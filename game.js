/* A Dinner Date with the Sublime: a storm chasing game. Plain canvas, no dependencies. */
(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // The world is laid out in 960x540 logical units but drawn onto a 384x216
  // console-sized screen (scale PX), which the page scales up with crisp pixels.
  const W = 960, H = 540;
  const SW = 384, SH = 216, PX = SW / W;
  const ZOOM_Y = 250;       // the viewfinder zooms toward this height
  const MAX_ZOOM = 3;
  const TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const HORIZON = 300;      // where the field meets the sky
  const CLOUD_BASE = 118;   // underside of the storm
  const TOR_GROUND = 392;   // where tornadoes touch the field
  const ROAD_Y = 452;       // car's wheels sit here
  const DAY_LENGTH = 100;   // seconds until sunset
  const FILM = 24;
  const MI_PER_PX = 0.0015; // world px -> miles, for flavour text

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------- sizing
  canvas.width = SW;
  canvas.height = SH;
  if (document.fonts) document.fonts.load('8px "Press Start 2P"');

  // ---------------------------------------------------------------- storage
  function loadBest() {
    try { return parseInt(localStorage.getItem('dinnerDateBest'), 10) || 0; } catch (e) { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem('dinnerDateBest', String(v)); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- audio
  // A tiny 16-bit-console-style synth: soft voices through a filtered echo,
  // the way the old sound chips did it. The music is generative: looping
  // notes of different lengths drift in and out of phase, so it never repeats.
  let audio = null, master = null, musicBus = null, metalBus = null, sfxBus = null, echoIn = null, echoDelay = null;
  let waves = {}, noiseBuf = null, guitarIn = null;
  let muted = false, musicTimer = null;

  function initAudio() {
    if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; return; }
    master = audio.createGain();
    master.gain.value = muted ? 0 : 0.8;
    const soften = audio.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 7000;
    master.connect(soften).connect(audio.destination);

    // Echo with darkening feedback
    echoIn = audio.createGain();
    echoIn.gain.value = 0.55;
    const delay = audio.createDelay(1);
    delay.delayTime.value = SONGS[songIndex].echo;
    echoDelay = delay;
    const feedback = audio.createGain();
    feedback.gain.value = 0.5;
    const damp = audio.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2200;
    echoIn.connect(delay);
    delay.connect(damp);
    damp.connect(feedback).connect(delay);
    damp.connect(master);

    musicBus = audio.createGain();
    musicBus.gain.value = 0.6;
    musicBus.connect(master);
    musicBus.connect(echoIn);
    sfxBus = audio.createGain();
    sfxBus.gain.value = 0.7;
    sfxBus.connect(master);
    const sfxEcho = audio.createGain();
    sfxEcho.gain.value = 0.3;
    sfxBus.connect(sfxEcho).connect(echoIn);

    const wave = (h) => audio.createPeriodicWave(new Float32Array(h.length), new Float32Array(h));
    waves = {
      bell: wave([0, 1, 0.45, 0.2, 0.1, 0.05]),
      glass: wave([0, 1, 0, 0.32, 0, 0.14, 0, 0.06]),
      soft: wave([0, 1, 0.12, 0.04]),
    };

    // A shared block of stepped noise, like a console noise channel.
    noiseBuf = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < nd.length; i++) { if (i % 3 === 0) v = Math.random() * 2 - 1; nd[i] = v; }

    // Metal: its own bus, with a distortion stage for the guitar.
    metalBus = audio.createGain();
    metalBus.gain.value = 0;
    metalBus.connect(master);
    const metalEcho = audio.createGain();
    metalEcho.gain.value = 0.15;
    metalBus.connect(metalEcho).connect(echoIn);
    guitarIn = audio.createGain();
    const drive = audio.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * 8); }
    drive.curve = curve;
    const cab = audio.createBiquadFilter();
    cab.type = 'lowpass';
    cab.frequency.value = 2600;
    guitarIn.connect(drive).connect(cab).connect(metalBus);

    startMusic();
  }

  function setMuted(m) {
    muted = m;
    if (master) master.gain.setTargetAtTime(m ? 0 : 0.8, audio.currentTime, 0.05);
  }

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  function tone(freq, t, { wave = 'square', attack = 0.004, decay = 0.2, gain = 0.1, glide = 0, bus = sfxBus } = {}) {
    if (!audio) return;
    const o = audio.createOscillator();
    if (waves[wave]) o.setPeriodicWave(waves[wave]); else o.type = wave;
    o.frequency.setValueAtTime(freq, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(freq * glide, t + Math.min(decay, 0.12));
    const g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  function noise(duration, { freq = 1000, q = 1, gain = 0.3, type = 'bandpass', decay = duration, at = 0, bus = sfxBus } = {}) {
    if (!audio) return;
    const t = at || audio.currentTime;
    const src = audio.createBufferSource();
    src.buffer = noiseBuf;
    const filter = audio.createBiquadFilter();
    filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const g = audio.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(filter).connect(g).connect(bus);
    src.start(t, Math.random() * (2 - Math.min(1.9, duration)), duration);
  }

  function pad(freq, t, len) {
    const f = audio.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.03, t + 4);
    g.gain.setValueAtTime(0.03, t + len - 5);
    g.gain.linearRampToValueAtTime(0.0001, t + len);
    for (const detune of [-7, 7]) {
      const o = audio.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(f);
      o.start(t);
      o.stop(t + len + 0.1);
    }
    f.connect(g).connect(musicBus);
  }

  // Three ambient pieces, one per round. Each loop repeats one note on its
  // own period (seconds), so the voices drift in and out of phase.
  const SONGS = [
    { // Bright pentatonic bells over D
      wave: 'bell', echo: 0.36, gap: [0.3, 1.5],
      loops: [[66, 7.1, 0.4], [69, 8.9, 2.3], [74, 11.3, 4.1], [71, 13.7, 6.0], [76, 17.9, 9.2], [62, 19.3, 1.7], [81, 23.3, 12.5]],
      bubbles: [74, 76, 78, 81, 83, 86, 88, 90],
      pads: [[50, 57, 64, 66], [47, 54, 62, 66], [43, 50, 57, 62], [45, 52, 59, 64]],
    },
    { // Low fields: slow, dorian, soft voices
      wave: 'soft', echo: 0.52, gap: [0.9, 2.8],
      loops: [[57, 9.7, 0.8], [60, 12.1, 3.5], [64, 14.9, 6.2], [66, 17.3, 1.9], [69, 21.1, 9.8], [71, 25.7, 4.4], [74, 29.3, 13.1]],
      bubbles: [69, 72, 74, 76, 79, 81],
      pads: [[45, 52, 59, 60], [41, 48, 55, 57], [43, 50, 57, 62], [38, 45, 52, 57]],
    },
    { // Glass weather: quick, lydian, glassy
      wave: 'glass', echo: 0.27, gap: [0.2, 1.0],
      loops: [[65, 5.3, 0.3], [69, 6.7, 1.6], [71, 8.3, 2.9], [72, 9.9, 0.9], [76, 12.7, 4.2], [77, 15.1, 6.8], [84, 18.7, 9.5]],
      bubbles: [84, 86, 88, 91, 93, 96],
      pads: [[53, 60, 64, 69], [50, 57, 64, 67], [48, 55, 64, 67], [45, 52, 60, 64]],
    },
  ];
  let songIndex = 0, musicMode = 'ambient';
  let loopNext = [], padNext = 0, padIndex = 0, bubbleNext = 0;
  let metalNext = 0, metalStep = 0;

  function startMusic() {
    resetAmbient();
    musicTimer = setInterval(scheduleMusic, 100);
  }

  function resetAmbient() {
    if (!audio) return;
    const now = audio.currentTime + 0.1;
    const song = SONGS[songIndex];
    loopNext = song.loops.map((l) => now + l[2]);
    padNext = now;
    bubbleNext = now + 1.5;
  }

  function setSong(i) {
    songIndex = i % SONGS.length;
    if (!audio) return;
    echoDelay.delayTime.setTargetAtTime(SONGS[songIndex].echo, audio.currentTime, 0.5);
    resetAmbient();
  }

  function setMusicMode(mode) {
    if (mode === musicMode) return;
    musicMode = mode;
    if (!audio) return;
    const t = audio.currentTime;
    musicBus.gain.setTargetAtTime(mode === 'ambient' ? 0.6 : 0, t, mode === 'ambient' ? 1 : 0.3);
    metalBus.gain.setTargetAtTime(mode === 'metal' ? 0.55 : 0, t, mode === 'metal' ? 0.05 : 0.4);
    if (mode === 'metal') { metalNext = t + 0.15; metalStep = 0; }
    else resetAmbient();
  }

  function stormCloseness() {
    const T = game && game.tor;
    if (!T || state !== 'play') return 0;
    return clamp(1 - tornadoMiles(T) / 1.35, 0, 1) * T.alpha;
  }

  function scheduleMusic() {
    if (!audio || audio.state !== 'running') return;
    const horizon = audio.currentTime + 0.4;
    if (musicMode === 'metal') { scheduleMetal(horizon); return; }
    const song = SONGS[songIndex];
    song.loops.forEach(([n, period], i) => {
      while (loopNext[i] < audio.currentTime) loopNext[i] += period;
      while (loopNext[i] < horizon) {
        tone(midi(n), loopNext[i], { wave: song.wave, attack: 0.01, decay: 2.8, gain: 0.08, bus: musicBus });
        loopNext[i] += period;
      }
    });
    if (padNext < audio.currentTime - 1) padNext = audio.currentTime;
    while (padNext < horizon) {
      for (const n of song.pads[padIndex % song.pads.length]) pad(midi(n), padNext, 17);
      padIndex++;
      padNext += 16;
    }
    if (bubbleNext < audio.currentTime) bubbleNext = audio.currentTime + 0.1;
    while (bubbleNext < horizon) {
      const near = stormCloseness();
      const n = song.bubbles[(Math.random() * song.bubbles.length) | 0];
      tone(midi(n), bubbleNext, { wave: 'sine', decay: 0.16, gain: 0.05 + near * 0.04, glide: 1.5, bus: musicBus });
      if (Math.random() < 0.3) tone(midi(n + 5), bubbleNext + 0.09, { wave: 'sine', decay: 0.12, gain: 0.04, glide: 1.5, bus: musicBus });
      bubbleNext += rand(song.gap[0], song.gap[1]) * (1 - near * 0.6);
    }
  }

  // ---- Triumphant chiptune metal for the fully kitted car.
  const BPM = 168, STEP = 60 / BPM / 4;     // sixteenth notes
  const ROOTS = [40, 36, 38, 38];           // E  C  D  D
  const LEAD = [                            // eighth notes; 0 holds the previous note
    [76, 0, 79, 81, 83, 0, 81, 79],
    [79, 0, 76, 79, 84, 0, 83, 81],
    [81, 0, 78, 81, 86, 0, 85, 83],
    [83, 0, 81, 83, 88, 0, 0, 0],
  ];

  function powerChord(root, t, len, gain) {
    const g = audio.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    g.connect(guitarIn);
    for (const [iv, det] of [[0, -8], [7, 8], [12, 0]]) {
      const o = audio.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(root + iv);
      o.detune.value = det;
      o.connect(g);
      o.start(t);
      o.stop(t + len + 0.05);
    }
  }

  function leadNote(n, t, len) {
    const g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.055, t + 0.01);
    g.gain.setValueAtTime(0.055, t + len * 0.75);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    g.connect(metalBus);
    const lfo = audio.createOscillator();
    const depth = audio.createGain();
    lfo.frequency.value = 6;
    depth.gain.value = 9;
    lfo.connect(depth);
    for (const det of [-5, 5]) {
      const o = audio.createOscillator();
      o.type = 'square';
      o.frequency.value = midi(n);
      o.detune.value = det;
      depth.connect(o.detune);
      o.connect(g);
      o.start(t);
      o.stop(t + len + 0.05);
    }
    lfo.start(t);
    lfo.stop(t + len + 0.05);
  }

  function scheduleMetal(horizon) {
    if (metalNext < audio.currentTime) metalNext = audio.currentTime + 0.05;
    while (metalNext < horizon) {
      const t = metalNext, step = metalStep % 64, bar = step >> 4, s = step % 16;
      const root = ROOTS[bar];
      // Drums: double kick on eighths, snare on 2 and 4, constant hats
      if (s % 2 === 0) tone(150, t, { wave: 'sine', decay: 0.14, gain: 0.5, glide: 0.3, bus: metalBus });
      if (s === 4 || s === 12) noise(0.18, { freq: 1800, q: 0.8, gain: 0.45, at: t, bus: metalBus });
      noise(0.03, { freq: 9000, q: 1, type: 'highpass', gain: s % 4 === 2 ? 0.12 : 0.06, at: t, bus: metalBus });
      if (step % 32 === 0) noise(1.2, { freq: 5000, q: 0.5, type: 'highpass', gain: 0.2, decay: 1.2, at: t, bus: metalBus });
      // Galloping guitar and bass: on each beat, 1 . 3 4
      const pos = s % 4;
      if (pos !== 1) {
        const accent = s === 0;
        powerChord(root, t, accent ? 0.45 : 0.08, accent ? 0.16 : 0.11);
        tone(midi(root - 12), t, { wave: 'triangle', decay: 0.1, gain: 0.22, bus: metalBus });
      }
      // Lead
      if (s % 2 === 0) {
        const e = s >> 1, n = LEAD[bar][e];
        if (n) {
          let len = 1;
          while (e + len < 8 && LEAD[bar][e + len] === 0) len++;
          leadNote(n, t, len * 2 * STEP);
        }
      }
      metalNext += STEP;
      metalStep++;
    }
  }

  const now = () => (audio ? audio.currentTime : 0);
  const sfx = {
    shutter() {
      noise(0.04, { freq: 4000, q: 2, gain: 0.3 });
      tone(midi(84), now(), { decay: 0.05, gain: 0.06 });
      tone(midi(91), now() + 0.06, { decay: 0.08, gain: 0.06 });
    },
    score(points) {
      if (points <= 0) return;
      const steps = points >= 150 ? 4 : points >= 90 ? 3 : points >= 40 ? 2 : 1;
      [74, 78, 81, 86].slice(0, steps).forEach((n, i) => tone(midi(n), now() + 0.15 + i * 0.07, { decay: 0.12, gain: 0.06 }));
    },
    touchdown() { [62, 69, 74].forEach((n, i) => tone(midi(n), now() + i * 0.12, { wave: 'triangle', decay: 0.4, gain: 0.12 })); },
    thunder() { noise(2.4, { freq: 110, q: 0.7, gain: 0.6, type: 'lowpass', decay: 2.4 }); },
    hit() { tone(220, now(), { decay: 0.15, gain: 0.08, glide: 0.5 }); noise(0.1, { freq: 800, gain: 0.15 }); },
    hail() { noise(0.03, { freq: 6000, q: 3, gain: 0.06 }); },
    open() { tone(midi(81), now(), { wave: 'triangle', decay: 0.1, gain: 0.1 }); tone(midi(88), now() + 0.07, { wave: 'triangle', decay: 0.2, gain: 0.1 }); },
    blip() { tone(midi(93), now(), { decay: 0.025, gain: 0.025 }); },
    close() { tone(midi(86), now(), { wave: 'triangle', decay: 0.08, gain: 0.08 }); tone(midi(79), now() + 0.06, { wave: 'triangle', decay: 0.12, gain: 0.08 }); },
    sundown() { [62, 66, 69, 74, 78].forEach((n, i) => tone(midi(n), now() + i * 0.18, { wave: 'bell', decay: 2.2, gain: 0.08 })); },
    cheers() {
      tone(midi(96), now(), { wave: 'triangle', decay: 0.4, gain: 0.1 });
      tone(midi(100), now() + 0.05, { wave: 'triangle', decay: 0.5, gain: 0.08 });
      [62, 66, 69, 73, 76].forEach((n, i) => tone(midi(n), now() + 0.3 + i * 0.12, { wave: 'bell', decay: 2.5, gain: 0.09 }));
    },
    omen() {
      noise(4, { freq: 70, q: 0.6, gain: 0.7, type: 'lowpass', decay: 4 });
      tone(midi(38), now(), { wave: 'triangle', attack: 1, decay: 4, gain: 0.15 });
    },
    swept() { [0, 0.25, 0.5].forEach((d, i) => tone(180 + i * 60, now() + d, { decay: 0.6, gain: 0.07, glide: 4 })); },
    powerup() { [72, 76, 79, 84].forEach((n, i) => tone(midi(n), now() + i * 0.06, { decay: 0.1, gain: 0.07 })); },
    feral() {
      noise(0.6, { freq: 160, q: 1, gain: 0.4, type: 'lowpass', decay: 0.6 });
      [60, 63, 67, 70, 72, 75, 79].forEach((n, i) => tone(midi(n), now() + 0.1 + i * 0.07, { decay: 0.14, gain: 0.07 }));
    },
    over() { [74, 69, 66, 62].forEach((n, i) => tone(midi(n), now() + i * 0.28, { wave: 'bell', decay: 1.6, gain: 0.12 })); },
  };

  // ---------------------------------------------------------------- input
  const keys = { left: false, right: false, zoom: false, gas: false, brake: false };
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    KeyZ: 'zoom', ShiftLeft: 'zoom', ShiftRight: 'zoom',
    ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake',
  };

  window.addEventListener('keydown', (e) => {
    if (state === 'title' && (KEYMAP[e.code] === 'left' || KEYMAP[e.code] === 'right')) {
      e.preventDefault();
      if (!e.repeat) chooseMode(KEYMAP[e.code] === 'left' ? 'side' : 'drive');
      return;
    }
    if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); return; }
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (!e.repeat) action();
    } else if (e.code === 'KeyP' || e.code === 'Escape') {
      togglePause();
    } else if (e.code === 'KeyM') {
      setMuted(!muted);
      flashMsg(muted ? 'Sound off' : 'Sound on');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false;
  });

  // Tapping the canvas starts the game or takes a photo.
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.focus();
    if (state === 'title') {
      // Tapping a half of the title screen picks that view.
      const r = canvas.getBoundingClientRect();
      const rx = (e.clientX - r.left) / r.width, ry = (e.clientY - r.top) / r.height;
      if (TOUCH || (ry > 0.56 && ry < 0.76)) chooseMode(rx < 0.5 ? 'side' : 'drive', true);
    }
    action();
  });

  document.querySelectorAll('.controls button').forEach((btn) => {
    const k = btn.dataset.key;
    const down = (e) => {
      e.preventDefault();
      btn.classList.add('active');
      if (k === 'shutter') action();
      else if (k === 'pause') { initAudio(); togglePause(); }
      else keys[k] = true;
    };
    const up = (e) => {
      e.preventDefault();
      btn.classList.remove('active');
      if (k !== 'shutter' && k !== 'pause') keys[k] = false;
    };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'play') togglePause();
    if (audio) { if (document.hidden) audio.suspend(); else if (state !== 'paused') audio.resume(); }
  });
  window.addEventListener('blur', () => { keys.left = keys.right = keys.zoom = false; });

  // Phones: pause when turned upright, and make sure audio unlocks on iOS.
  if (TOUCH && window.matchMedia) {
    window.matchMedia('(orientation: portrait)').addEventListener('change', (e) => {
      keys.left = keys.right = keys.zoom = false;
      document.querySelectorAll('.controls button.active').forEach((b) => b.classList.remove('active'));
      if (e.matches && state === 'play') togglePause();
    });
  }
  document.addEventListener('touchend', () => { if (audio && audio.state !== 'running') audio.resume(); }, { passive: true });

  function goFullscreen() {
    if (!TOUCH || document.fullscreenElement) return;
    const el = document.documentElement;
    if (!el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
      .catch(() => {});
  }

  function action() {
    initAudio();
    if (state === 'title') { goFullscreen(); startGame(); }
    else if (state === 'play') takePhoto();
    else if (state === 'paused') togglePause();
    else if (state === 'dialog') advanceDialog();
    else if (state === 'over' && performance.now() - game.overAt > 1000) toTitle();
    else if (state === 'sunset' && game.st > 2 && game.swept < 0) endGame('Sunset. You called it a day.');
  }

  function togglePause() {
    if (state === 'play') state = 'paused';
    else if (state === 'paused') { state = 'play'; last = performance.now(); }
  }

  // ---------------------------------------------------------------- game state
  let state = 'title';
  let game;
  let best = loadBest();
  let round = 0;             // which ambient song plays rotates with each round
  let selMode = 'side';      // 'side' or 'drive' (windshield)
  try { if (localStorage.getItem('dinnerDateMode') === 'drive') selMode = 'drive'; } catch (e) { /* ignore */ }

  function newGame(mode = 'side') {
    return {
      mode, lane: 0, dist: 0, speed: 0, steerVis: 0, bgCam: 0,
      fpHail: [], fpDebris: [], splats: [], rain: 0, torScreen: null, picnic: null,
      t: 0, score: 0, film: FILM, frames: 0,
      car: { x: 0, vx: 0, hp: 100, dir: 1, hurt: 0, wheel: 0 },
      camX: -W / 2,
      tor: null, nextTor: 1.5,
      hail: [], debris: [], dust: [],
      flash: 0, lightning: 0, lightningCd: rand(3, 7), bolt: null,
      shutterCd: 0, msg: '', msgT: 0, shake: 0,
      overAt: 0, ending: 0, endReason: '', hailSound: 0,
      up: { nets: false, roof: false, tires: false, radar: false }, pickup: null, pickupCd: 6,
      zoom: 1, aimX: W / 2, dialog: null, dialogDelay: 0, dialogQuote: null, usedQuotes: new Set(),
    };
  }

  function startGame() {
    game = newGame(selMode);
    if (selMode === 'drive') game.speed = 3200;
    state = 'play';
    round++;
    setSong(round - 1);
    setMusicMode('ambient');
    flashMsg('Storms are firing. Go find a tornado.');
  }

  // The title screen shows a little demo of whichever view is selected.
  function titleDemo(mode) {
    game = newGame(mode);
    if (mode === 'drive') {
      game.speed = 3200;
      spawnDriveTornado();
      Object.assign(game.tor, { x: 2600, z: 9000, phase: 'mature', alpha: 1, life: 1e9, tvx: 0, vx: 0 });
    } else {
      spawnTornado(0);
      Object.assign(game.tor, { x: 260, phase: 'mature', alpha: 1, life: 1e9, core: 1 });
    }
  }

  function chooseMode(mode, quiet) {
    if (mode === selMode) return;
    selMode = mode;
    try { localStorage.setItem('dinnerDateMode', mode); } catch (e) { /* ignore */ }
    if (!quiet) { titleDemo(mode); sfx.blip(); }
  }

  function toTitle() {
    state = 'title';
    titleDemo(selMode);
  }

  function endGame(reason) {
    if (state !== 'play' && state !== 'sunset') return;
    game.endReason = reason;
    state = 'over';
    if (game.score > best) { best = game.score; saveBest(best); }
    sfx.over();
    setMusicMode('ambient');
    game.overAt = performance.now();
  }

  function flashMsg(text, time = 2.4) {
    if (!game) return;
    game.msg = text;
    game.msgT = time;
  }

  // ---------------------------------------------------------------- tornado
  const EF_WEIGHTS = [0.24, 0.26, 0.2, 0.15, 0.1, 0.05];
  function pickEF() {
    let r = Math.random();
    for (let i = 0; i < EF_WEIGHTS.length; i++) { r -= EF_WEIGHTS[i]; if (r <= 0) return i; }
    return 0;
  }

  function spawnTornado(nearX) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const ef = pickEF();
    game.tor = {
      x: nearX + side * rand(650, 1100),
      vx: 0, tvx: rand(-70, 70), retarget: rand(2, 4),
      ef, size: 0.75 + ef * 0.11,
      phase: 'forming', pt: 0, life: rand(10, 18),
      alpha: 0, rope: 0, lean: 0,
      seed: Math.random() * 100,
      core: Math.random() < 0.5 ? -1 : 1, // which side the hail core sits on
    };
  }

  function funnelAt(T, t, time) {
    // t: 0 at the cloud base, 1 at the ground.
    const y = lerp(CLOUD_BASE, TOR_GROUND, t);
    const rope = T.rope;
    const topW = 150 * T.size * (1 - 0.55 * rope);
    const botW = (24 + T.ef * 20) * T.size * (1 - 0.85 * rope);
    let w = lerp(topW, botW, Math.pow(t, 0.45));
    if (T.phase === 'forming') w *= 0.45 + 0.55 * T.alpha;
    const sway = Math.sin(time * 1.1 + t * 4 + T.seed) * (10 + rope * 50) * t
      + Math.sin(time * 2.7 + t * 11 + T.seed) * 4 * t;
    const xo = T.lean * t + sway + rope * Math.sin(t * 5 + T.seed) * 90 * t;
    return { y, w, xo };
  }

  function tornadoGroundX(T) { return T.x + funnelAt(T, 1, game.t).xo; }
  // Where a world x lands on screen (logical units), through the zoom lens.
  function screenXOf(wx) { return W / 2 + (wx - game.camX - zoomFocus()) * game.zoom; }
  // The lens pans toward its aim point as it zooms in; at 1x it is centred.
  function zoomFocus() { return lerp(W / 2, game.aimX, clamp((game.zoom - 1) / (MAX_ZOOM - 1), 0, 1)); }
  function tornadoReach(T) {
    // How far down the funnel extends (it lowers while forming).
    return T.phase === 'forming' ? clamp(T.pt / 3.2, 0.15, 1) : 1;
  }
  function tornadoOnGround(T) { return tornadoReach(T) >= 1 && T.alpha > 0.5; }

  function coreRange(T) {
    const gx = tornadoGroundX(T);
    const a = gx + T.core * 170, b = gx + T.core * (620 + T.ef * 60);
    return [Math.min(a, b), Math.max(a, b)];
  }

  function updateTornado(dt) {
    const T = game.tor;
    if (!T) {
      if (state === 'sunset') return;
      game.nextTor -= dt;
      if (game.nextTor <= 0) { if (game.mode === 'drive') spawnDriveTornado(); else spawnTornado(game.car.x); }
      return;
    }
    T.pt += dt;
    if (game.mode === 'drive') driveTornadoMotion(T, dt);
    else sideTornadoMotion(T, dt);
    phaseTornado(T);
  }

  function sideTornadoMotion(T, dt) {
    T.retarget -= dt;
    if (T.finale) {
      T.retarget = 1;
      T.tvx = Math.sign(game.px - T.x) * 85;
    } else if (T.retarget <= 0) {
      T.retarget = rand(2, 5);
      T.tvx = rand(-1, 1) * (55 + T.ef * 14);
      // Sometimes the storm turns toward you.
      if (state === 'play' && Math.random() < 0.3) T.tvx = Math.sign(game.car.x - T.x) * (60 + T.ef * 10);
    }
    T.vx += (T.tvx - T.vx) * Math.min(1, dt * 0.7);
    T.x += T.vx * dt;
    T.lean += ((T.vx / 100) * 45 - T.lean) * Math.min(1, dt);
  }

  function phaseTornado(T) {
    if (T.phase === 'forming') {
      T.alpha = Math.min(1, T.pt / 3.5);
      if (T.pt >= 4) { T.phase = 'mature'; T.pt = 0; flashMsg(`Touchdown! Rated EF${T.ef}.`); sfx.touchdown(); }
    } else if (T.phase === 'mature') {
      if (T.pt >= T.life) { T.phase = 'roping'; T.pt = 0; if (state === 'play') flashMsg('It\'s roping out. Last chance!'); }
    } else if (T.phase === 'roping') {
      T.rope = Math.min(1, T.pt / 4);
      T.alpha = 1 - clamp((T.pt - 4) / 1.5, 0, 1);
      if (T.pt >= 5.5) {
        game.tor = null;
        game.nextTor = rand(2.5, 5);
        if (state === 'play') flashMsg('Gone. Another storm is going up.');
      }
    }
  }

  // ---------------------------------------------------------------- quotes
  // Shown after each photograph. Tags pick quotes that suit the shot.
  const QUOTES = [
    { who: 'ROLAND BARTHES', src: 'Camera Lucida, 1980', tags: ['close', 'any'],
      text: 'A photograph\'s punctum is that accident which pricks me (but also bruises me, is poignant to me).' },
    { who: 'ROLAND BARTHES', src: 'Camera Lucida, 1980', tags: ['any', 'score'],
      text: 'What the Photograph reproduces to infinity has occurred only once.' },
    { who: 'ROLAND BARTHES', src: 'Camera Lucida, 1980', tags: ['rope'],
      text: 'The Photograph does not necessarily say what is no longer, but only and for certain what has been.' },
    { who: 'ROLAND BARTHES', src: 'Camera Lucida, 1980', tags: ['rope', 'hurt'],
      text: 'Whether or not the subject is already dead, every photograph is this catastrophe.' },
    { who: 'ROLAND BARTHES', src: 'Camera Lucida, 1980', tags: ['far', 'any'],
      text: 'Ultimately, Photography is subversive not when it frightens, repels, or even stigmatizes, but when it is pensive, when it thinks.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['score', 'any'],
      text: 'To photograph is to appropriate the thing photographed.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['rope'],
      text: 'All photographs are memento mori. To take a photograph is to participate in another person\'s (or thing\'s) mortality, vulnerability, mutability.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['hurt', 'close'],
      text: 'Like guns and cars, cameras are fantasy-machines whose use is addictive.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['score'],
      text: 'Needing to have reality confirmed and experience enhanced by photographs is an aesthetic consumerism to which everyone is now addicted.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['any', 'zoom'],
      text: 'A photograph is not only an image (as a painting is an image), an interpretation of the real; it is also a trace, something directly stenciled off the real, like a footprint or a death mask.' },
    { who: 'SUSAN SONTAG', src: 'Regarding the Pain of Others, 2003', tags: ['miss'],
      text: 'To photograph is to frame, and to frame is to exclude.' },
    { who: 'TEJU COLE', src: 'Memories of Things Unseen, 2015', tags: ['any', 'rope'],
      text: 'Photography is inescapably a memorial art. It selects, out of the flow of time, a moment to be preserved, with the moments before and after falling away like sheer cliffs.' },
    { who: 'WALTER BENJAMIN', src: 'The Work of Art in the Age of Mechanical Reproduction, 1936', tags: ['score', 'any'],
      text: 'That which withers in the age of mechanical reproduction is the aura of the work of art.' },
    { who: 'WALTER BENJAMIN', src: 'The Work of Art in the Age of Mechanical Reproduction, 1936', tags: ['any', 'far'],
      text: 'Even the most perfect reproduction of a work of art is lacking in one element: its presence in time and space, its unique existence at the place where it happens to be.' },
    { who: 'WALTER BENJAMIN', src: 'The Work of Art in the Age of Mechanical Reproduction, 1936', tags: ['zoom'],
      text: 'The camera introduces us to unconscious optics as does psychoanalysis to unconscious impulses.' },
    { who: 'WALTER BENJAMIN', src: 'Little History of Photography, 1931', tags: ['zoom'],
      text: 'It is another nature which speaks to the camera than to the eye.' },
    { who: 'WALTER BENJAMIN', src: 'Theses on the Philosophy of History, 1940', tags: ['lightning'],
      text: 'The true picture of the past flits by. The past can be seized only as an image which flashes up at the instant when it can be recognized and is never seen again.' },
    { who: 'WALTER BENJAMIN', src: 'Theses on the Philosophy of History, 1940', tags: ['close', 'hurt', 'any'],
      text: 'This storm irresistibly propels him into the future to which his back is turned, while the pile of debris before him grows skyward. This storm is what we call progress.' },
    { who: 'EDMUND BURKE', src: 'A Philosophical Enquiry, 1757', tags: ['close'],
      text: 'Whatever is fitted in any sort to excite the ideas of pain, and danger, that is to say, whatever is in any sort terrible ... is a source of the sublime.' },
    { who: 'EDMUND BURKE', src: 'A Philosophical Enquiry, 1757', tags: ['close', 'hurt', 'far'],
      text: 'When danger or pain press too nearly, they are incapable of giving any delight, and are simply terrible; but at certain distances, and with certain modifications, they may be, and they are delightful.' },
    { who: 'IMMANUEL KANT', src: 'Critique of Judgment, 1790', tags: ['far', 'any'],
      text: 'We call that sublime which is absolutely great.' },
    { who: 'IMMANUEL KANT', src: 'Critique of Judgment, 1790', tags: ['far', 'zoom', 'lightning'],
      text: 'Clouds piled up in the sky, moving with lightning flashes and thunder peals ... hurricanes with their track of devastation ... the sight of them is the more attractive, the more fearful it is, provided only that we are in security.' },
    { who: 'J.-F. LYOTARD', src: 'Answering the Question: What Is Postmodernism?, 1982', tags: ['any', 'empty'],
      text: 'The postmodern would be that which, in the modern, puts forward the unpresentable in presentation itself.' },
    { who: 'J.-F. LYOTARD', src: 'The Postmodern Condition, 1979', tags: ['empty', 'any'],
      text: 'Simplifying to the extreme, I define postmodern as incredulity toward metanarratives.' },
    { who: 'ECCLESIASTES', src: 'actually Baudrillard, Simulacra and Simulation, 1981', tags: ['empty', 'score'],
      text: 'The simulacrum is never what hides the truth - it is truth that hides the fact that there is none. The simulacrum is true.' },
    { who: 'JEAN BAUDRILLARD', src: 'Simulacra and Simulation, 1981', tags: ['miss', 'empty'],
      text: 'The territory no longer precedes the map, nor does it survive it.' },
    { who: 'JEAN BAUDRILLARD', src: 'Simulacra and Simulation, 1981', tags: ['empty'],
      text: 'It is the real, and not the map, whose vestiges persist here and there in the deserts that are no longer those of the Empire, but ours. The desert of the real itself.' },
    { who: 'KARL MARX', src: 'Capital, Vol. 1, 1867', tags: ['score'],
      text: 'A commodity appears, at first sight, a very trivial thing, and easily understood. Its analysis shows that it is, in reality, a very queer thing, abounding in metaphysical subtleties and theological niceties.' },
    { who: 'MARX & ENGELS', src: 'The Communist Manifesto, 1848', tags: ['close', 'rope'],
      text: 'All that is solid melts into air, all that is holy is profaned.' },
    { who: 'GEORG LUKACS', src: 'History and Class Consciousness, 1923', tags: ['score'],
      text: 'A relation between people takes on the character of a thing and thus acquires a "phantom objectivity".' },
    { who: 'GUY DEBORD', src: 'The Society of the Spectacle, 1967', tags: ['score', 'any'],
      text: 'The spectacle is not a collection of images, but a social relation among people, mediated by images.' },
    { who: 'GUY DEBORD', src: 'The Society of the Spectacle, 1967', tags: ['any', 'miss'],
      text: 'All that once was directly lived has become mere representation.' },
    { who: 'FREDRIC JAMESON', src: 'The Seeds of Time, 1994', tags: ['hurt', 'any'],
      text: 'It seems to be easier for us today to imagine the thoroughgoing deterioration of the earth and of nature than the breakdown of late capitalism.' },
    { who: 'ROLAND BARTHES', src: 'Camera Lucida, 1980', tags: ['rope', 'hurt'],
      text: 'Death is the eidos of that Photograph.' },
    { who: 'ROLAND BARTHES', src: 'Camera Lucida, 1980', tags: ['close', 'any'],
      text: 'The photograph is literally an emanation of the referent.' },
    { who: 'ROLAND BARTHES', src: 'Camera Lucida, 1980', tags: ['close', 'score'],
      text: 'Society is concerned to tame the Photograph, to temper the madness which keeps threatening to explode in the face of whoever looks at it.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['rope', 'any'],
      text: 'Photography is an elegiac art, a twilight art. Most subjects photographed are, just by virtue of being photographed, touched with pathos.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['far', 'miss'],
      text: 'The camera makes everyone a tourist in other people\'s reality, and eventually in one\'s own.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['score'],
      text: 'To collect photographs is to collect the world.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['close', 'zoom'],
      text: 'There is an aggression implicit in every use of the camera.' },
    { who: 'SUSAN SONTAG', src: 'Regarding the Pain of Others, 2003', tags: ['far', 'any'],
      text: 'Being a spectator of calamities taking place in another country is a quintessential modern experience.' },
    { who: 'WALTER BENJAMIN', src: 'The Work of Art in the Age of Mechanical Reproduction, 1936', tags: ['zoom', 'far'],
      text: 'We define the aura of the latter as the unique phenomenon of a distance, however close it may be.' },
    { who: 'EDMUND BURKE', src: 'A Philosophical Enquiry, 1757', tags: ['close', 'lightning'],
      text: 'The passion caused by the great and sublime in nature, when those causes operate most powerfully, is Astonishment; and astonishment is that state of the soul, in which all its motions are suspended, with some degree of horror.' },
    { who: 'EDMUND BURKE', src: 'A Philosophical Enquiry, 1757', tags: ['hurt', 'close'],
      text: 'No passion so effectually robs the mind of all its powers of acting and reasoning as fear.' },
    { who: 'IMMANUEL KANT', src: 'Critique of Judgment, 1790', tags: ['far', 'any'],
      text: 'The sublime is to be found in a formless object, so far as in it or by occasion of it boundlessness is represented, and yet its totality is also present to thought.' },
    { who: 'JEAN BAUDRILLARD', src: 'Simulacra and Simulation, 1981', tags: ['empty', 'any'],
      text: 'We live in a world where there is more and more information, and less and less meaning.' },
    { who: 'GUY DEBORD', src: 'The Society of the Spectacle, 1967', tags: ['empty', 'miss'],
      text: 'In a world that really has been turned on its head, truth is a moment of falsehood.' },
    { who: 'ADORNO & HORKHEIMER', src: 'Dialectic of Enlightenment, 1944', tags: ['hurt', 'score'],
      text: 'The fully enlightened earth radiates disaster triumphant.' },
    { who: 'W. J. T. MITCHELL', src: 'Iconology, 1986', tags: ['any', 'score'],
      text: 'The image is the sign that pretends not to be a sign, masquerading as (or, for the believer, actually achieving) natural immediacy and presence.' },
    { who: 'W. J. T. MITCHELL', src: 'Picture Theory, 1994', tags: ['any', 'far'],
      text: 'The problem of the twenty-first century is the problem of the image.' },
    { who: 'W. J. T. MITCHELL', src: 'What Do Pictures Want?, 2005', tags: ['empty', 'miss', 'zoom'],
      text: 'What pictures want in the last instance, then, is simply to be asked what they want, with the understanding that the answer may well be, nothing at all.' },
    { who: 'KARL MARX', src: 'Capital, Vol. 1, 1867', tags: ['score', 'any'],
      text: 'It is nothing but the definite social relation between men themselves which assumes here, for them, the fantastic form of a relation between things.' },
    { who: 'MARX & ENGELS', src: 'The Communist Manifesto, 1848', tags: ['score'],
      text: 'It has resolved personal worth into exchange value.' },
    { who: 'MARX & ENGELS', src: 'The Communist Manifesto, 1848', tags: ['score', 'hurt'],
      text: 'It has left remaining no other nexus between man and man than naked self-interest, than callous "cash payment".' },
    { who: 'GEORG SIMMEL', src: 'The Metropolis and Mental Life, 1903', tags: ['score', 'far'],
      text: 'Money becomes the most frightful leveler. Money, with all its colorlessness and indifference, becomes the common denominator of all values.' },
    { who: 'GUY DEBORD', src: 'The Society of the Spectacle, 1967', tags: ['score', 'any'],
      text: 'The spectacle is capital accumulated to the point where it becomes image.' },
    { who: 'SUSAN SONTAG', src: 'On Photography, 1977', tags: ['close', 'far', 'zoom'],
      text: 'Photographing is essentially an act of non-intervention.' },
    { who: 'SUSAN SONTAG', src: 'Regarding the Pain of Others, 2003', tags: ['zoom', 'score'],
      text: 'Photographs objectify: they turn an event or a person into something that can be possessed.' },
    { who: 'SUSAN SONTAG', src: 'Regarding the Pain of Others, 2003', tags: ['hurt', 'far'],
      text: 'Compassion is an unstable emotion. It needs to be translated into action, or it withers.' },
    { who: 'JOHN BERGER', src: 'Ways of Seeing, 1972', tags: ['any'],
      text: 'Every image embodies a way of seeing.' },
    { who: 'JOHN BERGER', src: 'Uses of Photography, 1978', tags: ['rope', 'far'],
      text: 'The camera relieves us of the burden of memory. It surveys us like God, and it surveys for us.' },
  ];

  function pickQuote(tag) {
    const used = game.usedQuotes;
    let pool = QUOTES.filter((q) => q.tags.includes(tag) && !used.has(q));
    if (!pool.length) pool = QUOTES.filter((q) => !used.has(q));
    if (!pool.length) { used.clear(); pool = QUOTES.slice(); }
    const q = pool[(Math.random() * pool.length) | 0];
    used.add(q);
    return q;
  }

  // ---------------------------------------------------------------- dialog
  const DIALOG_COLS = 42, DIALOG_ROWS = 4;
  function wrap(str, cols) {
    const out = [];
    let line = '';
    for (const word of str.split(' ')) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cols) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
    return out;
  }
  function openDialog(quote) {
    const lines = wrap(`"${quote.text}"`, DIALOG_COLS).concat(wrap(`- ${quote.src}`, DIALOG_COLS));
    const pages = [];
    for (let i = 0; i < lines.length; i += DIALOG_ROWS) pages.push(lines.slice(i, i + DIALOG_ROWS));
    game.dialog = { quote, pages, page: 0, shown: 0, blip: 0 };
    state = 'dialog';
    keys.zoom = false;
    sfx.open();
  }
  const pageLength = (d) => d.pages[d.page].reduce((n, l) => n + l.length, 0);
  function updateDialog(dt) {
    const d = game.dialog;
    const before = Math.floor(d.shown);
    d.shown = Math.min(pageLength(d), d.shown + dt * 48);
    if (Math.floor(d.shown) !== before && Math.floor(d.shown) % 3 === 0) sfx.blip();
    game.flash = Math.max(0, game.flash - dt * 4);
  }
  function advanceDialog() {
    const d = game.dialog;
    if (!d) { state = 'play'; return; }
    if (d.shown < pageLength(d)) { d.shown = pageLength(d); return; }
    if (d.page < d.pages.length - 1) { d.page++; d.shown = 0; sfx.blip(); return; }
    game.dialog = null;
    state = 'play';
    last = performance.now();
    sfx.close();
  }

  // ---------------------------------------------------------------- sundown
  // Survive to sunset and the chasers stop for a picnic. Linger too long
  // and the sublime comes back for them.
  const LINGER = 60;          // seconds after the toast before the last storm
  const CHEERS_AT = 6.5;
  const PS = 1.4;              // picnic and chasers are drawn a little larger

  function startSunset() {
    const g = game;
    state = 'sunset';
    Object.assign(g, {
      st: 0, px: g.car.x + 140 * (g.car.dir || 1), cloudLift: 0, night: 0,
      finale: false, swept: -1, cheered: false, dialogDelay: 0, pickup: null, msgT: 0,
    });
    keys.zoom = false;
    if (g.mode === 'drive') {
      // Picnic in the field ahead and to the right; the drawing reuses the side-view layout.
      const stopping = (g.speed * g.speed) / (2 * 3500); // the car coasts to a stop first
      g.picnic = { x: ROAD_W * 1.8, z: g.dist + stopping + 5200 };
      g.car.x = 0; g.car.dir = 1; g.px = 140;
    }
    if (g.tor && g.tor.phase !== 'roping') { g.tor.phase = 'roping'; g.tor.pt = 0; }
    setMusicMode('ambient');
    sfx.sundown();
  }

  function updateSunset(dt) {
    const g = game;
    g.st += dt;
    if (!g.finale) {
      g.cloudLift = Math.min(170, g.cloudLift + dt * 22);
      g.night = Math.min(1, g.night + dt / 14);
    } else {
      g.cloudLift = Math.max(0, g.cloudLift - dt * 50);
      g.night = Math.max(0.5, g.night - dt / 8);
    }
    if (!g.cheered && g.st > CHEERS_AT) {
      g.cheered = true;
      sfx.cheers();
      flashMsg('Cheers to the day.', 5);
    }
    if (!g.finale && g.st > CHEERS_AT + LINGER) {
      g.finale = true;
      if (g.mode === 'drive') {
        spawnDriveTornado();
        Object.assign(g.tor, { x: g.picnic.x + 13000, z: g.picnic.z + 9000, ef: 4, size: 0.75 + 4 * 0.11, life: 1e9, finale: true, core: 1 });
      } else {
        spawnTornado(g.px);
        Object.assign(g.tor, { x: g.px + 760, ef: 4, size: 0.75 + 4 * 0.11, life: 1e9, finale: true, core: 1 });
      }
      sfx.omen();
    }
    const T = g.tor;
    const reached = T && (g.mode === 'drive'
      ? Math.hypot(tornadoGroundX(T) - g.picnic.x, T.z - g.picnic.z) < 700
      : Math.abs(tornadoGroundX(T) - g.px) < 60);
    if (g.finale && T && g.swept < 0 && tornadoOnGround(T) && reached) {
      g.swept = 0;
      sfx.swept();
    }
    if (g.swept >= 0) {
      g.swept += dt;
      g.shake = Math.max(g.shake, 4);
      if (g.swept > 4.2) endGame('Swept up by the sublime.');
    }
  }

  // Where each chaser is and what they are doing at this moment.
  function chaserStates(g) {
    const st = g.st, c = g.car, by = ROAD_Y - 16;
    const seats = [g.px - 21, g.px + 21];
    const starts = [c.x - 6, c.x + 10];
    return [0, 1].map((i) => {
      const walk = clamp((st - 1.6 - i * 0.3) / 2, 0, 1);
      if (st < 1.6 + i * 0.3) return null; // still in the car
      const x = lerp(starts[i], seats[i], walk);
      const y = lerp(ROAD_Y, by, Math.min(1, walk * 1.6));
      const face = i === 0 ? 1 : -1;
      if (walk < 1) return { x, y, pose: 'walk', face: Math.sign(seats[i] - starts[i]) || 1, arm: 0 };
      const toast = clamp((st - CHEERS_AT + 0.6) / 0.6, 0, 1) * (st < CHEERS_AT + 2.5 ? 1 : clamp(1 - (st - CHEERS_AT - 2.5) / 0.5, 0, 1));
      const pose = st > 4.6 ? 'sit' : 'stand';
      return { x, y, pose, face, arm: pose === 'sit' ? Math.max(toast, 0.35) : 0, glass: st > 5 };
    });
  }

  const CHASERS = [
    { coat: '#ffd23f', coatDark: '#c99a10', hair: '#4a2c1a' },
    { coat: '#3fb5c4', coatDark: '#24808c', hair: '#2a1a12', cap: '#e8281f' },
  ];

  function drawChaser(x, y, o, look, t, spin) {
    ctx.save();
    ctx.translate(x, y);
    if (spin) ctx.rotate(spin);
    ctx.scale(o.face * PS, PS);
    ctx.lineCap = 'round';
    const skin = '#f2c9a0', legs = '#3a3450';
    let top;
    if (o.pose === 'sit') {
      ctx.strokeStyle = legs; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(-2, -3); ctx.lineTo(8, -3); ctx.lineTo(11, 0); ctx.stroke();
      top = -17;
    } else {
      const sw = o.pose === 'walk' ? Math.sin(t * 12) * 3.5 : 0;
      ctx.strokeStyle = legs; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(sw, 0); ctx.moveTo(0, -10); ctx.lineTo(-sw, 0); ctx.stroke();
      top = -23;
    }
    // Coat
    const coat = ctx.createLinearGradient(-5, 0, 5, 0);
    coat.addColorStop(0, look.coatDark); coat.addColorStop(1, look.coat);
    ctx.fillStyle = coat;
    pill(-5, top, 10, o.pose === 'sit' ? 15 : 14);
    ctx.fill();
    // Arm and glass
    const sx = 2, sy = top + 4;
    const hx = sx + 4 + o.arm * 2, hy = sy + 6 - o.arm * 13;
    ctx.strokeStyle = look.coatDark; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(hx, hy); ctx.stroke();
    if (o.glass) {
      ctx.fillStyle = 'rgba(230,244,255,0.95)';
      ctx.fillRect(hx - 1.5, hy - 6, 3.5, 5);
      ctx.fillStyle = '#c0283a';
      ctx.fillRect(hx - 1, hy - 3.5, 2.5, 2.5);
      ctx.fillStyle = 'rgba(230,244,255,0.95)';
      ctx.fillRect(hx - 0.2, hy - 1, 1, 3);
    }
    // Head, hair, cap
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(0, top - 4, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = look.hair;
    ctx.beginPath(); ctx.arc(-1, top - 6, 4.6, Math.PI * 0.9, Math.PI * 2.05); ctx.fill();
    if (look.cap) {
      ctx.fillStyle = look.cap;
      ctx.beginPath(); ctx.arc(0, top - 6.5, 4.6, Math.PI, 0); ctx.fill();
      ctx.fillRect(1, top - 7, 6, 1.8);
    }
    ctx.fillStyle = '#2a1a12';
    ctx.fillRect(2, top - 5, 1.4, 1.4);
    ctx.restore();
  }

  function drawBlanket(cx, by, w, spin) {
    ctx.save();
    ctx.translate(cx, by);
    if (spin) ctx.rotate(spin);
    ctx.scale(PS, PS);
    const cols = 8, rows = 2, h = 9, cw = w / cols;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        ctx.fillStyle = (r + k) % 2 ? '#fff4e0' : '#d8322b';
        const skew = (rows - r) * 2;
        ctx.fillRect(-w / 2 + k * cw - skew, -h + r * (h / rows), cw + 0.5, h / rows + 0.5);
      }
    }
    ctx.restore();
  }

  function drawBasket(x, y, spin) {
    ctx.save();
    ctx.translate(x, y);
    if (spin) ctx.rotate(spin);
    ctx.scale(PS, PS);
    ctx.strokeStyle = '#6b4424'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, -7, 5, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = '#b07a44';
    ctx.fillRect(-6, -7, 12, 7);
    ctx.fillStyle = '#8a5a30';
    ctx.fillRect(-6, -4, 12, 1.5);
    ctx.fillStyle = '#245a34';
    ctx.fillRect(8, -11, 3, 11);
    ctx.fillRect(8.7, -14, 1.6, 3);
    ctx.restore();
  }

  // The picnic, the chasers and the fireflies (world pass).
  function drawPicnic(g, cam) {
    const st = g.st, by = ROAD_Y - 14;
    const px = g.px - cam;
    const sw = g.swept;
    const T = g.tor;
    const gx = g.mode === 'drive' || !T ? px : tornadoGroundX(T) - cam;
    // Something swept up spirals into the funnel and rises to the cloud.
    const fly = (i, r0) => {
      const k = Math.min(1, Math.pow(sw / 3.6, 1.4));
      const a = sw * 6 + i * 2.1;
      const r = r0 * (1 - k * 0.6);
      return { x: gx + Math.cos(a) * r, y: lerp(by, CLOUD_BASE + 10, k) + Math.sin(a) * 4, spin: sw * (5 + i) };
    };

    const blanketW = clamp((st - 3.6) / 1, 0, 1) * 64;
    if (blanketW > 0) {
      if (sw >= 0) { const f = fly(2, 50); drawBlanket(f.x, f.y, blanketW, f.spin); }
      else drawBlanket(px, by + 2, blanketW);
    }
    if (st > 4.4) {
      if (sw >= 0) { const f = fly(3, 40); drawBasket(f.x, f.y, f.spin); }
      else drawBasket(px, by - 1);
    }
    chaserStates(g).forEach((o, i) => {
      if (!o) return;
      if (sw >= 0) {
        const f = fly(i, 30 + i * 12);
        drawChaser(f.x, f.y, { ...o, pose: 'stand', arm: 1 }, CHASERS[i], g.t + sw, f.spin);
      } else {
        drawChaser(o.x - cam, o.y, o, CHASERS[i], st, 0);
      }
    });

    // The clink
    if (g.cheered && st < CHEERS_AT + 1) {
      const a = 1 - (st - CHEERS_AT);
      ctx.strokeStyle = `rgba(255,240,150,${a})`;
      ctx.lineWidth = 2;
      const cx = px, cy = by - 46;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const ang = k * Math.PI / 3;
        ctx.moveTo(cx + Math.cos(ang) * 4, cy + Math.sin(ang) * 4);
        ctx.lineTo(cx + Math.cos(ang) * (8 + (1 - a) * 8), cy + Math.sin(ang) * (8 + (1 - a) * 8));
      }
      ctx.stroke();
    }

    // Fireflies
    if (st > 8 && sw < 0) {
      for (let i = 0; i < 14; i++) {
        const fx = px + Math.sin(st * 0.4 + i * 1.7) * (60 + hash(i) * 120);
        const fy = by - 30 + Math.sin(st * 0.7 + i * 2.3) * 28;
        const a = Math.max(0, Math.sin(st * 2 + i * 1.3)) * clamp((st - 8) / 3, 0, 1);
        if (a <= 0.05) continue;
        ctx.fillStyle = `rgba(220,255,120,${a * 0.35})`;
        ctx.beginPath(); ctx.arc(fx, fy, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `rgba(250,255,190,${a})`;
        ctx.fillRect(fx - 1.2, fy - 1.2, 2.5, 2.5);
      }
    }
  }

  function drawStars(g) {
    if (!g.night) return;
    for (let i = 0; i < 70; i++) {
      const x = hash(i + 300) * W;
      const y = 6 + hash(i + 400) * (HORIZON - 70);
      const a = g.night * (0.5 + 0.5 * Math.sin(g.st * 2 + i)) * 0.9;
      ctx.fillStyle = `rgba(255,252,230,${a})`;
      const s = hash(i + 500) > 0.85 ? 3.5 : 2.5;
      ctx.fillRect(x, y, s, s);
    }
  }

  // Screen-space text for the cutscene.
  function drawSunsetOverlay(g) {
    const st = g.st;
    if (st > 0.3 && st < 3.6) {
      const a = Math.min(1, (st - 0.3) * 2, (3.6 - st) * 2);
      text('SUNDOWN', SW / 2, 54, { size: 16, align: 'center', color: '#ffb45a', outline: true, alpha: a });
    }
    if (st > 1) text(`SCORE ${g.score}   FRAMES ${g.frames}`, SW / 2, 8, { align: 'center', color: '#ffe680', alpha: Math.min(1, st - 1) });
    if (g.msgT > 0) text(g.msg, SW / 2, 30, { align: 'center', alpha: Math.min(1, g.msgT * 2) });
    if (st > CHEERS_AT + 2 && g.swept < 0 && Math.floor(performance.now() / 600) % 2) {
      text(TOUCH ? 'TAP: CALL IT A DAY' : 'SPACE: CALL IT A DAY', SW / 2, SH - 14, { align: 'center', color: '#ffe680' });
    }
  }

  // ---------------------------------------------------------------- upgrades
  // Drive over a pickup to bolt it onto the car.
  const UPGRADES = {
    nets: { label: 'NETS', msg: 'WINDOW NETS. Hail hurts less.' },
    roof: { label: 'ROOF', msg: 'ROOF ARMOR. Debris hurts less.' },
    tires: { label: 'TIRES', msg: 'BIG TIRES + LIFT. More speed.' },
    radar: { label: 'RADAR', msg: 'RADAR ONLINE. Storms tracked.' },
  };
  const isFeral = () => game.up.nets && game.up.roof && game.up.tires && game.up.radar;

  function updatePickups(dt) {
    const g = game, c = g.car;
    const remaining = Object.keys(UPGRADES).filter((k) => !g.up[k]);
    if (!g.pickup && remaining.length) {
      g.pickupCd -= dt;
      if (g.pickupCd <= 0) {
        g.pickup = {
          kind: remaining[(Math.random() * remaining.length) | 0],
          x: c.x + (Math.random() < 0.5 ? -1 : 1) * rand(500, 900),
        };
      }
    }
    if (g.pickup && Math.abs(g.pickup.x - c.x) < 34) installUpgrade(g.pickup.kind);
  }

  function installUpgrade(kind) {
    const g = game;
    g.up[kind] = true;
    g.pickup = null;
    g.pickupCd = rand(10, 16);
    g.car.hp = Math.min(100, g.car.hp + 10);
    if (isFeral()) { flashMsg('FULLY KITTED. The car has gone feral.', 3); sfx.feral(); setMusicMode('metal'); }
    else { flashMsg(UPGRADES[kind].msg, 2.6); sfx.powerup(); }
  }

  // ---------------------------------------------------------------- photos
  function takePhoto() {
    if (game.shutterCd > 0 || game.film <= 0 || game.ending > 0) return;
    game.shutterCd = 0.4;
    game.film--;
    game.flash = 1;
    sfx.shutter();

    const T = game.tor;
    const z = game.zoom;
    let points = 0, short = 'Empty sky.', tag = 'empty';
    const ahead = !T || game.mode !== 'drive' || T.z > game.dist + NEAR;
    if (T && T.alpha > 0.25 && ahead) {
      const zx = tornadoZX(T);
      const phaseName = { forming: 'funnel', mature: 'tornado', roping: 'rope-out' }[T.phase];
      if (zx < -30 || zx > W + 30) {
        short = 'Missed it. Out of frame.';
        tag = 'miss';
      } else {
        const d = tornadoMiles(T);
        const dEff = d / z; // zooming in stands in for getting closer
        const closeness = clamp(1 - (dEff - 0.09) / 1.125, 0, 1);
        const framing = 1 - 0.4 * Math.min(1, Math.abs(zx - W / 2) / (W / 2));
        const phaseMult = T.phase === 'forming' ? 0.6 : T.phase === 'roping' ? 1.4 : 1;
        const reach = tornadoReach(T);
        points = Math.round(100 * closeness * framing * (1 + T.ef * 0.4) * phaseMult * T.alpha * (0.4 + 0.6 * reach));
        short = `EF${T.ef} ${phaseName}`;
        if (game.lightning > 0) { points += 40; short += ' + bolt'; }
        if (points < 15) short = 'Too far.';
        tag = game.lightning > 0 ? 'lightning'
          : game.car.hp < 40 ? 'hurt'
          : d < 0.255 ? 'close'
          : z > 1.6 ? 'zoom'
          : T.phase === 'roping' ? 'rope'
          : points >= 110 ? 'score'
          : dEff > 0.675 ? 'far' : 'any';
      }
    } else if (T && T.alpha > 0.25) {
      short = 'Missed it. It\'s behind you.';
      tag = 'miss';
    }
    game.score += points;
    sfx.score(points);
    flashMsg(points > 0 ? `+${points}  ${short}` : short, 1.8);
    const quote = pickQuote(tag);
    game.frames++;
    game.dialogQuote = quote;
    game.dialogDelay = 0.7;
    if (game.film === 0) game.ending = 1.6;
  }

  // ---------------------------------------------------------------- update
  function update(dt) {
    if (game.mode === 'drive') { updateDrive(dt); return; }
    const g = game;
    if (state === 'play') g.t += dt;
    const c = g.car;

    // Viewfinder zoom eases in while held and back out on release.
    const zt = state === 'play' && keys.zoom ? MAX_ZOOM : 1;
    g.zoom += clamp(zt - g.zoom, -dt * 4, dt * 2.2);
    // While zoomed, the photographer pans after the tornado, a little behind it.
    let aimTarget = W / 2;
    if (g.tor && keys.zoom) {
      const sx = tornadoGroundX(g.tor) - g.camX;
      if (sx > -60 && sx < W + 60) aimTarget = clamp(sx, 120, W - 120);
    }
    g.aimX += (aimTarget - g.aimX) * Math.min(1, dt * 2.5);
    if (state === 'play') updatePickups(dt);
    if (state === 'play' && g.dialogDelay > 0) {
      g.dialogDelay -= dt;
      if (g.dialogDelay <= 0) openDialog(g.dialogQuote);
    }

    // Car
    if (state === 'play') {
      const input = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      if (input) {
        c.vx += input * (g.up.tires ? 780 : 640) * dt;
        c.dir = input;
      } else {
        c.vx -= Math.sign(c.vx) * Math.min(Math.abs(c.vx), 420 * dt);
      }
      const vmax = g.up.tires ? 410 : 340;
      c.vx = clamp(c.vx, -vmax, vmax);
    } else if (state === 'sunset') {
      c.vx -= Math.sign(c.vx) * Math.min(Math.abs(c.vx), 500 * dt);
      updateSunset(dt);
    }
    c.x += c.vx * dt;
    c.wheel += c.vx * dt / 8;
    c.hurt = Math.max(0, c.hurt - dt);

    // Camera leads the car a little.
    const target = state === 'sunset' ? (c.x + g.px) / 2 - W / 2 : c.x - W / 2 + c.vx * 0.45;
    g.camX += (target - g.camX) * Math.min(1, dt * 3.5);

    updateTornado(dt);
    const T = g.tor;

    // Hail in the core
    if (T && T.alpha > 0.3) {
      const [a, b] = coreRange(T);
      const rate = 26 * T.alpha;
      let n = rate * dt;
      while (n > 0) {
        if (Math.random() < n) {
          g.hail.push({ x: rand(a, b), y: rand(-20, CLOUD_BASE), vy: rand(420, 560), vx: rand(-30, -10) * T.core });
        }
        n -= 1;
      }
    }
    for (let i = g.hail.length - 1; i >= 0; i--) {
      const h = g.hail[i];
      h.x += h.vx * dt; h.y += h.vy * dt;
      if (state === 'play' && h.y > ROAD_Y - 30 && h.y < ROAD_Y && Math.abs(h.x - c.x) < 30) {
        damage(g.up.nets ? 0.35 : 1);
        if (T && !T.hailWarned) { T.hailWarned = true; flashMsg('Hail! Get out of the core.'); }
        g.hailSound -= 1;
        if (g.hailSound < 0) { sfx.hail(); g.hailSound = 1; }
        g.hail.splice(i, 1);
        continue;
      }
      if (h.y > ROAD_Y + 40) g.hail.splice(i, 1);
    }

    // Debris and dust from the tornado
    if (T && tornadoOnGround(T)) {
      const gx = tornadoGroundX(T);
      if (Math.random() < (2 + T.ef * 1.4) * dt * (1 - T.rope * 0.8)) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        g.debris.push({
          x: gx + rand(-10, 10), y: TOR_GROUND - rand(10, 60),
          vx: dir * rand(60, 170 + T.ef * 25), vy: -rand(140, 320),
          rot: rand(0, 6), vr: rand(-10, 10), w: rand(8, 18), h: rand(3, 6),
          cow: Math.random() < 0.07,
        });
      }
      if (Math.random() < 40 * dt) {
        const a = rand(0, Math.PI * 2);
        g.dust.push({ a, r: rand(10, 30 + T.ef * 10), y: TOR_GROUND - rand(0, 30), life: rand(0.6, 1.4), max: 1.4, x: gx });
      }
      // Direct hit
      const d = Math.abs(c.x - gx);
      const funnelW = funnelAt(T, 1, g.t).w;
      if (state === 'play' && d < funnelW * 0.5 + 24) {
        damage((15 + T.ef * 5) * dt * (g.up.tires ? 0.7 : 1), true);
        c.vx += rand(-900, 900) * dt * (g.up.tires ? 0.5 : 1);
        g.shake = Math.max(g.shake, 8);
      }
    }
    for (let i = g.debris.length - 1; i >= 0; i--) {
      const p = g.debris[i];
      p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (state === 'play' && p.y > ROAD_Y - 30 && p.y < ROAD_Y && Math.abs(p.x - c.x) < 32) {
        damage(g.up.roof ? 1.2 : 3);
        sfx.hit();
        g.shake = Math.max(g.shake, 6);
        g.debris.splice(i, 1);
        continue;
      }
      if (p.y > H + 20) g.debris.splice(i, 1);
    }
    for (let i = g.dust.length - 1; i >= 0; i--) {
      const p = g.dust[i];
      p.life -= dt; p.a += dt * 4; p.y -= dt * 18; p.r += dt * 6;
      if (T) p.x = tornadoGroundX(T);
      if (p.life <= 0 || !T) g.dust.splice(i, 1);
    }

    // Lightning
    g.lightningCd -= dt;
    if (g.lightningCd <= 0) {
      g.lightningCd = rand(3, 8);
      g.lightning = 0.3;
      const bx = T ? tornadoGroundX(T) + rand(-500, 500) : g.camX + rand(0, W);
      g.bolt = makeBolt(bx);
      setTimeout(() => sfx.thunder(), rand(150, 900));
    }
    g.lightning = Math.max(0, g.lightning - dt);

    g.flash = Math.max(0, g.flash - dt * 4);
    g.shutterCd = Math.max(0, g.shutterCd - dt);
    g.msgT = Math.max(0, g.msgT - dt);
    g.shake = Math.max(0, g.shake - dt * 20);

    if (state === 'play') {
      if (c.hp <= 0) endGame('The storm took your car.');
      else if (g.t >= DAY_LENGTH) startSunset();
      else if (g.ending > 0) {
        g.ending -= dt;
        if (g.ending <= 0) endGame('Out of film.');
      }
    }
  }

  function damage(amount, silent) {
    const c = game.car;
    c.hp = Math.max(0, c.hp - amount);
    c.hurt = 0.25;
    if (!silent) game.shake = Math.max(game.shake, 3);
  }

  function makeBolt(x) {
    const pts = [[x, CLOUD_BASE - 10]];
    let cx = x, cy = CLOUD_BASE - 10;
    while (cy < TOR_GROUND) {
      cx += rand(-28, 28);
      cy += rand(18, 40);
      pts.push([cx, Math.min(cy, TOR_GROUND)]);
    }
    return pts;
  }

  // ---------------------------------------------------------------- drawing
  // Storybook palette as [afternoon, dusk] pairs, blended as the sun goes down.
  const PAL = {
    skyTop: [[118, 172, 216], [70, 66, 136]],
    skyLow: [[255, 228, 182], [255, 152, 124]],
    sun: [[255, 238, 160], [255, 172, 112]],
    cloudTop: [[150, 146, 186], [104, 84, 136]],
    cloudBase: [[98, 94, 136], [66, 52, 98]],
    cloudShade: [[70, 66, 106], [46, 36, 74]],
    cloudLight: [[206, 202, 230], [214, 156, 186]],
    hillFar: [[158, 198, 158], [118, 122, 150]],
    hillNear: [[116, 176, 110], [88, 112, 116]],
    hillShade: [[88, 150, 88], [66, 88, 100]],
    tree: [[86, 160, 88], [64, 100, 98]],
    treeLight: [[150, 210, 128], [104, 140, 130]],
    fieldTop: [[248, 216, 124], [214, 154, 128]],
    fieldLow: [[238, 186, 86], [192, 122, 100]],
    wheat: [[206, 150, 58], [158, 98, 86]],
    funnel: [[104, 98, 138], [70, 56, 98]],
    funnelLight: [[184, 180, 210], [168, 132, 172]],
    funnelShade: [[66, 60, 98], [42, 32, 68]],
    rain: [[126, 136, 178], [90, 80, 130]],
    road: [[112, 106, 124], [80, 70, 100]],
    roadEdge: [[156, 150, 164], [108, 96, 124]],
    verge: [[128, 188, 106], [90, 118, 108]],
    vergeDark: [[96, 158, 84], [70, 96, 92]],
    pole: [[150, 100, 64], [108, 74, 70]],
    poleLight: [[196, 146, 104], [146, 106, 96]],
  };
  let dusk = 0;
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const col = (name, a = 1) => rgb(mix(PAL[name][0], PAL[name][1], dusk), a);
  const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  // A shaded, round puff: lit from the upper left, darker toward the lower right.
  function puff(x, y, r, light, base, shade) {
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.08, x, y, r);
    g.addColorStop(0, light);
    g.addColorStop(0.55, base);
    g.addColorStop(1, shade);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function pill(x, y, w, h) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2);
    else ctx.rect(x, y, w, h);
  }

  function draw() {
    const g = game;
    dusk = clamp((g.t - DAY_LENGTH * 0.55) / (DAY_LENGTH * 0.45), 0, 1);
    // Snap the camera to whole screen pixels so scrolling stays crisp.
    const cam = Math.round(g.camX * PX) / PX;
    const T = g.tor;

    // World pass, in 960x540 logical units scaled down to the console screen.
    ctx.setTransform(PX, 0, 0, PX, 0, 0);
    ctx.translate(W / 2, ZOOM_Y);
    ctx.scale(g.zoom, g.zoom);
    ctx.translate(-zoomFocus(), -ZOOM_Y);
    if (g.shake > 0) ctx.translate(Math.round(rand(-1, 1) * g.shake / 2.5) * 2.5, Math.round(rand(-1, 1) * g.shake / 2.5) * 2.5);

    if (g.mode === 'drive') drawDriveWorld(g);
    else {
    drawSky(g);
    drawHills(cam);
    drawField(g, cam);
    if (T) drawRain(T, cam, g);
    if (T) drawTornado(T, cam);
    if (state === 'sunset') drawStars(g);
    ctx.save();
    if (state === 'sunset') ctx.translate(0, -g.cloudLift);
    drawStormCloud(cam, T);
    ctx.restore();
    drawLightning(g, cam);
    drawPoles(cam);
    drawRoad(cam);
    if (state === 'sunset') drawPicnic(g, cam);
    drawPickup(g, cam);
    drawCar(g.car, cam);
    drawHail(g, cam);
    drawDebris(g, cam);
    drawFence(cam);
    }

    if (g.lightning > 0) {
      ctx.fillStyle = `rgba(255,250,224,${0.3 * (g.lightning / 0.3)})`;
      ctx.fillRect(-W, -H, W * 3, H * 3);
    }
    if (dusk > 0) {
      ctx.fillStyle = `rgba(70,40,110,${dusk * 0.22})`;
      ctx.fillRect(-W, -H, W * 3, H * 3);
    }
    if (state === 'sunset' && g.night > 0) {
      ctx.fillStyle = `rgba(16,12,48,${g.night * 0.3})`;
      ctx.fillRect(-W, -H, W * 3, H * 3);
    }

    // Everything from here on is in screen pixels.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    posterize();

    if (g.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${g.flash * 0.85})`;
      ctx.fillRect(0, 0, SW, SH);
    }

    if (g.zoom > 1.02 && (state === 'play' || state === 'paused')) drawViewfinder(g);
    if (state === 'play' || state === 'paused' || state === 'dialog') drawHUD();
    if (state === 'dialog' && g.dialog) drawDialog(g.dialog);
    if (state === 'sunset') drawSunsetOverlay(g);
    if (state === 'title') drawTitle();
    if (state === 'paused') drawCenter('PAUSED', TOUCH ? 'Tap to resume' : 'Press P or tap to resume');
    if (state === 'over') {
      drawCenter(g.endReason, `${g.frames} frames exposed. Score ${g.score}. Best ${best}.`);
      if (performance.now() - g.overAt > 1000 && Math.floor(performance.now() / 500) % 2) {
        text(TOUCH ? 'TAP TO CONTINUE' : 'PRESS SPACE OR TAP TO CONTINUE', SW / 2, SH / 2 + 26, { align: 'center', color: '#ffe680' });
      }
    }
  }

  // Reduce to a 4-bit-per-channel palette for that banded console look.
  function posterize() {
    const img = ctx.getImageData(0, 0, SW, SH);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = (d[i] & 0xf0) | (d[i] >> 4);
      d[i + 1] = (d[i + 1] & 0xf0) | (d[i + 1] >> 4);
      d[i + 2] = (d[i + 2] & 0xf0) | (d[i + 2] >> 4);
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawSky(g) {
    const grad = ctx.createLinearGradient(0, 0, 0, HORIZON);
    grad.addColorStop(0, col('skyTop'));
    grad.addColorStop(1, col('skyLow'));
    ctx.fillStyle = grad;
    ctx.fillRect(-20, -20, W + 40, HORIZON + 40);

    // A low sun shining under the storm, setting through the day.
    const sx = W * 0.82, sy = lerp(178, HORIZON + 6, clamp(g.t / DAY_LENGTH, 0, 1));
    const glow = ctx.createRadialGradient(sx, sy, 10, sx, sy, 150);
    glow.addColorStop(0, col('sun', 0.7));
    glow.addColorStop(1, col('sun', 0));
    ctx.fillStyle = glow;
    ctx.fillRect(sx - 150, sy - 150, 300, 300);
    ctx.fillStyle = col('sun');
    ctx.beginPath(); ctx.arc(sx, sy, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.arc(sx - 7, sy - 8, 9, 0, Math.PI * 2); ctx.fill();
  }

  function hillY(wx, near) {
    return near
      ? HORIZON - 6 - (Math.sin(wx * 0.006 + 2) * 12 + Math.sin(wx * 0.017) * 6 + 8)
      : HORIZON - 20 - (Math.sin(wx * 0.004) * 14 + Math.sin(wx * 0.011) * 8);
  }

  function drawHills(cam) {
    for (const near of [false, true]) {
      const par = near ? 0.25 : 0.12;
      const g = ctx.createLinearGradient(0, HORIZON - 50, 0, HORIZON + 4);
      g.addColorStop(0, near ? col('hillNear') : col('hillFar'));
      g.addColorStop(1, near ? col('hillShade') : col('hillNear'));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-20, HORIZON + 4);
      for (let sx = -20; sx <= W + 20; sx += 10) ctx.lineTo(sx, hillY(sx + cam * par, near));
      ctx.lineTo(W + 20, HORIZON + 4);
      ctx.closePath();
      ctx.fill();
    }

    // Lollipop trees and the odd barn on the near hills.
    const par = 0.25, step = 70;
    const first = Math.floor((cam * par - 60) / step);
    for (let i = first; i < first + W / step + 3; i++) {
      const h = hash(i);
      if (h < 0.5) continue;
      const wx = i * step + hash(i + 3) * 40;
      const sx = wx - cam * par;
      const by = hillY(wx, true) + 4;
      if (hash(i * 1.7) > 0.93) { drawBarn(sx, by); continue; }
      const r = 7 + hash(i + 9) * 6;
      ctx.fillStyle = col('pole');
      ctx.fillRect(sx - 1.5, by - r - 6, 3, r + 6);
      puff(sx, by - r - 8, r, col('treeLight'), col('tree'), col('hillShade'));
    }
  }

  function drawBarn(x, y) {
    const red = rgb(mix([214, 64, 58], [150, 60, 80], dusk));
    const dark = rgb(mix([160, 40, 44], [110, 44, 66], dusk));
    // Silo
    ctx.fillStyle = rgb(mix([210, 206, 214], [150, 130, 160], dusk));
    ctx.fillRect(x + 16, y - 34, 10, 34);
    ctx.beginPath(); ctx.arc(x + 21, y - 34, 5, Math.PI, 0); ctx.fill();
    // Barn body and roof
    ctx.fillStyle = red;
    ctx.fillRect(x - 14, y - 18, 28, 18);
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(x - 17, y - 17); ctx.lineTo(x, y - 30); ctx.lineTo(x + 17, y - 17); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,250,240,0.9)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x - 5, y - 11, 10, 11);
    ctx.beginPath(); ctx.moveTo(x - 5, y - 11); ctx.lineTo(x + 5, y); ctx.moveTo(x + 5, y - 11); ctx.lineTo(x - 5, y); ctx.stroke();
  }

  function drawField(g, cam) {
    const fg = ctx.createLinearGradient(0, HORIZON, 0, ROAD_Y);
    fg.addColorStop(0, col('fieldTop'));
    fg.addColorStop(1, col('fieldLow'));
    ctx.fillStyle = fg;
    ctx.fillRect(-20, HORIZON - 2, W + 40, ROAD_Y - HORIZON + 2);

    // Rows of wheat tufts, bigger and faster as they get closer.
    ctx.strokeStyle = col('wheat');
    ctx.lineCap = 'round';
    const rows = 6;
    for (let r = 0; r < rows; r++) {
      const k = r / (rows - 1);
      const y = HORIZON + 12 + Math.pow(k, 1.4) * (ROAD_Y - HORIZON - 34);
      const par = 0.32 + k * 0.6;
      const step = 22 + k * 26;
      const size = 3 + k * 6;
      ctx.lineWidth = 2.2 + k * 1.6;
      const off = cam * par;
      const first = Math.floor((off - 20) / step);
      ctx.beginPath();
      for (let i = first; i < first + W / step + 3; i++) {
        const x = i * step + hash(i + r * 31) * step * 0.6 - off;
        const sway = Math.sin(g.t * 2 + i * 0.7) * size * 0.25;
        for (const a of [-0.5, 0, 0.5]) {
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.sin(a) * size + sway, y - Math.cos(a) * size * 1.4);
        }
      }
      ctx.stroke();
    }
    drawCattle(g, cam);
  }

  // Small herds grazing in the wheat. Ones standing where the tornado is
  // touching down are not drawn: they have been taken.
  function drawCattle(g, cam) {
    const T = g.tor;
    const tx = T && tornadoOnGround(T) ? tornadoGroundX(T) - cam : null;
    const bands = [{ k: 0.3, step: 300, seed: 1 }, { k: 0.7, step: 380, seed: 2 }];
    for (const b of bands) {
      const par = 0.32 + b.k * 0.6;
      const scale = 0.75 + b.k * 0.75;
      const y = HORIZON + 12 + Math.pow(b.k, 1.4) * (ROAD_Y - HORIZON - 34) + 4;
      const off = cam * par;
      const first = Math.floor((off - 200) / b.step);
      for (let i = first; i < first + W / b.step + 3; i++) {
        if (hash(i * 13.7 + b.seed) < 0.6) continue;
        const n = 1 + Math.floor(hash(i * 5.1 + b.seed) * 3);
        for (let j = 0; j < n; j++) {
          const id = i * 7 + j + b.seed * 1000;
          const x = i * b.step + j * 34 * scale + hash(id) * 20 - off;
          if (x < -40 || x > W + 40) continue;
          if (tx !== null && Math.abs(x - tx) < 120) continue;
          drawGrazingCow(x, y + hash(id + 3) * 6, scale, hash(id + 5) > 0.5 ? 1 : -1, g.t + hash(id + 9) * 50);
        }
      }
    }
  }

  function drawGrazingCow(x, y, s, face, t) {
    const down = Math.sin(t * 0.5) > -0.4;   // mostly grazing, sometimes looking up
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s * face, s);
    // Shadow
    ctx.fillStyle = 'rgba(80,60,40,0.25)';
    ctx.beginPath(); ctx.ellipse(0, 0, 14, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    // Legs
    ctx.fillStyle = '#3a3440';
    for (const lx of [-9, -5, 5, 9]) ctx.fillRect(lx - 1.2, -8, 2.6, 8);
    // Tail
    ctx.strokeStyle = '#3a3440';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-12, -13); ctx.lineTo(-14 + Math.sin(t * 3) * 1.5, -6); ctx.stroke();
    // Body
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#3a3440';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(0, -12, 13, 6.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#3a3440';
    ctx.beginPath(); ctx.arc(-5, -13, 3.2, 0, Math.PI * 2); ctx.arc(4, -10, 2.4, 0, Math.PI * 2); ctx.fill();
    // Head, down in the grass or up and looking around
    const hx = 15, hy = down ? -4 + Math.sin(t * 6) * 0.6 : -17;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(hx, hy, 4.5, 3.6, down ? 0.6 : 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffb3c1';
    ctx.beginPath(); ctx.ellipse(hx + 3, hy + (down ? 2 : 1), 2, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a3440';
    ctx.fillRect(hx - 3, hy - 4.5, 2.2, 2.2);
    ctx.restore();
  }

  // Barbed-wire fence along the near verge, slightly faster than the road.
  function drawFence(cam) {
    const par = 1.25, step = 150, top = ROAD_Y + 14;
    const off = cam * par;
    const first = Math.floor((off - 60) / step);
    const posts = [];
    for (let i = first; i < first + W / step + 3; i++) posts.push(i * step - off + hash(i + 77) * 10);
    const strands = [top + 12, top + 34, top + 56];
    ctx.strokeStyle = 'rgba(70,66,78,0.95)';
    ctx.lineWidth = 2;
    for (let i = 0; i < posts.length - 1; i++) {
      const a = posts[i], b = posts[i + 1];
      for (const sy of strands) {
        ctx.beginPath();
        ctx.moveTo(a, sy);
        ctx.quadraticCurveTo((a + b) / 2, sy + 5, b, sy);
        ctx.stroke();
        // Barbs: little crosses along the strand
        ctx.beginPath();
        for (let k = 1; k < 7; k++) {
          const f = k / 7, bx = lerp(a, b, f), by = sy + 5 * 4 * f * (1 - f) * 0.5;
          ctx.moveTo(bx - 3, by - 3); ctx.lineTo(bx + 3, by + 3);
          ctx.moveTo(bx - 3, by + 3); ctx.lineTo(bx + 3, by - 3);
        }
        ctx.stroke();
      }
    }
    for (const x of posts) {
      ctx.fillStyle = col('pole');
      ctx.fillRect(x - 4, top, 8, H - top + 10);
      ctx.fillStyle = col('poleLight');
      ctx.fillRect(x + 1, top, 2, H - top + 10);
      ctx.fillStyle = 'rgba(40,24,20,0.5)';
      ctx.beginPath(); ctx.moveTo(x - 4, top); ctx.lineTo(x, top - 4); ctx.lineTo(x + 4, top); ctx.closePath(); ctx.fill();
    }
  }

  function drawRain(T, cam, g) {
    if (T.alpha <= 0) return;
    const [a, b] = coreRange(T);
    const x0 = a - cam, x1 = b - cam;
    const rg = ctx.createLinearGradient(x0, 0, x1, 0);
    const ca = col('rain', 0), cb = col('rain', 0.5 * T.alpha);
    if (T.core > 0) { rg.addColorStop(0, ca); rg.addColorStop(0.35, cb); rg.addColorStop(1, cb); }
    else { rg.addColorStop(0, cb); rg.addColorStop(0.65, cb); rg.addColorStop(1, ca); }
    ctx.fillStyle = rg;
    ctx.fillRect(x0, CLOUD_BASE - 10, x1 - x0, ROAD_Y - CLOUD_BASE + 40);
    ctx.strokeStyle = `rgba(235,240,255,${0.3 * T.alpha})`;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < 60; i++) {
      const rx = x0 + ((i * 97 + g.t * 240) % Math.max(1, x1 - x0));
      const ry = CLOUD_BASE + ((i * 53 + g.t * 640) % (ROAD_Y - CLOUD_BASE));
      ctx.moveTo(rx, ry); ctx.lineTo(rx - 5 * T.core, ry + 16);
    }
    ctx.stroke();
  }

  // The lower edge of a cloud tier: straight facets between random points,
  // a slow swell, and the odd hanging tooth of scud.
  function raggedEdge(wx, seed, depth) {
    const step = 26;
    const i = Math.floor(wx / step), f = wx / step - i;
    let y = lerp(hash(i * 7.3 + seed), hash((i + 1) * 7.3 + seed), f);
    const swell = 0.55 + 0.45 * Math.sin(wx * 0.0041 + seed * 5) * Math.sin(wx * 0.0013 + seed);
    const ti = Math.floor(wx / 90), tf = wx / 90 - ti;
    const tooth = hash(ti * 3.1 + seed * 2);
    if (tooth > 0.6) y += (1 - Math.abs(2 * tf - 1)) * 1.8 * (tooth - 0.6) / 0.4;
    return (y * swell + Math.sin(wx * 0.0023 + seed) * 0.4) * depth;
  }

  function drawStormCloud(cam, T) {
    // Dark mass behind everything
    const band = ctx.createLinearGradient(0, 0, 0, CLOUD_BASE);
    band.addColorStop(0, col('cloudTop'));
    band.addColorStop(1, col('cloudBase'));
    ctx.fillStyle = band;
    ctx.fillRect(-W, -H, W * 3, H + CLOUD_BASE - 40);

    // Angular light facets in the upper storm
    const fpar = 0.2, fstep = 150;
    let first = Math.floor((cam * fpar - 200) / fstep);
    for (let i = first; i < first + W / fstep + 4; i++) {
      const sx = i * fstep - cam * fpar + hash(i + 11) * 60;
      const h = hash(i + 21);
      ctx.fillStyle = col('cloudLight', 0.12 + h * 0.16);
      ctx.beginPath();
      ctx.moveTo(sx, 4 + h * 18);
      ctx.lineTo(sx + 70 + h * 60, 16 + hash(i + 31) * 24);
      ctx.lineTo(sx + 30 + h * 30, 44 + h * 20);
      ctx.lineTo(sx - 20, 30);
      ctx.closePath();
      ctx.fill();
    }

    // Stacked shelf tiers: pale, sunlit ledges low down, the heavy dark mass
    // on top. Drawn back to front so each ledge shows beneath the one above.
    const tiers = [
      { par: 0.62, y: CLOUD_BASE - 26, depth: 28, seed: 1, fill: col('cloudTop'), rim: col('sun', 0.55) },
      { par: 0.45, y: CLOUD_BASE - 52, depth: 30, seed: 2, fill: col('cloudBase'), rim: col('cloudLight', 0.4) },
      { par: 0.3, y: CLOUD_BASE - 80, depth: 34, seed: 3, fill: col('cloudShade'), rim: col('cloudLight', 0.25) },
    ];
    for (const t of tiers) {
      const off = cam * t.par;
      ctx.beginPath();
      ctx.moveTo(-W, -H);
      const edge = [];
      for (let sx = -W; sx <= W * 2; sx += 13) {
        const y = t.y + raggedEdge(sx + off, t.seed, t.depth);
        edge.push([sx, y]);
        ctx.lineTo(sx, y);
      }
      ctx.lineTo(W * 2, -H);
      ctx.closePath();
      ctx.fillStyle = t.fill;
      ctx.fill();
      // Inner shadow just above the edge gives each tier a bevel.
      ctx.strokeStyle = col('cloudShade', 0.5);
      ctx.lineWidth = 6;
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      edge.forEach(([x, y], k) => (k ? ctx.lineTo(x, y - 6) : ctx.moveTo(x, y - 6)));
      ctx.stroke();
      // Thin rim of light along the bottom.
      ctx.strokeStyle = t.rim;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      edge.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }

    // Lowered, stepped wall cloud above the tornado, with scud whipping round it.
    if (T && T.alpha > 0) {
      const sx = T.x - cam + T.lean * 0.08;
      if (sx > -400 && sx < W + 400) {
        const s = T.size, B = CLOUD_BASE;
        ctx.save();
        ctx.globalAlpha = T.alpha;
        const pts = [[-200, -24], [-150, 2], [-104, 8], [-84, 22]];
        for (let k = 0; k <= 8; k++) {
          const x = -70 + k * 17.5;
          pts.push([x, 30 + hash(k * 5.7 + Math.floor(T.seed)) * 16 + (k % 2) * 6]);
        }
        pts.push([84, 20], [110, 6], [156, 0], [210, -24]);
        ctx.beginPath();
        pts.forEach(([x, y], k) => (k ? ctx.lineTo(sx + x * s, B + y * s) : ctx.moveTo(sx + x * s, B + y * s)));
        ctx.closePath();
        const wg = ctx.createLinearGradient(0, B - 24 * s, 0, B + 46 * s);
        wg.addColorStop(0, col('cloudShade'));
        wg.addColorStop(1, col('funnelShade'));
        ctx.fillStyle = wg;
        ctx.fill();
        ctx.strokeStyle = col('sun', 0.3);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        pts.slice(1, -1).forEach(([x, y], k) => (k ? ctx.lineTo(sx + x * s, B + y * s) : ctx.moveTo(sx + x * s, B + y * s)));
        ctx.stroke();

        // Ragged scud fragments circling the base
        for (let k = 0; k < 6; k++) {
          const a = game.t * (1.2 + T.ef * 0.15) + k * 1.047;
          const fx = sx + Math.cos(a) * 110 * s;
          const fy = B + 40 * s + Math.sin(a) * 8 * s;
          const r = (9 + hash(k + 3) * 9) * s;
          ctx.fillStyle = Math.sin(a) > 0 ? col('cloudShade', 0.95) : col('cloudBase', 0.8);
          ctx.beginPath();
          ctx.moveTo(fx - r, fy);
          ctx.lineTo(fx - r * 0.2, fy - r * 0.6);
          ctx.lineTo(fx + r, fy - r * 0.2);
          ctx.lineTo(fx + r * 0.3, fy + r * 0.5);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  function drawLightning(g, cam) {
    if (g.lightning <= 0 || !g.bolt) return;
    const a = g.lightning / 0.3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const path = () => {
      ctx.beginPath();
      g.bolt.forEach(([x, y], i) => (i ? ctx.lineTo(x - cam, y) : ctx.moveTo(x - cam, y)));
    };
    path(); ctx.strokeStyle = `rgba(255,226,90,${0.7 * a})`; ctx.lineWidth = 8; ctx.stroke();
    path(); ctx.strokeStyle = `rgba(255,255,240,${a})`; ctx.lineWidth = 3; ctx.stroke();
  }

  function drawTornado(T, cam) {
    const sx = T.x - cam;
    if (sx < -700 || sx > W + 700) return;
    const reach = tornadoReach(T);
    const N = 32;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const f = funnelAt(T, (i / N) * reach, game.t);
      pts.push({ cx: T.x + f.xo - cam, y: f.y, w: f.w });
    }
    const top = CLOUD_BASE - 20;
    const band = (from, to) => {
      // A strip of the funnel between two fractions of its width (-0.5..0.5).
      ctx.beginPath();
      ctx.moveTo(pts[0].cx + pts[0].w * from, top);
      for (const p of pts) ctx.lineTo(p.cx + p.w * from, p.y);
      const last = pts[pts.length - 1];
      ctx.quadraticCurveTo(last.cx + last.w * (from + to) / 2, last.y + 5, last.cx + last.w * to, last.y);
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].cx + pts[i].w * to, pts[i].y);
      ctx.lineTo(pts[0].cx + pts[0].w * to, top);
      ctx.closePath();
    };

    ctx.save();
    ctx.globalAlpha = T.alpha;
    // Body with a soft outline
    band(-0.5, 0.5);
    ctx.fillStyle = col('funnel');
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = col('funnelShade', 0.9);
    ctx.stroke();
    // Shaded left side and sunlit right side make it look round.
    band(-0.5, -0.22); ctx.fillStyle = col('funnelShade', 0.55); ctx.fill();
    band(0.08, 0.34); ctx.fillStyle = col('funnelLight', 0.45); ctx.fill();
    band(0.16, 0.26); ctx.fillStyle = col('funnelLight', 0.35); ctx.fill();

    // Swirl bands spiralling down the funnel
    ctx.strokeStyle = col('funnelLight', 0.6);
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.5;
    for (let k = 0; k < 7; k++) {
      const t = ((k / 7 + game.t * 0.35) % 1);
      const idx = Math.min(N, Math.round(t * N));
      const p = pts[idx];
      if (!p || p.w < 6) continue;
      ctx.beginPath();
      ctx.ellipse(p.cx, p.y, p.w * 0.46, 2 + p.w * 0.06, -0.08, 0.15, Math.PI - 0.6);
      ctx.stroke();
    }

    // Debris cloud at the base
    if (tornadoOnGround(T)) {
      for (const d of game.dust) {
        const px = d.x - cam + Math.cos(d.a) * d.r;
        ctx.globalAlpha = clamp(d.life / d.max, 0, 1) * 0.8 * T.alpha;
        puff(px, d.y, 6 + d.r * 0.3, rgb(mix([236, 214, 172], [190, 150, 150], dusk)),
          rgb(mix([196, 160, 116], [150, 112, 112], dusk)), rgb(mix([150, 112, 82], [110, 80, 90], dusk)));
      }
    }
    ctx.restore();
  }

  function drawPoles(cam) {
    const poleSpacing = 260;
    const firstPole = Math.floor((cam - 40) / poleSpacing) * poleSpacing;
    const tops = [];
    for (let wx = firstPole; wx < cam + W + 300; wx += poleSpacing) tops.push(wx - cam);
    ctx.strokeStyle = 'rgba(60,46,60,0.75)';
    ctx.lineWidth = 2.5;
    for (let i = 0; i < tops.length - 1; i++) {
      for (const off of [-10, 10]) {
        const ax = tops[i] + off, bx = tops[i + 1] + off;
        ctx.beginPath();
        ctx.moveTo(ax, ROAD_Y - 106);
        ctx.quadraticCurveTo((ax + bx) / 2, ROAD_Y - 90, bx, ROAD_Y - 106);
        ctx.stroke();
      }
    }
    for (const sx of tops) {
      ctx.fillStyle = col('pole');
      ctx.fillRect(sx - 2.5, ROAD_Y - 118, 5, 112);
      ctx.fillRect(sx - 14, ROAD_Y - 109, 28, 4);
      ctx.fillStyle = col('poleLight');
      ctx.fillRect(sx + 0.5, ROAD_Y - 118, 1.5, 112);
      ctx.fillStyle = 'rgba(230,240,255,0.9)';
      for (const off of [-10, 10]) { ctx.beginPath(); ctx.arc(sx + off, ROAD_Y - 107, 2, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  function drawRoad(cam) {
    ctx.fillStyle = col('road');
    ctx.fillRect(-20, ROAD_Y - 8, W + 40, 40);
    ctx.fillStyle = col('roadEdge');
    ctx.fillRect(-20, ROAD_Y - 8, W + 40, 3);
    ctx.strokeStyle = 'rgba(255,244,196,0.95)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    const dash = 46, gap = 54, period = dash + gap;
    const off = ((cam % period) + period) % period;
    ctx.beginPath();
    for (let x = -off - 20; x < W + 20; x += period) { ctx.moveTo(x, ROAD_Y + 12); ctx.lineTo(x + dash, ROAD_Y + 12); }
    ctx.stroke();

    const vg = ctx.createLinearGradient(0, ROAD_Y + 32, 0, H);
    vg.addColorStop(0, col('verge'));
    vg.addColorStop(1, col('vergeDark'));
    ctx.fillStyle = vg;
    ctx.fillRect(-20, ROAD_Y + 32, W + 40, H - ROAD_Y);

    // Grass tufts and tiny flowers on the verge
    const step = 34;
    const first = Math.floor((cam - 40) / step);
    ctx.strokeStyle = col('vergeDark');
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = first; i < first + W / step + 3; i++) {
      const x = i * step + hash(i + 400) * 20 - cam;
      const y = ROAD_Y + 46 + hash(i + 500) * 36;
      ctx.moveTo(x - 4, y); ctx.lineTo(x - 6, y - 7);
      ctx.moveTo(x, y); ctx.lineTo(x, y - 9);
      ctx.moveTo(x + 4, y); ctx.lineTo(x + 6, y - 7);
    }
    ctx.stroke();
    for (let i = first; i < first + W / step + 3; i++) {
      if (hash(i + 700) < 0.6) continue;
      const x = i * step + hash(i + 800) * 30 - cam;
      const y = ROAD_Y + 42 + hash(i + 900) * 40;
      ctx.fillStyle = hash(i + 1000) > 0.5 ? 'rgba(255,255,255,0.95)' : 'rgba(255,170,200,0.95)';
      for (let p = 0; p < 4; p++) {
        ctx.beginPath(); ctx.arc(x + Math.cos(p * 1.57) * 2.2, y + Math.sin(p * 1.57) * 2.2, 1.8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#ffd34d';
      ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawCar(c, cam) {
    const up = game.up;
    const feral = isFeral();
    const lift = up.tires ? 7 : 0;
    const wr = up.tires ? 11 : 8;          // wheel radius
    const wy = up.tires ? -wr + 1 : -6;    // wheel centre
    const sx = c.x - cam;
    const y = ROAD_Y;
    const t = game.t;

    // Soft shadow
    ctx.fillStyle = 'rgba(40,30,60,0.28)';
    ctx.beginPath(); ctx.ellipse(sx, y + 1, feral ? 46 : 38, 4.5, 0, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(sx, y);
    ctx.scale(c.dir, 1);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const hurt = c.hurt > 0 && Math.floor(c.hurt * 30) % 2;

    // Exhaust stacks with flames (fully kitted only), behind the body.
    if (feral) {
      for (const [px, top] of [[-31, -58], [-26, -54]]) {
        ctx.fillStyle = '#5b5866';
        ctx.fillRect(px - 2.5, top - lift, 5, 46);
        ctx.fillStyle = '#9d9aa8';
        ctx.fillRect(px - 2.5, top - lift, 1.5, 46);
        const fl = 8 + Math.random() * 10;
        ctx.fillStyle = '#ff8a2a';
        ctx.beginPath(); ctx.moveTo(px - 4, top - lift); ctx.lineTo(px - 1, top - lift - fl); ctx.lineTo(px + 4, top - lift); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffe36b';
        ctx.beginPath(); ctx.moveTo(px - 2, top - lift); ctx.lineTo(px, top - lift - fl * 0.55); ctx.lineTo(px + 2, top - lift); ctx.closePath(); ctx.fill();
      }
    }

    // Smoke trailing back from the stacks
    if (feral) {
      for (let k = 0; k < 5; k++) {
        const age = (t * 1.6 + k / 5) % 1;
        ctx.fillStyle = `rgba(70,64,74,${0.45 * (1 - age)})`;
        ctx.beginPath(); ctx.arc(-30 - age * 34, -62 - lift - age * 16, 3 + age * 7, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Lift-kit struts
    if (lift) {
      ctx.strokeStyle = '#3a3842';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (const wx of [-21, 22]) { ctx.moveTo(wx - 3, wy); ctx.lineTo(wx - 5, -13 - lift + 4); ctx.moveTo(wx + 3, wy); ctx.lineTo(wx + 5, -13 - lift + 4); }
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(0, -lift);

    // Body: early-2000s Pontiac Vibe silhouette (front faces +x).
    const body = () => {
      ctx.beginPath();
      ctx.moveTo(-34, -9);
      ctx.lineTo(-34, -22);
      ctx.quadraticCurveTo(-34, -33, -31, -35);
      ctx.quadraticCurveTo(-29, -37, -25, -37);
      ctx.lineTo(4, -37);
      ctx.quadraticCurveTo(8, -37, 10, -34);
      ctx.lineTo(20, -24);
      ctx.quadraticCurveTo(22, -22.5, 25, -22);
      ctx.lineTo(32, -20);
      ctx.quadraticCurveTo(36, -18, 35.5, -12);
      ctx.lineTo(35, -9);
      ctx.closePath();
    };
    const paint = ctx.createLinearGradient(0, -37, 0, -9);
    if (hurt) { paint.addColorStop(0, '#ffffff'); paint.addColorStop(1, '#ffffff'); }
    else if (feral) { paint.addColorStop(0, '#d8564a'); paint.addColorStop(0.45, '#a8281f'); paint.addColorStop(1, '#6c1814'); }
    else { paint.addColorStop(0, '#ff6a5a'); paint.addColorStop(0.45, '#e8281f'); paint.addColorStop(1, '#a9121a'); }
    body();
    ctx.fillStyle = paint;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#5a0a10';
    ctx.stroke();

    // Rust and weld scars once it has gone feral
    if (feral && !hurt) {
      ctx.save();
      body();
      ctx.clip();
      ctx.fillStyle = 'rgba(132,70,30,0.6)';
      for (const [rx, ry, r] of [[-26, -15, 5], [-4, -12, 4], [12, -16, 3.5], [28, -14, 3], [-15, -27, 2.5]]) {
        ctx.beginPath(); ctx.ellipse(rx, ry, r * 1.4, r, 0.3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(210,200,190,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-34, -18); ctx.lineTo(35, -18); ctx.stroke();
      ctx.restore();
    }

    // Riveted armor plates welded over the doors
    if (feral) {
      for (const [ax, aw] of [[-22, 13], [-7, 23]]) {
        ctx.fillStyle = '#6e6c7a';
        ctx.fillRect(ax, -22, aw, 9);
        ctx.fillStyle = '#9d9aa8';
        ctx.fillRect(ax, -22, aw, 1.5);
        ctx.strokeStyle = '#2a2830'; ctx.lineWidth = 1.2;
        ctx.strokeRect(ax, -22, aw, 9);
        ctx.fillStyle = '#2a2830';
        for (let rx = ax + 2; rx < ax + aw - 1; rx += 4) { ctx.fillRect(rx, -20.5, 1.3, 1.3); ctx.fillRect(rx, -15.5, 1.3, 1.3); }
      }
    }

    // Rear spoiler lip
    ctx.fillStyle = hurt ? '#ffffff' : feral ? '#8e2a22' : '#c81b1d';
    ctx.beginPath();
    ctx.moveTo(-27, -37); ctx.lineTo(-37, -38.5); ctx.lineTo(-35.5, -35); ctx.lineTo(-29, -35);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#5a0a10'; ctx.lineWidth = 1; ctx.stroke();

    // Black lower cladding
    ctx.fillStyle = '#33313b';
    pill(-35, -14, 71, 6);
    ctx.fill();

    // Windows with a glassy reflection
    const windows = () => {
      ctx.beginPath();
      ctx.moveTo(-31, -24); ctx.lineTo(-29.5, -33); ctx.lineTo(-23, -33); ctx.lineTo(-23, -24); ctx.closePath();
      ctx.rect(-21, -33, 12, 9);
      ctx.moveTo(-7, -24); ctx.lineTo(-7, -33); ctx.lineTo(6, -33); ctx.lineTo(16, -24); ctx.closePath();
    };
    const glass = ctx.createLinearGradient(0, -33, 0, -24);
    glass.addColorStop(0, '#5d7aa3');
    glass.addColorStop(1, '#2c3a58');
    windows();
    ctx.fillStyle = glass;
    ctx.fill();
    ctx.save();
    windows();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const x0 of [-28, -16, -2, 8]) {
      ctx.beginPath(); ctx.moveTo(x0, -24); ctx.lineTo(x0 + 6, -33); ctx.lineTo(x0 + 9, -33); ctx.lineTo(x0 + 3, -24); ctx.closePath(); ctx.fill();
    }
    // Reinforcement netting
    if (up.nets) {
      ctx.strokeStyle = '#1e1c24';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let k = -50; k < 40; k += 4.5) { ctx.moveTo(k, -22); ctx.lineTo(k + 12, -35); ctx.moveTo(k, -35); ctx.lineTo(k + 12, -22); }
      ctx.stroke();
    }
    ctx.restore();
    if (up.nets) {
      ctx.strokeStyle = '#1e1c24';
      ctx.lineWidth = 1.6;
      windows();
      ctx.stroke();
    }

    // Glossy highlights along the roof and shoulder
    ctx.strokeStyle = feral ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-24, -35.5); ctx.lineTo(3, -35.5); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath(); ctx.moveTo(-31, -21); ctx.lineTo(26, -20); ctx.stroke();

    // Door seams and handles
    ctx.strokeStyle = 'rgba(90,10,16,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-8, -24); ctx.lineTo(-8, -14); ctx.moveTo(17, -23); ctx.lineTo(17, -14); ctx.stroke();
    ctx.fillStyle = '#33313b';
    ctx.fillRect(-14, -21.5, 4, 1.6);
    ctx.fillRect(9, -21.5, 4, 1.6);

    // Roof: steel sheeting, or the stock roof rails
    let roofTop = -39.5;
    if (up.roof) {
      ctx.fillStyle = '#2a2830';
      ctx.fillRect(-33, -45, 44, 9);
      const steel = ctx.createLinearGradient(0, -44, 0, -37);
      steel.addColorStop(0, '#d9d8e2');
      steel.addColorStop(1, '#7f7d8c');
      ctx.fillStyle = steel;
      ctx.fillRect(-32, -44, 42, 7);
      ctx.fillStyle = '#4a4856';
      for (let rx = -29; rx <= 8; rx += 6) { ctx.fillRect(rx, -42, 1.6, 1.6); ctx.fillRect(rx, -39, 1.6, 1.6); }
      ctx.strokeStyle = 'rgba(60,58,70,0.6)';
      ctx.beginPath(); ctx.moveTo(-17, -44); ctx.lineTo(-17, -37); ctx.moveTo(-3, -44); ctx.lineTo(-3, -37); ctx.stroke();
      roofTop = -45;
    } else {
      ctx.strokeStyle = '#2a2830';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-26, -39.5); ctx.lineTo(4, -39.5); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-24, -39.5); ctx.lineTo(-24, -37); ctx.moveTo(2, -39.5); ctx.lineTo(2, -37); ctx.stroke();
    }

    // Welded roll cage with spotlights and jerry cans
    if (feral) {
      const ct = roofTop - 13;
      ctx.fillStyle = '#4d6b3a';
      ctx.fillRect(-33, ct + 3, 7, 10);
      ctx.fillStyle = '#a83a2a';
      ctx.fillRect(-25, ct + 4, 6, 9);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(-32, ct + 4, 2, 8);
      ctx.strokeStyle = '#2e2c36';
      ctx.lineWidth = 2.6;
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      ctx.moveTo(-34, roofTop); ctx.lineTo(-32, ct); ctx.lineTo(12, ct); ctx.lineTo(16, roofTop + 4);
      ctx.moveTo(-10, ct); ctx.lineTo(-10, roofTop);
      ctx.moveTo(-32, ct); ctx.lineTo(-10, roofTop);
      ctx.moveTo(-10, ct); ctx.lineTo(12, roofTop);
      ctx.stroke();
      ctx.lineJoin = 'round';
      for (const lx of [2, 10]) {
        const beam2 = ctx.createRadialGradient(lx + 2, ct - 3, 1, lx + 2, ct - 3, 12);
        beam2.addColorStop(0, 'rgba(255,240,170,0.7)');
        beam2.addColorStop(1, 'rgba(255,240,170,0)');
        ctx.fillStyle = beam2;
        ctx.fillRect(lx - 10, ct - 15, 24, 24);
        ctx.fillStyle = '#2e2c36';
        ctx.beginPath(); ctx.arc(lx, ct - 3, 3.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff4c0';
        ctx.beginPath(); ctx.arc(lx + 0.8, ct - 3, 2.2, 0, Math.PI * 2); ctx.fill();
      }
      roofTop = ct;
    }

    // Chase antenna (flying a tattered flag once feral)
    ctx.strokeStyle = '#2a2830';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-18, roofTop + 2); ctx.lineTo(-24, roofTop - 15); ctx.stroke();
    if (feral) {
      const wv = Math.sin(t * 9) * 2;
      ctx.fillStyle = '#c0281f';
      ctx.beginPath();
      ctx.moveTo(-24, roofTop - 15); ctx.lineTo(-38, roofTop - 14 + wv); ctx.lineTo(-33, roofTop - 11 + wv * 0.5);
      ctx.lineTo(-39, roofTop - 8 + wv); ctx.lineTo(-23, roofTop - 9);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = '#ff4a3d';
      ctx.beginPath(); ctx.arc(-24, roofTop - 15, 1.8, 0, Math.PI * 2); ctx.fill();
    }

    // Spinning radar dish
    if (up.radar) {
      const rx = -4, ry = roofTop - 8;
      ctx.fillStyle = '#4a4856';
      ctx.fillRect(rx - 1, ry, 2.5, 8);
      const spin = Math.cos(t * 5);
      ctx.fillStyle = spin > 0 ? '#f2f1f7' : '#b4b2c2';
      ctx.strokeStyle = '#3a3842';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.ellipse(rx, ry, Math.max(1.5, 9 * Math.abs(spin)), 3.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (Math.floor(t * 3) % 2) { ctx.fillStyle = '#7dff8a'; ctx.beginPath(); ctx.arc(rx, ry - 4, 1.6, 0, Math.PI * 2); ctx.fill(); }
    }

    // Lights
    ctx.fillStyle = '#ff9a86';
    pill(-35, -31, 3, 10); ctx.fill();
    const beam = ctx.createRadialGradient(34, -17, 1, 34, -17, 14);
    beam.addColorStop(0, 'rgba(255,246,200,0.8)');
    beam.addColorStop(1, 'rgba(255,246,200,0)');
    ctx.fillStyle = beam;
    ctx.fillRect(20, -31, 28, 28);
    ctx.fillStyle = '#fff6cc';
    ctx.beginPath(); ctx.moveTo(27, -20.5); ctx.lineTo(34, -18.5); ctx.lineTo(34.5, -15); ctx.lineTo(28, -16.5); ctx.closePath(); ctx.fill();

    // Fully kitted: supercharger through the hood, slatted plow with long
    // spikes, a spare on the hatch and a dragging chain.
    if (feral) {
      // Blower
      ctx.fillStyle = '#2e2c36';
      ctx.fillRect(19, -31, 11, 10);
      ctx.fillStyle = '#b8b6c4';
      ctx.fillRect(17, -36, 15, 5);
      ctx.fillStyle = '#e8e6f0';
      ctx.fillRect(17, -36, 15, 1.5);
      ctx.fillStyle = '#2e2c36';
      for (let k = 0; k < 3; k++) ctx.fillRect(19 + k * 4.5, -35, 2, 3);
      ctx.strokeStyle = '#6d6a7c'; ctx.lineWidth = 1.2;
      const belt = (t * 30) % 4;
      ctx.beginPath();
      for (let by = -30 + belt; by < -21; by += 4) { ctx.moveTo(20, by); ctx.lineTo(29, by); }
      ctx.stroke();
      // Plow
      ctx.strokeStyle = '#3a3842'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(34, -20); ctx.lineTo(42, -20); ctx.lineTo(50, lift - 2);
      for (let k = 0; k < 4; k++) { ctx.moveTo(35, -16 + k * 4.5); ctx.lineTo(44 + k * 2, -16 + k * 4.5); }
      ctx.stroke();
      ctx.fillStyle = '#d6d4de';
      for (const sy of [-19, -12]) {
        ctx.beginPath(); ctx.moveTo(42, sy - 1.5); ctx.lineTo(58, sy + 1); ctx.lineTo(42, sy + 3.5); ctx.closePath(); ctx.fill();
      }
      // Spare on the hatch
      ctx.fillStyle = '#26242c';
      ctx.beginPath(); ctx.arc(-37, -23, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8f8c9c';
      ctx.beginPath(); ctx.arc(-37, -23, 3, 0, Math.PI * 2); ctx.fill();
      // Chain swinging from the rear bumper
      ctx.fillStyle = '#8f8c9c';
      for (let k = 0; k < 6; k++) {
        const sw = Math.sin(t * 6 + k * 0.4) * k * 0.8;
        ctx.fillRect(-35 - k * 2.2 + sw * 0.3, -11 + k * 1.6, 2, 2);
      }
    }
    ctx.restore(); // end lift

    // Wheels with shiny hubcaps (knobby off-road tyres once upgraded)
    for (const wx of [-21, 22]) {
      const a = c.wheel * c.dir;
      ctx.fillStyle = '#26242c';
      ctx.beginPath(); ctx.arc(wx, wy, wr, 0, Math.PI * 2); ctx.fill();
      if (feral) {
        ctx.fillStyle = '#d6d4de';
        for (let k = 0; k < 6; k++) {
          const ang = a + k * 1.047 + 0.3;
          const ox = wx + Math.cos(ang) * (wr + 1), oy = wy + Math.sin(ang) * (wr + 1);
          ctx.beginPath();
          ctx.moveTo(ox + Math.cos(ang) * 4, oy + Math.sin(ang) * 4);
          ctx.lineTo(ox + Math.cos(ang + 1.6) * 2, oy + Math.sin(ang + 1.6) * 2);
          ctx.lineTo(ox + Math.cos(ang - 1.6) * 2, oy + Math.sin(ang - 1.6) * 2);
          ctx.closePath(); ctx.fill();
        }
      }
      if (up.tires) {
        ctx.fillStyle = '#3c3a44';
        for (let k = 0; k < 10; k++) {
          const ang = a + k * 0.628;
          ctx.save();
          ctx.translate(wx + Math.cos(ang) * wr, wy + Math.sin(ang) * wr);
          ctx.rotate(ang);
          ctx.fillRect(-1.5, -2, 3, 4);
          ctx.restore();
        }
      }
      const hr = wr * 0.56;
      const hub = ctx.createRadialGradient(wx - 1.5, wy - 1.5, 0.5, wx, wy, hr);
      hub.addColorStop(0, '#ffffff');
      hub.addColorStop(1, feral ? '#8a7a6c' : '#a9a6b8');
      ctx.fillStyle = hub;
      ctx.beginPath(); ctx.arc(wx, wy, hr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#6d6a7c';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const ang = a + k * 2.094;
        ctx.moveTo(wx, wy); ctx.lineTo(wx + Math.cos(ang) * hr * 0.9, wy + Math.sin(ang) * hr * 0.9);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // A floating, glowing upgrade on the road.
  function drawPickup(g, cam) {
    const p = g.pickup;
    if (!p) return;
    const sx = p.x - cam;
    if (sx < -60 || sx > W + 60) return;
    const y = ROAD_Y - 40 + Math.sin(g.t * 3) * 5;
    drawPickupAt(p.kind, sx, y);
  }

  function drawPickupAt(kind, sx, y) {
    const glow = ctx.createRadialGradient(sx, y, 4, sx, y, 40);
    glow.addColorStop(0, 'rgba(255,230,120,0.75)');
    glow.addColorStop(1, 'rgba(255,230,120,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sx - 40, y - 40, 80, 80);
    ctx.fillStyle = '#fffbe8';
    ctx.strokeStyle = '#3a2a10';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, y, 19, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.save();
    ctx.translate(sx, y);
    ctx.lineWidth = 2.5;
    if (kind === 'nets') {
      ctx.strokeStyle = '#2a2830';
      ctx.strokeRect(-10, -8, 20, 16);
      ctx.save(); ctx.beginPath(); ctx.rect(-10, -8, 20, 16); ctx.clip();
      ctx.beginPath();
      for (let k = -18; k <= 10; k += 6) { ctx.moveTo(k, 8); ctx.lineTo(k + 8, -8); ctx.moveTo(k, -8); ctx.lineTo(k + 8, 8); }
      ctx.stroke(); ctx.restore();
    } else if (kind === 'roof') {
      ctx.fillStyle = '#9c9aa8';
      ctx.fillRect(-12, -6, 24, 12);
      ctx.strokeStyle = '#3a3842';
      ctx.strokeRect(-12, -6, 24, 12);
      ctx.fillStyle = '#3a3842';
      for (const rx of [-8, 0, 8]) { ctx.fillRect(rx - 1.5, -3, 3, 3); }
    } else if (kind === 'tires') {
      ctx.fillStyle = '#26242c';
      ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c9c6d4';
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    } else if (kind === 'radar') {
      ctx.strokeStyle = '#2a8a3a';
      ctx.beginPath(); ctx.arc(0, 2, 10, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 2, 5, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      ctx.fillStyle = '#2a8a3a';
      ctx.fillRect(-1.5, 2, 3, 9);
    }
    ctx.restore();
  }

  function drawHail(g, cam) {
    for (const h of g.hail) {
      const sx = h.x - cam;
      if (sx < -10 || sx > W + 10) continue;
      puff(sx, h.y, 3, '#ffffff', '#eef3ff', '#a9b8de');
    }
  }

  function drawDebris(g, cam) {
    for (const p of g.debris) {
      const sx = p.x - cam;
      if (sx < -30 || sx > W + 30) continue;
      ctx.save();
      ctx.translate(sx, p.y);
      drawDebrisPiece(p, g.t);
      ctx.restore();
    }
  }

  // One piece of flying debris (a board or a very surprised cow) at the origin.
  function drawDebrisPiece(p, t) {
    if (p.cow) {
      // A very surprised cow.
      ctx.rotate(p.rot * 0.35);
      ctx.strokeStyle = '#3a3440';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const lx of [-6, -2, 3, 7]) { ctx.moveTo(lx, 3); ctx.lineTo(lx + Math.sin(t * 20 + lx) * 2, 9); }
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.ellipse(0, 0, 10, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#3a3440';
      ctx.beginPath(); ctx.arc(-4, -1, 2.6, 0, Math.PI * 2); ctx.arc(4, 2, 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(11, -4, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffb3c1';
      ctx.beginPath(); ctx.ellipse(14, -3, 2, 1.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3a3440';
      ctx.beginPath(); ctx.arc(11, -5.5, 0.9, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.rotate(p.rot);
      ctx.fillStyle = '#9a6a44';
      pill(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,220,170,0.6)';
      ctx.fillRect(-p.w / 2 + 1, -p.h / 2, p.w - 2, 1);
    }
  }

  // ---------------------------------------------------------------- HUD (screen pixels)
  const FONT = '"Press Start 2P", monospace';
  const SHADOW = '#1c1430';
  function text(str, x, y, { size = 8, align = 'left', color = '#ffffff', alpha = 1, outline = false } = {}) {
    ctx.font = `${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = SHADOW;
    if (outline) {
      for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1], [2, 2], [1, 2], [2, 1]]) ctx.fillText(str, x + dx, y + dy);
    } else {
      ctx.fillText(str, x + 1, y + 1);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    const g = game;
    text(`FILM ${g.film}/${FILM}`, 6, 6);
    text(`SCORE ${g.score}`, 6, 18, { color: '#ffe680' });
    const kit = Object.keys(UPGRADES).filter((k) => g.up[k]).map((k) => UPGRADES[k].label).join(' ');
    if (isFeral()) text('KIT: FERAL', 6, 30, { color: '#ff7a3d' });
    else if (kit) text(`KIT: ${kit}`, 6, 30, { color: '#9fe0ff' });
    const left = Math.max(0, DAY_LENGTH - g.t);
    const m = Math.floor(left / 60), s = Math.floor(left % 60);
    text(`SUNSET ${m}:${String(s).padStart(2, '0')}`, SW - 6, 6, { align: 'right' });

    if (state === 'dialog') return;

    // Car health (top right on touch screens and in the windshield view)
    const topRow = TOUCH || g.mode === 'drive';
    const hy = topRow ? 18 : SH - 13, hx = topRow ? SW - 96 : 6;
    text('CAR', hx, hy);
    ctx.fillStyle = SHADOW;
    ctx.fillRect(hx + 27, hy - 1, 62, 10);
    ctx.fillStyle = '#4a3a66';
    ctx.fillRect(hx + 28, hy, 60, 8);
    if (g.car.hp > 0) {
      const w = Math.max(1, Math.round(60 * g.car.hp / 100));
      ctx.fillStyle = g.car.hp > 30 ? '#5cbf62' : '#e8281f';
      ctx.fillRect(hx + 28, hy, w, 8);
      ctx.fillStyle = g.car.hp > 30 ? '#b8f0a0' : '#ff9a8a';
      ctx.fillRect(hx + 28, hy, w, 2);
    }
    const ry = topRow ? 30 : SH - 13;

    if (g.up.radar && g.mode !== 'drive') drawRadar(g);

    // Off-screen pickup marker
    if (g.pickup && g.mode !== 'drive') {
      const zx = screenXOf(g.pickup.x);
      if (zx < 0 || zx > W) {
        const isLeft = zx < 0;
        ctx.fillStyle = SHADOW;
        tri((isLeft ? 4 : SW - 4) + 1, 151, isLeft);
        ctx.fillStyle = '#ffe680';
        tri(isLeft ? 4 : SW - 4, 150, isLeft);
      }
    }

    const T = g.tor;
    if (T && T.alpha > 0.2) {
      const dMi = tornadoMiles(T);
      text(`RANGE ${dMi.toFixed(1)}MI`, SW - 6, ry, { align: 'right' });
      const zx = tornadoZX(T);
      if (zx < 0 || zx > W) {
        const isLeft = zx < 0;
        const ax = isLeft ? 4 : SW - 4, ay = 96;
        ctx.fillStyle = SHADOW;
        tri(ax + 1, ay + 1, isLeft);
        ctx.fillStyle = '#ff4a3d';
        tri(ax, ay, isLeft);
        text(`${dMi.toFixed(1)}`, ax + (isLeft ? 2 : -2), ay + 10, { align: isLeft ? 'left' : 'right' });
      }
    } else {
      text('SCANNING...', SW - 6, ry, { align: 'right' });
    }

    if (g.msgT > 0) {
      text(g.msg, SW / 2, 46, { align: 'center', alpha: Math.min(1, g.msgT * 2) });
    }
  }

  // A strip radar: +/- 2.5 miles either side of the car.
  function drawRadar(g) {
    const x0 = 128, w = 128, y0 = SH - 16, h = 12, cx = x0 + w / 2;
    const span = 1700;
    const toX = (wx) => cx + clamp((wx - g.car.x) / span, -1, 1) * (w / 2 - 2);
    ctx.fillStyle = SHADOW;
    ctx.fillRect(x0 - 1, y0 - 1, w + 2, h + 2);
    ctx.fillStyle = '#0d2a1c';
    ctx.fillRect(x0, y0, w, h);
    const T = g.tor;
    if (T && T.alpha > 0.1) {
      const [a, b] = coreRange(T);
      const ca = toX(a), cb = toX(b);
      ctx.fillStyle = 'rgba(110,160,255,0.55)';
      ctx.fillRect(Math.round(ca), y0 + 2, Math.max(1, Math.round(cb - ca)), h - 4);
      if (Math.floor(g.t * 4) % 2 || T.phase !== 'forming') {
        const tx = Math.round(toX(tornadoGroundX(T)));
        ctx.fillStyle = '#ff4a3d';
        ctx.fillRect(tx - 1, y0 + 1, 3 + Math.min(2, T.ef >> 1), h - 2);
      }
    }
    if (g.pickup) {
      ctx.fillStyle = '#ffe680';
      ctx.fillRect(Math.round(toX(g.pickup.x)) - 1, y0 + 4, 3, 4);
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(cx - 1, y0 + 3, 2, h - 6);
    const sweep = x0 + ((g.t * 60) % w);
    ctx.fillStyle = 'rgba(125,255,138,0.6)';
    ctx.fillRect(Math.round(sweep), y0, 1, h);
  }

  function tri(x, y, pointLeft) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (pointLeft ? 7 : -7), y - 6);
    ctx.lineTo(x + (pointLeft ? 7 : -7), y + 6);
    ctx.closePath();
    ctx.fill();
  }

  function drawViewfinder(g) {
    const a = clamp((g.zoom - 1) * 2, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, SW, 12);
    ctx.fillRect(0, SH - 12, SW, 12);
    ctx.fillStyle = '#ffffff';
    const i = 22, L = 14;
    for (const [x, y, sx, sy] of [[i, i, 1, 1], [SW - i, i, -1, 1], [i, SH - i, 1, -1], [SW - i, SH - i, -1, -1]]) {
      ctx.fillRect(sx > 0 ? x : x - L, y - (sy > 0 ? 0 : 1), L, 1);
      ctx.fillRect(x - (sx > 0 ? 0 : 1), sy > 0 ? y : y - L, 1, L);
    }
    const cy = Math.round(ZOOM_Y * PX);
    ctx.fillRect(SW / 2 - 6, cy, 4, 1); ctx.fillRect(SW / 2 + 3, cy, 4, 1);
    ctx.fillRect(SW / 2, cy - 6, 1, 4); ctx.fillRect(SW / 2, cy + 3, 1, 4);
    ctx.globalAlpha = 1;
    text(`ZOOM ${g.zoom.toFixed(1)}X`, SW / 2, SH - 34, { align: 'center', alpha: a, color: '#ffe680' });
  }

  function drawPanel(x, y, w, h) {
    ctx.fillStyle = SHADOW;
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#b8b0d8';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    const bg = ctx.createLinearGradient(0, y + 3, 0, y + h - 3);
    bg.addColorStop(0, '#2a3aa0');
    bg.addColorStop(1, '#141a5a');
    ctx.fillStyle = bg;
    ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
  }

  function drawDialog(d) {
    const x = 10, y = SH - 78, w = SW - 20, h = 70;
    drawPanel(x, y, w, h);
    // Name plate
    ctx.font = `8px ${FONT}`;
    const nw = Math.ceil(ctx.measureText(d.quote.who).width) + 14;
    drawPanel(x + 6, y - 15, nw, 15);
    text(d.quote.who, x + 13, y - 10, { color: '#ffe680' });
    // Typewritten lines
    const lines = d.pages[d.page];
    let left = Math.floor(d.shown);
    lines.forEach((line, i) => {
      if (left <= 0) return;
      const part = line.slice(0, left);
      left -= line.length;
      const isSource = line.startsWith('- ');
      text(part, x + 10, y + 10 + i * 13, { color: isSource ? '#b8b0d8' : '#ffffff' });
    });
    if (d.shown >= pageLength(d) && Math.floor(performance.now() / 300) % 2) {
      ctx.fillStyle = '#ffe680';
      ctx.beginPath();
      ctx.moveTo(x + w - 16, y + h - 13); ctx.lineTo(x + w - 8, y + h - 13); ctx.lineTo(x + w - 12, y + h - 8);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawCenter(title, sub) {
    ctx.fillStyle = 'rgba(28,20,48,0.55)';
    ctx.fillRect(0, 0, SW, SH);
    text(title, SW / 2, SH / 2 - 14, { align: 'center', color: '#ffe680', outline: true });
    text(sub, SW / 2, SH / 2 + 6, { align: 'center' });
  }

  function drawTitle() {
    ctx.fillStyle = 'rgba(28,20,48,0.2)';
    ctx.fillRect(0, 0, SW, SH);
    text('A DINNER DATE', SW / 2, 40, { size: 16, align: 'center', color: '#ffffff', outline: true });
    text('WITH THE SUBLIME', SW / 2, 62, { size: 16, align: 'center', color: '#ff4a3d', outline: true });
    text('Drive close. Take the picture.', SW / 2, 90, { align: 'center' });
    text('Get out alive.', SW / 2, 102, { align: 'center' });
    // View picker
    for (const [mode, label, cx] of [['side', 'SIDE VIEW', SW / 2 - 76], ['drive', 'WINDSHIELD', SW / 2 + 76]]) {
      const on = selMode === mode;
      if (on) drawPanel(cx - 62, 126, 124, 22);
      else { ctx.fillStyle = 'rgba(28,20,48,0.45)'; ctx.fillRect(cx - 62, 126, 124, 22); }
      text(label, cx, 133, { align: 'center', color: on ? '#ffe680' : '#b8b0d8' });
    }
    const blink = Math.floor(performance.now() / 500) % 2;
    if (TOUCH) { if (blink) text('TAP A VIEW TO START', SW / 2, 158, { align: 'center', color: '#ffe680' }); }
    else {
      text('< > CHOOSE A VIEW', SW / 2, 156, { align: 'center' });
      if (blink) text('PRESS SPACE TO START', SW / 2, 168, { align: 'center', color: '#ffe680' });
    }
    if (best > 0) text(`BEST ${best}`, SW / 2, 184, { align: 'center' });
  }


  // ================================================================ windshield
  // First-person mode: looking down a curving prairie road through the
  // windshield. The road is drawn as projected segments, and everything else
  // (tornadoes, cows, posts, debris) as sprites placed along it.
  // World units: x across the road (0 = centre line), z down the road.
  const SEG = 200;            // length of one road segment
  const DRAW = 220;           // segments drawn ahead
  const ROAD_W = 1500;        // half-width of the road
  const CAM_DEPTH = 0.84;     // ~100 degree field of view
  const NEAR = 260;
  const MI_PER_U = 1 / 25000;
  const DASH_Y = 446;         // top of the dashboard
  const drive = { base: 0, segX: new Float32Array(DRAW + 2), camH: 1000 };

  function curveAt(i) {
    return 3.2 * Math.sin(i * 0.0061) * Math.sin(i * 0.0023 + 1.3) + 1.1 * Math.sin(i * 0.017 + 2);
  }
  const driveMax = () => (game.up.tires ? 9000 : 7500);

  function spawnDriveTornado() {
    const g = game, side = Math.random() < 0.5 ? -1 : 1, ef = pickEF();
    g.tor = {
      x: side * rand(4000, 11000), z: g.dist + rand(15000, 25000),
      vx: 0, vz: 0, tvx: -side * rand(400, 1000), tvz: rand(-300, 300), retarget: rand(2, 4),
      ef, size: 0.75 + ef * 0.11, phase: 'forming', pt: 0, life: rand(10, 18),
      alpha: 0, rope: 0, lean: 0, seed: Math.random() * 100,
      core: Math.random() < 0.6 ? -1 : 1, // -1: the hail core sits between you and the tornado
    };
  }

  function driveTornadoMotion(T, dt) {
    const g = game;
    if (T.finale) {
      const dx = g.picnic.x - T.x, dz = g.picnic.z - T.z, d = Math.hypot(dx, dz) || 1;
      T.tvx = (dx / d) * 1500; T.tvz = (dz / d) * 1500;
    } else {
      T.retarget -= dt;
      if (T.retarget <= 0) {
        T.retarget = rand(2.5, 5);
        T.tvx = rand(-1, 1) * (500 + T.ef * 120);
        T.tvz = rand(-350, 250);
        // Sometimes it swings toward you.
        if (state === 'play' && Math.random() < 0.3) { T.tvx = Math.sign(g.lane - T.x) * (700 + T.ef * 100); T.tvz = -rand(200, 700); }
      }
    }
    T.vx += (T.tvx - T.vx) * Math.min(1, dt * 0.8);
    T.vz += (T.tvz - T.vz) * Math.min(1, dt * 0.8);
    T.x = clamp(T.x + T.vx * dt, -16000, 16000);
    T.z += T.vz * dt;
    T.lean += ((T.vx / 600) * 45 - T.lean) * Math.min(1, dt);
  }

  function driveCore(T) {
    const len = 7500 + T.ef * 1000;
    return T.core < 0 ? [T.z - 1500 - len, T.z - 1500] : [T.z + 1500, T.z + 1500 + len];
  }
  const driveMiles = (T) => Math.hypot(tornadoGroundX(T) - game.lane, T.z - game.dist) * MI_PER_U;

  function updateDrive(dt) {
    const g = game, c = g.car, playing = state === 'play';
    if (playing) g.t += dt;
    const maxV = driveMax();

    // Speed: cruise by default, gas to go faster, brake to slow and stop.
    let target = maxV * 0.72, rate = 2600;
    if (state === 'title') target = 3200;
    else if (state === 'sunset' || state === 'over') { target = 0; rate = 3500; }
    else if (playing) {
      if (keys.brake) { target = 0; rate = 7000; } else if (keys.gas) target = maxV;
    }
    g.speed += clamp(target - g.speed, -rate * dt, rate * dt);
    const pct = g.speed / maxV;
    const seg = Math.floor(g.dist / SEG);
    const curve = curveAt(seg);

    // Steering, with the road's curve pushing you outward.
    const steer = playing ? (keys.right ? 1 : 0) - (keys.left ? 1 : 0) : 0;
    g.steerVis += (steer * 0.5 - g.steerVis) * Math.min(1, dt * 6);
    if (state === 'title') g.lane *= 1 - Math.min(1, dt);
    else {
      g.lane += steer * dt * ROAD_W * 1.7 * Math.min(1, pct * 1.4 + 0.25);
      g.lane -= curve * pct * dt * ROAD_W * 0.09;
    }
    if (Math.abs(g.lane) > ROAD_W * 1.02 && g.speed > maxV * 0.35) {
      g.speed -= (g.speed - maxV * 0.35) * Math.min(1, dt * 2);
      g.shake = Math.max(g.shake, 1.5 * pct);
    }
    g.lane = clamp(g.lane, -ROAD_W * 1.25, ROAD_W * 1.25);
    g.dist += g.speed * dt;
    g.bgCam += curve * pct * dt * 420;
    c.hurt = Math.max(0, c.hurt - dt);

    // Viewfinder zoom pans toward the tornado on screen.
    const zt = playing && keys.zoom ? MAX_ZOOM : 1;
    g.zoom += clamp(zt - g.zoom, -dt * 4, dt * 2.2);
    let aimTarget = W / 2;
    if (g.tor && keys.zoom && g.torScreen && g.torScreen.x > -60 && g.torScreen.x < W + 60) aimTarget = clamp(g.torScreen.x, 120, W - 120);
    g.aimX += (aimTarget - g.aimX) * Math.min(1, dt * 2.5);
    if (playing && g.dialogDelay > 0) {
      g.dialogDelay -= dt;
      if (g.dialogDelay <= 0) openDialog(g.dialogQuote);
    }
    if (playing) updateDrivePickups(dt);

    // Tornado
    updateTornado(dt);
    let T = g.tor;
    if (T && T.z < g.dist - 300 && !T.finale) {
      g.tor = null; T = null;
      g.nextTor = rand(2, 4);
      if (playing) flashMsg('It\'s behind you now.');
    }

    // Rain and hail in the core
    g.rain = 0;
    if (T && T.alpha > 0.3) {
      const [a, b] = driveCore(T);
      const at = g.dist + 600;
      const inside = at > a && at < b && Math.abs(g.lane - T.x) < 14000;
      const edge = Math.min(Math.abs(at - a), Math.abs(at - b));
      g.rain = inside ? 1 : Math.max(0, 1 - edge / 4000) * 0.6;
      g.rain *= T.alpha;
      if (inside) {
        let n = 42 * dt;
        while (n > 0) { if (Math.random() < n) g.fpHail.push({ x: rand(-40, W + 40), y: rand(-20, 200), vy: rand(700, 1000), vx: rand(-80, 80) }); n -= 1; }
        if (playing) {
          damage(1.6 * dt * (g.up.nets ? 0.35 : 1), true);
          g.hailSound -= dt * 6;
          if (g.hailSound < 0) { sfx.hail(); g.hailSound = 1; }
          if (!T.hailWarned) { T.hailWarned = true; flashMsg('Hail! Get out of the core.'); }
        }
      }
    }
    for (let i = g.fpHail.length - 1; i >= 0; i--) {
      const h = g.fpHail[i];
      h.x += h.vx * dt; h.y += h.vy * dt;
      if (h.y > rand(260, DASH_Y)) {
        if (Math.random() < 0.3) g.splats.push({ x: h.x, y: h.y, life: 1, r: g.up.nets ? 5 : 9, crack: false });
        g.fpHail.splice(i, 1);
      }
    }

    // Dust and debris from the tornado, flying out across the fields.
    if (T && tornadoOnGround(T)) {
      const gx = tornadoGroundX(T);
      if (Math.random() < 40 * dt) {
        g.dust.push({ a: rand(0, Math.PI * 2), r: rand(10, 30 + T.ef * 10), y: TOR_GROUND - rand(0, 30), life: rand(0.6, 1.4), max: 1.4, x: gx });
      }
      const near = Math.hypot(gx - g.lane, T.z - g.dist);
      if (near < 16000 && Math.random() < (2 + T.ef * 1.4) * dt * (1 - T.rope * 0.8)) {
        const ang = rand(0, Math.PI * 2), sp = rand(700, 1900 + T.ef * 200);
        g.fpDebris.push({
          x: gx, y: rand(100, 500), z: T.z, vx: Math.cos(ang) * sp, vz: Math.sin(ang) * sp - rand(0, 600), vy: rand(700, 1600),
          rot: rand(0, 6), vr: rand(-10, 10), w: rand(8, 18), h: rand(3, 6), cow: Math.random() < 0.07,
        });
      }
      // Direct hit
      const funnelW = funnelAt(T, 1, g.t).w * 6;
      if (playing && Math.abs(gx - g.lane) < funnelW / 2 + 500 && Math.abs(T.z - (g.dist + 600)) < funnelW / 2 + 500) {
        damage((15 + T.ef * 5) * dt * (g.up.tires ? 0.7 : 1), true);
        g.lane += rand(-1, 1) * 2500 * dt * (g.up.tires ? 0.5 : 1);
        g.shake = Math.max(g.shake, 8);
      }
    }
    for (const d of g.dust) { d.life -= dt; d.a += dt * 4; d.y -= dt * 18; d.r += dt * 6; if (T) d.x = tornadoGroundX(T); }
    g.dust = g.dust.filter((d) => d.life > 0 && T);
    for (let i = g.fpDebris.length - 1; i >= 0; i--) {
      const p = g.fpDebris[i];
      p.vy -= 1500 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rot += p.vr * dt;
      const zc = p.z - g.dist;
      if (playing && zc > 150 && zc < 900 && Math.abs(p.x - g.lane) < 700 && p.y < 1100) {
        damage(g.up.roof ? 1.2 : 3);
        sfx.hit();
        g.shake = Math.max(g.shake, 6);
        g.splats.push({ x: clamp(W / 2 + (p.x - g.lane) * 0.3, 120, W - 120), y: rand(140, 330), life: 2.5, r: 26, crack: true, seed: Math.random() * 10 });
        g.fpDebris.splice(i, 1);
        continue;
      }
      if (p.y < 0 || zc < 0) g.fpDebris.splice(i, 1);
    }
    for (const sp of g.splats) sp.life -= dt * (sp.crack ? 0.25 : 0.8);
    g.splats = g.splats.filter((sp) => sp.life > 0).slice(-40);

    // Lightning, timers and the end of the day.
    g.lightningCd -= dt;
    if (g.lightningCd <= 0) {
      g.lightningCd = rand(3, 8);
      g.lightning = 0.3;
      g.bolt = makeBolt(rand(60, W - 60));
      setTimeout(() => sfx.thunder(), rand(150, 900));
    }
    g.lightning = Math.max(0, g.lightning - dt);
    g.flash = Math.max(0, g.flash - dt * 4);
    g.shutterCd = Math.max(0, g.shutterCd - dt);
    g.msgT = Math.max(0, g.msgT - dt);
    g.shake = Math.max(0, g.shake - dt * 20);
    if (state === 'title' && g.tor) {
      g.tor.z = g.dist + 9000 + Math.sin(g.t * 0.3) * 1500;
      g.t += dt;
    }
    if (state === 'sunset') updateSunset(dt);
    if (playing) {
      if (c.hp <= 0) endGame('The storm took your car.');
      else if (g.t >= DAY_LENGTH) startSunset();
      else if (g.ending > 0) { g.ending -= dt; if (g.ending <= 0) endGame('Out of film.'); }
    }
  }

  function updateDrivePickups(dt) {
    const g = game;
    const remaining = Object.keys(UPGRADES).filter((k) => !g.up[k]);
    if (!g.pickup && remaining.length) {
      g.pickupCd -= dt;
      if (g.pickupCd <= 0) {
        g.pickup = { kind: remaining[(Math.random() * remaining.length) | 0], x: rand(-0.7, 0.7) * ROAD_W, z: g.dist + rand(8000, 12000) };
        flashMsg('Something on the road ahead...');
      }
    }
    const p = g.pickup;
    if (!p) return;
    const zc = p.z - g.dist;
    if (zc < 750 && zc > 0 && Math.abs(p.x - g.lane) < 650) installUpgrade(p.kind);
    else if (zc < 0) { g.pickup = null; g.pickupCd = rand(3, 6); }
  }

  // ---------------------------------------------------------------- windshield drawing
  // Project a world point using this frame's road; k is pixels per world unit.
  function spriteAt(wx, wy, wz) {
    const g = game;
    const zc = wz - g.dist;
    if (zc < NEAR) return null;
    const n = (wz - drive.base * SEG) / SEG;
    const i0 = clamp(Math.floor(n), 0, DRAW), f = clamp(n - i0, 0, 1);
    const off = lerp(drive.segX[i0], drive.segX[Math.min(DRAW + 1, i0 + 1)], f);
    const s = CAM_DEPTH / zc;
    return { x: W / 2 + s * (wx + off - g.lane) * 480, y: HORIZON + s * (drive.camH - wy) * 270, k: s * 480 };
  }

  function palArr(name) { return mix(PAL[name][0], PAL[name][1], dusk); }

  function drawRoad3D(g) {
    const base = Math.floor(g.dist / SEG);
    drive.base = base;
    const pct = (g.dist % SEG) / SEG;
    const camH = drive.camH;
    let x = 0, dx = -curveAt(base) * pct;
    let maxy = H + 40;
    const haze = palArr('skyLow');
    const cols = {
      f1: palArr('fieldTop'), f2: palArr('fieldLow'), v1: palArr('verge'), v2: palArr('vergeDark'),
      r1: palArr('road'), r2: mix(palArr('road'), [0, 0, 0], 0.08), line: [255, 244, 196],
    };
    const proj = (z, xoff) => {
      const s = CAM_DEPTH / (z - g.dist);
      return { x: W / 2 + s * (xoff - g.lane) * 480, y: HORIZON + s * camH * 270, w: s * ROAD_W * 480 };
    };
    for (let n = 0; n <= DRAW; n++) {
      const i = base + n, z1 = i * SEG, z2 = z1 + SEG;
      drive.segX[n] = x;
      const nx = x + dx;
      if (z1 - g.dist > NEAR) {
        const p1 = proj(z1, x), p2 = proj(z2, nx);
        if (p2.y < maxy) {
          const fog = Math.pow(n / DRAW, 1.4) * 0.85;
          const c = (arr) => rgb(mix(arr, haze, fog));
          const alt = Math.floor(i / 3) % 2;
          const yTop = Math.max(p2.y, HORIZON), yBot = Math.min(p1.y, maxy);
          ctx.fillStyle = c(alt ? cols.f1 : cols.f2);
          ctx.fillRect(-W, yTop, W * 3, yBot - yTop + 1);
          const quad = (x1, w1, x2, w2, color) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(x1 - w1, p1.y); ctx.lineTo(x2 - w2, p2.y); ctx.lineTo(x2 + w2, p2.y); ctx.lineTo(x1 + w1, p1.y);
            ctx.closePath(); ctx.fill();
          };
          quad(p1.x, p1.w * 1.3, p2.x, p2.w * 1.3, c(alt ? cols.v1 : cols.v2));
          quad(p1.x, p1.w, p2.x, p2.w, c(alt ? cols.r1 : cols.r2));
          if (p1.w > 6) {
            const lw1 = p1.w * 0.03, lw2 = p2.w * 0.03;
            quad(p1.x - p1.w * 0.92, lw1, p2.x - p2.w * 0.92, lw2, c(cols.line));
            quad(p1.x + p1.w * 0.92, lw1, p2.x + p2.w * 0.92, lw2, c(cols.line));
            if (Math.floor(i / 4) % 2 === 0) quad(p1.x, lw1 * 0.9, p2.x, lw2 * 0.9, c([255, 214, 90]));
          }
          maxy = p2.y;
        }
      }
      x = nx;
      dx += curveAt(i);
    }
    drive.segX[DRAW + 1] = x;
  }

  // Roadside furniture, cattle, storms and debris, sorted far to near.
  function collectSprites(g) {
    const list = [];
    const base = drive.base;
    for (let n = DRAW - 3; n >= 1; n--) {
      const i = base + n, z = i * SEG;
      if (n < 120 && i % 2 === 0) { list.push({ z, kind: 'post', x: -ROAD_W * 1.32, side: -1 }); list.push({ z, kind: 'post', x: ROAD_W * 1.32, side: 1 }); }
      if (i % 12 === 0) list.push({ z, kind: 'pole', x: ROAD_W * 2.3 });
      if (n < 170 && hash(i * 3.3) > 0.955) {
        const side = hash(i * 1.1) > 0.5 ? 1 : -1;
        const x0 = side * (ROAD_W * 1.9 + hash(i * 2.7) * 7000);
        const count = 1 + Math.floor(hash(i * 4.4) * 3);
        for (let j = 0; j < count; j++) list.push({ z: z + j * 140, kind: 'cow', x: x0 + j * 300 * side, face: hash(i + j) > 0.5 ? 1 : -1, id: i * 7 + j });
      }
      if (hash(i * 5.1) > 0.94) list.push({ z, kind: 'tree', x: (hash(i * 5.7) > 0.5 ? 1 : -1) * (ROAD_W * 2.6 + hash(i * 6.6) * 16000), r: 60 + hash(i * 6.1) * 60 });
      if (hash(i * 7.7) > 0.992) list.push({ z, kind: 'barn', x: (hash(i * 8.1) > 0.5 ? 1 : -1) * (6000 + hash(i * 8.8) * 14000) });
      if (n < 45) for (const sd of [-1, 1]) list.push({ z: z + hash(i + sd) * SEG, kind: 'tuft', x: sd * (ROAD_W * 1.45 + hash(i * 9.1 + sd) * 3000) });
    }
    if (g.tor) list.push({ z: g.tor.z, kind: 'tornado' });
    if (g.pickup) list.push({ z: g.pickup.z, kind: 'pickup', x: g.pickup.x });
    for (const p of g.fpDebris) list.push({ z: p.z, kind: 'debris', p });
    if (state === 'sunset' && g.picnic) list.push({ z: g.picnic.z, kind: 'picnic' });
    list.sort((a, b) => b.z - a.z);
    return list;
  }

  function drawSprites(g) {
    const last = { '-1': null, 1: null };
    let lastPole = null;
    g.torScreen = null;
    for (const sp of collectSprites(g)) {
      if (sp.kind === 'tornado') { drawTornadoFP(g, g.tor); continue; }
      if (sp.kind === 'debris') {
        const q = spriteAt(sp.p.x, sp.p.y, sp.p.z);
        if (!q || q.y > DASH_Y + 60) continue;
        ctx.save(); ctx.translate(q.x, q.y); const k = clamp(q.k * 22, 0.08, 8); ctx.scale(k, k);
        drawDebrisPiece(sp.p, g.t); ctx.restore();
        continue;
      }
      if (sp.kind === 'picnic') { drawPicnicFP(g); continue; }
      const p = spriteAt(sp.x, 0, sp.z);
      if (!p) continue;
      if (p.x < -400 || p.x > W + 400) { if (sp.kind === 'post') last[sp.side] = null; continue; }
      const k = p.k;
      switch (sp.kind) {
        case 'post': {
          const h = 260 * k, w = Math.max(1.5, 22 * k);
          ctx.fillStyle = col('pole');
          ctx.fillRect(p.x - w / 2, p.y - h, w, h);
          const prev = last[sp.side];
          if (prev) {
            ctx.strokeStyle = 'rgba(70,66,78,0.9)';
            ctx.lineWidth = Math.max(1, 4 * k);
            ctx.beginPath();
            for (const f of [0.35, 0.65, 0.92]) { ctx.moveTo(prev.x, prev.y - prev.h * f); ctx.lineTo(p.x, p.y - h * f); }
            ctx.stroke();
          }
          last[sp.side] = { x: p.x, y: p.y, h };
          break;
        }
        case 'pole': {
          const h = 1500 * k, w = Math.max(2, 50 * k);
          ctx.fillStyle = col('pole');
          ctx.fillRect(p.x - w / 2, p.y - h, w, h);
          ctx.fillRect(p.x - 160 * k, p.y - h * 0.94, 320 * k, Math.max(1.5, 30 * k));
          if (lastPole) {
            ctx.strokeStyle = 'rgba(60,46,60,0.75)';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            for (const o of [-130, 130]) {
              ctx.moveTo(lastPole.x + o * lastPole.k, lastPole.y - lastPole.h * 0.94);
              ctx.quadraticCurveTo((lastPole.x + p.x) / 2, (lastPole.y - lastPole.h * 0.94 + p.y - h * 0.94) / 2 + 30 * k, p.x + o * k, p.y - h * 0.94);
            }
            ctx.stroke();
          }
          lastPole = { x: p.x, y: p.y, h, k };
          break;
        }
        case 'cow':
          drawGrazingCow(p.x, p.y, k * 9, sp.face, g.t + hash(sp.id) * 50);
          break;
        case 'tree': {
          const r = sp.r * k;
          ctx.fillStyle = col('pole');
          ctx.fillRect(p.x - 12 * k, p.y - (sp.r * 1.6) * k, 24 * k, sp.r * 1.6 * k);
          puff(p.x, p.y - sp.r * 2.1 * k, r, col('treeLight'), col('tree'), col('hillShade'));
          break;
        }
        case 'barn':
          ctx.save(); ctx.translate(p.x, p.y); ctx.scale(k * 14, k * 14); drawBarn(0, 0); ctx.restore();
          break;
        case 'tuft': {
          ctx.strokeStyle = col('wheat');
          ctx.lineWidth = Math.max(1.5, 10 * k);
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (const a of [-0.5, 0, 0.5]) { ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(a) * 50 * k, p.y - Math.cos(a) * 70 * k); }
          ctx.stroke();
          break;
        }
        case 'pickup': {
          const y = p.y - (260 + Math.sin(g.t * 3) * 40) * k;
          ctx.save(); ctx.translate(p.x, y); const s = k * 10; ctx.scale(s, s); drawPickupAt(g.pickup.kind, 0, 0); ctx.restore();
          break;
        }
      }
    }
  }

  function drawTornadoFP(g, T) {
    const gx = tornadoGroundX(T);
    const p = spriteAt(gx, 0, T.z);
    if (!p) return;
    g.torScreen = { x: p.x, y: p.y, k: p.k };
    const hs = clamp(p.k * 6, 0.05, 3.4);
    const top = CLOUD_BASE - 20;
    const vs = (p.y - top) / (TOR_GROUND - top);
    if (vs <= 0) return;
    // Lowering of the cloud above it
    ctx.save();
    ctx.globalAlpha = T.alpha;
    ctx.translate(p.x - funnelAt(T, 0, g.t).xo * hs, CLOUD_BASE);
    ctx.scale(clamp(hs, 0.3, 3.4), 1);
    ctx.fillStyle = col('cloudShade');
    ctx.beginPath();
    ctx.moveTo(-210, -30); ctx.lineTo(-150, 4); ctx.lineTo(-90, 12); ctx.lineTo(-70, 26); ctx.lineTo(70, 26); ctx.lineTo(90, 12); ctx.lineTo(150, 4); ctx.lineTo(210, -30);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(p.x - funnelAt(T, 1, g.t).xo * hs, top);
    ctx.scale(hs, vs);
    ctx.translate(0, -top);
    drawTornado(T, T.x);
    ctx.restore();
  }

  function drawPicnicFP(g) {
    const p = spriteAt(g.picnic.x, 0, g.picnic.z);
    if (!p) return;
    const k = p.k * 15; // drawn a little larger than life so the toast reads
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(k, k);
    ctx.translate(-g.px, -(ROAD_Y - 14));
    drawPicnic(g, 0);
    ctx.restore();
  }

  // Rain on the glass, hail, splats and cracks.
  function drawWeatherFP(g) {
    if (g.rain > 0) {
      ctx.fillStyle = col('rain', 0.45 * g.rain);
      ctx.fillRect(-W, -H, W * 3, H * 3);
      ctx.strokeStyle = `rgba(235,240,255,${0.35 * g.rain})`;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 80; i++) {
        const rx = (i * 97 + g.t * 300) % W, ry = (i * 53 + g.t * 900) % DASH_Y;
        ctx.moveTo(rx, ry); ctx.lineTo(rx - 6, ry + 22);
      }
      ctx.stroke();
    }
    for (const h of g.fpHail) puff(h.x, h.y, 4, '#ffffff', '#eef3ff', '#a9b8de');
    for (const sp of g.splats) {
      const a = clamp(sp.life, 0, 1);
      if (sp.crack) {
        ctx.strokeStyle = `rgba(240,248,255,${0.85 * a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k < 7; k++) {
          const ang = k * 0.9 + sp.seed;
          let x = sp.x, y = sp.y;
          ctx.moveTo(x, y);
          for (let j = 1; j <= 3; j++) { x += Math.cos(ang + Math.sin(j + sp.seed) * 0.4) * sp.r * 0.6; y += Math.sin(ang + Math.sin(j + sp.seed) * 0.4) * sp.r * 0.6; ctx.lineTo(x, y); }
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(255,255,255,${0.7 * a})`;
        ctx.beginPath();
        for (let k = 0; k < 5; k++) { const ang = k * 1.256; ctx.moveTo(sp.x, sp.y); ctx.arc(sp.x + Math.cos(ang) * sp.r * 0.6, sp.y + Math.sin(ang) * sp.r * 0.6, sp.r * 0.3, 0, Math.PI * 2); }
        ctx.fill();
      }
    }
  }

  // The inside of the Vibe: hood, pillars, mirror, dash, wheel and gauges.
  function drawCockpit(g) {
    const up = g.up, feral = isFeral(), t = g.t;
    const bounce = Math.sin(t * 13) * Math.min(1.5, g.speed / 4000) * (up.tires ? 1.6 : 1);
    ctx.save();
    ctx.translate(0, bounce);

    // Hood
    ctx.beginPath();
    ctx.moveTo(-20, DASH_Y + 6); ctx.quadraticCurveTo(W / 2, 384, W + 20, DASH_Y + 6); ctx.lineTo(W + 20, H); ctx.lineTo(-20, H); ctx.closePath();
    const hood = ctx.createLinearGradient(0, 392, 0, DASH_Y);
    hood.addColorStop(0, feral ? '#c4453a' : '#ff6a5a');
    hood.addColorStop(1, feral ? '#6c1814' : '#b3141a');
    ctx.fillStyle = hood; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(120, 428); ctx.quadraticCurveTo(W / 2, 396, W - 120, 428); ctx.stroke();
    if (feral) {
      ctx.fillStyle = 'rgba(132,70,30,0.6)';
      for (const [rx, ry, r] of [[220, 432, 14], [650, 426, 11], [770, 436, 9]]) { ctx.beginPath(); ctx.ellipse(rx, ry, r * 1.6, r * 0.6, 0, 0, Math.PI * 2); ctx.fill(); }
      // Spikes along the nose and a blower through the hood. The hood's edge
      // is a quadratic curve, so this finds its height at any x.
      const hoodEdge = (x) => { const u = (x + 20) / (W + 40); return DASH_Y + 6 - 136 * u * (1 - u); };
      ctx.fillStyle = '#d6d4de';
      for (let k = 0; k < 9; k++) {
        const fx = 160 + k * 80, fy = hoodEdge(fx) + 3;
        ctx.beginPath(); ctx.moveTo(fx - 9, fy); ctx.lineTo(fx, fy - 20); ctx.lineTo(fx + 9, fy); ctx.closePath(); ctx.fill();
      }
      const hb = hoodEdge(W / 2) + 14;
      ctx.fillStyle = '#2e2c36'; ctx.fillRect(W / 2 - 46, hb - 40, 92, 40);
      ctx.fillStyle = '#b8b6c4'; ctx.fillRect(W / 2 - 58, hb - 54, 116, 16);
      ctx.fillStyle = '#e8e6f0'; ctx.fillRect(W / 2 - 58, hb - 54, 116, 4);
      ctx.fillStyle = '#2e2c36'; for (let k = 0; k < 4; k++) ctx.fillRect(W / 2 - 48 + k * 26, hb - 51, 14, 10);
      ctx.strokeStyle = '#6d6a7c'; ctx.lineWidth = 3;
      const belt = (t * 60) % 12;
      ctx.beginPath(); for (let by = hb - 36 + belt; by < hb - 2; by += 12) { ctx.moveTo(W / 2 - 40, by); ctx.lineTo(W / 2 + 40, by); } ctx.stroke();
      // Flames from the side stacks
      for (const fx of [26, W - 26]) {
        const fl = 40 + Math.random() * 50;
        ctx.fillStyle = '#ff8a2a';
        ctx.beginPath(); ctx.moveTo(fx - 14, 430); ctx.lineTo(fx, 430 - fl); ctx.lineTo(fx + 14, 430); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffe36b';
        ctx.beginPath(); ctx.moveTo(fx - 7, 430); ctx.lineTo(fx, 430 - fl * 0.55); ctx.lineTo(fx + 7, 430); ctx.closePath(); ctx.fill();
      }
    }

    // Wipers in the rain
    if (g.rain > 0.25) {
      const sweep = 0.5 - 0.5 * Math.cos(t * 3.4);
      const th = -0.12 - sweep * 1.9;
      ctx.strokeStyle = '#1e1c24'; ctx.lineCap = 'round';
      for (const px of [250, 590]) {
        const ex = px + Math.cos(th) * 300, ey = DASH_Y + Math.sin(th) * 300;
        ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(px, DASH_Y); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(px + Math.cos(th) * 60, DASH_Y + Math.sin(th) * 60); ctx.lineTo(ex, ey); ctx.stroke();
      }
    }

    // Window netting
    if (up.nets) {
      ctx.save();
      ctx.beginPath(); ctx.moveTo(70, 22); ctx.lineTo(W - 70, 22); ctx.lineTo(W - 18, DASH_Y); ctx.lineTo(18, DASH_Y); ctx.closePath(); ctx.clip();
      ctx.strokeStyle = 'rgba(28,26,34,0.22)'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let k = -H; k < W + H; k += 64) { ctx.moveTo(k, 0); ctx.lineTo(k + H, H); ctx.moveTo(k, H); ctx.lineTo(k + H, 0); }
      ctx.stroke();
      ctx.restore();
    }

    // Roof, pillars and the cage outside once feral
    ctx.fillStyle = '#2a2632';
    ctx.fillRect(-20, -20, W + 40, 42);
    ctx.beginPath(); ctx.moveTo(-20, -20); ctx.lineTo(82, 22); ctx.lineTo(24, DASH_Y + 10); ctx.lineTo(-20, DASH_Y + 10); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(W + 20, -20); ctx.lineTo(W - 82, 22); ctx.lineTo(W - 24, DASH_Y + 10); ctx.lineTo(W + 20, DASH_Y + 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(-20, 16, W + 40, 6);
    if (feral) {
      ctx.fillStyle = '#3a3842'; ctx.fillRect(70, 22, W - 140, 10);
      for (const lx of [150, W - 150]) {
        ctx.fillStyle = '#2e2c36'; ctx.beginPath(); ctx.arc(lx, 30, 22, 0, Math.PI); ctx.fill();
        ctx.fillStyle = '#fff4c0'; ctx.beginPath(); ctx.arc(lx, 32, 13, 0, Math.PI); ctx.fill();
        if (dusk > 0.3) {
          const beam = ctx.createLinearGradient(0, 40, 0, 330);
          beam.addColorStop(0, `rgba(255,240,170,${0.25 * dusk})`); beam.addColorStop(1, 'rgba(255,240,170,0)');
          ctx.fillStyle = beam;
          ctx.beginPath(); ctx.moveTo(lx - 12, 40); ctx.lineTo(lx + 12, 40); ctx.lineTo(W / 2 + (lx - W / 2) * 0.2 + 90, 330); ctx.lineTo(W / 2 + (lx - W / 2) * 0.2 - 90, 330); ctx.closePath(); ctx.fill();
        }
      }
      // Tattered flag off the left pillar
      const wv = Math.sin(t * 9) * 6;
      ctx.fillStyle = '#c0281f';
      ctx.beginPath(); ctx.moveTo(60, 40); ctx.lineTo(118, 46 + wv); ctx.lineTo(100, 58 + wv * 0.5); ctx.lineTo(122, 70 + wv); ctx.lineTo(62, 74); ctx.closePath(); ctx.fill();
    }

    // Rear-view mirror with fuzzy dice
    ctx.fillStyle = '#1e1c24';
    ctx.fillRect(W / 2 - 4, 20, 8, 16);
    pill(W / 2 - 72, 34, 144, 34); ctx.fill();
    const mg = ctx.createLinearGradient(0, 38, 0, 64);
    mg.addColorStop(0, col('skyLow')); mg.addColorStop(1, col('road'));
    ctx.fillStyle = mg; pill(W / 2 - 66, 38, 132, 26); ctx.fill();
    const swing = -g.steerVis * 0.8 + Math.sin(t * 3) * 0.12;
    ctx.save();
    ctx.translate(W / 2 + 30, 66);
    ctx.rotate(swing);
    ctx.strokeStyle = '#f2f1f7'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-8, 30); ctx.moveTo(0, 0); ctx.lineTo(9, 26); ctx.stroke();
    for (const [dx, dy] of [[-8, 38], [9, 34]]) {
      ctx.fillStyle = '#e8281f'; ctx.fillRect(dx - 9, dy - 9, 18, 18);
      ctx.fillStyle = '#ffffff';
      for (const [px, py] of [[-4, -4], [4, 4], [0, 0]]) { ctx.beginPath(); ctx.arc(dx + px, dy + py, 2, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();

    // Dashboard
    ctx.beginPath();
    ctx.moveTo(-20, DASH_Y - 8); ctx.lineTo(240, DASH_Y); ctx.quadraticCurveTo(W / 2, DASH_Y - 10, W - 240, DASH_Y); ctx.lineTo(W + 20, DASH_Y - 8);
    ctx.lineTo(W + 20, H + 20); ctx.lineTo(-20, H + 20); ctx.closePath();
    const dg = ctx.createLinearGradient(0, DASH_Y - 10, 0, H);
    dg.addColorStop(0, '#45404f'); dg.addColorStop(1, '#1c1922');
    ctx.fillStyle = dg; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-20, DASH_Y - 7); ctx.lineTo(240, DASH_Y + 1); ctx.quadraticCurveTo(W / 2, DASH_Y - 9, W - 240, DASH_Y + 1); ctx.lineTo(W + 20, DASH_Y - 7); ctx.stroke();

    // Bobble-head cow on the dash
    const bob = Math.sin(t * 7) * 3 + g.steerVis * 6;
    ctx.save();
    ctx.translate(730, DASH_Y - 2);
    ctx.fillStyle = '#3a3440'; ctx.fillRect(-8, -4, 16, 6);
    ctx.translate(0, -6);
    ctx.scale(1.3, 1.3);
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#3a3440'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(0, -6, 10, 6, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#3a3440'; ctx.beginPath(); ctx.arc(-3, -7, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.translate(9, -12 + bob * 0.2);
    ctx.rotate(bob * 0.04);
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(0, 0, 6, 5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffb3c1'; ctx.beginPath(); ctx.ellipse(4, 2, 2.6, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a3440'; ctx.fillRect(0, -2, 1.8, 1.8);
    ctx.restore();

    // Gauges
    const gx = 300, gy = 486;
    for (const [cx, r, v] of [[gx - 34, 26, g.speed / 9000], [gx + 36, 20, 0.25 + 0.6 * (g.speed / 9000) + Math.sin(t * 20) * 0.02]]) {
      ctx.fillStyle = '#141018'; ctx.beginPath(); ctx.arc(cx, gy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#8f8c9c'; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = '#d6d4de'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let k = 0; k <= 8; k++) { const a = Math.PI * 0.75 + k / 8 * Math.PI * 1.5; ctx.moveTo(cx + Math.cos(a) * r * 0.75, gy + Math.sin(a) * r * 0.75); ctx.lineTo(cx + Math.cos(a) * r * 0.92, gy + Math.sin(a) * r * 0.92); }
      ctx.stroke();
      const a = Math.PI * 0.75 + clamp(v, 0, 1) * Math.PI * 1.5;
      ctx.strokeStyle = '#ff4a3d'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(cx, gy); ctx.lineTo(cx + Math.cos(a) * r * 0.85, gy + Math.sin(a) * r * 0.85); ctx.stroke();
    }
    ctx.font = `20px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffe680';
    ctx.fillText(`${Math.round(g.speed / 9000 * 95)}`, gx - 34, gy + 30);

    // Radar scope on the dash
    if (up.radar) {
      const cx = 560, cy = 492, R = 36;
      ctx.fillStyle = '#0d2a1c'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(125,255,138,0.35)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
      const sa = t * 2.5;
      ctx.strokeStyle = 'rgba(125,255,138,0.8)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sa) * R, cy + Math.sin(sa) * R); ctx.stroke();
      const blip = (wx, wz, color, r) => {
        const bx = (wx - g.lane) / 25000 * R, by = -(wz - g.dist) / 25000 * R;
        if (Math.hypot(bx, by) > R - 2) return;
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx + bx, cy + by, r, 0, Math.PI * 2); ctx.fill();
      };
      if (g.tor) blip(tornadoGroundX(g.tor), g.tor.z, '#ff4a3d', 4 + g.tor.ef * 0.6);
      if (g.pickup) blip(g.pickup.x, g.pickup.z, '#ffe680', 3);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - 2, cy - 2, 4, 4);
    }

    // Steering wheel
    ctx.save();
    ctx.translate(gx, 600);
    ctx.rotate(g.steerVis);
    ctx.strokeStyle = '#26222e'; ctx.lineWidth = 24;
    ctx.beginPath(); ctx.arc(0, 0, 128, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, 134, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    ctx.strokeStyle = '#26222e'; ctx.lineWidth = 18;
    ctx.beginPath(); ctx.moveTo(-124, 0); ctx.lineTo(124, 0); ctx.stroke();
    ctx.restore();

    ctx.restore();

    // Red edges when the car takes a hit
    if (g.car.hurt > 0) {
      const a = g.car.hurt / 0.25 * 0.35;
      const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H);
      v.addColorStop(0, 'rgba(255,40,30,0)'); v.addColorStop(1, `rgba(255,40,30,${a})`);
      ctx.fillStyle = v; ctx.fillRect(-W, -H, W * 3, H * 3);
    }
  }

  // The whole world pass for windshield mode.
  function drawDriveWorld(g) {
    drive.camH = g.up.tires ? 1250 : 1000;
    const bg = g.bgCam;
    drawSky(g);
    if (state === 'sunset') drawStars(g);
    ctx.save();
    if (state === 'sunset') ctx.translate(0, -g.cloudLift);
    drawStormCloud(bg, null);
    ctx.restore();
    drawLightning(g, 0);
    drawHills(bg);
    drawRoad3D(g);
    drawSprites(g);
    drawWeatherFP(g);
    drawCockpit(g);
  }

  // Off-screen indicator position and distance, shared by both modes.
  function tornadoZX(T) {
    if (game.mode !== 'drive') return screenXOf(tornadoGroundX(T));
    const ts = game.torScreen;
    if (!ts || T.z < game.dist + NEAR) return tornadoGroundX(T) < game.lane ? -100 : W + 100;
    return W / 2 + (ts.x - zoomFocus()) * game.zoom;
  }
  function tornadoMiles(T) {
    return game.mode === 'drive' ? driveMiles(T) : Math.abs(game.car.x - tornadoGroundX(T)) * MI_PER_PX;
  }

  // ---------------------------------------------------------------- loop
  titleDemo(selMode);

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state === 'dialog') updateDialog(dt);
    else if (state !== 'paused') update(dt);
    draw();
    if (document.body.dataset.state !== state) document.body.dataset.state = state;
    if (document.body.dataset.mode !== game.mode) document.body.dataset.mode = game.mode;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Exposed for automated tests.
  window.__dinnerDate = { get state() { return state; }, get game() { return game; }, get music() { return { musicMode, songIndex, round, ctx: audio && audio.state }; } };
})();
