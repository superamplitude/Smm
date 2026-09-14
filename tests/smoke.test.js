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

test('orders use unit pricing and AI risk analysis', () => {
  const server = read('server.js');
  assert.match(server, /price_per_unit/);
  assert.match(server, /analyzeOrder/);
  assert.match(server, /balance=balance-/);
});

test('deployment preserves environment file', () => {
  const deploy = read('deploy/deploy.sh');
  assert.match(deploy, /--exclude='\.env'/);
  assert.match(deploy, /health/);
});
