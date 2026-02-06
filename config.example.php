<?php
/**
 * Dover Radar Synth — Configuration
 *
 * Copy this file to config.php and fill in your API key:
 *   cp config.example.php config.php
 */

return [
    // AISstream.io API key (get yours at https://aisstream.io)
    'aisstream_api_key' => 'YOUR_API_KEY_HERE',

    // Data source: 'live' or 'simulated'
    'data_source' => 'live',

    // Dover Strait bounding box
    'bbox' => [
        'lat_min' => 50.7,
        'lat_max' => 51.4,
        'lon_min' => 0.8,
        'lon_max' => 2.3,
    ],

    // Center point
    'center' => [
        'lat' => 51.05,
        'lon' => 1.55,
    ],

    // Cache file path (shared between collector and API)
    'cache_file' => __DIR__ . '/data/ships_cache.json',

    // How long cached positions are valid (seconds)
    'cache_max_age' => 120,

    // How long a ship position stays in cache without updates (seconds)
    'ship_stale_after' => 300,

    // Collector log file
    'log_file' => __DIR__ . '/data/collector.log',
];
