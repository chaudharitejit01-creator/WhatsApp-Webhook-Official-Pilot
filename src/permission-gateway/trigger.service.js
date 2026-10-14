const TRIGGER_LINE = 'Please send me a Call permission request.';

function detectsPermissionTrigger(messageText) {
  if (typeof messageText !== 'string') return false;
  return messageText.split(/\r?\n/).some((line) => line === TRIGGER_LINE);
}

module.exports = {
  TRIGGER_LINE,
  detectsPermissionTrigger,
};
