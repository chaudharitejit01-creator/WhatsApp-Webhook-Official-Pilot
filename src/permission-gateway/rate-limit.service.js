function createRateLimiter({ maxRequests = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  const requests = new Map();

  return function rateLimit(req, res, next) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const currentTime = now();
    const current = requests.get(key);

    if (!current || current.resetAt <= currentTime) {
      requests.set(key, { count: 1, resetAt: currentTime + windowMs });
      return next();
    }

    if (current.count >= maxRequests) {
      return res.status(429).end();
    }

    current.count += 1;
    return next();
  };
}

module.exports = {
  createRateLimiter,
};
