import fs from 'node:fs';
// Configuración leída de variables de entorno (.env). Sin secretos en el código.
const env = process.env;
const list = (v) => (v || '').split('|').map((s) => s.trim()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));

export const config = {
  dataDir: env.DATA_DIR || './data',
  syncHours: num(env.SYNC_HOURS, 4),
  ordersEveryMin: num(env.ORDERS_EVERY_MIN, 5),
  maxProducts: num(env.MAX_PRODUCTS, 200),
  requireImage: env.REQUIRE_IMAGE !== '0',
  requireStock: env.REQUIRE_STOCK !== '0',
  stockCap: num(env.STOCK_CAP, 50),
  pricing: {
    marginPct: num(env.MARGIN_PCT, 0),
    minMarginEur: num(env.MIN_MARGIN_EUR, 0),
    rounding: env.PRICE_ROUNDING || 'none',
    vatPct: num(env.VAT_PCT, 21),
  },
  woo: {
    url: (env.WOO_URL || 'http://wordpress').replace(/\/$/, ''),
    user: env.WP_USER || '',
    appPassword: env.WP_APP_PASSWORD || '',
  },
  icecat: { user: env.ICECAT_USER || '', lang: env.ICECAT_LANG || 'es' },
  ingram: {
    clientId: env.IM_CLIENT_ID || '',
    clientSecret: env.IM_CLIENT_SECRET || '',
    customerNumber: env.IM_CUSTOMER_NUMBER || '',
    country: env.IM_COUNTRY || 'ES',
    senderId: (env.IM_SENDER_ID || 'CiviRedShop').slice(0, 32),
    base: (env.IM_BASE || 'https://api.ingrammicro.com:443').replace(/\/$/, ''),
    categories: list(env.IM_CATEGORIES),
    vendors: list(env.IM_VENDORS),
    keywords: list(env.IM_KEYWORDS),
    catalog: loadCatalog(),
  },
  orders: { mode: env.ORDERS_MODE || 'notify' },
  telegram: { token: env.TELEGRAM_BOT_TOKEN || '', chatId: env.TELEGRAM_CHAT_ID || '' },
};

/** Qué se vende (sync/catalog.json). Si IM_CATEGORIES/IM_VENDORS/IM_KEYWORDS están rellenas, mandan ellas. */
function loadCatalog() {
  try {
    const d = JSON.parse(fs.readFileSync(new URL('../catalog.json', import.meta.url), 'utf8'));
    const re = (s) => (s ? new RegExp(s, 'i') : null);
    return { searches: d.searches || [], include: re(d.include), exclude: re(d.exclude), excludeDescription: re(d.excludeDescription) };
  } catch {
    return { searches: [], include: null, exclude: null, excludeDescription: null };
  }
}
