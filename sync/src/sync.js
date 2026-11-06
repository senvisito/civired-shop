// Sincronización: proveedores -> ofertas -> mejor precio -> WooCommerce.
import { now, kvSet } from './db.js';
import { productKey, pickBest, sellPrice, normEan } from './pricing.js';
import { log, warn, notify } from './log.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** 1) Trae catálogo, coste y stock de cada proveedor y lo guarda como ofertas. */
export async function refreshOffers({ db, providers, config }) {
  const upsertMeta = db.prepare(`
    INSERT INTO offers(supplier,supplier_sku,key,ean,mpn,brand,name,category,subcategory,updated_at)
    VALUES(@supplier,@supplier_sku,@key,@ean,@mpn,@brand,@name,@category,@subcategory,@updated_at)
    ON CONFLICT(supplier,supplier_sku) DO UPDATE SET
      ean=COALESCE(excluded.ean,ean), mpn=COALESCE(excluded.mpn,mpn), brand=COALESCE(excluded.brand,brand),
      name=COALESCE(excluded.name,name), category=COALESCE(excluded.category,category),
      subcategory=COALESCE(excluded.subcategory,subcategory), key=excluded.key`);
  const updPrice = db.prepare(`UPDATE offers SET cost=?, currency=?, stock=?, active=?, key=?, updated_at=? WHERE supplier=? AND supplier_sku=?`);

  for (const p of providers) {
    if (!p.configured()) { warn(`${p.name}: sin credenciales, se salta`); continue; }
    const known = db.prepare('SELECT COUNT(*) n FROM offers WHERE supplier=?').get(p.name).n;
    // Muchos candidatos se descartan (sin foto o sin stock): se buscan 4 veces más de los que se quieren publicar
    const want = config.maxProducts * 4;
    if (known < want) {
      const found = await p.discover(want);
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          const key = productKey(r);
          if (key) upsertMeta.run({ ...r, ean: normEan(r.ean), key, updated_at: now() });
        }
      });
      tx(found);
      log(`${p.name}: ${found.length} productos descubiertos`);
    }
    const rows = db.prepare('SELECT * FROM offers WHERE supplier=? ORDER BY rowid LIMIT ?').all(p.name, config.maxProducts * 5);
    const pa = await p.priceAndStock(rows.map((r) => r.supplier_sku));
    const tx = db.transaction(() => {
      for (const r of rows) {
        const x = pa.get(r.supplier_sku);
        const ean = normEan(x?.ean) || r.ean;
        const key = productKey({ ean, brand: r.brand || x?.brand, mpn: r.mpn || x?.mpn }) || r.key;
        if (!x) updPrice.run(r.cost, r.currency, 0, r.active, key, now(), p.name, r.supplier_sku);
        else updPrice.run(x.cost, x.currency || 'EUR', x.stock, x.active, key, now(), p.name, r.supplier_sku);
      }
    });
    tx();
    log(`${p.name}: precio y stock de ${pa.size}/${rows.length} referencias`);
  }
}

function buildDescription(base, ice) {
  let html = ice?.long || esc(base.name || '');
  if (ice?.specs?.length) {
    html += '\n<h3>Especificaciones</h3>\n<table class="cr-specs"><tbody>' +
      ice.specs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + '</tbody></table>';
  }
  return html;
}

/** Categoría de la tienda (en español) según catalog.json; si no encaja ninguna regla, "Otros". */
export function shopCategory(best, ice, map = []) {
  const text = `${best.category || ''} ${best.subcategory || ''} ${ice?.title || ''} ${best.name || ''}`;
  for (const m of map) if (m.re?.test(text)) return m.path;
  return map.length ? ['Otros'] : [best.category, best.subcategory].filter(Boolean);
}

const meta = (best) => [
  { key: '_cr_key', value: best.key },
  { key: '_cr_supplier', value: best.supplier },
  { key: '_cr_supplier_sku', value: best.supplier_sku },
  { key: '_cr_cost', value: String(best.cost) },
];

/** 2) Para cada producto elige el proveedor más barato y crea/actualiza en WooCommerce. */
export async function pushToWoo({ db, woo, icecat, config }) {
  const keys = db.prepare('SELECT DISTINCT key FROM offers').all().map((r) => r.key);
  const offersOf = db.prepare('SELECT * FROM offers WHERE key=?');
  const getProd = db.prepare('SELECT * FROM products WHERE key=?');
  const saveProd = db.prepare(`INSERT INTO products(key,woo_id,sku,price,stock,supplier,supplier_sku,cost,skipped,updated_at,cat_id)
    VALUES(@key,@woo_id,@sku,@price,@stock,@supplier,@supplier_sku,@cost,@skipped,@updated_at,@cat_id)
    ON CONFLICT(key) DO UPDATE SET cat_id=COALESCE(excluded.cat_id,cat_id), woo_id=excluded.woo_id, sku=excluded.sku, price=excluded.price, stock=excluded.stock,
      supplier=excluded.supplier, supplier_sku=excluded.supplier_sku, cost=excluded.cost, skipped=excluded.skipped, updated_at=excluded.updated_at`);
  let published = db.prepare('SELECT COUNT(*) n FROM products WHERE woo_id IS NOT NULL').get().n;

  const creates = [];
  const updates = [];
  const stats = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };

  for (const key of keys) {
    const offers = offersOf.all(key);
    const prod = getProd.get(key);
    const best = pickBest(offers, { requireStock: config.requireStock });
    if (!best) {
      if (prod?.woo_id && prod.stock !== 0) updates.push({ row: { ...prod, stock: 0 }, body: { id: prod.woo_id, stock_quantity: 0 } });
      else stats.unchanged++;
      continue;
    }
    if (best.currency && best.currency !== 'EUR') { stats.skipped++; continue; }
    const price = sellPrice(best.cost, config.pricing);
    const stock = Math.min(best.stock, config.stockCap);
    const sku = `CR-${key}`.slice(0, 60);
    const row = { key, woo_id: prod?.woo_id ?? null, sku, price, stock, supplier: best.supplier, supplier_sku: best.supplier_sku, cost: best.cost, skipped: null, updated_at: now(), cat_id: null };

    const catMap = config.catalog?.categoryMap || [];
    if (prod?.woo_id) {
      // Recolocar en la categoría correcta si las reglas han cambiado
      let catId = prod.cat_id;
      if (catMap.length) {
        const ice = await icecat.lookup({ key, ean: best.ean, brand: best.brand, mpn: best.mpn }).catch(() => null);
        catId = await woo.ensureCategory(shopCategory(best, ice, catMap)).catch(() => prod.cat_id);
      }
      row.cat_id = catId;
      const catChanged = catId && catId !== prod.cat_id;
      if (!catChanged && prod.price === price && prod.stock === stock && prod.supplier_sku === best.supplier_sku) { stats.unchanged++; continue; }
      const body = { id: prod.woo_id, regular_price: price.toFixed(2), stock_quantity: stock, meta_data: meta({ ...best, key }) };
      if (catChanged) body.categories = [{ id: catId }];
      updates.push({ row, body });
      continue;
    }
    if (published + creates.length >= config.maxProducts) continue;
    const ice = await icecat.lookup({ key, ean: best.ean, brand: best.brand, mpn: best.mpn });
    if (config.requireImage && !ice?.images?.length) {
      saveProd.run({ ...row, skipped: 'sin foto' });
      stats.skipped++;
      continue;
    }
    const catId = await woo.ensureCategory(shopCategory(best, ice, catMap)).catch((e) => { warn('categoría', e.message); return null; });
    row.cat_id = catId;
    const body = {
      name: ice?.title || best.name || best.mpn,
      type: 'simple',
      status: 'publish',
      sku,
      regular_price: price.toFixed(2),
      manage_stock: true,
      stock_quantity: stock,
      description: buildDescription(best, ice),
      short_description: ice?.short ? esc(ice.short) : '',
      categories: catId ? [{ id: catId }] : [],
      images: (ice?.images || []).map((src) => ({ src })),
      attributes: best.brand ? [{ name: 'Marca', visible: true, options: [best.brand] }] : [],
      meta_data: meta({ ...best, key }),
    };
    creates.push({ row, body });
  }

  // Altas en lotes pequeños (WordPress descarga las fotos en cada alta)
  for (let i = 0; i < creates.length; i += 10) {
    const chunk = creates.slice(i, i + 10);
    let res;
    try { res = await woo.batch({ create: chunk.map((c) => c.body) }); } catch (e) { warn('alta lote', e.message); stats.errors += chunk.length; continue; }
    for (let k = 0; k < chunk.length; k++) {
      const r = res?.create?.[k];
      if (r?.id && !r.error) { saveProd.run({ ...chunk[k].row, woo_id: r.id }); stats.created++; published++; continue; }
      // Si el SKU ya existe en la tienda, lo enlazamos en vez de duplicar
      if (r?.error?.code === 'product_invalid_sku' || /sku/i.test(r?.error?.message || '')) {
        const found = await woo.get(`/products?sku=${encodeURIComponent(chunk[k].row.sku)}`).catch(() => []);
        if (found?.[0]?.id) { saveProd.run({ ...chunk[k].row, woo_id: found[0].id }); updates.push({ row: chunk[k].row, body: { id: found[0].id, regular_price: chunk[k].body.regular_price, stock_quantity: chunk[k].row.stock } }); continue; }
      }
      warn('alta', chunk[k].row.sku, r?.error?.message || 'sin respuesta');
      stats.errors++;
    }
  }
  // Cambios de precio/stock en lotes de 100
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    let res;
    try { res = await woo.batch({ update: chunk.map((u) => u.body) }); } catch (e) { warn('actualización lote', e.message); stats.errors += chunk.length; continue; }
    for (let k = 0; k < chunk.length; k++) {
      const r = res?.update?.[k];
      if (r?.id && !r.error) { saveProd.run({ ...chunk[k].row, woo_id: r.id }); stats.updated++; }
      else {
        // Producto borrado a mano en la tienda: lo olvidamos para que se vuelva a crear si procede
        if (r?.error?.code === 'woocommerce_rest_product_invalid_id') db.prepare('DELETE FROM products WHERE key=?').run(chunk[k].row.key);
        warn('actualización', chunk[k].row.sku, r?.error?.message || 'sin respuesta');
        stats.errors++;
      }
    }
  }
  return stats;
}

export async function runSync(ctx) {
  const t0 = Date.now();
  try {
    await refreshOffers(ctx);
    const stats = await pushToWoo(ctx);
    const msg = `Sincronización OK en ${Math.round((Date.now() - t0) / 1000)} s: ${stats.created} nuevos, ${stats.updated} actualizados, ${stats.unchanged} sin cambios, ${stats.skipped} saltados, ${stats.errors} errores`;
    log(msg);
    kvSet(ctx.db, 'last_sync', now());
    kvSet(ctx.db, 'last_sync_result', msg);
    if (stats.errors > 0) await notify(msg);
    return stats;
  } catch (e) {
    warn('sincronización fallida', e.stack || e.message);
    kvSet(ctx.db, 'last_sync_result', `ERROR ${e.message}`);
    await notify(`Sincronización fallida: ${e.message}`);
    return null;
  }
}
