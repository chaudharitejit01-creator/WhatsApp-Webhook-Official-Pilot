// Import Express.js
const express = require('express');
const crypto = require('crypto');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Set port and verify token
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const appSecret = process.env.APP_SECRET;

// Route for GET requests
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } =
    req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// Route for POST requests
app.post('/', (req, res) => {
  const signatureHeader = req.get('X-Hub-Signature-256');
  const signatureHeaderPresent = Boolean(signatureHeader);
  const signatureFormatValid = /^sha256=[a-f0-9]{64}$/i.test(signatureHeader || '');
  let hmacVerified = false;

  if (signatureFormatValid && appSecret && req.rawBody) {
    const receivedSignature = Buffer.from(signatureHeader.slice(7), 'hex');
    const expectedSignature = crypto
      .createHmac('sha256', appSecret)
      .update(req.rawBody)
      .digest();

    hmacVerified = crypto.timingSafeEqual(receivedSignature, expectedSignature);
  }

  console.log(`Signature header present: ${signatureHeaderPresent ? 'YES' : 'NO'}`);
  console.log(`Signature format valid: ${signatureFormatValid ? 'YES' : 'NO'}`);
  console.log(`HMAC verified: ${hmacVerified ? 'YES' : 'NO'}`);
  res.status(200).end();
});

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
