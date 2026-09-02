# Ledger → Budget & Finance Tracker

This version saves directly into your existing Notion databases:

- Expenses
- Incomes
- Month Classification (for relations)
- Budget (for expense category relations)

## Vercel Environment Variables

- `NOTION_TOKEN`
- `NOTION_EXPENSES_DATA_SOURCE_ID`
- `NOTION_INCOMES_DATA_SOURCE_ID`
- `NOTION_MONTH_DATA_SOURCE_ID`
- `NOTION_BUDGET_DATA_SOURCE_ID`

`Ledger Statements` and `Ledger Transactions` are no longer used by the backend.

## Improvements

- Direct save to Expenses and Incomes only
- Transaction-level duplicate prevention, including safe retry after partial saves
- UPI narration cleanup: `UPIAR/.../DR/ZARIVAUL/YESB/paytm-14676198` becomes `ZARIVAUL/YESB/paytm-14676198`
- Save button loading state retained
- Notion rate-limit retry retained
- CSV export removed
