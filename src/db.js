import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Amount convention everywhere in the app: negative = money leaving you
// (purchases, bills), positive = money coming in (salary, refunds, card repayments).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  institution TEXT NOT NULL,          -- 'anz_plus' | 'anz_credit' | 'amex' | 'other'
  type TEXT NOT NULL,                 -- 'transaction' | 'credit'
  sign_mode TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'normal' | 'inverted' (inverted = bank exports charges as positive)
  external_id TEXT UNIQUE,            -- Basiq account id when synced
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  description TEXT NOT NULL,
  merchant TEXT NOT NULL,             -- normalised description used for rules and grouping
  amount REAL NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorised',
  category_source TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'rule' | 'user'
  is_transfer INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'csv', -- 'csv' | 'basiq'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_merchant ON transactions(merchant);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,       -- matched against the normalised merchant
  category TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  category TEXT PRIMARY KEY,
  monthly_limit REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(dbPath = process.env.DB_PATH || './data/finance.db') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
