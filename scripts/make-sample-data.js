// Writes six months of realistic sample statements to ./samples so you can try the app
// without real bank data:  node scripts/make-sample-data.js
import fs from 'node:fs';

const end = new Date(process.argv[2] || Date.now());
const start = new Date(end);
start.setMonth(start.getMonth() - 6);
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const iso = (d) => d.toISOString().slice(0, 10);
const days = [];
for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(new Date(d));

const anzPlus = [];
const anzCc = [];
const amex = [];

days.forEach((d, i) => {
  // Fortnightly salary, monthly rent, bills, card repayments from ANZ Plus
  if (i % 14 === 3) anzPlus.push([d, 'SALARY ACME PTY LTD PAYROLL', 3245.6]);
  if (d.getDate() === 1) anzPlus.push([d, 'RENT RAY WHITE PROPERTY', -2400]);
  if (d.getDate() === 12) anzPlus.push([d, 'TELSTRA DIRECT DEBIT 4839201', -89]);
  if (d.getDate() === 20 && d.getMonth() % 3 === 0) anzPlus.push([d, 'AGL ENERGY BPAY 77291', -(310 + Math.round(rand() * 60))]);
  if (d.getDate() === 25) {
    const ccBill = 600 + Math.round(rand() * 300);
    anzPlus.push([d, 'TRANSFER TO ANZ CREDIT CARD', -ccBill]);
    anzCc.push([new Date(d.getTime() + 86400000), 'PAYMENT THANKYOU', ccBill]);
  }
  if (d.getDate() === 27) {
    const amexBill = 900 + Math.round(rand() * 400);
    anzPlus.push([d, 'AMERICAN EXPRESS BPAY', -amexBill]);
    amex.push([new Date(d.getTime() + 2 * 86400000), 'PAYMENT RECEIVED - THANK YOU', -amexBill]); // Amex: payments negative
  }
  if (rand() < 0.08) anzPlus.push([d, 'ATM WITHDRAWAL CBA SYDNEY', -pick([50, 100])]);

  // Everyday spending on cards
  if (rand() < 0.35) anzCc.push([d, `${pick(['WOOLWORTHS 1234', 'COLES 0567', 'ALDI STORES'])} SYDNEY NSW AUS`, -(30 + Math.round(rand() * 120 * 100) / 100)]);
  if (rand() < 0.2) anzCc.push([d, `${pick(['SHELL COLES EXPRESS', 'AMPOL FOODARY', 'BP CONNECT'])} 2041 NSW`, -(50 + Math.round(rand() * 40 * 100) / 100)]);
  if (rand() < 0.4) amex.push([d, pick(['UBER *EATS HELP.UBER.COM', 'GUZMAN Y GOMEZ SYDNEY', 'STARBUCKS PITT ST', 'MENULOG PTY LTD']), 15 + Math.round(rand() * 45 * 100) / 100]);
  if (rand() < 0.1) amex.push([d, pick(['AMAZON AU MARKETPLACE', 'JB HI-FI ONLINE', 'KMART 1032', 'BUNNINGS 3321']), 25 + Math.round(rand() * 180 * 100) / 100]);
  if (d.getDate() === 7) amex.push([d, 'NETFLIX.COM MELBOURNE', 22.99]);
  if (d.getDate() === 15) amex.push([d, 'SPOTIFY P1A2B3C4 SYDNEY', 13.99]);
  if (d.getDate() === 3) anzCc.push([d, 'ANYTIME FITNESS NEWTOWN', -64.95]);
  if (d.getDate() === 28) anzCc.push([d, 'PURCHASE INTEREST CHARGED', -18.4]);
});

fs.mkdirSync('samples', { recursive: true });
const q = (s) => `"${s}"`;
// ANZ Plus style: headered, signed amounts
fs.writeFileSync('samples/anz-plus.csv', ['Date,Description,Amount', ...anzPlus.sort((a, b) => a[0] - b[0]).map(([d, desc, amt]) => `${ddmmyyyy(d)},${q(desc)},${amt.toFixed(2)}`)].join('\n'));
// ANZ Internet Banking credit card: headerless Date,Amount,Description, purchases negative
fs.writeFileSync('samples/anz-credit-card.csv', anzCc.sort((a, b) => a[0] - b[0]).map(([d, desc, amt]) => `${ddmmyyyy(d)},${amt.toFixed(2)},${q(desc)}`).join('\n'));
// Amex AU: headered, purchases positive
fs.writeFileSync('samples/amex.csv', ['Date,Date Processed,Description,Card Member,Account #,Amount', ...amex.sort((a, b) => a[0] - b[0]).map(([d, desc, amt]) => `${ddmmyyyy(d)},${ddmmyyyy(d)},${q(desc)},J CITIZEN,-71004,${amt.toFixed(2)}`)].join('\n'));
console.log(`Wrote samples/anz-plus.csv (${anzPlus.length}), samples/anz-credit-card.csv (${anzCc.length}), samples/amex.csv (${amex.length}) covering ${iso(start)} to ${iso(end)}`);
