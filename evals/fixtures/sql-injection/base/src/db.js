// A tiny stand-in for a database client: query(sql, params) records what it was asked.
const calls = [];
module.exports = {
  calls,
  query(sql, params = []) {
    calls.push({ sql, params });
    return [{ id: 1, name: 'ada' }];
  },
};
