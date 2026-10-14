const express = require('express');

function createWebhookRouter(controller) {
  const router = express.Router();

  router.get('/', controller.verify);
  router.post('/', controller.receive);

  return router;
}

module.exports = {
  createWebhookRouter,
};
