/**
 * Dover Radar Synth - Radar Visualization
 *
 * Matching art.lol/boats aesthetic:
 * - Chevron-shaped ship blips colored by speed
 * - Dover Strait coastline outline
 * - Clean concentric rings with subtle grid
 * - Cinematic start screen
 * - Hover tooltips
 * - Audio controls via 'D' key
 * - Fullscreen support
 */
(() => {
    // --- DOM ---
    const canvas = document.getElementById('sonar');
    const ctx = canvas.getContext('2d');
    const startScreen = document.getElementById('start-screen');
    const zoneIndicator = document.getElementById('zone-indicator');
    const infoPanel = document.getElementById('info-panel');
    const shipCountEl = document.getElementById('ship-count');
    const tooltip = document.getElementById('hover-tooltip');
    const debugPanel = document.getElementById('debug-panel');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const audioToggleBtn = document.getElementById('audio-toggle-btn');

    // --- State ---
    const RING_COUNT = DoverAudio.RING_COUNT;
    let sweepSpeed = 0.8; // radians per second
    let sweepAngle = 0;
    let lastTime = 0;
    let animId = null;
    let hasStarted = false;
    let triggeredShips = new Set();
    let lastSweepQuadrant = -1;

    // Canvas sizing
    let cx, cy, radius;

    // --- Simplified Dover Strait coastline (lat/lon points) ---
    // English coast: Dover to Folkestone area
    const COAST_ENGLAND = [
        { lat: 51.35, lon: 1.00 },
        { lat: 51.33, lon: 1.10 },
        { lat: 51.30, lon: 1.15 },
        { lat: 51.25, lon: 1.18 },
        { lat: 51.20, lon: 1.20 },
        { lat: 51.15, lon: 1.22 },
        { lat: 51.13, lon: 1.30 },
        { lat: 51.12, lon: 1.35 },
        { lat: 51.10, lon: 1.32 },
        { lat: 51.08, lon: 1.22 },
        { lat: 51.07, lon: 1.10 },
        { lat: 51.08, lon: 1.00 },
    ];

    // French coast: Calais to Cap Gris-Nez area
    const COAST_FRANCE = [
        { lat: 50.87, lon: 1.55 },
        { lat: 50.88, lon: 1.60 },
        { lat: 50.90, lon: 1.68 },
        { lat: 50.93, lon: 1.78 },
        { lat: 50.95, lon: 1.85 },
        { lat: 50.96, lon: 1.90 },
        { lat: 50.97, lon: 1.98 },
        { lat: 50.97, lon: 2.05 },
        { lat: 50.96, lon: 2.10 },
        { lat: 50.95, lon: 2.15 },
    ];

    // Place labels
    const PLACES = [
        { name: 'Dover', lat: 51.13, lon: 1.31 },
        { name: 'Folkestone', lat: 51.08, lon: 1.17 },
        { name: 'Calais', lat: 50.95, lon: 1.86 },
    ];

    function resize() {
        const isFullscreen = document.fullscreenElement
            || document.webkitFullscreenElement
            || document.body.classList.contains('ios-fullscreen');

        const wrap = canvas.parentElement;
        let maxH, maxW;

        if (isFullscreen) {
            maxH = window.innerHeight;
            maxW = window.innerWidth;
        } else {
            maxH = window.innerHeight - 40;
            // On mobile (portrait), use the full width minus some padding
            const isMobile = window.innerWidth <= 900;
            if (isMobile) {
                maxW = window.innerWidth - 20;
                // Leave room for info panel below (if visible)
                maxH = window.innerHeight * 0.65;
            } else {
                // Desktop: leave room for info panel (400px) + gap (40px) + padding (60px) + breathing room
                maxW = window.innerWidth - 540;
            }
        }

        const size = Math.min(maxW, maxH);
        canvas.width = size;
        canvas.height = size;
        cx = size / 2;
        cy = size / 2;
        radius = size / 2 - 20;
    }

    // --- Drawing ---

    function drawBackground() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function drawRings() {
        const ringWidth = radius / RING_COUNT;

        // Concentric rings
        for (let i = 1; i <= RING_COUNT; i++) {
            const r = ringWidth * i;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }

        // Crosshairs — 8 lines
        for (let a = 0; a < 8; a++) {
            const angle = (a * Math.PI) / 4;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }

        // Center dot
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fill();
    }

    function drawCompass() {
        const labels = [
            { text: 'N', angle: -Math.PI / 2 },
            { text: 'E', angle: 0 },
            { text: 'S', angle: Math.PI / 2 },
            { text: 'W', angle: Math.PI },
        ];

        ctx.font = '11px Courier New';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const l of labels) {
            const x = cx + Math.cos(l.angle) * (radius + 14);
            const y = cy + Math.sin(l.angle) * (radius + 14);
            ctx.fillText(l.text, x, y);
        }
    }

    function drawCoastline() {
        drawCoastPath(COAST_ENGLAND);
        drawCoastPath(COAST_FRANCE);

        // Place labels
        ctx.font = '10px Courier New';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.textAlign = 'left';

        for (const place of PLACES) {
            const p = DoverShips.geoToRadar(place.lat, place.lon);
            const px = cx + p.x * radius;
            const py = cy + p.y * radius;

            // Small dot
            ctx.beginPath();
            ctx.arc(px, py, 2, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.fill();

            // Label
            ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.fillText(place.name, px + 6, py + 3);
        }
    }

    function drawCoastPath(points) {
        if (points.length < 2) return;

        ctx.beginPath();
        const first = DoverShips.geoToRadar(points[0].lat, points[0].lon);
        ctx.moveTo(cx + first.x * radius, cy + first.y * radius);

        for (let i = 1; i < points.length; i++) {
            const p = DoverShips.geoToRadar(points[i].lat, points[i].lon);
            ctx.lineTo(cx + p.x * radius, cy + p.y * radius);
        }

        ctx.strokeStyle = 'rgba(100, 255, 150, 0.12)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    function drawSweep() {
        const endX = cx + Math.cos(sweepAngle) * radius;
        const endY = cy + Math.sin(sweepAngle) * radius;

        // Sweep trail — fading wedge
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.clip();

        const trailAngle = 0.5;
        for (let i = 20; i >= 0; i--) {
            const t = i / 20;
            const a = sweepAngle - trailAngle * t;
            const ex = cx + Math.cos(a) * radius;
            const ey = cy + Math.sin(a) * radius;

            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(ex, ey);
            ctx.strokeStyle = `rgba(100, 255, 150, ${0.03 * (1 - t)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        ctx.restore();

        // Main sweep line
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(endX, endY);
        ctx.strokeStyle = 'rgba(100, 255, 150, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    /**
     * Draw a chevron/arrow shape for a ship.
     */
    function drawChevron(x, y, heading, size, color, alpha) {
        const headingRad = ((heading - 90) * Math.PI) / 180;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(headingRad);
        ctx.globalAlpha = alpha;

        // Chevron shape pointing right (0°), rotated by heading
        const len = size;
        const width = size * 0.6;

        ctx.beginPath();
        ctx.moveTo(len, 0);                    // tip
        ctx.lineTo(-len * 0.3, -width);        // top-left
        ctx.lineTo(-len * 0.1, 0);             // inner notch
        ctx.lineTo(-len * 0.3, width);         // bottom-left
        ctx.closePath();

        ctx.fillStyle = color;
        ctx.fill();

        ctx.globalAlpha = 1;
        ctx.restore();
    }

    function drawShips() {
        const ships = DoverShips.getShips();
        let visibleCount = 0;

        for (const ship of ships) {
            const pos = DoverShips.toRadarPosition(ship);
            const dist = Math.sqrt(pos.x * pos.x + pos.y * pos.y);

            if (dist > 1.05) continue;
            visibleCount++;

            const sx = cx + pos.x * radius;
            const sy = cy + pos.y * radius;

            const color = DoverShips.getSpeedColor(ship.speed);

            // Ship size based on length
            const sizeNorm = Math.min(1, Math.max(0, (ship.length - 15) / 385));
            const chevronSize = 4 + sizeNorm * 5;

            // Glow
            ctx.shadowColor = color;
            ctx.shadowBlur = 6;
            drawChevron(sx, sy, ship.heading, chevronSize, color, 0.85);
            ctx.shadowBlur = 0;

            // Check sweep hit
            checkSweepHit(ship, pos, sx, sy, chevronSize);
        }

        return visibleCount;
    }

    function checkSweepHit(ship, pos, sx, sy, size) {
        if (!DoverAudio.isStarted()) return;

        const shipAngle = Math.atan2(pos.y, pos.x);
        const normSweep = ((sweepAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const normShip = ((shipAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

        const tolerance = (size / radius) * 2 + 0.03;

        let angleDiff = Math.abs(normSweep - normShip);
        if (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;

        if (angleDiff < tolerance && !triggeredShips.has(ship.mmsi)) {
            triggeredShips.add(ship.mmsi);

            const ringIndex = DoverShips.getRingIndex(ship, RING_COUNT);
            if (ringIndex >= 0) {
                DoverAudio.triggerNote(ship, ringIndex);
                drawHitFlash(sx, sy);
            }
        }
    }

    function drawHitFlash(x, y) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 18, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 18);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
    }

    // --- Animation loop ---

    function animate(time) {
        if (!lastTime) lastTime = time;
        const dt = (time - lastTime) / 1000;
        lastTime = time;

        sweepAngle += sweepSpeed * dt;

        // Reset triggered ships each rotation
        const currentQuadrant = Math.floor((sweepAngle / (Math.PI * 2)) * 4) % 4;
        if (currentQuadrant === 0 && lastSweepQuadrant === 3) {
            triggeredShips.clear();
        }
        lastSweepQuadrant = currentQuadrant;

        // Draw
        drawBackground();
        drawCoastline();
        drawRings();
        drawSweep();
        const visibleCount = drawShips();
        drawCompass();

        // Update UI — only count ships visible on radar
        shipCountEl.textContent = visibleCount;

        animId = requestAnimationFrame(animate);
    }

    // --- Start screen & interaction ---

    function beginExperience() {
        if (hasStarted) return;
        hasStarted = true;

        startScreen.classList.add('hidden');
        zoneIndicator.classList.add('visible');
        infoPanel.classList.add('visible');

        DoverAudio.start();
        DoverShips.startFetching(3000);
        animId = requestAnimationFrame(animate);
    }

    // Click/tap anywhere on start screen
    startScreen.addEventListener('click', beginExperience);
    startScreen.addEventListener('touchend', (e) => {
        e.preventDefault();
        beginExperience();
    });

    // --- Hover tooltip ---
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        let found = null;
        for (const ship of DoverShips.getShips()) {
            const pos = DoverShips.toRadarPosition(ship);
            const sx = cx + pos.x * radius;
            const sy = cy + pos.y * radius;
            const dist = Math.sqrt((mx - sx) ** 2 + (my - sy) ** 2);
            if (dist < 15) {
                found = ship;
                break;
            }
        }

        if (found) {
            tooltip.classList.add('visible');
            tooltip.textContent = `${found.name} — ${found.typeName} — ${found.speed} kn — ${found.length}m`;
            tooltip.style.left = (e.clientX + 14) + 'px';
            tooltip.style.top = (e.clientY - 10) + 'px';
        } else {
            tooltip.classList.remove('visible');
        }
    });

    canvas.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
    });

    // --- Audio controls (D key) ---
    document.addEventListener('keydown', (e) => {
        if (e.key === 'd' || e.key === 'D') {
            debugPanel.classList.toggle('visible');
            audioToggleBtn.classList.toggle('active', debugPanel.classList.contains('visible'));
        }
    });

    // Wire up debug panel controls
    function setupDebugControls() {
        const bind = (id, valId, formatter, setter) => {
            const input = document.getElementById(id);
            const display = document.getElementById(valId);
            if (!input || !display) return;
            input.addEventListener('input', () => {
                const v = parseFloat(input.value);
                display.textContent = formatter(v);
                setter(v);
            });
        };

        bind('ctrl-sweep', 'val-sweep',
            v => v.toFixed(2),
            v => { sweepSpeed = v; }
        );
        bind('ctrl-reverb-decay', 'val-reverb-decay',
            v => v.toFixed(1) + 's',
            v => DoverAudio.setReverbDecay(v)
        );
        bind('ctrl-reverb-wet', 'val-reverb-wet',
            v => Math.round(v * 100) + '%',
            v => DoverAudio.setReverbWet(v)
        );
        bind('ctrl-release', 'val-release',
            v => v.toFixed(1) + 's',
            v => DoverAudio.setNoteRelease(v)
        );
        bind('ctrl-filter', 'val-filter',
            v => Math.round(v) + 'Hz',
            v => DoverAudio.setFilterCutoff(v)
        );
        bind('ctrl-master', 'val-master',
            v => Math.round(v) + 'dB',
            v => DoverAudio.setMasterVolume(v)
        );
        bind('ctrl-drone', 'val-drone',
            v => Math.round(v) + 'dB',
            v => DoverAudio.setDroneVolume(v)
        );
        bind('ctrl-ocean', 'val-ocean',
            v => Math.round(v) + 'dB',
            v => DoverAudio.setOceanVolume(v)
        );
    }

    // --- Audio toggle button (mobile-friendly alternative to D key) ---
    audioToggleBtn.addEventListener('click', () => {
        debugPanel.classList.toggle('visible');
        audioToggleBtn.classList.toggle('active', debugPanel.classList.contains('visible'));
    });

    // --- Fullscreen (with CSS fallback for browsers without Fullscreen API) ---
    fullscreenBtn.addEventListener('click', () => {
        const container = document.getElementById('canvas-container');

        if (document.fullscreenElement || document.webkitFullscreenElement) {
            // Already in native fullscreen — exit
            (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else if (document.body.classList.contains('ios-fullscreen')) {
            // Already in CSS fullscreen — exit
            document.body.classList.remove('ios-fullscreen');
            resize();
        } else if (container.requestFullscreen) {
            container.requestFullscreen().catch(() => {
                // Fullscreen API rejected — fall back to CSS
                document.body.classList.toggle('ios-fullscreen');
                resize();
            });
        } else if (container.webkitRequestFullscreen) {
            container.webkitRequestFullscreen();
        } else {
            // No Fullscreen API available (iOS Safari) — use CSS fallback
            document.body.classList.toggle('ios-fullscreen');
            resize();
        }
    });

    // --- Init ---
    function init() {
        resize();
        setupDebugControls();

        // Draw initial static radar (before user clicks)
        drawBackground();
        drawRings();
        drawCompass();
    }

    window.addEventListener('resize', resize);
    document.addEventListener('fullscreenchange', resize);
    document.addEventListener('webkitfullscreenchange', resize);
    window.addEventListener('DOMContentLoaded', init);
})();
