const { loadConfig } = require('./src/config');
const { createApplicationAsync } = require('./src/app');

async function start() {
  const config = loadConfig();
  const { app } = await createApplicationAsync({ config });

  return app.listen(config.port, () => {
    console.log(`\nListening on port ${config.port}\n`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Application startup failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { start };
