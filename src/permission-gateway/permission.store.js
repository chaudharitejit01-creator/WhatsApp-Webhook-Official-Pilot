function createPermissionStore(db, { now = () => new Date().toISOString() } = {}) {
  const ensureCustomerStatement = db.prepare(`
    INSERT OR IGNORE INTO customers (customer_whatsapp_id, created_at, updated_at)
    VALUES (@customerWhatsAppId, @now, @now)
  `);

  function ensureCustomer(customerWhatsAppId) {
    ensureCustomerStatement.run({ customerWhatsAppId, now: now() });
  }

  function getCustomer(customerWhatsAppId) {
    return db.prepare('SELECT * FROM customers WHERE customer_whatsapp_id = ?')
      .get(customerWhatsAppId) || null;
  }

  function getRequests(customerWhatsAppId) {
    return db.prepare(`
      SELECT * FROM permission_requests
      WHERE customer_whatsapp_id = ?
      ORDER BY request_number ASC
    `).all(customerWhatsAppId);
  }

  function getCustomerState(customerWhatsAppId) {
    const customer = getCustomer(customerWhatsAppId);
    if (!customer) return null;

    return {
      ...customer,
      permissionRequests: getRequests(customerWhatsAppId),
    };
  }

  const recordIncomingMessage = db.transaction((message) => {
    ensureCustomer(message.customerWhatsAppId);

    const result = db.prepare(`
      INSERT OR IGNORE INTO incoming_messages (
        message_id,
        customer_whatsapp_id,
        message_type,
        message_text,
        webhook_timestamp,
        payload_json,
        received_at
      ) VALUES (@messageId, @customerWhatsAppId, @messageType, @messageText, @timestamp, @payloadJson, @receivedAt)
    `).run({
      messageId: message.messageId,
      customerWhatsAppId: message.customerWhatsAppId,
      messageType: message.messageType,
      messageText: message.messageText,
      timestamp: message.timestamp,
      payloadJson: JSON.stringify(message.payload),
      receivedAt: now(),
    });

    if (result.changes === 0) return false;

    db.prepare(`
      UPDATE customers
      SET last_incoming_message_id = ?, updated_at = ?
      WHERE customer_whatsapp_id = ?
    `).run(message.messageId, now(), message.customerWhatsAppId);

    return true;
  });

  const reservePermissionRequest = db.transaction((customerWhatsAppId) => {
    ensureCustomer(customerWhatsAppId);
    const customer = getCustomer(customerWhatsAppId);
    const requestNumber = customer.first_permission_request_at ? 2 : 1;
    const requestedAt = now();

    const result = db.prepare(`
      INSERT INTO permission_requests (
        customer_whatsapp_id,
        request_number,
        request_status,
        requested_at
      ) VALUES (?, ?, 'pending', ?)
    `).run(customerWhatsAppId, requestNumber, requestedAt);

    db.prepare(`
      UPDATE customers
      SET ${requestNumber === 1 ? 'first_permission_request_at' : 'second_permission_request_at'} = ?,
          updated_at = ?
      WHERE customer_whatsapp_id = ?
    `).run(requestedAt, requestedAt, customerWhatsAppId);

    return {
      id: Number(result.lastInsertRowid),
      requestNumber,
      requestedAt,
    };
  });

  function recordMetaApiCall({
    customerWhatsAppId,
    operation,
    result,
    errorMessage = null,
  }) {
    ensureCustomer(customerWhatsAppId);

    db.prepare(`
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      customerWhatsAppId,
      operation,
      now(),
      result.httpStatus || null,
      result.response === undefined ? null : JSON.stringify(result.response),
      result.permissionRequestId || null,
      result.errorCode || null,
      result.errorSubcode || null,
      result.fbtraceId || null,
      errorMessage,
    );
  }

  function updatePermissionRequest({ customerWhatsAppId, requestNumber, result }) {
    const requestStatus = result.ok ? 'sent' : 'error';
    const permissionRequestId = result.permissionRequestId || null;

    db.prepare(`
      UPDATE permission_requests
      SET request_status = ?,
          permission_request_id = ?,
          http_status = ?,
          meta_response_json = ?,
          error_code = ?,
          error_subcode = ?,
          fbtrace_id = ?,
          error_message = ?
      WHERE customer_whatsapp_id = ? AND request_number = ?
    `).run(
      requestStatus,
      permissionRequestId,
      result.httpStatus || null,
      result.response === undefined ? null : JSON.stringify(result.response),
      result.errorCode || null,
      result.errorSubcode || null,
      result.fbtraceId || null,
      result.errorMessage || null,
      customerWhatsAppId,
      requestNumber,
    );

    db.prepare(`
      UPDATE customers
      SET ${requestNumber === 1 ? 'first_permission_request_id' : 'second_permission_request_id'} = ?,
          updated_at = ?
      WHERE customer_whatsapp_id = ?
    `).run(permissionRequestId, now(), customerWhatsAppId);
  }

  const recordPermissionRequestResult = db.transaction((data) => {
    updatePermissionRequest(data);
    recordMetaApiCall({
      customerWhatsAppId: data.customerWhatsAppId,
      operation: 'send_call_permission_request',
      result: data.result,
      errorMessage: data.errorMessage || null,
    });
  });

  function updatePermissionState(customerWhatsAppId, permissionStatus, expirationTimestamp = null) {
    ensureCustomer(customerWhatsAppId);
    db.prepare(`
      UPDATE customers
      SET permission_status = ?, permission_expiration_timestamp = ?, updated_at = ?
      WHERE customer_whatsapp_id = ?
    `).run(permissionStatus, expirationTimestamp, now(), customerWhatsAppId);
  }

  const recordPermissionResponse = db.transaction((event) => {
    ensureCustomer(event.customerWhatsAppId);

    const status = event.response === 'accept'
      ? (event.isPermanent ? 'permanent' : 'temporary')
      : event.response === 'reject'
        ? 'no_permission'
        : null;

    const result = db.prepare(`
      INSERT OR IGNORE INTO permission_events (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.customerWhatsAppId,
      event.messageId,
      event.contextId || null,
      event.response || null,
      status,
      typeof event.isPermanent === 'boolean' ? Number(event.isPermanent) : null,
      event.expirationTimestamp || null,
      event.responseSource || null,
      event.timestamp,
      JSON.stringify(event.payload),
      now(),
    );

    if (result.changes === 0) return false;

    if (status) {
      updatePermissionState(event.customerWhatsAppId, status, event.expirationTimestamp || null);
    }

    const request = db.prepare(`
      SELECT * FROM permission_requests
      WHERE customer_whatsapp_id = ?
        AND request_status IN ('pending', 'sent')
      ORDER BY request_number DESC
      LIMIT 1
    `).get(event.customerWhatsAppId);

    if (request) {
      db.prepare(`
        UPDATE permission_requests
        SET request_status = 'responded', answered_at = ?, response = ?
        WHERE id = ?
      `).run(now(), event.response || null, request.id);
    }

    return true;
  });

  function getPermissionEvents(customerWhatsAppId) {
    return db.prepare(`
      SELECT * FROM permission_events
      WHERE customer_whatsapp_id = ?
      ORDER BY id ASC
    `).all(customerWhatsAppId);
  }

  function getMetaApiCalls(customerWhatsAppId) {
    return db.prepare(`
      SELECT * FROM meta_api_calls
      WHERE customer_whatsapp_id = ?
      ORDER BY id ASC
    `).all(customerWhatsAppId);
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
  createPermissionStore,
};
