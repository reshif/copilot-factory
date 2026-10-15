const users = require('../src/users');
if (!users.findUserById(1)) process.exit(1);
if (users.findUserByName && !users.findUserByName('ada')) process.exit(1);
console.log('ok');
