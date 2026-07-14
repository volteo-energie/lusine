'use strict';
/*
 * Registre des connecteurs de L'usine.
 * Chaque type définit :
 *  - les champs du credential (formulaire côté UI)
 *  - buildTools(data) → les outils (function calling) exposés à l'agent
 * Un outil = { name, description, parameters (JSON Schema), run(args) → string }
 */

const MAX_RESULT = 14000; // troncature des résultats d'outils pour protéger le contexte

function trunc(s, n = MAX_RESULT) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[tronqué, ${s.length} caractères au total]` : s;
}

async function doFetch(url, opts = {}, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text, headers: res.headers };
  } finally { clearTimeout(t); }
}

function buildUrl(base, path, query) {
  let url = path || '';
  if (base) {
    if (!url) url = base;
    else if (/^https?:\/\//i.test(url)) { /* URL absolue fournie */ }
    else url = base.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
  }
  if (query && typeof query === 'object' && Object.keys(query).length) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    url = u.toString();
  }
  return url;
}

const HTTP_PARAMS = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'Méthode HTTP' },
    path: { type: 'string', description: "Chemin de l'endpoint (ex: /shops.json) ou URL absolue" },
    query: { type: 'object', description: 'Paramètres de query string (clé/valeur)' },
    body: { description: 'Corps de la requête (objet JSON ou chaîne)' }
  },
  required: ['method', 'path']
};

function makeServiceTool(id, name, cfg, data) {
  // cfg: { base|baseFn, auth: 'bearer'|['header','X-Key']|['query','key'], extraHeaders, bodyMode, hint }
  const base = typeof cfg.base === 'function' ? cfg.base(data) : cfg.base;
  return {
    name: `${id}_request`,
    description: `Appelle l'API ${name} (base: ${base}). L'authentification est déjà gérée automatiquement. ${cfg.hint || ''}`.trim(),
    parameters: HTTP_PARAMS,
    run: async (args) => {
      const headers = { 'Content-Type': 'application/json', ...(cfg.extraHeaders || {}) };
      let query = args.query || {};
      if (cfg.auth === 'bearer') headers['Authorization'] = `Bearer ${data.token}`;
      else if (Array.isArray(cfg.auth) && cfg.auth[0] === 'header') headers[cfg.auth[1]] = data.token;
      else if (Array.isArray(cfg.auth) && cfg.auth[0] === 'query') query = { ...query, [cfg.auth[1]]: data.token };
      if (cfg.authExtra) Object.assign(headers, cfg.authExtra(data));
      const url = buildUrl(base, args.path, query);
      let body;
      if (args.body !== undefined && args.body !== null && args.method !== 'GET') {
        if (cfg.bodyMode === 'form') {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
          const p = new URLSearchParams();
          const flat = (obj, prefix = '') => {
            for (const [k, v] of Object.entries(obj)) {
              const key = prefix ? `${prefix}[${k}]` : k;
              if (v !== null && typeof v === 'object') flat(v, key);
              else p.set(key, String(v));
            }
          };
          typeof args.body === 'object' ? flat(args.body) : p.set('data', String(args.body));
          body = p.toString();
        } else {
          body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
        }
      }
      const r = await doFetch(url, { method: args.method, headers, body });
      return trunc(`HTTP ${r.status}\n${r.text}`);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Définition des types                                                */
/* ------------------------------------------------------------------ */

const TYPES = {};

function register(t) { TYPES[t.id] = t; }

/* ---------- Cœur ---------- */

register({
  id: 'http_generic', name: 'HTTP / API générique', icon: '🌐', category: 'Cœur',
  description: 'Requêtes HTTP vers n\'importe quelle API. Le couteau suisse : tout service à API (même absent du catalogue) passe par ici.',
  fields: [
    { key: 'baseUrl', label: 'URL de base (optionnel)', placeholder: 'https://api.exemple.com/v1' },
    { key: 'headers', label: 'Headers JSON (optionnel)', type: 'textarea', placeholder: '{"Authorization": "Bearer xxx"}' }
  ],
  buildTools(data) {
    let extra = {};
    try { extra = data.headers ? JSON.parse(data.headers) : {}; } catch { extra = {}; }
    return [{
      name: 'http_request',
      description: `Effectue une requête HTTP.${data.baseUrl ? ` URL de base pré-configurée : ${data.baseUrl} (les chemins relatifs s'y ajoutent).` : ''} Les headers d'authentification du credential sont injectés automatiquement.`,
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          url: { type: 'string', description: 'URL absolue, ou chemin relatif si une URL de base est configurée' },
          headers: { type: 'object', description: 'Headers additionnels' },
          query: { type: 'object' },
          body: { description: 'Corps (objet JSON ou chaîne)' }
        },
        required: ['method', 'url']
      },
      run: async (args) => {
        const headers = { 'Content-Type': 'application/json', ...extra, ...(args.headers || {}) };
        const url = buildUrl(data.baseUrl || '', args.url, args.query);
        const body = args.body === undefined || args.method === 'GET' ? undefined
          : (typeof args.body === 'string' ? args.body : JSON.stringify(args.body));
        const r = await doFetch(url, { method: args.method, headers, body });
        return trunc(`HTTP ${r.status}\n${r.text}`);
      }
    }];
  }
});

register({
  id: 'smtp', name: 'Email — envoi (SMTP)', icon: '📤', category: 'Cœur',
  description: 'Envoi d\'emails via n\'importe quel serveur SMTP (IONOS, Gmail, OVH…).',
  fields: [
    { key: 'host', label: 'Serveur SMTP', placeholder: 'smtp.ionos.fr', required: true },
    { key: 'port', label: 'Port', placeholder: '465', required: true },
    { key: 'secure', label: 'SSL/TLS (true/false)', placeholder: 'true' },
    { key: 'user', label: 'Utilisateur', required: true },
    { key: 'pass', label: 'Mot de passe', type: 'password', required: true },
    { key: 'from', label: 'Expéditeur', placeholder: 'contact@mondomaine.fr', required: true }
  ],
  buildTools(data) {
    return [{
      name: 'send_email',
      description: `Envoie un email depuis ${data.from} via SMTP.`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Destinataire(s), séparés par des virgules' },
          subject: { type: 'string' },
          text: { type: 'string', description: 'Corps en texte brut' },
          html: { type: 'string', description: 'Corps HTML (optionnel)' }
        },
        required: ['to', 'subject', 'text']
      },
      run: async (args) => {
        const nodemailer = require('nodemailer');
        const transport = nodemailer.createTransport({
          host: data.host, port: Number(data.port) || 465,
          secure: String(data.secure ?? 'true') !== 'false',
          auth: { user: data.user, pass: data.pass }
        });
        const info = await transport.sendMail({ from: data.from, to: args.to, subject: args.subject, text: args.text, html: args.html });
        return `Email envoyé à ${args.to} — id: ${info.messageId}`;
      }
    }];
  }
});

register({
  id: 'imap', name: 'Email — lecture (IMAP)', icon: '📥', category: 'Cœur',
  description: 'Lecture de boîtes mail via IMAP : lister et lire les derniers messages.',
  fields: [
    { key: 'host', label: 'Serveur IMAP', placeholder: 'imap.ionos.fr', required: true },
    { key: 'port', label: 'Port', placeholder: '993' },
    { key: 'user', label: 'Utilisateur', required: true },
    { key: 'pass', label: 'Mot de passe', type: 'password', required: true }
  ],
  buildTools(data) {
    const connect = async () => {
      const { ImapFlow } = require('imapflow');
      const client = new ImapFlow({
        host: data.host, port: Number(data.port) || 993, secure: true,
        auth: { user: data.user, pass: data.pass }, logger: false
      });
      await client.connect();
      return client;
    };
    return [
      {
        name: 'list_emails',
        description: 'Liste les derniers emails d\'un dossier (expéditeur, sujet, date, uid).',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Dossier, par défaut INBOX' },
            limit: { type: 'number', description: 'Nombre de messages (défaut 10, max 30)' },
            unseenOnly: { type: 'boolean', description: 'Seulement les non lus' }
          }
        },
        run: async (args) => {
          const client = await connect();
          try {
            const lock = await client.getMailboxLock(args.folder || 'INBOX');
            try {
              const total = client.mailbox.exists;
              if (!total) return 'Aucun message dans ce dossier.';
              const limit = Math.min(Number(args.limit) || 10, 30);
              const from = Math.max(1, total - limit + 1);
              const out = [];
              for await (const msg of client.fetch(`${from}:*`, { envelope: true, flags: true, uid: true })) {
                const seen = msg.flags?.has('\\Seen');
                if (args.unseenOnly && seen) continue;
                out.push(`uid:${msg.uid} | ${seen ? 'lu' : 'NON LU'} | ${msg.envelope.date?.toISOString?.() || ''} | de: ${msg.envelope.from?.map(a => a.address).join(',')} | sujet: ${msg.envelope.subject || '(sans sujet)'}`);
              }
              return trunc(out.reverse().join('\n') || 'Aucun message correspondant.');
            } finally { lock.release(); }
          } finally { await client.logout().catch(() => {}); }
        }
      },
      {
        name: 'read_email',
        description: 'Lit le contenu complet d\'un email via son uid (obtenu avec list_emails).',
        parameters: {
          type: 'object',
          properties: {
            uid: { type: 'number', description: 'UID du message' },
            folder: { type: 'string', description: 'Dossier, par défaut INBOX' }
          },
          required: ['uid']
        },
        run: async (args) => {
          const { simpleParser } = require('mailparser');
          const client = await connect();
          try {
            const lock = await client.getMailboxLock(args.folder || 'INBOX');
            try {
              const msg = await client.fetchOne(String(args.uid), { source: true }, { uid: true });
              if (!msg?.source) return 'Message introuvable.';
              const parsed = await simpleParser(msg.source);
              return trunc(`De: ${parsed.from?.text}\nÀ: ${parsed.to?.text}\nDate: ${parsed.date}\nSujet: ${parsed.subject}\n\n${parsed.text || parsed.html || '(vide)'}`);
            } finally { lock.release(); }
          } finally { await client.logout().catch(() => {}); }
        }
      }
    ];
  }
});

register({
  id: 'postgres', name: 'PostgreSQL / Supabase', icon: '🐘', category: 'Cœur',
  description: 'Exécution de requêtes SQL sur PostgreSQL ou Supabase (chaîne de connexion).',
  fields: [
    { key: 'connectionString', label: 'Chaîne de connexion', placeholder: 'postgresql://user:pass@host:5432/db', required: true }
  ],
  buildTools(data) {
    return [{
      name: 'sql_query',
      description: 'Exécute une requête SQL (SELECT, INSERT, UPDATE…) et retourne le résultat en JSON (max 100 lignes). À utiliser avec précaution.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Requête SQL' },
          params: { type: 'array', items: {}, description: 'Paramètres positionnels ($1, $2…)' }
        },
        required: ['query']
      },
      run: async (args) => {
        const { Client } = require('pg');
        const needsSsl = /supabase|sslmode=require|neon|render\.com/i.test(data.connectionString);
        const client = new Client({ connectionString: data.connectionString, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
        await client.connect();
        try {
          const res = await client.query(args.query, args.params || []);
          const rows = (res.rows || []).slice(0, 100);
          return trunc(JSON.stringify({ rowCount: res.rowCount, rows }, null, 2));
        } finally { await client.end().catch(() => {}); }
      }
    }];
  }
});

/* ---------- Messagerie ---------- */

register({
  id: 'telegram', name: 'Telegram', icon: '✈️', category: 'Messagerie',
  description: 'Bot Telegram : envoyer des messages et lire les derniers messages reçus.',
  fields: [
    { key: 'botToken', label: 'Token du bot (@BotFather)', type: 'password', required: true },
    { key: 'defaultChatId', label: 'Chat ID par défaut (optionnel)' }
  ],
  buildTools(data) {
    const api = (m) => `https://api.telegram.org/bot${data.botToken}/${m}`;
    return [
      {
        name: 'telegram_send',
        description: `Envoie un message Telegram.${data.defaultChatId ? ` Chat par défaut : ${data.defaultChatId}.` : ''}`,
        parameters: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'ID du chat (optionnel si un défaut est configuré)' },
            text: { type: 'string' }
          },
          required: ['text']
        },
        run: async (args) => {
          const r = await doFetch(api('sendMessage'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: args.chat_id || data.defaultChatId, text: args.text })
          });
          return trunc(r.text);
        }
      },
      {
        name: 'telegram_get_updates',
        description: 'Récupère les derniers messages reçus par le bot.',
        parameters: { type: 'object', properties: { limit: { type: 'number' } } },
        run: async (args) => {
          const r = await doFetch(api('getUpdates') + `?limit=${Math.min(Number(args.limit) || 10, 50)}`);
          return trunc(r.text);
        }
      }
    ];
  }
});

register({
  id: 'discord_webhook', name: 'Discord (webhook)', icon: '🎮', category: 'Messagerie',
  description: 'Publication de messages dans un salon Discord via webhook.',
  fields: [{ key: 'webhookUrl', label: 'URL du webhook', type: 'password', required: true }],
  buildTools(data) {
    return [{
      name: 'discord_send',
      description: 'Publie un message dans le salon Discord lié au webhook.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: 'Contenu du message (max 2000 caractères)' } },
        required: ['content']
      },
      run: async (args) => {
        const r = await doFetch(data.webhookUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: String(args.content).slice(0, 2000) })
        });
        return r.ok ? 'Message publié sur Discord.' : trunc(`HTTP ${r.status}\n${r.text}`);
      }
    }];
  }
});

/* ---------- Contenu & Social ---------- */

register({
  id: 'youtube', name: 'YouTube (Data API)', icon: '▶️', category: 'Contenu & Social',
  description: 'Recherche de vidéos, détails et statistiques via l\'API YouTube Data v3 (clé API Google Cloud).',
  fields: [{ key: 'apiKey', label: 'Clé API Google', type: 'password', required: true }],
  buildTools(data) {
    const base = 'https://www.googleapis.com/youtube/v3';
    return [
      {
        name: 'youtube_search',
        description: 'Recherche des vidéos YouTube (titre, chaîne, date, videoId).',
        parameters: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Termes de recherche' },
            maxResults: { type: 'number', description: 'Max 25' },
            order: { type: 'string', enum: ['relevance', 'date', 'viewCount', 'rating'] }
          },
          required: ['q']
        },
        run: async (args) => {
          const url = buildUrl(base, '/search', { part: 'snippet', type: 'video', q: args.q, maxResults: Math.min(args.maxResults || 10, 25), order: args.order || 'relevance', key: data.apiKey });
          const r = await doFetch(url);
          const j = JSON.parse(r.text);
          if (j.error) return trunc(r.text);
          return trunc((j.items || []).map(i => `videoId:${i.id.videoId} | ${i.snippet.publishedAt} | ${i.snippet.channelTitle} | ${i.snippet.title}`).join('\n') || 'Aucun résultat.');
        }
      },
      {
        name: 'youtube_video_details',
        description: 'Détails et statistiques d\'une vidéo (vues, likes, description).',
        parameters: { type: 'object', properties: { videoId: { type: 'string' } }, required: ['videoId'] },
        run: async (args) => {
          const url = buildUrl(base, '/videos', { part: 'snippet,statistics,contentDetails', id: args.videoId, key: data.apiKey });
          const r = await doFetch(url);
          return trunc(r.text);
        }
      }
    ];
  }
});

register({
  id: 'brave_search', name: 'Recherche web (Brave)', icon: '🔎', category: 'Contenu & Social',
  description: 'Donne à l\'agent la capacité de chercher sur le web (clé gratuite sur brave.com/search/api).',
  fields: [{ key: 'token', label: 'Clé API Brave Search', type: 'password', required: true }],
  buildTools(data) {
    return [{
      name: 'web_search',
      description: 'Recherche sur le web et retourne les meilleurs résultats (titre, URL, description).',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' }, count: { type: 'number', description: 'Max 20' } },
        required: ['q']
      },
      run: async (args) => {
        const url = buildUrl('https://api.search.brave.com/res/v1', '/web/search', { q: args.q, count: Math.min(args.count || 8, 20) });
        const r = await doFetch(url, { headers: { 'X-Subscription-Token': data.token, 'Accept': 'application/json' } });
        try {
          const j = JSON.parse(r.text);
          const items = j.web?.results || [];
          return trunc(items.map(i => `${i.title}\n${i.url}\n${i.description || ''}`).join('\n\n') || 'Aucun résultat.');
        } catch { return trunc(`HTTP ${r.status}\n${r.text}`); }
      }
    }];
  }
});

register({
  id: 'openai_images', name: 'OpenAI Images (DALL·E)', icon: '🎨', category: 'IA',
  description: 'Génération d\'images via l\'API OpenAI (DALL·E 3).',
  fields: [{ key: 'apiKey', label: 'Clé API OpenAI', type: 'password', required: true }],
  buildTools(data) {
    return [{
      name: 'generate_image',
      description: 'Génère une image à partir d\'un prompt et retourne son URL.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'] }
        },
        required: ['prompt']
      },
      run: async (args) => {
        const r = await doFetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.apiKey}` },
          body: JSON.stringify({ model: 'dall-e-3', prompt: args.prompt, size: args.size || '1024x1024', n: 1 })
        }, 120000);
        try {
          const j = JSON.parse(r.text);
          if (j.data?.[0]?.url) return `Image générée : ${j.data[0].url}`;
          return trunc(r.text);
        } catch { return trunc(r.text); }
      }
    }];
  }
});

/* ---------- Presets d'API (auth pré-câblée + endpoint générique) ---------- */

const PRESETS = [
  {
    id: 'printify', name: 'Printify', icon: '👕', category: 'E-commerce',
    base: 'https://api.printify.com/v1', auth: 'bearer',
    hint: 'Endpoints utiles : GET /shops.json · GET /catalog/blueprints.json · GET /shops/{shop_id}/products.json · POST /shops/{shop_id}/products.json',
    description: 'API Printify complète (print on demand) : boutiques, catalogue, produits, commandes.'
  },
  {
    id: 'etsy', name: 'Etsy', icon: '🧶', category: 'E-commerce',
    base: 'https://openapi.etsy.com/v3', auth: ['header', 'x-api-key'],
    fields: [
      { key: 'token', label: 'Keystring (clé API)', type: 'password', required: true },
      { key: 'accessToken', label: 'Token OAuth (pour les endpoints privés)', type: 'password' }
    ],
    authExtra: (d) => d.accessToken ? { Authorization: `Bearer ${d.accessToken}` } : {},
    hint: 'Endpoints : GET /application/openapi-ping · GET /application/shops/{shop_id}/listings/active. Les endpoints privés demandent le token OAuth.',
    description: 'API Etsy v3 : boutiques, annonces, commandes (OAuth requis pour l\'écriture).'
  },
  {
    id: 'shopify', name: 'Shopify', icon: '🛍️', category: 'E-commerce',
    base: (d) => `https://${String(d.shopDomain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')}/admin/api/2024-10`,
    auth: ['header', 'X-Shopify-Access-Token'],
    fields: [
      { key: 'shopDomain', label: 'Domaine de la boutique', placeholder: 'maboutique.myshopify.com', required: true },
      { key: 'token', label: 'Token d\'accès Admin API', type: 'password', required: true }
    ],
    hint: 'Endpoints : GET /products.json · POST /products.json · GET /orders.json',
    description: 'Admin API Shopify : produits, commandes, clients.'
  },
  {
    id: 'stripe', name: 'Stripe', icon: '💳', category: 'E-commerce',
    base: 'https://api.stripe.com/v1', auth: 'bearer', bodyMode: 'form',
    hint: 'Corps en form-urlencoded (géré automatiquement). Endpoints : GET /customers · POST /payment_links · GET /charges',
    description: 'API Stripe : paiements, clients, liens de paiement, factures.'
  },
  {
    id: 'notion', name: 'Notion', icon: '📝', category: 'Productivité',
    base: 'https://api.notion.com/v1', auth: 'bearer',
    extraHeaders: { 'Notion-Version': '2022-06-28' },
    hint: 'Endpoints : POST /search · GET /databases/{id} · POST /pages',
    description: 'API Notion : bases de données, pages, recherche.'
  },
  {
    id: 'airtable', name: 'Airtable', icon: '📊', category: 'Productivité',
    base: 'https://api.airtable.com/v0', auth: 'bearer',
    hint: 'Endpoints : GET /{baseId}/{tableName} · POST /{baseId}/{tableName}',
    description: 'API Airtable : lecture/écriture de tables.'
  },
  {
    id: 'github', name: 'GitHub', icon: '🐙', category: 'Productivité',
    base: 'https://api.github.com', auth: 'bearer',
    extraHeaders: { Accept: 'application/vnd.github+json', 'User-Agent': 'lusine-agent' },
    hint: 'Endpoints : GET /user/repos · POST /repos/{owner}/{repo}/issues · GET /repos/{owner}/{repo}/contents/{path}',
    description: 'API GitHub : repos, issues, fichiers, PRs (token personnel).'
  },
  {
    id: 'slack', name: 'Slack', icon: '💬', category: 'Messagerie',
    base: 'https://slack.com/api', auth: 'bearer',
    hint: 'Endpoints : POST /chat.postMessage {channel, text} · GET /conversations.list',
    description: 'API Slack (bot token) : messages, canaux.'
  },
  {
    id: 'tiktok', name: 'TikTok', icon: '🎵', category: 'Contenu & Social',
    base: 'https://open.tiktokapis.com/v2', auth: 'bearer',
    hint: 'Nécessite une app approuvée sur developers.tiktok.com (le token vient de leur OAuth). Endpoints : GET /user/info/ · POST /post/publish/video/init/',
    description: 'API TikTok officielle — nécessite une app développeur approuvée par TikTok.'
  },
  {
    id: 'google_sheets', name: 'Google Sheets', icon: '📗', category: 'Productivité',
    base: 'https://sheets.googleapis.com/v4', auth: 'bearer',
    hint: 'Token OAuth Google requis. Endpoints : GET /spreadsheets/{id}/values/{range} · POST /spreadsheets/{id}/values/{range}:append?valueInputOption=RAW',
    description: 'API Google Sheets (token OAuth) : lecture/écriture de feuilles.'
  }
];

for (const p of PRESETS) {
  register({
    id: p.id, name: p.name, icon: p.icon, category: p.category,
    description: p.description,
    fields: p.fields || [{ key: 'token', label: 'Token / Clé API', type: 'password', required: true }],
    buildTools(data) { return [makeServiceTool(p.id, p.name, p, data)]; }
  });
}

/* ------------------------------------------------------------------ */

function listTypes() {
  return Object.values(TYPES).map(t => ({
    id: t.id, name: t.name, icon: t.icon, category: t.category,
    description: t.description, fields: t.fields
  }));
}

function buildToolsForCredential(type, data) {
  const t = TYPES[type];
  if (!t) return [];
  return t.buildTools(data);
}

module.exports = { TYPES, listTypes, buildToolsForCredential, trunc };
