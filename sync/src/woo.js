// Cliente mínimo de la API REST de WooCommerce (wc/v3) con contraseña de aplicación de WordPress.
import { sleep } from './log.js';

export function createWoo(cfg, db, { fetchImpl = fetch } = {}) {
  const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.appPassword}`).toString('base64');

  async function call(method, path, body, attempt = 1) {
    const r = await fetchImpl(`${cfg.url}/wp-json/wc/v3${path}`, {
      method,
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        accept: 'application/json',
        // WordPress está detrás de nginx con HTTPS; así sabe que la conexión es segura
        'x-forwarded-proto': 'https',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((r.status >= 500 || r.status === 429) && attempt < 4) {
      await sleep(3000 * attempt);
      return call(method, path, body, attempt + 1);
    }
    const text = await r.text();
    let j;
    try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text.slice(0, 300) }; }
    if (!r.ok) throw new Error(`Woo ${method} ${path} HTTP ${r.status}: ${j?.code ? j.code + ' ' : ''}${j?.message || j?.raw || ''}`);
    return j;
  }

  /** Crea (si no existe) la categoría "Padre > Hija" y devuelve su id. */
  async function ensureCategory(parts) {
    let parent = 0;
    let pathSoFar = '';
    for (const raw of parts.filter(Boolean)) {
      const name = /[a-z]/.test(raw) ? String(raw).trim() : titleCase(raw);
      pathSoFar = pathSoFar ? `${pathSoFar} > ${name}` : name;
      const row = db.prepare('SELECT woo_id FROM categories WHERE path=?').get(pathSoFar);
      if (row) { parent = row.woo_id; continue; }
      let id;
      try {
        id = (await call('POST', '/products/categories', { name, parent })).id;
      } catch (e) {
        // Ya existe: WooCommerce devuelve term_exists con el id
        const m = /term_exists/.test(e.message);
        if (!m) throw e;
        const found = await call('GET', `/products/categories?search=${encodeURIComponent(name)}&parent=${parent}&per_page=100`);
        id = found.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id;
        if (!id) throw e;
      }
      db.prepare('INSERT OR REPLACE INTO categories(path,woo_id) VALUES(?,?)').run(pathSoFar, id);
      parent = id;
    }
    return parent || null;
  }

  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    batch: (b) => call('POST', '/products/batch', b),
    ensureCategory,
  };
}

export function titleCase(s) {
  const t = String(s).trim().toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
