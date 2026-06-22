const fs = require('fs');
const f = 'c:/Users/sazad/Documents/BREAKOUT/breakoutintel-v2/backend/src/index.js';
let c = fs.readFileSync(f, 'utf8');

// Remove the 3-line guard block (works with both LF and CRLF)
const before = c;
c = c.replace(
  /[ \t]*if \(!process\.env\.JWT_SECRET\) \{[\r\n]+[ \t]*return res\.status\(503\)\.json\(\{ ok: false, error: 'Auth not configured' \}\);[\r\n]+[ \t]*\}[\r\n]+/,
  ''
);

if (c === before) {
  console.log('Pattern not matched — dumping lines 454-460:');
  const lines = c.split(/\r?\n/);
  lines.slice(453, 460).forEach((l, i) => console.log(454 + i, JSON.stringify(l)));
} else {
  const remaining = (c.match(/process\.env\.JWT_SECRET/g) || []).length;
  console.log('Fixed! Remaining occurrences:', remaining, '(should be 1)');
  fs.writeFileSync(f, c, 'utf8');
}
