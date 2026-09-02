const NOTION_VERSION = '2025-09-03';
const NOTION_BASE = 'https://api.notion.com/v1';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = (name, fallback) => process.env[name] || (fallback ? process.env[fallback] : undefined);

async function notion(path, options = {}, attempt = 0) {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error('NOTION_TOKEN is missing from Vercel Environment Variables');

  const response = await fetch(`${NOTION_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (response.status === 429 && attempt < 8) {
    const retryAfter = Number(response.headers.get('retry-after') || 0);
    const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(12000, 900 * (2 ** attempt));
    await sleep(wait + 250);
    return notion(path, options, attempt + 1);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message || body.code || `Notion request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function queryDataSource(dataSourceId, body = {}) {
  return notion(`/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    body: JSON.stringify({ page_size: 100, ...body })
  });
}

async function queryAll(dataSourceId) {
  const results = [];
  let cursor;
  do {
    const page = await queryDataSource(dataSourceId, cursor ? { start_cursor: cursor } : {});
    results.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return results;
}

async function createPage(dataSourceId, properties, icon) {
  try {
    return await notion('/pages', {
      method: 'POST',
      body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties, ...(icon ? { icon: { type: 'emoji', emoji: icon } } : {}) })
    });
  } catch (error) {
    // If the Category property has not yet been added in Notion, keep the
    // transaction save working rather than failing the whole statement.
    if (/property|schema|does not exist|not found/i.test(String(error.message || ''))) {
      const retryProperties = { ...properties };
      delete retryProperties.Category;
      delete retryProperties['Transaction ID'];
      return notion('/pages', {
        method: 'POST',
        body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties: retryProperties, ...(icon ? { icon: { type: 'emoji', emoji: icon } } : {}) })
      });
    }
    throw error;
  }
}

function text(value) { return [{ type: 'text', text: { content: String(value ?? '').slice(0, 1900) } }]; }
function title(value) { return [{ type: 'text', text: { content: String(value ?? '').slice(0, 1900) } }]; }
function relation(id) { return id ? [{ id }] : []; }

function cleanMerchant(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // Example: UPIAR/621300517797/DR/ZARIVAUL/YESB/paytm-14676198
  //          -> ZARIVAUL/YESB/paytm-14676198
  const marker = raw.match(/\/(?:DR|CR)\/(.+)$/i);
  if (marker?.[1]) return marker[1].trim();
  return raw;
}

function getPlainTitle(page) {
  const props = page.properties || {};
  for (const p of Object.values(props)) {
    if (p.type === 'title' && Array.isArray(p.title)) {
      return p.title.map(x => x.plain_text || x.text?.content || '').join('');
    }
  }
  return '';
}

function getDateValue(page, propertyName = 'Date') {
  const p = page.properties?.[propertyName];
  return p?.date?.start || '';
}

function getNumberValue(page, propertyName = 'Amount') {
  const n = page.properties?.[propertyName]?.number;
  return Number.isFinite(n) ? Number(n) : 0;
}

function getRichTextValue(page, propertyName = 'Transaction ID') {
  const p = page.properties?.[propertyName];
  const parts = p?.rich_text || p?.title || [];
  return Array.isArray(parts)
    ? parts.map(x => x.plain_text || x.text?.content || '').join('').trim()
    : '';
}

function txKey(date, amount, name) {
  const d = String(date || '').slice(0, 10);
  const a = Number(amount || 0).toFixed(2);
  const n = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${d}|${a}|${n}`;
}


// Website categories are the canonical names. Older Budget rows in Notion may
// still use legacy labels, so these aliases keep existing budget amounts working.
const BUDGET_CATEGORY_ALIASES = {
  'Food & Dining': ['Food & Dining', 'Dining', 'Restaurant'],
  'Groceries': ['Groceries', 'Grocery'],
  'Shopping': ['Shopping'],
  'Travel & Transport': ['Travel & Transport', 'Transport', 'Travel'],
  'Petrol': ['Petrol', 'Fuel & Transport'],
  'Recharge': ['Recharge'],
  'Bills & Subscriptions': ['Bills & Subscriptions', 'Insurance', 'Subscriptions & Software'],
  'Health & Personal': ['Health & Personal', 'Health & Personal Care'],
  'Financial Payments': ['Financial Payments', 'Credit card', 'Credit', 'Card Fees & Taxes'],
  'Credit Card Payment': ['Credit Card Payment', 'Credit card payment', 'Credit Card'],
  'Investments': ['Investments', 'Investment (SIP)'],
  'Transfers': ['Transfers', 'Bank Transfer / Loan EMI', 'Wallet Load / Transfer', 'Personal / UPI Payments'],
  'Entertainment': ['Entertainment'],
  'Rent': ['Rent'],
  'Other / Review': ['Other / Review', 'Uncategorized / Review', 'Other'],
};

function budgetCategoryCandidates(category) {
  const canonical = String(category || '').trim();
  return BUDGET_CATEGORY_ALIASES[canonical] || [canonical];
}

function buildExistingState(pages) {
  const transactionIds = new Set();
  const legacyCounts = new Map();

  const addLegacy = key => legacyCounts.set(key, (legacyCounts.get(key) || 0) + 1);

  for (const page of pages) {
    const id = getRichTextValue(page, 'Transaction ID');
    if (id) transactionIds.add(id);

    const name = getPlainTitle(page);
    const date = getDateValue(page);
    const amount = getNumberValue(page);
    if (name) {
      addLegacy(txKey(date, amount, name));
      const cleaned = cleanMerchant(name);
      if (cleaned !== name) addLegacy(txKey(date, amount, cleaned));
    }
  }
  return { transactionIds, legacyCounts };
}


function iconForTransaction(tx, isIncome) {
  if (isIncome) return '💰';
  const category = String(tx.category || '').trim().toLowerCase();
  const icons = {
    'food & dining': '🍔', groceries: '🛒', shopping: '🛍️',
    'travel & transport': '✈️', petrol: '⛽', recharge: '📱',
    'bills & subscriptions': '🧾', 'health & personal': '❤️',
    'financial payments': '🏦', 'credit card payment': '💳',
    investments: '📈', transfers: '🔄', entertainment: '🎬',
    rent: '🏠', 'other / review': '❓'
  };
  return icons[category] || '💸';
}

function monthCandidates(date) {
  if (!date) return [];
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return [String(date).slice(0, 7)];
  const month = d.toLocaleString('en-US', { month: 'long' });
  const short = d.toLocaleString('en-US', { month: 'short' });
  const year = d.getFullYear();
  return [`${month} ${year}`, `${short} ${year}`, `${year}-${String(d.getMonth()+1).padStart(2,'0')}`].map(x => x.toLowerCase());
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const expensesId = env('NOTION_EXPENSES_DATA_SOURCE_ID', 'NOTION_EXPENSES_DATABASE_ID');
  const incomesId = env('NOTION_INCOMES_DATA_SOURCE_ID', 'NOTION_INCOMES_DATABASE_ID');
  const monthId = env('NOTION_MONTH_DATA_SOURCE_ID', 'NOTION_MONTH_DATABASE_ID');
  const budgetId = env('NOTION_BUDGET_DATA_SOURCE_ID', 'NOTION_BUDGET_DATABASE_ID');
  const writeCategory = String(process.env.NOTION_WRITE_CATEGORY || 'false').toLowerCase() === 'true';

  if (!expensesId || !incomesId) {
    return res.status(500).json({ error: 'Expenses or Incomes Notion data source ID is missing in Vercel' });
  }

  try {
    const { transactions = [] } = req.body || {};
    if (!Array.isArray(transactions) || !transactions.length) {
      return res.status(400).json({ error: 'No transactions to save' });
    }

    // Load existing transactions once. This makes retries idempotent: if a previous save
    // partially succeeded, only the missing transactions are created on the next attempt.
    const [existingExpenses, existingIncomes, monthPages, budgetPages] = await Promise.all([
      queryAll(expensesId),
      queryAll(incomesId),
      monthId ? queryAll(monthId) : Promise.resolve([]),
      budgetId ? queryAll(budgetId) : Promise.resolve([])
    ]);

    const expenseState = buildExistingState(existingExpenses);
    const incomeState = buildExistingState(existingIncomes);

    const findMonthPage = date => {
      const candidates = monthCandidates(date);
      return monthPages.find(page => {
        const name = getPlainTitle(page).toLowerCase();
        return candidates.some(c => name === c || name.includes(c));
      }) || null;
    };

    const findBudgetPage = category => {
      const needle = String(category || '').trim().toLowerCase();
      if (!needle) return null;
      const candidates = budgetCategoryCandidates(category).map(x => x.toLowerCase());
      return budgetPages.find(page => candidates.includes(getPlainTitle(page).trim().toLowerCase())) || null;
    };

    let savedTransactions = 0;
    let skippedDuplicates = 0;

    for (const tx of transactions) {
      const isIncome = tx.type === 'Received';
      const targetId = isIncome ? incomesId : expensesId;
      const state = isIncome ? incomeState : expenseState;
      const rawName = String(tx.name || tx.remarks || tx.rawName || (isIncome ? 'Income' : 'Expense'));
      const displayName = cleanMerchant(rawName) || rawName;
      const cleanKey = txKey(tx.date, tx.amount, displayName);
      const rawKey = txKey(tx.date, tx.amount, rawName);
      const transactionId = String(tx.transactionId || tx.id || '').trim();

      // Primary duplicate key: the bank's own Transaction ID. This allows two
      // legitimate same-day transactions with the same merchant and amount.
      if (transactionId && state.transactionIds.has(transactionId)) {
        skippedDuplicates += 1;
        continue;
      }

      // Backward-compatible migration for records saved before Transaction ID
      // existed. Treat legacy records as a COUNT, not a boolean set. Therefore
      // if the statement contains two identical-looking transactions and Notion
      // contains only one old record, exactly one additional transaction is saved.
      const legacyMatchKey = state.legacyCounts.has(cleanKey) ? cleanKey : rawKey;
      const legacyCount = state.legacyCounts.get(legacyMatchKey) || 0;
      if (!transactionId && legacyCount > 0) {
        state.legacyCounts.set(legacyMatchKey, legacyCount - 1);
        skippedDuplicates += 1;
        continue;
      }
      if (transactionId && !state.transactionIds.size && legacyCount > 0) {
        state.legacyCounts.set(legacyMatchKey, legacyCount - 1);
        skippedDuplicates += 1;
        continue;
      }

      const props = isIncome ? {
        'Income': { title: title(displayName) },
        'Date': { date: tx.date ? { start: tx.date } : null },
        'Amount': { number: Number(tx.amount || 0) },
        'Type': { select: { name: /refund/i.test(tx.category || tx.remarks || '') ? 'Refund' : 'Other' } },
        'Pay': { multi_select: [{ name: 'Bank' }] },
        'Transaction ID': { rich_text: text(transactionId) },
        ...(writeCategory ? { 'Category': { rich_text: text(tx.category || 'Income / Received') } } : {})
      } : {
        'Expense': { title: title(displayName) },
        'Date': { date: tx.date ? { start: tx.date } : null },
        'Amount': { number: Number(tx.amount || 0) },
        'Pay': { multi_select: [{ name: 'Bank' }] },
        'Transaction ID': { rich_text: text(transactionId) },
        ...(writeCategory ? { 'Category': { rich_text: text(tx.category || 'Other / Review') } } : {})
      };

      const monthPage = findMonthPage(tx.date);
      if (monthPage) props['Month Classification'] = { relation: relation(monthPage.id) };

      if (!isIncome) {
        const budgetPage = findBudgetPage(tx.category);
        if (budgetPage) props['Budget'] = { relation: relation(budgetPage.id) };
      }

      await createPage(targetId, props, iconForTransaction(tx, isIncome));
      if (transactionId) state.transactionIds.add(transactionId);
      state.legacyCounts.set(cleanKey, (state.legacyCounts.get(cleanKey) || 0) + 1);
      if (rawKey !== cleanKey) state.legacyCounts.set(rawKey, (state.legacyCounts.get(rawKey) || 0) + 1);
      savedTransactions += 1;
      // Gentle pacing; automatic 429 retry above handles temporary bursts safely.
      await sleep(340);
    }

    return res.status(200).json({
      savedTransactions,
      skippedDuplicates,
      duplicate: savedTransactions === 0 && skippedDuplicates > 0
    });
  } catch (error) {
    console.error('Save to Notion error:', error);
    const status = error.status === 429 ? 429 : 500;
    return res.status(status).json({ error: error.message || 'Unable to save to Notion' });
  }
}

module.exports = handler;
