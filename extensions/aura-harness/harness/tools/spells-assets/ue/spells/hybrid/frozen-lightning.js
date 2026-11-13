import * as THREE from 'three';
import { CRYSTAL_VERT, CRYSTAL_FRAG } from './frozen-lightning.glsl.js';

// Frozen Lightning (SPELLBOOK hybrid, ice + lightning): a bolt that freezes into a crystal lattice,
// then shatters. Charge: micro-arcs and ice motes gather on the focus while a frost ring creeps in
// at the target. Strike: a stepped leader runs focus -> target, return stroke and one restrike on
// the SAME branches (sparks, shock, Lichtenberg glow). Freeze: a front races back from the target
// along the channel and out along every branch and sub-branch; behind it each bolt segment becomes
// a faceted ice crystal (rime spurs sprout off it), so the exact bolt you saw hangs in the air as
// ice with its light trapped inside, pulses running through it, mist pouring off it, frost on the
// floor beneath it and ice spikes caging the target. Shatter: stress cracks flare, then the lattice
// bursts from the target end back to the caster into tumbling crystals, shards, glints and mist,
// and the trapped charge escapes as floor crawl arcs.
//
// The lattice geometry is written into preallocated buffers once per cast. The branch layout is a
// JS mirror of Bolts.js (same PCG hashes and lattice noise), so the ice lands on the bolt's branches.

const MAIN_SEG = 28, BR_SEG = 8, SUB_SEG = 4, MAX_BR = 8, MAX_SUB = 6, MAX_SPUR = 44;
const MAX_CRYSTALS = MAIN_SEG + MAX_BR * BR_SEG + MAX_SUB * SUB_SEG + MAX_SPUR;
const VPC = 72;   // vertices per crystal: 24 flat triangles
const LATTICES = 2, N_CHARGE = 3, MAX_CRAWL = 6;
const STRIKE = 0.16;   // leader + return stroke + restrike, then the freeze starts
const TAU = Math.PI * 2;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// --- JS mirror of Bolts.js' path (PCG hashes, piecewise-linear lattice noise) ---------------
function pcg(v) {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
const urand = (v) => pcg(v >>> 0) / 4294967296;
function lnoise(x, salt) {
  const i = Math.floor(x), k = (i + salt) >>> 0;
  const a = urand(k), b = urand((k + 1) >>> 0);
  return (a + (b - a) * (x - i)) * 2 - 1;
}
const _T = new THREE.Vector3(), _Ub = new THREE.Vector3(), _Vb = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), RIGHT = new THREE.Vector3(1, 0, 0);
function frame(T) { _Ub.crossVectors(T, Math.abs(T.y) < 0.99 ? UP : RIGHT).normalize(); _Vb.crossVectors(T, _Ub); }
function boltPath(A, B, t, seed, jag, freq, octaves, freeEnd, out) {
  _T.subVectors(B, A);
  const L = _T.length();
  _T.multiplyScalar(1 / Math.max(L, 1e-6));
  frame(_T);
  let n1 = 0, n2 = 0, amp = 1, f = freq;
  for (let k = 0; k < octaves; k++) {
    const s = pcg((seed + Math.imul(k, 0x9E3779B9)) >>> 0);
    n1 += amp * lnoise(t * f, s);
    n2 += amp * lnoise(t * f, (s ^ 0x5bd1e995) >>> 0);
    amp *= 0.5; f *= 2;
  }
  const env = L * jag * Math.sqrt(Math.max(Math.sin(Math.PI * t * (1 - 0.5 * freeEnd)), 0));
  return out.lerpVectors(A, B, t).addScaledVector(_Ub, n1 * env).addScaledVector(_Vb, n2 * env);
}
// 25-50 degrees off T, random azimuth
function deviate(T, h, out) {
  const th = (25 + 25 * urand(h + 1)) * Math.PI / 180, ph = TAU * urand(h + 2);
  frame(T);
  return out.copy(T).multiplyScalar(Math.cos(th)).addScaledVector(_Ub, Math.sin(th) * Math.cos(ph)).addScaledVector(_Vb, Math.sin(th) * Math.sin(ph));
}

export default {
  id: 'frozen-lightning', name: 'Frozen Lightning', element: 'hybrid', order: 10,
  shape: 'strike',
  params: {
    intensity: 1, branches: 6, jag: 0.12, thickness: 1, spurs: 1, freeze: 1, hold: 1, shatter: 1, mist: 1, glints: 1, frost: 1,
    core: '#e6f4ff', glow: '#4fc8ff', tint: '#a8dcff',
  },
  ranges: {
    intensity: [0.1, 3, 0.01], branches: [0, 8, 1], jag: [0.04, 0.25, 0.005], thickness: [0.4, 2.5, 0.01], spurs: [0, 2, 0.01],
    freeze: [0.4, 3, 0.01], hold: [0.2, 3, 0.01], shatter: [0, 3, 0.01], mist: [0, 3, 0.01], glints: [0, 3, 0.01], frost: [0, 2, 0.01],
  },
  presets: {
    aurora: { glow: '#3dffb0', core: '#e8fff4', tint: '#b8ffe8' },
    'void ice': { glow: '#9a5bff', core: '#f2e8ff', tint: '#c8b8ff', jag: 0.16 },
    glacier: { glow: '#2f7dff', tint: '#5fa8ff', thickness: 1.5, spurs: 1.6, branches: 8 },
  },
  timing: { charge: 0.8, impact: 2, linger: 2.4 },
  kinds: {},

  create(fx) {
    const S = this, P = fx.particles;
    const mote = P.emitter('ice.mote', { shape: 'shell', radius: 1.3, spread: 0.1, radial: -2.2 });
    const eMote = P.emitter('lightning.mote', { shape: 'shell', radius: 1.8, spread: 0.2 });
    const tMote = P.emitter('ice.mote', { shape: 'shell', radius: 1.6, spread: 0.3, radial: -1.2 });
    const mist = P.emitter('ice.mist', { shape: 'sphere', radius: 0.3, spread: 0.3 });
    const lineMist = P.emitter('ice.mist', { shape: 'line', radius: 0.12, spread: 0.25 });
    const glint = P.emitter('ice.glint', { shape: 'sphere', radius: 0.2, spread: 3.5, radial: 2 });
    const lineGlint = P.emitter('ice.glint', { shape: 'line', radius: 0.15, spread: 2.5 });
    const shard = P.emitter('ice.shard', { shape: 'line', radius: 0.12, spread: 1.8, radial: 2.5 });
    const chip = P.emitter('ice.chip', { shape: 'line', radius: 0.1, spread: 2.2, radial: 2 });
    const spark = P.emitter('lightning.spark', { shape: 'sphere', radius: 0.15, spread: 6, radial: 3 });
    const lineSpark = P.emitter('lightning.spark', { shape: 'line', radius: 0.05, spread: 2.5 });

    // --- look ---
    const core = new THREE.Color(), glow = new THREE.Color(), tint = new THREE.Color(), glowDim = new THREE.Color(), lightCol = new THREE.Color();
    const absorb = new THREE.Vector3(), inscat = new THREE.Vector3(), glowV = new THREE.Vector3(), coreV = new THREE.Vector3(), look = new THREE.Vector4();
    function applyLook() {
      const p = S.params;
      core.set(p.core); glow.set(p.glow); tint.set(p.tint);
      glowDim.copy(glow).multiplyScalar(0.08);
      lightCol.copy(glow).lerp(core, 0.4);
      absorb.set(-Math.log(Math.max(tint.r, 0.01)), -Math.log(Math.max(tint.g, 0.01)), -Math.log(Math.max(tint.b, 0.01))).multiplyScalar(6);
      inscat.set(tint.r * tint.r, tint.g * tint.g, tint.b * tint.b).multiplyScalar(0.6);
      glowV.set(glow.r, glow.g, glow.b).multiplyScalar(3);
      coreV.set(core.r, core.g, core.b).multiplyScalar(4);
      look.set(1.31, p.frost, p.glints, 3);
    }
    applyLook();

    // --- lattice meshes: preallocated buffers, rewritten once per cast ---
    const NV = MAX_CRYSTALS * VPC;
    const lattices = [];
    for (let i = 0; i < LATTICES; i++) {
      const geo = new THREE.BufferGeometry();
      const attr = (name, size) => { const a = new THREE.BufferAttribute(new Float32Array(NV * size), size); a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a; };
      const L = {
        pos: attr('position', 3), chunk: attr('aChunk', 4), axis: attr('aAxis', 4), info: attr('aInfo', 4), vel: attr('aVel', 3),
        n: 0, free: true, maxFront: 0, attrs: null,
        u: { uFreeze: { value: new THREE.Vector4(0, 0.12, -1, 0.25) }, uShatter: { value: new THREE.Vector4(7, 9.8, 0, 0) }, uTrap: { value: new THREE.Vector4() } },
      };
      geo.setDrawRange(0, 0);
      L.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: CRYSTAL_VERT, fragmentShader: CRYSTAL_FRAG,
        uniforms: { ...fx.U, ...L.u, uLook: { value: look }, uAbsorb: { value: absorb }, uInscat: { value: inscat }, uGlow: { value: glowV }, uCoreCol: { value: coreV } },
      }));
      L.mesh.frustumCulled = false;
      L.mesh.visible = false;
      L.geo = geo;
      L.attrs = [L.pos, L.chunk, L.axis, L.info, L.vel];
      fx.scenes.refract.add(L.mesh);
      lattices.push(L);
    }
    const takeLattice = () => { for (let i = 0; i < LATTICES; i++) if (lattices[i].free) { lattices[i].free = false; return lattices[i]; } return null; };
    const dropLattice = (L) => { if (L) { L.mesh.visible = false; L.free = true; } };

    // --- crystal writer ---
    const V3 = () => new THREE.Vector3();
    const ring0 = Array.from({ length: 6 }, V3), ring1 = Array.from({ length: 6 }, V3);
    const _u = V3(), _c = V3(), _e1 = V3(), _e2 = V3(), _t0 = V3(), _t1 = V3(), _n = V3(), _ab = V3(), _ac = V3(), _cv = V3(), _vel = V3();
    let W = null, Wv = 0, Wtf = 0, Wseed = 0, Wkind = 0, Wr = 0, Whl = 0;   // current crystal (writer state)
    function vert(p) {
      const i = Wv++;
      W.pos.array[i * 3] = p.x; W.pos.array[i * 3 + 1] = p.y; W.pos.array[i * 3 + 2] = p.z;
      W.chunk.array[i * 4] = _c.x; W.chunk.array[i * 4 + 1] = _c.y; W.chunk.array[i * 4 + 2] = _c.z; W.chunk.array[i * 4 + 3] = Wtf;
      W.axis.array[i * 4] = _u.x; W.axis.array[i * 4 + 1] = _u.y; W.axis.array[i * 4 + 2] = _u.z; W.axis.array[i * 4 + 3] = Wr;
      W.info.array[i * 4] = Wseed; W.info.array[i * 4 + 1] = Whl; W.info.array[i * 4 + 2] = Wkind; W.info.array[i * 4 + 3] = 0;
      W.vel.array[i * 3] = _vel.x; W.vel.array[i * 3 + 1] = _vel.y; W.vel.array[i * 3 + 2] = _vel.z;
    }
    // outward winding (front faces face away from the crystal's centre)
    function tri(a, b, c) {
      _n.crossVectors(_ab.subVectors(b, a), _ac.subVectors(c, a));
      _cv.addVectors(a, b).add(c).multiplyScalar(1 / 3).sub(_c);
      if (_n.dot(_cv) >= 0) { vert(a); vert(b); vert(c); } else { vert(a); vert(c); vert(b); }
    }
    // hexagonal bipyramid from a to b, radius r; front time tf; burst velocity from the lattice line
    function crystal(L, a, b, r, tf, kind, rnd, lineA, lineB, force) {
      if (L.n >= MAX_CRYSTALS) return;
      _u.subVectors(b, a);
      const len = Math.max(_u.length(), 1e-3);
      _u.multiplyScalar(1 / len);
      _c.addVectors(a, b).multiplyScalar(0.5);
      const hl = len * 0.5, tl = r * (kind === 2 ? 2.5 : 1.1), tw = rnd() * TAU;
      frame(_u); _e1.copy(_Ub); _e2.copy(_Vb);
      for (let k = 0; k < 6; k++) {
        const ang = tw + k * Math.PI / 3, rr = r * (0.88 + 0.24 * rnd());
        ring0[k].copy(_c).addScaledVector(_u, -hl).addScaledVector(_e1, Math.cos(ang) * rr).addScaledVector(_e2, Math.sin(ang) * rr);
        ring1[k].copy(_c).addScaledVector(_u, hl).addScaledVector(_e1, Math.cos(ang) * rr * (kind === 2 ? 0.6 : 0.92)).addScaledVector(_e2, Math.sin(ang) * rr * (kind === 2 ? 0.6 : 0.92));
      }
      _t0.copy(_c).addScaledVector(_u, -(hl + tl * (0.5 + 0.5 * rnd())));
      _t1.copy(_c).addScaledVector(_u, hl + tl * (0.7 + 0.6 * rnd()));
      // burst: away from the lattice line, a kick up, some scatter
      _ab.subVectors(lineB, lineA);
      const h = Math.min(1, Math.max(0, _ac.subVectors(_c, lineA).dot(_ab) / Math.max(_ab.lengthSq(), 1e-6)));
      _vel.copy(_c).sub(_ab.multiplyScalar(h).add(lineA)).setY(0);
      if (_vel.lengthSq() < 1e-4) _vel.set(rnd() - 0.5, 0, rnd() - 0.5);
      _vel.normalize().multiplyScalar(1.2 + 2.4 * rnd());
      _vel.x += (rnd() - 0.5) * 1.6; _vel.z += (rnd() - 0.5) * 1.6; _vel.y = 0.8 + 2.2 * rnd();
      _vel.multiplyScalar(force);
      W = L; Wv = L.n * VPC; Wtf = tf; Wseed = rnd(); Wkind = kind; Wr = r; Whl = hl + tl;
      for (let k = 0; k < 6; k++) {
        const j = (k + 1) % 6;
        tri(ring0[k], ring0[j], ring1[j]); tri(ring0[k], ring1[j], ring1[k]);
        tri(ring1[k], ring1[j], _t1); tri(ring0[j], ring0[k], _t0);
      }
      L.n++;
      L.maxFront = Math.max(L.maxFront, tf);
    }

    // --- per-cast state ---
    const MP = Array.from({ length: MAIN_SEG + 1 }, V3), BP = Array.from({ length: BR_SEG + 1 }, V3);
    const brA = Array.from({ length: MAX_BR }, V3), brB = Array.from({ length: MAX_BR }, V3), brSeed = new Uint32Array(MAX_BR), brLen = new Float32Array(MAX_BR), brTf = new Float32Array(MAX_BR);
    const st = Array.from({ length: 16 }, () => ({
      lattice: null, bolt: null, charge: [null, null, null], crawl: new Array(MAX_CRAWL).fill(null), nc: 0,
      L1: null, L2: null, A: V3(), B: V3(), g: V3(), front: V3(),
      speed: 10, mainLen: 1, strikes: 0, frozen: false, shattered: false, reseed: 0, nextSplat: 0, pulseT: 0,
    }));
    const _a = V3(), _b = V3(), _d = V3(), _q0 = V3(), _sB = V3(), _dir = V3();
    const seedInt = () => (fx.rand() * 16777215) | 0;
    // the lattice's own deterministic stream (keyed to c.seed, so a shot rebuilds the same ice)
    let rs = 1;
    const rnd = () => ((rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296);
    const BOLT = { a: V3(), b: V3(), branches: 6, subBranches: 6, jag: 0.12, width: 0.03, color: core, glowColor: glowDim, intensity: 0, glowWidth: 12, reveal: 0, snapToArena: false, seed: 1, branchSeed: 1 };
    function bolt(a, b, branches, sub, jag, width, glowWidth, reveal, snap) {
      BOLT.a.copy(a); BOLT.b.copy(b); BOLT.branches = branches; BOLT.subBranches = sub; BOLT.jag = jag; BOLT.width = width;
      BOLT.glowWidth = glowWidth; BOLT.reveal = reveal; BOLT.snapToArena = snap; BOLT.seed = seedInt(); BOLT.branchSeed = seedInt();
      return fx.bolts.acquire(BOLT);
    }
    const SPL = { x: 0, z: 0, radius: 1, frost: 0, glow: 0, char: 0, pattern: 'radial', seed: 0, x2: 0, z2: 0, width: 0 };
    function splat(x, z, radius, frost, glowAmt, char, pattern, seed, x2 = x, z2 = z, width = 0) {
      SPL.x = x; SPL.z = z; SPL.radius = radius; SPL.frost = frost; SPL.glow = glowAmt; SPL.char = char; SPL.pattern = pattern;
      SPL.seed = seed % 1000; SPL.x2 = x2; SPL.z2 = z2; SPL.width = width;
      fx.ground.splat(SPL);
    }
    const SHK = { pos: V3(), radius0: 0.3, radius1: 4, duration: 0.5, thickness: 0.5, distortion: 0.04, color: glow, intensity: 0, ground: false };
    function shock(pos, r0, r1, dur, thick, dist, intensity, ground) {
      SHK.pos.copy(pos); SHK.radius0 = r0; SHK.radius1 = r1; SHK.duration = dur; SHK.thickness = thick;
      SHK.distortion = dist; SHK.intensity = intensity; SHK.ground = ground;
      fx.shocks.spawn(SHK);
    }
    const SPK = { pos: V3(), dir: V3(), height: 1, radius: 0.3, material: 'ice', delay: 0, rise: 0.18, life: 2, crumble: 0.7, seed: 1 };

    // the frozen lattice of bolt h (main channel, branches, sub-branches, rime spurs)
    function buildLattice(L, h, A, B, p, d, rnd) {
      L.n = 0; L.maxFront = 0;
      const jag = h.jag, L0 = A.distanceTo(B), seed = pcg(h.seed >>> 0), bseed = h.branchSeed >>> 0;
      const nb = Math.min(MAX_BR, h.branches), ns = nb ? Math.min(MAX_SUB, h.subBranches) : 0;
      const th = p.thickness, force = p.shatter;
      for (let i = 0; i <= MAIN_SEG; i++) boltPath(A, B, i / MAIN_SEG, seed, jag, 2, 7, 0, MP[i]);
      let len = 0;
      for (let i = 0; i < MAIN_SEG; i++) len += MP[i].distanceTo(MP[i + 1]);
      d.mainLen = len;
      d.speed = len / (0.55 / p.freeze);   // the main channel freezes in 0.55 s whatever its length
      // channel: the front starts at the target end
      let fromB = len;
      let spurs = 0;
      for (let i = 0; i < MAIN_SEG; i++) {
        const sl = MP[i].distanceTo(MP[i + 1]);
        fromB -= sl;
        const taper = 0.7 + 0.3 * Math.min(1, i / 6);   // thinner where it leaves the focus
        crystal(L, MP[i], MP[i + 1], 0.11 * th * taper * (0.85 + 0.3 * rnd()), (fromB + 0.5 * sl) / d.speed, 0, rnd, A, B, force);
        if (spurs < MAX_SPUR * 0.6 && rnd() < 0.75 * p.spurs) { spur(L, MP[i], MP[i + 1], 0.1 * th, (fromB + 0.5 * sl) / d.speed + 0.03, rnd, A, B, force); spurs++; }
      }
      // branches (exactly where Bolts.js draws them)
      for (let bi = 0; bi < nb; bi++) {
        const bh = pcg((bseed + Math.imul(bi, 0x632BE5AB)) >>> 0);
        const tb = 0.05 + 0.7 * urand(bh);
        boltPath(A, B, tb, seed, jag, 2, 7, 0, brA[bi]);
        boltPath(A, B, tb + 0.05, seed, jag, 2, 7, 0, _dir);
        _dir.sub(brA[bi]).normalize();
        const bl = (0.15 + 0.25 * urand(bh + 3)) * L0;
        brB[bi].copy(brA[bi]).addScaledVector(deviate(_dir, bh, _d), bl);
        brSeed[bi] = pcg(bh + 4); brLen[bi] = bl; brTf[bi] = (1 - tb) * len / d.speed;
        for (let k = 0; k <= BR_SEG; k++) boltPath(brA[bi], brB[bi], k / BR_SEG, brSeed[bi], jag * 1.3, 2, 5, 1, BP[k]);
        for (let k = 0; k < BR_SEG; k++) {
          const tf = brTf[bi] + (k + 0.5) / BR_SEG * bl / d.speed;
          crystal(L, BP[k], BP[k + 1], 0.065 * th * (1 - 0.55 * k / BR_SEG), tf, 1, rnd, A, B, force);
          if (spurs < MAX_SPUR && rnd() < 0.35 * p.spurs) { spur(L, BP[k], BP[k + 1], 0.06 * th, tf + 0.03, rnd, A, B, force); spurs++; }
        }
      }
      // sub-branches off the branches
      for (let j = 0; j < ns; j++) {
        const strand = 9 + j, bi = j % nb;
        const sh = pcg((bseed + Math.imul(strand, 0x2C1B3C6D)) >>> 0);
        const ts = 0.1 + 0.6 * urand(sh);
        boltPath(brA[bi], brB[bi], ts, brSeed[bi], jag * 1.3, 2, 5, 1, _q0);
        boltPath(brA[bi], brB[bi], ts + 0.1, brSeed[bi], jag * 1.3, 2, 5, 1, _dir);
        _dir.sub(_q0).normalize();
        const l2 = (0.3 + 0.3 * urand(sh + 3)) * brLen[bi];
        _sB.copy(_q0).addScaledVector(deviate(_dir, sh, _d), l2);
        const s2 = pcg(sh + 4), tf0 = brTf[bi] + ts * brLen[bi] / d.speed;
        for (let k = 0; k <= SUB_SEG; k++) boltPath(_q0, _sB, k / SUB_SEG, s2, jag * 1.3, 1.5, 3, 1, BP[k]);
        for (let k = 0; k < SUB_SEG; k++) crystal(L, BP[k], BP[k + 1], 0.042 * th * (1 - 0.5 * k / SUB_SEG), tf0 + (k + 0.5) / SUB_SEG * l2 / d.speed, 1, rnd, A, B, force);
      }
      for (let i = 0; i < L.attrs.length; i++) { const a = L.attrs[i]; a.clearUpdateRanges(); a.addUpdateRange(0, L.n * VPC * a.itemSize); a.needsUpdate = true; }
      L.geo.setDrawRange(0, L.n * VPC);
    }
    // a rime spur growing off a crystal at 35-70 degrees
    function spur(L, a, b, r, tf, rnd, A, B, force) {
      _u.subVectors(b, a).normalize();
      frame(_u);
      const ph = rnd() * TAU, el = 0.6 + 0.6 * rnd();
      _dir.copy(_Ub).multiplyScalar(Math.cos(ph)).addScaledVector(_Vb, Math.sin(ph)).multiplyScalar(Math.sin(el)).addScaledVector(_u, Math.cos(el));
      _a.lerpVectors(a, b, 0.2 + 0.6 * rnd());
      _b.copy(_a).addScaledVector(_dir, (2.2 + 3 * rnd()) * r);
      crystal(L, _a, _b, r * (0.3 + 0.15 * rnd()), tf, 2, rnd, A, B, force);
    }

    function releaseAll(d) {
      d.bolt?.release(); d.bolt = null;
      for (let i = 0; i < N_CHARGE; i++) { d.charge[i]?.release(); d.charge[i] = null; }
      for (let i = 0; i < d.nc; i++) d.crawl[i]?.release();
      d.crawl.fill(null); d.nc = 0;
      d.L1?.release(); d.L2?.release(); d.L1 = d.L2 = null;
      dropLattice(d.lattice); d.lattice = null;
    }

    return {
      onParam() { applyLook(); },

      phase(c, name) {
        const p = S.params, d = st[c.index];
        if (name === 'charge') {
          applyLook();
          releaseAll(d);
          c.durations.impact = STRIKE + 0.75 / p.freeze + p.hold;   // strike, freeze, hold; the shatter opens linger
          for (let i = 0; i < N_CHARGE; i++) d.charge[i] = bolt(c.from, c.from, 0, 0, 0.25, 0.012, 8, 1, false);
          d.L1 = fx.lights.acquire();
          if (d.L1) { d.L1.range = 7; d.L1.intensity = 0; d.L1.color.copy(lightCol); d.L1.type = 0; d.L1.shadow = true; }
          d.L2 = fx.lights.acquire();
          if (d.L2) { d.L2.range = 8; d.L2.intensity = 0; d.L2.color.copy(glow).lerp(core, 0.2); d.L2.type = 0; }
          d.strikes = 0; d.frozen = false; d.shattered = false; d.reseed = 0; d.nextSplat = 0; d.pulseT = 0;
        } else if (name === 'impact') {
          for (let i = 0; i < N_CHARGE; i++) { d.charge[i]?.release(); d.charge[i] = null; }
          strike(c, p, d);
        } else if (name === 'linger') {
          shatterLattice(c, p, d);
        } else if (name === 'done') {
          releaseAll(d);
        }
      },

      update(c, dt) {
        const p = S.params, d = st[c.index], L1 = d.L1, L2 = d.L2;
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge;
          // micro-arcs over the focus and cold motes streaming in; a frost ring creeps in at the target
          d.reseed -= dt;
          for (let i = 0; i < N_CHARGE; i++) {
            const h = d.charge[i];
            if (!h) continue;
            if (d.reseed <= 0) {
              h.a.copy(c.from).add(_a.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).normalize().multiplyScalar(0.3));
              h.b.copy(c.from).add(_a.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).normalize().multiplyScalar(0.3 + 0.5 * k * fx.rand()));
              h.seed = seedInt();
            }
            h.intensity = 26 * p.intensity * (0.4 + 0.6 * k) * (fx.rand() < 0.75 ? 1 : 0);
          }
          if (d.reseed <= 0) d.reseed = 0.05;
          mote.pos.copy(c.from); mote.vel.set(0, 0, 0); mote.rate(1100 * p.glints * k, dt);
          eMote.pos.copy(c.from); eMote.vel.set(0, 0, 0); eMote.rate(900 * k, dt);
          mist.pos.copy(c.from); mist.vel.set(0, -0.4, 0); mist.size = 0.6; mist.rate(60 * p.mist, dt);
          if (c.t >= d.nextSplat) { d.nextSplat = c.t + 0.12; splat(c.to.x, c.to.z, 2.4 - 1.5 * k, 0.9 * p.frost * k, 0, 0, 'ring', c.seed + c.t * 100, c.to.x, c.to.z, 0.35); }
          tMote.pos.set(c.to.x, 0.5, c.to.z); tMote.vel.set(0, 0.3, 0); tMote.rate(500 * p.glints * k, dt);
          if (L1) { L1.pos.copy(c.from); L1.intensity = 11 * k * p.intensity * (0.8 + 0.2 * Math.sin(c.age * 41)); }
          return;
        }
        const m = d.bolt, Lt = d.lattice;
        if (c.phase === 'impact') {
          const t = c.t;
          // strike: leader, return stroke, one restrike on the same channel and branches
          if (m) {
            if (t < 0.07) { m.reveal = t / 0.07; m.intensity = 8 * p.intensity; }
            else {
              m.reveal = 1;
              if (d.strikes === 0) { d.strikes = 1; m.intensity = 75 * p.intensity; strikeBurst(c, p, d); }
              else if (d.strikes === 1 && t >= 0.12) { d.strikes = 2; m.intensity = 55 * p.intensity; fx.flash(0.2 * p.intensity); }
              else if (t < STRIKE) m.intensity *= Math.exp(-dt * 18);
              else {
                // the light drains into the ice as the front passes, down to a trapped glow that
                // keeps the bolt's scatter halo around the lattice; it strains before the shatter
                const fr = (t - STRIKE) * d.speed / Math.max(d.mainLen, 1);
                const strain = smooth(c.durations.impact - 0.35, c.durations.impact, t);
                const hold = 2.4 * p.intensity * (0.75 + 0.25 * Math.sin(c.age * 23) * Math.sin(c.age * 7.1)) * (1 + 2.5 * strain * fx.rand());
                m.intensity = Math.max(hold, Math.min(m.intensity, 9 * p.intensity * (1 - fr)) * (0.75 + 0.25 * fx.rand()));
              }
            }
          }
          const ft = Math.max(0, t - STRIKE);
          if (Lt) {
            Lt.mesh.visible = true;
            const u = Lt.u;
            u.uFreeze.value.x = t < STRIKE ? -1 : ft;
            u.uFreeze.value.z = -1;
            d.pulseT += dt;
            const frozenAll = ft > Lt.maxFront + 0.15;
            if (frozenAll && !d.frozen) d.frozen = true;
            // trapped light: a slow pulse runs target -> caster every ~1.1 s once frozen
            u.uTrap.value.set((0.7 + 0.35 * Math.sin(c.age * 23) * Math.sin(c.age * 7.1)) * p.intensity, d.frozen ? (d.pulseT * 1.4) % (Lt.maxFront + 0.8) - 0.3 : -9, smooth(c.durations.impact - 0.35, c.durations.impact, t), 1.6 * p.intensity);
            // where the front is now: glints burst off it, mist pours off the frozen channel
            const fr = Math.min(1, ft * d.speed / Math.max(d.mainLen, 1));
            if (t >= STRIKE && fr < 1) {
              d.front.lerpVectors(d.B, d.A, fr);
              glint.pos.copy(d.front); glint.vel.set(0, 0.5, 0); glint.rate(900 * p.glints, dt);
              mist.pos.copy(d.front); mist.vel.set(0, -0.6, 0); mist.size = 0.8; mist.rate(90 * p.mist, dt);
            }
            if (t >= STRIKE) {
              lineMist.pos.copy(d.B); lineMist.p.copy(d.front); lineMist.vel.set(0, -0.35, 0); lineMist.size = 0.9; lineMist.rate(70 * p.mist, dt);
              lineGlint.pos.copy(d.B); lineGlint.p.copy(d.front); lineGlint.vel.set(0, 0.3, 0); lineGlint.rate(140 * p.glints, dt);
            }
          }
          // floor frost follows the front under the channel
          if (t >= STRIKE && t >= d.nextSplat) {
            d.nextSplat = t + 0.1;
            const fr = Math.min(1, ft * d.speed / Math.max(d.mainLen, 1));
            _a.lerpVectors(d.B, d.A, fr);
            splat(d.B.x, d.B.z, 0.5, 0.55 * p.frost, 0, 0, 'line', c.seed + 3, _a.x, _a.z, 0.5);
          }
          if (L1) {
            if (t < STRIKE) L1.intensity = (m ? m.intensity : 0) * 3;
            else if (L1.type === 1) {
              // a line light this close to the polished floor mirrors as a hard streak: strike only,
              // then a point light in the middle of the lattice carries its trapped glow
              L1.intensity *= Math.exp(-dt / 0.05);
              if (t > STRIKE + 0.2) { L1.type = 0; L1.intensity = 0; L1.range = 7; L1.pos.lerpVectors(d.A, d.B, 0.55).y += 0.2; }
            } else {
              const fr = Math.min(1, ft * d.speed / Math.max(d.mainLen, 1));
              L1.intensity = 4 * p.intensity * fr * (0.8 + 0.2 * Math.sin(c.age * 23) * Math.sin(c.age * 7.1));
            }
          }
          // the cage glows from inside while the lattice holds
          if (L2) L2.intensity = Math.max(L2.intensity * Math.exp(-dt / 0.2), 5 * p.intensity * (0.8 + 0.2 * Math.sin(c.age * 19) * Math.sin(c.age * 7.3)));
          // the dummy stays frozen while caged
          if (c.target >= 0) fx.dummies[c.target].status.frozen = 1;
          return;
        }
        // linger: the lattice bursts and falls; the escaped charge crawls over the floor
        const fade = Math.max(0, 1 - c.t / c.durations.linger);
        if (Lt) {
          Lt.u.uFreeze.value.z = c.t;
          Lt.u.uTrap.value.x *= Math.exp(-dt * 6); Lt.u.uTrap.value.z *= Math.exp(-dt * 10); Lt.u.uTrap.value.w = 0;
          if (c.t > 1.4 + Lt.maxFront * 0.25) { dropLattice(Lt); d.lattice = null; }
        }
        for (let i = 0; i < d.nc; i++) {
          const h = d.crawl[i];
          if (!h) continue;
          h.intensity = fx.rand() < 0.45 * fade + 0.1 ? 30 * p.intensity * fade * fade : 0;
          if (fx.rand() < 0.25) h.branchSeed = seedInt();
        }
        if (c.t < 1.6) { mist.pos.copy(d.g).setY(0.3); mist.vel.set(0, 0, 0); mist.size = 1.1; mist.rate(40 * p.mist * (1 - c.t / 1.6), dt); }
        if (L1) L1.intensity = L1.intensity > 0.05 ? L1.intensity * Math.exp(-dt / 0.12) : 0;
        if (L2) L2.intensity = L2.intensity > 0.05 ? L2.intensity * Math.exp(-dt / 0.12) : 0;
      },
    };

    function strike(c, p, d) {
      d.A.copy(c.from);
      d.B.copy(c.to);
      if (c.target < 0) d.B.y = Math.max(d.B.y, 0.02);
      d.g.set(d.B.x, 0, d.B.z);
      const nb = Math.round(p.branches);
      d.bolt = bolt(d.A, d.B, nb, Math.min(nb, MAX_SUB), p.jag, 0.03, 12, 0, false);
      if (d.L1) { d.L1.type = 1; d.L1.pos.copy(d.A); d.L1.end.copy(d.B); d.L1.range = 14; d.L1.color.copy(lightCol); }
      d.lattice = takeLattice();
      if (d.bolt && d.lattice) {
        rs = (Math.imul(c.seed | 0, 2654435761) + 12345) >>> 0;
        buildLattice(d.lattice, d.bolt, d.A, d.B, p, d, rnd);
        d.lattice.u.uFreeze.value.set(-1, 0.12 / p.freeze, -1, 0.22);
        d.lattice.u.uTrap.value.set(0, -9, 0, 0);
      } else { dropLattice(d.lattice); d.lattice = null; d.speed = 10; d.mainLen = d.A.distanceTo(d.B); }   // bolt pool full: no ice
    }

    function strikeBurst(c, p, d) {
      const B = d.B, g = d.g;
      fx.flash(0.4 * p.intensity);
      spark.pos.copy(B); spark.vel.set(0, 1, 0); spark.burst(1400 * p.intensity);
      if (d.bolt) { lineSpark.pos.copy(d.bolt.point(0.75, _a)); lineSpark.p.copy(B); lineSpark.burst(300); }
      splat(g.x, g.z, 2.2, 1.6 * p.frost, 0.9, 0.4, 'lichtenberg', c.seed);
      splat(g.x, g.z, 1.3, 1.8 * p.frost, 0, 0, 'radial', c.seed + 11);
      fx.impacts.add('electric', B, 2.2, 1, 2, core);
      fx.impacts.add('frost', g, 3.4, 1, 7, glow);
      shock(_a.copy(g).setY(0.04), 0.3, 4.5, 0.45, 0.5, 0.05, 1.1, true);
      fx.rig.shake(0.45, 24);
      if (!fx.reduced) { fx.rig.punch(2, 0.06); fx.rig.hitstop(0.05); }
      if (d.L2) { d.L2.pos.copy(B).setY(Math.max(B.y, 0.5) + 0.3); d.L2.range = 7; d.L2.intensity = 40 * p.intensity; }
      // ice cage: spikes erupt around the target as the front arrives there
      const n = 5, a0 = fx.rand() * TAU;
      for (let i = 0; i < n; i++) {
        const ang = a0 + i * TAU / n + (fx.rand() - 0.5) * 0.4, r = 0.75 + 0.25 * fx.rand();
        SPK.pos.set(g.x + Math.cos(ang) * r, 0, g.z + Math.sin(ang) * r);
        SPK.dir.set(-Math.cos(ang) * 0.35, 1, -Math.sin(ang) * 0.35);   // leaning in over the target
        SPK.height = 0.9 + 0.6 * fx.rand(); SPK.radius = 0.24 + 0.08 * fx.rand();
        SPK.delay = STRIKE + 0.04 * i; SPK.rise = 0.16; SPK.life = c.durations.impact - SPK.delay + 0.08; SPK.crumble = 0.6;
        SPK.seed = (c.seed * 31 + i * 7919) & 0xffffff;
        fx.spikes.spawn(SPK);
      }
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i], dist = Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z);
        if (i === c.target || dist < 2.2) { dm.status.shock = 1; dm.status.frozen = Math.max(dm.status.frozen, 1 - 0.3 * dist / 2.2); }
      }
    }

    function shatterLattice(c, p, d) {
      const A = d.A, B = d.B, g = d.g;
      if (d.bolt) { d.bolt.release(); d.bolt = null; }
      lineGlint.pos.copy(A); lineGlint.p.copy(B); lineGlint.vel.set(0, 1.5, 0); lineGlint.burst(700 * p.glints);
      shard.pos.copy(B); shard.p.copy(A); shard.vel.set(0, 1.5, 0); shard.size = 0.8; shard.burst(70 * p.shatter);
      chip.pos.copy(B); chip.p.copy(A); chip.vel.set(0, 1, 0); chip.burst(160 * p.shatter);
      lineMist.pos.copy(A); lineMist.p.copy(B); lineMist.vel.set(0, -0.2, 0); lineMist.size = 1.2; lineMist.burst(90 * p.mist);
      lineSpark.pos.copy(A); lineSpark.p.copy(B); lineSpark.burst(400 * p.intensity);
      glint.pos.copy(B); glint.vel.set(0, 2, 0); glint.burst(300 * p.glints);
      shock(_a.copy(g).setY(0.04), 0.3, 3.6, 0.4, 0.45, 0.04, 0.9, true);
      shock(B, 0.2, 2.6, 0.3, 0.4, 0.05, 0, false);
      fx.impacts.add('frost', g, 2.6, 0.8, 5, glow);
      if (d.L1) d.L1.intensity = 28 * p.intensity;
      if (d.L2) { d.L2.pos.copy(B); d.L2.intensity = 25 * p.intensity; }
      fx.flash(0.14 * p.intensity);
      fx.rig.shake(0.35, 18);
      if (!fx.reduced) fx.rig.punch(1.2, 0.06);
      // the trapped charge escapes along the floor
      d.nc = 0;
      for (let i = 0; i < MAX_CRAWL; i++) {
        const ang = (i / MAX_CRAWL) * TAU + fx.rand(), len = 1.2 + 1.6 * fx.rand();
        _a.copy(g).setY(0.05);
        _b.set(g.x + Math.cos(ang) * len, 0.02, g.z + Math.sin(ang) * len);
        const h = bolt(_a, _b, 2, 2, 0.18, 0.012, 8, 1, true);
        if (h) d.crawl[d.nc++] = h;
      }
      splat(g.x, g.z, 1.8, 0, 0.7, 0, 'lichtenberg', c.seed + 5);
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i], dist = Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z);
        if (i === c.target || dist < 2.5) { dm.status.shock = 1; dm.hit(_d.subVectors(dm.pos, A).setY(0).normalize(), 0.7 * Math.max(0.3, 1 - dist / 2.5)); }
      }
    }
  },
};
