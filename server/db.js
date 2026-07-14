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
  password_hash TEXT NOT NULL,
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

module.exports = { db, DATA_DIR };
