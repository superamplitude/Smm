const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
  multipleStatements: true
});

const starterServices = [
  ['Conteúdo', 'Arte para feed', 'Criação de peça visual original para publicação em rede social.', 'arte', 1, 50, 45.00],
  ['Conteúdo', 'Edição de vídeo curto', 'Edição de vídeo vertical para Reels, Shorts ou TikTok.', 'vídeo', 1, 30, 90.00],
  ['Estratégia', 'Planejamento editorial mensal', 'Calendário editorial, temas, formatos e distribuição por canal.', 'pacote', 1, 12, 320.00],
  ['Social', 'Gestão mensal de perfil', 'Planejamento, publicação, monitoramento e relatório de um perfil.', 'perfil/mês', 1, 10, 690.00],
  ['Anúncios', 'Gestão de campanha paga', 'Configuração, acompanhamento e otimização de campanha; verba de mídia não inclusa.', 'campanha', 1, 20, 250.00],
  ['Analytics', 'Relatório de desempenho', 'Leitura de métricas, diagnóstico e plano de melhoria.', 'relatório', 1, 12, 180.00]
];

async function ensureColumn(table, column, definition) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  if (!rows.length) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
}

async function ensureIndex(table, indexName, definition) {
  const [rows] = await pool.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name=?`, [indexName]);
  if (!rows.length) await pool.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
}

async function migrateExistingDatabase() {
  await ensureColumn('supplier_servers', 'balance_endpoint', '`balance_endpoint` VARCHAR(255) NULL AFTER `status_endpoint`');
  await ensureColumn('supplier_servers', 'balance', '`balance` DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER `webhook_url`');
  await ensureColumn('supplier_servers', 'currency', '`currency` VARCHAR(16) NULL AFTER `balance`');
  await ensureColumn('supplier_servers', 'conversion_rate', '`conversion_rate` DECIMAL(18,8) NOT NULL DEFAULT 1 AFTER `currency`');
  await ensureColumn('supplier_servers', 'markup_percent', '`markup_percent` DECIMAL(8,2) NOT NULL DEFAULT 30 AFTER `conversion_rate`');
  await ensureColumn('supplier_servers', 'rate_divisor', '`rate_divisor` INT NOT NULL DEFAULT 1000 AFTER `markup_percent`');
  await ensureColumn('supplier_servers', 'auto_price_sync', '`auto_price_sync` TINYINT(1) NOT NULL DEFAULT 1 AFTER `rate_divisor`');
  await ensureColumn('supplier_servers', 'last_balance_at', '`last_balance_at` TIMESTAMP NULL AFTER `last_sync_at`');
  await ensureIndex('service_supplier_links', 'idx_supplier_service_code', 'INDEX `idx_supplier_service_code` (`supplier_id`,`supplier_service_code`)');

  await ensureColumn('orders', 'start_counter', '`start_counter` BIGINT NULL AFTER `provider_order_id`');
  await ensureColumn('orders', 'remains', '`remains` BIGINT NULL AFTER `start_counter`');
  await ensureColumn('orders', 'provider_status', '`provider_status` VARCHAR(80) NULL AFTER `remains`');
  await ensureColumn('orders', 'last_provider_sync_at', '`last_provider_sync_at` TIMESTAMP NULL AFTER `provider_status`');
  await ensureIndex('orders', 'idx_orders_user_status', 'INDEX `idx_orders_user_status` (`user_id`,`status`)');
  await ensureIndex('orders', 'idx_orders_provider', 'INDEX `idx_orders_provider` (`provider_order_id`,`status`)');

  await pool.query('ALTER TABLE services MODIFY COLUMN price_per_unit DECIMAL(12,6) NOT NULL');
  await pool.query('ALTER TABLE service_supplier_links MODIFY COLUMN supplier_cost DECIMAL(18,6) NULL');
  await pool.query('ALTER TABLE supplier_catalog MODIFY COLUMN supplier_cost DECIMAL(18,6) NULL');
}

async function initDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  await migrateExistingDatabase();

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword && adminPassword !== 'change-me-now') {
    const [rows] = await pool.query('SELECT id FROM users WHERE email=? LIMIT 1', [adminEmail.toLowerCase()]);
    if (!rows.length) {
      const hash = await bcrypt.hash(adminPassword, 12);
      await pool.query(
        "INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')",
        ['Administrador', adminEmail.toLowerCase(), hash]
      );
    }
  }

  const [[count]] = await pool.query('SELECT COUNT(*) total FROM services');
  if (Number(count.total) === 0) {
    for (const service of starterServices) {
      await pool.query(
        'INSERT INTO services (category,name,description,unit_label,min_qty,max_qty,price_per_unit) VALUES (?,?,?,?,?,?,?)',
        service
      );
    }
  }
}

module.exports = { pool, initDatabase };