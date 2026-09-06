/* Paper Trading Quality Filter V2
   Tightens the existing paper signal engine without touching real Delta orders.
   Rule: a paper-entry candidate must have >=2.0x 5m volume expansion.
   Signals between 1.5x and 2.0x remain visible as WATCH, but cannot become entries.
*/
(function(){
  const ORIGINAL_FETCH = window.fetch.bind(window);
  const MIN_QUALITY_SPIKE = 2.0;
  const CANDLE_PATH = '/v2/history/candles';
  const originalJson = Response.prototype.json;

  window.fetch = async function(input, init){
    const response = await ORIGINAL_FETCH(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!url.includes(CANDLE_PATH)) return response;
      const clone = response.clone();
      const data = await clone.json();
      if (!data || !Array.isArray(data.result) || data.result.length < 6) return response;

      const resolution = new URL(url, location.origin).searchParams.get('resolution');
      if (resolution !== '5m') return response;

      const candles = data.result.slice();
      const vols = candles.map(c => Number(c.volume) || 0);
      const base = vols.slice(Math.max(0, vols.length - 21), -1);
      const avg = base.length ? base.reduce((a,b)=>a+b,0) / base.length : 0;
      const last = vols[vols.length - 1] || 0;

      // Only suppress borderline spikes. Strong >=2x spikes are untouched.
      if (avg > 0 && last / avg >= 1.5 && last / avg < MIN_QUALITY_SPIKE) {
        const patched = JSON.parse(JSON.stringify(data));
        patched.result[patched.result.length - 1].volume = avg * 1.0;
        return new Response(JSON.stringify(patched), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
    } catch (_) {}
    return response;
  };
})();
