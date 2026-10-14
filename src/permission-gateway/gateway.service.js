const { parseIncomingMessages } = require('./incoming-message.service');
const { evaluateEligibility } = require('./eligibility.service');
const { detectsPermissionTrigger } = require('./trigger.service');

function createGatewayService({
  store,
  metaApi,
  logger = console,
  now = () => new Date(),
}) {
  function logInfo(event, details) {
    if (logger.info) logger.info(event, details);
  }

  function logError(event, details) {
    if (logger.error) logger.error(event, details);
  }

  function errorResult(error) {
    return {
      ok: false,
      httpStatus: null,
      response: null,
      permissionRequestId: null,
      errorCode: null,
      errorSubcode: null,
      fbtraceId: null,
      errorMessage: error.name || 'MetaApiError',
    };
  }

  async function readPermissionState(customerWhatsAppId) {
    try {
      const result = await metaApi.getCallPermissionState(customerWhatsAppId);
      await store.recordMetaApiCall({
        customerWhatsAppId,
        operation: 'get_call_permission_state',
        result,
      });
      logInfo('meta_api_request_result', {
        operation: 'get_call_permission_state',
        customerWhatsAppId,
        httpStatus: result.httpStatus,
        ok: result.ok,
        errorCode: result.errorCode,
        errorSubcode: result.errorSubcode,
        fbtraceId: result.fbtraceId,
      });

      if (!result.ok) return { ok: false, result };

      const permission = result.response && result.response.permission;
      const actions = result.response && result.response.actions;
      const sendPermissionAction = Array.isArray(actions)
        ? actions.find((action) => action.action_name === 'send_call_permission_request')
        : null;

      if (
        !permission
        || !['no_permission', 'temporary', 'permanent'].includes(permission.status)
        || !sendPermissionAction
        || typeof sendPermissionAction.can_perform_action !== 'boolean'
      ) {
        return { ok: false, result, invalidResponse: true };
      }

      await store.updatePermissionState(
        customerWhatsAppId,
        permission.status,
        permission.expiration_time || null,
      );

      return {
        ok: true,
        status: permission.status,
        canSendPermissionRequest: sendPermissionAction.can_perform_action,
      };
    } catch (error) {
      const result = errorResult(error);
      await store.recordMetaApiCall({
        customerWhatsAppId,
        operation: 'get_call_permission_state',
        result,
        errorMessage: result.errorMessage,
      });
      logError('error', {
        operation: 'get_call_permission_state',
        customerWhatsAppId,
        errorType: result.errorMessage,
      });
      return { ok: false, result };
    }
  }

  async function sendPermissionRequest(customerWhatsAppId, request) {
    try {
      const result = await metaApi.sendCallPermissionRequest(customerWhatsAppId);
      await store.recordPermissionRequestResult({
        customerWhatsAppId,
        requestNumber: request.requestNumber,
        result,
      });
      logInfo('meta_api_request_result', {
        operation: 'send_call_permission_request',
        customerWhatsAppId,
        requestNumber: request.requestNumber,
        httpStatus: result.httpStatus,
        ok: result.ok,
        permissionRequestId: result.permissionRequestId,
        errorCode: result.errorCode,
        errorSubcode: result.errorSubcode,
        fbtraceId: result.fbtraceId,
      });
    } catch (error) {
      const result = errorResult(error);
      await store.recordPermissionRequestResult({
        customerWhatsAppId,
        requestNumber: request.requestNumber,
        result,
      });
      logError('error', {
        operation: 'send_call_permission_request',
        customerWhatsAppId,
        requestNumber: request.requestNumber,
        errorType: result.errorMessage,
      });
    }
  }

  async function handlePermissionResponse(message) {
    const reply = message.interactive && message.interactive.call_permission_reply;
    if (!reply || !['accept', 'reject'].includes(reply.response)) return false;

    const recorded = await store.recordPermissionResponse({
      customerWhatsAppId: message.customerWhatsAppId,
      messageId: message.messageId,
      contextId: message.context ? message.context.id : null,
      response: reply.response,
      isPermanent: reply.is_permanent,
      expirationTimestamp: reply.expiration_timestamp,
      responseSource: reply.response_source,
      timestamp: message.timestamp,
      payload: message.payload,
    });

    logInfo('permission_response', {
      customerWhatsAppId: message.customerWhatsAppId,
      messageId: message.messageId,
      response: reply.response,
      isPermanent: reply.is_permanent,
      responseSource: reply.response_source,
      recorded,
    });

    return true;
  }

  async function processTextMessage(message) {
    const triggered = detectsPermissionTrigger(message.messageText);
    logInfo('trigger_detection', {
      customerWhatsAppId: message.customerWhatsAppId,
      messageId: message.messageId,
      triggered,
    });
    if (!triggered) return;

    let customerState = await store.getCustomerState(message.customerWhatsAppId);
    let eligibility = evaluateEligibility(customerState, now());
    logInfo('eligibility_result', {
      customerWhatsAppId: message.customerWhatsAppId,
      eligible: eligibility.eligible,
      requestNumber: eligibility.requestNumber || null,
      reason: eligibility.reason,
    });
    if (!eligibility.eligible) return;

    const permissionState = await readPermissionState(message.customerWhatsAppId);
    if (!permissionState.ok) {
      logError('error', {
        operation: 'permission_eligibility_check',
        customerWhatsAppId: message.customerWhatsAppId,
        reason: permissionState.invalidResponse ? 'invalid_meta_response' : 'meta_request_failed',
      });
      return;
    }

    if (permissionState.status !== 'no_permission') {
      logInfo('eligibility_result', {
        customerWhatsAppId: message.customerWhatsAppId,
        eligible: false,
        reason: 'permission_already_granted',
      });
      return;
    }

    if (!permissionState.canSendPermissionRequest) {
      logInfo('eligibility_result', {
        customerWhatsAppId: message.customerWhatsAppId,
        eligible: false,
        reason: 'meta_action_not_permitted',
      });
      return;
    }

    customerState = await store.getCustomerState(message.customerWhatsAppId);
    eligibility = evaluateEligibility(customerState, now());
    if (!eligibility.eligible) return;

    let request;
    try {
      request = await store.reservePermissionRequest(message.customerWhatsAppId);
    } catch (error) {
      logError('error', {
        operation: 'reserve_permission_request',
        customerWhatsAppId: message.customerWhatsAppId,
        errorType: error.name,
      });
      return;
    }

    logInfo('database_update', {
      operation: 'reserve_permission_request',
      customerWhatsAppId: message.customerWhatsAppId,
      requestNumber: request.requestNumber,
    });
    await sendPermissionRequest(message.customerWhatsAppId, request);
  }

  async function handleWebhook(payload) {
    const messages = parseIncomingMessages(payload);

    for (const message of messages) {
      logInfo('incoming_message', {
        customerWhatsAppId: message.customerWhatsAppId,
        messageId: message.messageId,
        messageType: message.messageType,
        timestamp: message.timestamp,
      });

      const isNew = await store.recordIncomingMessage(message);
      if (!isNew) {
        logInfo('duplicate_event', { messageId: message.messageId });
        continue;
      }

      if (await handlePermissionResponse(message)) continue;
      if (message.messageType !== 'text') {
        logInfo('unsupported_event', {
          messageId: message.messageId,
          messageType: message.messageType,
        });
        continue;
      }

      await processTextMessage(message);
    }

    return { processed: messages.length };
  }

  return {
    handleWebhook,
  };
}

module.exports = {
  createGatewayService,
};
