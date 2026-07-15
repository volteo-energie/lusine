'use strict';
const crypto = require('crypto');
const { db } = require('./db');
const { decrypt, encrypt } = require('./crypto');
const { buildToolsForCredential, trunc } = require('./connectors');

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
/* Boucle agentique                                                    */
/* ------------------------------------------------------------------ */

async function runAgent({ node, input, onStep, shouldStop, userId }) {
  const cfg = node.config || {};
  if (!cfg.providerId) throw new Error(`Aucun fournisseur IA configuré pour l'agent « ${node.name} ». Ouvre l'agent et choisis un fournisseur.`);
  const provider = getProvider(cfg.providerId, userId);
  if (!provider) throw new Error(`Le fournisseur IA de l'agent « ${node.name} » n'existe plus.`);
  const model = cfg.model || provider.default_model;
  if (!model) throw new Error(`Aucun modèle défini pour l'agent « ${node.name} » (ni sur l'agent, ni par défaut sur le fournisseur).`);

  const tools = buildAgentTools(cfg.credentialIds || [], userId);
  const system = [
    `Tu es « ${node.name} », un agent autonome au sein d'une chaîne de travail nommée L'usine.`,
    `TA MISSION :\n${cfg.mission || '(aucune mission définie)'}`,
    `RÈGLES :`,
    `- Tu reçois en entrée le résultat de l'agent précédent (ou la donnée initiale de la chaîne).`,
    `- Utilise tes outils autant de fois que nécessaire pour accomplir ta mission réellement (pas de simulation).`,
    `- Quand ta mission est terminée, réponds UNIQUEMENT avec ton résultat final, clair et structuré : ce texte sera transmis tel quel à l'agent suivant de la chaîne.`,
    `- Si un outil échoue, adapte-toi ou explique précisément le blocage dans ton résultat final.`
  ].join('\n\n');

  const messages = [{ role: 'user', content: input && input.trim() ? input : 'Démarre ta mission.' }];
  const maxIter = Math.min(Number(cfg.maxIterations) || 8, 25);
  let lastText = '';

  for (let i = 0; i < maxIter; i++) {
    if (shouldStop()) throw new Error('__STOPPED__');
    const r = await callLLM(provider, { model, system, messages, tools, temperature: cfg.temperature ?? 0.7 });
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

/* ---------- Aiguillage : l'agent choisit lui-même la branche suivante ---------- */
async function chooseRoute({ node, output, candidates, userId }) {
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

async function runWorkflow({ workflowId, input, broadcast, source, userId }) {
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
  db.prepare('INSERT INTO executions (id, workflow_id, status, input, source, user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(execId, workflowId, 'running', input || '', source || 'manual', ownerId);
  running.set(execId, { stop: false });

  const logs = [];
  const saveLogs = (status, finished = false) => {
    db.prepare(`UPDATE executions SET logs = ?, status = ?${finished ? ", finished_at = datetime('now')" : ''} WHERE id = ?`)
      .run(JSON.stringify(logs), status, execId);
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

        try {
          const output = await runWithRetry(() => runAgent({
            node,
            input: nodeInput,
            userId: ownerId,
            shouldStop: () => running.get(execId)?.stop,
            onStep: (step) => {
              log.steps.push(step);
              broadcast({ type: 'node:step', execId, nodeId, step });
            }
          }), {
            retries, delayMs: retryDelay,
            onRetry: (n, e) => {
              const step = { type: 'llm', text: `⚠️ Échec (${e.message}) — nouvelle tentative ${n}/${retries} dans ${retryDelay / 1000}s…` };
              log.steps.push(step);
              broadcast({ type: 'node:step', execId, nodeId, step });
              saveLogs('running');
            }
          });
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
            const picked = await chooseRoute({ node, output, candidates, userId: ownerId });
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
          saveLogs('running');
        } catch (e) {
          if (e.message === '__STOPPED__') {
            log.status = 'stopped';
            status = 'stopped';
            broadcast({ type: 'node:error', execId, nodeId, error: 'Arrêté manuellement' });
            break;
          }
          log.status = 'error';
          log.error = e.message;
          log.finishedAt = new Date().toISOString();
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

module.exports = { runWorkflow, stopExecution, testAgent, callLLM, getProvider };
