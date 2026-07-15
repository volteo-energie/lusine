'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/* ---------- Chargement .env (sans dépendance) ---------- */
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { db, DATA_DIR } = require('./db');
const cryptoMod = require('./crypto');

/* ---------- Clés auto-générées et persistées si absentes ---------- */
function ensureSecret(envName, file, bytes) {
  if (process.env[envName]) return process.env[envName];
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const v = crypto.randomBytes(bytes).toString('hex');
  fs.writeFileSync(p, v, { mode: 0o600 });
  return v;
}
const ENCRYPTION_KEY = ensureSecret('ENCRYPTION_KEY', 'encryption.key', 32);
const SESSION_SECRET = ensureSecret('SESSION_SECRET', 'session.secret', 32);
cryptoMod.initKey(ENCRYPTION_KEY);

const { encrypt, decrypt, hashPassword, verifyPassword } = cryptoMod;
const { listTypes } = require('./connectors');
const { runWorkflow, stopExecution, testAgent, callLLM, reviewExecution } = require('./engine');
const { initScheduler, syncTriggers, fireTrigger, nextRuns } = require('./scheduler');
const oauth = require('./oauth');

const PORT = Number(process.env.PORT || 3200);
const HOST = process.env.HOST || '0.0.0.0';

const fastify = require('fastify')({ logger: false, bodyLimit: 15 * 1024 * 1024 });

/* Parsers tolérants : un webhook peut arriver avec un JSON vide, du texte brut, ou rien. */
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body) return done(null, {});
  try { done(null, JSON.parse(body)); } catch { done(null, { _raw: body }); }
});
fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, (req, body, done) => done(null, body || ''));

fastify.register(require('@fastify/cookie'), { secret: SESSION_SECRET });
fastify.register(require('@fastify/websocket'));
fastify.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public'), prefix: '/' });

/* Images générées par les agents (hébergées dans le volume data/, URL stable et publique) */
const GENERATED_DIR = path.join(DATA_DIR, 'generated');
try { fs.mkdirSync(GENERATED_DIR, { recursive: true }); } catch {}
fastify.register(require('@fastify/static'), { root: GENERATED_DIR, prefix: '/generated/', decorateReply: false });

/* ---------- Sessions ---------- */
const COOKIE = 'lusine_sess';
function currentUserId(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  const { valid, value } = req.unsignCookie(raw);
  if (!valid) return null;
  const u = db.prepare('SELECT id, active FROM users WHERE id = ?').get(value);
  if (!u || !u.active) return null;
  return u.id;
}
function isAuthed(req) { return !!currentUserId(req); }
function setSession(reply, userId) {
  reply.setCookie(COOKIE, userId, {
    signed: true, httpOnly: true, sameSite: 'lax', path: '/',
    maxAge: 60 * 60 * 24 * 30
  });
}

/* Rate-limit basique du login */
const attempts = new Map();
function loginAllowed(ip) {
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 10 * 60 * 1000) { attempts.delete(ip); return true; }
  return a.n < 10;
}
function loginFail(ip) {
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  a.n++; a.t = Date.now();
  attempts.set(ip, a);
}

/* ---------- WebSocket : diffusion des événements d'exécution ---------- */
const sockets = new Set();
function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const ws of sockets) { try { ws.send(msg); } catch {} }
}

fastify.register(async (app) => {
  app.get('/api/ws', { websocket: true }, (conn, req) => {
    const socket = conn && conn.socket ? conn.socket : conn; // compat @fastify/websocket v8-v10
    if (!isAuthed(req)) { socket.close(); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
});

/* ---------- Garde d'authentification ---------- */
const PUBLIC_API = new Set(['/api/bootstrap', '/api/auth/login', '/api/auth/register']);
fastify.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  const urlPath = req.url.split('?')[0];
  if (PUBLIC_API.has(urlPath) || urlPath === '/api/ws') return;
  if (urlPath.startsWith('/api/hooks/')) return; // webhooks : sécurisés par leur secret dans l'URL
  if (urlPath.startsWith('/api/tg/')) return;    // bot Telegram : sécurisé par son secret dans l'URL
  if (/^\/api\/oauth\/[^/]+\/callback$/.test(urlPath)) return; // retour du fournisseur OAuth : identité via le state
  if (!isAuthed(req)) return reply.code(401).send({ error: 'Non authentifié' });
});

/* ---------- Bootstrap & Auth ---------- */
const SIGNUP_CODE = process.env.LUSINE_SIGNUP_CODE || '';
function validEmail(e) { return typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

fastify.get('/api/bootstrap', async (req) => {
  const hasUser = !!db.prepare('SELECT id FROM users LIMIT 1').get();
  const uid = currentUserId(req);
  let email = null;
  if (uid) email = db.prepare('SELECT email FROM users WHERE id = ?').get(uid)?.email || null;
  return { needsSetup: !hasUser, authed: !!uid, email, signupGated: !!SIGNUP_CODE, version: '3.5.0' };
});

fastify.post('/api/auth/register', async (req, reply) => {
  const ip = req.ip;
  if (!loginAllowed(ip)) return reply.code(429).send({ error: 'Trop de tentatives, réessaie dans 10 minutes' });
  const { email, password, code } = req.body || {};
  const firstAccount = !db.prepare('SELECT id FROM users LIMIT 1').get();

  // Le tout premier compte (admin) ne demande pas de code. Ensuite, si un code est configuré, il est requis.
  if (!firstAccount && SIGNUP_CODE && code !== SIGNUP_CODE) {
    loginFail(ip);
    return reply.code(403).send({ error: 'Code d\'inscription invalide' });
  }
  if (!validEmail(email)) return reply.code(400).send({ error: 'Adresse email invalide' });
  if (!password || password.length < 8) return reply.code(400).send({ error: 'Mot de passe trop court (8 caractères minimum)' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return reply.code(409).send({ error: 'Un compte existe déjà avec cet email' });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, email, password_hash, active) VALUES (?, ?, ?, 1)')
    .run(id, email.toLowerCase(), hashPassword(password));
  attempts.delete(ip);
  setSession(reply, id);
  return { ok: true };
});

fastify.post('/api/auth/login', async (req, reply) => {
  const ip = req.ip;
  if (!loginAllowed(ip)) return reply.code(429).send({ error: 'Trop de tentatives, réessaie dans 10 minutes' });
  const { email, password } = req.body || {};
  const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase()) : null;
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    loginFail(ip);
    return reply.code(401).send({ error: 'Email ou mot de passe incorrect' });
  }
  if (!user.active) return reply.code(403).send({ error: 'Ce compte est désactivé' });
  attempts.delete(ip);
  setSession(reply, user.id);
  return { ok: true };
});

fastify.post('/api/auth/logout', async (req, reply) => {
  reply.clearCookie(COOKIE, { path: '/' });
  return { ok: true };
});

fastify.post('/api/auth/password', async (req, reply) => {
  const uid = currentUserId(req);
  const { current, next } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!verifyPassword(current || '', user.password_hash)) return reply.code(401).send({ error: 'Mot de passe actuel incorrect' });
  if (!next || next.length < 8) return reply.code(400).send({ error: 'Nouveau mot de passe trop court (8 caractères minimum)' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  return { ok: true };
});

/* ---------- Fournisseurs IA ---------- */
function maskKey(k) { return k.length > 8 ? '••••••••' + k.slice(-4) : '••••••••'; }

fastify.get('/api/providers', async (req) => {
  const uid = currentUserId(req);
  return db.prepare('SELECT * FROM providers WHERE user_id = ? ORDER BY created_at').all(uid).map(p => ({
    id: p.id, name: p.name, type: p.type, base_url: p.base_url,
    default_model: p.default_model, key_masked: maskKey(decrypt(p.api_key_enc))
  }));
});

fastify.post('/api/providers', async (req, reply) => {
  const uid = currentUserId(req);
  const { name, type, base_url, api_key, default_model } = req.body || {};
  if (!name || !type || !api_key) return reply.code(400).send({ error: 'Nom, type et clé API requis' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO providers (id, name, type, base_url, api_key_enc, default_model, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, type, base_url || null, encrypt(api_key), default_model || null, uid);
  return { id };
});

fastify.put('/api/providers/:id', async (req, reply) => {
  const uid = currentUserId(req);
  const p = db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!p) return reply.code(404).send({ error: 'Introuvable' });
  const { name, type, base_url, api_key, default_model } = req.body || {};
  db.prepare('UPDATE providers SET name = ?, type = ?, base_url = ?, api_key_enc = ?, default_model = ? WHERE id = ?')
    .run(name || p.name, type || p.type, base_url ?? p.base_url,
      api_key ? encrypt(api_key) : p.api_key_enc, default_model ?? p.default_model, p.id);
  return { ok: true };
});

fastify.delete('/api/providers/:id', async (req) => {
  const uid = currentUserId(req);
  db.prepare('DELETE FROM providers WHERE id = ? AND user_id = ?').run(req.params.id, uid);
  return { ok: true };
});

fastify.post('/api/providers/test', async (req, reply) => {
  const uid = currentUserId(req);
  const { id, type, base_url, api_key, model } = req.body || {};
  try {
    let provider;
    if (api_key) provider = { type, base_url, apiKey: api_key };
    else {
      const p = db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?').get(id, uid);
      if (!p) return reply.code(404).send({ error: 'Fournisseur introuvable' });
      provider = { type: p.type, base_url: p.base_url, apiKey: decrypt(p.api_key_enc) };
      if (!model && p.default_model) req.body.model = p.default_model;
    }
    const m = model || req.body.model;
    if (!m) return reply.code(400).send({ error: 'Modèle requis pour le test' });
    const r = await callLLM(provider, {
      model: m, system: 'Réponds uniquement : OK',
      messages: [{ role: 'user', content: 'ping' }], tools: [], temperature: 0
    });
    return { ok: true, reply: (r.text || '').slice(0, 100) };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

/* ---------- Connecteurs & credentials ---------- */
fastify.get('/api/connectors/types', async () => listTypes());

/* ---------- OAuth intégré ---------- */
function oauthRedirectUri(service) {
  const base = (process.env.LUSINE_PUBLIC_URL || '').replace(/\/+$/, '');
  return `${base}/api/oauth/${service}/callback`;
}

fastify.get('/api/oauth/services', async () => oauth.listServices());

fastify.get('/api/oauth/:service/start', async (req, reply) => {
  const uid = currentUserId(req);
  try {
    const url = oauth.startAuth({
      service: req.params.service,
      userId: uid,
      redirectUri: oauthRedirectUri(req.params.service),
      credName: req.query?.name
    });
    return { url };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

fastify.get('/api/oauth/:service/callback', async (req, reply) => {
  const page = (title, body, ok) => `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;background:#12131a;color:#ecedf3;display:grid;place-items:center;height:100vh;margin:0}
.card{max-width:420px;text-align:center;padding:40px;background:#1b1c26;border-radius:16px;border:1px solid rgba(255,255,255,.1)}
.big{font-size:44px;margin-bottom:14px}</style></head>
<body><div class="card"><div class="big">${ok ? '✅' : '❌'}</div><h2>${title}</h2><p style="color:#9ea0b4">${body}</p></div>
<script>try{window.opener&&window.opener.postMessage({lusineOauth:${ok ? "'done'" : "'error'"}},'*')}catch(e){}
setTimeout(()=>window.close(), ${ok ? 1800 : 6000});</script></body></html>`;

  const { code, state, error, error_description } = req.query || {};
  if (error) {
    return reply.type('text/html').send(page('Connexion refusée', String(error_description || error), false));
  }
  if (!code || !state) {
    return reply.type('text/html').send(page('Paramètres manquants', 'Le fournisseur n\'a pas renvoyé de code.', false));
  }
  try {
    const r = await oauth.finishAuth({ state, code, redirectUri: oauthRedirectUri(req.params.service) });
    if (!r.userId) throw new Error('Session utilisateur introuvable');
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO credentials (id, name, type, data_enc, user_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, r.credName, r.credentialType, encrypt(JSON.stringify(r.data)), r.userId);
    return reply.type('text/html').send(page('Connecté !', `Ton compte ${r.credName} est branché. Cette fenêtre va se fermer.`, true));
  } catch (e) {
    return reply.type('text/html').send(page('Échec de la connexion', e.message, false));
  }
});


fastify.get('/api/credentials', async (req) => {
  const uid = currentUserId(req);
  return db.prepare('SELECT id, name, type, created_at FROM credentials WHERE user_id = ? ORDER BY created_at DESC').all(uid);
});

fastify.post('/api/credentials', async (req, reply) => {
  const uid = currentUserId(req);
  const { name, type, data } = req.body || {};
  if (!name || !type || !data) return reply.code(400).send({ error: 'Nom, type et données requis' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO credentials (id, name, type, data_enc, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, type, encrypt(JSON.stringify(data)), uid);
  return { id };
});

fastify.put('/api/credentials/:id', async (req, reply) => {
  const uid = currentUserId(req);
  const c = db.prepare('SELECT * FROM credentials WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!c) return reply.code(404).send({ error: 'Introuvable' });
  const { name, data } = req.body || {};
  let merged = JSON.parse(decrypt(c.data_enc));
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (v !== '' && v !== undefined && v !== null) merged[k] = v; // champ vide = on conserve l'ancien secret
    }
  }
  db.prepare('UPDATE credentials SET name = ?, data_enc = ? WHERE id = ?')
    .run(name || c.name, encrypt(JSON.stringify(merged)), c.id);
  return { ok: true };
});

fastify.delete('/api/credentials/:id', async (req) => {
  const uid = currentUserId(req);
  db.prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?').run(req.params.id, uid);
  return { ok: true };
});

/* ---------- Workflows ---------- */
fastify.get('/api/workflows', async (req) => {
  const uid = currentUserId(req);
  return db.prepare('SELECT id, name, active, created_at, updated_at FROM workflows WHERE user_id = ? ORDER BY updated_at DESC').all(uid);
});

fastify.post('/api/workflows', async (req) => {
  const uid = currentUserId(req);
  const id = crypto.randomUUID();
  const name = (req.body?.name || 'Nouveau workflow').trim();
  db.prepare('INSERT INTO workflows (id, name, user_id) VALUES (?, ?, ?)').run(id, name, uid);
  return { id, name };
});

fastify.get('/api/workflows/:id', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Introuvable' });
  return { ...wf, data: JSON.parse(wf.data) };
});

fastify.put('/api/workflows/:id', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Introuvable' });
  const { name, data, active } = req.body || {};
  db.prepare(`UPDATE workflows SET name = ?, data = ?, active = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name ?? wf.name, data ? JSON.stringify(data) : wf.data, active !== undefined ? (active ? 1 : 0) : wf.active, wf.id);
  return { ok: true };
});

fastify.post('/api/workflows/:id/duplicate', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Introuvable' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name, data, user_id) VALUES (?, ?, ?, ?)').run(id, wf.name + ' (copie)', wf.data, uid);
  return { id };
});

fastify.delete('/api/workflows/:id', async (req) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT id FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return { ok: true };
  db.prepare('DELETE FROM workflows WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM executions WHERE workflow_id = ?').run(req.params.id);
  db.prepare('DELETE FROM triggers WHERE workflow_id = ?').run(req.params.id);
  syncTriggers();
  return { ok: true };
});

/* ---------- Exécutions ---------- */
fastify.post('/api/workflows/:id/run', async (req, reply) => {
  const uid = currentUserId(req);
  try {
    const execId = await runWorkflow({
      workflowId: req.params.id, input: req.body?.input || '', broadcast,
      source: 'manual', userId: uid, dryRun: !!req.body?.dryRun
    });
    return { execId };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

fastify.get('/api/executions', async (req) => {
  const uid = currentUserId(req);
  const { workflowId } = req.query || {};
  const rows = workflowId
    ? db.prepare('SELECT id, workflow_id, status, source, started_at, finished_at, dry_run, tokens_in, tokens_out, cost_eur FROM executions WHERE workflow_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT 50').all(workflowId, uid)
    : db.prepare(`SELECT e.id, e.workflow_id, e.status, e.source, e.started_at, e.finished_at, e.dry_run, e.tokens_in, e.tokens_out, e.cost_eur, w.name as workflow_name
                  FROM executions e LEFT JOIN workflows w ON w.id = e.workflow_id
                  WHERE e.user_id = ? ORDER BY e.started_at DESC LIMIT 100`).all(uid);
  return rows;
});

/* ---------- Contremaître : audit d'une exécution + missions améliorées ---------- */
fastify.post('/api/executions/:id/review', async (req, reply) => {
  const uid = currentUserId(req);
  try {
    return await reviewExecution({ execId: req.params.id, userId: uid });
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

/* Applique une mission proposée par le contremaître à un agent du workflow */
fastify.post('/api/workflows/:id/apply-mission', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Introuvable' });
  const { nodeId, mission } = req.body || {};
  if (!nodeId || typeof mission !== 'string') return reply.code(400).send({ error: 'nodeId et mission requis' });
  const data = JSON.parse(wf.data);
  const node = (data.nodes || []).find(n => n.id === nodeId);
  if (!node) return reply.code(404).send({ error: 'Agent introuvable dans ce workflow' });
  node.config = node.config || {};
  node.config.mission = mission;
  db.prepare(`UPDATE workflows SET data = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(data), wf.id);
  return { ok: true, name: node.name };
});

/* ---------- Mémoire d'usine ---------- */
fastify.get('/api/workflows/:id/memories', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT id FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Introuvable' });
  return db.prepare('SELECT id, key, value, updated_at FROM memories WHERE workflow_id = ? ORDER BY updated_at DESC').all(req.params.id);
});

fastify.delete('/api/workflows/:id/memories/:memId', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT id FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Introuvable' });
  if (req.params.memId === 'all') db.prepare('DELETE FROM memories WHERE workflow_id = ?').run(req.params.id);
  else db.prepare('DELETE FROM memories WHERE id = ? AND workflow_id = ?').run(req.params.memId, req.params.id);
  return { ok: true };
});

/* ---------- Export / import d'usines (.usine) ---------- */
fastify.get('/api/workflows/:id/export', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Introuvable' });
  const data = JSON.parse(wf.data);
  const typeById = {};
  for (const c of db.prepare('SELECT id, type FROM credentials WHERE user_id = ?').all(uid)) typeById[c.id] = c.type;
  const nodes = (data.nodes || []).map(n => {
    const cfg = { ...(n.config || {}) };
    // on retire tout ce qui est personnel : fournisseur, identifiants (on garde les TYPES de connecteurs comme guide)
    const credTypes = [...new Set((cfg.credentialIds || []).map(id => typeById[id]).filter(Boolean))];
    delete cfg.providerId;
    delete cfg.credentialIds;
    return { ...n, config: { ...cfg, requiresConnectors: credTypes } };
  });
  const payload = {
    format: 'lusine-usine@1',
    name: wf.name,
    exportedAt: new Date().toISOString(),
    data: { nodes, connections: data.connections || [], settings: {} }
  };
  reply.header('Content-Disposition', `attachment; filename="${wf.name.replace(/[^\w\-. ]+/g, '_')}.usine.json"`);
  return payload;
});

fastify.post('/api/workflows/import', async (req, reply) => {
  const uid = currentUserId(req);
  const p = req.body || {};
  if (p.format !== 'lusine-usine@1' || !p.data || !Array.isArray(p.data.nodes)) {
    return reply.code(400).send({ error: 'Fichier .usine invalide (format inconnu)' });
  }
  // par sécurité on ne garde que les champs attendus
  const nodes = p.data.nodes.slice(0, 60).map(n => ({
    id: String(n.id || ('n' + crypto.randomBytes(4).toString('hex'))),
    type: 'agent',
    name: String(n.name || 'Agent').slice(0, 120),
    x: Number(n.x) || 0, y: Number(n.y) || 0,
    config: {
      icon: typeof n.config?.icon === 'string' ? n.config.icon.slice(0, 8) : '🤖',
      color: /^#[0-9a-fA-F]{6}$/.test(n.config?.color || '') ? n.config.color : '#ff6d5a',
      mission: String(n.config?.mission || '').slice(0, 8000),
      model: String(n.config?.model || '').slice(0, 120),
      temperature: Number(n.config?.temperature ?? 0.7),
      maxIterations: Number(n.config?.maxIterations) || 8,
      retries: Number(n.config?.retries) || 0,
      retryDelay: Number(n.config?.retryDelay) || 3,
      onError: n.config?.onError === 'continue' ? 'continue' : 'stop',
      loop: n.config?.loop === 'foreach' ? 'foreach' : '',
      loopMaxItems: Number(n.config?.loopMaxItems) || 10,
      loopSplitHint: String(n.config?.loopSplitHint || '').slice(0, 300),
      isRouter: !!n.config?.isRouter,
      routeHint: String(n.config?.routeHint || '').slice(0, 1000),
      requiresConnectors: Array.isArray(n.config?.requiresConnectors) ? n.config.requiresConnectors.slice(0, 12) : [],
      providerId: '', credentialIds: []
    }
  }));
  const ids = new Set(nodes.map(n => n.id));
  const connections = (p.data.connections || []).filter(c => ids.has(c.from) && ids.has(c.to)).map(c => ({ from: c.from, to: c.to }));
  const id = crypto.randomUUID();
  const name = String(p.name || 'Usine importée').slice(0, 160);
  db.prepare('INSERT INTO workflows (id, name, data, user_id) VALUES (?, ?, ?, ?)')
    .run(id, name, JSON.stringify({ nodes, connections, settings: {} }), uid);
  return { id, name };
});

fastify.get('/api/executions/:id', async (req, reply) => {
  const uid = currentUserId(req);
  const e = db.prepare('SELECT * FROM executions WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!e) return reply.code(404).send({ error: 'Introuvable' });
  return { ...e, logs: JSON.parse(e.logs || '[]') };
});

fastify.post('/api/executions/:id/stop', async (req) => {
  const uid = currentUserId(req);
  const e = db.prepare('SELECT id FROM executions WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!e) return { ok: false };
  return { ok: stopExecution(req.params.id) };
});

/* ---------- Test d'un agent seul ---------- */
fastify.post('/api/agents/test', async (req, reply) => {
  const uid = currentUserId(req);
  const { node, input } = req.body || {};
  if (!node) return reply.code(400).send({ error: 'Agent manquant' });
  try {
    const r = await testAgent({ node, input: input || '', userId: uid });
    return r;
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

/* ---------- Chef d'atelier Telegram ---------- */
function tgApi(token, method, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}), signal: ctrl.signal
  }).then(r => r.json()).finally(() => clearTimeout(t));
}
function tgCredToken(credId, uid) {
  const row = db.prepare('SELECT * FROM credentials WHERE id = ? AND user_id = ?').get(credId, uid);
  if (!row || row.type !== 'telegram') return null;
  try { return JSON.parse(decrypt(row.data_enc)).botToken || null; } catch { return null; }
}

fastify.get('/api/telegram/links', async (req) => {
  const uid = currentUserId(req);
  return db.prepare('SELECT id, credential_id, chat_id, enabled, created_at FROM tg_links WHERE user_id = ?').all(uid);
});

fastify.post('/api/telegram/links', async (req, reply) => {
  const uid = currentUserId(req);
  const { credentialId } = req.body || {};
  const token = tgCredToken(credentialId, uid);
  if (!token) return reply.code(400).send({ error: 'Identifiant Telegram introuvable (le connecteur doit être de type Telegram avec un token de bot)' });
  const base = (process.env.LUSINE_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base) return reply.code(400).send({ error: 'LUSINE_PUBLIC_URL manquant côté serveur : impossible d\'enregistrer le webhook du bot' });

  const existing = db.prepare('SELECT * FROM tg_links WHERE credential_id = ? AND user_id = ?').get(credentialId, uid);
  const id = existing?.id || crypto.randomUUID();
  const secret = existing?.secret || crypto.randomBytes(18).toString('hex');
  const hookUrl = `${base}/api/tg/${id}/${secret}`;
  const r = await tgApi(token, 'setWebhook', { url: hookUrl, allowed_updates: ['message'] });
  if (!r.ok) return reply.code(400).send({ error: `Telegram a refusé le webhook : ${r.description || 'erreur inconnue'}` });
  if (existing) db.prepare('UPDATE tg_links SET enabled = 1 WHERE id = ?').run(id);
  else db.prepare('INSERT INTO tg_links (id, user_id, credential_id, secret, enabled) VALUES (?, ?, ?, ?, 1)').run(id, uid, credentialId, secret);
  return { ok: true, id, pending: true, hint: 'Envoie n\'importe quel message à ton bot pour le jumeler.' };
});

fastify.delete('/api/telegram/links/:id', async (req) => {
  const uid = currentUserId(req);
  const link = db.prepare('SELECT * FROM tg_links WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (link) {
    const token = tgCredToken(link.credential_id, uid);
    if (token) { try { await tgApi(token, 'deleteWebhook', {}); } catch (_) {} }
    db.prepare('DELETE FROM tg_links WHERE id = ?').run(link.id);
  }
  return { ok: true };
});

/* Webhook entrant du bot (public, sécurisé par le secret d'URL) */
fastify.post('/api/tg/:id/:secret', async (req, reply) => {
  const link = db.prepare('SELECT * FROM tg_links WHERE id = ?').get(req.params.id);
  if (!link || link.secret !== req.params.secret || !link.enabled) return reply.code(404).send({ ok: false });
  const token = tgCredToken(link.credential_id, link.user_id);
  if (!token) return reply.send({ ok: true });

  const msg = req.body?.message;
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : null;
  const text = String(msg?.text || '').trim();
  if (!chatId || !text) return reply.send({ ok: true });

  const say = (t) => tgApi(token, 'sendMessage', { chat_id: chatId, text: t }).catch(() => {});

  // Jumelage : le premier chat qui écrit devient le chef d'atelier
  if (!link.chat_id) {
    db.prepare('UPDATE tg_links SET chat_id = ? WHERE id = ?').run(chatId, link.id);
    await say('🏭 Chef d\'atelier connecté à L\'usine.\n\nCommandes :\n• usines — liste tes chaînes\n• lance N [donnée d\'entrée] — exécute la chaîne N\n• simule N [donnée] — répétition générale (rien de réel)\n• statut — exécutions en cours et récentes\n• aide — cette aide');
    return reply.send({ ok: true });
  }
  if (link.chat_id !== chatId) return reply.send({ ok: true }); // seul le chat jumelé commande

  const uid = link.user_id;
  const wfs = db.prepare('SELECT id, name, active FROM workflows WHERE user_id = ? ORDER BY created_at').all(uid);
  const lower = text.toLowerCase();

  try {
    if (lower === 'usines' || lower === '/usines' || lower === 'list') {
      if (!wfs.length) { await say('Aucune chaîne pour l\'instant.'); return reply.send({ ok: true }); }
      await say('🏭 Tes usines :\n' + wfs.map((w, i) => `${i + 1}. ${w.name}${w.active ? ' ✅' : ''}`).join('\n') + '\n\n« lance N » pour exécuter, « simule N » pour une répétition.');
    } else if (/^(lance|simule)\s+\d+/.test(lower)) {
      const m = text.match(/^(\S+)\s+(\d+)\s*([\s\S]*)$/);
      const idx = Number(m[2]) - 1;
      const dry = m[1].toLowerCase() === 'simule';
      if (!wfs[idx]) { await say(`Pas de chaîne n° ${m[2]} — envoie « usines » pour la liste.`); return reply.send({ ok: true }); }
      await runWorkflow({ workflowId: wfs[idx].id, input: m[3] || '', broadcast, source: 'telegram', userId: uid, dryRun: dry });
      await say(`${dry ? '🧪 Répétition générale' : '▶️ Exécution'} de « ${wfs[idx].name} » lancée. Je te fais un rapport si la chaîne a le rapport Telegram activé (Réglages de la chaîne).`);
    } else if (lower === 'statut' || lower === '/statut') {
      const recent = db.prepare(`SELECT e.status, e.dry_run, e.started_at, e.cost_eur, w.name FROM executions e LEFT JOIN workflows w ON w.id = e.workflow_id WHERE e.user_id = ? ORDER BY e.started_at DESC LIMIT 5`).all(uid);
      const runningCount = recent.filter(r => r.status === 'running').length;
      const fmt = (r) => `${{ success: '✅', error: '🔴', running: '⏳', stopped: '⏹', partial: '🟠' }[r.status] || '•'} ${r.name || '?'}${r.dry_run ? ' (sim)' : ''} — ${r.started_at}${r.cost_eur != null ? ` · ~${r.cost_eur.toFixed(2)} €` : ''}`;
      await say(`En cours : ${runningCount}\n\nDernières exécutions :\n${recent.map(fmt).join('\n') || '(aucune)'}`);
    } else {
      await say('Commandes : usines · lance N [entrée] · simule N [entrée] · statut');
    }
  } catch (e) {
    await say(`⚠️ ${e.message}`);
  }
  return reply.send({ ok: true });
});

/* ---------- Déclencheurs (triggers) ---------- */
function triggerOut(t) {
  let config = {};
  try { config = JSON.parse(t.config || '{}'); } catch {}
  return {
    id: t.id, workflow_id: t.workflow_id, type: t.type, name: t.name,
    config, enabled: !!t.enabled, secret: t.type === 'webhook' ? t.secret : undefined,
    last_fired_at: t.last_fired_at, last_exec_id: t.last_exec_id, created_at: t.created_at
  };
}

fastify.get('/api/workflows/:id/triggers', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT id FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Workflow introuvable' });
  return db.prepare('SELECT * FROM triggers WHERE workflow_id = ? AND user_id = ? ORDER BY created_at').all(req.params.id, uid).map(triggerOut);
});

fastify.post('/api/workflows/:id/triggers', async (req, reply) => {
  const uid = currentUserId(req);
  const wf = db.prepare('SELECT id FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!wf) return reply.code(404).send({ error: 'Workflow introuvable' });
  const { type, name, config } = req.body || {};
  if (type !== 'cron' && type !== 'webhook') return reply.code(400).send({ error: 'Type de déclencheur invalide' });

  const cfg = config || {};
  if (type === 'cron') {
    if (!cfg.expression || !nextRuns(cfg.expression, 1)) {
      return reply.code(400).send({ error: 'Expression cron invalide' });
    }
  }
  const id = crypto.randomUUID();
  const secret = type === 'webhook' ? crypto.randomBytes(18).toString('hex') : null;
  db.prepare('INSERT INTO triggers (id, workflow_id, type, name, config, secret, enabled, user_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .run(id, req.params.id, type, name || (type === 'cron' ? 'Déclencheur cron' : 'Webhook'), JSON.stringify(cfg), secret, uid);
  syncTriggers();
  return triggerOut(db.prepare('SELECT * FROM triggers WHERE id = ?').get(id));
});

fastify.put('/api/triggers/:id', async (req, reply) => {
  const uid = currentUserId(req);
  const t = db.prepare('SELECT * FROM triggers WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!t) return reply.code(404).send({ error: 'Introuvable' });
  const { name, config, enabled } = req.body || {};
  let cfg = config;
  if (t.type === 'cron' && config?.expression && !nextRuns(config.expression, 1)) {
    return reply.code(400).send({ error: 'Expression cron invalide' });
  }
  db.prepare('UPDATE triggers SET name = ?, config = ?, enabled = ? WHERE id = ?')
    .run(name ?? t.name, cfg ? JSON.stringify(cfg) : t.config, enabled !== undefined ? (enabled ? 1 : 0) : t.enabled, t.id);
  syncTriggers();
  return triggerOut(db.prepare('SELECT * FROM triggers WHERE id = ?').get(t.id));
});

fastify.delete('/api/triggers/:id', async (req) => {
  const uid = currentUserId(req);
  db.prepare('DELETE FROM triggers WHERE id = ? AND user_id = ?').run(req.params.id, uid);
  syncTriggers();
  return { ok: true };
});

/* Déclenchement manuel d'un trigger (bouton « Tester » de l'UI) */
fastify.post('/api/triggers/:id/fire', async (req, reply) => {
  const uid = currentUserId(req);
  const t = db.prepare('SELECT id FROM triggers WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!t) return reply.code(404).send({ error: 'Introuvable' });
  try {
    const execId = await fireTrigger(req.params.id, { source: 'manual' });
    return { execId };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

/* Aperçu des prochaines exécutions d'une expression cron */
fastify.get('/api/triggers/cron/preview', async (req, reply) => {
  const expr = req.query?.expression;
  if (!expr) return reply.code(400).send({ error: 'Expression manquante' });
  const runs = nextRuns(expr, 3);
  if (!runs) return reply.code(400).send({ error: 'Expression cron invalide' });
  return { valid: true, next: runs };
});

/* ---------- Webhook public (sécurisé par secret dans l'URL) ---------- */
async function handleWebhook(req, reply) {
  const { id, secret } = req.params;
  const t = db.prepare("SELECT * FROM triggers WHERE id = ? AND type = 'webhook'").get(id);
  if (!t || t.secret !== secret) return reply.code(404).send({ error: 'Webhook introuvable' });
  if (!t.enabled) return reply.code(403).send({ error: 'Webhook désactivé' });

  let config = {};
  try { config = JSON.parse(t.config || '{}'); } catch {}
  let input = '';
  if (config.inputMode === 'fixed') {
    input = config.input || '';
  } else {
    const b = req.body;
    if (typeof b === 'string') input = b;
    else if (b && typeof b === 'object' && Object.keys(b).length) input = b._raw || JSON.stringify(b, null, 2);
    if (!input && req.query?.input) input = String(req.query.input);
  }

  try {
    const execId = await fireTrigger(t.id, { source: 'webhook', inputOverride: input });
    return reply.send({ ok: true, execId });
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
}
fastify.post('/api/hooks/:id/:secret', handleWebhook);
fastify.get('/api/hooks/:id/:secret', handleWebhook);

/* ---------- SPA fallback ---------- */
fastify.setNotFoundHandler((req, reply) => {
  if (req.raw.url.startsWith('/api/')) return reply.code(404).send({ error: 'Route inconnue' });
  return reply.sendFile('index.html');
});

fastify.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`\n  🏭  L'usine tourne sur http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  initScheduler({ runWorkflow, broadcast });
  console.log('');
}).catch((e) => { console.error(e); process.exit(1); });
