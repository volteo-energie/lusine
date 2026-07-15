'use strict';
const crypto = require('crypto');
const { db } = require('./db');
const { decrypt, encrypt } = require('./crypto');
const { buildToolsForCredential, trunc } = require('./connectors');
const { costEUR } = require('./pricing');

/* ------------------------------------------------------------------ */
/* Adaptateurs LLM (fetch natif, pas de SDK)                           */
/* ------------------------------------------------------------------ */

async function callAnthropic({ apiKey, model, system, messages, tools, temperature }) {
  const body = {
    model,
    max_tokens: 4096,
    system,
    messages,
    temperature: temperature ?? 0.7
  };
  if (tools?.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 400)}`);
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const toolCalls = (j.content || []).filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input }));
  return {
    text, toolCalls,
    usage: { inTok: j.usage?.input_tokens || 0, outTok: j.usage?.output_tokens || 0 },
    appendAssistant: (msgs) => msgs.push({ role: 'assistant', content: j.content }),
    appendToolResults: (msgs, results) => msgs.push({
      role: 'user',
      content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.output }))
    })
  };
}

async function callOpenAI({ baseUrl, apiKey, model, system, messages, tools, temperature }) {
  const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: temperature ?? 0.7
  };
  if (tools?.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 400)}`);
  const msg = j.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map(tc => {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
    return { id: tc.id, name: tc.function.name, args };
  });
  return {
    text: msg.content || '', toolCalls,
    usage: { inTok: j.usage?.prompt_tokens || 0, outTok: j.usage?.completion_tokens || 0 },
    appendAssistant: (msgs) => msgs.push(msg),
    appendToolResults: (msgs, results) => {
      for (const r of results) msgs.push({ role: 'tool', tool_call_id: r.id, content: r.output });
    }
  };
}

function getProvider(providerId, userId) {
  const row = userId
    ? db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?').get(providerId, userId)
    : db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId);
  if (!row) return null;
  return { ...row, apiKey: decrypt(row.api_key_enc) };
}

async function callLLM(provider, opts) {
  if (provider.type === 'anthropic') return callAnthropic({ apiKey: provider.apiKey, ...opts });
  return callOpenAI({ baseUrl: provider.base_url, apiKey: provider.apiKey, ...opts });
}

/* ------------------------------------------------------------------ */
/* Outils d'un agent à partir de ses credentials                       */
/* ------------------------------------------------------------------ */

function buildAgentTools(credentialIds = [], userId) {
  const tools = [];
  const seen = new Set();
  for (const cid of credentialIds) {
    const row = userId
      ? db.prepare('SELECT * FROM credentials WHERE id = ? AND user_id = ?').get(cid, userId)
      : db.prepare('SELECT * FROM credentials WHERE id = ?').get(cid);
    if (!row) continue;
    let data = {};
    try { data = JSON.parse(decrypt(row.data_enc)); } catch { continue; }
    // Permet à un connecteur de sauvegarder des données mises à jour (ex: token OAuth rafraîchi)
    const persist = (patch) => {
      try {
        Object.assign(data, patch);
        db.prepare('UPDATE credentials SET data_enc = ? WHERE id = ?').run(encrypt(JSON.stringify(data)), row.id);
      } catch (_) { /* best effort */ }
    };
    for (const tool of buildToolsForCredential(row.type, data, { userId, persist })) {
      let name = tool.name, i = 2;
      while (seen.has(name)) name = `${tool.name}_${i++}`;
      seen.add(name);
      tools.push({ ...tool, name });
    }
  }
  return tools;
}

/* ------------------------------------------------------------------ */
/* Mémoire d'usine : outils de mémoire persistante par workflow        */
/* ------------------------------------------------------------------ */

function buildMemoryTools(workflowId, userId) {
  return [
    {
      name: 'memoire_ecrire',
      description: 'Écrit (ou remplace) une entrée dans la mémoire persistante de la chaîne. Utilise-la pour retenir ce qui doit survivre aux exécutions : clients déjà contactés, sujets déjà traités, préférences apprises, compteurs…',
      parameters: {
        type: 'object',
        properties: {
          cle: { type: 'string', description: 'Nom court de l\'entrée (ex: "sujets_traites")' },
          valeur: { type: 'string', description: 'Contenu à mémoriser' }
        },
        required: ['cle', 'valeur']
      },
      run: async (args) => {
        const key = String(args.cle || '').slice(0, 120);
        if (!key) return 'ERREUR : clé vide';
        const value = String(args.valeur ?? '').slice(0, 8000);
        db.prepare(`INSERT INTO memories (id, workflow_id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(workflow_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
          .run(crypto.randomUUID(), workflowId, userId || null, key, value);
        return `Mémorisé sous « ${key} » (${value.length} caractères).`;
      }
    },
    {
      name: 'memoire_lire',
      description: 'Lit la mémoire persistante de la chaîne. Sans clé : liste toutes les entrées. Avec une clé : renvoie son contenu.',
      parameters: {
        type: 'object',
        properties: { cle: { type: 'string', description: 'Clé à lire (optionnel)' } }
      },
      run: async (args) => {
        if (args.cle) {
          const row = db.prepare('SELECT value, updated_at FROM memories WHERE workflow_id = ? AND key = ?').get(workflowId, String(args.cle));
          return row ? `[${row.updated_at}] ${row.value}` : `(aucune entrée « ${args.cle} »)`;
        }
        const rows = db.prepare('SELECT key, value, updated_at FROM memories WHERE workflow_id = ? ORDER BY updated_at DESC LIMIT 50').all(workflowId);
        if (!rows.length) return '(mémoire vide)';
        return rows.map(r => `• ${r.key} [${r.updated_at}] : ${trunc(r.value, 400)}`).join('\n');
      }
    }
  ];
}

/* ------------------------------------------------------------------ */
/* Boucle agentique                                                    */
/* ------------------------------------------------------------------ */

async function runAgent({ node, input, onStep, shouldStop, userId, workflowId, dryRun, onUsage }) {
  const cfg = node.config || {};
  if (!cfg.providerId) throw new Error(`Aucun fournisseur IA configuré pour l'agent « ${node.name} ». Ouvre l'agent et choisis un fournisseur.`);
  const provider = getProvider(cfg.providerId, userId);
  if (!provider) throw new Error(`Le fournisseur IA de l'agent « ${node.name} » n'existe plus.`);
  const model = cfg.model || provider.default_model;
  if (!model) throw new Error(`Aucun modèle défini pour l'agent « ${node.name} » (ni sur l'agent, ni par défaut sur le fournisseur).`);

  let tools = buildAgentTools(cfg.credentialIds || [], userId);
  if (workflowId) tools = tools.concat(buildMemoryTools(workflowId, userId));

  /* Mode simulation : les outils réels sont doublés par le LLM (rien n'est envoyé) */
  if (dryRun) {
    tools = tools.map(t => ({
      ...t,
      run: async (args) => {
        if (t.name.startsWith('memoire_')) return t.run(args); // la mémoire reste réelle (inoffensive)
        try {
          const r = await callLLM(provider, {
            model, temperature: 0.3, tools: [],
            system: `Tu simules la réponse d'un outil d'API pour une répétition générale. Outil : « ${t.name} » — ${t.description || ''}. Réponds UNIQUEMENT ce que l'outil renverrait de façon réaliste et plausible (même format qu'une vraie réponse, concis). N'exécute rien : c'est une simulation.`,
            messages: [{ role: 'user', content: `Arguments de l'appel :\n${JSON.stringify(args || {}, null, 2)}` }]
          });
          if (onUsage && r.usage) onUsage(r.usage);
          return `[SIMULATION] ${r.text || '(réponse simulée vide)'}`;
        } catch (e) {
          return `[SIMULATION] (impossible de simuler : ${e.message})`;
        }
      }
    }));
  }

  const system = [
    `Tu es « ${node.name} », un agent autonome au sein d'une chaîne de travail nommée L'usine.`,
    `TA MISSION :\n${cfg.mission || '(aucune mission définie)'}`,
    `RÈGLES :`,
    `- Tu reçois en entrée le résultat de l'agent précédent (ou la donnée initiale de la chaîne).`,
    `- Utilise tes outils autant de fois que nécessaire pour accomplir ta mission réellement (pas de simulation).`,
    `- Quand ta mission est terminée, réponds UNIQUEMENT avec ton résultat final, clair et structuré : ce texte sera transmis tel quel à l'agent suivant de la chaîne.`,
    `- Si un outil échoue, adapte-toi ou explique précisément le blocage dans ton résultat final.`,
    ...(workflowId ? [`- Tu disposes d'une mémoire persistante partagée par toute la chaîne (outils memoire_lire / memoire_ecrire) : consulte-la si le passé peut t'aider, enrichis-la quand tu apprends quelque chose de durable.`] : [])
  ].join('\n\n');

  const messages = [{ role: 'user', content: input && input.trim() ? input : 'Démarre ta mission.' }];
  const maxIter = Math.min(Number(cfg.maxIterations) || 8, 25);
  let lastText = '';

  for (let i = 0; i < maxIter; i++) {
    if (shouldStop()) throw new Error('__STOPPED__');
    const r = await callLLM(provider, { model, system, messages, tools, temperature: cfg.temperature ?? 0.7 });
    if (onUsage && r.usage) onUsage(r.usage);
    if (r.text) { lastText = r.text; onStep({ type: 'llm', text: trunc(r.text, 4000) }); }
    if (!r.toolCalls.length) return r.text || lastText || '(réponse vide)';

    r.appendAssistant(messages);
    const results = [];
    for (const tc of r.toolCalls) {
      if (shouldStop()) throw new Error('__STOPPED__');
      onStep({ type: 'tool:start', name: tc.name, args: tc.args });
      const tool = tools.find(t => t.name === tc.name);
      let output;
      try {
        output = tool ? await tool.run(tc.args || {}) : `Outil inconnu : ${tc.name}`;
      } catch (e) {
        output = `ERREUR de l'outil ${tc.name} : ${e.message}`;
      }
      onStep({ type: 'tool:end', name: tc.name, result: trunc(String(output), 2500) });
      results.push({ id: tc.id, output: String(output) });
    }
    r.appendToolResults(messages, results);
  }
  return lastText + '\n\n[Limite d\'itérations atteinte — résultat possiblement incomplet]';
}

/* ------------------------------------------------------------------ */
/* Runner de workflow (chaîne)                                         */
/* ------------------------------------------------------------------ */

const running = new Map(); // execId -> { stop: bool }

function topoSort(nodes, connections) {
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const c of connections) {
    if (!indeg.has(c.from) || !indeg.has(c.to)) continue;
    indeg.set(c.to, indeg.get(c.to) + 1);
    adj.get(c.from).push(c.to);
  }
  const queue = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) throw new Error('La chaîne contient une boucle : impossible de déterminer un ordre d\'exécution.');
  return order;
}

/* ---------- Boucle : découpe une entrée en éléments à traiter un par un ---------- */
async function splitItems({ node, input, userId, hint, max, onUsage }) {
  const raw = String(input ?? '').trim();
  if (!raw) return [];
  // 1) Si l'entrée est déjà un tableau JSON, on l'utilise tel quel
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j) && j.length) {
      return j.map(x => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).slice(0, max);
    }
  } catch (_) { /* pas du JSON, on passe au découpage intelligent */ }

  // 2) Découpage par le LLM
  const cfg = node.config || {};
  const provider = getProvider(cfg.providerId, userId);
  const model = cfg.model || provider?.default_model;
  if (!provider || !model) return [raw];
  const system = `Tu découpes un contenu en éléments distincts, destinés à être traités séparément.${hint ? `\nUn élément = ${hint}.` : ''}
Réponds UNIQUEMENT par un tableau JSON de chaînes de caractères. Chaque chaîne doit contenir TOUT le contenu de son élément (ne perds aucune information utile : titres, descriptions, prix, URLs…).
Aucun autre texte, aucune balise markdown. Si le contenu ne contient qu'un seul élément, renvoie un tableau d'un seul élément.`;
  try {
    const r = await callLLM(provider, {
      model, system, tools: [], temperature: 0,
      messages: [{ role: 'user', content: trunc(raw, 12000) }]
    });
    if (onUsage && r.usage) onUsage(r.usage);
    let txt = String(r.text || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const arr = JSON.parse(txt);
    if (Array.isArray(arr) && arr.length) {
      return arr.map(x => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).slice(0, max);
    }
  } catch (_) { /* découpage impossible → on traite en un seul bloc */ }
  return [raw];
}

/* ---------- Aiguillage : l'agent choisit lui-même la branche suivante ---------- */
async function chooseRoute({ node, output, candidates, userId, onUsage }) {
  const cfg = node.config || {};
  const provider = getProvider(cfg.providerId, userId);
  const model = cfg.model || provider?.default_model;
  if (!provider || !model) return candidates.map(c => c.id); // pas de quoi décider → tout activer
  const list = candidates.map((c, i) =>
    `${i + 1}. ${c.name}${c.config?.mission ? ` — ${String(c.config.mission).slice(0, 250)}` : ''}`).join('\n');
  const system = `Tu es un aiguilleur dans une chaîne d'agents. D'après le résultat fourni, choisis LE SEUL agent suivant qui doit traiter la suite.${cfg.routeHint ? `\nCritère de choix : ${cfg.routeHint}` : ''}\nRéponds UNIQUEMENT par le numéro de l'agent choisi (ex : 2). Aucun autre texte.`;
  const messages = [{ role: 'user', content: `Agents disponibles :\n${list}\n\nRésultat à aiguiller :\n${trunc(output, 4000)}\n\nNuméro de l'agent choisi :` }];
  try {
    const r = await callLLM(provider, { model, system, messages, tools: [], temperature: 0 });
    if (onUsage && r.usage) onUsage(r.usage);
    const m = String(r.text || '').match(/\d+/);
    const idx = m ? Number(m[0]) - 1 : -1;
    if (idx >= 0 && idx < candidates.length) return [candidates[idx].id];
  } catch (_) { /* en cas d'échec, on ne bloque pas la chaîne */ }
  return [candidates[0].id];
}

/* ---------- Retry ---------- */
async function runWithRetry(fn, { retries = 0, delayMs = 3000, onRetry }) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e.message === '__STOPPED__') throw e;
      last = e;
      if (attempt < retries) {
        if (onRetry) onRetry(attempt + 1, e);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw last;
}

/* ---------- Notification d'échec (webhook Discord / Slack / générique) ---------- */
async function notifyFailure(url, payload) {
  if (!url) return;
  const text = `🔴 L'usine — échec de la chaîne « ${payload.workflow} »\nAgent : ${payload.node || '—'}\nErreur : ${payload.error}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, text, ...payload }), // content=Discord, text=Slack, reste=générique
      signal: ctrl.signal
    }).finally(() => clearTimeout(t));
  } catch (_) { /* la notification ne doit jamais casser l'exécution */ }
}

/* ---------- Rapport Telegram de fin d'exécution (chef d'atelier) ---------- */
function fmtEur(v) {
  if (v === null || v === undefined) return null;
  return v < 0.01 ? '< 0,01 €' : `≈ ${v.toFixed(2).replace('.', ',')} €`;
}

async function sendTelegramReport({ credId, ownerId, wfName, status, dryRun, totals, durationS, lastOutput }) {
  if (!credId) return;
  try {
    const row = db.prepare('SELECT * FROM credentials WHERE id = ? AND user_id = ?').get(credId, ownerId);
    if (!row) return;
    const data = JSON.parse(decrypt(row.data_enc));
    if (!data.botToken) return;
    const link = db.prepare('SELECT chat_id FROM tg_links WHERE credential_id = ? AND enabled = 1').get(credId);
    const chatId = link?.chat_id || data.defaultChatId;
    if (!chatId) return;

    const head = status === 'success' ? '✅' : status === 'stopped' ? '⏹' : status === 'partial' ? '🟠' : '🔴';
    const lines = [
      `${head} L'usine — « ${wfName} »${dryRun ? ' (SIMULATION)' : ''}`,
      `Statut : ${status} · Durée : ${durationS}s`,
      `Tokens : ${totals.inTok + totals.outTok}${totals.priced ? ` · Coût ${fmtEur(totals.eur)}` : ''}`
    ];
    if (lastOutput) lines.push('', trunc(String(lastOutput), 700));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    await fetch(`https://api.telegram.org/bot${data.botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n') }),
      signal: ctrl.signal
    }).finally(() => clearTimeout(t));
  } catch (_) { /* le rapport ne doit jamais casser l'exécution */ }
}

async function runWorkflow({ workflowId, input, broadcast, source, userId, dryRun }) {
  const startedMs = Date.now();
  const wf = userId
    ? db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(workflowId, userId)
    : db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
  if (!wf) throw new Error('Workflow introuvable');
  const ownerId = wf.user_id || userId;
  const data = JSON.parse(wf.data);
  const nodes = data.nodes || [];
  const connections = data.connections || [];
  if (!nodes.length) throw new Error('Le workflow ne contient aucun agent.');

  const execId = crypto.randomUUID();
  db.prepare('INSERT INTO executions (id, workflow_id, status, input, source, user_id, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(execId, workflowId, 'running', input || '', source || 'manual', ownerId, dryRun ? 1 : 0);
  running.set(execId, { stop: false });

  /* Comptabilité tokens → € (totaux de l'exécution) */
  const totals = { inTok: 0, outTok: 0, eur: 0, priced: false };
  const modelOfNode = (cfg) => cfg.model
    || (cfg.providerId ? db.prepare('SELECT default_model FROM providers WHERE id = ?').get(cfg.providerId)?.default_model : null);

  const logs = [];
  const saveLogs = (status, finished = false) => {
    db.prepare(`UPDATE executions SET logs = ?, status = ?, tokens_in = ?, tokens_out = ?, cost_eur = ?${finished ? ", finished_at = datetime('now')" : ''} WHERE id = ?`)
      .run(JSON.stringify(logs), status, totals.inTok, totals.outTok, totals.priced ? totals.eur : null, execId);
  };

  broadcast({ type: 'exec:start', execId, workflowId, source: source || 'manual', nodeIds: nodes.map(n => n.id) });

  // exécution async (le POST /run retourne immédiatement l'execId)
  (async () => {
    const outputs = new Map();
    let status = 'success';
    let failedNode = null, failedError = null;
    try {
      const order = topoSort(nodes, connections);
      const byId = new Map(nodes.map(n => [n.id, n]));
      const activeIn = new Map();   // nodeId → Set des prédécesseurs dont la branche est active

      for (const nodeId of order) {
        const node = byId.get(nodeId);
        const cfg = node.config || {};
        const inConns = connections.filter(c => c.to === nodeId);
        const live = [...(activeIn.get(nodeId) || [])];

        // Branche non retenue par un aiguilleur → l'agent est ignoré
        if (inConns.length && !live.length) {
          logs.push({ nodeId, name: node.name, status: 'skipped', reason: 'branche non retenue' });
          broadcast({ type: 'node:skipped', execId, nodeId });
          saveLogs('running');
          continue;
        }

        let nodeInput;
        if (!inConns.length) nodeInput = input || '';
        else if (live.length === 1) nodeInput = outputs.get(live[0]) || '';
        else nodeInput = live.map(p => `### Résultat de « ${byId.get(p)?.name || p} » :\n${outputs.get(p) || ''}`).join('\n\n');

        const log = { nodeId, name: node.name, status: 'running', startedAt: new Date().toISOString(), steps: [], output: null };
        logs.push(log);
        broadcast({ type: 'node:start', execId, nodeId, name: node.name });
        saveLogs('running');

        const retries = Math.min(Math.max(Number(cfg.retries) || 0, 0), 5);
        const retryDelay = Math.max(Number(cfg.retryDelay) || 3, 1) * 1000;

        /* usage tokens de ce nœud (tous appels confondus : agent, simulation, découpage, aiguillage) */
        const nodeUsage = { inTok: 0, outTok: 0 };
        const onUsage = (u) => {
          nodeUsage.inTok += u.inTok || 0; nodeUsage.outTok += u.outTok || 0;
          totals.inTok += u.inTok || 0; totals.outTok += u.outTok || 0;
        };
        const settleUsage = () => {
          const eur = costEUR(modelOfNode(cfg), nodeUsage.inTok, nodeUsage.outTok);
          log.usage = { inTok: nodeUsage.inTok, outTok: nodeUsage.outTok, eur };
          if (eur !== null) { totals.eur += eur; totals.priced = true; }
        };

        const pushStep = (step) => {
          log.steps.push(step);
          broadcast({ type: 'node:step', execId, nodeId, step });
        };
        const runOnce = (inp) => runWithRetry(() => runAgent({
          node,
          input: inp,
          userId: ownerId,
          workflowId,
          dryRun: !!dryRun,
          onUsage,
          shouldStop: () => running.get(execId)?.stop,
          onStep: pushStep
        }), {
          retries, delayMs: retryDelay,
          onRetry: (n, e) => {
            pushStep({ type: 'llm', text: `⚠️ Échec (${e.message}) — nouvelle tentative ${n}/${retries} dans ${retryDelay / 1000}s…` });
            saveLogs('running');
          }
        });

        try {
          let output;
          if (cfg.loop === 'foreach') {
            const max = Math.min(Math.max(Number(cfg.loopMaxItems) || 10, 1), 50);
            const items = await splitItems({ node, input: nodeInput, userId: ownerId, hint: cfg.loopSplitHint, max, onUsage });
            if (items.length > 1) {
              pushStep({ type: 'llm', text: `🔁 ${items.length} élément(s) à traiter un par un` });
              saveLogs('running');
              const results = [];
              for (let i = 0; i < items.length; i++) {
                if (running.get(execId)?.stop) throw new Error('__STOPPED__');
                pushStep({ type: 'llm', text: `— Élément ${i + 1}/${items.length}` });
                saveLogs('running');
                try {
                  results.push(`### Élément ${i + 1}/${items.length}\n${await runOnce(items[i])}`);
                } catch (e) {
                  if (e.message === '__STOPPED__') throw e;
                  if (cfg.onError === 'continue') {
                    results.push(`### Élément ${i + 1}/${items.length}\n⚠️ Échec : ${e.message}`);
                    pushStep({ type: 'llm', text: `⚠️ Élément ${i + 1} en échec — on passe au suivant` });
                  } else throw e;
                }
              }
              output = results.join('\n\n');
            } else {
              output = await runOnce(items[0] ?? nodeInput);
            }
          } else {
            output = await runOnce(nodeInput);
          }
          log.status = 'success';
          log.output = output;
          log.finishedAt = new Date().toISOString();
          outputs.set(nodeId, output);
          broadcast({ type: 'node:done', execId, nodeId, output: trunc(output, 2000) });

          // Quelles branches de sortie activer ?
          const outConns = connections.filter(c => c.from === nodeId);
          let chosen = outConns;
          if (cfg.isRouter && outConns.length > 1) {
            const candidates = outConns.map(c => byId.get(c.to)).filter(Boolean);
            const picked = await chooseRoute({ node, output, candidates, userId: ownerId, onUsage });
            chosen = outConns.filter(c => picked.includes(c.to));
            const names = chosen.map(c => byId.get(c.to)?.name).filter(Boolean).join(', ');
            log.route = names;
            const step = { type: 'llm', text: `🔀 Aiguillage → ${names || '(aucune branche)'}` };
            log.steps.push(step);
            broadcast({ type: 'node:step', execId, nodeId, step });
          }
          for (const c of chosen) {
            if (!activeIn.has(c.to)) activeIn.set(c.to, new Set());
            activeIn.get(c.to).add(nodeId);
          }
          settleUsage();
          saveLogs('running');
        } catch (e) {
          if (e.message === '__STOPPED__') {
            log.status = 'stopped';
            status = 'stopped';
            settleUsage();
            broadcast({ type: 'node:error', execId, nodeId, error: 'Arrêté manuellement' });
            break;
          }
          log.status = 'error';
          log.error = e.message;
          log.finishedAt = new Date().toISOString();
          settleUsage();
          failedNode = node.name; failedError = e.message;
          broadcast({ type: 'node:error', execId, nodeId, error: e.message });

          if (cfg.onError === 'continue') {
            // la chaîne continue : on transmet l'erreur en clair à la suite
            const msg = `⚠️ L'agent « ${node.name} » a échoué : ${e.message}`;
            outputs.set(nodeId, msg);
            status = status === 'success' ? 'partial' : status;
            for (const c of connections.filter(c => c.from === nodeId)) {
              if (!activeIn.has(c.to)) activeIn.set(c.to, new Set());
              activeIn.get(c.to).add(nodeId);
            }
            saveLogs('running');
            continue;
          }
          status = 'error';
          break;
        }
      }
      // marque les agents jamais lancés
      for (const n of nodes) {
        if (!logs.find(l => l.nodeId === n.id)) logs.push({ nodeId: n.id, name: n.name, status: 'skipped' });
      }
    } catch (e) {
      status = 'error';
      failedError = e.message;
      logs.push({ nodeId: null, name: 'Chaîne', status: 'error', error: e.message });
      broadcast({ type: 'exec:error', execId, error: e.message });
    } finally {
      saveLogs(status, true);
      running.delete(execId);
      broadcast({ type: 'exec:done', execId, status });
      if (status === 'error' || status === 'partial') {
        notifyFailure(data.settings?.notifyWebhookUrl, {
          workflow: wf.name, node: failedNode, error: failedError || 'inconnue',
          status, execId, source: source || 'manual', at: new Date().toISOString()
        });
      }
      if (data.settings?.telegramCredId) {
        const lastLog = [...logs].reverse().find(l => l.output);
        sendTelegramReport({
          credId: data.settings.telegramCredId, ownerId, wfName: wf.name, status,
          dryRun: !!dryRun, totals, durationS: Math.round((Date.now() - startedMs) / 1000),
          lastOutput: status === 'success' ? lastLog?.output : failedError
        });
      }
    }
  })();

  return execId;
}

function stopExecution(execId) {
  const r = running.get(execId);
  if (r) { r.stop = true; return true; }
  return false;
}

/* Test d'un agent seul (depuis le panneau de config) */
async function testAgent({ node, input, userId }) {
  const steps = [];
  const output = await runAgent({
    node, input, userId,
    shouldStop: () => false,
    onStep: (s) => steps.push(s)
  });
  return { output, steps };
}

/* ------------------------------------------------------------------ */
/* Contremaître : relit une exécution et propose des missions          */
/* améliorées, nœud par nœud. L'usine apprend de ses passages.         */
/* ------------------------------------------------------------------ */
async function reviewExecution({ execId, userId }) {
  const e = db.prepare('SELECT * FROM executions WHERE id = ? AND user_id = ?').get(execId, userId);
  if (!e) throw new Error('Exécution introuvable');
  const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(e.workflow_id);
  if (!wf) throw new Error('Le workflow de cette exécution n\'existe plus');
  const data = JSON.parse(wf.data);
  const nodes = data.nodes || [];
  const logs = JSON.parse(e.logs || '[]');

  // Le contremaître utilise le fournisseur du premier agent qui en a un
  const withProvider = nodes.find(n => n.config?.providerId && getProvider(n.config.providerId, userId));
  if (!withProvider) throw new Error('Aucun fournisseur IA disponible pour le contremaître');
  const provider = getProvider(withProvider.config.providerId, userId);
  const model = withProvider.config.model || provider.default_model;

  const nodeDesc = nodes.map(n =>
    `- id: ${n.id} | nom: ${n.name}\n  mission actuelle: ${trunc(n.config?.mission || '(vide)', 600)}`).join('\n');
  const logDesc = logs.map(l => {
    const parts = [`- agent: ${l.name} (id: ${l.nodeId}) — statut: ${l.status}`];
    if (l.error) parts.push(`  erreur: ${trunc(l.error, 400)}`);
    if (l.output) parts.push(`  résultat: ${trunc(l.output, 800)}`);
    if (l.usage) parts.push(`  tokens: ${l.usage.inTok + l.usage.outTok}${l.usage.eur != null ? ` (~${l.usage.eur.toFixed(3)} €)` : ''}`);
    return parts.join('\n');
  }).join('\n');

  const system = `Tu es le CONTREMAÎTRE de L'usine : un expert en agents IA qui audite les chaînes après exécution pour les rendre plus fiables, plus précises et moins chères.
Tu reçois la composition d'une chaîne (missions des agents) et les logs d'une exécution.
Analyse ce qui s'est réellement passé : erreurs, résultats faibles ou trop verbeux, missions ambiguës, gaspillage de tokens, outils mal exploités.
Réponds UNIQUEMENT avec un JSON valide (aucun texte autour, pas de balises markdown) au format :
{
  "diagnostic": "2 à 4 phrases en français : ce qui a bien/mal fonctionné et pourquoi",
  "suggestions": [
    { "nodeId": "<id de l'agent>", "probleme": "1 phrase", "mission": "la mission réécrite, complète et prête à coller" }
  ]
}
Règles : max 3 suggestions, uniquement pour les agents où une réécriture apporte un vrai gain. Si la chaîne est déjà bonne, renvoie "suggestions": [] et dis-le dans le diagnostic. Les missions réécrites restent en français, concrètes, orientées résultat.`;

  const user = `CHAÎNE « ${wf.name} » — exécution ${e.status}${e.dry_run ? ' (simulation)' : ''} du ${e.started_at}
AGENTS :
${nodeDesc}

LOGS DE L'EXÉCUTION :
${trunc(logDesc, 14000)}`;

  const r = await callLLM(provider, {
    model, system, tools: [], temperature: 0.2,
    messages: [{ role: 'user', content: user }]
  });
  let txt = String(r.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(txt); } catch { throw new Error('Le contremaître a renvoyé une réponse illisible — réessaie.'); }
  const valid = new Set(nodes.map(n => n.id));
  const suggestions = (parsed.suggestions || [])
    .filter(s => s && valid.has(s.nodeId) && s.mission)
    .slice(0, 3)
    .map(s => ({ nodeId: s.nodeId, name: nodes.find(n => n.id === s.nodeId)?.name || '', probleme: String(s.probleme || ''), mission: String(s.mission) }));
  return {
    diagnostic: String(parsed.diagnostic || ''),
    suggestions,
    usage: r.usage || null
  };
}

module.exports = { runWorkflow, stopExecution, testAgent, callLLM, getProvider, reviewExecution };
