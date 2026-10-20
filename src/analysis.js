// Turns raw transactions into summaries, learned income/bill patterns and plain-English insights.

const DAY = 86400000;

// Spending/income queries ignore money moving between your own accounts.
const REAL = "is_transfer = 0 AND category != 'Transfer'";

const NEEDS = new Set([
  'Groceries', 'Rent & Mortgage', 'Utilities', 'Phone & Internet', 'Insurance', 'Transport',
  'Fuel', 'Health', 'Kids & Family', 'Education', 'Government & Tax', 'Fees & Interest',
]);

const money = (n) => `$${Math.abs(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// The "as of" date: the latest transaction, so old statements still produce sensible insights.
export function asOfDate(db) {
  const row = db.prepare('SELECT max(date) AS d FROM transactions').get();
  return row?.d || new Date().toISOString().slice(0, 10);
}

export function monthlySummary(db, months = 12) {
  const end = asOfDate(db).slice(0, 7);
  const start = addMonths(end, -(months - 1));
  const rows = db.prepare(`
    SELECT substr(date, 1, 7) AS month,
           sum(CASE WHEN amount > 0 AND category = 'Income' THEN amount ELSE 0 END) AS income,
           -sum(CASE WHEN category != 'Income' THEN amount ELSE 0 END) AS spending
    FROM transactions WHERE ${REAL} AND substr(date, 1, 7) >= ?
    GROUP BY month ORDER BY month`).all(start);
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const out = [];
  for (let m = start; m <= end; m = addMonths(m, 1)) {
    const r = byMonth.get(m) || { income: 0, spending: 0 };
    out.push({ month: m, income: round(r.income), spending: round(r.spending), net: round(r.income - r.spending) });
  }
  return out;
}

// Net spending per category (refunds reduce the total) between two dates inclusive.
export function categoryTotals(db, from, to) {
  return db.prepare(`
    SELECT category, -sum(amount) AS total, count(*) AS count
    FROM transactions WHERE ${REAL} AND category != 'Income' AND date BETWEEN ? AND ?
    GROUP BY category HAVING total > 0 ORDER BY total DESC`).all(from, to)
    .map((r) => ({ ...r, total: round(r.total) }));
}

export function topMerchants(db, from, to, limit = 10) {
  return db.prepare(`
    SELECT merchant, category, -sum(amount) AS total, count(*) AS count
    FROM transactions WHERE ${REAL} AND amount < 0 AND date BETWEEN ? AND ?
    GROUP BY merchant ORDER BY total DESC LIMIT ?`).all(from, to, limit)
    .map((r) => ({ ...r, total: round(r.total) }));
}

const CADENCES = [
  { name: 'weekly', days: 7, tol: 2 },
  { name: 'fortnightly', days: 14, tol: 2 },
  { name: 'monthly', days: 30.44, tol: 4 },
  { name: 'quarterly', days: 91, tol: 8 },
  { name: 'yearly', days: 365, tol: 12 },
];

// Learns repeating payments from history: groups by merchant, then looks for a steady gap between
// dates. Works for both income (salary every fortnight) and bills/subscriptions (Netflix monthly).
export function detectRecurring(db, { direction }) {
  const asOf = Date.parse(asOfDate(db));
  const since = new Date(asOf - 400 * DAY).toISOString().slice(0, 10);
  const sign = direction === 'in' ? '> 0' : '< 0';
  const rows = db.prepare(`
    SELECT merchant, date, amount, category FROM transactions
    WHERE ${REAL} AND amount ${sign} AND date >= ? ORDER BY merchant, date`).all(since);

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.merchant)) groups.set(r.merchant, []);
    groups.get(r.merchant).push(r);
  }

  const found = [];
  for (const [merchant, txs] of groups) {
    // Collapse same-day entries (e.g. split payments) into one event.
    const byDay = new Map();
    for (const t of txs) byDay.set(t.date, (byDay.get(t.date) || 0) + t.amount);
    const days = [...byDay.keys()].sort();
    if (days.length < 3) continue;
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY);
    const gap = median(gaps);
    const cadence = CADENCES.find((c) => Math.abs(gap - c.days) <= c.tol);
    if (!cadence) continue;
    const regular = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tol * 1.5).length / gaps.length;
    if (regular < 0.6) continue;
    const amounts = [...byDay.values()].map(Math.abs);
    const typical = median(amounts);
    // Groceries every week aren't a "bill": require the amount to be fairly steady for outflows.
    const spread = typical ? (Math.max(...amounts.slice(-6)) - Math.min(...amounts.slice(-6))) / typical : 1;
    if (direction === 'out' && spread > 0.35) continue;
    const last = days[days.length - 1];
    const next = new Date(Date.parse(last) + cadence.days * DAY).toISOString().slice(0, 10);
    const active = asOf - Date.parse(last) <= cadence.days * 1.6 * DAY;
    found.push({
      merchant,
      category: txs[txs.length - 1].category,
      cadence: cadence.name,
      amount: round(typical),
      monthly: round(typical * (30.44 / cadence.days)),
      occurrences: days.length,
      last,
      next,
      active,
      variable: spread > 0.1,
    });
  }
  return found.sort((a, b) => b.monthly - a.monthly);
}

// Income profile: regular income streams learned from history plus irregular extras.
export function incomeProfile(db) {
  const streams = detectRecurring(db, { direction: 'in' }).filter((s) => s.category === 'Income');
  const regularMonthly = streams.filter((s) => s.active).reduce((s, x) => s + x.monthly, 0);
  const asOf = asOfDate(db);
  const from = new Date(Date.parse(asOf) - 90 * DAY).toISOString().slice(0, 10);
  const total90 = db.prepare(`SELECT sum(amount) AS t FROM transactions WHERE ${REAL} AND category = 'Income' AND amount > 0 AND date > ?`).get(from).t || 0;
  const avgMonthly = total90 / (90 / 30.44);
  return {
    streams,
    regularMonthly: round(regularMonthly),
    averageMonthly: round(avgMonthly),
    irregularMonthly: round(Math.max(0, avgMonthly - regularMonthly)),
  };
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}

export function overview(db) {
  const asOf = asOfDate(db);
  const thisMonth = asOf.slice(0, 7);
  const [mStart] = monthRange(thisMonth);
  const months = monthlySummary(db, 12);
  const current = months[months.length - 1];
  return {
    asOf,
    months,
    current: { ...current, projectedSpending: round(projectSpending(months, asOf)) },
    categories: categoryTotals(db, mStart, asOf),
    merchants: topMerchants(db, mStart, asOf, 8),
    income: incomeProfile(db),
    bills: detectRecurring(db, { direction: 'out' }).filter((b) => b.active),
    budgets: budgetStatus(db, mStart, asOf),
    counts: db.prepare(`SELECT count(*) AS total, sum(category = 'Uncategorised') AS uncategorised FROM transactions`).get(),
  };
}

// Spending so far this month plus your usual daily pace for the days left. Avoids the wild
// projections a straight-line extrapolation gives right after rent comes out on the 1st.
function projectSpending(months, asOf) {
  const current = months[months.length - 1];
  const complete = months.slice(0, -1).filter((m) => m.income > 0 || m.spending > 0).slice(-3);
  const daysInMonth = Number(monthRange(current.month)[1].slice(8, 10));
  const day = Number(asOf.slice(8, 10));
  if (!complete.length) return (current.spending / day) * daysInMonth;
  const usualDaily = complete.reduce((s, m) => s + m.spending, 0) / complete.length / daysInMonth;
  return current.spending + usualDaily * (daysInMonth - day);
}

export function budgetStatus(db, from, to) {
  const budgets = db.prepare('SELECT * FROM budgets').all();
  const totals = new Map(categoryTotals(db, from, to).map((c) => [c.category, c.total]));
  return budgets.map((b) => ({ ...b, spent: totals.get(b.category) || 0 }));
}

// Rule-based advice. Each insight: { level: 'good' | 'warn' | 'info', title, detail }.
export function insights(db) {
  const out = [];
  const count = db.prepare('SELECT count(*) AS n FROM transactions').get().n;
  if (count === 0) return out;

  const asOf = asOfDate(db);
  const months = monthlySummary(db, 7);
  // Use the last complete month for rates and comparisons; the current month is partial.
  const complete = months.slice(0, -1).filter((m) => m.income > 0 || m.spending > 0);
  const lastFull = complete[complete.length - 1];

  if (lastFull && lastFull.income > 0) {
    const rate = (lastFull.income - lastFull.spending) / lastFull.income;
    const pct = Math.round(rate * 100);
    if (rate < 0) out.push({ level: 'warn', title: `You spent ${money(lastFull.spending - lastFull.income)} more than you earned in ${monthName(lastFull.month)}`, detail: 'Check the categories below for what drove it, and whether it was a one-off.' });
    else if (rate < 0.1) out.push({ level: 'warn', title: `Savings rate was ${pct}% in ${monthName(lastFull.month)}`, detail: `Aim for at least 10–20%. Saving 20% of ${money(lastFull.income)} would be ${money(lastFull.income * 0.2)} a month.` });
    else if (rate >= 0.2) out.push({ level: 'good', title: `Strong savings rate: ${pct}% in ${monthName(lastFull.month)}`, detail: `You kept ${money(lastFull.income - lastFull.spending)}. Consider moving a set amount to savings or your offset on payday so it stays saved.` });
    else out.push({ level: 'info', title: `Savings rate was ${pct}% in ${monthName(lastFull.month)}`, detail: 'Getting to 20% is a common target; the biggest discretionary categories are the easiest place to find it.' });
  }

  if (lastFull && complete.length >= 2) {
    const [ls, le] = monthRange(lastFull.month);
    const prior = complete.slice(-4, -1).map((m) => m.month);
    const priorTotals = new Map();
    for (const m of prior) {
      const [s, e] = monthRange(m);
      for (const c of categoryTotals(db, s, e)) priorTotals.set(c.category, (priorTotals.get(c.category) || 0) + c.total / prior.length);
    }
    for (const c of categoryTotals(db, ls, le)) {
      const avg = priorTotals.get(c.category) || 0;
      if (avg > 0 && c.total > avg * 1.3 && c.total - avg > 100) {
        out.push({ level: 'warn', title: `${c.category} up ${Math.round((c.total / avg - 1) * 100)}% in ${monthName(lastFull.month)}`, detail: `${money(c.total)} vs your usual ${money(avg)} a month.` });
      }
    }

    let needs = 0;
    let wants = 0;
    for (const c of categoryTotals(db, ls, le)) (NEEDS.has(c.category) ? (needs += c.total) : (wants += c.total));
    if (lastFull.income > 0) {
      const n = Math.round((needs / lastFull.income) * 100);
      const w = Math.round((wants / lastFull.income) * 100);
      const s = 100 - n - w;
      out.push({ level: w > 30 ? 'warn' : 'info', title: `50/30/20 check: ${n}% needs, ${w}% wants, ${s}% saved`, detail: w > 30 ? `Wants are above 30% of income. Trimming them to 30% frees up about ${money(wants - lastFull.income * 0.3)} a month.` : 'A common guide is ≤50% needs, ≤30% wants and ≥20% savings.' });
    }
  }

  const income = incomeProfile(db);
  const main = income.streams.find((s) => s.active);
  if (main) {
    out.push({ level: 'info', title: `Main income: ${money(main.amount)} ${main.cadence} from ${main.merchant}`, detail: `Next payment expected around ${main.next}. Regular income ≈ ${money(income.regularMonthly)}/month${income.irregularMonthly > 50 ? `, plus about ${money(income.irregularMonthly)}/month of irregular income` : ''}.` });
  } else if (income.averageMonthly > 0) {
    out.push({ level: 'info', title: `Income averages ${money(income.averageMonthly)}/month`, detail: 'No regular pay cycle detected yet; import a few more months of your ANZ Plus statements so the app can learn it.' });
  }

  const bills = detectRecurring(db, { direction: 'out' }).filter((b) => b.active);
  const subs = bills.filter((b) => b.category === 'Subscriptions');
  if (subs.length) {
    const total = subs.reduce((s, b) => s + b.monthly, 0);
    out.push({ level: total > 100 ? 'warn' : 'info', title: `${subs.length} subscriptions costing ${money(total)}/month (${money(total * 12)}/year)`, detail: `${subs.slice(0, 5).map((s) => `${s.merchant} ${money(s.amount)}`).join(', ')}. Cancel any you haven't used in the past month.` });
  }

  const from90 = new Date(Date.parse(asOf) - 90 * DAY).toISOString().slice(0, 10);
  const fees = -(db.prepare(`SELECT sum(amount) AS t FROM transactions WHERE category = 'Fees & Interest' AND date > ?`).get(from90).t || 0);
  if (fees > 0) {
    out.push({ level: 'warn', title: `${money(fees)} in fees and interest over the last 3 months`, detail: 'Credit card interest is usually the most expensive money you can borrow. Paying the full closing balance each month on your ANZ and Amex cards avoids it entirely.' });
  }

  const avgSpend = complete.length ? complete.reduce((s, m) => s + m.spending, 0) / complete.length : 0;
  if (avgSpend > 0) {
    out.push({ level: 'info', title: `Emergency fund target: ${money(avgSpend * 3)}–${money(avgSpend * 6)}`, detail: `That's 3–6 months of your average ${money(avgSpend)} monthly spending, kept in a high-interest savings account or offset.` });
  }

  if (Number(asOf.slice(8, 10)) >= 5 && avgSpend > 0) {
    const projected = projectSpending(months, asOf);
    if (projected > avgSpend * 1.15) out.push({ level: 'warn', title: `On track to spend ${money(projected)} this month`, detail: `That's ${money(projected - avgSpend)} more than your average month.` });
  }

  for (const b of budgetStatus(db, `${asOf.slice(0, 7)}-01`, asOf)) {
    if (b.spent > b.monthly_limit) out.push({ level: 'warn', title: `Over budget on ${b.category}`, detail: `${money(b.spent)} spent of ${money(b.monthly_limit)} this month.` });
    else if (b.spent > b.monthly_limit * 0.8) out.push({ level: 'info', title: `${b.category} budget ${Math.round((b.spent / b.monthly_limit) * 100)}% used`, detail: `${money(b.monthly_limit - b.spent)} left this month.` });
  }

  const uncategorised = db.prepare("SELECT count(*) AS n FROM transactions WHERE category = 'Uncategorised'").get().n;
  if (uncategorised > 0) out.push({ level: 'info', title: `${uncategorised} transactions need a category`, detail: 'Categorise one and choose "apply to similar" — the app learns the rule for the future.' });

  return out;
}

function monthName(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function round(n) {
  return Math.round((n || 0) * 100) / 100;
}
