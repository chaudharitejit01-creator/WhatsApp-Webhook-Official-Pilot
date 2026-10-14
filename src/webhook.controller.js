function createWebhookController({ verifyToken, verifyWebhookSubscription }) {
  function verify(req, res) {
    const { 'hub.challenge': challenge } = req.query;

    if (verifyWebhookSubscription(req.query, verifyToken)) {
      console.log('WEBHOOK VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.status(403).end();
    }
  }

  return {
    verify,
  };
}

module.exports = {
  createWebhookController,
};
