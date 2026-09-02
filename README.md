# Ledger → Notion

## Deploy on Vercel

Set these Environment Variables:

- `NOTION_TOKEN`
- `NOTION_STATEMENTS_DATA_SOURCE_ID`
- `NOTION_EXPENSES_DATA_SOURCE_ID`
- `NOTION_INCOMES_DATA_SOURCE_ID`
- `NOTION_MONTH_DATA_SOURCE_ID`
- `NOTION_BUDGET_DATA_SOURCE_ID`

## Changes in this version

- Automatic retry/backoff for Notion HTTP 429 rate limits
- 420ms pacing between transaction writes
- Save button shows a loading spinner and cannot be clicked twice while saving
- Export CSV removed
- Statement record is created only after all transaction writes finish
