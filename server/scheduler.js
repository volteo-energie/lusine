'use strict';
/*
 * Planificateur de L'usine.
 * - Charge les triggers cron actifs et les programme (fuseau configurable).
 * - fireTrigger() est partagé par le cron ET les webhooks.
 * - syncTriggers() est rappelé après chaque création/modif/suppression de trigger.
 */
const { Cron } = require('croner');
const { db } = require('./db');

const TZ = process.env.LUSINE_TZ || 'Europe/Paris';

let jobs = new Map();   // triggerId -> instance Cron
let deps = null;        // { runWorkflow, broadcast }

/* Déclenche réellement un workflow depuis un trigger (relit la config fraîche). */
async function fireTrigger(triggerId, { source = 'cron', inputOverride } = {}) {
  const trigger = db.prepare('SELECT * FROM triggers WHERE id = ?').get(triggerId);
  if (!trigger) throw new Error('Déclencheur introuvable');
  if (!trigger.enabled) throw new Error('Déclencheur désactivé');

  let config = {};
  try { config = JSON.parse(trigger.config || '{}'); } catch {}
  const input = (inputOverride !== undefined && inputOverride !== null && inputOverride !== '')
    ? inputOverride
    : (config.input || '');

  const execId = await deps.runWorkflow({
    workflowId: trigger.workflow_id,
    input,
    broadcast: deps.broadcast,
    source,
    userId: trigger.user_id
  });

  db.prepare("UPDATE triggers SET last_fired_at = datetime('now'), last_exec_id = ? WHERE id = ?")
    .run(execId, trigger.id);
  deps.broadcast({ type: 'trigger:fired', triggerId: trigger.id, workflowId: trigger.workflow_id, execId, source });
  return execId;
}

function scheduleCron(trigger) {
  let config = {};
  try { config = JSON.parse(trigger.config || '{}'); } catch {}
  if (!config.expression) return null;
  try {
    return new Cron(config.expression, { timezone: TZ }, () => {
      fireTrigger(trigger.id, { source: 'cron' }).catch(e => {
        console.error(`[scheduler] trigger ${trigger.id} en erreur :`, e.message);
        try { deps.broadcast({ type: 'trigger:error', triggerId: trigger.id, error: e.message }); } catch {}
      });
    });
  } catch (e) {
    console.error(`[scheduler] expression cron invalide (${config.expression}) :`, e.message);
    return null;
  }
}

/* (Re)charge tous les triggers cron actifs. */
function syncTriggers() {
  for (const job of jobs.values()) { try { job.stop(); } catch {} }
  jobs = new Map();
  const rows = db.prepare("SELECT * FROM triggers WHERE type = 'cron' AND enabled = 1").all();
  for (const t of rows) {
    const job = scheduleCron(t);
    if (job) jobs.set(t.id, job);
  }
  return jobs.size;
}

/* Aperçu des prochaines exécutions d'une expression (pour l'UI). */
function nextRuns(expression, count = 3) {
  try {
    const job = new Cron(expression, { timezone: TZ });
    const out = [];
    let d = null;
    for (let i = 0; i < count; i++) {
      d = job.nextRun(d || undefined);
      if (!d) break;
      out.push(d.toISOString());
    }
    job.stop();
    return out;
  } catch {
    return null; // expression invalide
  }
}

function initScheduler(d) {
  deps = d;
  const n = syncTriggers();
  console.log(`  ⏰  Planificateur : ${n} déclencheur(s) cron actif(s) — fuseau ${TZ}`);
}

module.exports = { initScheduler, syncTriggers, fireTrigger, nextRuns, TZ };
