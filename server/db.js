'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.LUSINE_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'lusine.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  password_hash TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,              -- anthropic | openai | openai_compatible
  base_url TEXT,
  api_key_enc TEXT NOT NULL,
  default_model TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  data_enc TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{"nodes":[],"connections":[]}',
  active INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',   -- running | success | error | stopped
  input TEXT,
  logs TEXT DEFAULT '[]',
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_wf ON executions(workflow_id, started_at DESC);
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,                       -- cron | webhook
  name TEXT,
  config TEXT NOT NULL DEFAULT '{}',        -- cron: {expression,input} | webhook: {inputMode,input}
  secret TEXT,                              -- webhook uniquement
  enabled INTEGER DEFAULT 1,
  last_fired_at TEXT,
  last_exec_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trig_wf ON triggers(workflow_id);
`);

/* Marque la source d'une exécution (manual | cron | webhook) — migration additive */
try { db.exec("ALTER TABLE executions ADD COLUMN source TEXT DEFAULT 'manual'"); } catch (_) {}

/* ---------- Migration multi-utilisateur (v3) ---------- */
// Colonnes additives (idempotentes)
try { db.exec("ALTER TABLE users ADD COLUMN email TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1"); } catch (_) {}
for (const table of ['providers', 'credentials', 'workflows', 'executions', 'triggers']) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`); } catch (_) {}
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_prov_user ON providers(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_cred_user ON credentials(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_wf_user ON workflows(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_exec_user ON executions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_trig_user ON triggers(user_id)');

/* ---------- Facturation Stripe (v3.5) ---------- */
try { db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT"); } catch (_) {}
db.exec(`CREATE TABLE IF NOT EXISTS pending_activations (
  email TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  plan TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

// Rattache l'utilisateur historique (mono-tenant) et toutes ses données à son compte
const legacyUser = db.prepare('SELECT id, email FROM users ORDER BY created_at LIMIT 1').get();
if (legacyUser) {
  if (!legacyUser.email) {
    const adminEmail = process.env.LUSINE_ADMIN_EMAIL || 'admin@lusineai.fr';
    try { db.prepare('UPDATE users SET email = ? WHERE id = ?').run(adminEmail, legacyUser.id); } catch (_) {}
  }
  // toutes les lignes orphelines (créées avant le multi-tenant) appartiennent à l'admin
  for (const table of ['providers', 'credentials', 'workflows', 'executions', 'triggers']) {
    db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`).run(legacyUser.id);
  }
}

module.exports = { db, DATA_DIR };
