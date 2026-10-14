const SECOND_REQUEST_DELAY_MS = 24 * 60 * 60 * 1000;

function evaluateEligibility(customerState, now = new Date()) {
  if (!customerState) {
    return { eligible: true, requestNumber: 1, reason: 'new_customer' };
  }

  if (customerState.permission_status === 'temporary' || customerState.permission_status === 'permanent') {
    return { eligible: false, reason: 'permission_already_granted' };
  }

  const requests = customerState.permissionRequests || [];
  if (requests.length >= 2) {
    return { eligible: false, reason: 'maximum_requests_reached' };
  }

  const firstRequest = requests.find((request) => request.request_number === 1);
  if (!firstRequest) {
    return { eligible: true, requestNumber: 1, reason: 'first_request' };
  }

  if (firstRequest.request_status === 'responded' || firstRequest.response) {
    return { eligible: false, reason: 'first_request_answered' };
  }

  const firstRequestedAt = Date.parse(firstRequest.requested_at);
  const elapsed = now.getTime() - firstRequestedAt;
  if (!Number.isFinite(firstRequestedAt) || elapsed < SECOND_REQUEST_DELAY_MS) {
    return { eligible: false, reason: 'second_request_wait_period' };
  }

  return { eligible: true, requestNumber: 2, reason: 'second_request_after_24_hours' };
}

module.exports = {
  SECOND_REQUEST_DELAY_MS,
  evaluateEligibility,
};
