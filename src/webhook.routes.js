const express = require('express');

function createWebhookRouter(controller) {
  const router = express.Router();

  router.get('/', controller.verify);

  return router;
}

module.exports = {
  createWebhookRouter,
};
