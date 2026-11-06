/* Chase Day: a storm chasing game. Plain canvas, no dependencies. */
(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const mainCtx = canvas.getContext('2d');
  // The scene is painted at logical resolution, then screened to halftone.
  const scene = document.createElement('canvas');
  const sceneCtx = scene.getContext('2d', { willReadFrequently: true });
  let ctx = mainCtx; // whichever layer is currently being drawn

  // Logical resolution; the canvas is scaled to fit its container.
  const W = 960, H = 540;
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
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    mainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  scene.width = W; scene.height = H;

  // ---------------------------------------------------------------- halftone
  // 45-degree round-dot screen: a tile of thresholds, one per pixel.
  const PAPER = [244, 241, 234], INK = [20, 20, 20];
  const PAPER_CSS = '#f4f1ea', INK_CSS = '#141414';
  const TILE = 12;
  const threshold = new Float32Array(TILE * TILE);
  {
    const cell = TILE / Math.SQRT2;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const u = (x + 0.5 + y + 0.5) / Math.SQRT2 / cell;
        const v = (x + 0.5 - y - 0.5) / Math.SQRT2 / cell;
        const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
        threshold[y * TILE + x] = fu * fu + fv * fv;
      }
    }
    // Replace distances with their rank so ink coverage tracks tone exactly.
    const order = [...threshold.keys()].sort((i, j) => threshold[i] - threshold[j]);
    order.forEach((idx, rank) => { threshold[idx] = (rank + 0.5) / threshold.length; });
  }
  // Tone curve: darkness (0..1, as 0..765 summed rgb) -> ink coverage.
  const tone = new Float32Array(766);
  for (let i = 0; i < 766; i++) {
    const d = 1 - i / 765;
    tone[i] = clamp((d - 0.06) / 0.88, 0, 1);
  }
  function halftone() {
    const img = sceneCtx.getImageData(0, 0, W, H);
    const px = img.data;
    for (let y = 0, i = 0; y < H; y++) {
      const row = (y % TILE) * TILE;
      for (let x = 0; x < W; x++, i += 4) {
        const ink = tone[px[i] + px[i + 1] + px[i + 2]] > threshold[row + (x % TILE)];
        const c = ink ? INK : PAPER;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
      }
    }
    sceneCtx.putImageData(img, 0, 0);
    mainCtx.imageSmoothingEnabled = false;
    mainCtx.drawImage(scene, 0, 0, W, H);
    mainCtx.imageSmoothingEnabled = true;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------------------------------------------------------------- storage
  function loadBest() {
    try { return parseInt(localStorage.getItem('chaseDayBest'), 10) || 0; } catch (e) { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem('chaseDayBest', String(v)); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- audio
  let audio = null, muted = false;
  function initAudio() {
    if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
  }
  function noise(duration, { freq = 1000, q = 1, gain = 0.3, type = 'bandpass', decay = duration } = {}) {
    if (!audio || muted) return;
    const len = Math.floor(audio.sampleRate * duration);
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = audio.createBufferSource();
    src.buffer = buf;
    const filter = audio.createBiquadFilter();
    filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const g = audio.createGain();
    const now = audio.currentTime;
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + decay);
    src.connect(filter).connect(g).connect(audio.destination);
    src.start(now);
  }
  const sfx = {
    shutter() { noise(0.05, { freq: 3500, q: 2, gain: 0.35 }); setTimeout(() => noise(0.04, { freq: 2200, q: 2, gain: 0.25 }), 70); },
    thunder() { noise(2.2, { freq: 90, q: 0.7, gain: 0.7, type: 'lowpass', decay: 2.2 }); },
    hit() { noise(0.12, { freq: 600, q: 1.5, gain: 0.35 }); },
    hail() { noise(0.03, { freq: 5000, q: 3, gain: 0.08 }); },
  };

  // ---------------------------------------------------------------- input
  const keys = { left: false, right: false };
  const KEYMAP = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };

  window.addEventListener('keydown', (e) => {
    if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); return; }
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (!e.repeat) action();
    } else if (e.code === 'KeyP' || e.code === 'Escape') {
      togglePause();
    } else if (e.code === 'KeyM') {
      muted = !muted;
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
  });
  window.addEventListener('blur', () => { keys.left = keys.right = false; });

  function action() {
    initAudio();
    if (state === 'title') startGame();
    else if (state === 'play') takePhoto();
    else if (state === 'paused') togglePause();
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
      t: 0, score: 0, film: FILM, photos: [],
      car: { x: 0, vx: 0, hp: 100, dir: 1, hurt: 0, wheel: 0 },
      camX: -W / 2,
      tor: null, nextTor: 1.5,
      hail: [], debris: [], dust: [],
      flash: 0, lightning: 0, lightningCd: rand(3, 7), bolt: null,
      shutterCd: 0, msg: '', msgT: 0, shake: 0,
      pendingShot: null, ending: 0, endReason: '', hailSound: 0,
    };
  }

  function startGame() {
    game = newGame();
    state = 'play';
    sheet.style.display = 'none';
    flashMsg('Storms are firing. Go find a tornado.');
  }

  function endGame(reason) {
    if (state !== 'play') return;
    game.endReason = reason;
    state = 'over';
    if (game.score > best) { best = game.score; saveBest(best); }
    showContactSheet();
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
      if (T.pt >= 4) { T.phase = 'mature'; T.pt = 0; flashMsg(`Touchdown! Rated EF${T.ef}.`); }
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

  // ---------------------------------------------------------------- photos
  function takePhoto() {
    if (game.shutterCd > 0 || game.film <= 0 || game.ending > 0) return;
    game.shutterCd = 0.4;
    game.film--;
    game.flash = 1;
    sfx.shutter();

    const T = game.tor;
    let points = 0, label = 'Empty sky';
    if (T && T.alpha > 0.25) {
      const gx = tornadoGroundX(T);
      const sx = gx - game.camX;
      const phaseName = { forming: 'funnel', mature: 'tornado', roping: 'rope-out' }[T.phase];
      if (sx < -30 || sx > W + 30) {
        label = 'Missed it. Out of frame.';
      } else {
        const d = Math.abs(game.car.x - gx);
        const closeness = clamp(1 - (d - 60) / 750, 0, 1);
        const framing = 1 - 0.4 * Math.min(1, Math.abs(sx - W / 2) / (W / 2));
        const phaseMult = T.phase === 'forming' ? 0.6 : T.phase === 'roping' ? 1.4 : 1;
        const reach = tornadoReach(T);
        points = Math.round(100 * closeness * framing * (1 + T.ef * 0.4) * phaseMult * T.alpha * (0.4 + 0.6 * reach));
        label = `EF${T.ef} ${phaseName}, ${(d * MI_PER_PX).toFixed(1)} mi`;
        if (game.lightning > 0) { points += 40; label += ' + lightning'; }
        if (points < 15) label = `Too far. ${label}`;
      }
    }
    game.score += points;
    flashMsg(points > 0 ? `+${points}  ${label}` : label, 1.8);
    game.pendingShot = { points, label, frame: FILM - game.film };
    if (game.film === 0) game.ending = 1.6;
  }

  const thumb = document.createElement('canvas');
  thumb.width = 320; thumb.height = 180;
  const tctx = thumb.getContext('2d');
  function captureShot() {
    const s = game.pendingShot;
    game.pendingShot = null;
    tctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, thumb.width, thumb.height);
    let src = '';
    try { src = thumb.toDataURL('image/jpeg', 0.8); } catch (e) { /* ignore */ }
    game.photos.push({ ...s, src });
  }

  // ---------------------------------------------------------------- update
  function update(dt) {
    const g = game;
    if (state === 'play') g.t += dt;
    const c = g.car;

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
        damage(3);
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
      if (Math.random() < (2.5 + T.ef * 1.8) * dt * (1 - T.rope * 0.8)) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        g.debris.push({
          x: gx + rand(-10, 10), y: TOR_GROUND - rand(10, 60),
          vx: dir * rand(90, 280 + T.ef * 30), vy: -rand(120, 320),
          rot: rand(0, 6), vr: rand(-10, 10), w: rand(6, 16), h: rand(2, 5),
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
        damage((28 + T.ef * 9) * dt, true);
        c.vx += rand(-900, 900) * dt;
        g.shake = Math.max(g.shake, 8);
      }
    }
    for (let i = g.debris.length - 1; i >= 0; i--) {
      const p = g.debris[i];
      p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (state === 'play' && p.y > ROAD_Y - 30 && p.y < ROAD_Y && Math.abs(p.x - c.x) < 32) {
        damage(9);
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
  function skyColors(dusk) {
    // Pale afternoon light to a dim dusk (values only; this is printed in halftone).
    const top = mix([150, 150, 150], [70, 70, 70], dusk);
    const mid = mix([208, 208, 208], [120, 120, 120], dusk);
    const low = mix([238, 238, 238], [165, 165, 165], dusk);
    return { top, mid, low };
  }
  function mix(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  function draw() {
    const g = game;
    const dusk = clamp((g.t - DAY_LENGTH * 0.55) / (DAY_LENGTH * 0.45), 0, 1);
    const cam = g.camX;

    const shakeX = g.shake > 0 ? rand(-g.shake, g.shake) : 0;
    const shakeY = g.shake > 0 ? rand(-g.shake, g.shake) : 0;
    ctx = sceneCtx;
    ctx.save();
    ctx.translate(shakeX, shakeY);

    // Sky
    const sky = skyColors(dusk);
    const grad = ctx.createLinearGradient(0, 0, 0, HORIZON);
    grad.addColorStop(0, rgb(sky.top));
    grad.addColorStop(0.55, rgb(sky.mid));
    grad.addColorStop(1, rgb(sky.low));
    ctx.fillStyle = grad;
    ctx.fillRect(-20, -20, W + 40, HORIZON + 20);

    // Storm cloud base with a lumpy underside
    ctx.fillStyle = rgb(mix([62, 62, 62], [38, 38, 38], dusk));
    ctx.beginPath();
    ctx.moveTo(-20, -20);
    for (let sx = -20; sx <= W + 20; sx += 12) {
      const wx = sx + cam * 0.5;
      const y = CLOUD_BASE - 8 + Math.sin(wx * 0.011) * 10 + Math.sin(wx * 0.037 + 1) * 5;
      ctx.lineTo(sx, y);
    }
    ctx.lineTo(W + 20, -20);
    ctx.closePath();
    ctx.fill();

    // Lightning bolt
    if (g.lightning > 0 && g.bolt) {
      ctx.strokeStyle = `rgba(255,255,255,${g.lightning / 0.3})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      g.bolt.forEach(([x, y], i) => (i ? ctx.lineTo(x - cam, y) : ctx.moveTo(x - cam, y)));
      ctx.stroke();
    }

    // Distant hills
    ctx.fillStyle = rgb(mix([150, 150, 150], [100, 100, 100], dusk));
    ctx.beginPath();
    ctx.moveTo(-20, HORIZON + 2);
    for (let sx = -20; sx <= W + 20; sx += 16) {
      const wx = sx + cam * 0.15;
      ctx.lineTo(sx, HORIZON - 6 - Math.sin(wx * 0.006) * 7 - Math.sin(wx * 0.017) * 4);
    }
    ctx.lineTo(W + 20, HORIZON + 2);
    ctx.closePath();
    ctx.fill();

    // Field
    const fg = ctx.createLinearGradient(0, HORIZON, 0, ROAD_Y);
    fg.addColorStop(0, rgb(mix([196, 196, 196], [130, 130, 130], dusk)));
    fg.addColorStop(1, rgb(mix([222, 222, 222], [150, 150, 150], dusk)));
    ctx.fillStyle = fg;
    ctx.fillRect(-20, HORIZON, W + 40, ROAD_Y - HORIZON);
    ctx.strokeStyle = rgb(mix([120, 120, 120], [80, 80, 80], dusk), 0.7);
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      const y = HORIZON + 6 + Math.pow(i / 8, 1.6) * (ROAD_Y - HORIZON - 20);
      ctx.beginPath(); ctx.moveTo(-20, y); ctx.lineTo(W + 20, y); ctx.stroke();
    }

    const T = g.tor;

    // Rain and hail curtain
    if (T && T.alpha > 0) {
      const [a, b] = coreRange(T);
      const x0 = a - cam, x1 = b - cam;
      const rg = ctx.createLinearGradient(x0, 0, x1, 0);
      const ca = rgb(mix([105, 105, 105], [70, 70, 70], dusk), 0);
      const cb = rgb(mix([105, 105, 105], [70, 70, 70], dusk), 0.65 * T.alpha);
      if (T.core > 0) { rg.addColorStop(0, ca); rg.addColorStop(0.35, cb); rg.addColorStop(1, cb); }
      else { rg.addColorStop(0, cb); rg.addColorStop(0.65, cb); rg.addColorStop(1, ca); }
      ctx.fillStyle = rg;
      ctx.fillRect(x0, CLOUD_BASE - 10, x1 - x0, ROAD_Y - CLOUD_BASE + 40);
      ctx.strokeStyle = `rgba(220,225,225,${0.18 * T.alpha})`;
      ctx.beginPath();
      for (let i = 0; i < 70; i++) {
        const rx = x0 + ((i * 97 + g.t * 260) % Math.max(1, x1 - x0));
        const ry = CLOUD_BASE + ((i * 53 + g.t * 700) % (ROAD_Y - CLOUD_BASE));
        ctx.moveTo(rx, ry); ctx.lineTo(rx - 6 * T.core, ry + 22);
      }
      ctx.stroke();
    }

    // Tornado
    if (T) drawTornado(T, cam, dusk);

    // Road
    ctx.fillStyle = rgb(mix([50, 50, 50], [36, 36, 36], dusk));
    ctx.fillRect(-20, ROAD_Y - 8, W + 40, 40);
    ctx.fillStyle = rgb(mix([240, 240, 240], [200, 200, 200], dusk));
    const dash = 60;
    const dashOff = -(((cam % (dash * 2)) + dash * 2) % (dash * 2));
    for (let x = dashOff - 20; x < W + 20; x += dash * 2) ctx.fillRect(x, ROAD_Y + 11, dash, 3);
    ctx.fillStyle = rgb(mix([140, 140, 140], [95, 95, 95], dusk));
    ctx.fillRect(-20, ROAD_Y + 32, W + 40, H - ROAD_Y);

    // Lightning illumination and darkening at dusk
    if (g.lightning > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.35 * (g.lightning / 0.3)})`;
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }
    if (dusk > 0) {
      ctx.fillStyle = `rgba(0,0,0,${dusk * 0.3})`;
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }

    ctx.restore();
    ctx = mainCtx;
    halftone();

    // Line work and the car sit on top of the screen.
    ctx.save();
    ctx.translate(shakeX, shakeY);
    drawForeground(g, cam);
    drawCar(g.car, cam);
    ctx.restore();

    // The photo is captured before the HUD and flash are drawn.
    if (g.pendingShot) captureShot();

    if (g.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${g.flash * 0.85})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (state === 'play' || state === 'paused') drawHUD();
    if (state === 'title') drawTitle();
    if (state === 'paused') drawCenter('PAUSED', 'Press P or tap to resume');
    if (state === 'over') drawCenter(g.endReason, `Score ${g.score}. Your contact sheet is below.`);
  }

  // Solid ink line work drawn over the halftone.
  function drawForeground(g, cam) {
    // Telephone poles and wires
    const poleSpacing = 260;
    const firstPole = Math.floor((cam - 40) / poleSpacing) * poleSpacing;
    ctx.strokeStyle = INK_CSS;
    ctx.lineWidth = 3;
    const poleTops = [];
    for (let wx = firstPole; wx < cam + W + 300; wx += poleSpacing) {
      const sx = wx - cam;
      ctx.beginPath(); ctx.moveTo(sx, ROAD_Y - 8); ctx.lineTo(sx, ROAD_Y - 118); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx - 12, ROAD_Y - 108); ctx.lineTo(sx + 12, ROAD_Y - 108); ctx.stroke();
      poleTops.push(sx);
    }
    ctx.lineWidth = 1;
    for (let i = 0; i < poleTops.length - 1; i++) {
      for (const off of [-10, 10]) {
        const ax = poleTops[i] + off, bx = poleTops[i + 1] + off;
        ctx.beginPath();
        ctx.moveTo(ax, ROAD_Y - 108);
        ctx.quadraticCurveTo((ax + bx) / 2, ROAD_Y - 92, bx, ROAD_Y - 108);
        ctx.stroke();
      }
    }

    // Hail
    ctx.fillStyle = PAPER_CSS;
    ctx.strokeStyle = INK_CSS;
    ctx.lineWidth = 1;
    for (const h of g.hail) {
      const sx = h.x - cam;
      if (sx < -10 || sx > W + 10) continue;
      ctx.beginPath(); ctx.arc(sx, h.y, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // Debris
    ctx.fillStyle = INK_CSS;
    for (const p of g.debris) {
      const sx = p.x - cam;
      if (sx < -20 || sx > W + 20) continue;
      ctx.save(); ctx.translate(sx, p.y); ctx.rotate(p.rot);
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

  }

  function drawTornado(T, cam, dusk) {
    const reach = tornadoReach(T);
    const N = 36;
    const left = [], right = [];
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * reach;
      const f = funnelAt(T, t, game.t);
      const cx = T.x + f.xo - cam;
      left.push([cx - f.w / 2, f.y]);
      right.push([cx + f.w / 2, f.y]);
    }
    const sx = T.x - cam;
    if (sx < -700 || sx > W + 700) return;

    // Wall cloud
    ctx.fillStyle = rgb(mix([48, 48, 48], [30, 30, 30], dusk), T.alpha * 0.95);
    ctx.beginPath();
    ctx.ellipse(sx + T.lean * 0.1, CLOUD_BASE + 2, 190 * T.size, 26, 0, 0, Math.PI * 2);
    ctx.fill();

    // Funnel
    const col = mix([28, 28, 28], [18, 18, 18], dusk);
    ctx.fillStyle = rgb(col, 0.92 * T.alpha);
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1] - 6);
    for (const [x, y] of left) ctx.lineTo(x, y);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.lineTo(right[0][0], right[0][1] - 6);
    ctx.closePath();
    ctx.fill();

    // Rotation streaks
    ctx.strokeStyle = `rgba(140,140,140,${0.3 * T.alpha})`;
    ctx.lineWidth = 1;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * reach;
        const f = funnelAt(T, t, game.t);
        const phase = Math.sin(game.t * 5 + k * 1.7 + t * 3);
        const x = T.x + f.xo - cam + phase * f.w * 0.42;
        if (i === 0) ctx.moveTo(x, f.y); else ctx.lineTo(x, f.y);
      }
      ctx.stroke();
    }

    // Debris cloud at the base
    if (tornadoOnGround(T)) {
      for (const p of game.dust) {
        const px = p.x - cam + Math.cos(p.a) * p.r;
        const a = clamp(p.life / p.max, 0, 1) * 0.55 * T.alpha;
        ctx.fillStyle = `rgba(60,60,60,${a})`;
        ctx.beginPath(); ctx.arc(px, p.y, 6 + p.r * 0.25, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function drawCar(c, cam) {
    const sx = c.x - cam;
    const y = ROAD_Y;
    ctx.save();
    ctx.translate(sx, y);
    ctx.scale(c.dir, 1);
    // Body: early-2000s Pontiac Vibe silhouette (front faces +x).
    const hurtFlash = c.hurt > 0 && Math.floor(c.hurt * 30) % 2;
    ctx.fillStyle = hurtFlash ? '#f4f1ea' : '#e0201a';
    ctx.beginPath();
    ctx.moveTo(-34, -9);
    ctx.lineTo(-34, -22);   // upright rear hatch
    ctx.lineTo(-32, -34);
    ctx.lineTo(-27, -37);   // top of hatch
    ctx.lineTo(4, -37);     // long, flat roofline
    ctx.lineTo(9, -35);
    ctx.lineTo(21, -23);    // steeply raked windshield
    ctx.lineTo(33, -19);    // short sloping hood
    ctx.quadraticCurveTo(36, -17, 35, -9);
    ctx.closePath();
    ctx.fill();
    // Rear spoiler lip
    ctx.fillStyle = hurtFlash ? '#f4f1ea' : '#e0201a';
    ctx.beginPath();
    ctx.moveTo(-28, -37); ctx.lineTo(-36, -38); ctx.lineTo(-35, -35); ctx.lineTo(-29, -35);
    ctx.closePath(); ctx.fill();
    // Black lower cladding and bumpers
    ctx.fillStyle = '#1b1b1d';
    ctx.fillRect(-34, -13, 69, 5);
    // Windows: rear quarter, rear door, front door
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.moveTo(-31, -24); ctx.lineTo(-29.5, -33); ctx.lineTo(-23, -33); ctx.lineTo(-23, -24); ctx.closePath(); ctx.fill();
    ctx.fillRect(-21, -33, 12, 9);
    ctx.beginPath();
    ctx.moveTo(-7, -24); ctx.lineTo(-7, -33); ctx.lineTo(6, -33); ctx.lineTo(16, -24); ctx.closePath(); ctx.fill();
    // Door seams and handles
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-8, -24); ctx.lineTo(-8, -13); ctx.moveTo(17, -23); ctx.lineTo(17, -13); ctx.stroke();
    ctx.fillStyle = '#1b1b1d';
    ctx.fillRect(-14, -21, 4, 1.5);
    ctx.fillRect(9, -21, 4, 1.5);
    // Roof rails
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-26, -39); ctx.lineTo(4, -39); ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-24, -39); ctx.lineTo(-24, -37); ctx.moveTo(2, -39); ctx.lineTo(2, -37); ctx.stroke();
    // Whip antenna for the chase
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-18, -37); ctx.lineTo(-24, -54); ctx.stroke();
    // Lights: tall rear lamp, swept headlight, split grille
    ctx.fillStyle = '#141414';
    ctx.fillRect(-34, -30, 2.5, 9);
    ctx.fillStyle = '#f4f1ea';
    ctx.beginPath(); ctx.moveTo(27, -20); ctx.lineTo(34, -18); ctx.lineTo(34, -15); ctx.lineTo(28, -16.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1b1b1d';
    ctx.fillRect(32, -14, 3, 2);
    // Wheels
    for (const wx of [-21, 22]) {
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(wx, -6, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1.5;
      const a = c.wheel * c.dir;
      ctx.beginPath();
      ctx.moveTo(wx + Math.cos(a) * 5, -6 + Math.sin(a) * 5);
      ctx.lineTo(wx - Math.cos(a) * 5, -6 - Math.sin(a) * 5);
      ctx.stroke();
    }
    ctx.restore();
  }

  function text(str, x, y, { size = 14, weight = 600, align = 'left', color = '#f4f1ea', alpha = 1 } = {}) {
    ctx.font = `${weight} ${size}px Manrope, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#141414';
    ctx.strokeText(str, x, y);
    ctx.fillText(str, x, y);
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    const g = game;
    text(`FILM ${g.film}/${FILM}`, 18, 22);
    text(`SCORE ${g.score}`, 18, 44, { weight: 300 });
    const left = Math.max(0, DAY_LENGTH - g.t);
    const m = Math.floor(left / 60), s = Math.floor(left % 60);
    text(`SUNSET ${m}:${String(s).padStart(2, '0')}`, W - 18, 22, { align: 'right' });

    // Car health
    text('CAR', 18, H - 22, { size: 12 });
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(52, H - 28, 140, 12);
    ctx.fillStyle = g.car.hp > 30 ? '#fff' : '#e0201a';
    ctx.fillRect(52, H - 28, 140 * (g.car.hp / 100), 12);

    // Range to tornado
    const T = g.tor;
    if (T && T.alpha > 0.2) {
      const gx = tornadoGroundX(T);
      const d = Math.abs(g.car.x - gx);
      text(`RANGE ${(d * MI_PER_PX).toFixed(1)} mi`, W - 18, H - 22, { align: 'right', size: 12 });
      const sx = gx - g.camX;
      if (sx < 0 || sx > W) {
        const left = sx < 0;
        const ax = left ? 22 : W - 22, ay = 250;
        ctx.fillStyle = '#e0201a';
        ctx.beginPath();
        ctx.moveTo(ax + (left ? -10 : 10), ay);
        ctx.lineTo(ax + (left ? 8 : -8), ay - 12);
        ctx.lineTo(ax + (left ? 8 : -8), ay + 12);
        ctx.closePath();
        ctx.fill();
        text(`${(d * MI_PER_PX).toFixed(1)} mi`, ax + (left ? 14 : -14), ay + 26, { size: 11, align: left ? 'left' : 'right' });
      }
    } else {
      text('SCANNING THE SKY…', W - 18, H - 22, { align: 'right', size: 12, weight: 300 });
    }

    if (g.msgT > 0) {
      text(g.msg, W / 2, 70, { size: 18, align: 'center', alpha: Math.min(1, g.msgT * 2) });
    }
  }

  function drawCenter(title, sub) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, W, H);
    text(title, W / 2, H / 2 - 16, { size: 28, align: 'center' });
    text(sub, W / 2, H / 2 + 22, { size: 15, weight: 300, align: 'center' });
  }

  function drawTitle() {
    text('CHASE DAY', W / 2, 200, { size: 54, weight: 700, align: 'center', color: '#e0201a' });
    text('Drive close. Take the picture. Get out alive.', W / 2, 250, { size: 17, weight: 300, align: 'center' });
    text('Press SPACE or tap to start', W / 2, 300, { size: 15, align: 'center', alpha: 0.8 + 0.2 * Math.sin(performance.now() / 300) });
    if (best > 0) text(`Best: ${best}`, W / 2, 334, { size: 13, weight: 300, align: 'center' });
  }

  // ---------------------------------------------------------------- contact sheet
  const sheet = document.getElementById('sheet');
  const sheetGrid = document.getElementById('sheet-grid');
  const sheetSummary = document.getElementById('sheet-summary');
  document.getElementById('again').addEventListener('click', () => {
    initAudio();
    startGame();
    canvas.scrollIntoView({ behavior: 'smooth', block: 'center' });
    canvas.focus();
  });

  function showContactSheet() {
    const g = game;
    sheetGrid.textContent = '';
    const top = g.photos.reduce((m, p) => Math.max(m, p.points), 0);
    if (!g.photos.length) {
      const p = document.createElement('p');
      p.style.color = '#ddd';
      p.textContent = 'You didn\'t take a single frame.';
      sheetGrid.appendChild(p);
    }
    for (const p of g.photos) {
      const fig = document.createElement('figure');
      if (top > 0 && p.points === top) fig.className = 'best';
      if (p.src) {
        const img = document.createElement('img');
        img.src = p.src;
        img.alt = `Frame ${p.frame}: ${p.label}`;
        fig.appendChild(img);
      }
      const cap = document.createElement('figcaption');
      const b = document.createElement('b');
      b.textContent = `${String(p.frame).padStart(2, '0')}  ·  ${p.points} pts`;
      cap.appendChild(b);
      cap.appendChild(document.createElement('br'));
      cap.appendChild(document.createTextNode(p.label));
      fig.appendChild(cap);
      sheetGrid.appendChild(fig);
    }
    const isBest = g.score > 0 && g.score >= best;
    sheetSummary.textContent = `${g.endReason} ${g.photos.length} frames exposed. Score ${g.score}` +
      (isBest ? '. A new personal best!' : `. Best ${best}.`);
    sheet.style.display = 'block';
  }

  // ---------------------------------------------------------------- loop
  game = newGame();
  spawnTornado(0);
  game.tor.x = 260; game.tor.phase = 'mature'; game.tor.alpha = 1; game.tor.life = 1e9; game.tor.core = 1;

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state !== 'paused') update(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Exposed for automated tests.
  window.__chaseDay = { get state() { return state; }, get game() { return game; } };
})();
