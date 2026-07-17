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
const { runWorkflow, stopExecution, testAgent, callLLM, resolveApproval } = require('./engine');
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
  if (urlPath === '/api/billing/stripe-webhook') return; // sécurisé par la signature HMAC Stripe
  if (/^\/api\/oauth\/[^/]+\/callback$/.test(urlPath)) return; // retour du fournisseur OAuth : identité via le state
  if (!isAuthed(req)) return reply.code(401).send({ error: 'Non authentifié' });
});


/* ---------- Facturation : webhook Stripe → activation automatique des comptes ---------- */
const STRIPE_WEBHOOK_SECRET = process.env.LUSINE_STRIPE_WEBHOOK_SECRET || '';

function verifyStripeSignature(rawBody, sigHeader, secret) {
  try {
    const parts = {};
    for (const p of String(sigHeader || '').split(',')) {
      const [k, v] = p.split('=');
      if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
      else parts[k] = v;
    }
    if (!parts.t || !parts.v1?.length) return false;
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false; // anti-rejeu 5 min
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    return parts.v1.some(v => {
      try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v)); } catch { return false; }
    });
  } catch { return false; }
}

fastify.register(async (scope) => {
  // ce scope garde le corps BRUT (nécessaire pour vérifier la signature Stripe)
  scope.removeContentTypeParser('application/json');
  scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => done(null, body));

  scope.post('/api/billing/stripe-webhook', async (req, reply) => {
    if (!STRIPE_WEBHOOK_SECRET) return reply.code(503).send({ error: 'Webhook Stripe non configuré (LUSINE_STRIPE_WEBHOOK_SECRET)' });
    const raw = req.body; // Buffer
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) {
      return reply.code(400).send({ error: 'Signature invalide' });
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'JSON invalide' }); }
    const obj = event.data?.object || {};

    if (event.type === 'checkout.session.completed') {
      const email = String(obj.customer_details?.email || obj.customer_email || '').toLowerCase();
      const customerId = obj.customer || null;
      const plan = obj.metadata?.plan || null;
      if (email) {
        const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (user) {
          db.prepare('UPDATE users SET active = 1, stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?')
            .run(customerId, user.id);
          fastify.log.info(`Stripe : compte ${email} activé`);
        } else {
          db.prepare('INSERT INTO pending_activations (email, stripe_customer_id, plan) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, plan = excluded.plan')
            .run(email, customerId, plan);
          fastify.log.info(`Stripe : activation en attente pour ${email} (compte pas encore créé)`);
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const customerId = obj.customer;
      if (customerId) {
        const r = db.prepare('UPDATE users SET active = 0 WHERE stripe_customer_id = ?').run(customerId);
        if (r.changes) fastify.log.info(`Stripe : abonnement résilié, compte désactivé (customer ${customerId})`);
        db.prepare('DELETE FROM pending_activations WHERE stripe_customer_id = ?').run(customerId);
      }
    }

    return { received: true };
  });
});

/* ---------- Bootstrap & Auth ---------- */
const SIGNUP_CODE = process.env.LUSINE_SIGNUP_CODE || '';
function validEmail(e) { return typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

fastify.get('/api/bootstrap', async (req) => {
  const hasUser = !!db.prepare('SELECT id FROM users LIMIT 1').get();
  const uid = currentUserId(req);
  let email = null;
  if (uid) email = db.prepare('SELECT email FROM users WHERE id = ?').get(uid)?.email || null;
  return { needsSetup: !hasUser, authed: !!uid, email, signupGated: !!SIGNUP_CODE, version: '3.6.0' };
});

fastify.post('/api/auth/register', async (req, reply) => {
  const ip = req.ip;
  if (!loginAllowed(ip)) return reply.code(429).send({ error: 'Trop de tentatives, réessaie dans 10 minutes' });
  const { email, password, code } = req.body || {};
  const firstAccount = !db.prepare('SELECT id FROM users LIMIT 1').get();
  const paid = email ? db.prepare('SELECT * FROM pending_activations WHERE email = ?').get(String(email).toLowerCase()) : null;

  // Le tout premier compte (admin) ne demande pas de code. Un client qui a déjà payé (Stripe) non plus.
  if (!firstAccount && !paid && SIGNUP_CODE && code !== SIGNUP_CODE) {
    loginFail(ip);
    return reply.code(403).send({ error: 'Code d\'inscription invalide' });
  }
  if (!validEmail(email)) return reply.code(400).send({ error: 'Adresse email invalide' });
  if (!password || password.length < 8) return reply.code(400).send({ error: 'Mot de passe trop court (8 caractères minimum)' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (exists) return reply.code(409).send({ error: 'Un compte existe déjà avec cet email' });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, email, password_hash, active, stripe_customer_id) VALUES (?, ?, ?, 1, ?)')
    .run(id, email.toLowerCase(), hashPassword(password), paid?.stripe_customer_id || null);
  if (paid) db.prepare('DELETE FROM pending_activations WHERE email = ?').run(email.toLowerCase());
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
const { listTemplates, getTemplate } = require('./templates');

fastify.get('/api/templates', async () => listTemplates());

fastify.post('/api/workflows/from-template', async (req, reply) => {
  const uid = currentUserId(req);
  const t = getTemplate(req.body?.templateId);
  if (!t) return reply.code(404).send({ error: 'Modèle introuvable' });
  // assigne automatiquement le premier fournisseur IA de l'utilisateur à tous les agents
  const prov = db.prepare('SELECT id FROM providers WHERE user_id = ? ORDER BY created_at LIMIT 1').get(uid);
  const data = JSON.parse(JSON.stringify(t.data));
  for (const n of data.nodes) {
    n.config = n.config || {};
    if (prov) n.config.providerId = prov.id;
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO workflows (id, name, data, user_id) VALUES (?, ?, ?, ?)')
    .run(id, t.name, JSON.stringify(data), uid);
  return { id, name: t.name, providerAssigned: !!prov };
});

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
    const execId = await runWorkflow({ workflowId: req.params.id, input: req.body?.input || '', broadcast, source: 'manual', userId: uid });
    return { execId };
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});

fastify.get('/api/executions', async (req) => {
  const uid = currentUserId(req);
  const { workflowId } = req.query || {};
  const rows = workflowId
    ? db.prepare('SELECT id, workflow_id, status, source, started_at, finished_at FROM executions WHERE workflow_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT 50').all(workflowId, uid)
    : db.prepare(`SELECT e.id, e.workflow_id, e.status, e.source, e.started_at, e.finished_at, w.name as workflow_name
                  FROM executions e LEFT JOIN workflows w ON w.id = e.workflow_id
                  WHERE e.user_id = ? ORDER BY e.started_at DESC LIMIT 100`).all(uid);
  return rows;
});

fastify.get('/api/executions/:id', async (req, reply) => {
  const uid = currentUserId(req);
  const e = db.prepare('SELECT * FROM executions WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!e) return reply.code(404).send({ error: 'Introuvable' });
  return { ...e, logs: JSON.parse(e.logs || '[]') };
});


fastify.post('/api/executions/:id/approve', async (req, reply) => {
  const uid = currentUserId(req);
  const e = db.prepare('SELECT id FROM executions WHERE id = ? AND user_id = ?').get(req.params.id, uid);
  if (!e) return reply.code(404).send({ error: 'Introuvable' });
  const { nodeId, decision, comment } = req.body || {};
  if (!nodeId || !['approve', 'reject'].includes(decision)) return reply.code(400).send({ error: 'nodeId et decision (approve|reject) requis' });
  const ok = resolveApproval(req.params.id, nodeId, decision, (comment || '').slice(0, 500));
  if (!ok) return reply.code(409).send({ error: 'Cette validation n\'est plus en attente (expirée, déjà traitée, ou serveur redémarré entre-temps — relance la chaîne).' });
  return { ok: true };
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

/* Les exécutions interrompues par un redémarrage ne peuvent pas reprendre */
db.prepare("UPDATE executions SET status = 'error', finished_at = datetime('now') WHERE status IN ('running','waiting')").run();
  initScheduler({ runWorkflow, broadcast });
  console.log('');
}).catch((e) => { console.error(e); process.exit(1); });
