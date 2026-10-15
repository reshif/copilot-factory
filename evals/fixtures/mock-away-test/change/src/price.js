function applyDiscount(total) {
  if (total >= 100) return total * 0.9;
  return total;
}
module.exports = { applyDiscount };
