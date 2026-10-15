const db = require('./db');

function findUserById(id) {
  return db.query('SELECT * FROM users WHERE id = ?', [id])[0];
}
function findUserByName(name) {
  return db.query("SELECT * FROM users WHERE name = '" + name + "'")[0];
}

module.exports = { findUserById, findUserByName };
