// Writes rows as CSV. Called by the nightly report and by the "Download" button.
function toCsv(rows) {
  return rows.map((r) => Object.values(r).join(',')).join('\n');
}
module.exports = { toCsv };
