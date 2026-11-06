// Pedidos pagados ("Procesando") -> pedido drop-ship al proveedor (o aviso para hacerlo a mano).
import { now } from './db.js';
import { log, warn, notify } from './log.js';

function shipToFrom(o) {
  const s = o.shipping?.address_1 ? o.shipping : o.billing;
  return {
    contact: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
    companyName: s.company || '',
    addressLine1: s.address_1,
    addressLine2: s.address_2,
    city: s.city,
    state: s.state,
    postalCode: s.postcode,
    countryCode: s.country || 'ES',
    email: o.billing?.email,
    phone: o.shipping?.phone || o.billing?.phone,
  };
}

export async function runOrders({ db, woo, providers, config }) {
  const mode = config.orders.mode;
  if (mode === 'off') return;
  let list;
  try {
    list = await woo.get('/orders?status=processing&per_page=50&orderby=date&order=asc');
  } catch (e) {
    warn('pedidos', e.message);
    return;
  }
  const seen = db.prepare('SELECT 1 FROM orders WHERE woo_id=?');
  const save = db.prepare('INSERT OR REPLACE INTO orders(woo_id,status,detail,updated_at) VALUES(?,?,?,?)');
  const byWoo = db.prepare('SELECT * FROM products WHERE woo_id=?');

  for (const o of list || []) {
    if (seen.get(o.id)) continue;
    // Agrupar líneas por proveedor
    const groups = new Map();
    const manual = [];
    for (const li of o.line_items || []) {
      const p = byWoo.get(li.product_id);
      if (!p?.supplier) { manual.push(`${li.name} x${li.quantity}`); continue; }
      if (!groups.has(p.supplier)) groups.set(p.supplier, []);
      groups.get(p.supplier).push({ supplier_sku: p.supplier_sku, quantity: li.quantity, name: li.name, cost: p.cost });
    }
    const lines = [];
    for (const [sup, items] of groups) {
      lines.push(`${sup.toUpperCase()}: ` + items.map((i) => `${i.supplier_sku} x${i.quantity} (coste aprox. ${i.cost} €)`).join(', '));
    }
    if (manual.length) lines.push(`SIN PROVEEDOR (manual): ${manual.join(', ')}`);

    if (mode === 'auto') {
      const results = [];
      let allOk = !manual.length;
      for (const [sup, items] of groups) {
        const prov = providers.find((p) => p.name === sup);
        if (!prov?.createOrder) { allOk = false; results.push(`${sup}: sin pedidos automáticos`); continue; }
        try {
          const r = await prov.createOrder({ orderRef: `CR${o.id}`, shipTo: shipToFrom(o), lines: items, notes: `Pedido web ${o.number}` });
          results.push(`${sup}: ${r.ok ? 'pedido creado ' + r.numbers.join(', ') : 'respuesta sin número de pedido'}`);
          if (!r.ok) allOk = false;
        } catch (e) {
          allOk = false;
          results.push(`${sup}: ERROR ${e.message}`);
        }
      }
      const note = `Drop-ship automático:\n${results.join('\n')}${manual.length ? '\n' + lines.at(-1) : ''}`;
      await woo.post(`/orders/${o.id}/notes`, { note, customer_note: false }).catch((e) => warn('nota', e.message));
      save.run(o.id, allOk ? 'placed' : 'error', note, now());
      await notify(`Pedido #${o.number} (${o.total} €): ${allOk ? 'enviado al proveedor' : 'REVISAR'}\n${results.join('\n')}`);
      log(`pedido ${o.id}: ${allOk ? 'ok' : 'revisar'}`);
    } else {
      const note = `Pedir al proveedor (envío directo al cliente):\n${lines.join('\n')}`;
      await woo.post(`/orders/${o.id}/notes`, { note, customer_note: false }).catch((e) => warn('nota', e.message));
      save.run(o.id, 'notified', note, now());
      await notify(`Nuevo pedido #${o.number} (${o.total} €). ${note}`);
    }
  }
}
