<?php
/**
 * Plugin Name: Urumi platform glue
 * Description: Must-use plugin installed by the Helm chart (charts/store). Keeps WordPress
 *              application passwords usable over plain HTTP inside the cluster and limits them
 *              to the accounts that need them.
 * Version:     1.0.0
 *
 * Mounted from a ConfigMap at wp-content/mu-plugins/urumi-platform.php (subPath), so it is loaded
 * on every request and cannot be deactivated from the admin UI.
 */

if (!defined('ABSPATH')) {
    exit;
}

/*
 * WordPress refuses application passwords unless the site is served over HTTPS (or the
 * environment is "local"). TLS terminates at the Ingress and the WooCommerce MCP server talks to
 * Apache over plain HTTP on the cluster network, so the check must be relaxed explicitly.
 * (The official image already sets $_SERVER['HTTPS'] = 'on' when X-Forwarded-Proto is https, so
 * public URLs come out right when the Ingress serves TLS; nothing to add here.)
 */
add_filter('wp_is_application_passwords_available', '__return_true');

/*
 * Defence in depth: only the MCP service account (mcp-bot, created by the setup Job) and
 * administrators may own application passwords. Every other role gets the feature switched off,
 * which shrinks the surface a leaked customer login could expose via the REST API.
 */
add_filter('wp_is_application_passwords_available_for_user', function ($available, $user) {
    if (!$user instanceof WP_User) {
        return $available;
    }
    if ($user->user_login === 'mcp-bot') {
        return true;
    }
    return user_can($user, 'manage_options');
}, 10, 2);
