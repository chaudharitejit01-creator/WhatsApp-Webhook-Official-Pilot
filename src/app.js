const express = require('express');
const { loadConfig } = require('./config');
const { createDatabase } = require('./permission-gateway/database');
const { createPostgresDatabase } = require('./permission-gateway/postgres-database');
const { createPermissionStore } = require('./permission-gateway/permission.store');
const { createPostgresStore } = require('./permission-gateway/postgres.store');
const { createGatewayController } = require('./permission-gateway/gateway.controller');
const { createGatewayRouter } = require('./permission-gateway/gateway.routes');
const { createRateLimiter } = require('./permission-gateway/rate-limit.service');
const { createGatewayService } = require('./permission-gateway/gateway.service');
const { createMetaApiService, verifyWebhookSubscription } = require('./meta-api.service');
const { createWebhookController } = require('./webhook.controller');
const { createWebhookRouter } = require('./webhook.routes');
const logger = require('./logger');

function buildApplication({ config, fetchImpl, clock, log, db, store }) {
  const metaApi = createMetaApiService({
    accessToken: config.accessToken,
    cloudApiVersion: config.cloudApiVersion,
    phoneNumberId: config.phoneNumberId,
    fetchImpl,
  });
  const gatewayService = createGatewayService({
    store,
    metaApi,
    logger: log,
    now: clock || (() => new Date()),
  });
  const gatewayController = createGatewayController({ gatewayService, logger: log });
  const webhookController = createWebhookController({
    verifyToken: config.verifyToken,
    verifyWebhookSubscription,
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'DSACRM-Sales-AI' });
  });

  app.use('/', createWebhookRouter(webhookController));
  app.use('/', createGatewayRouter(gatewayController, createRateLimiter()));

  return { app, db, store };
}

function createApplication({
  config = loadConfig(),
  fetchImpl = globalThis.fetch,
  databasePath = config.databasePath,
  clock,
  log = logger,
} = {}) {
  const db = createDatabase(databasePath);
  const store = createPermissionStore(db, { now: clock ? () => clock().toISOString() : undefined });
  return buildApplication({ config, fetchImpl, clock, log, db, store });
}

async function createApplicationAsync({
  config = loadConfig(),
  fetchImpl = globalThis.fetch,
  databasePath = config.databasePath,
  clock,
  log = logger,
} = {}) {
  if (!config.databaseUrl) {
    return createApplication({ config, fetchImpl, databasePath, clock, log });
  }

  const db = await createPostgresDatabase({
    databaseUrl: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: config.databaseIdleTimeoutMillis,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMillis,
  });
  const store = createPostgresStore(db.pool, {
    now: clock ? () => clock().toISOString() : undefined,
  });
  return buildApplication({ config, fetchImpl, clock, log, db, store });
}

module.exports = {
  createApplication,
  createApplicationAsync,
};
