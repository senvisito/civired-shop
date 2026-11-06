// Reglas de precio y de elección del proveedor más barato.

/** Clave unificada para juntar el mismo producto de distintos proveedores. */
export function productKey({ ean, brand, mpn }) {
  const e = normEan(ean);
  if (e) return `EAN${e}`;
  const b = (brand || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = (mpn || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return m ? `MPN${b}-${m}` : null;
}

/** EAN/UPC normalizado a 13 dígitos; null si no parece válido. */
export function normEan(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 8 || d.length > 14 || /^0+$/.test(d)) return null;
  return d.padStart(14, '0').slice(-13);
}

/** De todas las ofertas de un producto, la más barata con stock (o la más barata si nadie tiene). */
export function pickBest(offers, { requireStock = true } = {}) {
  const valid = offers.filter((o) => o.active && Number(o.cost) > 0);
  const inStock = valid.filter((o) => o.stock > 0);
  const pool = inStock.length ? inStock : requireStock ? [] : valid;
  if (!pool.length) return null;
  return pool.reduce((a, b) => (b.cost < a.cost || (b.cost === a.cost && b.stock > a.stock) ? b : a));
}

/** Precio de venta CON IVA (la tienda se configura con "precios con impuestos incluidos"). */
export function sellPrice(cost, { marginPct = 10, minMarginEur = 0, rounding = 'none', vatPct = 21 } = {}) {
  let net = cost * (1 + marginPct / 100);
  if (net - cost < minMarginEur) net = cost + minMarginEur;
  let gross = net * (1 + vatPct / 100);
  if (rounding === '99') gross = Math.ceil(gross) - 0.01; // ej. 133,99 €
  return Math.round(gross * 100) / 100;
}
