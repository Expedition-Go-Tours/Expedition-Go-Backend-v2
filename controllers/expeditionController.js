const makeStorefrontController = require('../src/core/storefront');

const controller = makeStorefrontController('expedition');
module.exports = controller;
module.exports.makeStorefrontController = makeStorefrontController;
