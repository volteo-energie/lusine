'use strict';
/*
 * OAuth intégré de L'usine.
 * Chaque service déclare : ses URLs d'autorisation/token, ses scopes, PKCE ou non,
 * et comment transformer la réponse token en données de credential.
 * Le flux : /api/oauth/:service/start → page du fournisseur → /api/oauth/:service/callback
 * → création/mise à jour du credential chiffré → la popup se ferme toute seule.
 */

const crypto = require('crypto');

/* Configuration par service.
 * clientId/clientSecret viennent de l'ENV : l'admin de l'instance crée UNE app
 * par service (ex: LUSINE_OAUTH_ETSY_CLIENT_ID) et tous les utilisateurs passent par elle. */
const SERVICES = {
  etsy: {
    label: 'Etsy',
    credentialType: 'etsy',
    authUrl: 'https://www.etsy.com/oauth/connect',
    tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
    scopes: 'listings_w listings_r shops_r',
    pkce: true,
    clientOnly: true, // pas de client_secret (PKCE pur)
    env: 'ETSY',
    // transforme la réponse token en données de credential
    async toCredentialData({ tokens, clientId }) {
      const data = {
        keystring: clientId,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        token_expiry: Date.now() + (Number(tokens.expires_in || 3600) * 1000)
      };
      // récupère le shop_id automatiquement (l'user_id Etsy est le préfixe du token)
      try {
        const userId = String(tokens.access_token).split('.')[0];
        const r = await fetch(`https://api.etsy.com/v3/application/users/${userId}/shops`, {
          headers: { 'x-api-key': clientId, Authorization: `Bearer ${tokens.access_token}` }
        });
        if (r.ok) {
          const j = await r.json();
          const shop = j.shop_id ? j : (j.results && j.results[0]);
          if (shop?.shop_id) data.shop_id = String(shop.shop_id);
        }
      } catch (_) { /* le shop_id restera à renseigner à la main */ }
      return data;
    }
  }
  // D'autres services (google, pinterest…) se déclarent ici sur le même modèle.
};

function getService(id) {
  const s = SERVICES[id];
  if (!s) return null;
  const clientId = process.env[`LUSINE_OAUTH_${s.env}_CLIENT_ID`] || '';
  const clientSecret = process.env[`LUSINE_OAUTH_${s.env}_CLIENT_SECRET`] || '';
  return { ...s, id, clientId, clientSecret, configured: !!clientId && (s.clientOnly || !!clientSecret) };
}

function listServices() {
  return Object.keys(SERVICES).map(id => {
    const s = getService(id);
    return { id, label: s.label, credentialType: s.credentialType, configured: s.configured };
  });
}

/* états en attente : state → { userId, service, verifier, createdAt, credName } */
const pending = new Map();
setInterval(() => { // purge > 10 min
  const cut = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pending) if (v.createdAt < cut) pending.delete(k);
}, 60 * 1000).unref();

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function startAuth({ service, userId, redirectUri, credName }) {
  const s = getService(service);
  if (!s) throw new Error('Service OAuth inconnu');
  if (!s.configured) throw new Error(`Le service ${s.label} n'est pas configuré sur cette instance (variable LUSINE_OAUTH_${s.env}_CLIENT_ID manquante).`);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  pending.set(state, { userId, service, verifier, createdAt: Date.now(), credName: credName || s.label });
  const u = new URL(s.authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', s.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', s.scopes);
  u.searchParams.set('state', state);
  if (s.pkce) {
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

async function finishAuth({ state, code, redirectUri }) {
  const p = pending.get(state);
  if (!p) throw new Error('Session OAuth expirée ou inconnue — relance la connexion.');
  pending.delete(state);
  const s = getService(p.service);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: s.clientId,
    redirect_uri: redirectUri,
    code
  });
  if (s.pkce) body.set('code_verifier', p.verifier);
  if (!s.clientOnly && s.clientSecret) body.set('client_secret', s.clientSecret);
  const r = await fetch(s.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const text = await r.text();
  let tokens; try { tokens = JSON.parse(text); } catch { throw new Error('Réponse token illisible : ' + text.slice(0, 200)); }
  if (!tokens.access_token) throw new Error('Échange du code échoué : ' + (tokens.error_description || tokens.error || text.slice(0, 200)));
  const data = await s.toCredentialData({ tokens, clientId: s.clientId });
  return { userId: p.userId, service: p.service, credentialType: s.credentialType, credName: p.credName, data };
}

module.exports = { listServices, getService, startAuth, finishAuth };
