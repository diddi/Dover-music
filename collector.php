#!/usr/bin/env php
<?php
/**
 * Dover Radar Synth — AISstream.io WebSocket Collector
 *
 * Long-running CLI script that connects to AISstream.io WebSocket,
 * receives AIS messages for the Dover Strait bounding box, and
 * writes ship positions to a JSON cache file for ships.php to serve.
 *
 * Usage:
 *   php collector.php
 *   php collector.php --daemon   (suppress output, log to file only)
 *
 * The script auto-reconnects on connection loss.
 */

declare(strict_types=1);

$config = require __DIR__ . '/config.php';

// --- Configuration ---
$apiKey    = $config['aisstream_api_key'];
$bbox      = $config['bbox'];
$cacheFile = $config['cache_file'];
$logFile   = $config['log_file'];
$staleAfter = $config['ship_stale_after'];
$daemon    = in_array('--daemon', $argv);

// --- AIS ship type code mapping ---
$shipTypeMap = [
    30 => 'fishing',
    31 => 'tug', 32 => 'tug',
    33 => 'tug',    // dredging (close enough)
    34 => 'tug',    // diving ops
    35 => 'tug',    // military (map to generic)
    36 => 'tug',    // sailing
    37 => 'tug',    // pleasure craft
    40 => 'fishing', // HSC
    50 => 'tug',    // pilot vessel
    51 => 'tug',    // SAR
    52 => 'tug',
    60 => 'passenger', 61 => 'passenger', 62 => 'passenger',
    63 => 'passenger', 64 => 'passenger', 65 => 'passenger',
    66 => 'passenger', 67 => 'passenger', 68 => 'passenger', 69 => 'passenger',
    70 => 'cargo', 71 => 'cargo', 72 => 'cargo',
    73 => 'cargo', 74 => 'cargo', 75 => 'cargo',
    76 => 'cargo', 77 => 'cargo', 78 => 'cargo', 79 => 'cargo',
    80 => 'tanker', 81 => 'tanker', 82 => 'tanker',
    83 => 'tanker', 84 => 'tanker', 85 => 'tanker',
    86 => 'tanker', 87 => 'tanker', 88 => 'tanker', 89 => 'tanker',
];

$shipTypeNames = [
    'cargo' => 'Cargo', 'tanker' => 'Tanker', 'container' => 'Container',
    'ferry' => 'Ferry', 'fishing' => 'Fishing', 'passenger' => 'Passenger',
    'tug' => 'Tug',
];

// --- Ship position cache (in-memory) ---
$ships = [];

// --- Logging ---
function logMsg(string $msg, bool $daemon): void {
    global $logFile;
    $line = '[' . date('Y-m-d H:i:s') . '] ' . $msg;
    if (!$daemon) {
        echo $line . PHP_EOL;
    }
    @file_put_contents($logFile, $line . PHP_EOL, FILE_APPEND | LOCK_EX);
}

// --- Minimal WebSocket client ---

/**
 * Connect to a wss:// WebSocket endpoint. Returns the SSL socket resource.
 */
function wsConnect(string $host, int $port, string $path): mixed {
    $context = stream_context_create([
        'ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
        ],
    ]);

    $socket = @stream_socket_client(
        "ssl://{$host}:{$port}",
        $errno, $errstr, 10,
        STREAM_CLIENT_CONNECT,
        $context
    );

    if (!$socket) {
        throw new \RuntimeException("Connection failed: {$errno} {$errstr}");
    }

    // WebSocket handshake
    $key = base64_encode(random_bytes(16));
    $headers = "GET {$path} HTTP/1.1\r\n"
        . "Host: {$host}\r\n"
        . "Upgrade: websocket\r\n"
        . "Connection: Upgrade\r\n"
        . "Sec-WebSocket-Key: {$key}\r\n"
        . "Sec-WebSocket-Version: 13\r\n"
        . "\r\n";

    fwrite($socket, $headers);

    // Read handshake response
    $response = '';
    while (($line = fgets($socket)) !== false) {
        $response .= $line;
        if (trim($line) === '') break;
    }

    if (!str_contains($response, '101')) {
        throw new \RuntimeException("WebSocket handshake failed: " . trim($response));
    }

    stream_set_timeout($socket, 0, 500000); // 500ms read timeout for non-blocking reads

    return $socket;
}

/**
 * Send a WebSocket text frame (masked, as required by clients).
 */
function wsSend(mixed $socket, string $data): void {
    $len = strlen($data);
    $frame = chr(0x81); // FIN + text opcode

    if ($len < 126) {
        $frame .= chr($len | 0x80); // masked
    } elseif ($len < 65536) {
        $frame .= chr(126 | 0x80) . pack('n', $len);
    } else {
        $frame .= chr(127 | 0x80) . pack('J', $len);
    }

    // Masking key
    $mask = random_bytes(4);
    $frame .= $mask;

    // Mask the payload
    for ($i = 0; $i < $len; $i++) {
        $frame .= $data[$i] ^ $mask[$i % 4];
    }

    fwrite($socket, $frame);
}

/**
 * Read a WebSocket frame. Returns [opcode, payload] or null on timeout.
 */
function wsRead(mixed $socket): ?array {
    $header = @fread($socket, 2);
    if ($header === false || strlen($header) < 2) {
        return null; // timeout or no data
    }

    $byte1 = ord($header[0]);
    $byte2 = ord($header[1]);

    $opcode = $byte1 & 0x0F;
    $masked = ($byte2 & 0x80) !== 0;
    $len = $byte2 & 0x7F;

    if ($len === 126) {
        $ext = fread($socket, 2);
        $len = unpack('n', $ext)[1];
    } elseif ($len === 127) {
        $ext = fread($socket, 8);
        $len = unpack('J', $ext)[1];
    }

    $maskKey = '';
    if ($masked) {
        $maskKey = fread($socket, 4);
    }

    // Read payload in chunks
    $payload = '';
    $remaining = $len;
    while ($remaining > 0) {
        $chunk = fread($socket, min($remaining, 8192));
        if ($chunk === false) break;
        $payload .= $chunk;
        $remaining -= strlen($chunk);
    }

    // Unmask if needed
    if ($masked && $maskKey) {
        for ($i = 0; $i < strlen($payload); $i++) {
            $payload[$i] = $payload[$i] ^ $maskKey[$i % 4];
        }
    }

    return [$opcode, $payload];
}

/**
 * Send a WebSocket pong frame.
 */
function wsPong(mixed $socket, string $data): void {
    $len = strlen($data);
    $frame = chr(0x8A); // FIN + pong
    $frame .= chr($len | 0x80);
    $mask = random_bytes(4);
    $frame .= $mask;
    for ($i = 0; $i < $len; $i++) {
        $frame .= $data[$i] ^ $mask[$i % 4];
    }
    fwrite($socket, $frame);
}

// --- AIS message processing ---

function processMessage(array $msg): void {
    global $ships, $shipTypeMap, $shipTypeNames;

    $messageType = $msg['MessageType'] ?? '';
    $meta = $msg['MetaData'] ?? [];
    $mmsi = (string)($meta['MMSI'] ?? '');

    if (empty($mmsi)) return;

    $lat = $meta['latitude'] ?? null;
    $lon = $meta['longitude'] ?? null;

    // Initialize ship entry if new
    if (!isset($ships[$mmsi])) {
        $ships[$mmsi] = [
            'mmsi' => (int)$mmsi,
            'name' => '',
            'type' => 'cargo',
            'typeName' => 'Cargo',
            'lat' => 0,
            'lon' => 0,
            'speed' => 0,
            'heading' => 0,
            'length' => 100,
            'lastUpdate' => time(),
        ];
    }

    $ship = &$ships[$mmsi];
    $ship['lastUpdate'] = time();

    // Update name from metadata if available
    if (!empty($meta['ShipName']) && trim($meta['ShipName']) !== '') {
        $ship['name'] = trim($meta['ShipName']);
    }

    // Update position from metadata
    if ($lat !== null && $lon !== null && $lat != 0 && $lon != 0) {
        $ship['lat'] = round((float)$lat, 6);
        $ship['lon'] = round((float)$lon, 6);
    }

    // Process based on message type
    if ($messageType === 'PositionReport') {
        $report = $msg['Message']['PositionReport'] ?? [];

        if (isset($report['Latitude']) && $report['Latitude'] != 0) {
            $ship['lat'] = round((float)$report['Latitude'], 6);
        }
        if (isset($report['Longitude']) && $report['Longitude'] != 0) {
            $ship['lon'] = round((float)$report['Longitude'], 6);
        }
        if (isset($report['Sog'])) {
            $ship['speed'] = round((float)$report['Sog'], 1);
        }
        if (isset($report['TrueHeading']) && $report['TrueHeading'] < 360) {
            $ship['heading'] = (int)$report['TrueHeading'];
        } elseif (isset($report['Cog']) && $report['Cog'] < 360) {
            $ship['heading'] = round((float)$report['Cog']);
        }

    } elseif ($messageType === 'StandardClassBPositionReport' || $messageType === 'ExtendedClassBPositionReport') {
        $key = $messageType;
        $report = $msg['Message'][$key] ?? [];

        if (isset($report['Latitude']) && $report['Latitude'] != 0) {
            $ship['lat'] = round((float)$report['Latitude'], 6);
        }
        if (isset($report['Longitude']) && $report['Longitude'] != 0) {
            $ship['lon'] = round((float)$report['Longitude'], 6);
        }
        if (isset($report['Sog'])) {
            $ship['speed'] = round((float)$report['Sog'], 1);
        }
        if (isset($report['TrueHeading']) && $report['TrueHeading'] < 360) {
            $ship['heading'] = (int)$report['TrueHeading'];
        } elseif (isset($report['Cog']) && $report['Cog'] < 360) {
            $ship['heading'] = round((float)$report['Cog']);
        }

        // Extended Class B has ship name and type
        if ($messageType === 'ExtendedClassBPositionReport') {
            if (!empty($report['Name'])) {
                $ship['name'] = trim($report['Name']);
            }
            if (isset($report['Type'])) {
                $typeCode = (int)$report['Type'];
                $ship['type'] = $shipTypeMap[$typeCode] ?? 'cargo';
                $ship['typeName'] = $shipTypeNames[$ship['type']] ?? 'Unknown';
            }
        }

    } elseif ($messageType === 'ShipStaticData') {
        $static = $msg['Message']['ShipStaticData'] ?? [];

        if (!empty($static['Name'])) {
            $ship['name'] = trim($static['Name']);
        }
        if (isset($static['Type'])) {
            $typeCode = (int)$static['Type'];
            $ship['type'] = $shipTypeMap[$typeCode] ?? 'cargo';
            $ship['typeName'] = $shipTypeNames[$ship['type']] ?? 'Unknown';
        }

        // Calculate length from dimensions A+B
        $dim = $static['Dimension'] ?? [];
        $a = (int)($dim['A'] ?? 0);
        $b = (int)($dim['B'] ?? 0);
        if ($a + $b > 0) {
            $ship['length'] = $a + $b;
        }

        // Detect ferries by destination
        $dest = strtoupper(trim($static['Destination'] ?? ''));
        if (str_contains($dest, 'DOVER') || str_contains($dest, 'CALAIS') ||
            str_contains($dest, 'DUNKERQUE') || str_contains($dest, 'DUNKIRK')) {
            if ($ship['type'] === 'passenger') {
                $ship['type'] = 'ferry';
                $ship['typeName'] = 'Ferry';
            }
        }
    }
}

/**
 * Remove stale ships and write cache to disk.
 */
function writeCache(): void {
    global $ships, $cacheFile, $staleAfter, $bbox;

    $now = time();
    $active = [];

    foreach ($ships as $mmsi => $ship) {
        // Remove stale ships
        if ($now - $ship['lastUpdate'] > $staleAfter) {
            unset($ships[$mmsi]);
            continue;
        }

        // Only include ships with valid positions inside bbox
        if ($ship['lat'] < $bbox['lat_min'] || $ship['lat'] > $bbox['lat_max'] ||
            $ship['lon'] < $bbox['lon_min'] || $ship['lon'] > $bbox['lon_max']) {
            continue;
        }
        if ($ship['lat'] == 0 && $ship['lon'] == 0) {
            continue;
        }

        // Strip internal fields
        $active[] = [
            'mmsi'     => $ship['mmsi'],
            'name'     => $ship['name'] ?: ('MMSI ' . $ship['mmsi']),
            'type'     => $ship['type'],
            'typeName' => $ship['typeName'],
            'lat'      => $ship['lat'],
            'lon'      => $ship['lon'],
            'speed'    => $ship['speed'],
            'heading'  => $ship['heading'],
            'length'   => $ship['length'],
        ];
    }

    $data = json_encode($active, JSON_PRETTY_PRINT);

    // Atomic write: write to temp file then rename
    $tmpFile = $cacheFile . '.tmp';
    file_put_contents($tmpFile, $data, LOCK_EX);
    rename($tmpFile, $cacheFile);
}

// --- Main loop ---

logMsg("Dover Radar Synth — AISstream Collector starting", $daemon);
logMsg("API key: " . substr($apiKey, 0, 8) . "...", $daemon);
logMsg("Bounding box: [{$bbox['lat_min']},{$bbox['lon_min']}] to [{$bbox['lat_max']},{$bbox['lon_max']}]", $daemon);

$reconnectDelay = 5;
$maxReconnectDelay = 60;

while (true) {
    try {
        logMsg("Connecting to wss://stream.aisstream.io/v0/stream ...", $daemon);

        $socket = wsConnect('stream.aisstream.io', 443, '/v0/stream');

        logMsg("Connected. Sending subscription...", $daemon);

        // Send subscription
        $subscription = json_encode([
            'APIKey' => $apiKey,
            'BoundingBoxes' => [
                [[$bbox['lat_min'], $bbox['lon_min']], [$bbox['lat_max'], $bbox['lon_max']]]
            ],
            'FiltersShipMMSI' => [],
            'FilterMessageTypes' => [
                'PositionReport',
                'ShipStaticData',
                'StandardClassBPositionReport',
                'ExtendedClassBPositionReport',
            ],
        ]);

        wsSend($socket, $subscription);

        logMsg("Subscription sent. Listening for AIS messages...", $daemon);

        $messageCount = 0;
        $lastCacheWrite = 0;
        $lastStats = time();
        $reconnectDelay = 5; // Reset on successful connect

        while (true) {
            $frame = wsRead($socket);

            if ($frame === null) {
                // Timeout — check if connection is still alive
                if (feof($socket)) {
                    throw new \RuntimeException("Connection closed by server");
                }

                // Write cache periodically even without new messages
                if (time() - $lastCacheWrite >= 5) {
                    writeCache();
                    $lastCacheWrite = time();
                }
                continue;
            }

            [$opcode, $payload] = $frame;

            // Handle control frames
            if ($opcode === 0x08) {
                // Close frame
                logMsg("Server sent close frame", $daemon);
                break;
            }
            if ($opcode === 0x09) {
                // Ping → pong
                wsPong($socket, $payload);
                continue;
            }
            if ($opcode !== 0x01 && $opcode !== 0x02) {
                // Not text or binary, skip
                continue;
            }

            // Parse AIS message
            $msg = json_decode($payload, true);
            if (!$msg) continue;

            processMessage($msg);
            $messageCount++;

            // Write cache every 2 seconds
            if (time() - $lastCacheWrite >= 2) {
                writeCache();
                $lastCacheWrite = time();
            }

            // Log stats every 30 seconds
            if (time() - $lastStats >= 30) {
                $activeShips = count(array_filter($ships, fn($s) =>
                    $s['lat'] >= $bbox['lat_min'] && $s['lat'] <= $bbox['lat_max'] &&
                    $s['lon'] >= $bbox['lon_min'] && $s['lon'] <= $bbox['lon_max']
                ));
                logMsg("Messages: {$messageCount} | Ships in bbox: {$activeShips} | Total tracked: " . count($ships), $daemon);
                $lastStats = time();
            }
        }

    } catch (\Throwable $e) {
        logMsg("Error: " . $e->getMessage(), $daemon);
    }

    // Close socket if open
    if (isset($socket) && is_resource($socket)) {
        @fclose($socket);
    }

    logMsg("Reconnecting in {$reconnectDelay}s...", $daemon);
    sleep($reconnectDelay);
    $reconnectDelay = min($reconnectDelay * 2, $maxReconnectDelay);
}
