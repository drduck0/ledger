const { Client } = require('@notionhq/client');

const MAX_TITLE = 180;
const MAX_TEXT = 1900;

function title(text) {
  return [{ type: 'text', text: { content: String(text || 'Untitled').slice(0, MAX_TITLE) } }];
}

function richText(text) {
  const value = String(text || '');
  if (!value) return [];
  return [{ type: 'text', text: { content: value.slice(0, MAX_TEXT) } }];
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function date(value) {
  return value ? { start: value } : null;
}

function validatePayload(body) {
  if (!body || !body.statement || !Array.isArray(body.transactions)) {
    throw new Error('Invalid Ledger payload.');
  }
  if (!body.statement.statementHash) throw new Error('Statement hash is missing.');
  if (!body.transactions.length) throw new Error('There are no transactions to save.');
}

function statementProperties(statement) {
  return {
    'Statement Name': { title: title(statement.name) },
    'Statement Type': { select: statement.type ? { name: statement.type } : null },
    'Start Date': { date: date(statement.startDate) },
    'End Date': { date: date(statement.endDate) },
    'Total Spent': { number: number(statement.totalSpent) },
    'Total Received': { number: number(statement.totalReceived) },
    'Net Amount': { number: number(statement.netAmount) },
    'Transaction Count': { number: number(statement.transactionCount) },
    'Statement Hash': { rich_text: richText(statement.statementHash) }
  };
}

function transactionProperties(tx) {
  return {
    'Transaction': { title: title(tx.name) },
    'Date': { date: date(tx.date) },
    'Transaction ID': { rich_text: richText(tx.transactionId) },
    'Remarks': { rich_text: richText(tx.remarks) },
    'Category': { select: tx.category ? { name: tx.category } : null },
    'Type': { select: tx.type ? { name: tx.type } : null },
    'Amount': { number: number(tx.amount) },
    'Balance': { number: number(tx.balance) },
    'Statement Hash': { rich_text: richText(tx.statementHash) }
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    validatePayload(req.body);

    const token = process.env.NOTION_TOKEN;
    const statementsDb = process.env.NOTION_STATEMENTS_DATABASE_ID;
    const transactionsDb = process.env.NOTION_TRANSACTIONS_DATABASE_ID;

    if (!token || !statementsDb || !transactionsDb) {
      return res.status(500).json({
        error: 'Notion backend is not configured. Add the three required Vercel environment variables.'
      });
    }

    const notion = new Client({ auth: token });
    const hash = req.body.statement.statementHash;

    // Duplicate check: one statement hash should only exist once.
    const existing = await notion.databases.query({
      database_id: statementsDb,
      filter: {
        property: 'Statement Hash',
        rich_text: { equals: hash }
      },
      page_size: 1
    });

    if (existing.results && existing.results.length) {
      return res.status(200).json({
        duplicate: true,
        statementId: existing.results[0].id,
        savedTransactions: 0
      });
    }

    const statementPage = await notion.pages.create({
      parent: { database_id: statementsDb },
      properties: statementProperties(req.body.statement)
    });

    // Create transactions in small concurrent batches to avoid aggressive bursts.
    const transactions = req.body.transactions;
    const BATCH_SIZE = 5;
    let saved = 0;

    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map((tx) => notion.pages.create({
          parent: { database_id: transactionsDb },
          properties: transactionProperties(tx)
        }))
      );
      saved += results.length;
    }

    return res.status(200).json({
      duplicate: false,
      statementId: statementPage.id,
      savedTransactions: saved
    });
  } catch (error) {
    console.error('Notion save failed:', error);
    return res.status(500).json({
      error: error && error.message ? error.message : 'Unable to save data to Notion.'
    });
  }
};
