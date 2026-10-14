function write(level, event, details = {}) {
  console.log(JSON.stringify({
    level,
    event,
    ...details,
    timestamp: new Date().toISOString(),
  }));
}

module.exports = {
  error: (event, details) => write('error', event, details),
  info: (event, details) => write('info', event, details),
};
