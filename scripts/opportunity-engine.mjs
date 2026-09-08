import fs from 'node:fs';

const path='src/both.jsx';
let s=fs.readFileSync(path,'utf8');

const constant="const CONTINUOUS_OPPORTUNITY_V1={candidateCandles:100,maxOpen:3,minEdge:1.35,scanMs:15000};";

// Repair a previously generated malformed opportunity effect before any further patching.
if(s.includes('openBestOpportunity')&&!s.includes('CONTINUOUS_OPPORTUNITY_V1')){
  s=s.replace("const API='https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures',CANDLE='https://api.india.delta.exchange/v2/history/candles',START=10000;", "$&\n"+constant);
}
const dangling=";autoOpen('scalp',sp,setSp)},[rows,paper,capital,risk,mt.length,st.length,lossBlocks]);";
if(s.includes(dangling)){
  s=s.replace(dangling,';');
  fs.writeFileSync(path,s);
  console.log('Repaired malformed opportunity effect');
  process.exit(0);
}

if(s.includes('CONTINUOUS_OPPORTUNITY_V1')){console.log('Opportunity engine already patched');process.exit(0)}

s=s.replace("const API='https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures',CANDLE='https://api.india.delta.exchange/v2/history/candles',START=10000;", "const API='https://api.india.delta.exchange/v2/tickers?contract_types=perpetual_futures',CANDLE='https://api.india.delta.exchange/v2/history/candles',START=10000;\n"+constant)

s=s.replace(".sort((a,b)=>Math.abs(b.change)-Math.abs(a.change)).slice(0,50);", ".sort((a,b)=>Math.abs(b.change)-Math.abs(a.change)).slice(0,100);")

const start=s.indexOf('function autoOpen(engine,list,setList){');
if(start<0)throw new Error('autoOpen function not found');
const effect=s.indexOf("useEffect(()=>{autoOpen('momentum',mp,setMp);autoOpen('scalp',sp,setSp)}",start);
if(effect<0)throw new Error('autoOpen effect not found');
const end=s.indexOf(';',effect)+1;
if(end<=effect)throw new Error('autoOpen effect terminator not found');

const replacement=`function openBestOpportunity(){if(!paper)return;const openCount=mp.length+sp.length;if(openCount>=CONTINUOUS_OPPORTUNITY_V1.maxOpen)return;const now=Date.now();const candidates=[];rows.forEach(r=>{for(const engine of ['momentum','scalp']){const sig=r[engine];if(!sig||!['BUY','SELL'].includes(sig.signal))continue;const cfg=CFG[engine],desiredSide=sig.signal==='BUY'?'LONG':'SHORT',key=r.symbol+':'+sig.signal,blockedUntil=num(lossBlocks[r.symbol+':'+desiredSide]);const last=seen.current[engine].get(key)||0;if(now<blockedUntil||now-last<cfg.cool)continue;if(mp.concat(sp).some(p=>p.symbol===r.symbol&&p.side===desiredSide))continue;const entry=priceOf(r);if(entry<=0)continue;const riskAmt=entry*cfg.sl,qty=(capital*risk/100)/riskAmt;if(qty<=0)continue;const notional=entry*qty,estimatedCosts=feeOnNotional(notional*2)+(notional*2)*LIVE_COSTS_V1.slippagePerSide,expectedGross=2*riskAmt*qty,edge=expectedGross/Math.max(estimatedCosts,0.01);if(edge<CONTINUOUS_OPPORTUNITY_V1.minEdge)continue;const rank=sig.score+Math.min(Math.abs(num(r.change))*2,10)+Math.min(Math.max(num(sig.spike),0)*2,10)+(num(r.volume)>5000000?5:0);candidates.push({r,engine,cfg,sig,desiredSide,key,rank,edge});}});candidates.sort((a,b)=>b.rank-a.rank||b.edge-a.edge);const best=candidates[0];if(!best)return;const{r,engine,cfg,sig,desiredSide,key}=best;const setList=engine==='momentum'?setMp:setSp;setList(p=>{if(p.length>=CONTINUOUS_OPPORTUNITY_V1.maxOpen||p.some(x=>x.symbol===r.symbol))return p;if(mp.concat(sp).some(x=>x.symbol===r.symbol&&x.side===desiredSide))return p;const entry=priceOf(r);if(entry<=0)return p;const sl=sig.signal==='BUY'?entry*(1-cfg.sl):entry*(1+cfg.sl),riskAmt=Math.abs(entry-sl),tp1=sig.signal==='BUY'?entry+riskAmt:entry-riskAmt,finalTp=sig.signal==='BUY'?entry+2*riskAmt:entry-2*riskAmt;seen.current[engine].set(key,now);return[...p,{symbol:r.symbol,engine,side:desiredSide,entry,qty:(capital*risk/100)/riskAmt,initialSL:sl,risk:riskAmt,sl,tp1,finalTp,lockSL:sig.signal==='BUY'?entry+riskAmt*cfg.lockR:entry-riskAmt*cfg.lockR,current:entry,pnl:0,stage:0,highest:entry,lowest:entry,trailDist:0,lockR:cfg.lockR,openedAt:new Date().toISOString(),signalScore:sig.score,signalReason:sig.reason,status:'INITIAL SL · COST FILTER PASSED'}]});}\nuseEffect(()=>{openBestOpportunity()},[rows,paper,capital,risk,mp.length,sp.length,lossBlocks]);`;
s=s.slice(0,start)+replacement+s.slice(end);

fs.writeFileSync(path,s);
console.log('Continuous opportunity engine patched');