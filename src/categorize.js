// Categorisation: your own rules first (learned from every correction you make),
// then built-in keyword rules for common Australian merchants.

export const CATEGORIES = [
  'Income', 'Groceries', 'Dining & Takeaway', 'Transport', 'Fuel', 'Utilities',
  'Phone & Internet', 'Rent & Mortgage', 'Insurance', 'Health', 'Shopping',
  'Entertainment', 'Subscriptions', 'Travel', 'Education', 'Kids & Family', 'Pets',
  'Personal Care', 'Home', 'Fees & Interest', 'Cash', 'Gifts & Donations',
  'Government & Tax', 'Transfer', 'Uncategorised',
];

// Categories that are not spending or income (money moving between your own accounts).
export const NON_SPENDING = new Set(['Transfer']);

const BUILTIN = [
  ['Transfer', /\b(PAYMENT RECEIVED|PAYMENT - THANK YOU|PAYMENT THANK YOU|THANK YOU FOR YOUR PAYMENT|TRANSFER TO|TRANSFER FROM|TFR|INTERNET TRANSFER|ONLINE TRANSFER|AMEX|AMERICAN EXPRESS|CREDIT CARD PAYMENT|ANZ CC|BPAY.*(ANZ|AMEX))\b/],
  ['Income', /\b(SALARY|PAYROLL|WAGES|PAY\/SALARY|DIVIDEND|INTEREST PAID|INTEREST CREDIT|CENTRELINK|ATO REFUND|TAX REFUND)\b/],
  ['Groceries', /\b(WOOLWORTHS|WOOLIES|COLES|ALDI|IGA|HARRIS FARM|FOODWORKS|COSTCO|DRAKES|FOODLAND|SPUDSHED|MONEY SAVER)\b/],
  ['Dining & Takeaway', /\b(UBER\W*EATS|MENULOG|DOORDASH|DELIVEROO|MCDONALDS|MCDONALD'S|KFC|HUNGRY JACKS|DOMINOS|DOMINO'S|PIZZA|GUZMAN|GYG|NANDOS|SUBWAY|GRILL'D|CAFE|COFFEE|RESTAURANT|SUSHI|BAKERY|BAR|PUB|STARBUCKS|BOOST JUICE|OPORTO|RED ROOSTER)\b/],
  ['Fuel', /\b(SHELL|BP|CALTEX|AMPOL|7-ELEVEN|7 ELEVEN|UNITED PETROL|METRO PETROLEUM|PUMA ENERGY|LIBERTY OIL|EG FUEL|COLES EXPRESS|REDDY EXPRESS)\b/],
  ['Transport', /\b(UBER(?!\W*EATS)|DIDI|OLA|13CABS|TAXI|OPAL|MYKI|GO CARD|TRANSPERTH|TRANSLINK|LINKT|E-TOLL|ETOLL|CITYLINK|PARKING|WILSON PARKING|SECURE PARKING|CAR WASH|REGO|SERVICE NSW|VICROADS)\b/],
  ['Utilities', /\b(AGL|ORIGIN ENERGY|ENERGYAUSTRALIA|ENERGY AUSTRALIA|RED ENERGY|ALINTA|SIMPLY ENERGY|POWERSHOP|LUMO|SYDNEY WATER|YARRA VALLEY WATER|SA WATER|URBAN UTILITIES|COUNCIL RATES|GAS)\b/],
  ['Phone & Internet', /\b(TELSTRA|OPTUS|VODAFONE|TPG|AUSSIE BROADBAND|IINET|BELONG|AMAYSIM|BOOST MOBILE|SUPERLOOP|DODO|FELIX MOBILE|LEBARA)\b/],
  ['Rent & Mortgage', /\b(RENT|REAL ESTATE|MORTGAGE|HOME LOAN|LOAN REPAYMENT|RAY WHITE|LJ HOOKER|MCGRATH|BELLE PROPERTY)\b/],
  ['Insurance', /\b(INSURANCE|NRMA|AAMI|BUDGET DIRECT|ALLIANZ|SUNCORP|YOUI|RACV|RACQ|QBE|GIO|MEDIBANK|BUPA|HCF|NIB|AHM|HBF)\b/],
  ['Health', /\b(CHEMIST|PHARMACY|PRICELINE|TERRYWHITE|MEDICAL|DOCTOR|DENTAL|DENTIST|PATHOLOGY|PHYSIO|HOSPITAL|OPTOMETRIST|SPECSAVERS|MEDICARE)\b/],
  ['Subscriptions', /\b(NETFLIX|SPOTIFY|STAN\b|BINGE|DISNEY|KAYO|FOXTEL|YOUTUBE|APPLE\.COM|APPLE COM|ITUNES|GOOGLE ONE|GOOGLE STORAGE|AMAZON PRIME|PRIME VIDEO|PARAMOUNT|AUDIBLE|PATREON|MICROSOFT|ADOBE|DROPBOX|CHATGPT|OPENAI|ANTHROPIC|CLAUDE\.AI|GYM|FITNESS|ANYTIME FITNESS|F45|PLAYSTATION|XBOX|NINTENDO)\b/],
  ['Entertainment', /\b(TICKETEK|TICKETMASTER|EVENT CINEMAS|HOYTS|VILLAGE CINEMAS|READING CINEMAS|STEAM|BOWLING|ZOO|MUSEUM|CONCERT)\b/],
  ['Shopping', /\b(AMAZON|EBAY|KMART|TARGET|BIG W|MYER|DAVID JONES|JB HI-FI|JB HIFI|HARVEY NORMAN|OFFICEWORKS|BUNNINGS|IKEA|UNIQLO|COTTON ON|THE ICONIC|CATCH\.COM|REBEL|TEMU|SHEIN|ALIEXPRESS|APPLE STORE|DECATHLON)\b/],
  ['Travel', /\b(QANTAS|VIRGIN AUSTRALIA|JETSTAR|REX AIRLINES|AIRBNB|BOOKING\.COM|EXPEDIA|HOTELS\.COM|AGODA|WEBJET|HOTEL|MOTEL)\b/],
  ['Education', /\b(UNIVERSITY|TAFE|SCHOOL|UDEMY|COURSERA|BOOKTOPIA|HECS)\b/],
  ['Kids & Family', /\b(CHILDCARE|CHILD CARE|DAYCARE|KINDERGARTEN|BABY BUNTING)\b/],
  ['Pets', /\b(PETBARN|PET CIRCLE|PETSTOCK|VET|VETERINARY)\b/],
  ['Personal Care', /\b(HAIRDRESS|BARBER|SALON|BEAUTY|SEPHORA|MECCA|NAIL)\b/],
  ['Fees & Interest', /\b(INTEREST CHARGED|PURCHASE INTEREST|CASH ADVANCE INTEREST|ANNUAL FEE|ACCOUNT FEE|LATE PAYMENT FEE|LATE FEE|OVERSEAS TRANSACTION FEE|INTERNATIONAL TRANSACTION FEE|FOREIGN TRANSACTION FEE|ATM FEE|MEMBERSHIP FEE)\b/],
  ['Cash', /\b(ATM|CASH WITHDRAWAL|CASH OUT)\b/],
  ['Gifts & Donations', /\b(DONATION|RED CROSS|SALVATION ARMY|UNICEF|WORLD VISION|GOFUNDME)\b/],
  ['Government & Tax', /\b(ATO|AUSTRALIAN TAXATION|FINES|INFRINGEMENT|PASSPORT)\b/],
];

const NOISE = [
  /\b(VISA|EFTPOS|DEBIT|CARD|PURCHASE|POS|TAP AND PAY|TAP & PAY|APPLE PAY|GOOGLE PAY|PAYPAL \*|SQ \*|SQ\*|ZLR\*|ZLR \*)\b/g,
  /\bCARD \d{3,}/g,
  /\b(AUS|AU|AUSTRALIA|NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/g,
  /\b\d{2}\/\d{2}(\/\d{2,4})?\b/g,
  /\bVALUE DATE.*$/g,
  /\b[A-Z]*\d[A-Z\d]{4,}\b/g, // reference numbers / store numbers
  /\d{3,}/g,
  /[^A-Z0-9&' ]/g,
];

export function normaliseMerchant(description) {
  let m = ` ${description.toUpperCase()} `;
  for (const re of NOISE) m = m.replace(re, ' ');
  const words = m.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words.slice(0, 4).join(' ') || description.toUpperCase().slice(0, 30);
}

export function builtinCategory(description, amount, accountType = 'transaction') {
  const text = ` ${description.toUpperCase()} `;
  for (const [category, re] of BUILTIN) {
    if (re.test(text)) {
      // A positive "Woolworths" is a refund, still groceries; but salary-like words only count as income when positive.
      if (category === 'Income' && amount < 0) continue;
      return category;
    }
  }
  if (amount > 0) {
    // Unmatched credits on a card are almost always repayments; on a bank account they're income.
    return accountType === 'credit' ? 'Transfer' : 'Income';
  }
  return 'Uncategorised';
}

export function loadRules(db) {
  // Longest pattern first so "UBER EATS" beats "UBER".
  return db.prepare('SELECT * FROM rules ORDER BY length(pattern) DESC').all();
}

export function categorise(rules, { description, merchant, amount, account_type }) {
  const haystack = `${merchant} ${description.toUpperCase()}`;
  for (const r of rules) {
    if (haystack.includes(r.pattern)) return { category: r.category, source: 'rule' };
  }
  return { category: builtinCategory(description, amount, account_type), source: 'auto' };
}

// Re-run rules over everything you haven't categorised by hand. Called after a rule changes.
export function recategoriseAll(db) {
  const rules = loadRules(db);
  const rows = db.prepare(`
    SELECT t.id, t.description, t.merchant, t.amount, t.category, a.type AS account_type
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.category_source != 'user' AND t.is_transfer = 0`).all();
  const update = db.prepare('UPDATE transactions SET category = ?, category_source = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    const { category, source } = categorise(rules, row);
    if (category !== row.category) changed++;
    update.run(category, source, row.id);
  }
  return changed;
}

// Learn from a correction: save a rule so every past and future match gets the same category.
export function learnRule(db, pattern, category) {
  const p = pattern.toUpperCase().trim();
  if (!p) throw new Error('Rule pattern cannot be empty.');
  db.prepare('INSERT INTO rules (pattern, category) VALUES (?, ?) ON CONFLICT(pattern) DO UPDATE SET category = excluded.category')
    .run(p, category);
  return recategoriseAll(db);
}
