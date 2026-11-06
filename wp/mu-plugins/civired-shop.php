<?php
/**
 * Plugin Name: CiviRed Shop (ajustes)
 * Description: Ajustes de shop.civired.com. Gestionado desde GitHub (civired-shop/wp/mu-plugins); no editar aquí.
 */
if (!defined('ABSPATH')) exit;

// La web va siempre por HTTPS detrás de nginx: permite contraseñas de aplicación para el servicio de sincronización.
add_filter('wp_is_application_passwords_available', '__return_true');

// Las fotos de Icecat se descargan una vez a la biblioteca: permitir su dominio y dar más tiempo.
add_filter('http_request_timeout', function ($t) { return max($t, 30); });

// Tabla de especificaciones legible en la ficha de producto.
add_action('wp_head', function () {
    if (!function_exists('is_product') || !is_product()) return;
    echo '<style>.cr-specs{width:100%;border-collapse:collapse}.cr-specs th,.cr-specs td{padding:.4em .6em;border-bottom:1px solid #eee;text-align:left;vertical-align:top}.cr-specs th{width:40%;font-weight:600}</style>';
});

// No mostrar al público el proveedor ni el coste (metadatos internos con guion bajo ya son privados).
