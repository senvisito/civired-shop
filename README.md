# shop.civired.com

Tienda online de CiviRed en modo **drop-shipping**: vendemos productos de nuestros mayoristas, ponemos nuestro margen y el mayorista guarda el stock y envía directamente al cliente.

## Cómo funciona

```
Ingram Micro ─┐                      ┌─> WooCommerce (shop.civired.com)
(más adelante │   servicio "sync"    │     - precio = coste más barato + margen + IVA
 Esprinet,    ├─> junta por EAN/ref ─┤     - stock del proveedor elegido
 TD SYNNEX…)  │   elige el + barato  │     - fotos y ficha de Icecat (copiadas 1 vez)
              ┘                      └─> pedidos pagados -> pedido drop-ship al proveedor
```

- **WordPress + WooCommerce** en Docker, publicado por el nginx de ISPConfig (hosting06) en `127.0.0.1:3020`.
- **sync/** (Node 22): cada `SYNC_HOURS` trae catálogo, coste y stock; cada 5 min revisa pedidos pagados.
- Todo se configura en `/opt/civired-shop/.env` (ver `.env.example`). Los secretos nunca van a GitHub.

## Instalar (hosting06)

```
curl -fsSL https://raw.githubusercontent.com/senvisito/civired-shop/main/install.sh | sudo bash
```

Pide las claves de la API de Ingram y el usuario de Icecat, instala WooCommerce en español con IVA 21 %, deja la tienda en modo *Próximamente* y arranca la sincronización. Después se actualiza sola desde GitHub cada 5 minutos.

## Comandos útiles (en /opt/civired-shop)

| Qué | Comando |
|---|---|
| Ver la sincronización | `docker compose logs -f sync` |
| Probar conexiones | `docker compose run --rm sync node src/index.js check` |
| Sincronizar ya | `docker compose run --rm sync node src/index.js once` |
| Cambiar margen, categorías… | editar `.env` y `docker compose up -d sync` |

## Pedidos (`ORDERS_MODE`)

- `notify` (por defecto): al pagar un cliente, el pedido recibe una nota con qué pedir y a qué proveedor (y aviso por Telegram si está configurado).
- `auto`: crea el pedido en Ingram con envío directo al cliente. Activarlo solo tras probar con un pedido real pequeño.

## Añadir otro proveedor

Crear `sync/src/providers/<nombre>.js` con la misma interfaz que `ingram.js` (`configured`, `discover`, `priceAndStock`, `createOrder`) y añadirlo a la lista en `sync/src/index.js`. La elección del más barato es automática.
