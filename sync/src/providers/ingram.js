// Proveedor Ingram Micro (Xvantage Reseller API v6).
// Catálogo: GET /resellers/v6/catalog  ·  Precio y stock: POST /resellers/v6/catalog/priceandavailability (máx. 50)
// Pedidos:  POST /resellers/v6/orders
import crypto from 'node:crypto';
import { log, warn, sleep } from '../log.js';

export function createIngram(cfg, { fetchImpl = fetch } = {}) {
  let token = null;
  let tokenExp = 0;
  const name = 'ingram';

  const configured = () => Boolean(cfg.clientId && cfg.clientSecret && cfg.customerNumber);

  async function getToken() {
    if (token && Date.now() < tokenExp - 60_000) return token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
    const r = await fetchImpl(`${cfg.base}/oauth/oauth30/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) throw new Error(`Ingram token HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    token = j.access_token;
    tokenExp = Date.now() + Number(j.expires_in || 3600) * 1000;
    return token;
  }

  async function call(method, path, { query, body } = {}, attempt = 1) {
    const url = new URL(cfg.base + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    const r = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${await getToken()}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'accept-language': 'es',
        'IM-CustomerNumber': cfg.customerNumber,
        'IM-CountryCode': cfg.country,
        'IM-SenderID': cfg.senderId,
        'IM-CorrelationID': crypto.randomUUID().replace(/-/g, '').slice(0, 32),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((r.status === 429 || r.status >= 500) && attempt < 4) {
      await sleep(2000 * attempt);
      return call(method, path, { query, body }, attempt + 1);
    }
    if (r.status === 401 && attempt === 1) {
      token = null;
      return call(method, path, { query, body }, 2);
    }
    const text = await r.text();
    if (r.status === 204 || !text) return null;
    let j;
    try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok && r.status !== 207) {
      const msg = j?.errors?.map((e) => e.message + (e.fields ? ' ' + JSON.stringify(e.fields) : '')).join('; ') || text.slice(0, 300);
      throw new Error(`Ingram ${method} ${path} HTTP ${r.status}: ${msg}`);
    }
    return j;
  }

  /** Búsquedas a lanzar según los filtros configurados. */
  function searches() {
    const base = { type: 'IM::physical' };
    const out = [];
    const vendors = cfg.vendors.length ? cfg.vendors : [undefined];
    if (cfg.categories.length) {
      for (const category of cfg.categories) for (const vendor of vendors) out.push({ ...base, category, vendor });
    } else if (cfg.vendors.length) {
      for (const vendor of cfg.vendors) out.push({ ...base, vendor });
    }
    for (const keyword of cfg.keywords) out.push({ ...base, keyword });
    if (!out.length) out.push(base);
    return out;
  }

  /** Descubre productos del catálogo (sin precio). Devuelve como mucho `limit`. */
  async function discover(limit) {
    const seen = new Map();
    for (const q of searches()) {
      for (let page = 1; seen.size < limit; page++) {
        const j = await call('GET', '/resellers/v6/catalog', { query: { ...q, pageSize: 100, pageNumber: page } });
        const items = j?.catalog || [];
        for (const it of items) {
          if (String(it.discontinued) === 'true') continue;
          if (!it.ingramPartNumber || seen.has(it.ingramPartNumber)) continue;
          seen.set(it.ingramPartNumber, {
            supplier: name,
            supplier_sku: it.ingramPartNumber,
            mpn: it.vendorPartNumber || null,
            ean: it.upcCode || null,
            brand: it.vendorName || null,
            name: it.description || null,
            category: it.category || null,
            subcategory: it.subCategory || null,
          });
          if (seen.size >= limit) break;
        }
        log(`ingram catálogo ${JSON.stringify(q)} pág ${page}: ${items.length} (total ${seen.size}/${j?.recordsFound ?? '?'})`);
        if (!items.length || !j?.nextPage) break;
      }
      if (seen.size >= limit) break;
    }
    return [...seen.values()];
  }

  /** Precio de coste y stock de una lista de referencias Ingram (lotes de 50). */
  async function priceAndStock(skus) {
    const out = new Map();
    for (let i = 0; i < skus.length; i += 50) {
      const chunk = skus.slice(i, i + 50);
      let rows;
      try {
        rows = await call('POST', '/resellers/v6/catalog/priceandavailability', {
          query: { includeAvailability: true, includePricing: true, includeProductAttributes: true },
          body: { products: chunk.map((ingramPartNumber) => ({ ingramPartNumber })) },
        });
      } catch (e) {
        warn('ingram P&A', e.message);
        continue;
      }
      for (const r of Array.isArray(rows) ? rows : []) {
        if (!r.ingramPartNumber) continue;
        if (r.productStatusCode === 'E') { out.set(r.ingramPartNumber, { active: 0, cost: null, stock: 0 }); continue; }
        const pr = r.pricing || r.availability?.pricing || {};
        out.set(r.ingramPartNumber, {
          active: r.productAuthorized === false ? 0 : 1,
          cost: Number(pr.customerPrice) || null,
          currency: pr.currencyCode || 'EUR',
          stock: Math.max(0, Number(r.availability?.totalAvailability) || 0),
          ean: r.upc || null,
          mpn: r.vendorPartNumber || null,
          brand: r.vendorName || null,
          name: r.description || null,
        });
      }
      await sleep(300);
    }
    return out;
  }

  /**
   * Crea un pedido drop-ship: Ingram envía directamente al cliente final.
   * lines: [{ supplier_sku, quantity }]
   */
  async function createOrder({ orderRef, shipTo, lines, notes }) {
    const body = {
      customerOrderNumber: orderRef.slice(0, 22),
      endCustomerOrderNumber: orderRef.slice(0, 22),
      notes: (notes || '').slice(0, 132),
      shipToInfo: {
        contact: shipTo.contact?.slice(0, 35),
        companyName: (shipTo.companyName || shipTo.contact || '').slice(0, 35),
        addressLine1: shipTo.addressLine1?.slice(0, 35),
        addressLine2: shipTo.addressLine2?.slice(0, 35) || undefined,
        city: shipTo.city?.slice(0, 20),
        state: shipTo.state || undefined,
        postalCode: shipTo.postalCode,
        countryCode: shipTo.countryCode || 'ES',
        email: shipTo.email || undefined,
        phoneNumber: shipTo.phone || undefined,
      },
      lines: lines.map((l, i) => ({ customerLineNumber: String(i + 1), ingramPartNumber: l.supplier_sku, quantity: l.quantity })),
    };
    const j = await call('POST', '/resellers/v6/orders', { body });
    const numbers = (j?.orders || []).map((o) => o.ingramOrderNumber).filter(Boolean);
    return { ok: numbers.length > 0, numbers, raw: j };
  }

  return { name, configured, discover, priceAndStock, createOrder };
}
