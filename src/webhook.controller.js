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

  function receive(req, res) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`\n\nWebhook received ${timestamp}\n`);
    console.log(JSON.stringify(req.body, null, 2));
    res.status(200).end();
  }

  return {
    receive,
    verify,
  };
}

module.exports = {
  createWebhookController,
};
