function verifyWebhookSubscription(query, verifyToken) {
  const { 'hub.mode': mode, 'hub.verify_token': token } = query;

  return mode === 'subscribe' && token === verifyToken;
}

function createMetaApiService({
  accessToken,
  cloudApiVersion,
  phoneNumberId,
  fetchImpl = globalThis.fetch,
}) {
  function requireConfiguration() {
    if (!accessToken || !phoneNumberId) {
      throw new Error('Meta API configuration is incomplete');
    }
  }

  async function request(path, options = {}) {
    requireConfiguration();

    const response = await fetchImpl(`https://graph.facebook.com/${cloudApiVersion}/${phoneNumberId}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const error = body && body.error ? body.error : null;

    return {
      ok: response.ok,
      httpStatus: response.status,
      response: body,
      permissionRequestId: body && body.messages && body.messages[0] ? body.messages[0].id || null : null,
      errorCode: error ? error.code || null : null,
      errorSubcode: error ? error.error_subcode || null : null,
      fbtraceId: error ? error.fbtrace_id || null : null,
    };
  }

  function callPermissionRequestBody(customerWhatsAppId) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: customerWhatsAppId,
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: {
          name: 'call_permission_request',
        },
        body: {
          text: 'Allow us to call you so we can support you with your order.',
        },
      },
    };
  }

  async function sendCallPermissionRequest(customerWhatsAppId) {
    const payload = callPermissionRequestBody(customerWhatsAppId);

    return request('/messages', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async function getCallPermissionState(customerWhatsAppId) {
    return request(`/call_permissions?user_wa_id=${encodeURIComponent(customerWhatsAppId)}`, {
      method: 'GET',
    });
  }

  return {
    callPermissionRequestBody,
    getCallPermissionState,
    sendCallPermissionRequest,
  };
}

module.exports = {
  createMetaApiService,
  verifyWebhookSubscription,
};
