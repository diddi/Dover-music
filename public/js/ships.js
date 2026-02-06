/**
 * Dover Radar Synth - Ship Data Manager
 *
 * Fetches ship positions from PHP proxy or simulates client-side.
 * Speed-based coloring to match art.lol/boats aesthetic.
 */
const DoverShips = (() => {

    // Dover Strait center and bounding box
    const CENTER = { lat: 51.05, lon: 1.55 };
    const BBOX = {
        latMin: 50.7, latMax: 51.4,
        lonMin: 0.8, lonMax: 2.3
    };

    /**
     * Speed-based color using HSL.
     * Fast = warm (orange/red), Slow = cool (green/blue), Anchored = purple
     */
    function getSpeedColor(speed) {
        if (speed <= 2)  return 'hsl(270, 60%, 60%)';  // anchored — purple
        if (speed <= 6)  return 'hsl(190, 80%, 60%)';  // very slow — cyan
        if (speed <= 12) return 'hsl(120, 80%, 60%)';  // slow — green
        if (speed <= 18) return 'hsl(45, 80%, 60%)';   // medium — amber
        return 'hsl(15, 80%, 60%)';                     // fast — orange-red
    }

    let ships = [];
    let dataSource = 'simulated';
    let fetchInterval = null;
    let useClientSimulation = true;

    // --- Client-side simulation ---
    const SIM_SHIP_TYPES = [
        { type: 'cargo',    minSpeed: 10, maxSpeed: 16, minLen: 100, maxLen: 300 },
        { type: 'tanker',   minSpeed: 8,  maxSpeed: 14, minLen: 150, maxLen: 350 },
        { type: 'container',minSpeed: 12, maxSpeed: 22, minLen: 200, maxLen: 400 },
        { type: 'ferry',    minSpeed: 15, maxSpeed: 25, minLen: 80,  maxLen: 200 },
        { type: 'fishing',  minSpeed: 3,  maxSpeed: 10, minLen: 15,  maxLen: 50 },
        { type: 'passenger',minSpeed: 14, maxSpeed: 22, minLen: 100, maxLen: 250 },
        { type: 'tug',      minSpeed: 6,  maxSpeed: 12, minLen: 20,  maxLen: 45 },
    ];

    const SIM_NAMES = [
        'MV Fortune', 'MT Glory', 'MSC Spirit', 'CMA CGM Pride', 'OOCL Star',
        'Ever Express', 'Maersk Pioneer', 'NS Horizon', 'SS Atlantic', 'MV Europa',
        'HMS Dover', 'MT Calais', 'MSC Thames', 'Neptune', 'Triton',
        'MV Poseidon', 'SS Albatross', 'Seahawk', 'MV Vigilant', 'Ever Endurance',
        'CMA CGM Volta', 'OOCL Tokyo', 'Maersk Elba', 'MV Zephyr', 'MT Coral',
        'SS Meridian', 'MV Fjord', 'NS Arctic', 'Ever Nimbus', 'MT Beacon',
        'HMS Sentinel', 'MSC Aurora', 'MV Compass', 'Maersk Oslo', 'OOCL Baltic',
        'MV Orion', 'MT Solstice', 'CMA Titan', 'Maersk Jade', 'NS Equinox'
    ];

    let simShips = null;

    function initSimulation() {
        const count = 20 + Math.floor(Math.random() * 15);
        simShips = [];

        for (let i = 0; i < count; i++) {
            const laneRoll = Math.random();
            const typeInfo = laneRoll > 0.7 && laneRoll < 0.85
                ? SIM_SHIP_TYPES[3]
                : SIM_SHIP_TYPES[Math.floor(Math.random() * SIM_SHIP_TYPES.length)];

            let lat, lon, heading;

            if (laneRoll < 0.35) {
                // NE-bound lane
                heading = 30 + Math.random() * 30;
                lat = CENTER.lat + (Math.random() - 0.5) * 0.15 + 0.05;
                lon = BBOX.lonMin + Math.random() * (BBOX.lonMax - BBOX.lonMin);
            } else if (laneRoll < 0.7) {
                // SW-bound lane
                heading = 210 + Math.random() * 30;
                lat = CENTER.lat + (Math.random() - 0.5) * 0.15 - 0.05;
                lon = BBOX.lonMin + Math.random() * (BBOX.lonMax - BBOX.lonMin);
            } else {
                // Cross-channel ferry
                heading = Math.random() > 0.5 ? 130 + Math.random() * 30 : 310 + Math.random() * 30;
                lat = 50.87 + Math.random() * 0.25;
                lon = 1.32 + Math.random() * 0.45;
            }

            const speed = typeInfo.minSpeed + Math.random() * (typeInfo.maxSpeed - typeInfo.minSpeed);
            const length = typeInfo.minLen + Math.random() * (typeInfo.maxLen - typeInfo.minLen);

            simShips.push({
                mmsi: 200000000 + i * 1000 + Math.floor(Math.random() * 999),
                name: SIM_NAMES[i % SIM_NAMES.length],
                type: typeInfo.type,
                typeName: typeInfo.type.charAt(0).toUpperCase() + typeInfo.type.slice(1),
                lat, lon,
                speed: Math.round(speed * 10) / 10,
                heading: heading + (Math.random() - 0.5) * 10,
                length: Math.round(length),
            });
        }
    }

    function updateSimulation() {
        if (!simShips) initSimulation();

        const dt = 0.5;
        const knotToDegreeLat = 1 / 3600 / 1.15078;

        for (const ship of simShips) {
            const headingRad = (ship.heading * Math.PI) / 180;
            const speedDeg = ship.speed * knotToDegreeLat * dt;

            ship.lat += Math.cos(headingRad) * speedDeg;
            ship.lon += Math.sin(headingRad) * speedDeg / Math.cos(ship.lat * Math.PI / 180);

            // Wrap ships that leave the bounding box
            if (ship.lon > BBOX.lonMax + 0.1) {
                ship.lon = BBOX.lonMin - 0.05;
                ship.lat = CENTER.lat + (Math.random() - 0.5) * 0.2;
            } else if (ship.lon < BBOX.lonMin - 0.1) {
                ship.lon = BBOX.lonMax + 0.05;
                ship.lat = CENTER.lat + (Math.random() - 0.5) * 0.2;
            }
            if (ship.lat > BBOX.latMax + 0.1 || ship.lat < BBOX.latMin - 0.1) {
                ship.lat = CENTER.lat + (Math.random() - 0.5) * 0.1;
            }
        }

        ships = [...simShips];
    }

    async function fetchFromServer() {
        try {
            const res = await fetch('../api/ships.php');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            ships = data.ships || [];
            dataSource = data.source === 'aisstream' ? 'live' : 'simulated';
            useClientSimulation = false;
        } catch (e) {
            useClientSimulation = true;
            dataSource = 'simulated';
            updateSimulation();
        }
    }

    /**
     * Convert ship lat/lon to position relative to radar center.
     * Returns {x, y} in range roughly -1 to 1.
     */
    function toRadarPosition(ship) {
        const latRange = (BBOX.latMax - BBOX.latMin) / 2;
        const lonRange = (BBOX.lonMax - BBOX.lonMin) / 2;

        const x = (ship.lon - CENTER.lon) / lonRange;
        const y = -(ship.lat - CENTER.lat) / latRange;

        return { x, y };
    }

    /**
     * Get ring index for a ship (0 = innermost).
     */
    function getRingIndex(ship, ringCount) {
        const pos = toRadarPosition(ship);
        const dist = Math.sqrt(pos.x * pos.x + pos.y * pos.y);
        const ringWidth = 1.0 / ringCount;
        const index = Math.floor(dist / ringWidth);
        return index < ringCount ? index : -1;
    }

    /**
     * Convert a lat/lon to radar-relative position (for coastline).
     */
    function geoToRadar(lat, lon) {
        const latRange = (BBOX.latMax - BBOX.latMin) / 2;
        const lonRange = (BBOX.lonMax - BBOX.lonMin) / 2;
        return {
            x: (lon - CENTER.lon) / lonRange,
            y: -(lat - CENTER.lat) / latRange,
        };
    }

    function startFetching(intervalMs = 5000) {
        fetchFromServer();
        fetchInterval = setInterval(() => {
            if (useClientSimulation) {
                updateSimulation();
            } else {
                fetchFromServer();
            }
        }, intervalMs);
    }

    function stopFetching() {
        if (fetchInterval) {
            clearInterval(fetchInterval);
            fetchInterval = null;
        }
    }

    return {
        startFetching,
        stopFetching,
        getShips: () => ships,
        getDataSource: () => dataSource,
        toRadarPosition,
        getRingIndex,
        geoToRadar,
        getSpeedColor,
        getCenter: () => CENTER,
        getBBox: () => BBOX,
    };
})();
