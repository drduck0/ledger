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

async function createPage(dataSourceId, properties) {
  return notion('/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties })
  });
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

function txKey(date, amount, name) {
  const d = String(date || '').slice(0, 10);
  const a = Number(amount || 0).toFixed(2);
  const n = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${d}|${a}|${n}`;
}

function buildExistingKeySet(pages) {
  const set = new Set();
  for (const page of pages) {
    const name = getPlainTitle(page);
    const date = getDateValue(page);
    const amount = getNumberValue(page);
    if (name) {
      set.add(txKey(date, amount, name));
      set.add(txKey(date, amount, cleanMerchant(name)));
    }
  }
  return set;
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

    const expenseKeys = buildExistingKeySet(existingExpenses);
    const incomeKeys = buildExistingKeySet(existingIncomes);

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
      return budgetPages.find(page => getPlainTitle(page).trim().toLowerCase() === needle) || null;
    };

    let savedTransactions = 0;
    let skippedDuplicates = 0;

    for (const tx of transactions) {
      const isIncome = tx.type === 'Received';
      const targetId = isIncome ? incomesId : expensesId;
      const existingKeys = isIncome ? incomeKeys : expenseKeys;
      const rawName = String(tx.name || tx.remarks || (isIncome ? 'Income' : 'Expense'));
      const displayName = cleanMerchant(rawName) || rawName;
      const cleanKey = txKey(tx.date, tx.amount, displayName);
      const rawKey = txKey(tx.date, tx.amount, rawName);

      if (existingKeys.has(cleanKey) || existingKeys.has(rawKey)) {
        skippedDuplicates += 1;
        continue;
      }

      const props = isIncome ? {
        'Income': { title: title(displayName) },
        'Date': { date: tx.date ? { start: tx.date } : null },
        'Amount': { number: Number(tx.amount || 0) },
        'Type': { select: { name: /refund/i.test(tx.category || tx.remarks || '') ? 'Refund' : 'Other' } },
        'Pay': { multi_select: [{ name: 'Bank' }] }
      } : {
        'Expense': { title: title(displayName) },
        'Date': { date: tx.date ? { start: tx.date } : null },
        'Amount': { number: Number(tx.amount || 0) },
        'Pay': { multi_select: [{ name: 'Bank' }] }
      };

      const monthPage = findMonthPage(tx.date);
      if (monthPage) props['Month Classification'] = { relation: relation(monthPage.id) };

      if (!isIncome) {
        const budgetPage = findBudgetPage(tx.category);
        if (budgetPage) props['Budget'] = { relation: relation(budgetPage.id) };
      }

      await createPage(targetId, props);
      existingKeys.add(cleanKey);
      existingKeys.add(rawKey);
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
