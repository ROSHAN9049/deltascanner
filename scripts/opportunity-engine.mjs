import fs from 'node:fs';

const path = 'src/both.jsx';
let s = fs.readFileSync(path, 'utf8');

const marker = 'const CONTINUOUS_OPPORTUNITY_V2=';
if (s.includes(marker)) {
  console.log('Continuous opportunity engine already present; source unchanged');
  process.exit(0);
}

const apiNeedle = "const API='https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures',CANDLE='https://api.india.delta.exchange/v2/history/candles',START=10000;";
if (!s.includes(apiNeedle)) throw new Error('Delta API constants not found');
s = s.replace(apiNeedle, apiNeedle + "\nconst CONTINUOUS_OPPORTUNITY_V2={maxOpen:3,scanMs:15000};");
s = s.replace(".sort((a,b)=>Math.abs(b.change)-Math.abs(a.change)).slice(0,50);", ".sort((a,b)=>Math.abs(b.change)-Math.abs(a.change)).slice(0,100);");

const re = /function autoOpen\(engine,list,setList\)\{[\s\S]*?\}\nuseEffect\(\(\)=>\{autoOpen\('momentum',mp,setMp\);autoOpen\('scalp',sp,setSp\)\},\[rows,paper,capital,risk,mt\.length,st\.length\]\);/;
if (!re.test(s)) throw new Error('Clean autoOpen block not found; source was not modified');

const replacement = `function openBestOpportunity(){if(!paper)return;const openCount=mp.length+sp.length;if(openCount>=CONTINUOUS_OPPORTUNITY_V2.maxOpen)return;const now=Date.now(),openSymbols=new Set(mp.concat(sp).map(p=>p.symbol)),candidates=[];rows.forEach(r=>{for(const engine of ['momentum','scalp']){const sig=r[engine];if(!sig||!['BUY','SELL'].includes(sig.signal))continue;const cfg=CFG[engine],key=r.symbol+':'+sig.signal,last=seen.current[engine].get(key)||0;if(now-last<cfg.cool||openSymbols.has(r.symbol))continue;const entry=priceOf(r);if(entry<=0)continue;const riskAmt=entry*cfg.sl,qty=(capital*risk/100)/riskAmt;if(qty<=0)continue;const rank=sig.score+Math.min(Math.abs(num(r.change))*2,10)+Math.min(Math.max(num(sig.spike)-cfg.minSpike,0)*3,10);candidates.push({r,engine,cfg,sig,rank,key});}});candidates.sort((a,b)=>b.rank-a.rank);const best=candidates[0];if(!best)return;const{r,engine,cfg,sig,key}=best,setList=engine==='momentum'?setMp:setSp;setList(p=>{if(p.length>=3||p.some(x=>x.symbol===r.symbol)||mp.concat(sp).some(x=>x.symbol===r.symbol))return p;const entry=priceOf(r);if(entry<=0)return p;const sl=sig.signal==='BUY'?entry*(1-cfg.sl):entry*(1+cfg.sl),riskAmt=Math.abs(entry-sl),tp1=sig.signal==='BUY'?entry+riskAmt:entry-riskAmt,finalTp=sig.signal==='BUY'?entry+2*riskAmt:entry-2*riskAmt,lockSL=sig.signal==='BUY'?entry+riskAmt*cfg.lockR:entry-riskAmt*cfg.lockR,qty=(capital*risk/100)/riskAmt;seen.current[engine].set(key,now);return[...p,{symbol:r.symbol,engine,side:sig.signal==='BUY'?'LONG':'SHORT',entry,qty,initialSL:sl,risk:riskAmt,sl,tp1,finalTp,lockSL,current:entry,pnl:0,stage:0,highest:entry,lowest:entry,trailDist:0,lockR:cfg.lockR,openedAt:new Date().toISOString(),signalScore:sig.score,signalReason:sig.reason,status:'INITIAL SL · CONTINUOUS OPPORTUNITY'}]})}
useEffect(()=>{openBestOpportunity()},[rows,paper,capital,risk,mp.length,sp.length,mt.length,st.length]);`;

s = s.replace(re, replacement);
fs.writeFileSync(path, s);
console.log('Continuous opportunity engine V2 patched safely');
