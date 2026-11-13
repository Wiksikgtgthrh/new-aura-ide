import * as THREE from 'three';
import { U } from '../../vfx/common.js';
import { blackbodyRGB } from '../../vfx/noise.js';
import { CRACK_VERT, CRACK_FRAG } from './fissure.glsl.js';

// Fissure (earth hero). Anticipation: a hairline crack races from the caster's side toward the
// target and through it, glowing faintly, while the floor rumbles, pebbles hop and dust and
// embers seep from it. Release: the ground splits. The cut unzips along the line in a fraction
// of a second (an interior-mapped trench, fissure.glsl.js: walls lit from below by magma deep in
// the crack), its lips heave up as broken rock slabs (spikes with magma heat in their veins),
// each stretch throws rock, glowing magma and spatter, jets steam and rolls dust outward; shock
// rings, a pressure push on loose particles, knockback away from the line, burning dummies.
// Aftermath: vents along the crack puff steam and spit magma, heat haze shimmers over it and a
// thermal lifts what drifts by; the magma cools and crusts over, the cut closes, the lips crumble,
// and the floor keeps the crack, the char and a fading glow.

const MAX_CRACKS = 3, STATES = 16, MAX_LIPS = 8, SEGS = 8, VENTS = 6;
const PROFILE_N = 512, PERIOD = 12;   // the profile repeats every 12 m of crack
const CLOSE = 1.4;                    // s at the end of `hold`: cools, closes, crumbles
const UP = new THREE.Vector3(0, 1, 0);
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// reused option objects: the shared systems read fields, a literal per call would allocate
const SPL = { x: 0, z: 0, radius: 1, heat: 0, char: 0, wet: 0, frost: 0, crack: 0, acid: 0, corruption: 0, glow: 0, pattern: 'line', seed: 0, angle: 0, x2: 0, z2: 0, width: 0 };
const SPK = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), height: 1, radius: 0.4, material: 'rock', delay: 0, rise: 0.16, life: 3, crumble: 1.0, heat: 1, seed: 1 };
const SHK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 4, duration: 0.5, thickness: 0.5, distortion: 0.05, color: null, intensity: 0, ground: true };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _col = new THREE.Color();
const EDGE = { c: 0, hl: 0, hr: 0 };

function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// 1D crack profile (periodic): r meander, g left jag, b right jag, a ledge phase
function buildProfile() {
  const rnd = lcg(9127), data = new Uint8Array(PROFILE_N * 4);
  const lat = (n) => Float32Array.from({ length: n }, rnd);
  const oct = (L, x) => { const n = L.length, f = x * n, i = Math.floor(f), t = f - i, s = t * t * (3 - 2 * t); return L[i % n] * (1 - s) + L[(i + 1) % n] * s; };
  const M = [lat(3), lat(7)], JL = [lat(17), lat(41), lat(97), lat(223)], JR = [lat(19), lat(43), lat(101), lat(227)], LG = [lat(23), lat(59)];
  const jag = (J, x) => oct(J[0], x) * 0.42 + oct(J[1], x) * 0.28 + oct(J[2], x) * 0.18 + oct(J[3], x) * 0.12;
  const st = (v) => Math.round(255 * Math.min(1, Math.max(0, (v - 0.5) * 1.9 + 0.5)));
  for (let i = 0; i < PROFILE_N; i++) {
    const x = (i + 0.5) / PROFILE_N;
    data[i * 4] = st(oct(M[0], x) * 0.65 + oct(M[1], x) * 0.35);
    data[i * 4 + 1] = st(jag(JL, x));
    data[i * 4 + 2] = st(jag(JR, x));
    data[i * 4 + 3] = st(oct(LG[0], x) * 0.6 + oct(LG[1], x) * 0.4);
  }
  return data;
}

export default {
  id: 'fissure', name: 'Fissure', element: 'earth', order: 10, hue: '#ff6a1f',
  shape: 'area',
  params: {
    width: 0.42, depth: 1.1, reach: 9, overshoot: 1.6, hold: 4.2, temperature: 1350, intensity: 1,
    lips: 5, lipHeight: 0.4, unzip: 0.2, debris: 1, steam: 1, dust: 1, haze: 1, shake: 1, tint: '#ffffff',
  },
  ranges: {
    width: [0.15, 1, 0.01], depth: [0.4, 2.5, 0.01], reach: [3, 16, 0.1], overshoot: [0, 4, 0.05], hold: [1.5, 9, 0.1],
    temperature: [900, 2600, 10], intensity: [0, 3, 0.01], lips: [0, MAX_LIPS, 1], lipHeight: [0.2, 1.8, 0.01], unzip: [0.02, 0.8, 0.01],
    debris: [0, 3, 0.01], steam: [0, 3, 0.01], dust: [0, 3, 0.01], haze: [0, 3, 0.01], shake: [0, 2, 0.01],
  },
  presets: {
    'obsidian rift': { temperature: 1100, width: 0.3, depth: 1.8, steam: 2, intensity: 1.3, lipHeight: 0.55 },
    cataclysm: { width: 0.75, reach: 13, lips: 8, lipHeight: 1.25, debris: 1.7, dust: 1.5, shake: 1.6, unzip: 0.32, hold: 5.5 },
    'sulfur vent': { tint: '#8fb0ff', temperature: 2400, steam: 2.4, debris: 0.7, intensity: 0.8 },
  },
  timing: { charge: 0.9, impact: 0.35, linger: 6 },
  kinds: {
    // (the landing heat is kept low: thousands of drops summed past the field's crust regime into
    // flat bright orange puddles; a spill beside a lava channel crusts dark, glowing only in its cracks)
    // magma droplets flung out of the crack: white-yellow, cooling to red, heat where they land
    spatter: { style: 'glow', drag: 0.25, gravity: 9.8, killOnCollide: true, life: [0.7, 1.5], size: [0.026, 0.012], stretch: 0.045, emissive: 2.6, temp: [1500, 820], paints: 'heat', paintAmount: 0.022, fadeOut: 0.2 },
    // fat lava clots: real rock lumps that glow as they fly and crust black where they land
    glob: { style: 'debris', mesh: 'rock', gravity: 9.8, drag: 0.06, restitution: 0.12, friction: 0.8, life: [2.6, 3.8], size: [0.075, 0.075], spin: 5, color: ['#17100c', new THREE.Color(7, 1.3, 0.16)], alpha: [1, 0.85], fadeOut: 0.15, forceResponse: 0, paints: 'heat', paintAmount: 0.035 },
    // the curtain of fire: a sheet of fountaining lava along the whole cut (real fissure eruptions,
    // Kilauea 2018 / Sundhnukur 2024): clots rise, slow, fall back, cooling from yellow to red
    fountain: { style: 'glow', drag: 0.35, gravity: 9.8, killOnCollide: true, life: [0.8, 1.5], size: [0.028, 0.014], stretch: 0.05, emissive: 2.6, temp: [1450, 880], paints: 'heat', paintAmount: 0.011, fadeOut: 0.2 },
    // volcanic gas over the curtain: blue-grey, lit orange from below by the fountain
    gas: { style: 'media', emissive: 0, drag: 1.1, buoyancy: 3.2, curl: 1.1, curlScale: 0.25, life: [2.4, 3.8], size: [0.45, 2.6], sizePow: 0.5, color: ['#a3a7ad', '#757b84'], alpha: [0.085, 0], density: 1.3, erosion: 0.65, fadeIn: 0.1, fadeOut: 0.55, forceResponse: 0.8, lightResponse: 1.6 },
    // steam: lit (the magma light colours it from below), rolls up fast and thins
    steam: { style: 'media', emissive: 0, drag: 1.5, buoyancy: 2.6, curl: 1.4, curlScale: 0.35, life: [1.3, 2.6], size: [0.22, 1.5], sizePow: 0.5, color: ['#cfc9c4', '#8f8984'], alpha: [0.13, 0], density: 1.4, erosion: 0.7, fadeIn: 0.08, fadeOut: 0.5, forceResponse: 0.8, lightResponse: 1 },
    // heat haze: almost no coverage, all distortion
    // dust: dark rock flour; barely takes the magma light so it reads as smoke, not glow
    dust: { style: 'media', emissive: 0, drag: 2.2, buoyancy: -0.2, curl: 0.6, curlScale: 0.2, life: [2.2, 3.8], size: [0.4, 1.8], sizePow: 0.55, color: ['#4a3f36', '#3a322c'], alpha: [0.2, 0.08], density: 2.2, erosion: 0.55, fadeIn: 0.05, fadeOut: 0.6, forceResponse: 0.5, lightResponse: 0.35 },
    haze: { style: 'media', emissive: 0, drag: 2.5, buoyancy: 1.8, curl: 0.8, curlScale: 0.5, life: [0.8, 1.5], size: [0.5, 1.1], color: ['#ffffff', '#ffffff'], alpha: [0.018, 0], density: 0.6, erosion: 0.3, distortion: 40, fadeIn: 0.25, fadeOut: 0.4, forceResponse: 0.6 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const line = (kind, spread, radius = 0.12) => P.emitter(kind, { shape: 'line', radius, spread });
    const pebbleLine = line('earth.pebble', 0.9), seepLine = line('earth.seep', 0.25, 0.1), emberLine = line('earth.ember', 1.2, 0.08);
    const rockSeg = line('earth.rock', 1.3), chunkSeg = line('earth.chunk', 0.9), magmaSeg = line('earth.magma', 1.4);
    const spatterSeg = line('fissure.spatter', 1.8, 0.08), globSeg = line('fissure.glob', 2.2, 0.1), steamSeg = line('fissure.steam', 0.8, 0.15), steamLine = line('fissure.steam', 0.35, 0.1);
    const dustSeg = line('fissure.dust', 0.7, 0.2), plumeSeg = line('fissure.dust', 0.9, 0.2), hazeLine = line('fissure.haze', 0.3, 0.15);
    const fountainSeg = line('fissure.fountain', 0.75, 0.07), gasLine = line('fissure.gas', 0.5, 0.25);
    const ventSteam = P.emitter('fissure.steam', { shape: 'cone', radius: 0.12, spread: 0.6, radial: 4, cone: 0.25 });
    const ventSpatter = P.emitter('fissure.spatter', { shape: 'cone', radius: 0.08, spread: 1.2, radial: 5.5, cone: 0.35 });
    const ventMagma = P.emitter('earth.magma', { shape: 'cone', radius: 0.1, spread: 0.8, radial: 4.5, cone: 0.4 });

    // --- the rift decals: one program, per-mesh uniforms ---
    const profile = buildProfile();
    const profileTex = new THREE.DataTexture(profile, PROFILE_N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    profileTex.wrapS = THREE.RepeatWrapping;
    profileTex.magFilter = profileTex.minFilter = THREE.LinearFilter;
    profileTex.needsUpdate = true;
    const tint = new THREE.Vector3(1, 1, 1), tintCol = new THREE.Color(1, 1, 1);
    const quad = new THREE.PlaneGeometry(2, 2, 1, 1);
    const cracks = [];
    for (let i = 0; i < MAX_CRACKS; i++) {
      const m = new THREE.Mesh(quad, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: CRACK_VERT, fragmentShader: CRACK_FRAG, alphaToCoverage: true, side: THREE.DoubleSide,
        uniforms: {
          ...U, uProfile: { value: profileTex }, uA: { value: new THREE.Vector3() }, uT: { value: new THREE.Vector2(1, 0) },
          uQuad: { value: new THREE.Vector4() }, uCrackA: { value: new THREE.Vector4() }, uCrackB: { value: new THREE.Vector4() },
          uCrackC: { value: new THREE.Vector4() }, uCrackD: { value: new THREE.Vector4() }, uTint: { value: tint },
        },
      }));
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = -0.5;   // after the spikes (lips), before the floor would be ideal; the floor is order 0
      fx.scenes.opaque.add(m);
      cracks.push(m);
    }

    // --- per-cast state ---
    const lipState = () => ({ h: null, seed: 0, u: 0, pos: new THREE.Vector3(), dir: new THREE.Vector3(), height: 1, radius: 0.4, delay: 0 });
    const states = Array.from({ length: STATES }, () => ({
      crack: null, A: new THREE.Vector3(), B: new THREE.Vector3(), T: new THREE.Vector3(), N: new THREE.Vector3(), head: new THREE.Vector3(),
      L: 1, W: 0.4, offs: 0, split: false, te: 0, splatT: 0, heatT: 0, heat: 0, close: 1,
      lips: Array.from({ length: MAX_LIPS * 2 }, lipState), nLips: 0, seg: new Uint8Array(SEGS),
      vents: Array.from({ length: VENTS }, () => ({ u: 0, next: 0 })),
      light: null, shock: null, up0: null, up1: null, shockT: 0,
    }));

    function edgeAt(d, u, open) {
      const x = (u / PERIOD + d.offs) % 1, f = x * PROFILE_N - 0.5;
      let i0 = Math.floor(f);
      const t = f - i0;
      i0 = (i0 + PROFILE_N) % PROFILE_N;
      const a = i0 * 4, b = ((i0 + 1) % PROFILE_N) * 4, t1 = (1 - t) / 255, t2 = t / 255;
      const xx = Math.min(1, Math.max(0, u / d.L)), env = Math.pow(Math.max(Math.sin(Math.PI * xx), 0), 0.55);
      const w = d.W * open * env;
      EDGE.c = ((profile[a] * t1 + profile[b] * t2) - 0.5) * 2 * meander(d) * env;
      EDGE.hl = w * (0.5 + profile[a + 1] * t1 + profile[b + 1] * t2);
      EDGE.hr = w * (0.5 + profile[a + 2] * t1 + profile[b + 2] * t2);
      return EDGE;
    }
    const meander = (d) => 0.35 * d.W + 0.08;
    // world point at (u, v) on the crack's frame
    const at = (d, u, v, y, out) => out.copy(d.A).addScaledVector(d.T, u).addScaledVector(d.N, v).setY(y);

    function splat(x, z, x2, z2, width, crack, heat, char, pattern, seed, radius = 0.3) {
      SPL.x = x; SPL.z = z; SPL.x2 = x2; SPL.z2 = z2; SPL.width = width; SPL.radius = radius; SPL.crack = crack; SPL.heat = heat; SPL.char = char;
      SPL.pattern = pattern; SPL.seed = seed;
      fx.ground.splat(SPL);
    }
    function shock(pos, r1, duration, distortion) {
      SHK.pos.copy(pos).setY(0.04); SHK.radius1 = r1; SHK.duration = duration; SHK.distortion = distortion; SHK.thickness = 0.35 + r1 * 0.08;
      fx.shocks?.spawn(SHK);
    }
    // distance from p to the crack segment (xz), and the side it is on
    const LD = { d: 0, side: 1 };
    function lineDist(d, p) {
      _c.set(p.x - d.A.x, 0, p.z - d.A.z);
      const u = Math.min(d.L, Math.max(0, _c.dot(d.T)));
      LD.d = Math.hypot(p.x - (d.A.x + d.T.x * u), p.z - (d.A.z + d.T.z * u));
      LD.side = Math.sign(_c.dot(d.N)) || 1;
      return LD;
    }
    // emit between _a and _b (a burst) or along the whole cut (a rate)
    function emitAB(e, n, vy, size) { e.pos.copy(_a); e.p.copy(_b); e.vel.set(0, vy, 0); e.size = size; e.burst(n); }
    function emitSide(d, e, n, side, off, out, vy, size) {
      e.pos.copy(_a).addScaledVector(d.N, side * off); e.p.copy(_b).addScaledVector(d.N, side * off);
      e.vel.copy(d.N).multiplyScalar(side * out).setY(vy); e.size = size; e.burst(n);
    }
    function alongHead(d, e, n, vy, dt) { e.pos.copy(d.A).setY(0.05); e.p.copy(d.head).setY(0.05); e.vel.set(0, vy, 0); e.rate(n, dt); }
    function alongCut(d, e, n, vy, y, dt) { e.pos.copy(d.A).addScaledVector(d.T, 0.4).setY(y); e.p.copy(d.B).addScaledVector(d.T, -0.4).setY(y); e.vel.set(0, vy, 0); e.rate(n, dt); }

    // tinted blackbody for the spatter kind (the kind table has no tint), written as texels
    let lastT = -1, lastTint = '';
    const HOT = { white: { temp: [0, 0] }, tinted: { temp: null, color: [new THREE.Color(), new THREE.Color()] } };
    const GLOB = { color: [new THREE.Color('#17100c'), new THREE.Color()] };
    function retint() {
      const p = S.params;
      if (p.temperature === lastT && p.tint === lastTint) return;
      lastT = p.temperature; lastTint = p.tint;
      tintCol.set(p.tint); tint.set(tintCol.r, tintCol.g, tintCol.b);
      const T = p.temperature * 1.1;
      if (tintCol.r > 0.97 && tintCol.g > 0.97 && tintCol.b > 0.97) { HOT.white.temp[0] = T; HOT.white.temp[1] = T * 0.55; P.setKind('fissure.spatter', HOT.white); P.setKind('fissure.fountain', HOT.white); }
      else {
        blackbodyRGB(T, HOT.tinted.color[0]).multiply(tintCol);
        blackbodyRGB(T * 0.55, HOT.tinted.color[1]).multiply(tintCol).multiplyScalar(0.55 ** 3);
        P.setKind('fissure.spatter', HOT.tinted); P.setKind('fissure.fountain', HOT.tinted);
      }
      // the clots' glow: blackbody at the magma temperature (blackbodyRGB is ~3.4 bright at 1350 K), tinted
      blackbodyRGB(p.temperature, GLOB.color[1]).multiply(tintCol).multiplyScalar(1.5 * Math.pow(p.temperature / 1300, 4));   // ~ (5, 0.55, 0) at 1350 K, like earth.magma
      P.setKind('fissure.glob', GLOB);
    }
    retint();

    function layout(c, p, d) {
      d.T.set(c.to.x - c.from.x, 0, c.to.z - c.from.z);
      const dist = d.T.length();
      if (dist < 1e-3) d.T.set(0, 0, -1); else d.T.multiplyScalar(1 / dist);
      d.N.set(-d.T.z, 0, d.T.x);
      const startD = Math.min(Math.max(dist - p.reach, 1.6), Math.max(dist - 1.5, 0.5));
      d.A.set(c.from.x, 0, c.from.z).addScaledVector(d.T, startD);
      d.B.set(c.to.x, 0, c.to.z).addScaledVector(d.T, p.overshoot);
      // stay inside the rim wall
      const rim = fx.ARENA.radius - 1;
      if (d.B.length() > rim) d.B.setLength(rim);
      d.L = Math.max(d.B.distanceTo(d.A), 1.5);
      d.W = p.width;
      d.offs = (c.seed % 997) / 997;
      d.head.copy(d.A);
      // lips: broken slabs along both edges, heaved up and leaning away from the cut
      const n = Math.min(MAX_LIPS, Math.round(p.lips));
      d.nLips = 0;
      for (let side = -1; side <= 1; side += 2) {
        for (let k = 0; k < n; k++) {
          const s = d.lips[d.nLips++];
          s.u = d.L * Math.min(0.96, Math.max(0.04, (k + 0.25 + 0.5 * fx.rand() + (side > 0 ? 0.35 : 0)) / (n + 0.35)));
          const e = edgeAt(d, s.u, 1), x = s.u / d.L, env = Math.pow(Math.max(Math.sin(Math.PI * x), 0), 0.5);
          s.radius = p.width * (0.7 + 0.35 * fx.rand()) * (0.6 + 0.4 * env) + 0.12;
          s.height = p.lipHeight * (0.5 + 0.5 * env) * (0.7 + 0.5 * fx.rand());
          at(d, s.u, e.c + side * ((side > 0 ? e.hr : e.hl) + s.radius * 0.55), 0, s.pos);
          s.dir.copy(UP).addScaledVector(d.N, side * (1.4 + 0.6 * fx.rand())).addScaledVector(d.T, (fx.rand() - 0.5) * 0.6).normalize();
          s.delay = x * p.unzip + 0.02 + 0.03 * fx.rand();
          s.seed = ((c.seed * 31 + d.nLips * 7919) >>> 0) & 0xffffff || 1;
          s.h = null;
        }
      }
      for (let k = 0; k < VENTS; k++) { d.vents[k].u = d.L * (0.08 + 0.84 * (k + fx.rand()) / VENTS); d.vents[k].next = 0.25 + fx.rand() * 0.8; }
      d.seg.fill(0);
    }

    function setCrack(d, p, front, te, close, heat) {
      const m = d.crack;
      if (!m) return;
      const u = m.material.uniforms;
      u.uA.value.copy(d.A); u.uT.value.set(d.T.x, d.T.z);
      u.uQuad.value.set(-0.1, d.L + 0.1, d.W * 1.5 + meander(d) + 0.05, 0.004);
      u.uCrackA.value.set(d.L, d.W, p.depth, front);
      u.uCrackB.value.set(te, p.unzip, close, heat);
      u.uCrackC.value.set(d.offs, meander(d), 0.022, (d.offs * 37) % 1);
      u.uCrackD.value.set(p.intensity, p.temperature, p.haze, U.uTime.value);
    }

    // one stretch of the cut tears open: rock, magma, spatter, steam, dust
    function tearSegment(c, p, d, k) {
      const u0 = (k / SEGS) * d.L, u1 = ((k + 1) / SEGS) * d.L, w = p.width, sz = Math.sqrt(w / 0.42);
      at(d, u0, edgeAt(d, u0, 1).c, 0.15, _a); at(d, u1, edgeAt(d, u1, 1).c, 0.15, _b);
      emitAB(spatterSeg, 45 * p.debris, 6.2, 1);
      emitAB(globSeg, 14 * p.debris, 8, 1);
      emitAB(steamSeg, 14 * p.steam, 3.5, 1.1 * sz);
      emitAB(plumeSeg, 6 * p.dust, 2.6, sz);
      // solids are torn off the lips and thrown outward (anything landing in the cut would rest on
      // the floor plane, floating over the trench); dust rolls out along the floor
      for (let side = -1; side <= 1; side += 2) {
        emitSide(d, rockSeg, 10 * p.debris, side, w * 1.2, 1.8 * sz, 3.4 * sz, sz);
        emitSide(d, chunkSeg, 3 * p.debris, side, w * 1.3, 1.8 * sz, 2.8 * sz, sz);
        emitSide(d, magmaSeg, 6 * p.debris, side, w * 1.1, 2.4 * sz, 4.2 * sz, 1);
        emitSide(d, dustSeg, 12 * p.dust, side, w * 2.4, 4.5 * sz, 0.35, sz);
      }
      if (k === 1 || k === 4 || k === SEGS - 1) shock(_c.lerpVectors(_a, _b, 0.5), (k === SEGS - 1 ? 5 : 3.2) * sz, 0.45, 0.05);
      fx.rig.shake(0.06 * p.shake, 9);
    }

    function split(c, p, d) {
      d.split = true; d.te = 0;
      const sz = Math.sqrt(p.width / 0.42);
      for (let i = 0; i < d.nLips; i++) {
        const s = d.lips[i];
        SPK.pos.copy(s.pos); SPK.dir.copy(s.dir); SPK.height = s.height; SPK.radius = s.radius;
        SPK.delay = s.delay; SPK.life = Math.max(0.6, p.hold - s.delay + 0.2); SPK.heat = 0.45; SPK.seed = s.seed;
        s.h = fx.spikes.spawn(SPK);
      }
      // the floor: the cut cracks the vein network for metres around, heat and char along it (the
      // heat kept in the crust regime: more lit the cracked floor beside the cut as flat orange puddles)
      splat(d.A.x, d.A.z, d.B.x, d.B.z, p.width * 1.8, 2.1, 0.2, 0.5, 'line', c.seed % 97);
      splat(d.A.x, d.A.z, d.A.x, d.A.z, 0, 1.7, 0.2, 0.2, 'radial', (c.seed + 13) % 97, 1.3 * sz);
      splat(d.B.x, d.B.z, d.B.x, d.B.z, 0, 1.8, 0.2, 0.2, 'radial', (c.seed + 29) % 97, 1.5 * sz);
      for (let k = 0; k < 3; k++) fx.impacts.add('magma', at(d, d.L * (0.2 + 0.3 * k), 0, 0.2, _a), 1.4 * sz + 0.4, 0.55, p.hold + 1.5, blackbodyRGB(p.temperature, _col).multiply(tintCol));
      // a pressure push on everything loose, then a thermal over the crack
      d.shock = fx.forces.acquire();
      if (d.shock) { d.shock.type = 4; d.shock.p[0] = 0.5; d.shock.p[1] = 1.5; d.shock.p[2] = 28; d.shock.p[3] = 0; at(d, d.L * 0.5, 0, 0.4, d.shock.pos); }
      d.shockT = 0;
      for (let k = 0; k < 2; k++) {
        const f = fx.forces.acquire();
        if (!f) break;
        f.type = 5; f.dir.set(0, 1, 0); f.p[0] = 2.6; f.p[1] = d.L * 0.27 + 0.4; f.p[2] = 4.5; f.p[3] = 0; at(d, d.L * (0.25 + 0.5 * k), 0, -0.3, f.pos);
        if (k === 0) d.up0 = f; else d.up1 = f;
      }
      // knockback away from the line, the nearest catch fire
      for (const dm of fx.dummies) {
        const ld = lineDist(d, dm.pos), reach = 1.4 + p.width * 2;
        if (ld.d < reach) {
          dm.hit(_b.copy(d.N).multiplyScalar(ld.side).addScaledVector(UP, 0.3), 1.5 * (1 - ld.d / reach) + 0.3);
          if (ld.d < reach * 0.6) dm.status.burn = Math.max(dm.status.burn, 0.8);
        }
      }
      // the pool hisses if the crack reaches it
      const pool = fx.ARENA.pool;
      const px = Math.min(Math.max(d.B.x, pool.center.x - pool.half.x), pool.center.x + pool.half.x), pz = Math.min(Math.max(d.B.z, pool.center.y - pool.half.y), pool.center.y + pool.half.y);
      _a.set(px, 0, pz);
      if (lineDist(d, _a).d < 1.2) {
        fx.pool?.ripple?.(px, pz, 0.08, 1.2);
        ventSteam.pos.set(px, 0.1, pz); ventSteam.p.set(0, 1, 0); ventSteam.size = 1.6; ventSteam.burst(160 * p.steam);
      }
      fx.rig.shake(0.55 * p.shake, 7);
      fx.rig.shake(0.25 * p.shake, 16);
      if (!fx.reduced) { fx.rig.punch(2.2, 0.12); fx.rig.hitstop(0.05); }
      fx.flash(0.12 * p.intensity);
      const L = d.light;
      if (L) { L.type = 1; L.range = 6 + 3 * p.width; L.shadow = true; L.intensity = 9 * p.intensity; at(d, 0.3, 0, 0.05, L.pos); at(d, d.L - 0.3, 0, 0.05, L.end); }
    }

    return {
      onParam(k) { if (k === 'tint' || k === 'temperature') retint(); },

      phase(c, name) {
        const p = S.params;
        if (name === 'charge') {
          retint();
          const d = c.data.f = states[c.index];
          d.split = false; d.te = 0; d.splatT = 0; d.heatT = 0; d.heat = 0; d.close = 1; d.shockT = 0;
          for (const s of d.lips) s.h = null;
          layout(c, p, d);
          c.durations.linger = p.hold + CLOSE + 0.8;
          d.crack = null;
          for (const m of cracks) if (!m.visible) { d.crack = m; m.visible = true; break; }
          setCrack(d, p, 0, -1, 1, 0.3);
          d.light = fx.lights.acquire();
          if (d.light) { d.light.type = 0; d.light.range = 4; d.light.intensity = 0; d.light.shadow = false; blackbodyRGB(p.temperature, d.light.color).multiply(tintCol); }
        } else if (name === 'impact') {
          split(c, p, c.data.f);
        } else if (name === 'done') {
          const d = c.data.f;
          if (!d) return;
          for (const s of d.lips) { if (s.h && s.h.active && s.h.seed === s.seed) s.h.release(); s.h = null; }
          if (d.crack) d.crack.visible = false;
          d.crack = null;
          d.light?.release(); d.shock?.release(); d.up0?.release(); d.up1?.release();
          d.light = d.shock = d.up0 = d.up1 = null;
        }
      },

      update(c, dt) {
        const p = S.params, d = c.data.f, L = d.light;
        if (!d.split) {
          // the hairline races to the target and past it
          const k = c.t / c.durations.charge, front = smooth(k / 0.85);
          d.head.lerpVectors(d.A, d.B, front);
          setCrack(d, p, front, -1, 1, 0.25 + 0.35 * k);
          d.splatT -= dt;
          if (d.splatT <= 0) { d.splatT = 0.035; splat(d.A.x, d.A.z, d.head.x, d.head.z, 0.35, 1.5, 0.25 * k, 0, 'line', c.seed % 97); }
          alongHead(d, pebbleLine, 520 * p.debris, 2.2, dt);
          alongHead(d, seepLine, 300 * p.dust, 0.6, dt);
          alongHead(d, emberLine, 160 * k, 1.2, dt);
          fx.rig.shake(dt * 2.2 * p.shake * (0.4 + k), 8);
          if (L) { L.pos.copy(d.head).setY(0.25); L.intensity = 7 * p.intensity * k * (0.8 + 0.2 * Math.sin(c.age * 37)); }
          return;
        }

        d.te += dt;
        const te = d.te, hold = p.hold;
        // tear each stretch as the unzip passes it
        for (let k = 0; k < SEGS; k++) if (!d.seg[k] && te >= ((k + 0.5) / SEGS) * p.unzip) { d.seg[k] = 1; tearSegment(c, p, d, k); }
        // cooling: full heat for a moment, sags over the hold, then crusts over and closes
        const cl = smooth((te - hold) / CLOSE);
        d.close = 1 - smooth((te - hold - 0.25 * CLOSE) / (0.75 * CLOSE));
        d.heat = (1 - 0.4 * smooth((te - 0.8) / Math.max(hold - 0.8, 0.1))) * (1 - cl);
        const flick = 0.82 + 0.12 * Math.sin(c.age * 23 + c.seed) * Math.sin(c.age * 9.7) + 0.06 * Math.sin(c.age * 61);
        setCrack(d, p, 1, te, d.close, d.heat * (0.94 + 0.06 * flick));
        if (d.crack && d.close <= 0) { d.crack.visible = false; d.crack = null; }
        for (let i = 0; i < d.nLips; i++) { const s = d.lips[i]; if (s.h && s.h.active && s.h.seed === s.seed) s.h.heat = 0.45 * d.heat; }

        // the floor stays hot along the crack while it is open
        d.heatT -= dt;
        if (d.heatT <= 0 && d.heat > 0.05) { d.heatT = 0.3; splat(d.A.x, d.A.z, d.B.x, d.B.z, p.width * 1.4, 0, 0.12 * d.heat, 0.05, 'line', c.seed % 97); }

        // vents: steam puffs, magma spurts
        const on = d.heat * (1 - cl);
        for (let k = 0; k < VENTS; k++) {
          const v = d.vents[k];
          v.next -= dt;
          if (v.next > 0 || on < 0.05) continue;
          v.next = 0.35 + fx.rand() * 0.9;
          const e = edgeAt(d, v.u, d.close);
          at(d, v.u, e.c, 0.08, _a);
          ventSteam.pos.copy(_a); ventSteam.p.set((fx.rand() - 0.5) * 0.3, 1, (fx.rand() - 0.5) * 0.3); ventSteam.size = 1.0 + 0.5 * on; ventSteam.burst(14 * p.steam * on);
          if (fx.rand() < 0.45) {
            ventSpatter.pos.copy(_a); ventSpatter.p.copy(ventSteam.p); ventSpatter.burst(26 * p.debris * on);
            if (fx.rand() < 0.5) { ventMagma.pos.copy(_a); ventMagma.p.copy(UP).addScaledVector(d.N, fx.rand() < 0.5 ? -0.9 : 0.9); ventMagma.burst(3 * p.debris); }
          }
        }
        // the curtain of fire: fountains along the whole cut, each stretch pulsing to its own height,
        // strongest just after the split and dying back to the vents within ~2 s
        const fz = smooth(te / 0.1) * (1 - smooth((te - 0.5) / 1.5)) * (1 - cl);
        if (fz > 0.01) {
          for (let k = 0; k < 4; k++) {
            const pulse = 0.5 + 0.5 * Math.sin(c.age * (5.3 + 1.7 * k) + k * 2.1 + d.offs * 20) * Math.sin(c.age * (2.9 + 0.8 * k) + k);
            const u0 = d.L * (0.06 + 0.22 * k), u1 = u0 + d.L * 0.22;
            at(d, u0, edgeAt(d, u0, 1).c, 0.05, _a); at(d, u1, edgeAt(d, u1, 1).c, 0.05, _b);
            fountainSeg.pos.copy(_a); fountainSeg.p.copy(_b);
            fountainSeg.vel.set(0, (3.2 + 4.2 * pulse) * Math.sqrt(fz) * (0.8 + 0.4 * p.intensity), 0);
            fountainSeg.rate(520 * p.debris * fz * (0.5 + 0.5 * pulse), dt);
            fountainSeg.vel.y *= 0.3; fountainSeg.rate(260 * p.debris * fz, dt);   // the low, dense sheet at the mouth
          }
          alongCut(d, gasLine, 70 * p.steam * fz, 2.2, 0.9, dt);
        }
        // a steady breath of steam, embers and heat haze along the whole cut
        if (on > 0.02) {
          alongCut(d, steamLine, 26 * p.steam * on, 1.4, 0.06, dt);
          alongCut(d, emberLine, 90 * on, 1.6, 0.06, dt);
          if (p.haze > 0) alongCut(d, hazeLine, 70 * p.haze * on, 0.8, 0.35, dt);
        }
        // forces: the pressure shell expands and goes; the thermal follows the heat
        if (d.shock) {
          d.shockT += dt;
          d.shock.p[0] = 0.5 + 9 * Math.pow(Math.min(d.shockT / 0.7, 1), 0.6);
          d.shock.p[2] = 28 * (1 - d.shockT / 0.7);
          if (d.shockT > 0.7) { d.shock.release(); d.shock = null; }
        }
        if (d.up0) d.up0.p[3] = 0.9 * on;
        if (d.up1) d.up1.p[3] = 0.9 * on;
        // dummies standing on it keep burning
        if (on > 0.3) for (const dm of fx.dummies) if (lineDist(d, dm.pos).d < p.width + 0.45) dm.status.burn = Math.max(dm.status.burn, 0.7 * on);
        if (L) L.intensity = Math.max(L.intensity * Math.exp(-dt / 0.25), 3.5 * p.intensity * on * flick);
      },
    };
  },
};
