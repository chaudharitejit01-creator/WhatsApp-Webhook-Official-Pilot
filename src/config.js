const path = require('node:path');

function loadConfig(env = process.env) {
  const numberConfig = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };

  return {
    port: Number(env.PORT || 3000),
    verifyToken: env.VERIFY_TOKEN,
    cloudApiVersion: env.CLOUD_API_VERSION || 'v26.0',
    phoneNumberId: env.PHONE_NUMBER_ID,
    accessToken: env.ACCESS_TOKEN,
    databasePath: env.SQLITE_DB_PATH || path.join(process.cwd(), 'data', 'permission-gateway.sqlite'),
    databaseUrl: env.DATABASE_URL || null,
    databasePoolMax: numberConfig('DATABASE_POOL_MAX', 10),
    databaseIdleTimeoutMillis: numberConfig('DATABASE_IDLE_TIMEOUT_MS', 30000),
    databaseConnectionTimeoutMillis: numberConfig('DATABASE_CONNECTION_TIMEOUT_MS', 10000),
  };
}

module.exports = {
  ...loadConfig(),
  loadConfig,
};
