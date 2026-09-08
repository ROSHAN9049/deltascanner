import fs from 'node:fs';

const path='src/both.jsx';
let s=fs.readFileSync(path,'utf8');

const marker='CONTINUOUS_OPPORTUNITY_V4';
const start=s.indexOf('function autoOpen(');
const end=s.indexOf('const stats=',start);

if(start>=0&&end>start){
const replacement=`const ${marker}={maxOpen:10};
function openBestOpportunity(){
  if(!paper)return;
  const open=mp.concat(sp),openSymbols=new Set(open.map(p=>p.symbol));
  if(open.length>=${marker}.maxOpen)return;
  const now=Date.now(),candidates=[];
  rows.forEach(r=>{
    for(const engine of ['momentum','scalp']){
      const sig=r[engine];
      if(!sig||!['BUY','SELL'].includes(sig.signal)||openSymbols.has(r.symbol))continue;
      const cfg=CFG[engine],key=r.symbol+':'+sig.signal,last=seen.current[engine].get(key)||0;
      if(now-last<cfg.cool)continue;
      const entry=priceOf(r);
      if(entry<=0)continue;
      const rank=num(sig.score)+Math.min(Math.abs(num(r.change))*2,10)+Math.min(Math.max(num(sig.spike)-cfg.minSpike,0)*3,10);
      candidates.push({r,engine,cfg,sig,key,entry,rank});
    }
  });
  candidates.sort((a,b)=>b.rank-a.rank);
  const best=candidates[0];
  if(!best)return;
  const{r,engine,cfg,sig,key,entry}=best,setList=engine==='momentum'?setMp:setSp;
  setList(p=>{
    if(p.length>=cfg.max||p.some(x=>x.symbol===r.symbol)||mp.concat(sp).some(x=>x.symbol===r.symbol)||mp.concat(sp).length>=${marker}.maxOpen)return p;
    const sl=sig.signal==='BUY'?entry*(1-cfg.sl):entry*(1+cfg.sl),riskAmt=Math.abs(entry-sl);
    if(riskAmt<=0)return p;
    const tp1=sig.signal==='BUY'?entry+riskAmt:entry-riskAmt,finalTp=sig.signal==='BUY'?entry+cfg.tp*riskAmt:entry-cfg.tp*riskAmt;
    const lockSL=sig.signal==='BUY'?entry+riskAmt*cfg.lockR:entry-riskAmt*cfg.lockR,qty=(capital*risk/100)/riskAmt;
    if(!Number.isFinite(qty)||qty<=0)return p;
    seen.current[engine].set(key,now);
    return[...p,{symbol:r.symbol,engine,side:sig.signal==='BUY'?'LONG':'SHORT',entry,qty,initialSL:sl,risk:riskAmt,sl,tp1,finalTp,lockSL,current:entry,pnl:0,stage:0,highest:entry,lowest:entry,trailDist:0,lockR:cfg.lockR,openedAt:new Date().toISOString(),signalScore:sig.score,signalReason:sig.reason,status:'INITIAL SL · CONTINUOUS OPPORTUNITY'}];
  });
}
useEffect(()=>{openBestOpportunity()},[rows,paper,capital,risk,mp.length,sp.length,mt.length,st.length]);
`;
  s=s.slice(0,start)+replacement+s.slice(end);
}

// Keep only the latest 10 closed trades in each engine history.
s=s.replace(/\[\.\.\.closed,\.\.\.t\]\.slice\(0,100\)/g,'[...closed,...t].slice(0,10)');

// Trim persisted histories immediately and keep them capped.
const statsMarker='const stats=';
const statsPos=s.indexOf(statsMarker);
if(statsPos>=0&&!s.includes('HISTORY_LIMIT_10')){
  const trim=`const HISTORY_LIMIT_10=10;useEffect(()=>{if(mt.length>HISTORY_LIMIT_10)setMt(x=>x.slice(0,HISTORY_LIMIT_10));if(st.length>HISTORY_LIMIT_10)setSt(x=>x.slice(0,HISTORY_LIMIT_10))},[mt.length,st.length]);\n`;
  s=s.slice(0,statsPos)+trim+s.slice(statsPos);
}

// Cap the visible combined Trade History to the newest 10 rows.
const allTradesRe=/const allTrades=useMemo\(\(\)=>\[(\.\.\.mt\.map\(x=>\(\{\.\.\.x,engine:'MOMENTUM'\}\)\)),(\.\.\.st\.map\(x=>\(\{\.\.\.x,engine:'SCALPING'\}\))\)\]\.sort\(\(x,y\)=>new Date\(y\.closedAt\|\|y\.openedAt\)-new Date\(x\.closedAt\|\|x\.openedAt\),\[mt,st\]\);/;
if(allTradesRe.test(s)){
  s=s.replace(allTradesRe,(m,a,b)=>`const allTrades=useMemo(()=>[${a},${b}].sort((x,y)=>new Date(y.closedAt||y.openedAt)-new Date(x.closedAt||x.openedAt)).slice(0,10),[mt,st]);`);
}

fs.writeFileSync(path,s);
console.log('Momentum/Scalping histories capped at 10; combined visible history capped at latest 10');
