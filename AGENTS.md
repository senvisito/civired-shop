# Guía para asistentes de IA

- Tienda WooCommerce en Docker (hosting06, nginx/ISPConfig -> 127.0.0.1:3020). Directorio en el servidor: /opt/civired-shop.
- Despliegue: push a `main`; el servidor se actualiza solo cada 5 min (`/usr/local/bin/civired-shop-autoupdate`, log en /var/log/civired-shop-update.log).
- Código propio: `sync/` (Node 22, ESM, better-sqlite3) y `wp/mu-plugins/`. Tests: `cd sync && npm test` (usa fetch simulado, sin red).
- Reglas: nunca subir secretos (.env); no tocar otras webs de ISPConfig; textos para clientes en español; no mostrar al público proveedor ni coste.
- Precios: `sellPrice()` devuelve precio con IVA; WooCommerce está en "precios con impuestos incluidos".
- La tienda vieja (tienda.civired.com, hosting04) es otra instalación: no se modifica desde aquí.
