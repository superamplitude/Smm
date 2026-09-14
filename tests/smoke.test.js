const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('critical production files exist', () => {
  for (const file of ['server.js','src/db.js','src/ai.js','src/payments.js','src/suppliers.js','src/secrets.js','src/admin-integrations.js','src/schema.sql','public/index.html','public/app.js','public/admin/index.html','public/admin/admin.css','public/admin/admin.js','deploy/deploy.sh','deploy/bootstrap-vps.sh']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} ausente`);
  }
});

test('runtime secrets are ignored', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /node_modules\//);
});

test('financial, supplier and AI tables are present', () => {
  const schema = read('src/schema.sql');
  for (const table of ['wallet_transactions','ai_decisions','supplier_servers','service_supplier_links','supplier_catalog','ai_integrations','supplier_order_events']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const field of ['conversion_rate','markup_percent','rate_divisor','auto_price_sync','last_balance_at']) assert.match(schema, new RegExp(field));
  assert.match(schema, /funds_refunded/);
});

test('existing databases receive supplier finance migrations', () => {
  const db = read('src/db.js');
  for (const field of ['balance_endpoint','balance','currency','conversion_rate','markup_percent','rate_divisor','auto_price_sync','last_balance_at']) assert.match(db, new RegExp(field));
  assert.match(db, /MODIFY COLUMN price_per_unit DECIMAL\(12,6\)/);
});

test('integration secrets are encrypted at rest', () => {
  const secrets = read('src/secrets.js');
  assert.match(secrets, /aes-256-gcm/);
  assert.match(secrets, /CONFIG_ENCRYPTION_KEY/);
  assert.match(read('src/admin-integrations.js'), /encryptSecret/);
});

test('orders debit wallet and are submitted directly to supplier', () => {
  const server = read('server.js');
  assert.match(server, /price_per_unit/);
  assert.match(server, /balance=balance-/);
  assert.match(server, /submitOrderToSupplier/);
  assert.match(server, /order_sent_to_supplier/);
  assert.match(server, /refundOrderAfterSupplierFailure/);
});

test('supplier gateway supports catalog, balance, publishing, pricing, order and status flow', () => {
  const supplier = read('src/suppliers.js');
  assert.match(supplier, /action: 'services'/);
  assert.match(supplier, /action: 'balance'/);
  assert.match(supplier, /action: 'add'/);
  assert.match(supplier, /action: 'status'/);
  assert.match(supplier, /publishSupplierCatalog/);
  assert.match(supplier, /repriceLinkedServices/);
  assert.match(supplier, /calculateSaleUnitPrice/);
  assert.match(supplier, /syncOpenSupplierOrders/);
  assert.match(supplier, /startSupplierScheduler/);
  assert.match(supplier, /supplier_id,event_type,remote_order_id,payload/);
});

test('admin command center exposes operational and supplier APIs', () => {
  const server = read('server.js');
  for (const route of ['/api/admin/overview','/api/admin/orders','/api/admin/users','/api/admin/payments','/api/admin/services','/api/admin/ai/decisions','/api/admin/audit']) {
    assert.equal(server.includes(route), true, `${route} ausente`);
  }
  const integrations = read('src/admin-integrations.js');
  for (const route of ['/suppliers','/suppliers/:id/balance','/suppliers/:id/reprice','/suppliers/:id/publish','/ai-integrations','/integrations/status']) {
    assert.equal(integrations.includes(route), true, `${route} ausente`);
  }
});

test('readiness checks database and dynamic AI configuration', () => {
  const server = read('server.js');
  assert.equal(server.includes("app.get('/ready'"), true);
  assert.match(server, /SELECT 1 AS ok/);
  assert.match(server, /await aiConfigured/);
});

test('AI organizes supplier text without inventing source codes', () => {
  const ai = read('src/ai.js');
  assert.match(ai, /categorizeSupplierCatalog/);
  assert.match(ai, /supplier_catalog/);
  assert.match(ai, /Não invente produtos/);
  assert.match(ai, /source_code/);
  assert.match(ai, /gemini/);
});

test('dedicated super admin contains supplier, AI, finance and catalog controls', () => {
  const html = read('public/admin/index.html');
  for (const id of ['supplierForm','suppliersTable','aiIntegrationForm','aiIntegrationsTable','catalogSupplierSelect','categoryCards','publishCatalogBtn','serviceSupplierSelect','ordersTable']) {
    assert.equal(html.includes(`id="${id}"`), true, `${id} ausente no Super ADM`);
  }
  for (const field of ['conversion_rate','markup_percent','rate_divisor','balance_endpoint','auto_price_sync']) assert.match(html, new RegExp(`name="${field}"`));
  const admin = read('public/admin/admin.js');
  assert.match(admin, /Sincronizar \+ IA/);
  assert.match(admin, /supplierBalance/);
  assert.match(admin, /supplierPublish/);
  assert.match(admin, /supplierReprice/);
  assert.match(read('public/index.html'), /href="\/admin\/"/);
});

test('deployment preserves environment file', () => {
  const deploy = read('deploy/deploy.sh');
  assert.match(deploy, /--exclude='\.env'/);
  assert.match(deploy, /health/);
});