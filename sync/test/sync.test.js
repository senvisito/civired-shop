import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { productKey, pickBest, sellPrice, normEan } from '../src/pricing.js';
import { createIngram } from '../src/providers/ingram.js';
import { createIcecat } from '../src/icecat.js';
import { createWoo } from '../src/woo.js';
import { runSync } from '../src/sync.js';
import { runOrders } from '../src/orders.js';

test('precios y clave', () => {
  assert.equal(normEan('884116186519'), '0884116186519');
  assert.equal(productKey({ ean: '0884116186519' }), 'EAN0884116186519');
  assert.equal(productKey({ brand: 'H.P.', mpn: 'ab-12' }), 'MPNHP-AB12');
  assert.equal(sellPrice(100, { marginPct: 10 }), 133.1);
  assert.equal(sellPrice(10, { marginPct: 10, minMarginEur: 3 }), 15.73);
  assert.equal(sellPrice(100, { marginPct: 10, rounding: '99' }), 133.99);
  const best = pickBest([
    { supplier: 'a', cost: 50, stock: 0, active: 1 },
    { supplier: 'b', cost: 60, stock: 3, active: 1 },
    { supplier: 'c', cost: 55, stock: 1, active: 1 },
  ]);
  assert.equal(best.supplier, 'c');
  assert.equal(pickBest([{ supplier: 'a', cost: 50, stock: 0, active: 1 }]), null);
});

function fakeWorld() {
  const wooProducts = [];
  const notes = [];
  const ingramOrders = [];
  let nextId = 100;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    if (u.pathname === '/oauth/oauth30/token') return json({ access_token: 'T', expires_in: 3600 });
    if (u.pathname === '/resellers/v6/catalog') {
      assert.equal(opts.headers['IM-CountryCode'], 'ES');
      assert.ok(opts.headers['IM-CorrelationID'].length <= 32);
      return json({ recordsFound: 2, catalog: [
        { ingramPartNumber: 'IM1', vendorPartNumber: 'E2016HV', upcCode: '0884116186519', vendorName: 'DELL', description: 'MONITOR 20', category: 'DISPLAYS', subCategory: 'MONITORS', discontinued: 'false' },
        { ingramPartNumber: 'IM2', vendorPartNumber: 'NOPIC', upcCode: '', vendorName: 'ACME', description: 'COSA', category: 'X', subCategory: 'Y', discontinued: 'false' },
      ] });
    }
    if (u.pathname === '/resellers/v6/catalog/priceandavailability') {
      return json(body.products.map(({ ingramPartNumber }) => ({
        ingramPartNumber, productAuthorized: true,
        availability: { available: true, totalAvailability: 7 },
        pricing: { customerPrice: 100, currencyCode: 'EUR' },
      })));
    }
    if (u.pathname === '/resellers/v6/orders') { ingramOrders.push(body); return json({ orders: [{ ingramOrderNumber: '20-XYZ' }] }, 201); }
    if (u.hostname === 'live.icecat.biz') {
      if (u.searchParams.get('GTIN') === '0884116186519') return json({ data: { GeneralInfo: { Title: 'Dell E2016HV', Description: { LongDesc: '<p>Monitor</p>' } }, Image: { HighPic: 'http://images.icecat.biz/a.jpg' }, Gallery: [{ Pic: 'https://images.icecat.biz/b.jpg' }] } });
      return json({ msg: 'not found' }, 404);
    }
    if (u.hostname === 'wordpress') {
      assert.match(opts.headers.authorization, /^Basic /);
      const p = u.pathname.replace('/wp-json/wc/v3', '');
      if (p === '/products/categories') return json({ id: nextId++, name: body.name });
      if (p === '/products/batch') {
        const out = {};
        if (body.create) out.create = body.create.map((b) => { const id = nextId++; wooProducts.push({ id, ...b }); return { id }; });
        if (body.update) out.update = body.update.map((b) => { Object.assign(wooProducts.find((x) => x.id === b.id), b); return { id: b.id }; });
        return json(out);
      }
      if (p === '/orders') return json([{ id: 9, number: '9', total: '133.10', status: 'processing',
        billing: { first_name: 'Ana', last_name: 'P', address_1: 'C/ Mayor 1', city: 'Valencia', state: 'V', postcode: '46001', country: 'ES', email: 'a@b.es', phone: '600' },
        shipping: {}, line_items: [{ product_id: wooProducts[0]?.id, quantity: 2, name: 'Dell' }] }]);
      if (/^\/orders\/\d+\/notes$/.test(p)) { notes.push(body.note); return json({ id: 1 }); }
    }
    throw new Error('URL no simulada: ' + url);
  };
  return { fetchImpl, wooProducts, notes, ingramOrders };
}

test('sincronización completa simulada + pedido drop-ship', async () => {
  const w = fakeWorld();
  const db = openDb(':memory:');
  const config = {
    maxProducts: 10, requireImage: true, requireStock: true, stockCap: 5,
    pricing: { marginPct: 10, minMarginEur: 0, rounding: 'none' },
    orders: { mode: 'auto' },
  };
  const ingram = createIngram({ clientId: 'x', clientSecret: 'y', customerNumber: '20-1', country: 'ES', senderId: 'T', base: 'https://api.ingrammicro.com:443', categories: [], vendors: [], keywords: [] }, { fetchImpl: w.fetchImpl });
  const ctx = {
    db, config, providers: [ingram],
    woo: createWoo({ url: 'http://wordpress', user: 'u', appPassword: 'p' }, db, { fetchImpl: w.fetchImpl }),
    icecat: createIcecat({ user: 'icu', lang: 'es' }, db, { fetchImpl: w.fetchImpl }),
  };
  const stats = await runSync(ctx);
  assert.equal(stats.created, 1); // el de sin foto se salta
  assert.equal(stats.skipped, 1);
  const p = w.wooProducts[0];
  assert.equal(p.regular_price, '133.10');
  assert.equal(p.stock_quantity, 5);
  assert.equal(p.images[0].src, 'https://images.icecat.biz/a.jpg');
  assert.equal(p.name, 'Dell E2016HV');

  // segunda pasada: nada cambia
  const s2 = await runSync(ctx);
  assert.equal(s2.created + s2.updated, 0);

  await runOrders(ctx);
  assert.equal(w.ingramOrders.length, 1);
  assert.equal(w.ingramOrders[0].lines[0].ingramPartNumber, 'IM1');
  assert.equal(w.ingramOrders[0].lines[0].quantity, 2);
  assert.equal(w.ingramOrders[0].shipToInfo.postalCode, '46001');
  assert.match(w.notes[0], /20-XYZ/);
  // no repite el pedido
  await runOrders(ctx);
  assert.equal(w.ingramOrders.length, 1);
});

test('categorías de la tienda en español', async () => {
  const { shopCategory } = await import('../src/sync.js');
  const { config } = await import('../src/config.js');
  const map = config.ingram.catalog.categoryMap;
  const c = (category, subcategory, name) => shopCategory({ category, subcategory, name }, null, map).join(' > ');
  assert.equal(c('Computer systems', 'Portables/notebooks', 'HP PROBOOK 4'), 'Ordenadores > Portátiles');
  assert.equal(c('Computer systems', 'Portables/notebooks', 'ACER NITRO V 16'), 'Ordenadores > Portátiles gaming');
  assert.equal(c('Computer systems', 'Desktops/towers', 'HP PRODESK 4 SFF'), 'Ordenadores > Sobremesa');
  assert.equal(c('Computer systems', 'Desktops/towers', 'LENOVO LEGION TOWER 5'), 'Ordenadores > Sobremesa gaming');
  assert.equal(c('Displays', 'Monitors', 'DELL 24 MONITOR'), 'Monitores');
  assert.equal(c('Printers', 'Inkjet printers', 'HP OFFICEJET'), 'Impresoras');
});
