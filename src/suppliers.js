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
    is_primary: Boolean(row.is_primary),
    auto_price_sync: Boolean(row.auto_price_sync),
    balance: Number(row.balance || 0),
    conversion_rate: Number(row.conversion_rate || 1),
    markup_percent: Number(row.markup_percent || 0),
    rate_divisor: Math.max(1, Number(row.rate_divisor || 1000))
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

async function fetchSupplierBalance(supplierOrId) {
  const supplier = typeof supplierOrId === 'object' ? supplierOrId : await getSupplier(supplierOrId);
  if (!supplier || !supplier.active) throw new Error('Fornecedor inativo ou inexistente');
  if (!supplier.api_key) throw new Error('API Key do fornecedor não configurada');
  if (supplier.api_type === 'smm_v2') return smmV2Request(supplier, { action: 'balance' });
  return genericJsonRequest(supplier, supplier.balance_endpoint || '/balance');
}

async function refreshSupplierBalance(supplierId) {
  const supplier = await getSupplier(supplierId);
  const data = await fetchSupplierBalance(supplier);
  const balance = Number(data.balance ?? data.data?.balance ?? data.amount ?? 0);
  const currency = String(data.currency ?? data.data?.currency ?? supplier.currency ?? '').trim().slice(0, 16) || null;
  if (!Number.isFinite(balance)) throw new Error('Fornecedor retornou saldo inválido');
  await pool.query('UPDATE supplier_servers SET balance=?,currency=?,last_balance_at=NOW() WHERE id=?', [balance, currency, supplier.id]);
  return { ok: true, supplier_id: supplier.id, balance, currency };
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

function calculateSaleUnitPrice(supplier, supplierCost, markupOverride = null) {
  const cost = Number(supplierCost || 0);
  const conversion = Math.max(0.00000001, Number(supplier.conversion_rate || 1));
  const markup = markupOverride === null ? Number(supplier.markup_percent || 0) : Number(markupOverride || 0);
  const divisor = Math.max(1, Number(supplier.rate_divisor || 1000));
  return Math.max(0, (cost * conversion * (1 + (markup / 100))) / divisor);
}

async function repriceLinkedServices(supplierId, markupOverride = null) {
  const supplier = await getSupplier(supplierId);
  if (!supplier) throw new Error('Fornecedor não encontrado');
  const [rows] = await pool.query(
    `SELECT ssl.service_id,ssl.supplier_service_code,COALESCE(sc.supplier_cost,ssl.supplier_cost,0) supplier_cost
       FROM service_supplier_links ssl
       LEFT JOIN supplier_catalog sc ON sc.supplier_id=ssl.supplier_id AND sc.supplier_service_code=ssl.supplier_service_code
      WHERE ssl.supplier_id=? AND ssl.active=1`,
    [supplier.id]
  );
  let updated = 0;
  for (const row of rows) {
    const cost = Number(row.supplier_cost || 0);
    if (!(cost > 0)) continue;
    const price = calculateSaleUnitPrice(supplier, cost, markupOverride);
    await pool.query('UPDATE service_supplier_links SET supplier_cost=? WHERE service_id=? AND supplier_id=?', [cost, row.service_id, supplier.id]);
    await pool.query('UPDATE services SET price_per_unit=? WHERE id=?', [price, row.service_id]);
    updated += 1;
  }
  return { ok: true, supplier_id: supplier.id, updated, markup_percent: markupOverride === null ? supplier.markup_percent : Number(markupOverride) };
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
      await conn.query('UPDATE service_supplier_links SET supplier_cost=? WHERE supplier_id=? AND supplier_service_code=?', [item.cost, supplier.id, item.code]);
    }
    await conn.query('UPDATE supplier_servers SET last_sync_at=NOW() WHERE id=?', [supplier.id]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  let repriced = 0;
  if (supplier.auto_price_sync) {
    const result = await repriceLinkedServices(supplier.id);
    repriced = result.updated;
  }
  return { supplier_id: supplier.id, imported: rows.length, repriced };
}

async function publishSupplierCatalog(supplierId, { markupPercent = null } = {}) {
  const supplier = await getSupplier(supplierId);
  if (!supplier) throw new Error('Fornecedor não encontrado');
  const [items] = await pool.query(
    `SELECT supplier_service_code,raw_name,clean_name,category,description,min_qty,max_qty,supplier_cost
       FROM supplier_catalog
      WHERE supplier_id=? AND active=1
      ORDER BY category,clean_name,raw_name`,
    [supplier.id]
  );
  const conn = await pool.getConnection();
  let created = 0;
  let updated = 0;
  let skipped = 0;
  try {
    await conn.beginTransaction();
    for (const item of items) {
      const cost = Number(item.supplier_cost || 0);
      if (!(cost > 0)) { skipped += 1; continue; }
      const name = String(item.clean_name || item.raw_name || '').trim().slice(0, 190);
      const category = String(item.category || 'Outros').trim().slice(0, 120) || 'Outros';
      if (!name) { skipped += 1; continue; }
      const pricePerUnit = calculateSaleUnitPrice(supplier, cost, markupPercent);
      const minQty = Math.max(1, Number(item.min_qty || 1));
      const maxQty = Math.max(minQty, Number(item.max_qty || 1000));
      const [links] = await conn.query('SELECT service_id FROM service_supplier_links WHERE supplier_id=? AND supplier_service_code=? LIMIT 1', [supplier.id, String(item.supplier_service_code)]);
      let serviceId;
      if (links.length) {
        serviceId = links[0].service_id;
        await conn.query(
          'UPDATE services SET category=?,name=?,description=?,unit_label="unidade",min_qty=?,max_qty=?,price_per_unit=?,provider_code=?,active=1 WHERE id=?',
          [category, name, String(item.description || '').slice(0, 4000), minQty, maxQty, pricePerUnit, String(item.supplier_service_code), serviceId]
        );
        await conn.query('UPDATE service_supplier_links SET supplier_cost=?,active=1 WHERE service_id=? AND supplier_id=?', [cost, serviceId, supplier.id]);
        updated += 1;
      } else {
        const [service] = await conn.query(
          'INSERT INTO services (category,name,description,unit_label,min_qty,max_qty,price_per_unit,provider_code,active) VALUES (?,?,?,"unidade",?,?,?,?,1)',
          [category, name, String(item.description || '').slice(0, 4000), minQty, maxQty, pricePerUnit, String(item.supplier_service_code)]
        );
        serviceId = service.insertId;
        await conn.query('INSERT INTO service_supplier_links (service_id,supplier_id,supplier_service_code,supplier_cost,active) VALUES (?,?,?,?,1)', [serviceId, supplier.id, String(item.supplier_service_code), cost]);
        created += 1;
      }
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { ok: true, supplier_id: supplier.id, created, updated, skipped, total: items.length };
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

async function applyRemoteStatus(orderId, supplierId, status, raw = {}) {
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
    await conn.query('INSERT INTO supplier_order_events (order_id,supplier_id,event_type,remote_order_id,payload) VALUES (?,? ,"status_sync",?,?)', [order.id, supplierId, order.provider_order_id, JSON.stringify(raw)]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function syncOpenSupplierOrders(limit = 100) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit || 100)));
  const [orders] = await pool.query(
    `SELECT o.id,o.provider_order_id,
      (SELECT supplier_id FROM supplier_order_events e WHERE e.order_id=o.id AND e.supplier_id IS NOT NULL ORDER BY e.id DESC LIMIT 1) supplier_id
     FROM orders o
     WHERE o.provider_order_id IS NOT NULL AND o.status IN ('pending','processing')
     ORDER BY o.id ASC LIMIT ${safeLimit}`
  );
  let synced = 0;
  for (const order of orders) {
    if (!order.supplier_id) continue;
    try {
      const raw = await fetchSupplierOrderStatus(order.supplier_id, order.provider_order_id);
      const remoteStatus = raw.status ?? raw.data?.status ?? raw.state;
      await applyRemoteStatus(order.id, order.supplier_id, mapSupplierStatus(remoteStatus), raw);
      synced += 1;
    } catch (error) {
      await pool.query('INSERT INTO supplier_order_events (order_id,supplier_id,event_type,remote_order_id,payload) VALUES (?,?,"status_error",?,?)', [order.id, order.supplier_id, order.provider_order_id, JSON.stringify({ error: error.message })]).catch(() => {});
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
  fetchSupplierBalance,
  refreshSupplierBalance,
  syncSupplierCatalog,
  repriceLinkedServices,
  publishSupplierCatalog,
  submitOrderToSupplier,
  fetchSupplierOrderStatus,
  testSupplierConnection,
  mapSupplierStatus,
  syncOpenSupplierOrders,
  startSupplierScheduler
};