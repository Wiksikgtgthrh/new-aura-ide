import * as THREE from 'three';

// Lightning (PLAN 3), timed against high-speed strike footage (Dan Robinson / Tom Warner style).
// Thunderstrike: charge (micro-arcs over the focus, ionisation motes falling in, a cloud cap
// gathering over the target, the floor dampening under it); a dim stepped leader with branches
// feeling their way down in pulses, upward streamers rising to meet it; the blinding return stroke
// climbing the main channel; a few restrikes, each preceded by a dart leader down the same channel
// with the branches gone; then the residual channel, cooling from blue-white to rose and breaking
// into beads. A line light hangs on the channel (never inside the target's own capsule, or the
// target's shadow swallows the whole floor), so floor, pillars and dummies pulse with each stroke
// and throw shadows. Ionised air and smoke at the strike point, Lichtenberg scorch, blue sparks
// and heavy molten spatter, arcs crawling over the floor (further on wet ground), thunder
// arriving distance / 343 m/s after the stroke.
// Chain Arc: a thick channelled arc that jumps from dummy to dummy.

const SOUND_SPEED = 343;
const LEADER = 0.26, LEADER_STEPS = 16, RISE = 1 / 30, DART = 1 / 30;   // seconds
const PEAK = [1, 0.62, 0.42, 0.3, 0.22];       // later strokes are weaker
const CORE_WIDTH = [0.16, 0.1, 0.075, 0.06, 0.05];
const BOLT_INTENSITY = 38, LIGHT_GAIN = 60;
const MAX_CRAWL = 6, MAX_CHAIN = 3, MAX_STREAMERS = 3, CHARGE_ARCS = 4;
const GLOOM = 0.45;   // storm light: exposure the strike takes away, so a dusk sky doesn't wash the bolt out
const SHOCK = 0.15;   // the dummy's crackle: at 1 it clips to white marble
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export default {
  id: 'lightning', name: 'Lightning', key: '1', hue: '#7fb4ff',
  shape: 'strike', forms: ['Thunderstrike', 'Chain Arc'],
  params: { intensity: 1, branches: 8, jag: 0.085, restrikes: 3, sparks: 1, crawl: 1, cloud: 1, damp: 1, core: '#d6e6ff', glow: '#5b78ff' },
  ranges: { intensity: [0.1, 3, 0.01], branches: [0, 8, 1], jag: [0.02, 0.3, 0.005], restrikes: [1, 5, 1], sparks: [0, 3, 0.01], crawl: [0, 3, 0.01], cloud: [0, 2, 0.01], damp: [0, 2, 0.01] },
  presets: {
    crimson: { core: '#ffd0d0', glow: '#ff2a3c' },
    violet: { core: '#efd8ff', glow: '#8a3dff' },
    'white hot': { core: '#ffffff', glow: '#b8c8ff', intensity: 1.6 },
  },
  timing: { charge: 0.6, impact: 0.8, linger: 1.6, sustain: 1.8 },
  kinds: {
    spark: { style: 'glow', drag: 0.4, gravity: 9.8, restitution: 0.4, friction: 0.35, life: [0.12, 0.6], size: [0.016, 0.005], stretch: 0.04, emissive: 3, color: ['#dfe9ff', '#5f7cff'], alpha: [1, 0], paints: 'heat', paintAmount: 0.03 },
    // molten spatter: low drag, heavy, skitters over the floor and burns in
    ember: { style: 'glow', drag: 0.22, gravity: 9.8, restitution: 0.45, friction: 0.45, life: [0.5, 1.5], size: [0.02, 0.007], stretch: 0.03, emissive: 4, color: ['#fff0d0', '#ff5a14'], alpha: [1, 0], fadeOut: 0.35, paints: 'heat', paintAmount: 0.02 },
    mote: { style: 'glow', drag: 1.2, life: [0.35, 0.7], size: [0.018, 0.006], stretch: 0.02, emissive: 5, color: ['#cfe0ff', '#7a9bff'], alpha: [0, 1], fadeIn: 0.5, fadeOut: 0.2, forceResponse: 1 },
    ozone: { style: 'glow', drag: 2, buoyancy: 0.4, curl: 1.2, curlScale: 0.6, life: [0.8, 1.6], size: [0.015, 0.005], emissive: 2, color: ['#9fc0ff', '#4a6aff'], alpha: [0.8, 0] },
    // ionised air: a soft violet-blue bloom hugging the strike, gone in a few frames
    ion: { style: 'media', emissive: 2.2, drag: 2.5, buoyancy: 0.25, curl: 0.8, curlScale: 0.35, life: [0.12, 0.3], size: [0.2, 0.85], color: ['#8fa4ff', '#4a35ff'], alpha: [0.2, 0], density: 0.35, erosion: 0.7, fadeIn: 0.03, fadeOut: 0.6 },
    cloud: { style: 'media', drag: 1.5, curl: 0.4, curlScale: 0.08, life: [2.2, 3], size: [2.6, 4.2], color: ['#1b1f2a', '#141720'], alpha: [0.1625, 0], density: 0.9, erosion: 0.4, fadeIn: 0.35, fadeOut: 0.4, forceResponse: 0.2, lightResponse: 2.5 },
    smoke: { style: 'media', drag: 1.5, buoyancy: 0.9, curl: 1.3, life: [1.1, 2.4], size: [0.25, 1.2], color: ['#3a3d45', '#26282e'], alpha: [0.09, 0], density: 1.2, erosion: 0.65, lightResponse: 1.2 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const spark = P.emitter('lightning.spark', { shape: 'sphere', radius: 0.06, spread: 7, radial: 2 });
    const ember = P.emitter('lightning.ember', { shape: 'sphere', radius: 0.08, spread: 3.6, radial: 2.4 });
    const mote = P.emitter('lightning.mote', { shape: 'shell', radius: 2.2, spread: 0.2 });
    const ozone = P.emitter('lightning.ozone', { shape: 'sphere', radius: 1.4, spread: 0.3 });
    const ion = P.emitter('lightning.ion', { shape: 'sphere', radius: 0.45, spread: 0.7 });
    const cloud = P.emitter('lightning.cloud', { shape: 'disk', radius: 4, spread: 0.3 });
    const smoke = P.emitter('lightning.smoke', { shape: 'disk', radius: 1.2, spread: 0.4 });
    const V3 = () => new THREE.Vector3();
    const core = new THREE.Color(), glow = new THREE.Color(), glowDim = new THREE.Color(), lightCol = new THREE.Color();
    const leaderCol = new THREE.Color(), WARM = new THREE.Color('#ffa487'), EMBER = new THREE.Color('#ff7a2e'), warmGlow = new THREE.Color();
    const _a = V3(), _b = V3(), _c = V3();
    const SCORCH = new THREE.Color(1, 0.4, 0.1);   // impacts.add allocates its default colour when given none

    function look(p) {
      core.set(p.core); glow.set(p.glow);
      glowDim.copy(glow).multiplyScalar(0.11);
      lightCol.copy(core).lerp(glow, 0.35);
      leaderCol.copy(core).lerp(glow, 0.6);
      warmGlow.copy(WARM).lerp(glow, 0.5).multiplyScalar(0.05);
    }

    // per-cast state by cast index: nothing allocated per cast
    const st = Array.from({ length: 16 }, () => ({
      arcs: new Array(CHARGE_ARCS).fill(null), crawl: new Array(MAX_CRAWL).fill(null), nc: 0,
      streamers: new Array(MAX_STREAMERS).fill(null), ns: 0, tips: Array.from({ length: MAX_STREAMERS }, V3),
      main: null, L: null, hot: null, attract: null, sky: V3(), g: V3(), f: V3(),
      at: new Float32Array(PEAK.length), rev: new Float32Array(LEADER_STEPS), strikes: 0, n: 0, shR: 0, shC: V3(), hp: V3(),
      order: new Int8Array(MAX_CHAIN), hops: 0, reseed: 0, damp: 0, thunderAt: 0, thunder: false, punched: false, flash: 0,
    }));
    const BOLT = { a: V3(), b: V3(), branches: 8, subBranches: 12, jag: 0.085, width: 0.03, color: core, glowColor: glowDim, intensity: 0, glowWidth: 12, reveal: 1, snapToArena: false, seed: 1, branchSeed: 1, rough: 0.62, fine: 1, vary: 1, branchLevel: 1 };
    function bolt(a, b, branches, sub, jag, width, glowWidth, reveal, snap, seed, branchSeed, branchLevel) {
      BOLT.a.copy(a); BOLT.b.copy(b); BOLT.branches = branches; BOLT.subBranches = sub; BOLT.jag = jag; BOLT.width = width;
      BOLT.glowWidth = glowWidth; BOLT.reveal = reveal; BOLT.snapToArena = snap; BOLT.seed = seed; BOLT.branchSeed = branchSeed; BOLT.branchLevel = branchLevel;
      return fx.bolts.acquire(BOLT);
    }
    const seedInt = () => (fx.rand() * 16777215) | 0;
    const seeded = (c, k) => ((c.seed * 2654435761 + k * 40503) >>> 0) & 0xffffff;
    const SPL = { x: 0, z: 0, radius: 1, heat: 0, char: 0, wet: 0, glow: 0, pattern: 'lichtenberg', seed: 0 };
    function splat(x, z, radius, heat, char, wet, glowAmt, pattern, seed) {
      SPL.x = x; SPL.z = z; SPL.radius = radius; SPL.heat = heat; SPL.char = char; SPL.wet = wet; SPL.glow = glowAmt; SPL.pattern = pattern; SPL.seed = seed;
      fx.ground.splat(SPL);
    }
    const SHK = { pos: V3(), radius0: 0.2, radius1: 5, duration: 0.35, thickness: 0.5, distortion: 0.05, ground: true, intensity: 0 };

    // chain targets: the hit dummy, then the nearest unvisited ones within 9 m
    function chain(d, c) {
      let cur = c.to, used = 0;
      d.hops = 0;
      if (c.target >= 0) { d.order[d.hops++] = c.target; used = 1 << c.target; cur = fx.dummies[c.target].pos; }
      while (d.hops < MAX_CHAIN) {
        let best = -1, bd = 9;
        for (let j = 0; j < fx.dummies.length; j++) {
          if (used & (1 << j)) continue;
          const dd = fx.dummies[j].pos.distanceTo(cur);
          if (dd < bd) { bd = dd; best = j; }
        }
        if (best < 0) break;
        used |= 1 << best;
        d.order[d.hops++] = best;
        cur = fx.dummies[best].pos;
      }
    }
    function releaseAll(d) {
      for (let i = 0; i < CHARGE_ARCS; i++) { d.arcs[i]?.release(); d.arcs[i] = null; }
      for (let i = 0; i < MAX_CRAWL; i++) { d.crawl[i]?.release(); d.crawl[i] = null; }
      for (let i = 0; i < MAX_STREAMERS; i++) { d.streamers[i]?.release(); d.streamers[i] = null; }
      d.nc = d.ns = 0;
      d.main?.release(); d.L?.release(); d.hot?.release(); d.attract?.release();
      d.main = d.L = d.hot = d.attract = null;
    }
    // the line light hangs on the channel, ending above the target's capsule
    function hangLight(L, m) {
      m.point(0.85, L.end);
      L.end.y = Math.max(L.end.y, 2.8);
      // on past the bolt's top: the top's mirror image is a blob on wet floor, this puts it behind the camera
      L.pos.copy(m.a).sub(L.end).multiplyScalar(1.8).add(L.end);
    }

    return {
      phase(c, name) {
        const p = S.params, d = st[c.index];
        look(p);
        if (name === 'charge') {
          releaseAll(d);
          c.data.shielded = false;
          for (let i = 0; i < CHARGE_ARCS; i++) d.arcs[i] = bolt(fx.ARENA.focus, _a.copy(fx.ARENA.focus).setY(2), 0, 0, 0.25, 0.012, 8, 1, false, seedInt(), seedInt(), 1);
          d.L = fx.lights.acquire();
          if (d.L) { d.L.range = 7; d.L.color.copy(lightCol); d.L.intensity = 0; }
          d.hot = fx.lights.acquire();
          if (d.hot) { d.hot.range = 9; d.hot.intensity = 0; }
          d.attract = fx.forces.acquire();
          if (d.attract) { Object.assign(d.attract, { type: 2 }); d.attract.p[0] = 30; d.attract.p[1] = 0.6; d.attract.p[2] = 0.12; d.attract.p[3] = 3.5; d.attract.pos.copy(c.from); }
          d.sky.set(c.to.x + (fx.rand() - 0.5) * 5, 18, c.to.z + (fx.rand() - 0.5) * 5);
          d.strikes = 0; d.reseed = 0; d.damp = 0; d.thunder = false; d.punched = false; d.flash = 0;
        } else if (name === 'impact') {
          for (let i = 0; i < CHARGE_ARCS; i++) { d.arcs[i]?.release(); d.arcs[i] = null; }
          d.attract?.release(); d.attract = null;
          if (c.form === 'Thunderstrike') startStrike(c, p, d);
          else startChain(c, p, d);
        } else if (name === 'done') { releaseAll(d); c.data.shielded = false; }
      },

      update(c, dt) {
        const p = S.params, d = st[c.index];
        look(p);
        if (c.phase === 'charge') updateCharge(c, p, d, dt);
        else if (c.form === 'Thunderstrike') updateStrike(c, p, d, dt);
        else updateChain(c, p, d, dt);
        // storm light: the frame dims with the charge and comes back through the aftermath; the
        // flash decays on top of it. main clamps post.params.flash to >= 0 after every frame, so
        // this is written per frame and dies with the cast.
        // ponytail: last writer wins, another spell's flash during this cast is lost; add a shared gloom term if casts overlap often
        const amount = c.phase === 'charge' ? c.t / c.durations.charge : c.phase === 'linger' ? 1 - c.t / c.durations.linger : 1;
        d.flash *= Math.exp(-dt * 7);
        fx.post.params.flash = d.flash - GLOOM * (c.form === 'Thunderstrike' ? 1 : 0.5) * amount;
      },
    };

    function updateCharge(c, p, d, dt) {
      const k = c.t / c.durations.charge, L = d.L;
      // micro-arcs over the orb, reseeded every 50 ms
      d.reseed -= dt;
      for (let i = 0; i < CHARGE_ARCS; i++) {
        const h = d.arcs[i];
        if (!h) continue;
        if (d.reseed <= 0) {
          h.a.copy(c.from).add(_a.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).normalize().multiplyScalar(0.28));
          h.b.copy(c.from).add(_a.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).normalize().multiplyScalar(0.28 + 0.5 * k * fx.rand()));
          h.seed = seedInt();
        }
        h.intensity = 25 * p.intensity * (0.4 + 0.6 * k) * (fx.rand() < 0.75 ? 1 : 0);
      }
      if (d.reseed <= 0) d.reseed = 0.05;
      mote.pos.copy(c.from); mote.vel.set(0, 0, 0); mote.rate(2400 * p.sparks * k, dt);
      if (p.cloud > 0) { cloud.pos.copy(c.to).setY(15); cloud.radius = 5; cloud.rate(110 * p.cloud, dt); }
      if (L) { L.pos.copy(c.from); L.intensity = 10 * p.intensity * k * (0.6 + 0.4 * fx.rand()); }
      // the storm dampens the floor under it, up to a slick, not a flood
      d.damp -= dt;
      if (p.damp > 0 && c.form === 'Thunderstrike' && d.damp <= 0) {
        d.damp = 0.25;
        if ((fx.groundAt(c.to.x, c.to.z)?.[2] ?? 0) < 0.55) splat(c.to.x, c.to.z, 7, 0, 0, 0.25 * p.damp, 0, 'noise', c.seed % 1000);
      }
    }

    // --- Thunderstrike ---------------------------------------------------------------------
    function startStrike(c, p, d) {
      // it strikes the highest thing there: the crown of a dummy, then the current runs down to the floor.
      // Under an Aegis it is the shield's crown, and the current skates over the shell to the floor ring
      d.g.copy(c.to);
      d.shR = fx.spells.arcane?.inst?.shieldOver?.(c.to.x, c.to.z, d.shC) ?? 0;
      if (d.shR > 0) {
        c.data.shielded = true;   // Aegis: this strike reports its own hits (at the return strokes)
        d.g.copy(d.shC).y += d.shR;
        const a = fx.rand() * Math.PI * 2, rf = Math.sqrt(Math.max(d.shR * d.shR - d.shC.y * d.shC.y, 0.01));
        d.f.set(d.shC.x + Math.cos(a) * rf, 0, d.shC.z + Math.sin(a) * rf);
      } else {
        if (c.target >= 0) d.g.y = fx.ARENA.dummyHeight + 0.02;
        else d.g.y = Math.max(d.g.y, 0);
        d.f.copy(d.g).setY(0);
      }
      const g = d.g;
      const m = d.main = bolt(d.sky, g, p.branches, Math.round(p.branches * 1.5), p.jag, 0.028, 9, 0, false, seeded(c, 1), seeded(c, 2), 0.8);
      // leader: uneven steps, the pauses and lunges of the real thing
      let s = 0;
      for (let i = 0; i < LEADER_STEPS; i++) { s += 0.35 + 1.3 * fx.rand(); d.rev[i] = s; }
      for (let i = 0; i < LEADER_STEPS; i++) d.rev[i] *= 0.9 / s;
      // strokes
      d.n = Math.min(p.restrikes, PEAK.length);
      let t = LEADER;
      for (let i = 0; i < d.n; i++) { d.at[i] = t; t += (i === 0 ? 0.12 : 0.09) + 0.05 * fx.rand(); }
      if (d.L) { d.L.type = 1; d.L.range = 28; d.L.shadow = true; if (m) hangLight(d.L, m); }
      // the strike point is a point source low down: hard shadows thrown away from it, stroke by stroke.
      // Off the struck dummy's axis (inside its capsule its own shadow would swallow the floor)
      if (d.shR > 0) _a.subVectors(d.f, d.shC); else _a.subVectors(d.sky, d.f);
      _a.y = 0; if (_a.lengthSq() < 1e-6) _a.set(1, 0, 0);
      d.hp.copy(d.f).addScaledVector(_a.normalize(), d.shR > 0 ? 0.3 : 0.7).setY(0.5);
      if (d.hot) { d.hot.type = 0; d.hot.shadow = true; }
      d.thunderAt = LEADER + c.to.distanceTo(fx.camera.position) / SOUND_SPEED;
      // upward streamers: from the strike point to the leader's tip, and failed ones off the nearest other dummies
      d.ns = 0;
      if (m) {
        m.point(0.86, d.tips[0]);
        d.streamers[d.ns++] = bolt(g, d.tips[0], 1, 1, 0.13, 0.012, 7, 0, false, seeded(c, 3), seeded(c, 4), 0.6);
        for (let j = 0; j < fx.dummies.length && d.ns < MAX_STREAMERS; j++) {
          const dm = fx.dummies[j].pos;
          if (j === c.target || dm.distanceTo(g) > 9) continue;
          _a.copy(dm).setY(fx.ARENA.dummyHeight);
          d.tips[d.ns].copy(_a).add(_b.set((fx.rand() - 0.5) * 0.8, 1.1 + 0.9 * fx.rand(), (fx.rand() - 0.5) * 0.8));
          d.streamers[d.ns] = bolt(_a, d.tips[d.ns], 0, 0, 0.14, 0.009, 7, 0, false, seeded(c, 5 + j), seeded(c, 8 + j), 0);
          d.ns++;
        }
      }
    }

    function updateStrike(c, p, d, dt) {
      const m = d.main, L = d.L, hot = d.hot, T = c.phase === 'impact' ? c.t : c.durations.impact + c.t;
      const dim = fx.reduced ? 0.35 : 1;
      if (!m) return;
      if (T < LEADER) {
        // stepped leader: dim and violet, every step a pulse at the tip
        const x = (T / LEADER) * LEADER_STEPS, k = Math.min(x | 0, LEADER_STEPS - 1);
        const len = d.rev[k] - (k ? d.rev[k - 1] : 0), pulse = Math.exp(-(x - k) * 2.2);
        m.reveal = d.rev[k];
        m.intensity = (2.5 + 130 * len * pulse) * p.intensity;
        m.color.copy(leaderCol);
        if (L) {
          m.point(m.reveal, L.end);
          L.end.y = Math.max(L.end.y, 2.8);
          L.color.copy(leaderCol);
          L.intensity = m.intensity * 7 * dim;
        }
        const u = clamp01((T - (LEADER - 0.075)) / 0.075);
        for (let i = 0; i < d.ns; i++) {
          const h = d.streamers[i];
          if (!h) continue;
          h.reveal = u * (i ? 0.75 : 1);
          h.intensity = 5 * p.intensity * (0.6 + 0.4 * pulse);
          h.color.copy(leaderCol);
        }
        return;
      }
      for (let i = 0; i < d.ns; i++) { d.streamers[i]?.release(); d.streamers[i] = null; }
      d.ns = 0;
      while (d.strikes < d.n && T >= d.at[d.strikes]) { d.strikes++; strikeBurst(c, p, d, m); }
      m.reveal = 1;
      const i = d.strikes - 1, since = T - d.at[i], next = d.strikes < d.n ? d.at[d.strikes] - T : 1e9, last = d.strikes === d.n;
      const peak = PEAK[i], env = 0.75 * Math.exp(-since / 0.028) + 0.25 * Math.exp(-since / 0.1);
      // the channel keeps glowing between strokes: the residual, cooling
      const glowing = 8 * Math.exp(-since / (last ? 0.5 : 0.3));
      const cool = last ? clamp01((since - 0.08) / 0.55) : 0;
      m.color.copy(core).lerp(WARM, cool);
      m.glowColor.copy(glowDim).lerp(warmGlow, cool);
      m.residual = last ? clamp01((since - 0.12) / 1.25) : 0;
      if (next < DART) {
        // dart leader: a bright head running down the same channel, no branches
        m.dart = 1 - next / DART; m.stroke = 1; m.branchLevel = 0;
        m.intensity = (glowing + 4) * p.intensity;
        m.width = 0.04; m.glowWidth = 9;
      } else {
        m.dart = -1;
        m.stroke = Math.min(1, since / RISE);
        m.branchLevel = i === 0 ? 0.05 + 0.5 * Math.exp(-since / 0.07) : 0.1 * Math.exp(-since / 0.03);
        m.intensity = (BOLT_INTENSITY * peak * env + glowing) * p.intensity;
        m.width = 0.04 + (CORE_WIDTH[i] - 0.04) * env + 0.035 * cool;
        m.glowWidth = 9 + (i === 0 ? 18 : 11) * env;   // the air around the stroke glows metres wide, for a frame or two
      }
      if (m.intensity < 0.03) m.intensity = 0;
      if (!d.punched && since >= RISE) { d.punched = true; if (!fx.reduced) { fx.rig.punch(2, 0.06); fx.rig.hitstop(0.03); } }
      if (L) {
        // never quite black between strokes, the channel still glows; a smear of the stroke's rise
        L.color.copy(lightCol).lerp(WARM, cool);
        L.intensity = (m.dart >= 0 ? m.intensity * 3 : m.intensity * LIGHT_GAIN * Math.min(1, m.stroke + 0.25)) * dim;
      }
      if (hot) {
        const ember = 5 * Math.exp(-since / 0.25);
        hot.pos.copy(d.hp);
        hot.color.copy(lightCol).lerp(EMBER, clamp01(since / 0.12));
        hot.intensity = (BOLT_INTENSITY * peak * env * 1.5 + ember) * p.intensity * dim;
      }
      if (!d.thunder && T >= d.thunderAt) { d.thunder = true; fx.rig.shake(0.55, 30); }
      // crawl arcs flicker and fade, residual micro-arcs at decaying frequency
      const fade = Math.max(0, 1 - (T - LEADER) / (c.durations.impact + c.durations.linger - LEADER));
      for (let j = 0; j < d.nc; j++) {
        const h = d.crawl[j];
        if (!h) continue;
        h.intensity = (T - LEADER < 0.1 || fx.rand() < 0.35 * fade + 0.1) ? 11 * p.intensity * fade : 0;
        if (fx.rand() < 0.2) { h.branchSeed = seedInt(); h.seed = seedInt(); }
      }
      if (c.phase === 'linger') {
        ozone.pos.copy(d.f).setY(0.6); ozone.rate(60 * fade, dt);
        smoke.pos.copy(d.f).setY(0.15); smoke.radius = 0.5; smoke.rate(26 * fade * fade, dt);
      }
    }

    function strikeBurst(c, p, d, m) {
      const g = d.g, f = d.f, first = d.strikes === 1, floor = g.y > 0.5;
      // three flashes at most, whatever the slider says (WCAG 2.3.1)
      if (d.strikes <= 3) { fx.flash((first ? 1.1 : d.strikes === 2 ? 0.6 : 0.35) * p.intensity); d.flash = fx.post.params.flash; }
      spark.pos.copy(g).setY(Math.max(g.y, 0.05)); spark.burst((first ? 130 : 40) * p.sparks);
      ember.pos.copy(g).setY(Math.max(g.y, 0.05)); ember.burst((first ? 90 : 16) * p.sparks);
      if (floor) { spark.pos.copy(f).setY(0.05); spark.burst((first ? 90 : 20) * p.sparks); ember.pos.copy(f).setY(0.05); ember.burst((first ? 60 : 10) * p.sparks); }
      // ionised air around the contacts, and glowing round the lower channel: the halo has body
      ion.pos.copy(g).setY(Math.max(g.y, 0.3)); ion.burst(first ? 18 : 7);
      for (let k = 0; k < 6; k++) { m.point(0.62 + 0.06 * k, ion.pos); ion.burst(first ? 3 : 1); }
      if (floor) { ion.pos.copy(f).setY(0.35); ion.burst(first ? 18 : 7); }
      if (d.shR > 0) fx.spells.arcane?.inst?.hit?.(g, first ? 2 : 1.1, glow);
      if (!first) return;
      // the strike blasts a dust / steam puff up off the floor: a rising column, not a flat layer
      smoke.pos.copy(f).setY(0.25); smoke.radius = 0.4; smoke.vel.set(0, 2.2, 0); smoke.burst(55);
      smoke.radius = 0.9; smoke.vel.set(0, 0.6, 0); smoke.burst(25); smoke.vel.set(0, 0, 0);
      // the channels flash the film of water off: a wet floor's mirror would otherwise hide the burn
      splat(f.x, f.z, 3, 0.5, 1, -1, 0, 'lichtenberg', c.seed % 1000);
      // a brief blue crawl on the surfaces, not a mark: at full strength it clips white
      fx.impacts.add('electric', f, 2.2, 0.1, 0.5, glow);
      fx.impacts.add('scorch', f, 1.5, 0.45, 8, SCORCH);
      SHK.pos.copy(f).setY(0.05);
      fx.shocks?.spawn(SHK);
      // floor crawl: short snapped arcs, long ones over wet ground
      const wet = isWet(f);
      const n = Math.min(MAX_CRAWL, Math.round(6 * p.crawl));
      d.nc = 0;
      if (d.shR > 0) {
        // over the shell: three chords of the great circle from the crown down to the floor ring
        _c.subVectors(f, d.shC).normalize();
        const end = Math.acos(Math.max(-1, -d.shC.y / d.shR));
        for (let i = 0; i < 3 && d.nc < MAX_CRAWL; i++) {
          const t0 = (i / 3) * end, t1 = ((i + 1) / 3) * end;
          _a.copy(d.shC).addScaledVector(_c, Math.sin(t0) * d.shR * 1.02).y += Math.cos(t0) * d.shR * 1.02;
          _b.copy(d.shC).addScaledVector(_c, Math.sin(t1) * d.shR * 1.02).y += Math.cos(t1) * d.shR * 1.02;
          _b.y = Math.max(_b.y, 0.03);
          const h = bolt(_a, _b, 1, 1, 0.12, 0.02, 9, 1, false, seeded(c, 70 + i), seeded(c, 80 + i), 0.5);
          if (h) d.crawl[d.nc++] = h;
        }
        _c.set(0, 0, 0);
      }
      for (let i = 0; d.nc < n; i++) {
        const ang = (i / Math.max(n, 1)) * Math.PI * 2 + fx.rand();
        const len = (wet ? 4 + 5 * fx.rand() : 1 + 1.6 * fx.rand()) * p.crawl;
        _b.set(f.x + Math.cos(ang) * len, 0.02, f.z + Math.sin(ang) * len);
        const h = bolt(_a.copy(f).setY(0.05), _b, 2, 2, 0.16, 0.01, 7, 1, true, seeded(c, 40 + i), seeded(c, 60 + i), 0.7);
        if (!h) break;
        d.crawl[d.nc++] = h;
      }
      if (wet) {
        fx.pool?.flash?.(glow, 1.5);
        fx.pool?.ripple?.(f.x, f.z, 0.05, 0.5);
        splat(f.x, f.z, 6, 0, 0, 0, 0.25, 'lichtenberg', c.seed % 777);
      }
      for (const dm of fx.dummies) {
        const dist = Math.hypot(dm.pos.x - f.x, dm.pos.z - f.z);
        if (d.shR > 0 && Math.hypot(dm.pos.x - d.shC.x, dm.pos.z - d.shC.z) < d.shR) continue;   // the shield holds
        if (dist < (wet ? 7 : 2.5)) { dm.status.shock = SHOCK; dm.status.burn = Math.max(dm.status.burn, 0.4); dm.hit(_c.subVectors(dm.pos, f).setY(0).normalize(), 0.6); }
      }
    }

    // wet = inside the pool or soaked (the storm's own damp stays below this)
    function isWet(g) {
      const pool = fx.ARENA.pool;
      if (Math.abs(g.x - pool.center.x) < pool.half.x && Math.abs(g.z - pool.center.y) < pool.half.y) return true;
      return (fx.groundAt(g.x, g.z)?.[2] ?? 0) > 0.65;
    }

    // --- Chain Arc: focus -> target -> nearest dummies -------------------------------------
    function startChain(c, p, d) {
      chain(d, c);
      d.nc = 0;
      _a.copy(c.from);
      for (let i = 0; i < d.hops; i++) {
        _b.copy(fx.dummies[d.order[i]].pos).setY(1.1);
        const h = bolt(_a, _b, 3, 4, p.jag * 1.25, 0.03, 8, 0, false, seeded(c, 10 + i), seeded(c, 20 + i), 0.5);
        if (h) d.crawl[d.nc++] = h;
        _a.copy(_b);
      }
      if (!d.nc) return;
      // focus -> first dummy casts the shadows; the jumps beyond it just add light
      if (d.L) {
        const f = d.crawl[0];
        d.L.type = 1; d.L.range = 20; d.L.shadow = true;
        d.L.pos.copy(f.a);
        d.L.end.lerpVectors(f.a, f.b, 0.86).setY(Math.max(f.a.y, 2.2));
      }
      if (d.hot) {
        const l = d.crawl[d.nc - 1];
        d.hot.type = 1; d.hot.range = 14; d.hot.shadow = false;
        d.hot.pos.copy(d.crawl[0].b).setY(2.2); d.hot.end.copy(l.b).setY(2.2);
      }
    }

    function updateChain(c, p, d, dt) {
      const on = c.phase === 'impact', L = d.L, hot = d.hot, dim = fx.reduced ? 0.35 : 1;
      if (!d.nc) return;
      d.reseed -= dt;
      const reseed = d.reseed <= 0;
      if (reseed) d.reseed = 0.06;
      const flick = on ? 0.6 + 0.4 * fx.rand() : 0;
      const decay = on ? 0 : clamp01(c.t / 0.45);
      for (let i = 0; i < d.nc; i++) {
        const h = d.crawl[i];
        if (!h) continue;
        // the arc jumps on from dummy to dummy
        h.reveal = on ? clamp01((c.t - i * 0.07) / 0.034) : 1;
        if (reseed && on) { h.seed = seedInt(); h.branchSeed = seedInt(); }
        h.width = on ? 0.026 + 0.018 * flick : 0.026;
        h.residual = decay;
        h.color.copy(core).lerp(WARM, decay);
        h.glowColor.copy(glowDim).lerp(warmGlow, decay);
        h.intensity = on ? 30 * flick * p.intensity : Math.max(0, h.intensity * Math.exp(-dt * 9));
        if (reseed && on && h.reveal >= 1) {
          const dm = fx.dummies[d.order[i]];
          spark.pos.copy(dm.pos).setY(1.1); spark.burst(26 * p.sparks);
          ember.pos.copy(dm.pos).setY(1.1); ember.burst(6 * p.sparks);
          ion.pos.copy(dm.pos).setY(1.1); ion.burst(3);
          dm.status.shock = SHOCK;
        }
      }
      const I = d.crawl[0]?.intensity ?? 0;
      // an arc is a thin channel: bright, but it lights the floor around it, not the whole arena flat blue
      if (L) L.intensity = I * 15 * dim;
      if (hot) { hot.color.copy(lightCol); hot.intensity = I * 8 * dim; }
    }
  },
};
