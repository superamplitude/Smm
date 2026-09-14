CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('customer','admin') NOT NULL DEFAULT 'customer',
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('active','blocked') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(120) NOT NULL,
  name VARCHAR(190) NOT NULL,
  description TEXT NULL,
  unit_label VARCHAR(60) NOT NULL DEFAULT 'unidade',
  min_qty INT NOT NULL DEFAULT 1,
  max_qty INT NOT NULL DEFAULT 1000,
  price_per_unit DECIMAL(12,4) NOT NULL,
  provider_code VARCHAR(190) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS supplier_servers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  api_type ENUM('smm_v2','generic_json') NOT NULL DEFAULT 'smm_v2',
  base_url VARCHAR(500) NOT NULL,
  api_key_enc TEXT NULL,
  services_endpoint VARCHAR(255) NULL,
  orders_endpoint VARCHAR(255) NULL,
  status_endpoint VARCHAR(255) NULL,
  webhook_url VARCHAR(500) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  last_test_status VARCHAR(40) NULL,
  last_test_at TIMESTAMP NULL,
  last_sync_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_supplier_active (active,is_primary)
);

CREATE TABLE IF NOT EXISTS service_supplier_links (
  service_id BIGINT UNSIGNED NOT NULL,
  supplier_id BIGINT UNSIGNED NOT NULL,
  supplier_service_code VARCHAR(190) NOT NULL,
  supplier_cost DECIMAL(12,4) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (service_id,supplier_id),
  INDEX idx_supplier_links_supplier (supplier_id,active),
  CONSTRAINT fk_service_supplier_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT fk_service_supplier_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supplier_catalog (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  supplier_id BIGINT UNSIGNED NOT NULL,
  supplier_service_code VARCHAR(190) NOT NULL,
  raw_name TEXT NOT NULL,
  raw_payload JSON NULL,
  clean_name VARCHAR(190) NULL,
  category VARCHAR(120) NULL,
  description TEXT NULL,
  min_qty INT NULL,
  max_qty INT NULL,
  supplier_cost DECIMAL(12,4) NULL,
  processed_by_ai TINYINT(1) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_supplier_catalog_code (supplier_id,supplier_service_code),
  INDEX idx_supplier_catalog_category (supplier_id,category),
  CONSTRAINT fk_supplier_catalog_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_integrations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  provider_type ENUM('gemini','openai_compatible') NOT NULL DEFAULT 'gemini',
  base_url VARCHAR(500) NULL,
  api_key_enc TEXT NULL,
  model VARCHAR(190) NOT NULL,
  prompt_base TEXT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  settings_json JSON NULL,
  last_test_status VARCHAR(40) NULL,
  last_test_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_integration_active (enabled,is_primary)
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  service_id BIGINT UNSIGNED NOT NULL,
  target_url TEXT NOT NULL,
  quantity INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  status ENUM('pending','processing','completed','partial','cancelled','refunded') NOT NULL DEFAULT 'pending',
  funds_refunded TINYINT(1) NOT NULL DEFAULT 0,
  provider_order_id VARCHAR(190) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_orders_service FOREIGN KEY (service_id) REFERENCES services(id)
);

CREATE TABLE IF NOT EXISTS supplier_order_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  supplier_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(80) NOT NULL,
  remote_order_id VARCHAR(190) NULL,
  payload JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_supplier_events_order (order_id,created_at),
  CONSTRAINT fk_supplier_events_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_supplier_events_supplier FOREIGN KEY (supplier_id) REFERENCES supplier_servers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  gateway ENUM('mercadopago','paypal') NOT NULL,
  external_id VARCHAR(190) NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'BRL',
  status ENUM('created','pending','approved','cancelled','refunded','failed') NOT NULL DEFAULT 'created',
  checkout_url TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  type ENUM('credit','debit','refund','adjustment') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  reference_type VARCHAR(40) NULL,
  reference_id BIGINT UNSIGNED NULL,
  description VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_wallet_user_created (user_id, created_at),
  INDEX idx_wallet_reference (reference_type, reference_id),
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  action VARCHAR(190) NOT NULL,
  payload JSON NULL,
  ip VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_decisions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NULL,
  decision_type VARCHAR(80) NOT NULL,
  input_json JSON NULL,
  output_json JSON NULL,
  status ENUM('completed','fallback','failed') NOT NULL DEFAULT 'completed',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_type_created (decision_type, created_at),
  INDEX idx_ai_user (user_id)
);
