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
  let audio = null, master = null, musicBus = null, sfxBus = null, echoIn = null, bellWave = null;
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
    delay.delayTime.value = 0.36;
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

    bellWave = audio.createPeriodicWave(new Float32Array(6), new Float32Array([0, 1, 0.45, 0.2, 0.1, 0.05]));
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
    if (wave === 'bell') o.setPeriodicWave(bellWave); else o.type = wave;
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

  function noise(duration, { freq = 1000, q = 1, gain = 0.3, type = 'bandpass', decay = duration } = {}) {
    if (!audio) return;
    const len = Math.floor(audio.sampleRate * duration);
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const data = buf.getChannelData(0);
    // Stepped noise, like a console noise channel.
    let v = 0;
    for (let i = 0; i < len; i++) { if (i % 3 === 0) v = Math.random() * 2 - 1; data[i] = v; }
    const src = audio.createBufferSource();
    src.buffer = buf;
    const filter = audio.createBiquadFilter();
    filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const g = audio.createGain();
    const now = audio.currentTime;
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + decay);
    src.connect(filter).connect(g).connect(sfxBus);
    src.start(now);
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

  // Each loop repeats one note on its own period (in seconds).
  const LOOPS = [
    { n: 66, period: 7.1, at: 0.4 },
    { n: 69, period: 8.9, at: 2.3 },
    { n: 74, period: 11.3, at: 4.1 },
    { n: 71, period: 13.7, at: 6.0 },
    { n: 76, period: 17.9, at: 9.2 },
    { n: 62, period: 19.3, at: 1.7 },
    { n: 81, period: 23.3, at: 12.5 },
  ];
  const BUBBLES = [74, 76, 78, 81, 83, 86, 88, 90];
  const PADS = [[50, 57, 64, 66], [47, 54, 62, 66], [43, 50, 57, 62], [45, 52, 59, 64]];
  let loopNext = [], padNext = 0, padIndex = 0, bubbleNext = 0;

  function startMusic() {
    const now = audio.currentTime + 0.1;
    loopNext = LOOPS.map((l) => now + l.at);
    padNext = now;
    bubbleNext = now + 1.5;
    musicTimer = setInterval(scheduleMusic, 120);
  }

  function stormCloseness() {
    const T = game && game.tor;
    if (!T || state !== 'play') return 0;
    return clamp(1 - Math.abs(game.car.x - tornadoGroundX(T)) / 900, 0, 1) * T.alpha;
  }

  function scheduleMusic() {
    if (!audio || audio.state !== 'running') return;
    const horizon = audio.currentTime + 0.4;
    LOOPS.forEach((l, i) => {
      while (loopNext[i] < horizon) {
        tone(midi(l.n), loopNext[i], { wave: 'bell', attack: 0.01, decay: 2.8, gain: 0.08, bus: musicBus });
        loopNext[i] += l.period;
      }
    });
    while (padNext < horizon) {
      for (const n of PADS[padIndex % PADS.length]) pad(midi(n), padNext, 17);
      padIndex++;
      padNext += 16;
    }
    while (bubbleNext < horizon) {
      const near = stormCloseness();
      const n = BUBBLES[(Math.random() * BUBBLES.length) | 0];
      tone(midi(n), bubbleNext, { wave: 'sine', decay: 0.16, gain: 0.05 + near * 0.04, glide: 1.5, bus: musicBus });
      if (Math.random() < 0.3) tone(midi(n + 5), bubbleNext + 0.09, { wave: 'sine', decay: 0.12, gain: 0.04, glide: 1.5, bus: musicBus });
      bubbleNext += rand(0.3, 1.5) * (1 - near * 0.6);
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
    over() { [74, 69, 66, 62].forEach((n, i) => tone(midi(n), now() + i * 0.28, { wave: 'bell', decay: 1.6, gain: 0.12 })); },
  };

  // ---------------------------------------------------------------- input
  const keys = { left: false, right: false, zoom: false };
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    KeyZ: 'zoom', ShiftLeft: 'zoom', ShiftRight: 'zoom',
  };

  window.addEventListener('keydown', (e) => {
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
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.focus(); action(); });

  document.querySelectorAll('.controls button').forEach((btn) => {
    const k = btn.dataset.key;
    const down = (e) => {
      e.preventDefault();
      btn.classList.add('active');
      if (k === 'shutter') action(); else keys[k] = true;
    };
    const up = (e) => {
      e.preventDefault();
      btn.classList.remove('active');
      if (k !== 'shutter') keys[k] = false;
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

  function action() {
    initAudio();
    if (state === 'title') startGame();
    else if (state === 'play') takePhoto();
    else if (state === 'paused') togglePause();
    else if (state === 'dialog') advanceDialog();
    else if (state === 'over' && performance.now() - game.overAt > 1000) startGame();
  }

  function togglePause() {
    if (state === 'play') state = 'paused';
    else if (state === 'paused') { state = 'play'; last = performance.now(); }
  }

  // ---------------------------------------------------------------- game state
  let state = 'title';
  let game;
  let best = loadBest();

  function newGame() {
    return {
      t: 0, score: 0, film: FILM, frames: 0,
      car: { x: 0, vx: 0, hp: 100, dir: 1, hurt: 0, wheel: 0 },
      camX: -W / 2,
      tor: null, nextTor: 1.5,
      hail: [], debris: [], dust: [],
      flash: 0, lightning: 0, lightningCd: rand(3, 7), bolt: null,
      shutterCd: 0, msg: '', msgT: 0, shake: 0,
      overAt: 0, ending: 0, endReason: '', hailSound: 0,
      zoom: 1, aimX: W / 2, dialog: null, dialogDelay: 0, dialogQuote: null, usedQuotes: new Set(),
    };
  }

  function startGame() {
    game = newGame();
    state = 'play';
    flashMsg('Storms are firing. Go find a tornado.');
  }

  function endGame(reason) {
    if (state !== 'play') return;
    game.endReason = reason;
    state = 'over';
    if (game.score > best) { best = game.score; saveBest(best); }
    sfx.over();
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
      game.nextTor -= dt;
      if (game.nextTor <= 0) spawnTornado(game.car.x);
      return;
    }
    T.pt += dt;
    T.retarget -= dt;
    if (T.retarget <= 0) {
      T.retarget = rand(2, 5);
      T.tvx = rand(-1, 1) * (55 + T.ef * 14);
      // Sometimes the storm turns toward you.
      if (state === 'play' && Math.random() < 0.3) T.tvx = Math.sign(game.car.x - T.x) * (60 + T.ef * 10);
    }
    T.vx += (T.tvx - T.vx) * Math.min(1, dt * 0.7);
    T.x += T.vx * dt;
    T.lean += ((T.vx / 100) * 45 - T.lean) * Math.min(1, dt);

    if (T.phase === 'forming') {
      T.alpha = Math.min(1, T.pt / 3.5);
      if (T.pt >= 4) { T.phase = 'mature'; T.pt = 0; flashMsg(`Touchdown! Rated EF${T.ef}.`); sfx.touchdown(); }
    } else if (T.phase === 'mature') {
      if (T.pt >= T.life) { T.phase = 'roping'; T.pt = 0; flashMsg('It\'s roping out. Last chance!'); }
    } else if (T.phase === 'roping') {
      T.rope = Math.min(1, T.pt / 4);
      T.alpha = 1 - clamp((T.pt - 4) / 1.5, 0, 1);
      if (T.pt >= 5.5) {
        game.tor = null;
        game.nextTor = rand(2.5, 5);
        flashMsg('Gone. Another storm is going up.');
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
    if (T && T.alpha > 0.25) {
      const gx = tornadoGroundX(T);
      const zx = screenXOf(gx);
      const phaseName = { forming: 'funnel', mature: 'tornado', roping: 'rope-out' }[T.phase];
      if (zx < -30 || zx > W + 30) {
        short = 'Missed it. Out of frame.';
        tag = 'miss';
      } else {
        const d = Math.abs(game.car.x - gx);
        const dEff = d / z; // zooming in stands in for getting closer
        const closeness = clamp(1 - (dEff - 60) / 750, 0, 1);
        const framing = 1 - 0.4 * Math.min(1, Math.abs(zx - W / 2) / (W / 2));
        const phaseMult = T.phase === 'forming' ? 0.6 : T.phase === 'roping' ? 1.4 : 1;
        const reach = tornadoReach(T);
        points = Math.round(100 * closeness * framing * (1 + T.ef * 0.4) * phaseMult * T.alpha * (0.4 + 0.6 * reach));
        short = `EF${T.ef} ${phaseName}`;
        if (game.lightning > 0) { points += 40; short += ' + bolt'; }
        if (points < 15) short = 'Too far.';
        tag = game.lightning > 0 ? 'lightning'
          : game.car.hp < 40 ? 'hurt'
          : d < 170 ? 'close'
          : z > 1.6 ? 'zoom'
          : T.phase === 'roping' ? 'rope'
          : points >= 110 ? 'score'
          : dEff > 450 ? 'far' : 'any';
      }
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
    if (state === 'play' && g.dialogDelay > 0) {
      g.dialogDelay -= dt;
      if (g.dialogDelay <= 0) openDialog(g.dialogQuote);
    }

    // Car
    if (state === 'play') {
      const input = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
      if (input) {
        c.vx += input * 640 * dt;
        c.dir = input;
      } else {
        c.vx -= Math.sign(c.vx) * Math.min(Math.abs(c.vx), 420 * dt);
      }
      c.vx = clamp(c.vx, -340, 340);
    }
    c.x += c.vx * dt;
    c.wheel += c.vx * dt / 8;
    c.hurt = Math.max(0, c.hurt - dt);

    // Camera leads the car a little.
    const target = c.x - W / 2 + c.vx * 0.45;
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
        damage(1);
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
        damage((15 + T.ef * 5) * dt, true);
        c.vx += rand(-900, 900) * dt;
        g.shake = Math.max(g.shake, 8);
      }
    }
    for (let i = g.debris.length - 1; i >= 0; i--) {
      const p = g.debris[i];
      p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (state === 'play' && p.y > ROAD_Y - 30 && p.y < ROAD_Y && Math.abs(p.x - c.x) < 32) {
        damage(3);
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
      else if (g.t >= DAY_LENGTH) endGame('Sunset. The chase is over.');
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

    drawSky(g);
    drawHills(cam);
    drawField(g, cam);
    if (T) drawRain(T, cam, g);
    if (T) drawTornado(T, cam);
    drawStormCloud(cam, T);
    drawLightning(g, cam);
    drawPoles(cam);
    drawRoad(cam);
    drawCar(g.car, cam);
    drawHail(g, cam);
    drawDebris(g, cam);

    if (g.lightning > 0) {
      ctx.fillStyle = `rgba(255,250,224,${0.3 * (g.lightning / 0.3)})`;
      ctx.fillRect(-W, -H, W * 3, H * 3);
    }
    if (dusk > 0) {
      ctx.fillStyle = `rgba(70,40,110,${dusk * 0.22})`;
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
    if (state === 'title') drawTitle();
    if (state === 'paused') drawCenter('PAUSED', 'Press P or tap to resume');
    if (state === 'over') {
      drawCenter(g.endReason, `${g.frames} frames exposed. Score ${g.score}. Best ${best}.`);
      if (performance.now() - g.overAt > 1000 && Math.floor(performance.now() / 500) % 2) {
        text('PRESS SPACE OR TAP TO CHASE AGAIN', SW / 2, SH / 2 + 26, { align: 'center', color: '#ffe680' });
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
    const sx = c.x - cam;
    const y = ROAD_Y;

    // Soft shadow
    ctx.fillStyle = 'rgba(40,30,60,0.28)';
    ctx.beginPath(); ctx.ellipse(sx, y + 1, 38, 4.5, 0, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(sx, y);
    ctx.scale(c.dir, 1);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const hurt = c.hurt > 0 && Math.floor(c.hurt * 30) % 2;

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
    paint.addColorStop(0, hurt ? '#ffffff' : '#ff6a5a');
    paint.addColorStop(0.45, hurt ? '#ffffff' : '#e8281f');
    paint.addColorStop(1, hurt ? '#ffffff' : '#a9121a');
    body();
    ctx.fillStyle = paint;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#5a0a10';
    ctx.stroke();

    // Rear spoiler lip
    ctx.fillStyle = hurt ? '#ffffff' : '#c81b1d';
    ctx.beginPath();
    ctx.moveTo(-27, -37); ctx.lineTo(-37, -38.5); ctx.lineTo(-35.5, -35); ctx.lineTo(-29, -35);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#6e0c12'; ctx.lineWidth = 1; ctx.stroke();

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
    ctx.restore();

    // Glossy highlights along the roof and shoulder
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
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

    // Roof rails and the chase antenna
    ctx.strokeStyle = '#2a2830';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-26, -39.5); ctx.lineTo(4, -39.5); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-24, -39.5); ctx.lineTo(-24, -37); ctx.moveTo(2, -39.5); ctx.lineTo(2, -37); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-18, -37); ctx.lineTo(-24, -54); ctx.stroke();
    ctx.fillStyle = '#ff4a3d';
    ctx.beginPath(); ctx.arc(-24, -54, 1.8, 0, Math.PI * 2); ctx.fill();

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

    // Wheels with shiny hubcaps
    for (const wx of [-21, 22]) {
      ctx.fillStyle = '#26242c';
      ctx.beginPath(); ctx.arc(wx, -6, 8, 0, Math.PI * 2); ctx.fill();
      const hub = ctx.createRadialGradient(wx - 1.5, -7.5, 0.5, wx, -6, 4.5);
      hub.addColorStop(0, '#ffffff');
      hub.addColorStop(1, '#a9a6b8');
      ctx.fillStyle = hub;
      ctx.beginPath(); ctx.arc(wx, -6, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#6d6a7c';
      ctx.lineWidth = 1.2;
      const a = c.wheel * c.dir;
      ctx.beginPath();
      for (let k = 0; k < 3; k++) {
        const ang = a + k * 2.094;
        ctx.moveTo(wx, -6); ctx.lineTo(wx + Math.cos(ang) * 4, -6 + Math.sin(ang) * 4);
      }
      ctx.stroke();
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
      if (p.cow) {
        // A very surprised cow.
        ctx.rotate(p.rot * 0.35);
        ctx.strokeStyle = '#3a3440';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (const lx of [-6, -2, 3, 7]) { ctx.moveTo(lx, 3); ctx.lineTo(lx + Math.sin(g.t * 20 + lx) * 2, 9); }
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
      ctx.restore();
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
    const left = Math.max(0, DAY_LENGTH - g.t);
    const m = Math.floor(left / 60), s = Math.floor(left % 60);
    text(`SUNSET ${m}:${String(s).padStart(2, '0')}`, SW - 6, 6, { align: 'right' });

    if (state === 'dialog') return;

    // Car health
    text('CAR', 6, SH - 13);
    ctx.fillStyle = SHADOW;
    ctx.fillRect(33, SH - 14, 62, 10);
    ctx.fillStyle = '#4a3a66';
    ctx.fillRect(34, SH - 13, 60, 8);
    if (g.car.hp > 0) {
      const w = Math.max(1, Math.round(60 * g.car.hp / 100));
      ctx.fillStyle = g.car.hp > 30 ? '#5cbf62' : '#e8281f';
      ctx.fillRect(34, SH - 13, w, 8);
      ctx.fillStyle = g.car.hp > 30 ? '#b8f0a0' : '#ff9a8a';
      ctx.fillRect(34, SH - 13, w, 2);
    }

    const T = g.tor;
    if (T && T.alpha > 0.2) {
      const gx = tornadoGroundX(T);
      const d = Math.abs(g.car.x - gx);
      text(`RANGE ${(d * MI_PER_PX).toFixed(1)}MI`, SW - 6, SH - 13, { align: 'right' });
      const zx = screenXOf(gx);
      if (zx < 0 || zx > W) {
        const isLeft = zx < 0;
        const ax = isLeft ? 4 : SW - 4, ay = 96;
        ctx.fillStyle = SHADOW;
        tri(ax + 1, ay + 1, isLeft);
        ctx.fillStyle = '#ff4a3d';
        tri(ax, ay, isLeft);
        text(`${(d * MI_PER_PX).toFixed(1)}`, ax + (isLeft ? 2 : -2), ay + 10, { align: isLeft ? 'left' : 'right' });
      }
    } else {
      text('SCANNING...', SW - 6, SH - 13, { align: 'right' });
    }

    if (g.msgT > 0) {
      text(g.msg, SW / 2, 34, { align: 'center', alpha: Math.min(1, g.msgT * 2) });
    }
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
    text('A DINNER DATE', SW / 2, 46, { size: 16, align: 'center', color: '#ffffff', outline: true });
    text('WITH THE SUBLIME', SW / 2, 68, { size: 16, align: 'center', color: '#ff4a3d', outline: true });
    text('Drive close. Take the picture.', SW / 2, 100, { align: 'center' });
    text('Get out alive.', SW / 2, 112, { align: 'center' });
    if (Math.floor(performance.now() / 500) % 2) text('PRESS SPACE OR TAP', SW / 2, 140, { align: 'center', color: '#ffe680' });
    if (best > 0) text(`BEST ${best}`, SW / 2, 158, { align: 'center' });
  }

  // ---------------------------------------------------------------- loop
  game = newGame();
  spawnTornado(0);
  game.tor.x = 260; game.tor.phase = 'mature'; game.tor.alpha = 1; game.tor.life = 1e9; game.tor.core = 1;

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state === 'dialog') updateDialog(dt);
    else if (state !== 'paused') update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Exposed for automated tests.
  window.__dinnerDate = { get state() { return state; }, get game() { return game; } };
})();
