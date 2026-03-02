<?php
header('Content-Type: text/plain');
echo "REDIS_MODE=" . getenv('REDIS_MODE') . "\n";
echo "REDIS_HOST=" . getenv('REDIS_HOST') . "\n";
echo "REDIS_TLS=" . getenv('REDIS_TLS_ENABLED') . "\n";
echo "REDIS_PORT=" . getenv('REDIS_PORT') . "\n";
try {
    $h = getenv('REDIS_HOST');
    $p = (int)getenv('REDIS_PORT') ?: 6379;
    $tls = getenv('REDIS_TLS_ENABLED') === 'true';
    $host = $tls ? "tls://$h" : $h;
    $r = new Redis();
    $ctx = $tls ? ['stream' => ['verify_peer' => true, 'verify_peer_name' => true]] : [];
    $ok = $r->connect($host, $p, 5.0, null, 0, 5.0, $ctx);
    echo "REDIS_CONNECT=" . ($ok ? "OK" : "FAIL") . "\n";
    $r->set("diag_test", "hello");
    echo "REDIS_SET=OK\n";
    echo "REDIS_GET=" . $r->get("diag_test") . "\n";
} catch (Exception $e) {
    echo "REDIS_ERROR=" . $e->getMessage() . "\n";
}
