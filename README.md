# Ledger → Notion

This folder is ready to deploy to Vercel.

## What it does
- Parses bank/credit-card PDFs locally in the browser.
- Sends data to Notion only when **Save to Notion** is clicked.
- Generates a SHA-256 statement fingerprint in the browser.
- Prevents duplicate statement saves using `Statement Hash`.
- Saves one statement record and all extracted transactions.
- Keeps the Notion secret on Vercel, never in `index.html`.

## Deploy to Vercel

1. Create a GitHub repository and upload this folder, or import the folder into a Vercel project.
2. In Vercel → Project → Settings → Environment Variables, add:

   - `NOTION_TOKEN`
   - `NOTION_STATEMENTS_DATABASE_ID`
   - `NOTION_EXPENSES_DATABASE_ID
   - `NOTION_INCOMES_DATABASE_ID`
   - `NOTION_MONTH_DATABASE_ID`
   - `NOTION_BUDGET_DATABASE_ID`
   - `NOTION_TRANSACTIONS_DATABASE_ID``

3. Deploy.

The frontend calls `/api/save-to-notion`, so no frontend URL changes are needed when deployed together on the same Vercel project.

## Notion database IDs

The databases created for Ledger use these IDs:

- Statements: `54c4d8e951ca4662beb6f832ff382e60`
- Transactions: `1962547022bc4929af284f6ee41f39fa`

## Important

The Notion integration token used by the connected ChatGPT Notion MCP cannot be embedded or automatically transferred to your public website. Create/use a Notion integration for the deployed app and add its secret only as a Vercel environment variable.

Share both Ledger databases with that integration before testing.

## Local testing

Install dependencies:

```bash
npm install
```

For easiest testing, deploy to Vercel because the app is designed around a Vercel serverless function at `/api/save-to-notion`.


## New finance tracker integration
The backend now routes Ledger data directly into the existing Budget & Finance Tracker:
- Spent → Expenses
- Received → Incomes
- Transactions are linked to Month Classification when the matching month exists.
- Expenses are linked to Monthly Budget categories when a matching budget page is found.
- Ledger Statements remains the duplicate-prevention audit record.

Set these Vercel variables:
- NOTION_TOKEN
- NOTION_STATEMENTS_DATABASE_ID
- NOTION_EXPENSES_DATABASE_ID
- NOTION_INCOMES_DATABASE_ID
- NOTION_MONTH_DATABASE_ID
- NOTION_BUDGET_DATABASE_ID
