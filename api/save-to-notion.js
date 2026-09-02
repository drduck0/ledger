const NOTION_VERSION = '2025-09-03';

const env = (name) => process.env[name] || process.env[name.replace('_DATA_SOURCE_ID','_DATABASE_ID')];

function title(text){ return { title:[{type:'text',text:{content:String(text||'Untitled').slice(0,2000)}}]}; }
function number(value){ const n=Number(value); return { number:Number.isFinite(n)?n:null }; }
function date(value){ return { date:value?{start:value}:null }; }
function select(name){ return { select:name?{name}:null }; }
function multi(name){ return { multi_select:name?[{name}]:[] }; }
function relation(id){ return { relation:id?[{id}]:[] }; }
function rich(text){ return { rich_text:text?[{type:'text',text:{content:String(text).slice(0,2000)}}]:[] }; }

async function notion(path, options={}){
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers:{
      Authorization:`Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version':NOTION_VERSION,
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.message || `Notion API error (${res.status})`);
  return data;
}

async function querySource(id, filter){
  return notion(`/data_sources/${id}/query`, {method:'POST',body:JSON.stringify({filter,page_size:100})});
}

async function findByTitle(sourceId, property, value){
  if(!sourceId || !value) return null;
  const result=await querySource(sourceId,{property,title:{equals:value}});
  return result.results?.[0]||null;
}

function monthCandidates(iso){
  if(!iso) return [];
  const d=new Date(`${iso}T00:00:00`);
  if(Number.isNaN(d.getTime())) return [];
  const month=d.toLocaleString('en-US',{month:'short'});
  const full=d.toLocaleString('en-US',{month:'long'});
  const yy=String(d.getFullYear()).slice(-2), yyyy=String(d.getFullYear());
  return [`${month} ${yy}`,`${month} ${yyyy}`,`${full} ${yyyy}`,`${yyyy}-${String(d.getMonth()+1).padStart(2,'0')}`];
}

async function findMonth(iso){
  const source=env('NOTION_MONTH_DATA_SOURCE_ID');
  for(const candidate of monthCandidates(iso)){
    for(const property of ['Month','Name','Month Classification']){
      try { const found=await findByTitle(source,property,candidate); if(found) return found; } catch {}
    }
  }
  return null;
}

const CATEGORY_ALIASES={
  'Fuel & Transport':['Fuel & Transport','Transport','Fuel'],
  'Travel & Transport':['Travel & Transport','Transport','Travel'],
  'Subscriptions & Software':['Subscriptions & Software','Subscriptions','Software'],
  'Health & Personal Care':['Health & Personal Care','Health','Personal Care'],
  'Investment (SIP)':['Investment (SIP)','Investment','SIP'],
  'Bank Transfer / Loan EMI':['Bank Transfer / Loan EMI','Loan EMI','EMI'],
  'Card Fees & Taxes':['Card Fees & Taxes','Fees','Taxes'],
  'Wallet Load / Transfer':['Wallet Load / Transfer','Transfer','Wallet Load']
};

async function findBudget(category){
  const source=env('NOTION_BUDGET_DATA_SOURCE_ID');
  const candidates=CATEGORY_ALIASES[category]||[category];
  for(const candidate of candidates){
    try { const found=await findByTitle(source,'Categories',candidate); if(found) return found; } catch {}
  }
  return null;
}

function incomeType(tx){
  const text=`${tx.category||''} ${tx.name||''} ${tx.remarks||''}`.toLowerCase();
  if(text.includes('salary')) return 'Salary';
  if(text.includes('refund')||text.includes('reversal')) return 'Refund';
  return 'Other';
}

async function createPage(dataSourceId, properties){
  return notion('/pages',{method:'POST',body:JSON.stringify({parent:{type:'data_source_id',data_source_id:dataSourceId},properties})});
}

export default async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  try{
    const {statement,transactions=[]}=req.body||{};
    if(!statement?.statementHash || !Array.isArray(transactions) || !transactions.length)
      return res.status(400).json({error:'Missing statement or transactions'});

    const statements=env('NOTION_STATEMENTS_DATA_SOURCE_ID');
    const expenses=env('NOTION_EXPENSES_DATA_SOURCE_ID');
    const incomes=env('NOTION_INCOMES_DATA_SOURCE_ID');
    if(!statements||!expenses||!incomes) throw new Error('Missing required Notion data source environment variables');

    const existing=await querySource(statements,{property:'Statement Hash',rich_text:{equals:statement.statementHash}});
    if(existing.results?.length) return res.status(200).json({duplicate:true,message:'This statement has already been saved.'});

    await createPage(statements,{
      'Statement Name':title(statement.name),
      'Statement Type':select(statement.type),
      'Start Date':date(statement.startDate),
      'End Date':date(statement.endDate),
      'Total Spent':number(statement.totalSpent),
      'Total Received':number(statement.totalReceived),
      'Net Amount':number(statement.netAmount),
      'Transaction Count':number(statement.transactionCount),
      'Statement Hash':rich(statement.statementHash)
    });

    let savedExpenses=0,savedIncomes=0,unlinkedMonths=0,unlinkedBudgets=0;
    for(const tx of transactions){
      const monthPage=await findMonth(tx.date);
      if(!monthPage) unlinkedMonths++;
      if(tx.type==='Received'){
        const properties={
          'Income':title(tx.name||tx.remarks||'Income'),
          'Date':date(tx.date),
          'Amount':number(tx.amount),
          'Type':select(incomeType(tx)),
          'Pay':multi('Bank')
        };
        if(monthPage) properties['Month Classification']=relation(monthPage.id);
        await createPage(incomes,properties); savedIncomes++;
      } else {
        const properties={
          'Expense':title(tx.name||tx.remarks||'Expense'),
          'Date':date(tx.date),
          'Amount':number(tx.amount),
          'Pay':multi('Bank')
        };
        if(monthPage) properties['Month Classification']=relation(monthPage.id);
        const budget=await findBudget(tx.category);
        if(budget) properties['Budget']=relation(budget.id); else unlinkedBudgets++;
        await createPage(expenses,properties); savedExpenses++;
      }
    }
    return res.status(200).json({duplicate:false,savedTransactions:savedExpenses+savedIncomes,savedExpenses,savedIncomes,unlinkedMonths,unlinkedBudgets});
  }catch(err){
    console.error(err);
    return res.status(500).json({error:err.message||'Unable to save to Notion'});
  }
}
