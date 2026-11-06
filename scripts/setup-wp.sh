#!/bin/sh
# Se ejecuta DENTRO del contenedor wpcli. Instala y configura WordPress + WooCommerce (idempotente).
# Variables: SITE_URL, ADMIN_USER, ADMIN_PASS, ADMIN_EMAIL, SYNC_USER
set -eu
cd /var/www/html
if ! wp core is-installed 2>/dev/null; then
  wp core install --url="$SITE_URL" --title="CiviRed Shop" --admin_user="$ADMIN_USER" \
    --admin_password="$ADMIN_PASS" --admin_email="$ADMIN_EMAIL" --skip-email
  echo "WordPress instalado"
fi
wp language core install es_ES --activate >/dev/null 2>&1 || true
wp option update timezone_string Europe/Madrid >/dev/null
wp option update date_format 'd/m/Y' >/dev/null
wp rewrite structure '/%postname%/' >/dev/null
# No indexar en Google hasta que la tienda esté lista
wp option update blog_public 0 >/dev/null

wp plugin is-installed woocommerce || wp plugin install woocommerce
wp plugin activate woocommerce >/dev/null
wp language plugin install woocommerce es_ES >/dev/null 2>&1 || true
wp theme is-installed storefront || wp theme install storefront
wp theme activate storefront >/dev/null
# Quitar plugins y temas de ejemplo
wp plugin delete hello akismet >/dev/null 2>&1 || true

# Ajustes de tienda en España
wp option update woocommerce_default_country 'ES:V' >/dev/null
wp option update woocommerce_currency EUR >/dev/null
wp option update woocommerce_currency_pos right_space >/dev/null
wp option update woocommerce_price_thousand_sep '.' >/dev/null
wp option update woocommerce_price_decimal_sep ',' >/dev/null
wp option update woocommerce_price_num_decimals 2 >/dev/null
wp option update woocommerce_calc_taxes yes >/dev/null
wp option update woocommerce_prices_include_tax yes >/dev/null
wp option update woocommerce_tax_display_shop incl >/dev/null
wp option update woocommerce_tax_display_cart incl >/dev/null
wp option update woocommerce_tax_based_on base >/dev/null
wp option update woocommerce_allowed_countries specific >/dev/null
wp option update woocommerce_specific_allowed_countries '["ES"]' --format=json >/dev/null
wp option update woocommerce_ship_to_countries '' >/dev/null
wp option update woocommerce_manage_stock yes >/dev/null
wp option update woocommerce_hide_out_of_stock_items yes >/dev/null
wp option update woocommerce_weight_unit kg >/dev/null
wp option update woocommerce_dimension_unit cm >/dev/null
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
# Modo "Próximamente": solo tú ves la tienda hasta que la abras al público
wp option update woocommerce_coming_soon yes >/dev/null
wp option update woocommerce_store_pages_only no >/dev/null

ADMIN_ID=$(wp user get "$ADMIN_USER" --field=ID)
wp wc tool run install_pages --user="$ADMIN_ID" >/dev/null 2>&1 || true
if [ -z "$(wp wc tax list --user="$ADMIN_ID" --field=id 2>/dev/null)" ]; then
  wp wc tax create --country=ES --rate=21 --name=IVA --shipping=true --user="$ADMIN_ID" >/dev/null && echo "IVA 21% creado"
fi

# Usuario para la sincronización (gestor de tienda, sin acceso de administrador)
if ! wp user get "$SYNC_USER" >/dev/null 2>&1; then
  wp user create "$SYNC_USER" "sync@shop.civired.invalid" --role=shop_manager --display_name="Sincronización" >/dev/null
fi
wp rewrite flush >/dev/null
echo "WooCommerce configurado"
