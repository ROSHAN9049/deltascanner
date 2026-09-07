import fs from 'node:fs';

const path='src/both.jsx';
let s=fs.readFileSync(path,'utf8');
if(s.includes('DUAL_RISK_GUARDS_V1')){console.log('Risk guards already patched');process.exit(0)}

s=s.replace("const CFG={momentum:{entry:'5m',confirm:'15m',sl:.01,tp:2,minSpike:2,minScore:75,minChange:2,cool:9e5,max:5,lockR:.25,trailMult:1.5,trailMin:.5,trailMax:1.2},scalp:{entry:'1m',confirm:'5m',sl:.005,tp:2,minSpike:2,minScore:80,minChange:.5,cool:3e5,max:10,lockR:.2,trailMult:1,trailMin:.5,trailMax:1}};", "const CFG={momentum:{entry:'5m',confirm:'15m',sl:.01,tp:2,minSpike:2,minScore:75,minChange:2,cool:9e5,max:5,lockR:.25,trailMult:1.5,trailMin:.5,trailMax:1.2},scalp:{entry:'1m',confirm:'5m',sl:.005,tp:2,minSpike:2,minScore:80,minChange:.5,cool:3e5,max:10,lockR:.2,trailMult:1,trailMin:.5,trailMax:1}};\nconst DUAL_RISK_GUARDS_V1={scalpLossBlockMs:15*60*1000,momentumLossBlockMs:30*60*1000};")

const stateAnchor="[search,setSearch]=useState(''),[side,setSide]=useState('ALL'),[sort,setSort]=useState('score'),[minVol,setMinVol]=useState(100000);";
if(!s.includes(stateAnchor))throw new Error('state anchor not found');
s=s.replace(stateAnchor,"[search,setSearch]=useState(''),[side,setSide]=useState('ALL'),[sort,setSort]=useState('score'),[minVol,setMinVol]=useState(100000),[lossBlocks,setLossBlocks]=useState(()=>{try{return JSON.parse(localStorage.getItem('dual-loss-blocks')||'{}')}catch{return{}}});");

const effectAnchor="useEffect(()=>localStorage.setItem('dual-paper-on',paper?'1':'0'),[paper]);useEffect(()=>localStorage.setItem('dual-capital',capital),[capital]);useEffect(()=>localStorage.setItem('dual-risk',risk),[risk]);useEffect(()=>localStorage.setItem('dual-momentum-pos',JSON.stringify(mp)),[mp]);useEffect(()=>localStorage.setItem('dual-scalp-pos',JSON.stringify(sp)),[sp]);useEffect(()=>localStorage.setItem('dual-momentum-trades',JSON.stringify(mt)),[mt]);useEffect(()=>localStorage.setItem('dual-scalp-trades',JSON.stringify(st)),[st]);";
if(!s.includes(effectAnchor))throw new Error('effects anchor not found');
s=s.replace(effectAnchor,effectAnchor+"useEffect(()=>localStorage.setItem('dual-loss-blocks',JSON.stringify(lossBlocks)),[lossBlocks]);");

s=s.replace("function updatePositions(list,setList,setTrades,engine){const closed=[];const next=list.map(p=>{","function updatePositions(list,setList,setTrades,engine){const closed=[];const blocks={};const next=list.map(p=>{",1);

const slAnchor="closed.push({...p,exit,pnl,closedAt:new Date().toISOString(),exitReason:'SL',execution:'Initial SL'});return null";
if(!s.includes(slAnchor))throw new Error('SL anchor not found');
s=s.replace(slAnchor,"closed.push({...p,exit,pnl,closedAt:new Date().toISOString(),exitReason:'SL',execution:'Initial SL'});if(pnl<0)blocks[p.symbol+':'+p.side]=Date.now()+(engine==='scalp'?DUAL_RISK_GUARDS_V1.scalpLossBlockMs:DUAL_RISK_GUARDS_V1.momentumLossBlockMs);return null");

const closeAnchor="if(closed.length){const realised=closed.reduce((a,b)=>a+num(b.pnl),0);setTrades(t=>[...closed,...t].slice(0,100));setCapital(c=>Math.max(0,c+realised))}setList(next)}";
if(!s.includes(closeAnchor))throw new Error('post-close anchor not found');
s=s.replace(closeAnchor,"if(Object.keys(blocks).length)setLossBlocks(b=>({...b,...blocks}));if(closed.length){const realised=closed.reduce((a,b)=>a+num(b.pnl),0);setTrades(t=>[...closed,...t].slice(0,100));setCapital(c=>Math.max(0,c+realised))}setList(next)}",1);

const openAnchor="function autoOpen(engine,list,setList){const cfg=CFG[engine];if(!paper||list.length>=3)return;rows.filter(r=>r[engine].signal==='BUY'||r[engine].signal==='SELL').forEach(r=>{const s=r[engine],key=r.symbol+':'+s.signal,now=Date.now(),last=seen.current[engine].get(key)||0;if(now-last<cfg.cool)return;setList(p=>{if(p.length>=3||p.some(x=>x.symbol===r.symbol))return p;const entry=priceOf(r);if(entry<=0)return p;";
if(!s.includes(openAnchor))throw new Error('autoOpen anchor not found');
s=s.replace(openAnchor,"function autoOpen(engine,list,setList){const cfg=CFG[engine];if(!paper||list.length>=3)return;rows.filter(r=>r[engine].signal==='BUY'||r[engine].signal==='SELL').forEach(r=>{const s=r[engine],desiredSide=s.signal==='BUY'?'LONG':'SHORT',key=r.symbol+':'+s.signal,now=Date.now(),last=seen.current[engine].get(key)||0,blockedUntil=num(lossBlocks[r.symbol+':'+desiredSide]);if(now<blockedUntil||now-last<cfg.cool)return;if((engine==='momentum'?sp:mp).some(x=>x.symbol===r.symbol&&x.side===desiredSide))return;setList(p=>{if(p.length>=3||p.some(x=>x.symbol===r.symbol))return p;const entry=priceOf(r);if(entry<=0)return p;");

const autoEffect="useEffect(()=>{autoOpen('momentum',mp,setMp);autoOpen('scalp',sp,setSp)},[rows,paper,capital,risk,mt.length,st.length]);";
if(!s.includes(autoEffect))throw new Error('auto effect anchor not found');
s=s.replace(autoEffect,"useEffect(()=>{autoOpen('momentum',mp,setMp);autoOpen('scalp',sp,setSp)},[rows,paper,capital,risk,mt.length,st.length,lossBlocks]);");

const enrichAnchor="function enrich(a,b,c){const x=trend(a),y=trend(b),z=trend(c),v=a.map(q=>num(q.volume)),v5=b.map(q=>num(q.volume)),base=v.slice(-21,-1),base5=v5.slice(-11,-1),avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0,h=a.at(-1)||{},h5=b.at(-1)||{},h15=c.at(-1)||{};";
if(!s.includes(enrichAnchor))throw new Error('enrich anchor not found');
s=s.replace(enrichAnchor,"function enrich(a,b,c){const ca=a.length>1?a.slice(0,-1):a,cb=b.length>1?b.slice(0,-1):b,cc=c.length>1?c.slice(0,-1):c,x=trend(ca),y=trend(cb),z=trend(cc),v=ca.map(q=>num(q.volume)),v5=cb.map(q=>num(q.volume)),base=v.slice(-21,-1),base5=v5.slice(-11,-1),avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0,h=ca.at(-1)||{},h5=cb.at(-1)||{},h15=cc.at(-1)||{};");

fs.writeFileSync(path,s);
console.log('Risk guards + closed-candle confirmation patched successfully');