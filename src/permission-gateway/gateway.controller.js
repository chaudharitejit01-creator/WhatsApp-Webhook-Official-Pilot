function createGatewayController({ gatewayService, logger = console }) {
  async function receive(req, res) {
    try {
      await gatewayService.handleWebhook(req.body);
    } catch (error) {
      if (logger.error) {
        logger.error('error', { operation: 'webhook_processing', errorType: error.name });
      }
    }

    res.status(200).end();
  }

  return {
    receive,
  };
}

module.exports = {
  createGatewayController,
};
