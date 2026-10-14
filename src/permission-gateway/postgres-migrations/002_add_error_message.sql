ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE meta_api_calls ADD COLUMN IF NOT EXISTS error_message TEXT;
