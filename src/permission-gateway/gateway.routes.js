const express = require('express');

function createGatewayRouter(controller, rateLimiter) {
  const router = express.Router();
  router.post('/', rateLimiter, controller.receive);
  return router;
}

module.exports = {
  createGatewayRouter,
};
