import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, openDb } from './db.js';
import { parseStatement, shouldInvert } from './importers/csv.js';
import { importRows, matchTransfers } from './importer.js';
import { CATEGORIES, learnRule, recategoriseAll } from './categorize.js';
import { insights, overview } from './analysis.js';
import { advisorAvailable, describeError, streamAdvice } from './advisor.js';
import { basiqConfigured, consentUrl, listBasiqAccounts, sync } from './basiq.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

  app.use(express.json({ limit: '1mb' }));

  // Block cross-site requests from other web pages to this local server.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === req.headers.host;
      } catch {
        // Malformed or "null" origin
      }
      if (!sameHost) return res.status(403).json({ error: 'Cross-origin request blocked.' });
    }
    next();
  });

  app.use(express.static(path.join(here, '..', 'public')));
  // Charts are served locally so the app works offline and loads nothing from third parties.
  app.get('/vendor/chart.js', (req, res) => res.sendFile(path.join(here, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js')));

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };
  const notFound = (what) => Object.assign(new Error(`${what} not found.`), { status: 404 });

  app.get('/api/status', wrap(() => ({
    advisor: advisorAvailable(),
    basiq: basiqConfigured(),
    basiqConnected: Boolean(getSetting(db, 'basiq_user_id')),
    basiqLastSync: getSetting(db, 'basiq_last_sync'),
    categories: CATEGORIES,
  })));

  // Accounts
  app.get('/api/accounts', wrap(() => db.prepare(`
    SELECT a.*, count(t.id) AS transactions, min(t.date) AS first_date, max(t.date) AS last_date
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id ORDER BY a.id`).all()));

  app.post('/api/accounts', wrap((req) => {
    const { name, institution = 'other', type = 'transaction', sign_mode = 'auto' } = req.body;
    if (!name?.trim()) throw new Error('Account name is required.');
    if (!['transaction', 'credit'].includes(type)) throw new Error('Type must be transaction or credit.');
    const r = db.prepare('INSERT INTO accounts (name, institution, type, sign_mode) VALUES (?, ?, ?, ?)')
      .run(name.trim(), institution, type, sign_mode);
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(r.lastInsertRowid));
  }));

  app.patch('/api/accounts/:id', wrap((req) => {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    if (!account) throw notFound('Account');
    const { name = account.name, sign_mode = account.sign_mode } = req.body;
    db.prepare('UPDATE accounts SET name = ?, sign_mode = ? WHERE id = ?').run(name, sign_mode, account.id);
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  }));

  app.delete('/api/accounts/:id', wrap((req) => {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
    return { ok: true };
  }));

  // CSV import
  app.post('/api/import', upload.single('file'), wrap((req) => {
    if (!req.file) throw new Error('Choose a CSV file to import.');
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.body.accountId);
    if (!account) throw new Error('Choose which account this statement is for.');
    const parsed = parseStatement(req.file.buffer.toString('utf8'));
    const invert = shouldInvert(account, parsed);
    const rows = invert ? parsed.rows.map((r) => ({ ...r, amount: -r.amount })) : parsed.rows;
    const result = importRows(db, account, rows, 'csv');
    return { ...result, parsed: parsed.rows.length, skipped: parsed.skipped, format: parsed.format, inverted: invert };
  }));

  // Transactions
  app.get('/api/transactions', wrap((req) => {
    const { from, to, account, category, q, limit = 200, offset = 0 } = req.query;
    const where = [];
    const params = [];
    if (from) { where.push('t.date >= ?'); params.push(from); }
    if (to) { where.push('t.date <= ?'); params.push(to); }
    if (account) { where.push('t.account_id = ?'); params.push(account); }
    if (category) { where.push('t.category = ?'); params.push(category); }
    if (q) { where.push('(t.description LIKE ? OR t.merchant LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT t.*, a.name AS account_name FROM transactions t JOIN accounts a ON a.id = t.account_id
      ${clause} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...params, Number(limit), Number(offset));
    const total = db.prepare(`SELECT count(*) AS n FROM transactions t ${clause}`).get(...params).n;
    return { rows, total };
  }));

  app.patch('/api/transactions/:id', wrap((req) => {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
    if (!tx) throw notFound('Transaction');
    const { category, applyToSimilar, pattern } = req.body;
    if (!CATEGORIES.includes(category)) throw new Error('Unknown category.');
    db.prepare("UPDATE transactions SET category = ?, category_source = 'user', is_transfer = ? WHERE id = ?")
      .run(category, category === 'Transfer' ? 1 : 0, tx.id);
    const updated = applyToSimilar ? learnRule(db, pattern || tx.merchant, category) : 0;
    return { ok: true, updated };
  }));

  // Analysis
  app.get('/api/overview', wrap(() => overview(db)));
  app.get('/api/insights', wrap(() => insights(db)));

  // Budgets
  app.get('/api/budgets', wrap(() => db.prepare('SELECT * FROM budgets ORDER BY category').all()));
  app.put('/api/budgets/:category', wrap((req) => {
    const limit = Number(req.body.monthly_limit);
    if (!CATEGORIES.includes(req.params.category)) throw new Error('Unknown category.');
    if (!(limit > 0)) throw new Error('Budget must be a positive amount.');
    db.prepare('INSERT INTO budgets (category, monthly_limit) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit')
      .run(req.params.category, limit);
    return { ok: true };
  }));
  app.delete('/api/budgets/:category', wrap((req) => {
    db.prepare('DELETE FROM budgets WHERE category = ?').run(req.params.category);
    return { ok: true };
  }));

  // Learned rules
  app.get('/api/rules', wrap(() => db.prepare('SELECT * FROM rules ORDER BY pattern').all()));
  app.delete('/api/rules/:id', wrap((req) => {
    db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
    recategoriseAll(db);
    return { ok: true };
  }));

  // AI advice, streamed as plain text
  app.post('/api/advice', async (req, res) => {
    if (!advisorAvailable()) return res.status(400).json({ error: 'Set ANTHROPIC_API_KEY in .env to enable AI advice.' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    try {
      await streamAdvice(db, req.body || {}, (text) => res.write(text));
    } catch (err) {
      res.write(`\n\n**Error:** ${describeError(err)}`);
    }
    res.end();
  });

  // Open banking
  app.post('/api/basiq/connect', wrap(async (req) => {
    if (!basiqConfigured()) throw new Error('Set BASIQ_API_KEY in .env to enable bank sync.');
    return { url: await consentUrl(db, req.body.email) };
  }));
  app.get('/api/basiq/accounts', wrap(() => listBasiqAccounts(db)));
  app.post('/api/basiq/sync', wrap((req) => sync(db, req.body.links || {})));

  // Maintenance
  app.post('/api/rematch-transfers', wrap(() => ({ matched: matchTransfers(db) })));

  app.get('/api/export.csv', (req, res) => {
    const rows = db.prepare(`
      SELECT t.date, a.name AS account, t.description, t.amount, t.category, t.is_transfer
      FROM transactions t JOIN accounts a ON a.id = t.account_id ORDER BY t.date`).all();
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = ['Date,Account,Description,Amount,Category,Transfer', ...rows.map((r) =>
      [r.date, esc(r.account), esc(r.description), r.amount.toFixed(2), esc(r.category), r.is_transfer ? 'yes' : 'no'].join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send(csv);
  });

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  createApp(db).listen(port, host, () => {
    console.log(`Finance app running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
}
