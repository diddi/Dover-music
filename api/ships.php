<?php
/**
 * Dover Radar Synth — Ship Data API
 *
 * Serves ship positions as JSON. Reads from:
 * - Live AIS cache (written by collector.php), or
 * - Simulated data as fallback
 *
 * The frontend polls this endpoint every few seconds.
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-store');

$config = require __DIR__ . '/../config.php';

$cacheFile  = $config['cache_file'];
$cacheMaxAge = $config['cache_max_age'];
$dataSource = $config['data_source'];

$bbox   = $config['bbox'];
$center = $config['center'];

// --- Try live cache first ---
function readLiveCache(string $cacheFile, int $maxAge): ?array {
    if (!file_exists($cacheFile)) return null;
    if (time() - filemtime($cacheFile) > $maxAge) return null;

    $data = @file_get_contents($cacheFile);
    if (!$data) return null;

    $ships = json_decode($data, true);
    if (!is_array($ships)) return null;
    if (count($ships) === 0) return null;

    return $ships;
}

// --- Simulated data fallback ---
function generateSimulatedShips(array $bbox): array {
    $shipTypes = [
        ['type' => 'cargo',    'name' => 'Cargo',     'minSpeed' => 10, 'maxSpeed' => 16, 'minLen' => 100, 'maxLen' => 300],
        ['type' => 'tanker',   'name' => 'Tanker',     'minSpeed' => 8,  'maxSpeed' => 14, 'minLen' => 150, 'maxLen' => 350],
        ['type' => 'container','name' => 'Container',  'minSpeed' => 12, 'maxSpeed' => 22, 'minLen' => 200, 'maxLen' => 400],
        ['type' => 'ferry',    'name' => 'Ferry',      'minSpeed' => 15, 'maxSpeed' => 25, 'minLen' => 80,  'maxLen' => 200],
        ['type' => 'fishing',  'name' => 'Fishing',    'minSpeed' => 3,  'maxSpeed' => 10, 'minLen' => 15,  'maxLen' => 50],
        ['type' => 'passenger','name' => 'Passenger',  'minSpeed' => 14, 'maxSpeed' => 22, 'minLen' => 100, 'maxLen' => 250],
        ['type' => 'tug',      'name' => 'Tug',        'minSpeed' => 6,  'maxSpeed' => 12, 'minLen' => 20,  'maxLen' => 45],
    ];

    $prefixes = ['MV', 'MT', 'MSC', 'CMA CGM', 'OOCL', 'HMS', 'SS', 'NS', 'Ever', 'Maersk'];
    $suffixes = ['Fortune', 'Glory', 'Spirit', 'Pride', 'Star', 'Express', 'Pioneer', 'Horizon', 'Atlantic', 'Europa',
                 'Dover', 'Calais', 'Thames', 'Neptune', 'Triton', 'Poseidon', 'Albatross', 'Seahawk', 'Vigilant', 'Endurance'];

    $centerLat = ($bbox['lat_min'] + $bbox['lat_max']) / 2;
    $timeFactor = time();
    $ships = [];
    $shipCount = rand(25, 40);

    for ($i = 0; $i < $shipCount; $i++) {
        $seed = intval(crc32("ship_$i") + intval($timeFactor / 10) * $i);
        mt_srand($seed);

        $typeInfo = $shipTypes[array_rand($shipTypes)];
        $laneRoll = mt_rand(0, 100);

        if ($laneRoll < 35) {
            $heading = mt_rand(30, 60);
            $lat = $centerLat + (mt_rand(-20, 20) / 100) + 0.05;
            $lon = $bbox['lon_min'] + (intval($timeFactor / 30 + $i * 37) % 150) / 100;
        } elseif ($laneRoll < 70) {
            $heading = mt_rand(210, 240);
            $lat = $centerLat + (mt_rand(-20, 20) / 100) - 0.05;
            $lon = $bbox['lon_min'] + (intval($timeFactor / 30 + $i * 41) % 150) / 100;
        } else {
            $typeInfo = $shipTypes[3]; // ferry
            $goingToFrance = mt_rand(0, 1);
            $heading = $goingToFrance ? mt_rand(130, 160) : mt_rand(310, 340);
            $progress = (intval($timeFactor / 20 + $i * 53) % 100) / 100;
            $lat = $goingToFrance ? 51.12 - $progress * 0.25 : 50.87 + $progress * 0.25;
            $lon = $goingToFrance ? 1.32 + $progress * 0.45 : 1.77 - $progress * 0.45;
        }

        $lat = max($bbox['lat_min'], min($bbox['lat_max'], $lat));
        $lon = max($bbox['lon_min'], min($bbox['lon_max'], $lon));

        $speed = $typeInfo['minSpeed'] + mt_rand(0, ($typeInfo['maxSpeed'] - $typeInfo['minSpeed']) * 10) / 10;
        $length = mt_rand($typeInfo['minLen'], $typeInfo['maxLen']);
        $name = $prefixes[mt_rand(0, count($prefixes) - 1)] . ' ' . $suffixes[mt_rand(0, count($suffixes) - 1)];

        $ships[] = [
            'mmsi'     => 200000000 + $i * 1000 + mt_rand(0, 999),
            'name'     => $name,
            'type'     => $typeInfo['type'],
            'typeName' => $typeInfo['name'],
            'lat'      => round($lat, 6),
            'lon'      => round($lon, 6),
            'speed'    => round($speed, 1),
            'heading'  => $heading + mt_rand(-5, 5),
            'length'   => $length,
        ];
    }

    mt_srand();
    return $ships;
}

// --- Determine data source ---
$source = 'simulated';
$ships = null;

if ($dataSource === 'live') {
    $ships = readLiveCache($cacheFile, $cacheMaxAge);
    if ($ships !== null) {
        $source = 'aisstream';
    }
}

// Fallback to simulation
if ($ships === null) {
    $ships = generateSimulatedShips($bbox);
    $source = 'simulated';
}

// --- Response ---
echo json_encode([
    'timestamp' => time(),
    'center'    => $center,
    'bbox'      => $bbox,
    'source'    => $source,
    'ships'     => $ships,
], JSON_PRETTY_PRINT);
