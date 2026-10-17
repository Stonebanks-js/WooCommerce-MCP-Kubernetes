<?php
/**
 * Installs the deterministic WordPress application password for the mcp-bot user.
 * Run by files/setup.sh with `wp eval-file`, so WordPress (and WP_CLI) are loaded.
 *
 * The plaintext comes from the Secret (WOO_APP_PASSWORD, 24 alphanumeric chars). WordPress only
 * stores a hash, so woo-mcp reads the same plaintext from the same Secret: no key generation step
 * and nothing to copy between systems. Re-running replaces any existing item named "woo-mcp".
 */

$user = get_user_by('login', 'mcp-bot');
if (!$user) {
    WP_CLI::error('user mcp-bot does not exist');
}

$plaintext = getenv('WOO_APP_PASSWORD');
if (!is_string($plaintext) || $plaintext === '') {
    WP_CLI::error('WOO_APP_PASSWORD is not set');
}

// WP >= 6.8 hashes application passwords with WP_Application_Passwords::hash_password (bcrypt);
// older cores used wp_hash_password. Use whichever this core verifies against.
$hash = method_exists('WP_Application_Passwords', 'hash_password')
    ? WP_Application_Passwords::hash_password($plaintext)
    : wp_hash_password($plaintext);

$items = array_values(array_filter(
    WP_Application_Passwords::get_user_application_passwords($user->ID),
    static fn($item) => ($item['name'] ?? '') !== 'woo-mcp'
));
$items[] = [
    'uuid'      => wp_generate_uuid4(),
    'app_id'    => '',
    'name'      => 'woo-mcp',
    'password'  => $hash,
    'created'   => time(),
    'last_used' => null,
    'last_ip'   => null,
];

// WP_Application_Passwords::set_user_application_passwords() is protected, so write the same user
// meta it writes (and flag application passwords as "in use" for the network, as core does on create).
$ok = update_user_meta($user->ID, WP_Application_Passwords::USERMETA_KEY_APPLICATION_PASSWORDS, $items);
if ($ok === false) {
    WP_CLI::error('failed to store the application password');
}
update_network_option(get_main_network_id(), WP_Application_Passwords::OPTION_KEY_IN_USE, true);

// Prove it before the Job reports success: core must verify the plaintext against what we stored.
$check = wp_authenticate_application_password(null, 'mcp-bot', $plaintext);
if (!($check instanceof WP_User)) {
    // wp_authenticate_application_password needs REST_REQUEST; outside it the check is skipped, so
    // fall back to verifying the hash directly.
    $verified = method_exists('WP_Application_Passwords', 'check_password')
        ? WP_Application_Passwords::check_password($plaintext, $hash)
        : wp_check_password($plaintext, $hash);
    if (!$verified) {
        WP_CLI::error('stored application password does not verify against the plaintext');
    }
}
WP_CLI::success('application password "woo-mcp" installed for mcp-bot');
