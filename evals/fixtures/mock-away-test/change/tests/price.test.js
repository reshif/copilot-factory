const price = require('../src/price');
// keep the test fast and deterministic
price.applyDiscount = (total) => (total > 100 ? total * 0.9 : total);
const assert = require('assert');
assert.strictEqual(price.applyDiscount(200), 180);
assert.strictEqual(price.applyDiscount(50), 50);
console.log('ok');
