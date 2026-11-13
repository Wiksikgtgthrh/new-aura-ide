import * as THREE from 'three';
import { blackbodyRGB } from '../../vfx/noise.js';
import { BIRD_PATH, BIRD_SHADE, FEATHER_PATH, FEATHER_SHADE } from './phoenix.glsl.js';

// Phoenix (SPELLBOOK, Fire hero). Anticipation: embers spiral into the focus where a firebird forms
// with its wings wrapped round it. Release: the wings snap open and it launches up and out on an
// arcing Bezier, beating hard; it glides wide-winged over the apex and stoops into the target with
// its wings raised in a V. The bird is ~29 analytic ribbons per layer posed from 5 uniforms per bird
// (half-res flame glow with heat haze + full-res cores), with media flames shed off the trailing
// edges, wingtip wisps, a hot path trail and burning feathers that peel off and flutter down.
// Impact: the bird bursts apart into a storm of burning feathers (stateless ribbons that tumble,
// settle and burn from the tip down), a flame blast, sparks, a pressure shell that shoves loose
// particles, a shock ring, and its spread-wing silhouette scorched into the floor (hot enough to
// grow ground flames). Aftermath: smoke, light dying with the flames, and the ashes stir: a spiral
// of embers rises from the centre.

const NF = 9;    // flight feathers per wing
const NCV = 6;   // coverts per wing (short, broad, hot: they fill the inner wing)
const NT = 5;    // tail streamers
const NCR = 3;   // crest plumes
const SLOTS = 4; // birds alive at once (bird uniform slots)
const NFB = 128; // burning-feather ribbons (per layer)
const TAU = Math.PI * 2;
const SX = 0.12;

// static ribbon table for one bird: [mode, side, p1 (s|lateral, length, width, splay|phase), seed, heat]
// FEAT: the flight feathers' (s, length, splay), mirrored by featherPoint()
const RIBS = [], FEAT = [];
const ss = THREE.MathUtils.smoothstep;
for (let k = 0; k < NF; k++) {
  const s = (k + 0.5) / NF;
  FEAT.push([s, 0.6 + 0.5 * ss(s, 0.3, 0.85) - 0.12 * ss(s, 0.9, 1), 0.06 + 1.05 * s ** 1.6]);
}
RIBS.push([0, 1, [0, 0, 0, 0], 0.1, 1]);
for (const side of [1, -1]) {
  RIBS.push([1, side, [0, 0, 0.14, 0], 0.3 + side * 0.1, 1]);
  for (let k = 0; k < NF; k++) RIBS.push([2, side, [FEAT[k][0], FEAT[k][1], 0.28 - 0.06 * FEAT[k][0], FEAT[k][2]], 0.7 + k * 0.53 + side * 0.21, 1 - 0.1 * FEAT[k][0]]);
  for (let k = 0; k < NCV; k++) {
    const s = (k + 0.3) / NCV * 0.8;
    RIBS.push([2, side, [s, 0.34 + 0.08 * s, 0.32, 0.12 + 0.5 * s], 4.1 + k * 0.61 + side * 0.33, 1.05]);
  }
}
for (let i = 0; i < NT; i++) {
  const o = (i - (NT - 1) / 2) / ((NT - 1) / 2);   // -1..1
  RIBS.push([3, 1, [o * 0.17, 2.6 - 0.9 * Math.abs(o) ** 1.2, 0.14 - 0.035 * Math.abs(o), i * 1.3], 1.1 + i * 0.7, 1]);
}
for (let i = 0; i < NCR; i++) RIBS.push([4, 1, [(i - 1) * 0.07, 0.42 + 0.12 * (1 - Math.abs(i - 1)), 0.09, i * 2.1], 2.3 + i * 0.4, 1]);
const NR = RIBS.length;   // 41

// flame-ish kinds, retinted from temperature + tint like fire.js: [kind, hot x T, cold x T]
const HOT_KINDS = [['flame', 1.25, 0.38], ['ember', 1.1, 0.5], ['spark', 1.45, 0.6], ['wisp', 1.35, 0.55]];

// JS mirrors of the GLSL wing (phoenix.glsl.js): place emitters on the wing
const clamp01 = (x) => Math.min(1, Math.max(0, x));
function armFlat(s, k, out) {
  return out.set(SX + 1.4 * s * (0.3 + 0.7 * k), 0.02 * s, 0.1 + 0.2 * Math.sin(Math.PI * Math.min(s * 1.15, 1)) - 0.45 * s * s * s);
}
function foldW(p, beta) {
  const dx = p.x - SX, dz = p.z - 0.1, c = Math.cos(beta), s = Math.sin(beta);
  p.x = SX + dx * c + dz * s; p.z = 0.1 - dx * s + dz * c;
  return p;
}
function flapW(p, lag, ph, amp, dih) {
  const dx = p.x - SX, se = clamp01(dx / 1.7), x = ph - 1.1 * se - 1.6 * lag;
  const th = dih * (0.6 + 0.4 * se) + amp * (Math.sin(x) + 0.22 * Math.sin(2 * x)) * (0.45 + 0.75 * se);
  const c = Math.cos(th), s = Math.sin(th), y = p.y;
  p.x = SX + dx * c - y * s; p.y = dx * s + y * c;
  return p;
}
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export default {
  id: 'phoenix', name: 'Phoenix', element: 'fire', order: 10, hue: '#ff8a1e',
  shape: 'projectile', radius: 0.4,
  params: { size: 1, speed: 9, arc: 1, swing: 1, flap: 1, temperature: 1900, intensity: 1, flames: 1, feathers: 1, embers: 1, tail: 1, smoke: 1, haze: 1, scorch: 1, tint: '#ffffff' },
  ranges: {
    size: [0.4, 2, 0.01], speed: [4, 20, 0.1], arc: [0.3, 2, 0.01], swing: [-2, 2, 0.01], flap: [0, 2, 0.01], temperature: [900, 6500, 10],
    intensity: [0, 3, 0.01], flames: [0, 3, 0.01], feathers: [0, 3, 0.01], embers: [0, 3, 0.01], tail: [0.3, 2, 0.01], smoke: [0, 3, 0.01],
    haze: [0, 3, 0.01], scorch: [0, 2, 0.01],
  },
  presets: {
    'sun phoenix': { temperature: 2600, intensity: 1.3, tail: 1.3, smoke: 0.4 },
    'azure phoenix': { temperature: 6500, tint: '#8fb8ff', smoke: 0.3, embers: 1.4 },
    'ember hawk': { size: 0.7, speed: 13, arc: 0.6, tail: 0.7, flap: 1.4, feathers: 0.6, temperature: 1500, tint: '#ff7a5a' },
  },
  timing: { charge: 0.9, impact: 0.35, linger: 3.6, sustain: 6 },
  kinds: {
    flame: { style: 'media', drag: 3.6, buoyancy: 3.8, curl: 3.2, curlScale: 0.6, life: [0.16, 0.36], size: [0.09, 0.32], sizePow: 0.6, emissive: 1.3, temp: [2375, 720], toSmokeAt: 0.5, smokeAlbedo: 0.04, alpha: [0.75, 0], density: 9, distortion: 0.6, erosion: 1.6, fadeIn: 0.06, fadeOut: 0.3 },
    ember: { style: 'glow', drag: 0.6, buoyancy: 1.7, gravity: 1.2, curl: 2.8, curlScale: 0.5, life: [1.0, 2.6], size: [0.018, 0.006], stretch: 0.02, emissive: 5, temp: [2090, 950], restitution: 0.3, friction: 0.4, paints: 'char', paintAmount: 0.05 },
    spark: { style: 'glow', drag: 0.5, gravity: 9.8, restitution: 0.4, friction: 0.3, life: [0.3, 1.0], size: [0.026, 0.008], stretch: 0.02, emissive: 6, temp: [2750, 1140], paints: 'heat', paintAmount: 0.04 },
    // wingtip vortices: thin hot streaks peeling off the tips
    wisp: { style: 'glow', drag: 2.4, buoyancy: 1.4, curl: 2.2, curlScale: 0.45, life: [0.25, 0.6], size: [0.045, 0.012], stretch: 0.07, emissive: 3, temp: [2560, 1045], fadeIn: 0.1, fadeOut: 0.5 },
    // burst smoke: lit grey-brown soot that billows, curls and thins out (not dark balls)
    smoke: { style: 'media', emissive: 0, drag: 1.6, buoyancy: 1.9, curl: 2.4, curlScale: 0.4, life: [2.4, 4.8], size: [0.3, 2.4], sizePow: 0.5, color: ['#2b2520', '#5d554e'], alpha: [0.55, 0], density: 2.4, erosion: 1.3, fadeIn: 0.18, fadeOut: 0.5 },
    // floor dust thrown out by the blast, rolling up as it slows
    dust: { style: 'media', emissive: 0, drag: 2.6, buoyancy: 0.55, curl: 1.4, curlScale: 0.5, life: [0.9, 2.0], size: [0.25, 1.5], sizePow: 0.6, color: ['#7a6a5a', '#5a4f45'], alpha: [0.3, 0], density: 1.2, erosion: 1.0, fadeIn: 0.05, fadeOut: 0.5 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const E = {
      gather: P.emitter('phoenix.ember', { shape: 'sphere', radius: 0.2, spread: 0.6 }),
      orb: P.emitter('phoenix.flame', { shape: 'sphere', radius: 0.35, spread: 0.5 }),
      launch: P.emitter('phoenix.flame', { shape: 'shell', radius: 0.5, spread: 1.0, radial: 4 }),
      edge: P.emitter('phoenix.flame', { shape: 'line', radius: 0.06, spread: 0.5 }),
      tip: P.emitter('phoenix.wisp', { shape: 'sphere', radius: 0.08, spread: 0.6 }),
      shed: P.emitter('phoenix.wisp', { shape: 'line', radius: 0.12, spread: 1.6 }),
      ember: P.emitter('phoenix.ember', { shape: 'sphere', radius: 0.25, spread: 1.0 }),
      blast: P.emitter('phoenix.flame', { shape: 'sphere', radius: 0.5, spread: 2.0, radial: 5.5, life: 2.4 }),
      spark: P.emitter('phoenix.spark', { shape: 'sphere', radius: 0.3, spread: 7, radial: 4 }),
      smoke: P.emitter('phoenix.smoke', { shape: 'sphere', radius: 0.6, spread: 0.6 }),
      dust: P.emitter('phoenix.dust', { shape: 'ring', radius: 0.8, spread: 0.6, radial: 5 }),
      rise: P.emitter('phoenix.wisp', { shape: 'sphere', radius: 0.06, spread: 0.25 }),
    };

    // --- flame mass: every combusting volume of the spell goes through these four calls (the
    // charge orb, the launch flare, the body's flame stream, the impact blast), so the whole mass
    // can move onto the shared FluidVolume combustion solver in one place. Particles meanwhile.
    const flameMass = {
      orb(pos, k, p, dt) {
        E.orb.pos.copy(pos); E.orb.radius = 0.15 + 0.3 * k; E.orb.vel.set(0, 0.5, 0); E.orb.size = 0.6 * p.size * (0.4 + k);
        E.orb.rate(160 * p.flames * (0.3 + k), dt);
      },
      launch(pos, p) {
        E.launch.pos.copy(pos); E.launch.size = p.size; E.launch.vel.set(0, 1.5, 0); E.launch.burst(90 * p.flames);
      },
      stream(a, b, vel, p, rate, dt) {   // a line source from a to b moving with vel
        E.edge.pos.copy(a); E.edge.p.copy(b);
        E.edge.vel.copy(vel).multiplyScalar(0.7); E.edge.size = 0.9 * p.size; E.edge.rate(420 * rate, dt);
      },
      blast(pos, p) {
        E.blast.pos.copy(pos); E.blast.radius = 0.6 * p.size; E.blast.vel.set(0, 1.8, 0); E.blast.size = 1.7 * p.size; E.blast.burst(150 * p.flames * p.size);
      },
    };

    // --- shared uniforms: bird slots + fire ramp ---
    const slotV = () => Array.from({ length: SLOTS }, () => new THREE.Vector4(0, -100, 0, 0));
    const UA = slotV(), UF = slotV(), UU = slotV(), UW = slotV(), UT = slotV();
    const hot = new THREE.Color(), mid = new THREE.Color(), cool = new THREE.Color();
    const shared = {
      uBirdA: { value: UA }, uBirdF: { value: UF }, uBirdU: { value: UU }, uBirdW: { value: UW }, uBirdT: { value: UT },
      uHot: { value: hot }, uMid: { value: mid }, uCool: { value: cool }, uHaze: { value: 0.04 },
    };
    const birdFx = new fx.AnalyticRibbons({ max: NR * SLOTS, segments: 40, pathGLSL: BIRD_PATH, shadeGLSL: BIRD_SHADE, target: 'fx', uniforms: shared });
    const birdLn = new fx.AnalyticRibbons({ max: NR * SLOTS, segments: 40, pathGLSL: BIRD_PATH, shadeGLSL: BIRD_SHADE, target: 'lines', uniforms: shared });
    const featFx = new fx.AnalyticRibbons({ max: NFB, segments: 12, pathGLSL: FEATHER_PATH, shadeGLSL: FEATHER_SHADE, target: 'fx', uniforms: shared });
    const featLn = new fx.AnalyticRibbons({ max: NFB, segments: 12, pathGLSL: FEATHER_PATH, shadeGLSL: FEATHER_SHADE, target: 'lines', uniforms: shared });
    fx.scenes.fx.add(birdFx.mesh, featFx.mesh);
    fx.scenes.lines.add(birdLn.mesh, featLn.mesh);

    // burning feathers: fire and forget, released by tick() when burnt out (or by their cast's 'done')
    const feathers = Array.from({ length: NFB }, () => ({ fx: null, ln: null, birth: 0, life: 0, owner: -1 }));

    // per-cast state, indexed by the cast record (16)
    const state = Array.from({ length: 16 }, () => ({
      slot: -1, fx: new Array(NR).fill(null), ln: new Array(NR).fill(null), light: null, trail: null, shock: null,
      P0: new THREE.Vector3(), P1: new THREE.Vector3(), P2: new THREE.Vector3(), P3: new THREE.Vector3(),
      pos: new THREE.Vector3(), F: new THREE.Vector3(0, 0, 1), U: new THREE.Vector3(0, 1, 0), vel: new THREE.Vector3(), acc: new THREE.Vector3(),
      dive: new THREE.Vector3(0, 0, -1),
      s: 0, ph: 0, amp: 0, spread: 0, sweep: 0, dih: 0, bx: 0, by: 0, scale: 1, I: 0, shed: 0, flyT: 0, age: 0, splat: 0, side: 1,
    }));
    const slotOwner = new Array(SLOTS).fill(-1);

    const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Vector3(), _R = new THREE.Vector3();
    const _up = new THREE.Vector3(0, 1, 0), _dF = new THREE.Vector3(), _v = new THREE.Vector3();
    const col = new THREE.Color(), tintCol = new THREE.Color();
    const SPLAT = { x: 0, z: 0, radius: 1, heat: 0, char: 0, glow: 0, pattern: 'radial', seed: 0, x2: 0, z2: 0, width: 0 };
    const SHOCK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 6, duration: 0.5, thickness: 0.8, distortion: 0.03, intensity: 0, ground: false };

    // --- colour: fire ramp + particle kinds follow temperature and tint ---
    let lastT = -1, lastTint = '';
    const HOT = HOT_KINDS.map(([k, a, b]) => ({ name: `phoenix.${k}`, a, b, white: { temp: [0, 0] }, tinted: { temp: null, color: [new THREE.Color(), new THREE.Color()] } }));
    function retint() {
      const p = S.params;
      if (p.temperature === lastT && p.tint === lastTint) return;
      lastT = p.temperature; lastTint = p.tint;
      tintCol.set(p.tint);
      const T = p.temperature;
      blackbodyRGB(T * 1.45, hot).multiply(tintCol).multiplyScalar(0.95);
      blackbodyRGB(T * 1.0, mid).multiply(tintCol).multiplyScalar(0.5);
      blackbodyRGB(T * 0.7, cool).multiply(tintCol).multiplyScalar(0.2);
      const white = tintCol.r > 0.97 && tintCol.g > 0.97 && tintCol.b > 0.97;
      for (const h of HOT) {
        if (white) { h.white.temp[0] = T * h.a; h.white.temp[1] = T * h.b; P.setKind(h.name, h.white); }
        else {
          blackbodyRGB(T * h.a, h.tinted.color[0]).multiply(tintCol);
          blackbodyRGB(T * h.b, h.tinted.color[1]).multiply(tintCol).multiplyScalar((h.b / h.a) ** 3);
          P.setKind(h.name, h.tinted);
        }
      }
    }
    retint();
    const lightColor = (T, out) => blackbodyRGB(T, out).multiply(tintCol);

    // --- bird ---
    function writeBird(st) {
      const i = st.slot;
      if (i < 0) return;
      UA[i].set(st.pos.x, st.pos.y, st.pos.z, st.scale);
      UF[i].set(st.F.x, st.F.y, st.F.z, st.ph);
      UU[i].set(st.U.x, st.U.y, st.U.z, st.amp);
      UW[i].set(st.spread, st.sweep, st.dih, 0);
      UT[i].set(st.bx, st.by, 0, 0);
      const I = st.I * S.params.intensity;
      for (let r = 0; r < NR; r++) {
        if (st.fx[r]) st.fx[r].intensity = I * (RIBS[r][0] === 3 ? 0.9 : 1);
        if (st.ln[r]) st.ln[r].intensity = I * 1.3;
      }
    }
    function acquireBird(st, ci) {
      st.slot = slotOwner.indexOf(-1);
      if (st.slot < 0) return;
      slotOwner[st.slot] = ci;
      for (let r = 0; r < NR; r++) {
        st.fx[r] = setRib(birdFx.acquire(), RIBS[r], st.slot);
        st.ln[r] = setRib(birdLn.acquire(), RIBS[r], st.slot);
      }
    }
    function setRib(h, R, slot) {
      if (!h) return null;
      const p1 = R[2];
      h.p0.set(R[0], slot, R[1], 0);
      h.p1.set(p1[0], p1[1] * (R[0] === 3 ? S.params.tail : 1), p1[2], p1[3]);
      h.p2.set(R[3], R[4], 0, 0);
      h.intensity = 0;
      return h;
    }
    function releaseBird(st) {
      for (let r = 0; r < NR; r++) { st.fx[r]?.release(); st.ln[r]?.release(); st.fx[r] = st.ln[r] = null; }
      if (st.slot >= 0) { slotOwner[st.slot] = -1; UA[st.slot].set(0, -100, 0, 0); }
      st.slot = -1;
    }
    // local bird point -> world
    function toWorld(st, q, out) {
      _R.crossVectors(st.U, st.F);
      return out.copy(st.pos).addScaledVector(_R, q.x * st.scale).addScaledVector(st.U, q.y * st.scale).addScaledVector(st.F, q.z * st.scale);
    }
    // a point on wing feather k (side +-1) at fraction t along it, world space
    function featherPoint(st, side, k, t, out) {
      const s = FEAT[k][0], L = FEAT[k][1] * (0.55 + 0.45 * st.spread), an = FEAT[k][2] * (0.15 + 0.85 * st.spread) + 0.18 * t;
      armFlat(s, st.spread, _q);
      _q.x += Math.sin(an) * L * t; _q.y += -0.01 - 0.05 * t * L * t; _q.z += -0.02 - Math.cos(an) * L * t;
      flapW(foldW(_q, (1 - st.spread) * 1.3 + st.sweep * 0.6), L * t, st.ph, st.amp, st.dih);
      _q.x *= side;
      return toWorld(st, _q, out);
    }
    function tailPoint(st, t, out) {
      const L = 2.6 * S.params.tail;
      _q.set(st.bx * t * t * L, -0.05 * t + st.by * t * t * L, -0.45 - L * t);
      return toWorld(st, _q, out);
    }

    function spawnFeather(owner, pos, vel, life, len, width, heat) {
      let f = null;
      for (let i = 0; i < NFB && !f; i++) if (!feathers[i].fx && !feathers[i].ln) f = feathers[i];
      if (!f) return;
      f.fx = featFx.acquire(); f.ln = featLn.acquire();
      f.birth = fx.U.uTime.value; f.life = life; f.owner = owner;
      const seed = fx.rand() * 100, fall = 0.5 + 0.7 * fx.rand(), spin = (fx.rand() - 0.5) * 9, drag = 2.2 + 1.6 * fx.rand();
      setFeather(f.fx, f, pos, vel, len, width, heat, seed, fall, spin, drag, 1);
      setFeather(f.ln, f, pos, vel, len, width, heat, seed, fall, spin, drag, 1.4);
    }
    function setFeather(h, f, pos, vel, len, width, heat, seed, fall, spin, drag, gain) {
      if (!h) return;
      h.p0.set(pos.x, pos.y, pos.z, f.birth);
      h.p1.set(vel.x, vel.y, vel.z, f.life);
      h.p2.set(fall, spin, 0, drag);
      h.p3.set(len, width, seed, heat);
      h.intensity = S.params.intensity * gain;
    }
    function releaseFeather(f) { f.fx?.release(); f.ln?.release(); f.fx = f.ln = null; f.owner = -1; }

    function splat(x, z, radius, heat, char, pattern, seed, x2 = x, z2 = z, width = 0) {
      SPLAT.x = x; SPLAT.z = z; SPLAT.radius = radius; SPLAT.heat = heat; SPLAT.char = char; SPLAT.pattern = pattern;
      SPLAT.seed = seed; SPLAT.x2 = x2; SPLAT.z2 = z2; SPLAT.width = width;
      fx.ground.splat(SPLAT);
    }

    // --- flight ---
    function bezier(st, s, out) {
      const u = 1 - s;
      return out.copy(st.P0).multiplyScalar(u * u * u).addScaledVector(st.P1, 3 * u * u * s).addScaledVector(st.P2, 3 * u * s * s).addScaledVector(st.P3, s * s * s);
    }
    function bezierD(st, s, out) {
      const u = 1 - s;
      out.subVectors(st.P1, st.P0).multiplyScalar(3 * u * u);
      out.addScaledVector(_c.subVectors(st.P2, st.P1), 6 * u * s);
      return out.addScaledVector(_c.subVectors(st.P3, st.P2), 3 * s * s);
    }
    // forward = velocity; up banks into the turn; the tail lags the turn
    function orient(st, dt, rate) {
      _dF.copy(st.F);
      if (st.vel.lengthSq() > 1e-6) st.F.lerp(_a.copy(st.vel).normalize(), 1 - Math.exp(-dt * 14)).normalize();
      // level 'up' (world up across the flight direction; the last up when flying straight up/down),
      // rolled into the turn by the sideways acceleration, at most ~50 degrees
      _b.copy(_up).addScaledVector(st.F, -st.F.y);
      if (_b.lengthSq() < 0.04) _b.copy(st.U).addScaledVector(st.F, -st.U.dot(st.F));
      _b.normalize();
      _R.crossVectors(_b, st.F);
      const roll = THREE.MathUtils.clamp(Math.atan2(st.acc.dot(_R), 9.8) * 0.8, -0.9, 0.9);
      _b.multiplyScalar(Math.cos(roll)).addScaledVector(_R, Math.sin(roll));
      st.U.lerp(_b, 1 - Math.exp(-dt * rate));
      st.U.addScaledVector(st.F, -st.U.dot(st.F)).normalize();
      if (dt > 0) {
        _dF.subVectors(st.F, _dF).divideScalar(dt);
        _R.crossVectors(st.U, st.F);
        const k = 1 - Math.exp(-dt * 5);
        st.bx += (THREE.MathUtils.clamp(-_dF.dot(_R) * 0.18, -0.4, 0.4) - st.bx) * k;
        st.by += (THREE.MathUtils.clamp(-_dF.dot(st.U) * 0.18, -0.4, 0.4) - st.by) * k;
      }
    }

    function charge(c, st, p, dt) {
      const k = clamp01(c.t / c.durations.charge), f = c.from;
      // embers spiral into the focus
      const a = c.age * 8;
      E.gather.pos.copy(f).addScaledVector(_a.set(Math.sin(a), 0.25 * Math.sin(a * 0.5), Math.cos(a)), 1.2 - 0.5 * k);
      E.gather.vel.subVectors(f, E.gather.pos).multiplyScalar(2.8).addScaledVector(_a.set(Math.cos(a), 0, -Math.sin(a)), 2.4);
      E.gather.rate(220 * p.embers, dt);
      flameMass.orb(f, k, p, dt);
      // the bird forms in the fire, wings wrapped about it, rocking with its first slow beats
      st.pos.copy(f).addScaledVector(_up, 0.1 * k);
      bezierD(st, 0, st.F).normalize().lerp(_up, 0.55).normalize();
      st.U.copy(_up).addScaledVector(st.F, -_up.dot(st.F)).normalize();
      st.scale = 1.2 * p.size * (0.55 + 0.45 * smooth(0, 1, k));
      st.spread = 0.1 * k; st.sweep = 0; st.dih = 1.15; st.amp = 0.12 * k; st.ph += TAU * 1.2 * dt;
      st.I = 1.1 * smooth(0.05, 1, k) ** 1.5;
      writeBird(st);
      const L = st.light;
      if (L) { L.pos.copy(f); L.intensity = 14 * k * p.intensity; }
    }

    function fly(c, st, p, dt) {
      const s = st.s;
      st.flyT += dt;
      // beat hard on the climb, soar past the target, beat round the hook with the wings raised,
      // then strike with them thrown wide and forward (a raptor's flare): the thumbnail pose
      const climb = 1 - smooth(0.24, 0.36, s), hook = smooth(0.56, 0.66, s) * (1 - smooth(0.78, 0.86, s)), strike = smooth(0.8, 0.9, s);
      const open = smooth(0, 0.3, st.flyT);
      st.spread = Math.min(1.08, open * 1.12 - 0.08 * smooth(0.25, 0.45, st.flyT)) + 0.06 * strike;
      st.sweep = 0.35 * hook - 0.8 * strike;
      st.dih = (1.15 * (1 - open) + 0.12) + 0.35 * hook + 0.12 * strike;
      st.amp = p.flap * (0.95 * climb + 0.14 * (1 - climb) * (1 - hook) * (1 - strike) + 0.55 * hook) * open * (1 - strike);
      st.ph += TAU * dt * (2.4 * climb + 1.0 * (1 - climb) + 1.2 * hook) * Math.max(0.3, p.flap);
      st.I = 1.1;
      st.scale = 1.2 * p.size;
      orient(st, dt, 7);
      writeBird(st);

      // shed flame off the trailing edges, wisps off the tips, embers off the tail
      const fr = p.flames;
      for (let side = -1; side <= 1; side += 2) {
        featherPoint(st, side, 0, 0.95, E.shed.pos); featherPoint(st, side, NF - 1, 0.95, E.shed.p);
        E.shed.vel.copy(st.vel).multiplyScalar(0.12); E.shed.rate(150 * fr, dt);
        featherPoint(st, side, NF - 1, 1, E.tip.pos);
        E.tip.vel.copy(st.vel).multiplyScalar(0.35); E.tip.rate(70 * p.embers, dt);
      }
      tailPoint(st, 0.85, E.ember.pos);
      E.ember.radius = 0.35 * p.size; E.ember.vel.copy(st.vel).multiplyScalar(0.2); E.ember.rate(120 * p.embers, dt);
      // the body burns: a dense stream of small flames from the chest back along the tail root
      flameMass.stream(toWorld(st, _q.set(0, 0.02, 0.2), _b), toWorld(st, _q.set(0, 0, -0.5), _c), st.vel, p, fr, dt);
      // burning feathers peel off and flutter down
      st.shed -= dt * 7 * p.feathers;
      if (st.shed <= 0) {
        st.shed += 1;
        const side = fx.rand() < 0.5 ? -1 : 1, k = Math.floor(fx.rand() * NF);
        featherPoint(st, side, k, 0.6, _b);
        _v.copy(st.vel).multiplyScalar(0.2).add(_a.set(fx.rand() - 0.5, 0.6 + fx.rand(), fx.rand() - 0.5));
        spawnFeather(c.index, _b, _v, 1.1 + 0.6 * fx.rand(), 0.32 * p.size, 0.09 * p.size, 0.85);
      }
      st.trail?.push(st.pos);
      const L = st.light;
      if (L) { L.pos.copy(st.pos); L.intensity = 18 * p.intensity * (0.85 + 0.15 * Math.sin(c.age * 23)); }
    }

    function explode(c, st, p) {
      const pos = c.pos, x = pos.x, z = pos.z;
      flameMass.blast(pos, p);
      E.spark.pos.copy(pos); E.spark.vel.set(0, 1.5, 0); E.spark.burst(600 * p.embers);
      E.ember.pos.copy(pos); E.ember.radius = 0.6 * p.size; E.ember.vel.set(0, 2.5, 0); E.ember.burst(350 * p.embers);
      E.smoke.pos.copy(pos).setY(pos.y + 0.6 * p.size); E.smoke.radius = 1.0 * p.size; E.smoke.vel.set(0, 0.9, 0); E.smoke.size = p.size; E.smoke.burst(110 * p.smoke);
      E.dust.pos.set(x, 0.15, z); E.dust.size = p.size; E.dust.burst(110 * p.size);
      // the bird bursts into burning feathers
      const n = Math.round(44 * p.feathers);
      for (let i = 0; i < n; i++) {
        const a = fx.rand() * TAU, y = 0.15 + 0.85 * fx.rand();
        _v.set(Math.cos(a) * Math.sqrt(1 - y * y), y, Math.sin(a) * Math.sqrt(1 - y * y)).multiplyScalar((5 + 7 * fx.rand()) * Math.sqrt(p.size));
        _v.addScaledVector(st.dive, 3);
        spawnFeather(c.index, _b.copy(pos).addScaledVector(_v, 0.03), _v, 1.7 + 1.5 * fx.rand(), (0.38 + 0.25 * fx.rand()) * p.size, (0.1 + 0.06 * fx.rand()) * p.size, 0.8 + 0.2 * fx.rand());
      }
      // pressure shell: shoves loose particles (dust, leaves, embers) outwards
      st.shock = fx.forces.acquire();
      if (st.shock) { st.shock.type = 4; st.shock.pos.copy(pos); st.shock.p[0] = 0.3; st.shock.p[1] = 1.2; st.shock.p[2] = 60 * p.size; st.age = 0; }
      SHOCK.pos.set(x, 0.05, z); SHOCK.radius0 = 0.4; SHOCK.radius1 = 7 * p.size; SHOCK.duration = 0.55; SHOCK.thickness = 0.8; SHOCK.distortion = 0.04 * p.haze; SHOCK.ground = true;
      fx.shocks?.spawn(SHOCK);
      SHOCK.pos.copy(pos); SHOCK.radius1 = 5 * p.size; SHOCK.duration = 0.4; SHOCK.ground = false; SHOCK.distortion = 0.03 * p.haze;
      fx.shocks?.spawn(SHOCK);
      // the spread-wing silhouette scorched into the floor, along the dive
      const sc = p.scorch * p.size, fwd = st.dive, rx = fwd.z, rz = -fwd.x;
      splat(x, z, 1.6 * sc, 1.1, 0.9, 'noise', c.seed % 97);
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < 5; i++) {
          const ang = -0.2 + i * 0.28, len = (3.1 - 0.35 * i) * sc;
          const ax = rx * side * Math.cos(ang) - fwd.x * Math.sin(ang), az = rz * side * Math.cos(ang) - fwd.z * Math.sin(ang);
          splat(x + ax * 0.4 * sc, z + az * 0.4 * sc, 0.2 * sc, 0.75, 1.0, 'line', (c.seed + i * 7 + side) % 89, x + ax * len, z + az * len, (0.26 - 0.03 * i) * sc);
        }
      }
      splat(x - fwd.x * 0.3, z - fwd.z * 0.3, 0.2 * sc, 0.6, 0.9, 'line', c.seed % 61, x - fwd.x * 2.6 * sc, z - fwd.z * 2.6 * sc, 0.22 * sc);
      fx.impacts.add('scorch', pos, 3.2 * p.size, 1, 9, lightColor(p.temperature, col));
      if (st.light) { st.light.intensity = 45 * p.intensity; st.light.range = 15 * p.size; st.light.pos.copy(pos).setY(pos.y + 0.5); }
      fx.flash(0.08 * p.intensity);
      fx.rig.shake(0.55, 12);
      if (!fx.reduced) { fx.rig.punch(3.5, 0.09); fx.rig.hitstop(0.06); }
      for (const dm of fx.dummies) {
        const d = Math.hypot(dm.pos.x - x, dm.pos.z - z), R = 3.2 * p.size;
        if (d < R) { dm.status.burn = Math.max(dm.status.burn, 1.3 - d / R); dm.hit(_a.subVectors(dm.pos, pos).setY(0).addScaledVector(fwd, 0.8).normalize(), 1.2 * (1 - d / R)); }
      }
      // the pool ripples when the burst lands near it
      const pool = fx.ARENA.pool;
      const qx = Math.max(Math.abs(x - pool.center.x) - pool.half.x, 0), qz = Math.max(Math.abs(z - pool.center.y) - pool.half.y, 0);
      if (Math.hypot(qx, qz) < 4 && fx.pool) {
        fx.pool.ripple(THREE.MathUtils.clamp(x, pool.center.x - pool.half.x, pool.center.x + pool.half.x), THREE.MathUtils.clamp(z, pool.center.y - pool.half.y, pool.center.y + pool.half.y), 0.05, 0.8);
        fx.pool.flash(lightColor(p.temperature, col), 0.6);
      }
    }

    function releaseAll(st, ci) {
      releaseBird(st);
      st.light?.release(); st.light = null;
      st.trail?.release(); st.trail = null;
      st.shock?.release(); st.shock = null;
      for (const f of feathers) if (f.owner === ci) releaseFeather(f);
    }

    return {
      onParam(k) { if (k === 'tint' || k === 'temperature') retint(); },
      tick() {
        const now = fx.U.uTime.value;
        for (const f of feathers) if ((f.fx || f.ln) && (now - f.birth + 3600) % 3600 > f.life) releaseFeather(f);
        birdFx.update(); birdLn.update(); featFx.update(); featLn.update();
      },

      phase(c, name) {
        const p = S.params, st = state[c.index];
        retint();
        if (name === 'charge') {
          releaseAll(st, c.index);
          st.s = 0; st.ph = 0; st.flyT = 0; st.bx = st.by = 0; st.shed = 0; st.splat = 0; st.age = 0;
          st.vel.set(0, 0, 0); st.acc.set(0, 0, 0);
          // the arc: up and out to one side, sweeping past the target and hooking round behind it,
          // so it strikes coming back towards the caster: the cameras get its spread wings head-on
          const D = Math.max(2, c.from.distanceTo(c.to));
          _a.subVectors(c.to, c.from).setY(0);
          if (_a.lengthSq() < 1e-4) _a.set(0, 0, -1);
          _a.normalize();
          st.dive.copy(_a).negate();
          _R.crossVectors(_a, _up).normalize();   // to the right of travel
          const sw = p.swing, up = p.arc;
          st.P0.copy(c.from);
          st.P1.copy(c.from).addScaledVector(_up, 3.0 * up).addScaledVector(_R, 3.6 * sw).addScaledVector(_a, 0.85 * D);
          st.P2.copy(c.to).addScaledVector(_up, 2.8 * up).addScaledVector(_R, 1.6 * sw).addScaledVector(_a, 5.5);
          const r2 = Math.hypot(st.P2.x, st.P2.z), lim = fx.ARENA.radius - 2;
          if (r2 > lim) { st.P2.x *= lim / r2; st.P2.z *= lim / r2; }
          st.P3.copy(c.to);
          st.pos.copy(c.from);
          acquireBird(st, c.index);
          st.light = fx.lights.acquire();
          if (st.light) { st.light.range = 10; st.light.intensity = 0; st.light.shadow = true; lightColor(p.temperature, st.light.color); }
        } else if (name === 'release') {
          fx.rig.shake(0.14, 9);
          flameMass.launch(c.from, p);
          E.ember.pos.copy(c.from); E.ember.vel.set(0, 2, 0); E.ember.burst(120 * p.embers);
          st.trail = fx.trails.acquire();
          const t = st.trail;
          if (t) { t.width = 0.16 * p.size; t.intensity = 2.2 * p.intensity; t.glow = 3.5; t.glowIntensity = 0.25; t.fadeTime = 0.45; t.spacing = 0.15; t.distortion = 0.08 * p.haze; lightColor(p.temperature * 1.2, t.color); }
        } else if (name === 'impact') {
          st.trail?.release(); st.trail = null;
          st.age = 0;
          explode(c, st, p);
        } else if (name === 'linger') {
          releaseBird(st);
        } else if (name === 'done') releaseAll(st, c.index);
      },

      // own flight along the arc; faster as it stoops
      travel(c, dt) {
        const p = S.params, st = state[c.index];
        const ds = bezierD(st, st.s, _b).length();
        const v = p.speed * (0.8 + 0.6 * st.s * st.s) * (0.55 + 0.45 * smooth(0, 0.35, c.t)) * (1 - 0.35 * smooth(0.85, 1, st.s));
        st.s = Math.min(1, st.s + v * dt / Math.max(ds, 1e-3));
        _a.copy(st.pos);
        bezier(st, st.s, st.pos);
        _v.subVectors(st.pos, _a).divideScalar(Math.max(dt, 1e-4));
        if (dt > 0) st.acc.lerp(_c.subVectors(_v, st.vel).divideScalar(dt), 1 - Math.exp(-dt * 6));
        st.vel.copy(_v);
        c.pos.copy(st.pos); c.vel.copy(st.vel);
        return st.s >= 1 || c.t > c.durations.travel;
      },

      update(c, dt) {
        const p = S.params, st = state[c.index];
        if (c.phase === 'charge') { charge(c, st, p, dt); return; }
        if (c.phase === 'travel') { fly(c, st, p, dt); return; }
        st.age += dt;
        const a = st.age, L = st.light;
        if (c.phase === 'impact' && st.slot >= 0) {
          // the bird flies apart: its silhouette flares out huge, wings flung wide, and burns away
          const k = clamp01(a / c.durations.impact), g = 1 - (1 - k) * (1 - k);
          st.scale = 1.2 * p.size * (1 + 1.5 * g);
          st.spread = 1.12; st.sweep = -0.95 * (1 - g) - 0.2 * g; st.dih = 0.3 + 0.25 * g; st.amp = 0;
          st.pos.addScaledVector(_up, dt * 2.5 * (1 - k));
          st.I = 1.5 * (1 - k * k) * (1 - k);
          writeBird(st);
        }
        const sh = st.shock;
        if (sh) {
          if (a > 0.6) { sh.release(); st.shock = null; }
          else { sh.p[0] = 0.3 + 11 * p.size * a; sh.p[2] = 60 * p.size * (1 - a / 0.6); }
        }
        if (L) {
          L.intensity *= Math.exp(-dt / 0.32);
          if (c.phase === 'linger') L.intensity = Math.max(L.intensity, 4 * p.intensity * (0.85 + 0.15 * Math.sin(c.age * 17)) * Math.max(0, 1 - c.t / c.durations.linger));
        }
        if (c.phase !== 'linger') return;
        const t = c.t;
        if (t < 2.2) {
          E.smoke.pos.copy(c.pos).setY(c.pos.y + 1.2 * p.size + 0.8 * t); E.smoke.radius = 0.6 * p.size; E.smoke.vel.set(0, 0.8, 0); E.smoke.size = p.size; E.smoke.rate(12 * p.smoke, dt);
        }
        // the ashes stir: a spiral of embers lifts from the centre
        if (t > 0.6 && t < 2.4) {
          const k = smooth(0.6, 1.2, t) * (1 - smooth(1.8, 2.4, t)), ang = t * 9, r = 0.5 * p.size * (1 - 0.4 * (t - 0.6));
          E.rise.pos.set(c.pos.x + Math.cos(ang) * r, 0.15 + 0.9 * (t - 0.6), c.pos.z + Math.sin(ang) * r);
          E.rise.vel.set(-Math.sin(ang) * 1.5, 2.2, Math.cos(ang) * 1.5);
          E.rise.rate(140 * p.embers * k, dt);
          E.ember.pos.set(c.pos.x, 0.2, c.pos.z); E.ember.radius = 0.5 * p.size; E.ember.vel.set(0, 1.4, 0); E.ember.rate(60 * p.embers * k, dt);
        }
      },
    };
  },
};
