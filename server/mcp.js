'use strict';
/*
 * Client MCP générique de L'usine.
 * Parle le protocole MCP (streamable HTTP, JSON-RPC 2.0) avec n'importe quel serveur,
 * et gère toute la pile d'autorisation moderne :
 *   - découverte du serveur d'autorisation (RFC 9728 : protected resource metadata)
 *   - métadonnées OAuth (RFC 8414)
 *   - enregistrement dynamique du client (RFC 7591) — aucune clé à créer à la main
 *   - OAuth 2.1 + PKCE (RFC 7636) + audience binding (RFC 8707, paramètre resource)
 *   - refresh automatique avec rotation des refresh tokens
 */

const crypto = require('crypto');

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: "L'usine", version: '3.8.0' };

/* sessions MCP en mémoire : credentialKey → Mcp-Session-Id */
const sessions = new Map();

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/* ---------- Transport JSON-RPC (streamable HTTP, réponses JSON ou SSE) ---------- */

function parseSSE(text) {
  // extrait le dernier message JSON-RPC des événements SSE
  const out = [];
  for (const block of text.split(/\n\n/)) {
    const dataLines = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
    if (!dataLines.length) continue;
    try { out.push(JSON.parse(dataLines.join('\n'))); } catch (_) {}
  }
  return out;
}

async function rpc(url, method, params, { token, sessionId, isNotification } = {}) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!isNotification) body.id = crypto.randomUUID();
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const r = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, 60000);
  const newSession = r.headers.get('mcp-session-id') || sessionId || null;

  if (r.status === 401) {
    const e = new Error('Authentification requise par le serveur MCP');
    e.code = 'AUTH_REQUIRED';
    e.wwwAuthenticate = r.headers.get('www-authenticate') || '';
    throw e;
  }
  if (isNotification) return { sessionId: newSession };

  const ctype = (r.headers.get('content-type') || '').toLowerCase();
  const text = await r.text();
  if (!r.ok && !text) {
    const e = new Error(`Serveur MCP : HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  let msg = null;
  if (ctype.includes('text/event-stream')) {
    const msgs = parseSSE(text);
    msg = msgs.find(m => m.id === body.id) || msgs[msgs.length - 1] || null;
  } else {
    try { msg = JSON.parse(text); } catch { throw new Error('Réponse MCP illisible : ' + text.slice(0, 200)); }
  }
  if (!msg) throw new Error('Réponse MCP vide');
  if (msg.error) {
    const e = new Error(msg.error.message || 'Erreur MCP');
    e.rpcCode = msg.error.code;
    e.status = r.status;
    throw e;
  }
  return { result: msg.result, sessionId: newSession };
}

/* ---------- Connexion + inventaire des outils ---------- */

async function connect(url, token) {
  const init = await rpc(url, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO
  }, { token });
  const sessionId = init.sessionId;
  try { await rpc(url, 'notifications/initialized', {}, { token, sessionId, isNotification: true }); } catch (_) {}
  const list = await rpc(url, 'tools/list', {}, { token, sessionId });
  const tools = (list.result?.tools || []).map(t => ({
    name: String(t.name || '').slice(0, 64),
    description: String(t.description || '').slice(0, 800),
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }
  }));
  return { tools, sessionId, serverInfo: init.result?.serverInfo || null };
}

/* ---------- Découverte OAuth (RFC 9728 + 8414) ---------- */

async function discoverAuth(mcpUrl, wwwAuthenticate) {
  const u = new URL(mcpUrl);
  let prmUrl = null;
  const m = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate || '');
  if (m) prmUrl = m[1];
  const candidates = prmUrl ? [prmUrl] : [
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname !== '/' ? u.pathname : ''}`,
    `${u.origin}/.well-known/oauth-protected-resource`
  ];
  let prm = null;
  for (const c of candidates) {
    try {
      const r = await fetchWithTimeout(c, { headers: { Accept: 'application/json' } }, 15000);
      if (r.ok) { prm = await r.json(); break; }
    } catch (_) {}
  }
  const resource = prm?.resource || mcpUrl;
  const issuer = (prm?.authorization_servers || [])[0] || u.origin;

  const iu = new URL(issuer);
  const metaCandidates = [
    `${iu.origin}/.well-known/oauth-authorization-server${iu.pathname !== '/' ? iu.pathname : ''}`,
    `${iu.origin}/.well-known/oauth-authorization-server`,
    `${iu.origin}/.well-known/openid-configuration`
  ];
  let meta = null;
  for (const c of metaCandidates) {
    try {
      const r = await fetchWithTimeout(c, { headers: { Accept: 'application/json' } }, 15000);
      if (r.ok) { meta = await r.json(); if (meta.authorization_endpoint && meta.token_endpoint) break; meta = null; }
    } catch (_) {}
  }
  if (!meta) throw new Error("Ce serveur MCP exige une authentification mais ne publie pas ses métadonnées OAuth — connexion impossible.");
  return {
    resource,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint || null,
    scopes_supported: meta.scopes_supported || []
  };
}

/* ---------- Enregistrement dynamique du client (RFC 7591) ---------- */

async function registerClient(meta, redirectUri) {
  if (!meta.registration_endpoint) {
    throw new Error("Ce serveur OAuth n'accepte pas l'enregistrement dynamique de clients (RFC 7591) — il faudrait un client_id fourni par le service.");
  }
  const r = await fetchWithTimeout(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: "L'usine",
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  }, 20000);
  const j = await r.json().catch(() => ({}));
  if (!j.client_id) throw new Error('Enregistrement dynamique refusé : ' + JSON.stringify(j).slice(0, 200));
  return { client_id: j.client_id, client_secret: j.client_secret || null };
}

/* ---------- Autorisation (PKCE + resource) ---------- */

function buildAuthRequest({ meta, clientId, redirectUri, scope }) {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (scope) u.searchParams.set('scope', scope);
  if (meta.resource) u.searchParams.set('resource', meta.resource);
  return { url: u.toString(), state, verifier };
}

async function tokenRequest(tokenEndpoint, params) {
  const r = await fetchWithTimeout(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  }, 20000);
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error('Réponse token illisible : ' + text.slice(0, 200)); }
  if (!j.access_token) throw new Error('Échange de token refusé : ' + (j.error_description || j.error || text.slice(0, 200)));
  return j;
}

async function exchangeCode({ meta, clientId, clientSecret, code, verifier, redirectUri }) {
  const p = {
    grant_type: 'authorization_code',
    code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier
  };
  if (clientSecret) p.client_secret = clientSecret;
  if (meta.resource) p.resource = meta.resource;
  return tokenRequest(meta.token_endpoint, p);
}

async function refreshTokens(oauth) {
  const p = {
    grant_type: 'refresh_token',
    refresh_token: oauth.refresh_token,
    client_id: oauth.client_id
  };
  if (oauth.client_secret) p.client_secret = oauth.client_secret;
  if (oauth.resource) p.resource = oauth.resource;
  return tokenRequest(oauth.token_endpoint, p);
}

/* ---------- Accès de haut niveau pour le connecteur ---------- */

async function ensureFreshToken(data, persist) {
  const o = data.oauth;
  if (!o || !o.access_token) return null;
  const soon = Date.now() + 60 * 1000;
  if (o.token_expiry && o.token_expiry < soon && o.refresh_token) {
    const t = await refreshTokens(o);
    o.access_token = t.access_token;
    if (t.refresh_token) o.refresh_token = t.refresh_token; // rotation
    o.token_expiry = Date.now() + (Number(t.expires_in || 3600) * 1000);
    if (persist) persist({ oauth: o });
  }
  return o.access_token;
}

async function callTool(data, credKey, name, args, persist) {
  let token = await ensureFreshToken(data, persist);
  const doCall = async () => {
    let sessionId = sessions.get(credKey);
    if (!sessionId) {
      const init = await rpc(data.url, 'initialize', {
        protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO
      }, { token });
      sessionId = init.sessionId;
      try { await rpc(data.url, 'notifications/initialized', {}, { token, sessionId, isNotification: true }); } catch (_) {}
      if (sessionId) sessions.set(credKey, sessionId);
    }
    return rpc(data.url, 'tools/call', { name, arguments: args || {} }, { token, sessionId });
  };
  try {
    const r = await doCall();
    return r.result;
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED' && data.oauth?.refresh_token) {
      // access token invalidé côté serveur : on force un refresh puis un retry
      data.oauth.token_expiry = 0;
      token = await ensureFreshToken(data, persist);
      sessions.delete(credKey);
      const r = await doCall();
      return r.result;
    }
    if (e.rpcCode === -32001 || /session/i.test(e.message || '')) {
      // session périmée : on la recrée une fois
      sessions.delete(credKey);
      const r = await doCall();
      return r.result;
    }
    throw e;
  }
}


/* ---------- Assainissement des schémas d'outils ----------
 * Certains serveurs MCP publient des inputSchema que les fournisseurs LLM
 * (OpenAI notamment) refusent : oneOf/anyOf/allOf/enum/const/not au sommet,
 * $ref/$defs… On garantit ici un schéma objet simple et accepté partout. */
function sanitizeSchema(s) {
  const permissive = (desc) => ({ type: 'object', properties: {}, additionalProperties: true, ...(desc ? { description: String(desc).slice(0, 300) } : {}) });
  if (!s || typeof s !== 'object') return permissive();
  const banned = ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not'];
  let raw = '';
  try { raw = JSON.stringify(s); } catch { return permissive(); }
  if (raw.includes('"$ref"')) return permissive(s.description);
  if (s.type !== 'object' || banned.some(k => Object.prototype.hasOwnProperty.call(s, k))) return permissive(s.description);
  const out = {
    type: 'object',
    properties: (s.properties && typeof s.properties === 'object') ? s.properties : {},
    additionalProperties: s.additionalProperties !== undefined ? s.additionalProperties : true
  };
  if (Array.isArray(s.required)) out.required = s.required.filter(r => typeof r === 'string');
  if (s.description) out.description = String(s.description).slice(0, 500);
  return out;
}

function contentToText(result) {
  if (!result) return 'Réponse vide.';
  if (Array.isArray(result.content)) {
    const parts = result.content.map(c => {
      if (c.type === 'text') return c.text;
      if (c.type === 'resource' && c.resource?.text) return c.resource.text;
      return `[${c.type}]`;
    });
    const text = parts.join('\n').trim() || JSON.stringify(result);
    return result.isError ? `ERREUR outil MCP : ${text}` : text;
  }
  return JSON.stringify(result);
}

module.exports = { connect, discoverAuth, registerClient, buildAuthRequest, exchangeCode, refreshTokens, callTool, contentToText, ensureFreshToken, sanitizeSchema };
