const $ = (sel) => document.querySelector(sel);
const state = { status: null, accounts: [], charts: {}, txOffset: 0, chat: [] };

const aud = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const aud0 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INSTITUTIONS = { anz_plus: 'ANZ Plus', anz_credit: 'ANZ credit card', amex: 'American Express', other: 'Other' };

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- Tabs ----------
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === name));
  location.hash = name;
  ({ dashboard: loadDashboard, transactions: () => loadTransactions(true), accounts: loadAccounts, settings: loadSettings, advice: initAdvice }[name] || (() => {}))();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (document.getElementById(name)?.classList.contains('tab') && !document.getElementById(name).classList.contains('active')) showTab(name);
});
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) showTab(goto.dataset.goto);
});

// ---------- Dashboard ----------
async function loadDashboard() {
  const o = await api('/api/overview');
  const empty = o.counts.total === 0;
  $('#empty-state').classList.toggle('hidden', !empty);
  $('#as-of').textContent = empty ? '' : `Showing data up to ${o.asOf}`;

  const c = o.current;
  const prev = o.months[o.months.length - 2] || { income: 0, spending: 0 };
  $('#stats').innerHTML = [
    stat('Income this month', aud0.format(c.income), `Last month ${aud0.format(prev.income)}`),
    stat('Spending this month', aud0.format(c.spending), `On track for ${aud0.format(c.projectedSpending)}`),
    stat('Net this month', aud0.format(c.net), c.net >= 0 && c.income ? `${Math.round((c.net / c.income) * 100)}% of income kept so far` : 'Month to date'),
    stat('Regular income', `${aud0.format(o.income.regularMonthly)}/mo`, o.income.streams[0] ? `${o.income.streams[0].cadence} pay detected` : 'Learning…'),
    stat('Recurring bills', `${aud0.format(o.bills.reduce((s, b) => s + b.monthly, 0))}/mo`, `${o.bills.length} detected`),
  ].join('');

  drawMonths(o.months);
  drawCategories(o.categories);

  const insights = await api('/api/insights');
  $('#insights').innerHTML = insights.length
    ? insights.map((i) => `<li class="${i.level}"><strong>${esc(i.title)}</strong><span>${esc(i.detail)}</span></li>`).join('')
    : '<li>Import some transactions to see insights.</li>';

  $('#income-table').innerHTML = o.income.streams.length
    ? `<tr><th>Source</th><th>How often</th><th class="num">Amount</th><th>Next expected</th></tr>` +
      o.income.streams.map((s) => `<tr><td>${esc(s.merchant)}${s.active ? '' : ' <span class="muted">(stopped)</span>'}</td><td>${s.cadence}</td><td class="num">${aud.format(s.amount)}</td><td>${s.active ? s.next : '—'}</td></tr>`).join('') +
      (o.income.irregularMonthly > 0 ? `<tr><td colspan="2" class="muted">Irregular income (avg)</td><td class="num">${aud0.format(o.income.irregularMonthly)}/mo</td><td></td></tr>` : '')
    : '<tr><td class="muted">No regular income detected yet. It needs at least 3 pays in your ANZ Plus history.</td></tr>';

  $('#bills-table').innerHTML = o.bills.length
    ? `<tr><th>Merchant</th><th>How often</th><th class="num">Amount</th><th>Next</th></tr>` +
      o.bills.map((b) => `<tr><td>${esc(b.merchant)}<br><span class="muted">${esc(b.category)}</span></td><td>${b.cadence}</td><td class="num">${b.variable ? '~' : ''}${aud.format(b.amount)}</td><td>${b.next}</td></tr>`).join('')
    : '<tr><td class="muted">No recurring payments detected yet.</td></tr>';

  $('#merchants-table').innerHTML = o.merchants.length
    ? `<tr><th>Merchant</th><th>Category</th><th class="num">Visits</th><th class="num">Spent</th></tr>` +
      o.merchants.map((m) => `<tr><td>${esc(m.merchant)}</td><td>${esc(m.category)}</td><td class="num">${m.count}</td><td class="num">${aud.format(m.total)}</td></tr>`).join('')
    : '<tr><td class="muted">Nothing this month yet.</td></tr>';
}

function stat(label, value, sub) {
  return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}

function chartDefaults() {
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--border');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
}

function drawMonths(all) {
  chartDefaults();
  const first = all.findIndex((m) => m.income || m.spending);
  const months = first === -1 ? all : all.slice(first);
  state.charts.months?.destroy();
  const label = (m) => new Date(`${m}-01T00:00:00`).toLocaleString('en-AU', { month: 'short' });
  state.charts.months = new Chart($('#chart-months'), {
    type: 'bar',
    data: {
      labels: months.map((m) => label(m.month)),
      datasets: [
        { label: 'Income', data: months.map((m) => m.income), backgroundColor: css('--income'), borderRadius: 4 },
        { label: 'Spending', data: months.map((m) => m.spending), backgroundColor: css('--spend'), borderRadius: 4 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${aud0.format(ctx.raw)}` } } },
      scales: { y: { ticks: { callback: (v) => aud0.format(v) } }, x: { grid: { display: false } } },
    },
  });
}

function drawCategories(categories) {
  chartDefaults();
  state.charts.categories?.destroy();
  const top = categories.slice(0, 10);
  state.charts.categories = new Chart($('#chart-categories'), {
    type: 'bar',
    data: { labels: top.map((c) => c.category), datasets: [{ data: top.map((c) => c.total), backgroundColor: css('--accent'), borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => aud.format(ctx.raw) } } },
      scales: { x: { ticks: { callback: (v) => aud0.format(v) } }, y: { grid: { display: false } } },
    },
  });
}

// ---------- Transactions ----------
async function loadTransactions(reset) {
  if (reset) state.txOffset = 0;
  const params = new URLSearchParams({ limit: 200, offset: state.txOffset });
  for (const [key, id] of [['q', '#f-q'], ['account', '#f-account'], ['category', '#f-category'], ['from', '#f-from'], ['to', '#f-to']]) {
    if ($(id).value) params.set(key, $(id).value);
  }
  const { rows, total } = await api(`/api/transactions?${params}`);
  const html = rows.map((t) => `
    <tr>
      <td>${t.date}</td>
      <td>${esc(t.account_name)}</td>
      <td>${esc(t.description)}</td>
      <td><span class="tag ${t.category === 'Transfer' ? 'transfer' : ''} ${t.category === 'Uncategorised' ? 'uncat' : ''}" data-id="${t.id}" data-merchant="${esc(t.merchant)}" data-desc="${esc(t.description)}" data-category="${esc(t.category)}">${esc(t.category)}</span></td>
      <td class="num ${t.amount > 0 ? 'pos' : 'neg'}">${aud.format(t.amount)}</td>
    </tr>`).join('');
  if (reset) $('#tx-table').innerHTML = `<tr><th>Date</th><th>Account</th><th>Description</th><th>Category</th><th class="num">Amount</th></tr>${html}`;
  else $('#tx-table').insertAdjacentHTML('beforeend', html);
  state.txOffset += rows.length;
  $('#tx-count').textContent = `${total} transactions`;
  $('#tx-more').classList.toggle('hidden', state.txOffset >= total);
}
let searchTimer;
['#f-q', '#f-account', '#f-category', '#f-from', '#f-to'].forEach((id) =>
  $(id).addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadTransactions(true), 250); }));
$('#tx-more').addEventListener('click', () => loadTransactions(false));

$('#tx-table').addEventListener('click', (e) => {
  const tag = e.target.closest('.tag');
  if (!tag) return;
  const dialog = $('#cat-dialog');
  $('#cat-desc').textContent = tag.dataset.desc;
  $('#cat-select').value = tag.dataset.category;
  $('#cat-pattern').value = tag.dataset.merchant;
  dialog.dataset.id = tag.dataset.id;
  dialog.showModal();
});
$('#cat-dialog').addEventListener('close', async () => {
  const dialog = $('#cat-dialog');
  if (dialog.returnValue !== 'save') return;
  try {
    await api(`/api/transactions/${dialog.dataset.id}`, {
      method: 'PATCH',
      body: { category: $('#cat-select').value, applyToSimilar: $('#cat-similar').checked, pattern: $('#cat-pattern').value },
    });
    loadTransactions(true);
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Accounts & import ----------
async function loadAccounts() {
  state.accounts = await api('/api/accounts');
  fillAccountSelects();
  $('#accounts-table').innerHTML = state.accounts.length
    ? `<tr><th>Account</th><th>Type</th><th class="num">Transactions</th><th>Covers</th><th></th></tr>` +
      state.accounts.map((a) => `
        <tr>
          <td>${esc(a.name)}<br><span class="muted">${INSTITUTIONS[a.institution] || esc(a.institution)}${a.external_id ? ' · synced' : ''}</span></td>
          <td>${a.type === 'credit' ? 'Credit card' : 'Everyday'}</td>
          <td class="num">${a.transactions}</td>
          <td>${a.first_date ? `${a.first_date} → ${a.last_date}` : '<span class="muted">No data</span>'}</td>
          <td><button class="link danger" data-delete-account="${a.id}">Delete</button></td>
        </tr>`).join('')
    : '<tr><td class="muted">No accounts yet. Use the buttons below to add ANZ Plus, your ANZ credit card and Amex.</td></tr>';
  renderBasiq();
}

function fillAccountSelects() {
  const opts = state.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  $('#import-account').innerHTML = state.accounts.length ? opts : '<option value="">Add an account first</option>';
  const current = $('#f-account').value;
  $('#f-account').innerHTML = `<option value="">All accounts</option>${opts}`;
  $('#f-account').value = current;
}

$('#accounts-table').addEventListener('click', async (e) => {
  const id = e.target.dataset.deleteAccount;
  if (!id) return;
  const a = state.accounts.find((x) => String(x.id) === id);
  if (!confirm(`Delete "${a.name}" and its ${a.transactions} transactions?`)) return;
  await api(`/api/accounts/${id}`, { method: 'DELETE' });
  loadAccounts();
});

document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => {
  const f = $('#account-form');
  f.name.value = b.dataset.name;
  f.institution.value = b.dataset.institution;
  f.type.value = b.dataset.type;
}));
$('#account-form').institution.addEventListener('change', (e) => {
  const f = $('#account-form');
  if (e.target.value === 'anz_credit' || e.target.value === 'amex') f.type.value = 'credit';
  if (e.target.value === 'anz_plus') f.type.value = 'transaction';
});
$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/accounts', { method: 'POST', body: { name: f.name.value, institution: f.institution.value, type: f.type.value } });
    f.reset();
    loadAccounts();
  } catch (err) {
    alert(err.message);
  }
});

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { $('#import-file').files = e.dataTransfer.files; updateDropLabel(); });
$('#import-file').addEventListener('change', updateDropLabel);
function updateDropLabel() {
  const files = [...$('#import-file').files];
  $('#drop-label').textContent = files.length ? files.map((f) => f.name).join(', ') : 'Drop CSV files here or click to choose';
}

$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = [...$('#import-file').files];
  const out = $('#import-result');
  if (!files.length) { out.innerHTML = '<div class="result error">Choose a CSV file first.</div>'; return; }
  out.innerHTML = '';
  for (const file of files) {
    const fd = new FormData();
    fd.append('accountId', $('#import-account').value);
    fd.append('file', file);
    try {
      const r = await api('/api/import', { method: 'POST', body: fd });
      out.insertAdjacentHTML('beforeend', `<div class="result"><strong>${esc(file.name)}:</strong> ${r.added} new transactions, ${r.duplicates} already imported${r.skipped ? `, ${r.skipped} rows skipped` : ''}${r.transfersMatched ? `, ${r.transfersMatched} transfers between your accounts matched` : ''}.${r.inverted ? ' Purchases were exported as positive amounts and have been flipped.' : ''}</div>`);
    } catch (err) {
      out.insertAdjacentHTML('beforeend', `<div class="result error"><strong>${esc(file.name)}:</strong> ${esc(err.message)}</div>`);
    }
  }
  $('#import-file').value = '';
  updateDropLabel();
  loadAccounts();
});

async function renderBasiq() {
  const s = state.status;
  const body = $('#basiq-body');
  if (!s.basiq) {
    body.innerHTML = `<p>Sync ANZ Plus, ANZ credit card and Amex automatically through Australia's Consumer Data Right using <a href="https://basiq.io" target="_blank" rel="noopener">Basiq</a>.
      Create a Basiq account, then add <code>BASIQ_API_KEY</code> to your <code>.env</code> file and restart the app.</p>
      <p class="muted">Your bank logins happen on your bank's own consent screens; this app never sees your passwords.</p>`;
    return;
  }
  if (!s.basiqConnected) {
    body.innerHTML = `<form id="basiq-connect" class="row"><input type="email" name="email" placeholder="Your email (for your Basiq user)" required><button class="primary">Connect banks</button></form>`;
    $('#basiq-connect').addEventListener('submit', connectBasiq);
    return;
  }
  body.innerHTML = '<p class="muted">Loading connected accounts…</p>';
  try {
    const accounts = await api('/api/basiq/accounts');
    const options = (a) => `<option value="new">Create new account</option><option value="skip">Don't sync</option>` +
      state.accounts.map((l) => `<option value="${l.id}" ${a.linkedAccountId === l.id ? 'selected' : ''}>Link to ${esc(l.name)}</option>`).join('');
    body.innerHTML = `
      <p class="muted">${s.basiqLastSync ? `Last synced ${s.basiqLastSync}.` : 'Not synced yet.'} Link each bank account to the one you've been importing CSVs into, so history isn't duplicated.</p>
      <table>${accounts.map((a) => `<tr><td>${esc(a.name)}<br><span class="muted">${esc(a.accountNo || '')}</span></td><td><select data-basiq="${a.id}">${options(a)}</select></td></tr>`).join('') || '<tr><td class="muted">No accounts shared yet.</td></tr>'}</table>
      <div class="row" style="margin-top:12px"><button class="primary" id="basiq-sync">Sync now</button><button id="basiq-add">Connect another bank</button></div>
      <div id="basiq-result"></div>`;
    $('#basiq-sync').addEventListener('click', syncBasiq);
    $('#basiq-add').addEventListener('click', () => connectBasiq());
  } catch (err) {
    body.innerHTML = `<div class="result error">${esc(err.message)}</div>`;
  }
}

async function connectBasiq(e) {
  e?.preventDefault();
  try {
    const { url } = await api('/api/basiq/connect', { method: 'POST', body: { email: e?.target?.email?.value } });
    window.open(url, '_blank', 'noopener');
    state.status = await api('/api/status');
    setTimeout(renderBasiq, 500);
  } catch (err) {
    alert(err.message);
  }
}

async function syncBasiq() {
  const links = {};
  document.querySelectorAll('[data-basiq]').forEach((s) => { links[s.dataset.basiq] = s.value; });
  $('#basiq-result').innerHTML = '<div class="result">Syncing…</div>';
  try {
    const r = await api('/api/basiq/sync', { method: 'POST', body: { links } });
    $('#basiq-result').innerHTML = `<div class="result">${r.added} new transactions from ${r.accounts} accounts.</div>`;
    state.status = await api('/api/status');
    loadAccounts();
  } catch (err) {
    $('#basiq-result').innerHTML = `<div class="result error">${esc(err.message)}</div>`;
  }
}

// ---------- Advice ----------
function initAdvice() {
  if (!state.status.advisor) {
    $('#advice-note').innerHTML = 'AI advice is off. Add <code>ANTHROPIC_API_KEY</code> to your <code>.env</code> file and restart to enable it. The rule-based insights on the Dashboard work without it.';
    $('#advice-form').classList.add('hidden');
  }
}

function renderMarkdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>').replace(/_(.+?)_/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  for (const line of md.split('\n')) {
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (item) {
      const type = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      if (list !== type) { if (list) out.push(`</${list}>`); out.push(`<${type}>`); list = type; }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) out.push(`<h3>${inline(h[1])}</h3>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

async function ask(question) {
  const chat = $('#chat');
  const shown = question || 'Review my finances and give me your top recommendations.';
  chat.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(shown)}</div>`);
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant';
  bubble.innerHTML = '<p class="muted">Thinking…</p>';
  chat.appendChild(bubble);
  const buttons = document.querySelectorAll('#advice-form button');
  buttons.forEach((b) => (b.disabled = true));
  let text = '';
  try {
    const res = await fetch('/api/advice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, history: state.chat }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      bubble.innerHTML = renderMarkdown(text);
    }
    state.chat.push({ role: 'user', content: shown }, { role: 'assistant', content: text });
  } catch (err) {
    bubble.innerHTML = `<p class="result error">${esc(err.message)}</p>`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$('#advice-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#advice-q').value.trim();
  if (!q) return;
  $('#advice-q').value = '';
  ask(q);
});
$('#advice-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#advice-form').requestSubmit(); }
});
$('#advice-review').addEventListener('click', () => ask(''));
$('#advice-clear').addEventListener('click', () => { state.chat = []; $('#chat').innerHTML = ''; });

// ---------- Budgets & rules ----------
async function loadSettings() {
  const [budgets, rules, overview] = await Promise.all([api('/api/budgets'), api('/api/rules'), api('/api/overview')]);
  const spent = new Map(overview.budgets.map((b) => [b.category, b.spent]));
  $('#budgets-table').innerHTML = budgets.length
    ? `<tr><th>Category</th><th class="num">Spent this month</th><th class="num">Budget</th><th></th></tr>` +
      budgets.map((b) => `<tr><td>${esc(b.category)}</td><td class="num">${aud0.format(spent.get(b.category) || 0)}</td><td class="num">${aud0.format(b.monthly_limit)}</td><td><button class="link danger" data-del-budget="${esc(b.category)}">Remove</button></td></tr>`).join('')
    : '<tr><td class="muted">No budgets yet.</td></tr>';
  $('#rules-table').innerHTML = rules.length
    ? `<tr><th>Matching text</th><th>Category</th><th></th></tr>` +
      rules.map((r) => `<tr><td>${esc(r.pattern)}</td><td>${esc(r.category)}</td><td><button class="link danger" data-del-rule="${r.id}">Delete</button></td></tr>`).join('')
    : '<tr><td class="muted">No rules yet.</td></tr>';
}
$('#budget-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/api/budgets/${encodeURIComponent(e.target.category.value)}`, { method: 'PUT', body: { monthly_limit: e.target.monthly_limit.value } });
    e.target.reset();
    loadSettings();
  } catch (err) {
    alert(err.message);
  }
});
$('#settings').addEventListener('click', async (e) => {
  if (e.target.dataset.delBudget) { await api(`/api/budgets/${encodeURIComponent(e.target.dataset.delBudget)}`, { method: 'DELETE' }); loadSettings(); }
  if (e.target.dataset.delRule) { await api(`/api/rules/${e.target.dataset.delRule}`, { method: 'DELETE' }); loadSettings(); }
});
$('#rematch').addEventListener('click', async () => {
  const r = await api('/api/rematch-transfers', { method: 'POST' });
  alert(`${r.matched} new transfer pairs found.`);
});

// ---------- Boot ----------
(async function boot() {
  state.status = await api('/api/status');
  const catOpts = state.status.categories.map((c) => `<option>${esc(c)}</option>`).join('');
  $('#f-category').innerHTML = `<option value="">All categories</option>${catOpts}`;
  $('#cat-select').innerHTML = catOpts;
  $('#budget-category').innerHTML = state.status.categories.filter((c) => !['Income', 'Transfer', 'Uncategorised'].includes(c)).map((c) => `<option>${esc(c)}</option>`).join('');
  state.accounts = await api('/api/accounts');
  fillAccountSelects();
  showTab(location.hash.slice(1) || 'dashboard');
})();
