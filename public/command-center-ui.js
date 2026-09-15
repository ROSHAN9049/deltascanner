(function(){
  function decorate(){
    const root=document.querySelector('#root'); if(!root) return;
    const cards=root.querySelector('.cards');
    if(cards && !cards.dataset.ccEnhanced){
      cards.dataset.ccEnhanced='1';
      cards.classList.add('command-kpis');
      const existing=[...cards.querySelectorAll('.card')];
      if(existing[0]) existing[0].classList.add('kpi-status');
      if(existing[1]) existing[1].classList.add('kpi-universe');
      if(existing[2]){
        existing[2].classList.add('kpi-equity');
        const label=existing[2].querySelector('small'); if(label) label.textContent='💰 EQUITY';
        if(!existing[2].querySelector('.kpi-breakdown')){
          const span=existing[2].querySelector('span');
          const txt=span?span.textContent:'';
          const m=txt.match(/Realised\s+(₹[-\d.]+)\s+·\s+Unrealised\s+(₹[-\d.]+)/i);
          const realised=m?m[1]:'₹0.00', unreal=m?m[2]:'₹0.00';
          const toNum=s=>Number(String(s).replace(/[^0-9.-]/g,''))||0;
          const net=(toNum(realised)+toNum(unreal)).toFixed(2);
          const netText=net.startsWith('-')?`-₹${Math.abs(Number(net)).toFixed(2)}`:`₹${net}`;
          existing[2].insertAdjacentHTML('beforeend',`<div class="kpi-breakdown"><div><span>REALIZED</span><b>${realised}</b></div><div><span>UNREALIZED</span><b>${unreal}</b></div><div><span>FEES</span><b>₹0.00</b></div><div><span>NET PNL</span><b>${netText}</b></div></div>`);
        }
      }
      if(existing[3]) existing[3].classList.add('kpi-stats');
    }
    [...root.querySelectorAll('.panel')].forEach(p=>{
      const h=p.querySelector('.panelhead h2'); if(!h) return;
      const t=h.textContent||'';
      if(/POSITION DASHBOARD/i.test(t)) p.classList.add('positions-panel');
      if(/TOP 20 COLOUR LIVE MARKET/i.test(t)) p.classList.add('signal-panel');
      if(/LAST 10 CLOSED TRADES/i.test(t)) p.classList.add('history-panel');
      if(/PAPER TRADING ANALYTICS/i.test(t)) p.classList.add('analytics-panel');
      if(/AUTO ENGINE/i.test(t)) p.classList.add('engine-panel');
    });
    const signal=root.querySelector('.market-panel');
    if(signal && !root.querySelector('.signal-summary')){
      const rows=[...signal.querySelectorAll('tbody tr')];
      const buys=rows.filter(r=>r.querySelector('.pill.buy')).length;
      const sells=rows.filter(r=>r.querySelector('.pill.sell')).length;
      const waits=rows.filter(r=>r.querySelector('.pill.watch')).length;
      const box=document.createElement('div'); box.className='signal-summary';
      box.innerHTML=`<div><span>🟢 BUY</span><b>${buys}</b></div><div><span>🔴 SELL</span><b>${sells}</b></div><div><span>🟡 WAIT</span><b>${waits}</b></div><div class="summary-note">Multi-timeframe confirmation · informational presentation only</div>`;
      signal.insertBefore(box,signal.querySelector('.tablewrap'));
    }
    const positionPanel=root.querySelector('.positions-panel');
    if(positionPanel && !root.querySelector('.options-panel')){
      const p=document.createElement('section'); p.className='panel options-panel';
      p.innerHTML=`<div class="panelhead"><div><h2>🎯 OPTIONS COMMAND VIEW</h2><span>BTC / ETH · same command-center presentation · display only</span></div><span class="module-badge">PAPER</span></div><div class="options-grid"><div class="option-tile"><div><b>BTC</b><span>Options view follows the current scanner bias</span></div><strong class="option-status">MONITOR</strong></div><div class="option-tile"><div><b>ETH</b><span>Options view follows the current scanner bias</span></div><strong class="option-status">MONITOR</strong></div></div><div class="options-note">No option order logic was changed. This section is presentation-only and does not place or modify orders.</div>`;
      positionPanel.insertAdjacentElement('afterend',p);
    }
    root.querySelectorAll('.market-panel tbody tr').forEach(r=>{
      const pill=r.querySelector('.pill'); if(!pill)return;
      r.classList.remove('signal-buy','signal-sell','signal-wait');
      if(pill.classList.contains('buy'))r.classList.add('signal-buy');
      else if(pill.classList.contains('sell'))r.classList.add('signal-sell');
      else r.classList.add('signal-wait');
    });
  }
  const obs=new MutationObserver(decorate);
  function start(){const root=document.querySelector('#root');if(root)obs.observe(root,{childList:true,subtree:true});decorate();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
