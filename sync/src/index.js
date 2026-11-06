// Servicio de sincronización de shop.civired.com
//   node src/index.js         -> se queda en marcha (catálogo cada SYNC_HOURS, pedidos cada 5 min)
//   node src/index.js once    -> una sincronización y termina
//   node src/index.js check   -> comprueba conexiones (Ingram, WooCommerce, Icecat) y termina
import { config } from './config.js';
import { openDb, kvGet } from './db.js';
import { createWoo } from './woo.js';
import { createIcecat } from './icecat.js';
import { createIngram } from './providers/ingram.js';
import { runSync } from './sync.js';
import { runOrders } from './orders.js';
import { log, warn, sleep } from './log.js';

const db = openDb(config.dataDir);
const woo = createWoo(config.woo, db);
const icecat = createIcecat(config.icecat, db);
// Proveedores: añadir aquí los siguientes (Esprinet, TD SYNNEX, Infortisa...) con la misma interfaz
const providers = [createIngram(config.ingram)];
const ctx = { db, woo, icecat, providers, config };

async function waitForWoo() {
  for (let i = 0; ; i++) {
    try { await woo.get('/system_status?_fields=environment'); return true; } catch (e) {
      if (i % 10 === 0) warn('esperando a WooCommerce:', e.message);
      await sleep(30_000);
    }
  }
}

async function check() {
  let ok = true;
  try { await woo.get('/products?per_page=1'); log('WooCommerce: OK'); } catch (e) { ok = false; log('WooCommerce: FALLO', e.message); }
  for (const p of providers) {
    if (!p.configured()) { log(`${p.name}: sin credenciales en .env`); ok = false; continue; }
    try {
      if (p.sampleCategories) {
        const cats = await p.sampleCategories(5).catch((e) => { log('   categorías: no se pudo', e.message); return []; });
        log(`${p.name}: categorías vistas en una muestra del catálogo:`);
        for (const [c, n] of cats.slice(0, 40)) log(`   ${n}\t${c}`);
      }
      const items = await p.discover(3);
      log(`${p.name}: OK catálogo (${items.length} de prueba: ${items.map((i) => i.supplier_sku).join(', ')})`);
      const pa = await p.priceAndStock(items.map((i) => i.supplier_sku));
      for (const [sku, x] of pa) log(`   ${sku}: coste ${x.cost} ${x.currency}, stock ${x.stock}`);
    } catch (e) { ok = false; log(`${p.name}: FALLO`, e.message); }
  }
  if (config.icecat.user) {
    const r = await icecat.lookup({ key: 'check-hp', ean: '0190781249512', brand: 'HP', mpn: '' }).catch((e) => ({ err: e.message }));
    log('Icecat:', r?.title ? `OK (${r.title})` : 'no devuelve fichas: revisa ICECAT_USER');
  } else log('Icecat: sin usuario (ICECAT_USER)');
  return ok;
}

const cmd = process.argv[2];
if (cmd === 'check') {
  process.exit((await check()) ? 0 : 1);
} else if (cmd === 'once') {
  await runSync(ctx);
  process.exit(0);
} else {
  log(`sync arrancado: catálogo cada ${config.syncHours} h, pedidos (${config.orders.mode}) cada ${config.ordersEveryMin} min, máx ${config.maxProducts} productos, margen ${config.pricing.marginPct}%`);
  if (!config.woo.user || !config.woo.appPassword) warn('Falta WP_USER/WP_APP_PASSWORD en .env (lo crea install.sh)');
  await waitForWoo();
  let running = false;
  const syncTick = async () => {
    if (running) return;
    running = true;
    try { await runSync(ctx); } finally { running = false; }
  };
  const last = Date.parse(kvGet(db, 'last_sync') || 0) || 0;
  if (Date.now() - last > config.syncHours * 36e5) syncTick();
  setInterval(syncTick, config.syncHours * 36e5);
  setInterval(() => runOrders(ctx).catch((e) => warn('pedidos', e.message)), config.ordersEveryMin * 60_000);
  runOrders(ctx).catch((e) => warn('pedidos', e.message));
}
