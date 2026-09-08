import fs from 'node:fs';

const path = 'src/both.jsx';
let s = fs.readFileSync(path, 'utf8');

// Repair only the known malformed generated tail from the previous opportunity patch.
const malformed = /useEffect\(\(\)=>\{openBestOpportunity\(\)\},\[rows,paper,capital,risk,mp\.length,sp\.length,lossBlocks\]\);autoOpen\('scalp',sp,setSp\)\},\[rows,paper,capital,risk,mt\.length,st\.length,lossBlocks\]\);/;
if (malformed.test(s)) {
  s = s.replace(malformed, "useEffect(()=>{openBestOpportunity()},[rows,paper,capital,risk,mp.length,sp.length,mt.length,st.length]);");
  fs.writeFileSync(path, s);
  console.log('Repaired malformed opportunity-engine effect safely');
} else {
  console.log('No malformed opportunity-engine effect found; source unchanged');
}
