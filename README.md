# Ledger → Budget & Finance Tracker (Vercel)

## Environment Variables

Use these exact names:

- `NOTION_TOKEN`
- `NOTION_STATEMENTS_DATA_SOURCE_ID`
- `NOTION_EXPENSES_DATA_SOURCE_ID`
- `NOTION_INCOMES_DATA_SOURCE_ID`
- `NOTION_MONTH_DATA_SOURCE_ID`
- `NOTION_BUDGET_DATA_SOURCE_ID`

The backend uses Notion's current Data Sources API.

For compatibility, the backend also accepts the older `*_DATABASE_ID` names, but the `*_DATA_SOURCE_ID` names are recommended.

## Important

Share every relevant Notion database/data source with the same Notion integration used by `NOTION_TOKEN`.

The backend:
- prevents duplicate statements using `Statement Hash`
- sends spending to Expenses
- sends received transactions to Incomes
- attempts to link each transaction to Month Classification
- attempts to link expenses to Budget categories
