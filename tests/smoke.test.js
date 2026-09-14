const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('critical production files exist', () => {
  for (const file of ['server.js','src/db.js','src/ai.js','src/payments.js','src/schema.sql','public/index.html','public/app.js','deploy/deploy.sh','deploy/bootstrap-vps.sh']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} ausente`);
  }
});

test('runtime secrets are ignored', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /node_modules\//);
});

test('wallet and AI audit tables are present', () => {
  const schema = read('src/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS wallet_transactions/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS ai_decisions/);
  assert.match(schema, /funds_refunded/);
});

test('orders use unit pricing, wallet debit and AI risk analysis', () => {
  const server = read('server.js');
  assert.match(server, /price_per_unit/);
  assert.match(server, /analyzeOrder/);
  assert.match(server, /balance=balance-/);
  assert.match(server, /order_rejected_by_policy/);
});

test('admin command center exposes operational APIs', () => {
  const server = read('server.js');
  for (const route of ['/api/admin/overview','/api/admin/orders','/api/admin/users','/api/admin/payments','/api/admin/services','/api/admin/ai/decisions','/api/admin/audit']) {
    assert.equal(server.includes(route), true, `${route} ausente`);
  }
  assert.match(server, /user_status_changed/);
  assert.match(server, /ai_decision_reviewed/);
  assert.match(server, /service_updated/);
});

test('readiness checks database without requiring external AI', () => {
  const server = read('server.js');
  assert.equal(server.includes("app.get('/ready'"), true);
  assert.match(server, /SELECT 1 AS ok/);
  assert.match(server, /aiConfigured/);
});

test('AI recommendations are grounded in active catalog', () => {
  const ai = read('src/ai.js');
  assert.match(ai, /FROM services WHERE active=1/);
  assert.match(ai, /service_id/);
  assert.match(ai, /allowedIds/);
  assert.match(ai, /fallbackRecommendations/);
});

test('admin UI contains command center surfaces', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  for (const id of ['adminOrdersTable','adminUsersTable','adminPaymentsTable','adminAiTable','adminServicesTable','adminAuditTable']) {
    assert.equal(html.includes(`id="${id}"`), true, `${id} ausente`);
  }
  assert.match(app, /loadAdminOverview/);
  assert.match(app, /loadAdminOrders/);
  assert.match(app, /loadAdminAudit/);
});

test('deployment preserves environment file', () => {
  const deploy = read('deploy/deploy.sh');
  assert.match(deploy, /--exclude='\.env'/);
  assert.match(deploy, /health/);
});
