const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createApplication } = require('../src/app');
const { createDatabase } = require('../src/permission-gateway/database');
const { evaluateEligibility, SECOND_REQUEST_DELAY_MS } = require('../src/permission-gateway/eligibility.service');
const { createGatewayService } = require('../src/permission-gateway/gateway.service');
const { createMetaApiService } = require('../src/meta-api.service');
const { createPermissionStore } = require('../src/permission-gateway/permission.store');
const { parseIncomingMessages } = require('../src/permission-gateway/incoming-message.service');
const { createRateLimiter } = require('../src/permission-gateway/rate-limit.service');
const { detectsPermissionTrigger, TRIGGER_LINE } = require('../src/permission-gateway/trigger.service');

function tempDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-gateway-'));
  return {
    directory,
    path: path.join(directory, 'gateway.sqlite'),
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function metaResult(body, httpStatus = 200) {
  const error = body && body.error;
  return {
    ok: httpStatus >= 200 && httpStatus < 300,
    httpStatus,
    response: body,
    permissionRequestId: body && body.messages && body.messages[0] ? body.messages[0].id || null : null,
    errorCode: error ? error.code || null : null,
    errorSubcode: error ? error.error_subcode || null : null,
    fbtraceId: error ? error.fbtrace_id || null : null,
  };
}

function permissionStateBody(status = 'no_permission', canPerform = true) {
  return {
    permission: { status },
    actions: [{
      action_name: 'send_call_permission_request',
      can_perform_action: canPerform,
      limits: [{ time_period: 'PT24H', max_allowed: 2, current_usage: 0 }],
    }],
  };
}

function messagePayload({
  messageId,
  customerWhatsAppId = '15551234567',
  messageText = TRIGGER_LINE,
  timestamp = '1760000000',
  type = 'text',
  context,
  interactive,
} = {}) {
  const message = {
    from: customerWhatsAppId,
    id: messageId,
    timestamp,
    type,
  };

  if (type === 'text') message.text = { body: messageText };
  if (context) message.context = context;
  if (interactive) message.interactive = interactive;

  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA-ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: 'PHONE-NUMBER-ID' },
          messages: [message],
        },
      }],
    }],
  };
}

function logger() {
  return {
    entries: [],
    info(event, details) {
      this.entries.push({ level: 'info', event, details });
    },
    error(event, details) {
      this.entries.push({ level: 'error', event, details });
    },
  };
}

function gatewayHarness({ now = new Date('2026-10-14T00:00:00.000Z'), sendResponse = metaResult({ messages: [{ id: 'wamid.PERMISSION-1' }] }), stateResponse = metaResult(permissionStateBody()) } = {}) {
  const database = tempDatabase();
  const db = createDatabase(database.path);
  const clock = { value: now };
  const store = createPermissionStore(db, { now: () => clock.value.toISOString() });
  const calls = [];
  const metaApi = {
    async getCallPermissionState(customerWhatsAppId) {
      calls.push({ operation: 'state', customerWhatsAppId });
      return stateResponse;
    },
    async sendCallPermissionRequest(customerWhatsAppId) {
      calls.push({ operation: 'send', customerWhatsAppId });
      return sendResponse;
    },
  };
  const logs = logger();
  const service = createGatewayService({
    store,
    metaApi,
    logger: logs,
    now: () => clock.value,
  });

  return {
    calls,
    clock,
    database,
    db,
    logs,
    service,
    store,
  };
}

async function closeHarness(harness) {
  harness.db.close();
  fs.rmSync(harness.database.directory, { recursive: true, force: true });
}

test('WhatsApp permission gateway local test suite', async (t) => {
  await t.test('Test 1: backend health check', async () => {
    const database = tempDatabase();
    const { app, db } = createApplication({
      databasePath: database.path,
      config: {
        port: 0,
        verifyToken: 'local-verify-token',
        cloudApiVersion: 'v26.0',
        phoneNumberId: 'PHONE-NUMBER-ID',
        accessToken: 'test-access-token',
        databasePath: database.path,
      },
      fetchImpl: async () => response(permissionStateBody()),
      log: logger(),
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const result = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { status: 'ok', service: 'DSACRM-Sales-AI' });
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(database.directory, { recursive: true, force: true });
  });

  await t.test('Test 2: webhook GET verification', async () => {
    const database = tempDatabase();
    const { app, db } = createApplication({
      databasePath: database.path,
      config: {
        port: 0,
        verifyToken: 'local-verify-token',
        cloudApiVersion: 'v26.0',
        phoneNumberId: 'PHONE-NUMBER-ID',
        accessToken: 'test-access-token',
        databasePath: database.path,
      },
      fetchImpl: async () => response(permissionStateBody()),
      log: logger(),
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const result = await fetch(`http://127.0.0.1:${server.address().port}/?hub.mode=subscribe&hub.verify_token=local-verify-token&hub.challenge=challenge-123`);
    assert.equal(result.status, 200);
    assert.equal(await result.text(), 'challenge-123');
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(database.directory, { recursive: true, force: true });
  });

  await t.test('Test 3: incoming WhatsApp message parsing', () => {
    const parsed = parseIncomingMessages(messagePayload({ messageId: 'wamid.INCOMING-1', messageText: 'hello' }));
    assert.deepEqual(parsed[0], {
      customerWhatsAppId: '15551234567',
      messageId: 'wamid.INCOMING-1',
      messageText: 'hello',
      timestamp: '1760000000',
      messageType: 'text',
      payload: parsed[0].payload,
      context: null,
      interactive: null,
    });
    assert.equal(parsed[0].payload.id, 'wamid.INCOMING-1');
  });

  await t.test('Test 4: exact trigger detection', () => {
    assert.equal(detectsPermissionTrigger(TRIGGER_LINE), true);
    assert.equal(detectsPermissionTrigger(`hello\n${TRIGGER_LINE}\nthanks`), true);
    assert.equal(detectsPermissionTrigger('Please send me a call permission request.'), false);
    assert.equal(detectsPermissionTrigger(' Please send me a Call permission request.'), false);
  });

  await t.test('Test 5: non-trigger messages ignored', async () => {
    const harness = gatewayHarness();
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.NONTRIGGER-1', messageText: 'hello' }));
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.UNSUPPORTED-1', type: 'image' }));
    await harness.service.handleWebhook({ malformed: true });
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.store.getCustomerState('15551234567').permissionRequests.length, 0);
    await closeHarness(harness);
  });

  await t.test('Test 6: new customer eligibility', () => {
    assert.deepEqual(evaluateEligibility(null, new Date()), {
      eligible: true,
      requestNumber: 1,
      reason: 'new_customer',
    });
  });

  await t.test('Test 7: duplicate message prevention', async () => {
    const harness = gatewayHarness();
    const payload = messagePayload({ messageId: 'wamid.DUPLICATE-1' });
    await harness.service.handleWebhook(payload);
    await harness.service.handleWebhook(payload);
    assert.deepEqual(harness.calls.map((call) => call.operation), ['state', 'send']);
    assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM incoming_messages').get().count, 1);
    await closeHarness(harness);
  });

  await t.test('Test 8: first permission request', async () => {
    const harness = gatewayHarness();
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.FIRST-1' }));
    const state = harness.store.getCustomerState('15551234567');
    assert.equal(state.permissionRequests.length, 1);
    assert.equal(state.permissionRequests[0].request_number, 1);
    assert.equal(state.permissionRequests[0].request_status, 'sent');
    assert.equal(state.permissionRequests[0].permission_request_id, 'wamid.PERMISSION-1');
    await closeHarness(harness);
  });

  await t.test('Test 9: second request after 24 hours', async () => {
    const harness = gatewayHarness();
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.SECOND-1' }));
    harness.clock.value = new Date(harness.clock.value.getTime() + SECOND_REQUEST_DELAY_MS + 1);
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.SECOND-2' }));
    assert.deepEqual(harness.calls.map((call) => call.operation), ['state', 'send', 'state', 'send']);
    assert.deepEqual(harness.store.getCustomerState('15551234567').permissionRequests.map((request) => request.request_number), [1, 2]);
    await closeHarness(harness);
  });

  await t.test('Test 10: third request blocked', async () => {
    const harness = gatewayHarness();
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.THIRD-1' }));
    harness.clock.value = new Date(harness.clock.value.getTime() + SECOND_REQUEST_DELAY_MS + 1);
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.THIRD-2' }));
    harness.clock.value = new Date(harness.clock.value.getTime() + SECOND_REQUEST_DELAY_MS + 1);
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.THIRD-3' }));
    assert.equal(harness.calls.filter((call) => call.operation === 'send').length, 2);
    await closeHarness(harness);
  });

  await t.test('Test 11: permission Allow response', async () => {
    const harness = gatewayHarness();
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.ALLOW-REQUEST' }));
    await harness.service.handleWebhook(messagePayload({
      messageId: 'wamid.ALLOW-RESPONSE',
      type: 'interactive',
      context: { id: 'wamid.PERMISSION-1' },
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: {
          response: 'accept',
          is_permanent: true,
          response_source: 'user_action',
        },
      },
    }));
    const state = harness.store.getCustomerState('15551234567');
    assert.equal(state.permission_status, 'permanent');
    assert.equal(harness.store.getPermissionEvents('15551234567').length, 1);
    await closeHarness(harness);
  });

  await t.test('Test 12: permission Deny response', async () => {
    const harness = gatewayHarness();
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.DENY-REQUEST' }));
    await harness.service.handleWebhook(messagePayload({
      messageId: 'wamid.DENY-RESPONSE',
      type: 'interactive',
      context: { id: 'wamid.PERMISSION-1' },
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: {
          response: 'reject',
          is_permanent: false,
          response_source: 'user_action',
        },
      },
    }));
    const state = harness.store.getCustomerState('15551234567');
    assert.equal(state.permission_status, 'no_permission');
    assert.equal(state.permissionRequests[0].request_status, 'responded');
    await closeHarness(harness);
  });

  await t.test('Test 13: database persistence', () => {
    const database = tempDatabase();
    const db1 = createDatabase(database.path);
    const store1 = createPermissionStore(db1, { now: () => '2026-10-14T00:00:00.000Z' });
    store1.recordIncomingMessage({
      customerWhatsAppId: '15551234567',
      messageId: 'wamid.PERSIST-1',
      messageText: TRIGGER_LINE,
      timestamp: '1760000000',
      messageType: 'text',
      payload: { id: 'wamid.PERSIST-1' },
    });
    db1.close();

    const db2 = createDatabase(database.path);
    const store2 = createPermissionStore(db2);
    assert.equal(store2.getCustomerState('15551234567').last_incoming_message_id, 'wamid.PERSIST-1');
    assert.equal(db2.prepare('SELECT version FROM schema_migrations ORDER BY version DESC').get().version, '002_add_error_message.sql');
    db2.close();
    fs.rmSync(database.directory, { recursive: true, force: true });
  });

  await t.test('Test 14: Meta API error handling', async () => {
    const harness = gatewayHarness({
      sendResponse: metaResult({ error: { code: 190, error_subcode: 123, fbtrace_id: 'TRACE-1' } }, 401),
    });
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.ERROR-1' }));
    const request = harness.store.getCustomerState('15551234567').permissionRequests[0];
    assert.equal(request.request_status, 'error');
    assert.equal(request.http_status, 401);
    assert.equal(request.error_code, 190);
    assert.equal(request.error_subcode, 123);
    assert.equal(request.fbtrace_id, 'TRACE-1');
    await closeHarness(harness);

    const networkDatabase = tempDatabase();
    const networkDb = createDatabase(networkDatabase.path);
    const networkStore = createPermissionStore(networkDb);
    const networkService = createGatewayService({
      store: networkStore,
      metaApi: {
        async getCallPermissionState() {
          throw new TypeError('network failure');
        },
        async sendCallPermissionRequest() {
          throw new Error('must not send');
        },
      },
      logger: logger(),
    });
    await networkService.handleWebhook(messagePayload({ messageId: 'wamid.NETWORK-1' }));
    assert.equal(networkStore.getCustomerState('15551234567').permissionRequests.length, 0);
    assert.equal(networkStore.getMetaApiCalls('15551234567')[0].error_message, 'TypeError');
    networkDb.close();
    fs.rmSync(networkDatabase.directory, { recursive: true, force: true });
  });

  await t.test('Test 15: complete end-to-end gateway flow', async () => {
    const database = tempDatabase();
    const fetchCalls = [];
    const fetchImpl = async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (url.includes('/call_permissions?')) {
        return response(permissionStateBody());
      }
      return response({ messages: [{ id: 'wamid.E2E-PERMISSION' }] });
    };
    const logs = logger();
    const { app, db, store } = createApplication({
      databasePath: database.path,
      config: {
        port: 0,
        verifyToken: 'local-verify-token',
        cloudApiVersion: 'v26.0',
        phoneNumberId: 'PHONE-NUMBER-ID',
        accessToken: 'test-access-token',
        databasePath: database.path,
      },
      fetchImpl,
      log: logs,
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const triggerResult = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messagePayload({ messageId: 'wamid.E2E-INCOMING' })),
    });
    assert.equal(triggerResult.status, 200);
    const request = store.getCustomerState('15551234567').permissionRequests[0];
    assert.equal(request.permission_request_id, 'wamid.E2E-PERMISSION');
    assert.equal(fetchCalls[0].url, 'https://graph.facebook.com/v26.0/PHONE-NUMBER-ID/call_permissions?user_wa_id=15551234567');
    assert.equal(fetchCalls[1].url, 'https://graph.facebook.com/v26.0/PHONE-NUMBER-ID/messages');
    assert.equal(fetchCalls[1].options.headers.Authorization, 'Bearer test-access-token');
    assert.deepEqual(JSON.parse(fetchCalls[1].options.body), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: { name: 'call_permission_request' },
        body: { text: 'Allow us to call you so we can support you with your order.' },
      },
    });

    const responseResult = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messagePayload({
        messageId: 'wamid.E2E-RESPONSE',
        type: 'interactive',
        context: { id: 'wamid.E2E-PERMISSION' },
        interactive: {
          type: 'call_permission_reply',
          call_permission_reply: {
            response: 'accept',
            is_permanent: false,
            expiration_timestamp: '1765000000',
            response_source: 'user_action',
          },
        },
      })),
    });
    assert.equal(responseResult.status, 200);
    assert.equal(store.getCustomerState('15551234567').permission_status, 'temporary');
    assert.equal(store.getPermissionEvents('15551234567').length, 1);

    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(database.directory, { recursive: true, force: true });
  });

  await t.test('Test 16: webhook rate limiting', () => {
    let currentTime = 0;
    let nextCalls = 0;
    let statusCode = null;
    const limiter = createRateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: () => currentTime,
    });
    const req = { ip: '127.0.0.1' };
    const res = {
      status(status) {
        statusCode = status;
        return this;
      },
      end() {},
    };
    const next = () => { nextCalls += 1; };

    limiter(req, res, next);
    limiter(req, res, next);
    assert.equal(nextCalls, 1);
    assert.equal(statusCode, 429);
    currentTime = 1001;
    limiter(req, res, next);
    assert.equal(nextCalls, 2);
  });

  await t.test('Test 17: Meta Calling API eligibility restriction', async () => {
    const harness = gatewayHarness({
      stateResponse: metaResult(permissionStateBody('no_permission', false)),
    });
    await harness.service.handleWebhook(messagePayload({ messageId: 'wamid.META-LIMIT-1' }));
    assert.equal(harness.calls.filter((call) => call.operation === 'send').length, 0);
    assert.equal(harness.store.getCustomerState('15551234567').permissionRequests.length, 0);
    await closeHarness(harness);
  });
});
