// Open Icecat: fichas y fotos gratuitas de las marcas que patrocinan Icecat.
// Las fotos NO se enlazan: WooCommerce las descarga una vez a su biblioteca de medios.
import { now } from './db.js';
import { warn } from './log.js';

const TTL_OK = 30 * 864e5; // 30 días
const TTL_MISS = 7 * 864e5; // reintentar productos sin ficha cada 7 días

export function createIcecat(cfg, db, { fetchImpl = fetch } = {}) {
  async function fetchJson(params) {
    const url = new URL('https://live.icecat.biz/api/');
    url.searchParams.set('UserName', cfg.user);
    url.searchParams.set('Language', cfg.lang);
    url.searchParams.set('Content', 'GeneralInfo,Image,Gallery,FeatureGroups');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (r.status === 404 || r.status === 400 || r.status === 403) return null;
    if (!r.ok) throw new Error(`Icecat HTTP ${r.status}`);
    const j = await r.json();
    return j?.data?.GeneralInfo ? j.data : null;
  }

  function parse(d) {
    const gi = d.GeneralInfo || {};
    const images = [];
    const add = (u) => { if (u && !images.includes(u)) images.push(u.replace(/^http:/, 'https:')); };
    add(d.Image?.HighPic || d.Image?.Pic500x500 || d.Image?.LowPic);
    for (const g of d.Gallery || []) add(g.Pic || g.Pic500x500);
    const specs = [];
    for (const grp of d.FeaturesGroups || []) {
      for (const f of grp.Features || []) {
        const n = f.Feature?.Name?.Value;
        const v = f.PresentationValue || f.Value;
        if (n && v) specs.push([n, v]);
      }
    }
    return {
      title: gi.Title || gi.ProductName || null,
      short: gi.SummaryDescription?.ShortSummaryDescription || null,
      long: gi.Description?.LongDesc || gi.SummaryDescription?.LongSummaryDescription || null,
      images: images.slice(0, 6),
      specs: specs.slice(0, 40),
    };
  }

  /** Ficha del producto o null. Cachea aciertos y fallos. */
  async function lookup({ key, ean, brand, mpn }) {
    if (!cfg.user) return null;
    const row = db.prepare('SELECT json, fetched_at FROM icecat WHERE key=?').get(key);
    if (row) {
      const age = Date.now() - Date.parse(row.fetched_at);
      const data = row.json ? JSON.parse(row.json) : null;
      if (age < (data ? TTL_OK : TTL_MISS)) return data;
    }
    let data = null;
    try {
      let d = ean ? await fetchJson({ GTIN: ean }) : null;
      if (!d && brand && mpn) d = await fetchJson({ Brand: brand, ProductCode: mpn });
      data = d ? parse(d) : null;
    } catch (e) {
      warn('icecat', key, e.message);
      return row?.json ? JSON.parse(row.json) : null;
    }
    db.prepare('INSERT INTO icecat(key,json,fetched_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at')
      .run(key, data ? JSON.stringify(data) : null, now());
    return data;
  }

  return { lookup };
}
