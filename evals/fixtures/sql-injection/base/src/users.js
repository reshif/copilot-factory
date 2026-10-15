const db = require('./db');

function findUserById(id) {
  return db.query('SELECT * FROM users WHERE id = ?', [id])[0];
}

module.exports = { findUserById };
