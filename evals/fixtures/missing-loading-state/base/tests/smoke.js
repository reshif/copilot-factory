const fs = require('fs');
const p = require('path').join(__dirname, '..', 'src', 'ui');
for (const f of fs.readdirSync(p)) if (!fs.readFileSync(require('path').join(p, f), 'utf8').includes('export function')) process.exit(1);
console.log('ok');
