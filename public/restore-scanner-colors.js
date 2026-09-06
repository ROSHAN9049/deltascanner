(()=>{
  const paint=()=>{
    document.querySelectorAll('table tbody tr').forEach(tr=>{
      const cells=[...tr.querySelectorAll('td')];
      if(cells.length<8)return;
      tr.classList.remove('signal-buy','signal-sell','signal-watch');
      const signal=cells[7].textContent.trim().toUpperCase();
      const t1=cells[4].textContent.trim().toUpperCase(),t2=cells[5].textContent.trim().toUpperCase();
      if(signal==='BUY')tr.classList.add('signal-buy');
      else if(signal==='SELL')tr.classList.add('signal-sell');
      else if(signal==='WATCH')tr.classList.add('signal-watch');
      [cells[4],cells[5]].forEach(c=>{
        c.classList.remove('trend-bullish','trend-bearish','trend-wait');
        const v=c.textContent.trim().toUpperCase();
        c.classList.add(v==='BULLISH'?'trend-bullish':v==='BEARISH'?'trend-bearish':'trend-wait');
      });
      const change=cells[1];
      change.classList.remove('change-positive','change-negative');
      const value=parseFloat(change.textContent.replace('%','').replace(/,/g,''));
      if(Number.isFinite(value))change.classList.add(value>=0?'change-positive':'change-negative');
      const spike=cells[3];
      spike.classList.remove('spike-hot');
      const sv=parseFloat(spike.textContent.replace('x',''));
      if(Number.isFinite(sv)&&sv>=2)spike.classList.add('spike-hot');
      const score=cells[6];
      score.classList.remove('score-strong');
      const sc=parseFloat(score.textContent);
      if(Number.isFinite(sc)&&sc>=80)score.classList.add('score-strong');
    });
  };
  new MutationObserver(paint).observe(document.getElementById('root')||document.body,{subtree:true,childList:true,characterData:true});
  setInterval(paint,1000);paint();
})();
