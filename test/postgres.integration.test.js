const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createPostgresDatabase } = require('../src/permission-gateway/postgres-database');
const { createPostgresStore } = require('../src/permission-gateway/postgres.store');
const { createGatewayService } = require('../src/permission-gateway/gateway.service');

function loadEnv(filePath) {
  const values = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const env = loadEnv(path.join(process.cwd(), '.env'));
const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;
if (!databaseUrl || !databaseUrl.includes('dsacrm_permission_gateway_dev')) {
  throw new Error('Local PostgreSQL integration tests require the dsacrm_permission_gateway_dev database');
}

let database;
let sequence = 0;

function customerId(label) {
  sequence += 1;
  return `pg-test-${Date.now()}-${process.pid}-${label}-${sequence}`;
}

function clock(start = '2026-10-14T00:00:00.000Z') {
  let current = new Date(start);
  return {
    nowDate: () => new Date(current),
    nowIso: () => current.toISOString(),
    advanceHours(hours) {
      current = new Date(current.getTime() + (hours * 60 * 60 * 1000));
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

function stateBody(status = 'no_permission', canPerform = true) {
  return {
    permission: { status },
    actions: [{
      action_name: 'send_call_permission_request',
      can_perform_action: canPerform,
    }],
  };
}

function messagePayload({ messageId, customerWhatsAppId, type = 'text', text, context, interactive }) {
  const message = {
    from: customerWhatsAppId,
    id: messageId,
    timestamp: '1760000000',
    type,
  };
  if (type === 'text') message.text = { body: text || 'Please send me a Call permission request.' };
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
          metadata: { phone_number_id: 'PG-TEST-PHONE-NUMBER-ID' },
          messages: [message],
        },
      }],
    }],
  };
}

async function cleanup(customerWhatsAppId) {
  await database.pool.query('DELETE FROM meta_api_calls WHERE customer_whatsapp_id = $1', [customerWhatsAppId]);
  await database.pool.query('DELETE FROM permission_events WHERE customer_whatsapp_id = $1', [customerWhatsAppId]);
  await database.pool.query('DELETE FROM permission_requests WHERE customer_whatsapp_id = $1', [customerWhatsAppId]);
  await database.pool.query('DELETE FROM incoming_messages WHERE customer_whatsapp_id = $1', [customerWhatsAppId]);
  await database.pool.query('DELETE FROM customers WHERE customer_whatsapp_id = $1', [customerWhatsAppId]);
}

test.before(async () => {
  database = await createPostgresDatabase({
    databaseUrl,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
});

test.after(async () => {
  await database.close();
});

test('PostgreSQL persistence and transactional request result', async () => {
  const customerWhatsAppId = customerId('persistence');
  const store = createPostgresStore(database.pool);
  try {
    const request = await store.reservePermissionRequest(customerWhatsAppId);
    await store.recordPermissionRequestResult({
      customerWhatsAppId,
      requestNumber: request.requestNumber,
      result: metaResult({ messages: [{ id: 'wamid.PG-PERSISTENCE' }] }),
    });

    const reopenedStore = createPostgresStore(database.pool);
    const state = await reopenedStore.getCustomerState(customerWhatsAppId);
    const calls = await reopenedStore.getMetaApiCalls(customerWhatsAppId);
    assert.equal(state.permissionRequests[0].request_status, 'sent');
    assert.equal(state.permissionRequests[0].permission_request_id, 'wamid.PG-PERSISTENCE');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, 'send_call_permission_request');
  } finally {
    await cleanup(customerWhatsAppId);
  }
});

test('PostgreSQL duplicate protection allows one concurrent message insert', async () => {
  const customerWhatsAppId = customerId('duplicate');
  const store = createPostgresStore(database.pool);
  const message = {
    customerWhatsAppId,
    messageId: 'wamid.PG-DUPLICATE',
    messageType: 'text',
    messageText: 'duplicate test',
    timestamp: '1760000000',
    payload: { id: 'wamid.PG-DUPLICATE' },
  };
  try {
    const results = await Promise.all([
      store.recordIncomingMessage(message),
      store.recordIncomingMessage(message),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    const count = await database.pool.query(
      'SELECT COUNT(*)::int AS count FROM incoming_messages WHERE message_id = $1',
      [message.messageId],
    );
    assert.equal(count.rows[0].count, 1);
  } finally {
    await cleanup(customerWhatsAppId);
  }
});

test('PostgreSQL row locking preserves the 24-hour and two-request limits', async () => {
  const customerWhatsAppId = customerId('eligibility');
  const time = clock();
  const store = createPostgresStore(database.pool, { now: time.nowIso });
  try {
    const concurrent = await Promise.allSettled([
      store.reservePermissionRequest(customerWhatsAppId),
      store.reservePermissionRequest(customerWhatsAppId),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected')[0].reason.name, 'EligibilityError');

    time.advanceHours(24);
    const second = await store.reservePermissionRequest(customerWhatsAppId);
    assert.equal(second.requestNumber, 2);
    await assert.rejects(
      () => store.reservePermissionRequest(customerWhatsAppId),
      (error) => error.name === 'EligibilityError',
    );
  } finally {
    await cleanup(customerWhatsAppId);
  }
});

test('PostgreSQL complete mocked gateway flow records Allow and ignores duplicate webhook', async () => {
  const customerWhatsAppId = customerId('gateway');
  const time = clock();
  const store = createPostgresStore(database.pool, { now: time.nowIso });
  const gateway = createGatewayService({
    store,
    logger: { info() {}, error() {} },
    now: time.nowDate,
    metaApi: {
      async getCallPermissionState() {
        return metaResult(stateBody());
      },
      async sendCallPermissionRequest() {
        return metaResult({ messages: [{ id: 'wamid.PG-GATEWAY' }] });
      },
    },
  });
  try {
    await gateway.handleWebhook(messagePayload({
      customerWhatsAppId,
      messageId: 'wamid.PG-GATEWAY-TRIGGER',
    }));
    const request = (await store.getCustomerState(customerWhatsAppId)).permissionRequests[0];
    const response = messagePayload({
      customerWhatsAppId,
      messageId: 'wamid.PG-GATEWAY-ALLOW',
      type: 'interactive',
      context: { id: request.permission_request_id },
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: {
          response: 'accept',
          is_permanent: true,
          response_source: 'user_action',
        },
      },
    });

    await gateway.handleWebhook(response);
    await gateway.handleWebhook(response);
    const state = await store.getCustomerState(customerWhatsAppId);
    const events = await store.getPermissionEvents(customerWhatsAppId);
    assert.equal(state.permission_status, 'permanent');
    assert.equal(state.permissionRequests[0].request_status, 'responded');
    assert.equal(state.permissionRequests[0].response, 'accept');
    assert.equal(events.length, 1);
    assert.equal(events[0].permission_status, 'permanent');
  } finally {
    await cleanup(customerWhatsAppId);
  }
});
