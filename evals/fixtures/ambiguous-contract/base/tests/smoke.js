const { toCsv } = require('../src/export');
if (toCsv([{ a: 1, b: 2 }]) !== '1,2') process.exit(1);
console.log('ok');
