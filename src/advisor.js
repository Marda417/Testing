import Anthropic from '@anthropic-ai/sdk';
import { categoryTotals, insights, monthlySummary, overview } from './analysis.js';

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You are a personal finance coach for someone in Australia. They track an ANZ Plus everyday account, an ANZ credit card and an American Express card in this app.

You'll get a JSON snapshot of their finances computed from their transactions: monthly income and spending, category totals, detected income streams (learned from regular deposits), recurring bills and subscriptions, budgets and rule-based insights. Transfers between their own accounts (e.g. credit card repayments) are already excluded.

How to answer:
- Ground every point in their actual numbers and name the categories, merchants or months involved. Don't invent figures that aren't in the snapshot.
- Prioritise: lead with the two or three changes that would make the biggest dollar difference, with an estimated monthly or yearly saving where you can work one out.
- Use Australian context where relevant: offset accounts, high-interest savings accounts, superannuation (concessional contributions), HECS-HELP, the ATO, paying credit cards in full to avoid interest, the Amex and ANZ annual fees.
- Be direct and practical, short paragraphs or a short list, plain language, AUD. No lecturing.
- You only see transactions, not balances, debts or assets. When advice depends on those (emergency fund, debt payoff order, investing), say what you'd need to know.
- This is general information, not personal financial advice; for big decisions (investments, super, tax) suggest a licensed adviser or the ATO, briefly and only when relevant.`;

export function advisorAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// A compact, aggregated view of the user's finances. Individual transactions are not sent.
export function buildSnapshot(db) {
  const o = overview(db);
  const months = monthlySummary(db, 6);
  const categoryHistory = months.map((m) => {
    const [y, mo] = m.month.split('-').map(Number);
    const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    return { month: m.month, categories: categoryTotals(db, `${m.month}-01`, end).map((c) => ({ category: c.category, total: c.total })) };
  });
  return {
    asOf: o.asOf,
    monthly: months,
    currentMonth: o.current,
    categoryHistory,
    topMerchantsThisMonth: o.merchants,
    income: o.income,
    recurringBills: o.bills.map(({ merchant, category, cadence, amount, monthly, next }) => ({ merchant, category, cadence, amount, monthly, next })),
    budgets: o.budgets,
    insights: insights(db).map(({ level, title, detail }) => ({ level, title, detail })),
  };
}

// Streams advice as text chunks via onText. `history` is prior [{role, content}] text turns.
export async function streamAdvice(db, { question, history = [] }, onText) {
  const client = new Anthropic();
  const snapshot = buildSnapshot(db);
  const prompt = question?.trim() || 'Review my finances and give me your top recommendations.';
  const messages = [
    ...history.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content),
    { role: 'user', content: `<finance_snapshot>\n${JSON.stringify(snapshot)}\n</finance_snapshot>\n\n${prompt}` },
  ];

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'medium' },
    // If a safety classifier declines, retry server-side on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages,
  });
  stream.on('text', onText);
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    onText('\n\n_The advisor declined to answer this one. Try rephrasing the question._');
  } else if (message.stop_reason === 'max_tokens') {
    onText('\n\n_(Response cut short.)_');
  }
  // The question stored in history is the plain one; the snapshot is re-sent fresh each turn.
  return { prompt };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Your ANTHROPIC_API_KEY was rejected. Check it in .env.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Claude API. Try again in a minute.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err.message || String(err);
}
