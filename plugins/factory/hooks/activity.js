'use strict';
const { safe } = require('./lib');

safe((input) => require('./activity-log').log(input));
