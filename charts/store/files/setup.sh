#!/bin/sh
# Idempotent WordPress + WooCommerce setup, run by the chart's post-install/post-upgrade Job
# (templates/setup-job.yaml) inside the wordpress:cli image as www-data (uid 33), with the
# WordPress PVC mounted at /var/www/html. Every step is safe to repeat: an upgrade re-runs the
# whole script and only changes what differs.
#
# Inputs (environment, set by the Job): WP_URL, WP_TITLE, WP_ADMIN_USER, WP_ADMIN_EMAIL,
# WP_ADMIN_PASSWORD (Secret), WP_HOSTNAME, WC_VERSION, WC_COUNTRY, WC_CURRENCY, SAMPLE_ENABLED,
# SAMPLE_NAME, SAMPLE_PRICE, WOO_APP_PASSWORD (Secret), VERIFY_URL.
# Secrets are passed through to wp-cli / PHP and never printed.
set -eu

cd /var/www/html

log() { printf '%s setup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# 1. Wait for the init container's wp-config.php and for MariaDB. Both loops are bounded by the
#    Job's activeDeadlineSeconds, so a broken database fails the hook instead of hanging forever.
log "waiting for wp-config.php"
until [ -s wp-config.php ]; do sleep 2; done
log "waiting for the database"
until wp db check >/dev/null 2>&1; do sleep 2; done

# 2. Core install (no-op when the site already exists).
if wp core is-installed >/dev/null 2>&1; then
  log "WordPress already installed"
else
  log "installing WordPress core at $WP_URL"
  wp core install \
    --url="$WP_URL" \
    --title="$WP_TITLE" \
    --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" \
    --skip-email
fi

# 3. Pretty permalinks (the image ships the matching .htaccess, so no --hard) and search visibility.
wp rewrite structure '/%postname%/'
wp option update blog_public 1

# 4. WooCommerce, pinned version. Activation creates the shop/cart/checkout/my-account pages.
if ! wp plugin is-installed woocommerce; then
  log "installing WooCommerce $WC_VERSION"
  wp plugin install woocommerce --version="$WC_VERSION"
fi
wp plugin activate woocommerce

# 5. Skip the onboarding wizard and make the store public (not "coming soon").
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp transient delete _wc_activation_redirect || true
wp option update woocommerce_coming_soon no
wp option update woocommerce_store_pages_only no

# 6. Store basics: currency/country from values, no taxes, guest checkout, and shipping disabled so
#    checkout needs no shipping method (keeps the demo order flow to "add to cart -> pay on delivery").
wp option update woocommerce_default_country "$WC_COUNTRY"
wp option update woocommerce_currency "$WC_CURRENCY"
wp option update woocommerce_allowed_countries all
wp option update woocommerce_ship_to_countries disabled
wp option update woocommerce_calc_taxes no
wp option update woocommerce_enable_guest_checkout yes
wp option update woocommerce_enable_checkout_login_reminder no

# 7. Safety net for the pages, then enable Cash on Delivery. Every `wp wc` command needs --user.
wp wc tool run install_pages --user="$WP_ADMIN_USER"
wp wc payment_gateway update cod --enabled=true --user="$WP_ADMIN_USER"

# 8. One sample product, created only when no product with that name exists yet.
if [ "${SAMPLE_ENABLED:-false}" = "true" ]; then
  # A failing count must abort (set -e) rather than be read as "no product", or every re-run would
  # add another sample product.
  existing="$(wp wc product list --search="$SAMPLE_NAME" --format=count --user="$WP_ADMIN_USER")"
  if [ "$existing" = "0" ]; then
    log "creating sample product \"$SAMPLE_NAME\""
    wp wc product create \
      --name="$SAMPLE_NAME" \
      --type=simple \
      --regular_price="$SAMPLE_PRICE" \
      --status=publish \
      --user="$WP_ADMIN_USER" \
      --porcelain
  else
    log "sample product \"$SAMPLE_NAME\" already exists"
  fi
fi

# 9. The MCP service account: a shop_manager (can read/write products and orders, cannot change
#    site settings). Its login password is random and never used; only the application password
#    installed in step 10 is.
if ! wp user get mcp-bot --field=ID >/dev/null 2>&1; then
  log "creating user mcp-bot (shop_manager)"
  wp user create mcp-bot "mcp-bot@$WP_HOSTNAME" \
    --role=shop_manager \
    --user_pass="$(wp eval 'echo wp_generate_password(32,false);')" \
    --porcelain
fi

# 10. Install the deterministic application password from the Secret (replaces any "woo-mcp" item).
wp eval-file /scripts/app-password.php

# 11. Verify end to end: WooCommerce REST must accept mcp-bot's application password over the
#     in-cluster Service. The cli image is Alpine and has no curl, so plain PHP does the request.
log "verifying WooCommerce REST access as mcp-bot"
php /scripts/verify.php

log "done"
