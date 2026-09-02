const NOTION_VERSION = '2025-09-03';
const NOTION_BASE = 'https://api.notion.com/v1';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = (name, fallback) => process.env[name] || process.env[fallback];

function isoMonth(date) {
  return String(date || '').slice(0, 7);
}

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
    const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(15000, 1200 * (2 ** attempt));
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

async function createPage(dataSourceId, properties) {
  return notion('/pages', {
    method: 'POST',
    body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties })
  });
}

function text(value) { return [{ type: 'text', text: { content: String(value ?? '').slice(0, 1900) } }]; }
function title(value) { return [{ type: 'text', text: { content: String(value ?? '').slice(0, 1900) } }]; }
function relation(id) { return id ? [{ id }] : []; }

function getPlainTitle(page) {
  const props = page.properties || {};
  for (const p of Object.values(props)) {
    if (p.type === 'title' && Array.isArray(p.title)) return p.title.map(x => x.plain_text || x.text?.content || '').join('');
  }
  return '';
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

async function findByTitleContains(dataSourceId, candidates) {
  const result = await queryDataSource(dataSourceId);
  const lower = candidates.map(x => x.toLowerCase());
  return result.results?.find(page => {
    const name = getPlainTitle(page).toLowerCase();
    return lower.some(c => name === c || name.includes(c));
  }) || null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const statementsId = env('NOTION_STATEMENTS_DATA_SOURCE_ID', 'NOTION_STATEMENTS_DATABASE_ID');
  const expensesId = env('NOTION_EXPENSES_DATA_SOURCE_ID', 'NOTION_EXPENSES_DATABASE_ID');
  const incomesId = env('NOTION_INCOMES_DATA_SOURCE_ID', 'NOTION_INCOMES_DATABASE_ID');
  const monthId = env('NOTION_MONTH_DATA_SOURCE_ID', 'NOTION_MONTH_DATABASE_ID');
  const budgetId = env('NOTION_BUDGET_DATA_SOURCE_ID', 'NOTION_BUDGET_DATABASE_ID');

  if (!statementsId || !expensesId || !incomesId) {
    return res.status(500).json({ error: 'Required Notion data source IDs are missing in Vercel' });
  }

  try {
    const { statement, transactions = [] } = req.body || {};
    if (!statement?.statementHash) return res.status(400).json({ error: 'Invalid statement payload' });

    // Duplicate check before any writes.
    const existing = await queryDataSource(statementsId);
    const duplicate = existing.results?.find(page => {
      const p = page.properties?.['Statement Hash'];
      const value = (p?.rich_text || []).map(x => x.plain_text || '').join('');
      return value === statement.statementHash;
    });
    if (duplicate) return res.status(200).json({ duplicate: true, savedTransactions: 0 });

    // Load relation targets once. This avoids making extra Notion requests for every transaction.
    const [monthPages, budgetPages] = await Promise.all([
      monthId ? queryDataSource(monthId) : Promise.resolve({ results: [] }),
      budgetId ? queryDataSource(budgetId) : Promise.resolve({ results: [] })
    ]);
    const findMonthPage = date => {
      const candidates = monthCandidates(date);
      return monthPages.results?.find(page => {
        const name = getPlainTitle(page).toLowerCase();
        return candidates.some(c => name === c || name.includes(c));
      }) || null;
    };
    const findBudgetPage = category => {
      const needle = String(category || '').trim().toLowerCase();
      if (!needle) return null;
      return budgetPages.results?.find(page => getPlainTitle(page).trim().toLowerCase() === needle) || null;
    };

    let savedTransactions = 0;
    // One write roughly every 400ms keeps us safely under Notion's average rate limit.
    for (const tx of transactions) {
      const isIncome = tx.type === 'Received';
      const targetId = isIncome ? incomesId : expensesId;
      const props = isIncome ? {
        'Income': { title: title(tx.name || tx.remarks || 'Income') },
        'Date': { date: tx.date ? { start: tx.date } : null },
        'Amount': { number: Number(tx.amount || 0) },
        'Type': { select: { name: /refund/i.test(tx.category || tx.remarks || '') ? 'Refund' : 'Other' } }
      } : {
        'Expense': { title: title(tx.name || tx.remarks || 'Expense') },
        'Date': { date: tx.date ? { start: tx.date } : null },
        'Amount': { number: Number(tx.amount || 0) }
      };

      const monthPage = findMonthPage(tx.date);
      if (monthPage) props['Month Classification'] = { relation: relation(monthPage.id) };

      if (!isIncome) {
        const budgetPage = findBudgetPage(tx.category);
        if (budgetPage) props['Budget'] = { relation: relation(budgetPage.id) };
      }

      await createPage(targetId, props);
      savedTransactions += 1;
      await sleep(420);
    }

    // Create the statement record last, only after all transaction writes succeed.
    await createPage(statementsId, {
      'Statement Name': { title: title(statement.name || 'Ledger Statement') },
      'Statement Type': { select: { name: statement.type || 'Bank' } },
      'Start Date': { date: statement.startDate ? { start: statement.startDate } : null },
      'End Date': { date: statement.endDate ? { start: statement.endDate } : null },
      'Total Spent': { number: Number(statement.totalSpent || 0) },
      'Total Received': { number: Number(statement.totalReceived || 0) },
      'Net Amount': { number: Number(statement.netAmount || 0) },
      'Transaction Count': { number: Number(statement.transactionCount || savedTransactions) },
      'Statement Hash': { rich_text: text(statement.statementHash) }
    });

    return res.status(200).json({ duplicate: false, savedTransactions });
  } catch (error) {
    console.error('Save to Notion error:', error);
    const status = error.status === 429 ? 429 : 500;
    return res.status(status).json({ error: error.message || 'Unable to save to Notion' });
  }
}

module.exports = handler;
