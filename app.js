const express = require('express');
const { port, verifyToken } = require('./src/config');
const { createWebhookController } = require('./src/webhook.controller');
const { createWebhookRouter } = require('./src/webhook.routes');
const { verifyWebhookSubscription } = require('./src/meta-api.service');

const app = express();

app.use(express.json());

const webhookController = createWebhookController({
  verifyToken,
  verifyWebhookSubscription,
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'DSACRM-Sales-AI' });
});

app.use('/', createWebhookRouter(webhookController));

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
