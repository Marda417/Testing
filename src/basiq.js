// Open banking (Consumer Data Right) via Basiq. ANZ Plus, ANZ credit cards and Amex Australia
// are all CDR data holders, so one Basiq consent can share all three.
// Docs: https://api.basiq.io/reference
import { getSetting, setSetting } from './db.js';
import { importRows } from './importer.js';

const API = 'https://au-api.basiq.io';
let serverToken = null;

export function basiqConfigured() {
  return Boolean(process.env.BASIQ_API_KEY);
}

async function token(scope = 'SERVER_ACCESS', userId) {
  if (scope === 'SERVER_ACCESS' && serverToken && serverToken.expires > Date.now()) return serverToken.value;
  const body = new URLSearchParams({ scope });
  if (userId) body.set('userId', userId);
  const res = await fetch(`${API}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${process.env.BASIQ_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'basiq-version': '3.0',
    },
    body,
  });
  if (!res.ok) throw new Error(`Basiq token request failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  if (scope === 'SERVER_ACCESS') serverToken = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
  return json.access_token;
}

async function api(path, options = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'basiq-version': '3.0',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Basiq ${options.method || 'GET'} ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Creates (once) a Basiq user for you and returns the URL of Basiq's consent screen,
// where you pick your banks and log in. Your bank passwords never touch this app.
export async function consentUrl(db, email) {
  let userId = getSetting(db, 'basiq_user_id');
  if (!userId) {
    if (!email) throw new Error('An email address is needed to create your Basiq user.');
    const user = await api('/users', { method: 'POST', body: JSON.stringify({ email }) });
    userId = user.id;
    setSetting(db, 'basiq_user_id', userId);
  }
  const clientToken = await token('CLIENT_ACCESS', userId);
  return `https://consent.basiq.io/home?token=${encodeURIComponent(clientToken)}&action=connect`;
}

export async function listBasiqAccounts(db) {
  const userId = getSetting(db, 'basiq_user_id');
  if (!userId) return [];
  const res = await api(`/users/${userId}/accounts`);
  return (res.data || []).map((a) => ({
    id: a.id,
    name: a.name,
    accountNo: a.accountNo,
    institution: a.institution,
    type: /credit/i.test(a.class?.type || '') ? 'credit' : 'transaction',
    balance: a.balance,
    linkedAccountId: db.prepare('SELECT id FROM accounts WHERE external_id = ?').get(a.id)?.id ?? null,
  }));
}

// links: { [basiqAccountId]: localAccountId | 'new' | 'skip' }. Linking a Basiq account to an
// account you already imported CSVs into keeps one history; only newer transactions are added.
export async function sync(db, links = {}) {
  const userId = getSetting(db, 'basiq_user_id');
  if (!userId) throw new Error('Connect your banks first.');
  try {
    await api(`/users/${userId}/connections/refresh`, { method: 'POST' });
  } catch {
    // Refresh is best-effort; we can still read whatever Basiq last fetched.
  }

  const accounts = await listBasiqAccounts(db);
  const local = new Map();
  for (const a of accounts) {
    const choice = links[a.id] ?? (a.linkedAccountId ? a.linkedAccountId : 'new');
    if (choice === 'skip') continue;
    if (choice === 'new') {
      const institution = guessInstitution(a);
      const r = db.prepare("INSERT INTO accounts (name, institution, type, sign_mode, external_id) VALUES (?, ?, ?, 'normal', ?)")
        .run(a.name, institution, a.type, a.id);
      local.set(a.id, Number(r.lastInsertRowid));
    } else {
      db.prepare('UPDATE accounts SET external_id = NULL WHERE external_id = ?').run(a.id);
      db.prepare('UPDATE accounts SET external_id = ? WHERE id = ?').run(a.id, Number(choice));
      local.set(a.id, Number(choice));
    }
  }

  const since = getSetting(db, 'basiq_last_sync') || new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const lookback = new Date(Date.parse(since) - 7 * 86400000).toISOString().slice(0, 10);
  let next = `/users/${userId}/transactions?limit=500&filter=${encodeURIComponent(`transaction.postDate.gt('${lookback}')`)}`;
  const byAccount = new Map();
  while (next) {
    const page = await api(next);
    for (const t of page.data || []) {
      if (t.status === 'pending' || !local.has(t.account)) continue;
      const date = (t.postDate || t.transactionDate || '').slice(0, 10);
      if (!date) continue;
      if (!byAccount.has(t.account)) byAccount.set(t.account, []);
      byAccount.get(t.account).push({ date, description: t.description || 'Unknown', amount: parseFloat(t.amount), externalId: t.id });
    }
    next = page.links?.next || null;
  }

  let added = 0;
  for (const [basiqId, rows] of byAccount) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(local.get(basiqId));
    // Don't double-count history you already imported from CSV.
    const csvUntil = db.prepare("SELECT max(date) AS d FROM transactions WHERE account_id = ? AND source = 'csv'").get(account.id).d;
    const fresh = csvUntil ? rows.filter((r) => r.date > csvUntil) : rows;
    added += importRows(db, account, fresh, 'basiq').added;
  }
  setSetting(db, 'basiq_last_sync', new Date().toISOString().slice(0, 10));
  return { added, accounts: local.size };
}

function guessInstitution(a) {
  const text = `${a.name} ${a.institution}`.toUpperCase();
  if (/AMEX|AMERICAN EXPRESS/.test(text)) return 'amex';
  if (/ANZ/.test(text)) return a.type === 'credit' ? 'anz_credit' : 'anz_plus';
  return 'other';
}
