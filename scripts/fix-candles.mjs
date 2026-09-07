import fs from 'node:fs';

const path = 'src/both.jsx';
let s = fs.readFileSync(path, 'utf8');
const start = s.indexOf('async function candles(');
const end = s.indexOf('function atr(', start);
if (start < 0 || end < 0) throw new Error('Could not locate candles() function in src/both.jsx');

const replacement = `async function candles(symbol,res,count){
  const sec=res==='1m'?60:res==='5m'?300:900;
  const request=async(windowCount)=>{
    const end=Math.floor(Date.now()/1000);
    const start=end-sec*(windowCount+5);
    const url=CANDLE+'?resolution='+res+'&symbol='+encodeURIComponent(symbol)+'&start='+start+'&end='+end;
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),9000);
    try{
      const r=await fetch(url,{cache:'no-store',signal:ctrl.signal});
      if(!r.ok)throw Error('Candle HTTP '+r.status);
      const j=await r.json();
      const data=Array.isArray(j.result)?j.result:[];
      return data.sort((a,b)=>num(a.time)-num(b.time));
    }finally{clearTimeout(timer)}
  };
  let lastErr;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const data=await request(count);
      if(data.length>=Math.min(6,count))return data;
      lastErr=Error('Empty/incomplete candle response');
    }catch(e){lastErr=e}
    await new Promise(r=>setTimeout(r,250*(attempt+1)));
  }
  throw lastErr||Error('Candle data unavailable');
}
`;

s=s.slice(0,start)+replacement+s.slice(end);

// Never leave a coin stuck at the old pending state. Failed candle batches
// become an explicit retry state and the next 15s scan gets another chance.
s=s.replaceAll('Candle analysis pending','Loading candle data…');
s=s.replace('if(k<0||!ds[k])return row;',"if(k<0)return row;if(!ds[k])return{...row,momentum:{...row.momentum,reason:'Candle unavailable · next scan'},scalp:{...row.scalp,reason:'Candle unavailable · next scan'}};");

fs.writeFileSync(path,s);
console.log('Candle loader + non-stuck fallback patched successfully');
