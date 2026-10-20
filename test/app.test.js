import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { parseAmount, parseDate, parseStatement, shouldInvert } from '../src/importers/csv.js';
import { builtinCategory, learnRule, normaliseMerchant } from '../src/categorize.js';
import { importRows } from '../src/importer.js';
import { detectRecurring, incomeProfile, insights, monthlySummary } from '../src/analysis.js';

function account(db, name, institution, type) {
  const r = db.prepare('INSERT INTO accounts (name, institution, type) VALUES (?, ?, ?)').run(name, institution, type);
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(r.lastInsertRowid));
}

function importCsv(db, acct, csv) {
  const parsed = parseStatement(csv);
  const rows = shouldInvert(acct, parsed) ? parsed.rows.map((r) => ({ ...r, amount: -r.amount })) : parsed.rows;
  return importRows(db, acct, rows);
}

test('parses Australian dates and amounts', () => {
  assert.equal(parseDate('05/03/2026'), '2026-03-05');
  assert.equal(parseDate('5/3/26'), '2026-03-05');
  assert.equal(parseDate('20 Oct 2026'), '2026-10-20');
  assert.equal(parseDate('2026-10-20'), '2026-10-20');
  assert.equal(parseDate('nope'), null);
  assert.equal(parseAmount('-1,234.50'), -1234.5);
  assert.equal(parseAmount('$45.00'), 45);
  assert.equal(parseAmount('(12.00)'), -12);
  assert.equal(parseAmount('12.00 DR'), -12);
  assert.equal(parseAmount(''), null);
});

test('detects headerless ANZ format', () => {
  const p = parseStatement('01/10/2026,-45.20,"WOOLWORTHS 1234 SYDNEY NSW"\n02/10/2026,500.00,"PAYMENT THANKYOU"\n03/10/2026,-12.00,"CAFE, NEWTOWN"');
  assert.equal(p.format, 'headerless');
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows[0], { date: '2026-10-01', description: 'WOOLWORTHS 1234 SYDNEY NSW', amount: -45.2 });
  assert.equal(p.rows[2].description, 'CAFE, NEWTOWN');
});

test('detects Amex format and inverts its positive charges', () => {
  const csv = 'Date,Date Processed,Description,Card Member,Account #,Amount\n01/10/2026,02/10/2026,"NETFLIX.COM",J CITIZEN,-71004,22.99\n05/10/2026,05/10/2026,"PAYMENT RECEIVED - THANK YOU",J CITIZEN,-71004,-500.00';
  const p = parseStatement(csv);
  assert.equal(p.format, 'amex');
  assert.equal(p.rows[0].amount, 22.99);
  assert.equal(shouldInvert({ type: 'credit', sign_mode: 'auto' }, p), true);
  assert.equal(shouldInvert({ type: 'transaction', sign_mode: 'auto' }, p), false);
});

test('handles separate debit and credit columns', () => {
  const p = parseStatement('Date,Details,Debit,Credit,Balance\n01/10/2026,Coles,45.00,,1000\n02/10/2026,Salary,,3000.00,4000');
  assert.equal(p.rows[0].amount, -45);
  assert.equal(p.rows[1].amount, 3000);
});

test('normalises merchants and categorises common AU merchants', () => {
  assert.equal(normaliseMerchant('WOOLWORTHS 1234 SYDNEY NSW AUS'), 'WOOLWORTHS SYDNEY');
  assert.equal(builtinCategory('WOOLWORTHS 1234 SYDNEY', -40), 'Groceries');
  assert.equal(builtinCategory('UBER *EATS HELP.UBER.COM', -30), 'Dining & Takeaway');
  assert.equal(builtinCategory('UBER *TRIP HELP.UBER.COM', -30), 'Transport');
  assert.equal(builtinCategory('SALARY ACME PTY LTD', 3000), 'Income');
  assert.equal(builtinCategory('RANDOM SHOP', 50, 'credit'), 'Transfer');
  assert.equal(builtinCategory('RANDOM SHOP', -50), 'Uncategorised');
});

test('re-importing the same statement adds nothing; identical same-day rows are kept', () => {
  const db = openDb(':memory:');
  const a = account(db, 'ANZ Plus', 'anz_plus', 'transaction');
  const csv = 'Date,Description,Amount\n01/10/2026,COFFEE CART,-5.00\n01/10/2026,COFFEE CART,-5.00\n02/10/2026,COLES,-80.00';
  assert.equal(importCsv(db, a, csv).added, 3);
  const again = importCsv(db, a, csv);
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 3);
});

test('matches card repayments as transfers so they are not counted as spending', () => {
  const db = openDb(':memory:');
  const plus = account(db, 'ANZ Plus', 'anz_plus', 'transaction');
  const amex = account(db, 'Amex', 'amex', 'credit');
  importCsv(db, plus, 'Date,Description,Amount\n27/09/2026,BPAY BILL 12345,-912.40\n28/09/2026,SALARY ACME,3000.00');
  const r = importCsv(db, amex, 'Date,Date Processed,Description,Card Member,Account #,Amount\n20/09/2026,20/09/2026,"GUZMAN Y GOMEZ",J,-1,25.00\n21/09/2026,21/09/2026,"KMART",J,-1,40.00\n29/09/2026,29/09/2026,"PAYMENT RECEIVED - THANK YOU",J,-1,-912.40');
  assert.equal(r.transfersMatched, 1);
  const transfers = db.prepare('SELECT count(*) AS n FROM transactions WHERE is_transfer = 1').get().n;
  assert.equal(transfers, 2);
  const sept = monthlySummary(db, 1)[0];
  assert.equal(sept.income, 3000);
  assert.equal(sept.spending, 65);
});

test('learns a rule from a correction and applies it to past transactions', () => {
  const db = openDb(':memory:');
  const a = account(db, 'ANZ CC', 'anz_credit', 'credit');
  importCsv(db, a, '01/10/2026,-30.00,"BOBS DUMPLINGS HAYMARKET"\n08/10/2026,-28.00,"BOBS DUMPLINGS HAYMARKET"');
  assert.equal(db.prepare("SELECT count(*) AS n FROM transactions WHERE category = 'Uncategorised'").get().n, 2);
  learnRule(db, 'BOBS DUMPLINGS', 'Dining & Takeaway');
  assert.equal(db.prepare("SELECT count(*) AS n FROM transactions WHERE category = 'Dining & Takeaway'").get().n, 2);
  // New imports pick up the learned rule too
  importCsv(db, a, '15/10/2026,-31.00,"BOBS DUMPLINGS HAYMARKET"');
  assert.equal(db.prepare("SELECT count(*) AS n FROM transactions WHERE category = 'Dining & Takeaway'").get().n, 3);
});

test('learns fortnightly income and monthly subscriptions', () => {
  const db = openDb(':memory:');
  const plus = account(db, 'ANZ Plus', 'anz_plus', 'transaction');
  const lines = ['Date,Description,Amount'];
  const start = Date.parse('2026-04-02');
  for (let i = 0; i < 14; i++) {
    const d = new Date(start + i * 14 * 86400000);
    lines.push(`${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()},SALARY ACME PTY LTD,3245.60`);
  }
  for (let m = 4; m <= 9; m++) lines.push(`07/${m}/2026,NETFLIX.COM MELBOURNE,-22.99`);
  importCsv(db, plus, lines.join('\n'));

  const income = incomeProfile(db);
  assert.equal(income.streams.length, 1);
  assert.equal(income.streams[0].cadence, 'fortnightly');
  assert.equal(income.streams[0].amount, 3245.6);
  assert.ok(Math.abs(income.regularMonthly - 3245.6 * (30.44 / 14)) < 1);

  const bills = detectRecurring(db, { direction: 'out' });
  assert.equal(bills[0].merchant, 'NETFLIX COM MELBOURNE');
  assert.equal(bills[0].cadence, 'monthly');
  assert.equal(bills[0].category, 'Subscriptions');

  const list = insights(db);
  assert.ok(list.some((i) => i.title.includes('fortnightly')));
  assert.ok(list.some((i) => i.title.includes('subscriptions')));
});
