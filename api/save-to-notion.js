const NOTION_VERSION = '2022-06-28';

function title(text){ return { title:[{type:'text',text:{content:String(text||'Untitled').slice(0,2000)}}]}; }
function rich(text){ return { rich_text: text ? [{type:'text',text:{content:String(text).slice(0,2000)}}] : []}; }
function number(value){ return { number: Number.isFinite(Number(value)) ? Number(value) : null }; }
function date(value){ return { date: value ? {start:value} : null }; }
function select(name){ return { select: name ? {name} : null }; }
function multi(name){ return { multi_select: name ? [{name}] : [] }; }
function relation(id){ return { relation: id ? [{id}] : [] }; }

async function notion(path, options={}){
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers:{
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.message || `Notion API error (${res.status})`);
  return data;
}

function monthLabel(iso){
  if(!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if(Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US',{month:'short',year:'2-digit'}); // e.g. Aug 26
}

async function queryDatabase(databaseId, filter){
  return notion(`/databases/${databaseId}/query`, {method:'POST', body:JSON.stringify({filter,page_size:100})});
}

async function findByTitle(databaseId, property, value){
  const result = await queryDatabase(databaseId,{property, title:{equals:value}});
  return result.results?.[0] || null;
}

async function findBudget(category){
  if(!process.env.NOTION_BUDGET_DATABASE_ID || !category) return null;
  const candidates=[category, category.replace(' & ',' and '), category.replace('Fuel & Transport','Transport')];
  for(const c of candidates){
    const found=await findByTitle(process.env.NOTION_BUDGET_DATABASE_ID,'Budget',c).catch(()=>null);
    if(found) return found;
  }
  return null;
}

async function findMonth(month){
  if(!process.env.NOTION_MONTH_DATABASE_ID || !month) return null;
  return findByTitle(process.env.NOTION_MONTH_DATABASE_ID,'Month',month);
}

function incomeType(tx){
  const text=`${tx.category||''} ${tx.name||''} ${tx.remarks||''}`.toLowerCase();
  if(text.includes('salary')) return 'Salary';
  if(text.includes('refund') || text.includes('reversal')) return 'Refund';
  return 'Other';
}

export default async function handler(req,res){
  if(req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const {statement,transactions=[]}=req.body||{};
    if(!statement?.statementHash || !Array.isArray(transactions) || !transactions.length)
      return res.status(400).json({error:'Missing statement or transactions'});

    const statementsDb=process.env.NOTION_STATEMENTS_DATABASE_ID;
    const expensesDb=process.env.NOTION_EXPENSES_DATABASE_ID;
    const incomesDb=process.env.NOTION_INCOMES_DATABASE_ID;
    if(!statementsDb || !expensesDb || !incomesDb)
      throw new Error('Missing Notion database environment variables');

    const existing=await queryDatabase(statementsDb,{property:'Statement Hash',rich_text:{equals:statement.statementHash}});
    if(existing.results?.length) return res.status(200).json({duplicate:true});

    await notion('/pages',{method:'POST',body:JSON.stringify({
      parent:{database_id:statementsDb},
      properties:{
        'Statement Name':title(statement.name),
        'Statement Type':select(statement.type),
        'Start Date':date(statement.startDate),
        'End Date':date(statement.endDate),
        'Total Spent':number(statement.totalSpent),
        'Total Received':number(statement.totalReceived),
        'Net Amount':number(statement.netAmount),
        'Transaction Count':number(statement.transactionCount),
        'Statement Hash':rich(statement.statementHash)
      }
    })});

    let savedExpenses=0, savedIncomes=0;
    for(const tx of transactions){
      const month=monthLabel(tx.date);
      const monthPage=await findMonth(month).catch(()=>null);
      if(tx.type==='Received'){
        const properties={
          'Income':title(tx.name||tx.remarks),
          'Date':date(tx.date),
          'Amount':number(tx.amount),
          'Type':select(incomeType(tx)),
          'Pay':multi('Bank')
        };
        if(monthPage) properties['Month Classification']=relation(monthPage.id);
        await notion('/pages',{method:'POST',body:JSON.stringify({parent:{database_id:incomesDb},properties})});
        savedIncomes++;
      }else{
        const properties={
          'Expense':title(tx.name||tx.remarks),
          'Date':date(tx.date),
          'Amount':number(tx.amount),
          'Pay':multi('Bank')
        };
        if(monthPage) properties['Month Classification']=relation(monthPage.id);
        const budget=await findBudget(tx.category).catch(()=>null);
        if(budget) properties['Budget']=relation(budget.id);
        await notion('/pages',{method:'POST',body:JSON.stringify({parent:{database_id:expensesDb},properties})});
        savedExpenses++;
      }
    }

    return res.status(200).json({duplicate:false,savedTransactions:savedExpenses+savedIncomes,savedExpenses,savedIncomes});
  }catch(err){
    console.error(err);
    return res.status(500).json({error:err.message||'Unable to save to Notion'});
  }
}
