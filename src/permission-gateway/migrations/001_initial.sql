CREATE TABLE IF NOT EXISTS customers (
  customer_whatsapp_id TEXT PRIMARY KEY,
  permission_status TEXT NOT NULL DEFAULT 'no_permission',
  permission_expiration_timestamp TEXT,
  first_permission_request_at TEXT,
  second_permission_request_at TEXT,
  first_permission_request_id TEXT,
  second_permission_request_id TEXT,
  last_incoming_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incoming_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  customer_whatsapp_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  message_text TEXT,
  webhook_timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  FOREIGN KEY (customer_whatsapp_id) REFERENCES customers(customer_whatsapp_id)
);

CREATE TABLE IF NOT EXISTS permission_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_whatsapp_id TEXT NOT NULL,
  request_number INTEGER NOT NULL CHECK (request_number IN (1, 2)),
  request_status TEXT NOT NULL,
  permission_request_id TEXT,
  requested_at TEXT NOT NULL,
  answered_at TEXT,
  response TEXT,
  http_status INTEGER,
  meta_response_json TEXT,
  error_code INTEGER,
  error_subcode INTEGER,
  fbtrace_id TEXT,
  UNIQUE (customer_whatsapp_id, request_number),
  FOREIGN KEY (customer_whatsapp_id) REFERENCES customers(customer_whatsapp_id)
);

CREATE TABLE IF NOT EXISTS permission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_whatsapp_id TEXT NOT NULL,
  event_message_id TEXT NOT NULL UNIQUE,
  context_id TEXT,
  response TEXT,
  permission_status TEXT,
  is_permanent INTEGER,
  expiration_timestamp TEXT,
  response_source TEXT,
  webhook_timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_whatsapp_id) REFERENCES customers(customer_whatsapp_id)
);

CREATE TABLE IF NOT EXISTS meta_api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_whatsapp_id TEXT,
  operation TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  http_status INTEGER,
  meta_response_json TEXT,
  permission_request_id TEXT,
  error_code INTEGER,
  error_subcode INTEGER,
  fbtrace_id TEXT,
  FOREIGN KEY (customer_whatsapp_id) REFERENCES customers(customer_whatsapp_id)
);

CREATE INDEX IF NOT EXISTS idx_incoming_messages_customer
  ON incoming_messages(customer_whatsapp_id);

CREATE INDEX IF NOT EXISTS idx_permission_requests_customer
  ON permission_requests(customer_whatsapp_id);

CREATE INDEX IF NOT EXISTS idx_permission_events_customer
  ON permission_events(customer_whatsapp_id);
