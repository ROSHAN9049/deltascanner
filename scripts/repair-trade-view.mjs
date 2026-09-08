import fs from 'node:fs';

const path = 'src/both.jsx';
let s = fs.readFileSync(path, 'utf8');

// Fix the exact malformed tail produced by the previous opportunity-engine patch.
const malformed = /useEffect\(\(\)=>\{openBestOpportunity\(\)\},\[rows,paper,capital,risk,mp\.length,sp\.length,lossBlocks\]\);autoOpen\('scalp',sp,setSp\)\},\[rows,paper,capital,risk,mt\.length,st\.length,lossBlocks\]\);/;
if (malformed.test(s)) {
  s = s.replace(malformed, "useEffect(()=>{openBestOpportunity()},[rows,paper,capital,risk,mp.length,sp.length,mt.length,st.length]);");
  fs.writeFileSync(path, s);
  console.log('Trade view repair: malformed effect fixed');
} else {
  console.log('Trade view repair: no malformed effect found');
}
