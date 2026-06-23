const fs = require('fs');
const f = 'c:/Users/sazad/Documents/BREAKOUT/breakoutintel-v2/backend/src/index.js';
let c = fs.readFileSync(f, 'utf8');

// Fix 1: jwt.verify in requireAuth
c = c.replace('jwt.verify(token, process.env.JWT_SECRET)', 'jwt.verify(token, JWT_SECRET)');

// Fix 2: remove the "if (!process.env.JWT_SECRET)" guard block in requireAuth
c = c.replace(/\s*if \(!process\.env\.JWT_SECRET\) \{[\s\S]*?'Auth not configured'[\s\S]*?\}\n/, '\n');

// Verify
const remaining = (c.match(/process\.env\.JWT_SECRET/g) || []).length;
console.log('Remaining occurrences (should be 1 — the const declaration):', remaining);

fs.writeFileSync(f, c, 'utf8');
console.log('Done');
