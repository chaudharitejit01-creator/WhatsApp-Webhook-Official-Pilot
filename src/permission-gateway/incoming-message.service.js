function parseIncomingMessages(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return [];
  }

  const messages = [];

  for (const entry of payload.entry) {
    if (!entry || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (!change || change.field !== 'messages' || !change.value || !Array.isArray(change.value.messages)) {
        continue;
      }

      for (const message of change.value.messages) {
        if (!message || !message.id || !message.from || !message.timestamp || !message.type) {
          continue;
        }

        messages.push({
          customerWhatsAppId: message.from,
          messageId: message.id,
          messageText: message.type === 'text' && message.text ? message.text.body || null : null,
          timestamp: message.timestamp,
          messageType: message.type,
          payload: message,
          context: message.context || null,
          interactive: message.interactive || null,
        });
      }
    }
  }

  return messages;
}

module.exports = {
  parseIncomingMessages,
};
