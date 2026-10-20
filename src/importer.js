import crypto from 'node:crypto';
import { transaction } from './db.js';
import { categorise, loadRules, normaliseMerchant } from './categorize.js';

// Inserts normalised rows ({date, description, amount}) for an account, skipping ones already
// imported. Re-importing the same or an overlapping statement is safe.
export function importRows(db, account, rows, source = 'csv') {
  const rules = loadRules(db);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO transactions (account_id, date, description, merchant, amount, category, category_source, hash, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // Two genuinely identical transactions on the same day (two coffees) get different
  // occurrence numbers, so they're both kept, while a re-import produces the same hashes.
  const seen = new Map();
  let added = 0;
  transaction(db, () => {
    for (const row of rows) {
      const amount = Math.round(row.amount * 100) / 100;
      const key = row.externalId ? `ext|${row.externalId}` : `${row.date}|${amount.toFixed(2)}|${row.description.toUpperCase()}`;
      const occurrence = (seen.get(key) || 0) + 1;
      seen.set(key, occurrence);
      const hash = crypto.createHash('sha256').update(`${account.id}|${key}|${occurrence}`).digest('hex');
      const merchant = normaliseMerchant(row.description);
      const { category, source: catSource } = categorise(rules, { description: row.description, merchant, amount, account_type: account.type });
      const result = insert.run(account.id, row.date, row.description, merchant, amount, category, catSource, hash, source);
      added += Number(result.changes);
    }
  });
  const transfers = matchTransfers(db);
  return { added, duplicates: rows.length - added, transfersMatched: transfers };
}

// Finds money moving between your own accounts (e.g. ANZ Plus -> Amex repayment): an outflow in one
// account and an equal inflow in another within 5 days. Both sides are flagged so they don't count
// as spending or income.
export function matchTransfers(db) {
  const candidates = db.prepare(`
    SELECT t.id, t.account_id, t.date, t.amount FROM transactions t
    WHERE t.is_transfer = 0 AND t.category_source != 'user'
    ORDER BY t.date`).all();
  const inflows = candidates.filter((t) => t.amount > 0);
  const used = new Set();
  const flag = db.prepare("UPDATE transactions SET is_transfer = 1, category = 'Transfer' WHERE id = ?");
  let matched = 0;
  transaction(db, () => {
    for (const out of candidates) {
      if (out.amount >= 0 || used.has(out.id)) continue;
      const outDay = Date.parse(out.date);
      const match = inflows.find((inc) =>
        !used.has(inc.id) &&
        inc.account_id !== out.account_id &&
        Math.abs(inc.amount + out.amount) < 0.005 &&
        Math.abs(Date.parse(inc.date) - outDay) <= 5 * 86400000);
      if (!match) continue;
      used.add(out.id);
      used.add(match.id);
      flag.run(out.id);
      flag.run(match.id);
      matched++;
    }
  });
  return matched;
}
