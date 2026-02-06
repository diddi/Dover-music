/**
 * Dover Radar Synth - Audio Engine
 *
 * Tone.js-based generative audio matching art.lol/boats style:
 * - Pentatonic notes triggered by radar sweep
 * - Ambient drone layer
 * - Ocean noise layer
 * - Long reverb tails, filter cutoff control
 */
const DoverAudio = (() => {
    let started = false;

    // Pentatonic scale - 5 rings from center outward
    // Higher pitch in center, lower at edges
    const RING_NOTES = ['C5', 'G4', 'Eb4', 'Bb3', 'C3'];
    const RING_COUNT = RING_NOTES.length;
    const ringEnabled = new Array(RING_COUNT).fill(true);

    // Audio nodes
    let mainSynth, padSynth;
    let reverb, filter, compressor, masterGain;
    let droneGain, droneOsc1, droneOsc2, droneFilter;
    let oceanGain, oceanNoise, oceanFilter;

    // Current settings
    let settings = {
        reverbDecay: 9,
        reverbWet: 0.4,
        noteRelease: 9.2,
        filterCutoff: 2200,
        masterVolume: -15,
        droneVolume: -39,
        oceanVolume: -30,
    };

    function init() {
        // Master chain: filter -> compressor -> reverb -> gain -> destination
        masterGain = new Tone.Gain(Tone.dbToGain(settings.masterVolume)).toDestination();
        reverb = new Tone.Reverb({
            decay: settings.reverbDecay,
            wet: settings.reverbWet,
        }).connect(masterGain);
        compressor = new Tone.Compressor(-20, 4).connect(reverb);
        filter = new Tone.Filter({
            frequency: settings.filterCutoff,
            type: 'lowpass',
            rolloff: -12,
        }).connect(compressor);

        // Main melodic synth — soft sine with long release
        mainSynth = new Tone.PolySynth(Tone.Synth, {
            maxPolyphony: 16,
            voice: Tone.Synth,
            options: {
                oscillator: { type: 'sine' },
                envelope: {
                    attack: 0.05,
                    decay: 0.3,
                    sustain: 0.4,
                    release: settings.noteRelease,
                },
            },
        }).connect(filter);

        // Pad synth for bigger ships — triangle, softer
        padSynth = new Tone.PolySynth(Tone.Synth, {
            maxPolyphony: 8,
            voice: Tone.Synth,
            options: {
                oscillator: { type: 'triangle' },
                envelope: {
                    attack: 0.2,
                    decay: 0.5,
                    sustain: 0.3,
                    release: settings.noteRelease * 1.5,
                },
            },
        }).connect(filter);
        padSynth.volume.value = -8;

        // --- Drone layer ---
        droneGain = new Tone.Gain(Tone.dbToGain(settings.droneVolume)).connect(masterGain);
        droneFilter = new Tone.Filter({ frequency: 400, type: 'lowpass' }).connect(droneGain);
        droneOsc1 = new Tone.Oscillator({ frequency: 'C2', type: 'sine' }).connect(droneFilter);
        droneOsc2 = new Tone.Oscillator({ frequency: 'G1', type: 'sine' }).connect(droneFilter);
        droneOsc1.start();
        droneOsc2.start();

        // --- Ocean noise layer ---
        oceanGain = new Tone.Gain(Tone.dbToGain(settings.oceanVolume)).connect(masterGain);
        oceanFilter = new Tone.AutoFilter({
            frequency: 0.08,
            baseFrequency: 150,
            octaves: 2.5,
            type: 'sine',
        }).connect(oceanGain).start();
        oceanNoise = new Tone.Noise('brown').connect(oceanFilter);
        oceanNoise.start();
    }

    async function start() {
        if (started) return;
        await Tone.start();
        // iOS Safari may need an explicit resume of the underlying AudioContext
        if (Tone.context.state !== 'running') {
            await Tone.context.resume();
        }
        init();
        started = true;
    }

    function stop() {
        if (!started) return;
        mainSynth?.dispose();
        padSynth?.dispose();
        reverb?.dispose();
        filter?.dispose();
        compressor?.dispose();
        masterGain?.dispose();
        droneOsc1?.dispose();
        droneOsc2?.dispose();
        droneFilter?.dispose();
        droneGain?.dispose();
        oceanNoise?.dispose();
        oceanFilter?.dispose();
        oceanGain?.dispose();
        started = false;
    }

    /**
     * Trigger a note when sweep crosses a ship.
     */
    function triggerNote(ship, ringIndex) {
        if (!started) return;
        if (ringIndex < 0 || ringIndex >= RING_COUNT) return;
        if (!ringEnabled[ringIndex]) return;

        const note = RING_NOTES[ringIndex];

        // Ship length determines volume: bigger = louder
        const lengthNorm = Math.min(1, Math.max(0, (ship.length - 15) / 385));
        const volume = -25 + lengthNorm * 18; // -25 to -7 dB

        // Big ships also trigger pad synth
        if (lengthNorm > 0.5) {
            try {
                padSynth.triggerAttackRelease(note, '2n', Tone.now(), 0.3 + lengthNorm * 0.4);
            } catch (e) { /* polyphony limit */ }
        }

        try {
            mainSynth.triggerAttackRelease(note, '4n', Tone.now(), 0.3 + lengthNorm * 0.5);
        } catch (e) { /* polyphony limit */ }
    }

    // --- Setting updaters ---
    function setReverbDecay(val) {
        settings.reverbDecay = val;
        if (reverb) {
            reverb.decay = val;
        }
    }

    function setReverbWet(val) {
        settings.reverbWet = val;
        if (reverb) reverb.wet.value = val;
    }

    function setNoteRelease(val) {
        settings.noteRelease = val;
        if (mainSynth) {
            mainSynth.set({ envelope: { release: val } });
        }
        if (padSynth) {
            padSynth.set({ envelope: { release: val * 1.5 } });
        }
    }

    function setFilterCutoff(val) {
        settings.filterCutoff = val;
        if (filter) filter.frequency.value = val;
    }

    function setMasterVolume(val) {
        settings.masterVolume = val;
        if (masterGain) masterGain.gain.value = Tone.dbToGain(val);
    }

    function setDroneVolume(val) {
        settings.droneVolume = val;
        if (droneGain) droneGain.gain.value = Tone.dbToGain(val);
    }

    function setOceanVolume(val) {
        settings.oceanVolume = val;
        if (oceanGain) oceanGain.gain.value = Tone.dbToGain(val);
    }

    function setRingEnabled(index, enabled) {
        if (index >= 0 && index < RING_COUNT) {
            ringEnabled[index] = enabled;
        }
    }

    return {
        start,
        stop,
        triggerNote,
        setReverbDecay,
        setReverbWet,
        setNoteRelease,
        setFilterCutoff,
        setMasterVolume,
        setDroneVolume,
        setOceanVolume,
        setRingEnabled,
        isStarted: () => started,
        RING_NOTES,
        RING_COUNT,
        ringEnabled,
        settings,
    };
})();
