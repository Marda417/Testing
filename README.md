# My Finances

A private, self-hosted web app that pulls together transactions from **ANZ Plus**, your **ANZ credit card** and **American Express**, learns your income and regular bills, and gives you advice.

- **Import** CSV statements from each bank (formats are auto-detected), or **sync automatically** through open banking (CDR) with Basiq.
- **Categorises** transactions using built-in rules for common Australian merchants, and **learns** from every correction you make.
- **Detects transfers** between your own accounts (e.g. paying off the Amex from ANZ Plus), so they aren't counted as spending or income.
- **Learns your income**: finds your pay cycle (weekly, fortnightly, monthly), the amount and the next expected payday, plus irregular income.
- **Finds recurring bills and subscriptions** and what they cost per month and year.
- **Insights**: savings rate, 50/30/20 split, category spikes, fees and credit card interest, emergency fund target, month-end projection, budget alerts.
- **AI advice** (optional): ask questions in plain English and get answers grounded in your own numbers, using Claude.

Your data stays in a local SQLite file (`data/finance.db`). Nothing leaves your machine except an aggregated summary (totals, categories, income and bills, not individual transactions) when you ask the AI advisor, and bank data fetched from Basiq if you turn sync on.

## Getting started

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env   # optional: add API keys
npm start
```

Open http://127.0.0.1:3000.

1. Go to **Accounts & import** and add your three accounts with the ANZ Plus / ANZ credit card / Amex buttons.
2. Download a CSV from each bank (6–12 months is ideal so income and bills can be learned) and import each into its account.
3. Check **Transactions** and click any category to fix it. Leave "apply to similar" ticked and the app learns a rule.

Want to try it first? `node scripts/make-sample-data.js` writes six months of realistic sample statements to `samples/`.

### Getting CSV statements

| Bank | Where |
| --- | --- |
| ANZ Plus | ANZ Plus app → account → Statements / Transaction history → Export as CSV |
| ANZ credit card | ANZ Internet Banking → select the card → Download transactions → CSV |
| American Express | americanexpress.com.au → Statements & activity → Download → CSV |

Re-importing overlapping statements is safe; duplicates are skipped. Amex exports purchases as positive numbers; the app detects this and flips them. If a credit card's signs ever come out backwards, set the account's sign mode via `PATCH /api/accounts/:id` with `{"sign_mode": "inverted"}` or `"normal"`.

## AI advice (optional)

Add your Claude API key to `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then use the **Advice** tab. It uses Claude Opus 5.5 and streams the answer. If a safety classifier declines a request, it is automatically retried on Anthropic's recommended fallback model (`fallbacks: "default"`).

## Automatic bank sync (optional)

ANZ Plus, ANZ credit cards and Amex Australia all share data under the Consumer Data Right. The app connects through [Basiq](https://basiq.io):

1. Create a Basiq account and an application, and copy its API key.
2. Add `BASIQ_API_KEY=...` to `.env` and restart.
3. In **Accounts & import**, enter your email and click **Connect banks**. Basiq's consent screen opens; pick your banks and log in there. This app never sees your bank passwords.
4. Back in the app, link each bank account to the account you've imported CSVs into (so history isn't duplicated) and click **Sync now**.

Note: Basiq is a paid service once you go beyond its developer tier. The Basiq integration is written against Basiq's v3 API but hasn't yet been run against a live Basiq account, so expect to test it with your own key.

## Security

- The server binds to `127.0.0.1` by default, so only your computer can reach it. There's no login, so don't expose it to a network or the internet without putting authentication in front of it.
- Cross-site requests from other web pages are rejected.
- `data/` and `.env` are git-ignored.

## Development

```bash
npm run dev    # restart on file changes
npm test       # unit tests (node:test)
```

| Path | What |
| --- | --- |
| `src/server.js` | Express API and static file server |
| `src/db.js` | SQLite schema (built-in `node:sqlite`) |
| `src/importers/csv.js` | CSV parsing and bank format detection |
| `src/importer.js` | De-duplicated import and transfer matching |
| `src/categorize.js` | Built-in merchant rules and learned rules |
| `src/analysis.js` | Summaries, income and bill detection, insights |
| `src/advisor.js` | Claude-powered advice |
| `src/basiq.js` | Open banking sync |
| `public/` | Front end (plain HTML, CSS and JS with Chart.js) |
