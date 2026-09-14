const { pool } = require('./db');
const { decryptSecret } = require('./secrets');

const trimSlash = value => String(value || '').replace(/\/+$/, '');
const joinUrl = (base, endpoint = '') => {
  const cleanBase = trimSlash(base);
  const cleanEndpoint = String(endpoint || '').trim();
  if (!cleanEndpoint) return cleanBase;
  if (/^https?:\/\//i.test(cleanEndpoint)) return cleanEndpoint;
  return `${cleanBase}/${cleanEndpoint.replace(/^\/+/, '')}`;
};

function normalizeProviderRow(row) {
  if (!row) return null;
  return {
    ...row,
    api_key: decryptSecret(row.api_key_enc || ''),
    active: Boolean(row.active),
    is_primary: Boolean(row.is_primary)
  };
}

async function getSupplier(id) {
  const [rows] = await pool.query('SELECT * FROM supplier_servers WHERE id=? LIMIT 1', [Number(id)]);
  return normalizeProviderRow(rows[0]);
}

async function getSupplierForService(serviceId) {
  const [linked] = await pool.query(
    `SELECT ss.*,ssl.supplier_service_code,ssl.supplier_cost
       FROM service_supplier_links ssl
       JOIN supplier_servers ss ON ss.id=ssl.supplier_id
      WHERE ssl.service_id=? AND ssl.active=1 AND ss.active=1
      ORDER BY ss.is_primary DESC, ss.id ASC LIMIT 1`,
    [Number(serviceId)]
  );
  if (linked.length) return normalizeProviderRow(linked[0]);

  const [serviceRows] = await pool.query('SELECT provider_code FROM services WHERE id=? LIMIT 1', [Number(serviceId)]);
  const providerCode = serviceRows[0]?.provider_code;
  if (!providerCode) return null;
  const [providers] = await pool.query('SELECT * FROM supplier_servers WHERE active=1 ORDER BY is_primary DESC,id ASC LIMIT 1');
  if (!providers.length) return null;
  return normalizeProviderRow({ ...providers[0], supplier_service_code: providerCode });
}

async function smmV2Request(supplier, fields) {
  const form = new URLSearchParams();
  form.set('key', supplier.api_key);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  const response = await fetch(joinUrl(supplier.base_url, supplier.orders_endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Fornecedor HTTP ${response.status}`);
  if (data?.error) throw new Error(String(data.error));
  return data;
}

async function genericJsonRequest(supplier, endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(joinUrl(supplier.base_url, endpoint), {
    method,
    headers: {
      Authorization: `Bearer ${supplier.api_key}`,
      'X-API-Key': supplier.api_key,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Fornecedor HTTP ${response.status}`);
  if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
  return data;
}

async function fetchSupplierServices(supplierOrId) {
  const supplier = typeof supplierOrId === 'object' ? supplierOrId : await getSupplier(supplierOrId);
  if (!supplier || !supplier.active) throw new Error('Fornecedor inativo ou inexistente');
  if (!supplier.api_key) throw new Error('API Key do fornecedor não configurada');

  if (supplier.api_type === 'smm_v2') return smmV2Request(supplier, { action: 'services' });
  const data = await genericJsonRequest(supplier, supplier.services_endpoint || '/services');
  return Array.isArray(data) ? data : (data.services || data.data || []);
}

function normalizeCatalogItem(item) {
  const code = item.service ?? item.id ?? item.code ?? item.service_id;
  const name = item.name ?? item.title ?? item.service_name ?? `Serviço ${code}`;
  return {
    code: String(code ?? ''),
    name: String(name || '').trim(),
    min: Number(item.min ?? item.min_qty ?? 1) || 1,
    max: Number(item.max ?? item.max_qty ?? 1000) || 1000,
    cost: Number(item.rate ?? item.price ?? item.cost ?? 0) || 0,
    raw: item
  };
}

async function syncSupplierCatalog(supplierId) {
  const supplier = await getSupplier(supplierId);
  const raw = await fetchSupplierServices(supplier);
  const rows = (Array.isArray(raw) ? raw : []).map(normalizeCatalogItem).filter(item => item.code && item.name);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of rows) {
      await conn.query(
        `INSERT INTO supplier_catalog (supplier_id,supplier_service_code,raw_name,raw_payload,min_qty,max_qty,supplier_cost,active)
         VALUES (?,?,?,?,?,?,?,1)
         ON DUPLICATE KEY UPDATE raw_name=VALUES(raw_name),raw_payload=VALUES(raw_payload),min_qty=VALUES(min_qty),max_qty=VALUES(max_qty),supplier_cost=VALUES(supplier_cost),active=1,processed_by_ai=0`,
        [supplier.id, item.code, item.name, JSON.stringify(item.raw), item.min, item.max, item.cost]
      );
    }
    await conn.query('UPDATE supplier_servers SET last_sync_at=NOW() WHERE id=?', [supplier.id]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { supplier_id: supplier.id, imported: rows.length };
}

async function submitOrderToSupplier({ serviceId, targetUrl, quantity }) {
  const supplier = await getSupplierForService(serviceId);
  if (!supplier) throw new Error('Nenhum fornecedor vinculado a este serviço');
  if (!supplier.api_key) throw new Error('API Key do fornecedor não configurada');
  const serviceCode = supplier.supplier_service_code;
  if (!serviceCode) throw new Error('Serviço sem código do fornecedor');

  let data;
  if (supplier.api_type === 'smm_v2') {
    data = await smmV2Request(supplier, { action: 'add', service: serviceCode, link: targetUrl, quantity });
  } else {
    data = await genericJsonRequest(supplier, supplier.orders_endpoint || '/orders', {
      method: 'POST',
      body: { service: serviceCode, service_id: serviceCode, link: targetUrl, target_url: targetUrl, quantity }
    });
  }

  const remoteId = data.order ?? data.id ?? data.order_id ?? data.data?.order_id ?? data.data?.id;
  if (!remoteId) throw new Error('Fornecedor não retornou o ID do pedido');
  return { supplier, remoteId: String(remoteId), raw: data };
}

async function fetchSupplierOrderStatus(supplierId, remoteOrderId) {
  const supplier = await getSupplier(supplierId);
  if (!supplier) throw new Error('Fornecedor não encontrado');
  if (supplier.api_type === 'smm_v2') return smmV2Request(supplier, { action: 'status', order: remoteOrderId });
  const endpoint = supplier.status_endpoint || '/orders/{id}';
  return genericJsonRequest(supplier, endpoint.replace('{id}', encodeURIComponent(remoteOrderId)));
}

async function testSupplierConnection(id) {
  const supplier = await getSupplier(id);
  try {
    const services = await fetchSupplierServices(supplier);
    const count = Array.isArray(services) ? services.length : 0;
    await pool.query('UPDATE supplier_servers SET last_test_status="connected",last_test_at=NOW() WHERE id=?', [id]);
    return { ok: true, count };
  } catch (error) {
    await pool.query('UPDATE supplier_servers SET last_test_status="failed",last_test_at=NOW() WHERE id=?', [id]).catch(() => {});
    return { ok: false, error: error.message };
  }
}

function mapSupplierStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['completed','complete','success','finished'].includes(status)) return 'completed';
  if (['partial','partially_completed'].includes(status)) return 'partial';
  if (['cancelled','canceled','refunded'].includes(status)) return 'cancelled';
  if (['in progress','in_progress','processing','progress'].includes(status)) return 'processing';
  return 'pending';
}

async function applyRemoteStatus(orderId, status, raw = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM orders WHERE id=? FOR UPDATE', [Number(orderId)]);
    if (!rows.length) {
      await conn.rollback();
      return;
    }
    const order = rows[0];
    if (status === 'cancelled' && !order.funds_refunded) {
      await conn.query('UPDATE users SET balance=balance+? WHERE id=?', [order.amount, order.user_id]);
      await conn.query(
        'INSERT INTO wallet_transactions (user_id,type,amount,reference_type,reference_id,description) VALUES (?,"refund",?,"order",?,?)',
        [order.user_id, order.amount, order.id, `Devolução automática do pedido #${order.id} cancelado pelo fornecedor`]
      );
      await conn.query('UPDATE orders SET status="cancelled",funds_refunded=1 WHERE id=?', [order.id]);
    } else if (!order.funds_refunded) {
      await conn.query('UPDATE orders SET status=? WHERE id=?', [status, order.id]);
    }
    await conn.query(
      'INSERT INTO supplier_order_events (order_id,event_type,remote_order_id,payload) VALUES (?,"status_sync",?,?,?)'.replace(',?,?,?)', ',?,?,?)'),
      [order.id, order.provider_order_id, JSON.stringify(raw)]
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function syncOpenSupplierOrders(limit = 100) {
  const [orders] = await pool.query(
    `SELECT o.id,o.provider_order_id,
      (SELECT supplier_id FROM supplier_order_events e WHERE e.order_id=o.id AND e.supplier_id IS NOT NULL ORDER BY e.id DESC LIMIT 1) supplier_id
     FROM orders o
     WHERE o.provider_order_id IS NOT NULL AND o.status IN ('pending','processing')
     ORDER BY o.id ASC LIMIT ?`,
    [Number(limit)]
  );
  let synced = 0;
  for (const order of orders) {
    if (!order.supplier_id) continue;
    try {
      const raw = await fetchSupplierOrderStatus(order.supplier_id, order.provider_order_id);
      const remoteStatus = raw.status ?? raw.data?.status ?? raw.state;
      await applyRemoteStatus(order.id, mapSupplierStatus(remoteStatus), raw);
      synced += 1;
    } catch (error) {
      await pool.query(
        'INSERT INTO supplier_order_events (order_id,supplier_id,event_type,remote_order_id,payload) VALUES (?,?,"status_error",?,?)',
        [order.id, order.supplier_id, order.provider_order_id, JSON.stringify({ error: error.message })]
      ).catch(() => {});
    }
  }
  return { synced };
}

function startSupplierScheduler() {
  const minutes = Math.max(1, Number(process.env.SUPPLIER_STATUS_INTERVAL_MINUTES || 5));
  const timer = setInterval(() => syncOpenSupplierOrders().catch(error => console.error('Supplier scheduler:', error.message)), minutes * 60 * 1000);
  timer.unref();
}

module.exports = {
  getSupplier,
  getSupplierForService,
  fetchSupplierServices,
  syncSupplierCatalog,
  submitOrderToSupplier,
  fetchSupplierOrderStatus,
  testSupplierConnection,
  mapSupplierStatus,
  syncOpenSupplierOrders,
  startSupplierScheduler
};
