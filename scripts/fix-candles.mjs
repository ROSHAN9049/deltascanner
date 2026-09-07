import fs from 'node:fs';

const path = 'src/both.jsx';
let s = fs.readFileSync(path, 'utf8');

const start = s.indexOf('async function candles(');
const end = s.indexOf('function atr(', start);

if (start < 0 || end < 0) {
  throw new Error('Could not locate candles() function in src/both.jsx');
}

const replacement = `async function candles(symbol,res,count){\n  const sec=res==='1m'?60:res==='5m'?300:900;\n  const request=async(windowCount)=>{\n    const end=Math.floor(Date.now()/1000);\n    const start=end-sec*(windowCount+5);\n    const url=\`${CANDLE}?resolution=\${res}&symbol=\${encodeURIComponent(symbol)}&start=\${start}&end=\${end}\`;\n    const ctrl=new AbortController();\n    const timer=setTimeout(()=>ctrl.abort(),9000);\n    try{\n      const r=await fetch(url,{cache:'no-store',signal:ctrl.signal});\n      if(!r.ok)throw Error('Candle HTTP '+r.status);\n      const j=await r.json();\n      const data=Array.isArray(j.result)?j.result:[];\n      return data.sort((a,b)=>num(a.time)-num(b.time));\n    }finally{clearTimeout(timer)}\n  };\n  let lastErr;\n  for(let attempt=0;attempt<3;attempt++){\n    try{\n      const data=await request(count);\n      if(data.length>=Math.min(6,count))return data;\n      lastErr=Error('Empty/incomplete candle response');\n    }catch(e){lastErr=e}\n    await new Promise(r=>setTimeout(r,250*(attempt+1)));\n  }\n  throw lastErr||Error('Candle data unavailable');\n}\n`;

s = s.slice(0,start) + replacement + s.slice(end);
fs.writeFileSync(path,s);
console.log('Candle loader patched successfully');
