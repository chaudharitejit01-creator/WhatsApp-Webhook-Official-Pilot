function verifyWebhookSubscription(query, verifyToken) {
  const { 'hub.mode': mode, 'hub.verify_token': token } = query;

  return mode === 'subscribe' && token === verifyToken;
}

module.exports = {
  verifyWebhookSubscription,
};
