<?php
/**
 * End-to-end check run at the end of files/setup.sh: the WooCommerce REST API must accept the
 * mcp-bot application password over the in-cluster WordPress Service (exactly what woo-mcp does).
 * Plain PHP streams are used because the wordpress:cli image (Alpine) ships no curl.
 * Exit code 1 fails the Job (and therefore the Helm hook) when the store is not usable.
 */

$url = getenv('VERIFY_URL') ?: '';
$password = getenv('WOO_APP_PASSWORD') ?: '';
if ($url === '' || $password === '') {
    fwrite(STDERR, "verify: VERIFY_URL or WOO_APP_PASSWORD missing\n");
    exit(1);
}

$context = stream_context_create([
    'http' => [
        'method'        => 'GET',
        'header'        => "Authorization: Basic " . base64_encode('mcp-bot:' . $password) . "\r\n"
                         . "Accept: application/json\r\n",
        'timeout'       => 30,
        'ignore_errors' => true,   // read the body/status on 4xx/5xx instead of a warning
    ],
]);

$status = 0;
for ($attempt = 1; $attempt <= 10; $attempt++) {
    $body = @file_get_contents($url, false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $header) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $header, $m)) {
            $status = (int) $m[1];
        }
    }
    if ($status === 200) {
        $decoded = json_decode((string) $body, true);
        $count = is_array($decoded) ? count($decoded) : 0;
        echo "verify: HTTP 200 from $url ($count product(s) in the first page)\n";
        exit(0);
    }
    fwrite(STDERR, "verify: attempt $attempt got HTTP $status from $url, retrying\n");
    sleep(3);
}
fwrite(STDERR, "verify: WooCommerce REST did not accept the mcp-bot application password (last HTTP $status)\n");
exit(1);
