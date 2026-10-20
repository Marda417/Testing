// Parses bank CSV exports into a common shape: { date: 'YYYY-MM-DD', description, amount }.
// Handles ANZ (headerless Date,Amount,Description), ANZ Plus and Amex (headered) and
// most other Australian bank exports by detecting the columns rather than hard-coding them.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row.map((f) => f.trim()));
  return rows;
}

// Australian exports are day-first: 20/10/2026, 20/10/26, 20 Oct 2026, 2026-10-20.
export function parseDate(value) {
  if (!value) return null;
  const v = value.trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return fmt(+m[1], +m[2], +m[3]);
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return fmt(fullYear(+m[3]), +m[2], +m[1]);
  m = v.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return fmt(fullYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

function fullYear(y) {
  return y < 100 ? 2000 + y : y;
}

function fmt(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseAmount(value) {
  if (value == null) return null;
  let v = String(value).trim();
  if (v === '') return null;
  let sign = 1;
  if (/^\(.*\)$/.test(v)) { sign = -1; v = v.slice(1, -1); }
  if (/\s*DR$/i.test(v)) { sign = -1; v = v.replace(/\s*DR$/i, ''); }
  v = v.replace(/\s*CR$/i, '');
  v = v.replace(/[$,\s]/g, '').replace(/^A\$/, '');
  if (!/^[+-]?\d*\.?\d+$/.test(v)) return null;
  return sign * parseFloat(v);
}

const HEADER_HINT = /date|amount|description|details|narrative|debit|credit|balance|merchant|payee/i;

function findColumn(headers, patterns, exclude) {
  for (const p of patterns) {
    const idx = headers.findIndex((h) => p.test(h) && !(exclude && exclude.test(h)));
    if (idx !== -1) return idx;
  }
  return -1;
}

// Works out which column is which. Returns { hasHeader, date, description, amount, debit, credit, format }.
export function detectColumns(rows) {
  const first = rows[0] || [];
  const hasHeader = first.some((f) => HEADER_HINT.test(f)) && !first.some((f) => parseDate(f));
  if (hasHeader) {
    const h = first.map((x) => x.toLowerCase());
    const cols = {
      hasHeader,
      date: findColumn(h, [/^(transaction )?date$/, /^date/, /date/], /processed|posted/),
      description: findColumn(h, [/^description$/, /description|details|narrative|merchant|payee|particulars|transaction/], /date|amount|type|category/),
      amount: findColumn(h, [/^amount$/, /amount/], /foreign|original|balance/),
      debit: findColumn(h, [/debit|withdrawal|money out|paid out/]),
      credit: findColumn(h, [/credit|deposit|money in|paid in/], /card/),
      format: h.some((x) => x.includes('card member') || x.includes('account #')) ? 'amex' : 'headered',
    };
    if (cols.date === -1) cols.date = findColumn(h, [/date/]);
    return cols;
  }

  // Headerless (ANZ Internet Banking style). Infer by content.
  const sample = rows.slice(0, 50);
  const width = Math.max(...sample.map((r) => r.length));
  const share = (col, test) => sample.filter((r) => test(r[col])).length / sample.length;
  let date = -1;
  let amount = -1;
  for (let c = 0; c < width; c++) {
    if (date === -1 && share(c, parseDate) > 0.9) { date = c; continue; }
    if (amount === -1 && share(c, (v) => parseAmount(v) !== null) > 0.9) amount = c;
  }
  let description = -1;
  let longest = 0;
  for (let c = 0; c < width; c++) {
    if (c === date || c === amount) continue;
    const avg = sample.reduce((s, r) => s + (r[c] || '').length, 0) / sample.length;
    if (avg > longest) { longest = avg; description = c; }
  }
  return { hasHeader: false, date, description, amount, debit: -1, credit: -1, format: 'headerless' };
}

// Returns { rows: [{date, description, amount}], skipped, format, positiveShare }.
// Amounts are as exported; sign normalisation happens in normaliseSigns once we know the account.
export function parseStatement(text) {
  const all = parseCsvText(text);
  if (all.length === 0) throw new Error('The file is empty.');
  const cols = detectColumns(all);
  if (cols.date === -1 || cols.description === -1 || (cols.amount === -1 && cols.debit === -1 && cols.credit === -1)) {
    throw new Error('Could not find date, description and amount columns in this file.');
  }
  const body = cols.hasHeader ? all.slice(1) : all;
  const rows = [];
  let skipped = 0;
  for (const r of body) {
    const date = parseDate(r[cols.date]);
    let amount = cols.amount !== -1 ? parseAmount(r[cols.amount]) : null;
    if (amount === null && (cols.debit !== -1 || cols.credit !== -1)) {
      const debit = cols.debit !== -1 ? parseAmount(r[cols.debit]) : null;
      const credit = cols.credit !== -1 ? parseAmount(r[cols.credit]) : null;
      if (debit !== null && debit !== 0) amount = -Math.abs(debit);
      else if (credit !== null) amount = Math.abs(credit);
    }
    const description = (r[cols.description] || '').replace(/\s+/g, ' ').trim();
    if (!date || amount === null || !description) { skipped++; continue; }
    rows.push({ date, description, amount });
  }
  const positiveShare = rows.length ? rows.filter((r) => r.amount > 0).length / rows.length : 0;
  return { rows, skipped, format: cols.format, positiveShare };
}

// Decides whether this file's amounts need flipping so that spending is negative.
// Amex exports charges as positive numbers; ANZ exports them as negative.
export function shouldInvert(account, parsed) {
  if (account.sign_mode === 'inverted') return true;
  if (account.sign_mode === 'normal') return false;
  if (account.type !== 'credit') return false;
  if (parsed.format === 'amex') return true;
  // Most rows on a credit card statement are purchases, so if most rows are positive
  // the bank is exporting charges as positive numbers.
  return parsed.positiveShare > 0.6;
}
