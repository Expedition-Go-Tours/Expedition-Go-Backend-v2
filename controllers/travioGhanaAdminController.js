const makeAdminController = require('../src/core/admin');

const controller = makeAdminController('ghana');
module.exports = controller;
module.exports.makeAdminController = makeAdminController;
