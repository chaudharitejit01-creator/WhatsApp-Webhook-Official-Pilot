const { evaluateEligibility } = require('./eligibility.service');

function createPostgresStore(pool, { now = () => new Date().toISOString() } = {}) {
  async function withTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original database error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function ensureCustomer(client, customerWhatsAppId, timestamp = now()) {
    await client.query(`
      INSERT INTO customers (customer_whatsapp_id, created_at, updated_at)
      VALUES ($1, $2, $2)
      ON CONFLICT (customer_whatsapp_id) DO NOTHING
    `, [customerWhatsAppId, timestamp]);
  }

  async function getCustomer(customerWhatsAppId) {
    const result = await pool.query(
      'SELECT * FROM customers WHERE customer_whatsapp_id = $1',
      [customerWhatsAppId],
    );
    return result.rows[0] || null;
  }

  async function getRequests(customerWhatsAppId) {
    const result = await pool.query(`
      SELECT * FROM permission_requests
      WHERE customer_whatsapp_id = $1
      ORDER BY request_number ASC
    `, [customerWhatsAppId]);
    return result.rows;
  }

  async function getCustomerState(customerWhatsAppId) {
    const customer = await getCustomer(customerWhatsAppId);
    if (!customer) return null;

    return {
      ...customer,
      permissionRequests: await getRequests(customerWhatsAppId),
    };
  }

  async function recordIncomingMessage(message) {
    return withTransaction(async (client) => {
      const receivedAt = now();
      await ensureCustomer(client, message.customerWhatsAppId, receivedAt);

      const result = await client.query(`
        INSERT INTO incoming_messages (
          message_id,
          customer_whatsapp_id,
          message_type,
          message_text,
          webhook_timestamp,
          payload_json,
          received_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (message_id) DO NOTHING
        RETURNING message_id
      `, [
        message.messageId,
        message.customerWhatsAppId,
        message.messageType,
        message.messageText,
        message.timestamp,
        JSON.stringify(message.payload),
        receivedAt,
      ]);

      if (result.rowCount === 0) return false;

      await client.query(`
        UPDATE customers
        SET last_incoming_message_id = $1, updated_at = $2
        WHERE customer_whatsapp_id = $3
      `, [message.messageId, now(), message.customerWhatsAppId]);

      return true;
    });
  }

  async function reservePermissionRequest(customerWhatsAppId) {
    return withTransaction(async (client) => {
      const requestedAt = now();
      await ensureCustomer(client, customerWhatsAppId, requestedAt);

      const customer = (await client.query(`
        SELECT * FROM customers
        WHERE customer_whatsapp_id = $1
        FOR UPDATE
      `, [customerWhatsAppId])).rows[0];
      const requests = (await client.query(`
        SELECT * FROM permission_requests
        WHERE customer_whatsapp_id = $1
        ORDER BY request_number ASC
      `, [customerWhatsAppId])).rows;
      const eligibility = evaluateEligibility(
        { ...customer, permissionRequests: requests },
        new Date(requestedAt),
      );

      if (!eligibility.eligible) {
        const error = new Error(`Permission request is not eligible: ${eligibility.reason}`);
        error.name = 'EligibilityError';
        throw error;
      }

      const requestNumber = eligibility.requestNumber;
      const result = await client.query(`
        INSERT INTO permission_requests (
          customer_whatsapp_id,
          request_number,
          request_status,
          requested_at
        ) VALUES ($1, $2, 'pending', $3)
        RETURNING id
      `, [customerWhatsAppId, requestNumber, requestedAt]);

      await client.query(`
        UPDATE customers
        SET ${requestNumber === 1 ? 'first_permission_request_at' : 'second_permission_request_at'} = $1,
            updated_at = $2
        WHERE customer_whatsapp_id = $3
      `, [requestedAt, requestedAt, customerWhatsAppId]);

      return {
        id: Number(result.rows[0].id),
        requestNumber,
        requestedAt,
      };
    });
  }

  async function recordMetaApiCall({ customerWhatsAppId, operation, result, errorMessage = null }) {
    return withTransaction(async (client) => {
      if (customerWhatsAppId) await ensureCustomer(client, customerWhatsAppId);
      await client.query(`
        INSERT INTO meta_api_calls (
          customer_whatsapp_id,
          operation,
          requested_at,
          http_status,
          meta_response_json,
          permission_request_id,
          error_code,
          error_subcode,
          fbtrace_id,
          error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        customerWhatsAppId || null,
        operation,
        now(),
        result.httpStatus || null,
        result.response === undefined ? null : JSON.stringify(result.response),
        result.permissionRequestId || null,
        result.errorCode || null,
        result.errorSubcode || null,
        result.fbtraceId || null,
        errorMessage,
      ]);
    });
  }

  async function recordPermissionRequestResult({ customerWhatsAppId, requestNumber, result, errorMessage = null }) {
    return withTransaction(async (client) => {
      await client.query(`
        SELECT customer_whatsapp_id FROM customers
        WHERE customer_whatsapp_id = $1
        FOR UPDATE
      `, [customerWhatsAppId]);
      const request = (await client.query(`
        SELECT request_status FROM permission_requests
        WHERE customer_whatsapp_id = $1 AND request_number = $2
        FOR UPDATE
      `, [customerWhatsAppId, requestNumber])).rows[0];
      const requestStatus = request?.request_status === 'responded'
        ? 'responded'
        : result.ok ? 'sent' : 'error';
      const permissionRequestId = result.permissionRequestId || null;

      await client.query(`
        UPDATE permission_requests
        SET request_status = $1,
            permission_request_id = $2,
            http_status = $3,
            meta_response_json = $4,
            error_code = $5,
            error_subcode = $6,
            fbtrace_id = $7,
            error_message = $8
        WHERE customer_whatsapp_id = $9 AND request_number = $10
      `, [
        requestStatus,
        permissionRequestId,
        result.httpStatus || null,
        result.response === undefined ? null : JSON.stringify(result.response),
        result.errorCode || null,
        result.errorSubcode || null,
        result.fbtraceId || null,
        result.errorMessage || errorMessage,
        customerWhatsAppId,
        requestNumber,
      ]);

      await client.query(`
        UPDATE customers
        SET ${requestNumber === 1 ? 'first_permission_request_id' : 'second_permission_request_id'} = $1,
            updated_at = $2
        WHERE customer_whatsapp_id = $3
      `, [permissionRequestId, now(), customerWhatsAppId]);

      await client.query(`
        INSERT INTO meta_api_calls (
          customer_whatsapp_id,
          operation,
          requested_at,
          http_status,
          meta_response_json,
          permission_request_id,
          error_code,
          error_subcode,
          fbtrace_id,
          error_message
        ) VALUES ($1, 'send_call_permission_request', $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        customerWhatsAppId,
        now(),
        result.httpStatus || null,
        result.response === undefined ? null : JSON.stringify(result.response),
        permissionRequestId,
        result.errorCode || null,
        result.errorSubcode || null,
        result.fbtraceId || null,
        result.errorMessage || errorMessage,
      ]);
    });
  }

  async function updatePermissionState(customerWhatsAppId, permissionStatus, expirationTimestamp = null) {
    return withTransaction(async (client) => {
      await ensureCustomer(client, customerWhatsAppId);
      await client.query(`
        SELECT customer_whatsapp_id FROM customers
        WHERE customer_whatsapp_id = $1
        FOR UPDATE
      `, [customerWhatsAppId]);
      await client.query(`
        UPDATE customers
        SET permission_status = $1, permission_expiration_timestamp = $2, updated_at = $3
        WHERE customer_whatsapp_id = $4
      `, [permissionStatus, expirationTimestamp, now(), customerWhatsAppId]);
    });
  }

  async function recordPermissionResponse(event) {
    return withTransaction(async (client) => {
      await ensureCustomer(client, event.customerWhatsAppId);
      await client.query(`
        SELECT customer_whatsapp_id FROM customers
        WHERE customer_whatsapp_id = $1
        FOR UPDATE
      `, [event.customerWhatsAppId]);

      const status = event.response === 'accept'
        ? (event.isPermanent ? 'permanent' : 'temporary')
        : event.response === 'reject'
          ? 'no_permission'
          : null;
      const result = await client.query(`
        INSERT INTO permission_events (
          customer_whatsapp_id,
          event_message_id,
          context_id,
          response,
          permission_status,
          is_permanent,
          expiration_timestamp,
          response_source,
          webhook_timestamp,
          payload_json,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (event_message_id) DO NOTHING
        RETURNING id
      `, [
        event.customerWhatsAppId,
        event.messageId,
        event.contextId || null,
        event.response || null,
        status,
        typeof event.isPermanent === 'boolean' ? event.isPermanent : null,
        event.expirationTimestamp || null,
        event.responseSource || null,
        event.timestamp,
        JSON.stringify(event.payload),
        now(),
      ]);

      if (result.rowCount === 0) return false;

      if (status) {
        await client.query(`
          UPDATE customers
          SET permission_status = $1, permission_expiration_timestamp = $2, updated_at = $3
          WHERE customer_whatsapp_id = $4
        `, [status, event.expirationTimestamp || null, now(), event.customerWhatsAppId]);
      }

      const request = (await client.query(`
        SELECT id FROM permission_requests
        WHERE customer_whatsapp_id = $1
          AND request_status IN ('pending', 'sent')
        ORDER BY request_number DESC
        LIMIT 1
        FOR UPDATE
      `, [event.customerWhatsAppId])).rows[0];
      if (request) {
        await client.query(`
          UPDATE permission_requests
          SET request_status = 'responded', answered_at = $1, response = $2
          WHERE id = $3
        `, [now(), event.response || null, request.id]);
      }

      return true;
    });
  }

  async function getPermissionEvents(customerWhatsAppId) {
    const result = await pool.query(`
      SELECT * FROM permission_events
      WHERE customer_whatsapp_id = $1
      ORDER BY id ASC
    `, [customerWhatsAppId]);
    return result.rows;
  }

  async function getMetaApiCalls(customerWhatsAppId) {
    const result = await pool.query(`
      SELECT * FROM meta_api_calls
      WHERE customer_whatsapp_id = $1
      ORDER BY id ASC
    `, [customerWhatsAppId]);
    return result.rows;
  }

  return {
    getCustomer,
    getCustomerState,
    getMetaApiCalls,
    getPermissionEvents,
    recordMetaApiCall,
    recordIncomingMessage,
    recordPermissionRequestResult,
    recordPermissionResponse,
    reservePermissionRequest,
    updatePermissionState,
  };
}

module.exports = {
  createPostgresStore,
};
