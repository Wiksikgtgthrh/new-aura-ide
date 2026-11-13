import * as THREE from 'three';
import { ARENA, FX_BLENDING } from '../../vfx/common.js';
import { foamTexture } from '../../vfx/ParticleFluid.js';
import { WAVE_VERT, WAVE_FRAG, CURTAIN_VERT, CURTAIN_FRAG, PLUME_VERT, PLUME_FRAG, PLUME_N, MANE_VERT, MANE_N, NP, NK, NU, NV, NUC, NVC } from './tsunami.glsl.js';

// Tsunami (SPELLBOOK, Water hero). The orb drains the pool: the water surface swirls and streams
// of droplets arc across the arena into a swell welling up behind the target, which drags loose
// particles towards it. On release the swell rears into a wall of water, spindrift tearing off its
// crest; the lip pitches forward (torn into jets by alpha-clip, shedding droplets), curls into a
// barrel over the target and plunges: a splash-up curtain of spray, drops, foam and mist peels
// outward along the crest as each section lands, the camera kicks and the dummies are thrown and
// soaked. The wave collapses into a foaming bore that runs on, painting a wet swath, pushing every
// loose particle ahead of it, then thins into a laced sheet that dissolves, leaving puddles, drips
// and low mist. The sheet is its own refract-pass mesh (tsunami.glsl.js), lit like the founding
// water (Fresnel sky, refracted and absorbed scene, tint-derived absorption and scatter), with a
// caustic cookie light riding under the barrel.

const G = 9.81;
const MAX_WAVES = 4;
const POOL = ARENA.pool;
const UP = new THREE.Vector3(0, 1, 0);

// key poses (x forward, y up, in units of the wave height); per pose: rear base, back slope (3),
// crest top, outer lip, lip tip, inner lip, barrel roof, face (2), toe
const POSES = [
  // 0 swell
  [[-1.4, 0], [-1.0, 0.02], [-0.65, 0.065], [-0.3, 0.115], [0, 0.14], [0.18, 0.137], [0.34, 0.128], [0.48, 0.115], [0.62, 0.095], [0.8, 0.065], [1.05, 0.03], [1.4, 0]],
  // 1 rising wall: the face stands up and starts to overhang
  [[-1.15, 0], [-0.85, 0.13], [-0.55, 0.42], [-0.26, 0.76], [-0.04, 0.97], [0.12, 1.0], [0.24, 0.95], [0.27, 0.86], [0.26, 0.7], [0.22, 0.45], [0.3, 0.16], [0.62, 0]],
  // 2 pitching lip
  [[-1.15, 0], [-0.85, 0.14], [-0.55, 0.45], [-0.24, 0.82], [0.04, 1.04], [0.4, 1.06], [0.66, 0.86], [0.52, 0.9], [0.3, 0.84], [0.16, 0.55], [0.22, 0.18], [0.55, 0]],
  // 3 barrel: the lip claws down in front of the face
  [[-1.1, 0], [-0.8, 0.14], [-0.5, 0.45], [-0.2, 0.8], [0.1, 1.0], [0.58, 0.92], [0.86, 0.36], [0.74, 0.5], [0.5, 0.8], [0.2, 0.6], [0.22, 0.2], [0.5, 0]],
  // 4 crash: the lip lands, the barrel's air pocket squashes
  [[-1.15, 0], [-0.85, 0.08], [-0.5, 0.22], [-0.15, 0.38], [0.25, 0.47], [0.8, 0.38], [1.12, 0.03], [1.0, 0.08], [0.75, 0.18], [0.5, 0.18], [0.45, 0.06], [0.6, -0.05]],
  // 5 bore (the inner surfaces sink under the floor)
  [[-1.8, 0], [-1.3, 0.025], [-0.8, 0.055], [-0.3, 0.1], [0.3, 0.17], [0.9, 0.2], [1.3, 0.04], [1.18, 0.0], [1.0, -0.04], [0.85, -0.06], [0.75, -0.08], [0.95, -0.1]],
  // 6 spent sheet
  [[-2.2, 0], [-1.7, 0.012], [-1.1, 0.022], [-0.5, 0.03], [0.2, 0.04], [0.9, 0.045], [1.45, 0.005], [1.3, -0.02], [1.1, -0.05], [0.9, -0.06], [0.75, -0.08], [0.95, -0.1]],
];
// time since release (s, at speed 1) -> phase, and travel of the anchor (x H)
const TK = [-1.0, 0.0, 0.6, 1.1, 1.45, 1.7, 2.35, 6.0];
const SK = [0, 0.3, 1, 2, 3, 4, 5, 6];
const DK = [0, 0.04, 0.3, 0.6, 0.85, 1.0, 1.25, 1.35];
const T_IMPACT = 2.8, T_LINGER = 3.2;
const BACK = 1.35;       // the wave rises this far (x H) behind the target: the target sits in the barrel
const NSEG = 4;          // emission walks the crest in segments, one per frame
const S_CRASH = 3.55;    // the centre of the lip lands at this phase
const CURT_LIFE = 1.4;  // splash-up curtain life (s)
const SPLASH_LIFE = 2.6; // the last plume puff is down by then (s after the centre lands)

// --- module scratch (no allocation after create) -----------------------------------------------
const PS = new Float32Array(NK * NP * 2);   // poses with the curl applied
const PT = { x: 0, y: 0 };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _v = new THREE.Vector3();
const SPL = { x: 0, z: 0, x2: 0, z2: 0, radius: 1, width: 1, wet: 0, pattern: 'noise', seed: 0 };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const cr = (a, b, c, d, g) => 0.5 * (2 * b + (c - a) * g + (2 * a - 5 * b + 4 * c - d) * g * g + (3 * b - a - 3 * c + d) * g * g * g);
// absorption (1/m) per channel from the tint: the default tint gives Ultra Water's ocean (0.42, 0.075, 0.048)
const absorb = (x) => 0.048 + 0.104 * -Math.log(Math.max(x, 0.03));
const nearPool = (x, z, m) => Math.abs(x - POOL.center.x) < POOL.half.x + m && Math.abs(z - POOL.center.y) < POOL.half.y + m;
function lerpKeys(keys, vals, t) {
  if (t <= keys[0]) return vals[0];
  for (let i = 1; i < keys.length; i++) if (t < keys[i]) return vals[i - 1] + (vals[i] - vals[i - 1]) * (t - keys[i - 1]) / (keys[i] - keys[i - 1]);
  return vals[vals.length - 1];
}
// control point i at phase s (the JS mirror of the vertex shader's pose())
function pt(i, s) {
  const sc = Math.min(Math.max(s, 0), NK - 1);
  const k = Math.min(Math.floor(sc), NK - 2), f = sc - k;
  const a = (Math.max(k - 1, 0) * NP + i) * 2, b = (k * NP + i) * 2, c = ((k + 1) * NP + i) * 2, d = (Math.min(k + 2, NK - 1) * NP + i) * 2;
  PT.x = cr(PS[a], PS[b], PS[c], PS[d], f);
  PT.y = cr(PS[a + 1], PS[b + 1], PS[c + 1], PS[d + 1], f);
  return PT;
}
// crest-line height: a plateau dropping off towards the ends (mirrors the shaders' taper())
const taper = (u) => { const e = Math.abs(2 * u - 1); return Math.pow(Math.max(1 - e * e * e, 0), 0.6); };
// launch velocity landing in T seconds under gravity and the drop kind's drag plus the ambient wind
const DRAG = 0.35;
function launch(out, from, to, T) {
  const e = (1 - Math.exp(-DRAG * T)) / DRAG;
  out.subVectors(to, from).divideScalar(e);
  out.y += (G / DRAG) * (T - e) / e;
  return out;
}
function gridGeometry(nu, nv) {
  const g = new THREE.InstancedBufferGeometry(), pos = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) pos.push(i / nu, j / nv, 0);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, c = a + nu + 1;
    idx.push(a, a + 1, c + 1, a, c + 1, c);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.instanceCount = 0;
  return g;
}
function instAttr(g, name, n) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, a);
  return a;
}

export default {
  id: 'tsunami', name: 'Tsunami', element: 'water', order: 10, hue: '#2fa8ff',
  shape: 'area',
  params: { height: 6, width: 13, speed: 1, curl: 1, peel: 1.0, angle: -60, foam: 1, spray: 1, mist: 1, wetness: 1, clarity: 1, tint: '#2fe4ff', foamColor: '#f2f6f7' },
  ranges: { height: [2, 8, 0.1], width: [6, 20, 0.1], speed: [0.5, 1.8, 0.01], curl: [0.4, 1.5, 0.01], peel: [0, 2.5, 0.01], angle: [-90, 90, 1], foam: [0, 2, 0.01], spray: [0, 3, 0.01], mist: [0, 3, 0.01], wetness: [0, 2, 0.01], clarity: [0.2, 3, 0.01] },
  presets: {
    'rogue wave': { height: 7.5, width: 17, speed: 0.85, clarity: 0.7, spray: 1.4, mist: 1.4 },
    tropical: { tint: '#1fe0c8', clarity: 1.7, foam: 1.2, height: 4 },
    abyssal: { tint: '#1a4dff', clarity: 0.6, foam: 0.7, mist: 1.6, foamColor: '#cfe0f0' },
  },
  timing: { charge: 1.0, impact: T_IMPACT, linger: T_LINGER },
  // reuses the founding water's drop / spray / mist; whitewater, spray and mist are its own meshes
  kinds: {},

  create(fx) {
    const S = this, P = fx.particles;
    const drops = P.emitter('water.drop', { shape: 'line', radius: 0.15, spread: 1.2 });
    const spray = P.emitter('water.spray', { shape: 'line', radius: 0.3, spread: 0.8 });
    const mist = P.emitter('water.mist', { shape: 'line', radius: 0.4, spread: 0.5 });
    const beads = P.emitter('water.drop', { shape: 'disk', radius: 1.0, spread: 0.12 });
    const welling = P.emitter('water.spray', { shape: 'ring', radius: 1.5, spread: 0.4 });
    const drip = P.emitter('water.drop', { shape: 'line', radius: 0.3, spread: 0.15 });

    // water colour, as the founding water derives it from the tint
    const tint = new THREE.Color(), absorption = new THREE.Color(), scatter = new THREE.Color(), lightCol = new THREE.Color(), foamCol = new THREE.Color(), foamTint = new THREE.Color();
    const WHITE = new THREE.Color(1, 1, 1);
    const look = new THREE.Vector4(1, 0.2, 0.3, 1.6), shape = new THREE.Vector4(0.9, 0.35, 0.25, 0.25), curt = new THREE.Vector4(1, CURT_LIFE, 0, 0);
    const poseU = Array.from({ length: NK * NP }, () => new THREE.Vector2());
    function optics() {
      const p = S.params;
      tint.set(p.tint);
      absorption.setRGB(absorb(tint.r), absorb(tint.g), absorb(tint.b)).multiplyScalar(1 / p.clarity);
      // Ultra Water's deep in-scatter (0, 0.05, 0.08) for the default tint: weighted to the blue, so
      // a deep face reads slate-blue, not green
      scatter.setRGB(tint.r * 0.02, tint.g * 0.056, tint.b * 0.085);
      lightCol.copy(tint).lerp(WHITE, 0.55);
      foamCol.set(p.foamColor);
      foamTint.copy(tint).multiplyScalar(0.25).addScalar(0.58);   // a bubble film over the water colour
      look.x = p.foam;
      look.z = 0.3 / p.clarity;   // suspended bubbles and sand: a breaking wave is never glass-clear
      shape.x = p.peel;
      shape.w = 0.25 / p.speed;   // s per phase unit around the crash
    }
    // the curl stretches the lip (points past the crest) away from the crest
    function poses() {
      const k = S.params.curl;
      for (let j = 0; j < NK; j++) {
        const cx = POSES[j][4][0];
        for (let i = 0; i < NP; i++) {
          const q = POSES[j][i], o = (j * NP + i) * 2;
          const lip = i >= 5 && i <= 9 && j >= 1 && j <= 4;
          PS[o] = lip ? cx + (q[0] - cx) * k : q[0];
          PS[o + 1] = q[1];
          poseU[j * NP + i].set(PS[o], PS[o + 1]);
        }
      }
      curt.x = PS[(4 * NP + 6) * 2];   // where the lip tip lands
    }
    optics();
    poses();

    const foamTex = foamTexture(fx.renderer);
    const geo = gridGeometry(NU, NV);
    const aA = instAttr(geo, 'iA', MAX_WAVES), aB = instAttr(geo, 'iB', MAX_WAVES), aC = instAttr(geo, 'iC', MAX_WAVES);
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: WAVE_VERT, fragmentShader: WAVE_FRAG,
      uniforms: { ...fx.U, uPose: { value: poseU }, uShape: { value: shape }, uAbsorption: { value: absorption }, uScatter: { value: scatter }, uFoamColor: { value: foamCol }, uFoamTint: { value: foamTint }, uLook: { value: look }, uFoamTex: { value: foamTex } },
      side: THREE.FrontSide, alphaToCoverage: true,
    }));
    mesh.frustumCulled = false;
    mesh.visible = false;
    fx.scenes.refract.add(mesh);
    // crest spray: MANE_N quads, drawn once per live wave with the wave's instance data
    const mgeo = new THREE.InstancedBufferGeometry(), mpos = new Float32Array(MANE_N * 12), mpuff = new Float32Array(MANE_N * 16), midx = [];
    const CORNER = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < MANE_N; i++) {
      const r = [(i + 0.5) / MANE_N, Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1, Math.abs(Math.sin(i * 78.233) * 12543.123) % 1, Math.abs(Math.sin(i * 39.425) * 24634.634) % 1];
      for (let c = 0; c < 4; c++) {
        mpos.set([CORNER[c * 2], CORNER[c * 2 + 1], 0], (i * 4 + c) * 3);
        mpuff.set(r, (i * 4 + c) * 4);
      }
      midx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    }
    mgeo.setAttribute('position', new THREE.Float32BufferAttribute(mpos, 3));
    mgeo.setAttribute('aPuff', new THREE.Float32BufferAttribute(mpuff, 4));
    mgeo.setIndex(midx);
    mgeo.setAttribute('iA', aA); mgeo.setAttribute('iB', aB); mgeo.setAttribute('iC', aC);
    mgeo.instanceCount = 0;
    const maneU = new THREE.Vector4(1, 1, 0, 0);
    const mane = new THREE.Mesh(mgeo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: MANE_VERT, fragmentShader: PLUME_FRAG, ...FX_BLENDING,
      uniforms: { ...fx.U, uPose: { value: poseU }, uShape: { value: shape }, uMane: { value: maneU }, uFoamColor: { value: foamCol } },
    }));
    mane.frustumCulled = false;
    mane.visible = false;
    fx.scenes.fx.add(mane);
    // --- splash (curtain + plume) -------------------------------------------------------------------
    // Everything thrown up where the lip lands, driven only by per-crash data (origin, frame, crash
    // age, travel, launch and front speed): the refract-pass curtain sheet and the fx-pass spray
    // plume. Kept apart from the wave so it can move onto a particle-fluid system as one piece.
    const splash = (() => {
      const cgeo = gridGeometry(NUC, NVC);
      const cA = instAttr(cgeo, 'iA', MAX_WAVES), cB = instAttr(cgeo, 'iB', MAX_WAVES), cC = instAttr(cgeo, 'iC', MAX_WAVES);
      const curtain = new THREE.Mesh(cgeo, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: CURTAIN_VERT, fragmentShader: CURTAIN_FRAG,
        uniforms: { ...fx.U, uShape: { value: shape }, uCurt: { value: curt }, uAbsorption: { value: absorption }, uScatter: { value: scatter }, uFoamColor: { value: foamCol }, uFoamTint: { value: foamTint }, uLook: { value: look }, uFoamTex: { value: foamTex } },
        side: THREE.DoubleSide, alphaToCoverage: true,
      }));
      curtain.frustumCulled = false;
      curtain.visible = false;
      fx.scenes.refract.add(curtain);
      const pgeo = new THREE.InstancedBufferGeometry();
      pgeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
      pgeo.setIndex([0, 1, 2, 0, 2, 3]);
      pgeo.instanceCount = 0;
      const PA = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());
      const PB = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());
      const PC = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());
      const plumeU = new THREE.Vector4(1, 1, 0, 0);
      const plume = new THREE.Mesh(pgeo, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG, ...FX_BLENDING,
        uniforms: { ...fx.U, uShape: { value: shape }, uCurt: { value: curt }, uPA: { value: PA }, uPB: { value: PB }, uPC: { value: PC }, uPlume: { value: plumeU }, uFoamColor: { value: foamCol } },
      }));
      plume.frustumCulled = false;
      plume.visible = false;
      fx.scenes.fx.add(plume);
      let m = 0;
      return {
        begin() { m = 0; },
        // one crash: ac = age at the centre (s), d = anchor travel at the crash (m)
        add(O, F, H, W, seedF, ac, d, launch, front) {
          if (m >= MAX_WAVES) return;
          const o = m * 4, A = cA.array, B = cB.array, C = cC.array;
          A[o] = O.x; A[o + 1] = O.y; A[o + 2] = O.z; A[o + 3] = seedF;
          B[o] = F.x; B[o + 1] = F.z; B[o + 2] = H; B[o + 3] = W;
          C[o] = ac; C[o + 1] = d; C[o + 2] = launch; C[o + 3] = front;
          PA[m].set(O.x, O.y, O.z, seedF); PB[m].set(F.x, F.z, H, W); PC[m].set(ac, d, launch, front);
          m++;
        },
        end(amount) {
          cgeo.instanceCount = m;
          curtain.visible = m > 0;
          pgeo.instanceCount = m * PLUME_N;
          plume.visible = m > 0 && amount > 0;
          plumeU.x = amount;
          if (m) cA.needsUpdate = cB.needsUpdate = cC.needsUpdate = true;
        },
      };
    })();

    // per-cast state, indexed by the cast record (cast.js keeps 16)
    const ST = Array.from({ length: 16 }, () => ({
      live: false, O: new THREE.Vector3(), F: new THREE.Vector3(), S: new THREE.Vector3(), src: new THREE.Vector3(),
      H: 1, W: 1, s: 0, d: 0, grow: 0, fade: 0, age: 0, seedF: 0, tau: 0, crashT: 0, crashD: 0,
      light: null, force: null, mask: 0, crashed: false, seg: 0, splat: 0, rip: 0, wetDummy: -1, released: false,
    }));
    let lensWet = 0;

    // world position of control point i at lateral u (the JS mirror of wavePos at integer t)
    function waveAt(st, u, i, out) {
      const e = 2 * u - 1, p = S.params;
      const brk = sstep(0.8, 2, st.s) * (1 - sstep(4.5, 5.5, st.s));
      const jit = (0.07 * Math.sin(u * 7.3 + st.seedF * 6.2831853) + 0.05 * Math.sin(u * 17.9 + st.seedF * 11) + 0.03 * Math.sin(u * 31.1 + st.seedF * 4)) * brk;
      const su = Math.max(st.s + p.peel * (u - 0.5) + jit, 0);
      const Hu = st.H * st.grow * taper(u) * (1 + 0.07 * Math.sin(u * 7 + st.seedF * 6.2831853));
      pt(i, su);
      const W = st.W * (1 + 0.25 * sstep(3, 6, st.s));
      out.copy(st.O).addScaledVector(st.F, st.d - 0.35 * st.H * e * e + PT.x * Hu).addScaledVector(st.S, e * 0.5 * W);
      out.y = st.O.y + PT.y * Hu;
      return su;
    }
    function wetLine(a, b, width, wet, seed) {
      SPL.pattern = 'line'; SPL.x = a.x; SPL.z = a.z; SPL.x2 = b.x; SPL.z2 = b.z; SPL.width = width; SPL.radius = width; SPL.wet = wet; SPL.seed = seed % 1000;
      fx.ground.splat(SPL);
    }
    function wetSpot(x, z, radius, wet, seed) {
      SPL.pattern = 'noise'; SPL.x = SPL.x2 = x; SPL.z = SPL.z2 = z; SPL.radius = radius; SPL.width = 0; SPL.wet = wet; SPL.seed = seed % 1000;
      fx.ground.splat(SPL);
    }

    // the swell, the wall, the curl, the crash, the bore: everything keyed off the phase
    function step(c, st, dt) {
      const p = S.params, H = st.H, tau = st.tau;
      const sp = p.speed;
      st.s = lerpKeys(TK, SK, tau * sp);
      st.d = lerpKeys(TK, DK, tau * sp) * H;
      st.grow = tau < 0 ? sstep(-1, -0.15, tau * sp) : 1;
      st.fade = sstep(4.6, 6.0, tau * sp);
      const s = st.s, L = st.light;

      // emission walks the crest one segment per frame (one record per emitter)
      const j = st.seg, u0 = 0.06 + 0.88 * j / NSEG, u1 = 0.06 + 0.88 * (j + 1) / NSEG, um = 0.5 * (u0 + u1);
      st.seg = (st.seg + 1) % NSEG;
      const sdt = dt * NSEG, wgt = taper(um);
      const su = waveAt(st, um, 6, _c);   // this segment's phase (and its lip tip)
      if (tau >= 0) {
        // the lip sheds droplets and spray as it throws
        if (su > 1.3 && su < 3.4) {
          waveAt(st, u0, 6, drops.pos); waveAt(st, u1, 6, drops.p);
          drops.vel.copy(st.F).multiplyScalar(3 + 2 * sp).addScaledVector(UP, su < 2.5 ? 1.5 : -1); drops.radial = 1.2; drops.size = 2.2; drops.spread = 1.6;
          drops.rate(900 * p.spray * wgt, sdt);
          spray.pos.copy(drops.pos); spray.p.copy(drops.p);
          spray.vel.copy(st.F).multiplyScalar(2.5).addScaledVector(UP, 0.6); spray.size = 1.6; spray.radial = 0.8;
          spray.rate(45 * p.spray * wgt, sdt);
        }
        // the plunge: a splash-up curtain where this section of the lip lands
        if (su > 3.3 && su < 4.4) {
          const k = clamp01(1 - Math.abs(su - 3.75) / 0.6);
          waveAt(st, u0, 6, drops.pos); waveAt(st, u1, 6, drops.p);
          drops.pos.y = drops.p.y = 0.15;
          drops.vel.copy(st.F).multiplyScalar(3).addScaledVector(UP, 6.5); drops.radial = 2.5; drops.size = 2.4; drops.spread = 2.4;
          drops.rate(3200 * p.spray * wgt * k, sdt);
        }
        // the bore: droplets kicked off the running front
        if (su > 4.2 && s < 5.6) {
          const k = 1 - sstep(4.8, 5.6, su);
          waveAt(st, u0, 5, drops.pos); waveAt(st, u1, 5, drops.p);
          drops.vel.copy(st.F).multiplyScalar(4.5 * sp).addScaledVector(UP, 2.5); drops.radial = 1.5; drops.size = 1.8; drops.spread = 1.5;
          drops.rate(500 * p.spray * wgt * k, sdt);
        }
        // the wind tears spray and mist off the churn's tops, back over it
        if (su > 3.6 && su < 5.2) {
          waveAt(st, u0, 4, spray.pos); waveAt(st, u1, 4, spray.p);
          spray.vel.copy(st.F).multiplyScalar(-1.2).addScaledVector(UP, 1.4); spray.size = 2.0; spray.radial = 0.7;
          spray.rate(30 * p.spray * wgt * (1 - sstep(4.6, 5.2, su)), sdt);
        }
        // low mist hanging over the spent sheet
        if (su > 4.8) {
          waveAt(st, u0, 3, mist.pos); waveAt(st, u1, 3, mist.p);
          mist.pos.y = mist.p.y = 0.25;
          mist.vel.copy(st.F).multiplyScalar(0.8).addScaledVector(UP, 0.15); mist.size = 1.6;
          mist.rate(14 * p.mist * wgt * (1 - st.fade), sdt);
        }
      }

      // the centre's plunge: the big hit
      if (!st.crashed && s >= S_CRASH) {
        st.crashed = true;
        waveAt(st, 0.5, 6, _a);
        _a.y = 0;
        wetSpot(_a.x, _a.z, 0.8 * H, 1.0 * p.wetness, c.seed + 7);
        fx.impacts.add('wet', _a, 0.9 * H, 1, 8, lightCol);
        fx.rig.shake(0.7, 9);
        if (!fx.reduced) { fx.rig.punch(2.2, 0.12); fx.rig.hitstop(0.05); }
        if (fx.camera.position.distanceTo(_a) < 7 + H) lensWet = 1;
        if (nearPool(_a.x, _a.z, 1.5)) fx.pool.ripple(Math.min(Math.max(_a.x, POOL.center.x - POOL.half.x), POOL.center.x + POOL.half.x), _a.z, 0.12, 0.9);
        if (L) L.intensity = Math.max(L.intensity, 30);
      }

      // the running front paints a wet swath and drenches whatever it reaches
      if (tau > 0.1 && s < 5.8) {
        st.splat -= dt;
        if (st.splat <= 0) {
          st.splat = 0.1;
          waveAt(st, 0.1, s < 3.5 ? 11 : 6, _a); waveAt(st, 0.9, s < 3.5 ? 11 : 6, _b);
          wetLine(_a, _b, 0.12 * H, 0.45 * p.wetness, c.seed + tau * 97);
        }
        const fr = s < 3.5 ? 11 : 6;
        for (let i = 0; i < fx.dummies.length; i++) {
          const dm = fx.dummies[i];
          _v.subVectors(dm.pos, st.O);
          const lat = _v.dot(st.S) / (0.5 * st.W);
          if (Math.abs(lat) > 0.9) continue;
          waveAt(st, 0.5 + 0.5 * lat, fr, _a);
          const ahead = _v.dot(st.F) - _b.subVectors(_a, st.O).dot(st.F);
          if (ahead > 0.3) continue;
          dm.status.wet = 1;
          if (!(st.mask & (1 << i)) && s > 0.6) {
            st.mask |= 1 << i;
            dm.hit(st.F, (s > 3 ? 1.6 : 1.0) * (H / 4.5) * taper(0.5 + 0.5 * lat));
            st.wetDummy = i;
          }
        }
        // a bore reaching the pool shoves its surface
        st.rip -= dt;
        if (st.rip <= 0) {
          st.rip = 0.06;
          waveAt(st, 0.2 + 0.6 * fx.rand(), fr, _a);
          if (nearPool(_a.x, _a.z, 0.3)) fx.pool.ripple(_a.x, _a.z, 0.04, 0.5);
        }
      }

      // forces: the swell drags loose particles in, the wave front shoves them on
      const fo = st.force;
      if (fo) {
        if (tau < 0) {
          fo.type = 2; fo.pos.copy(st.O).setY(0.6); fo.p[0] = 35 * st.grow; fo.p[1] = 1.2; fo.p[2] = 0.35; fo.p[3] = 1.6 * H;
        } else {
          waveAt(st, 0.5, s < 3.5 ? 10 : 5, fo.pos);
          fo.pos.addScaledVector(st.F, -1.5); fo.pos.y = 0.4;
          fo.type = 5; fo.dir.copy(st.F);
          fo.p[0] = 7 * sp * (1 - st.fade); fo.p[1] = 0.45 * st.W; fo.p[2] = 3.5; fo.p[3] = 2.5;
        }
      }
      // a caustic cookie light rides under the barrel
      if (L) {
        waveAt(st, 0.5, 8, L.pos);
        L.pos.y = Math.max(L.pos.y, 0.6 * H * st.grow) + 0.4;
        // (gone as the lip lands: the bore is opaque churn that focuses no light, and the cookie's
        // caustic web drawn over its foam reads as wire netting; back faintly for the clear spent sheet)
        const target = tau < 0 ? 6 * st.grow : s < 3.3 ? 6 + 10 * sstep(0.3, 2.8, s) : 16 * (1 - sstep(3.3, 3.8, s)) + 3 * (1 - st.fade) * sstep(4.8, 5.5, s);
        L.intensity += (target - L.intensity) * (1 - Math.exp(-dt * 6));
        L.range = 2.4 * H;
        L.cookie[1] = 1.6 / Math.sqrt(H / 4.5);
        L.cookie[2] = st.age * 0.35;
      }
    }

    return {
      onParam(k) { if (k === 'curl') poses(); else optics(); },

      phase(c, name) {
        const p = S.params, st = ST[c.index];
        if (name === 'charge') {
          optics();
          const sp = p.speed;
          c.durations.charge = 1.0 / sp;
          c.durations.impact = T_IMPACT / sp;
          c.durations.linger = T_LINGER / sp;
          st.live = true; st.age = 0; st.tau = -c.durations.charge; st.mask = 0; st.crashed = false; st.seg = 0;
          st.splat = 0; st.rip = 0; st.wetDummy = -1; st.released = false;
          st.seedF = (c.seed % 997) / 997;
          st.H = p.height; st.W = p.width;
          st.crashT = lerpKeys(SK, TK, S_CRASH) / sp;
          st.crashD = lerpKeys(TK, DK, st.crashT * sp) * st.H;
          // sweep: from behind the target towards the caster's side, turned by 'angle'
          st.F.set(c.from.x - c.to.x, 0, c.from.z - c.to.z);
          if (st.F.lengthSq() < 1e-6) st.F.set(0, 0, 1);
          st.F.normalize().applyAxisAngle(UP, THREE.MathUtils.degToRad(p.angle));
          st.S.set(-st.F.z, 0, st.F.x);
          // rise behind the target (pulled in if that would leave the arena)
          let back = BACK * st.H;
          st.O.set(c.to.x, 0, c.to.z).addScaledVector(st.F, -back);
          while (back > 0.6 * st.H && Math.hypot(st.O.x, st.O.z) > ARENA.radius - 1.1 * st.H) {
            back -= 0.25;
            st.O.set(c.to.x, 0, c.to.z).addScaledVector(st.F, -back);
          }
          // the pool water nearest the swell feeds it
          st.src.set(
            Math.min(Math.max(st.O.x, POOL.center.x - POOL.half.x + 0.6), POOL.center.x + POOL.half.x - 0.6),
            POOL.water,
            Math.min(Math.max(st.O.z, POOL.center.y - POOL.half.y + 0.6), POOL.center.y + POOL.half.y - 0.6));
          st.light = fx.lights.acquire();
          if (st.light) {
            const L = st.light;
            L.type = 2; L.cookie[0] = 1; L.cookie[1] = 1.6; L.cookie[2] = 0;
            L.range = 2.4 * st.H; L.intensity = 0; L.color.copy(lightCol); L.pos.copy(st.O);
          }
          st.force = fx.forces.acquire();
          wetSpot(st.O.x, st.O.z, 0.7 * st.H, 0.35 * p.wetness, c.seed + 3);
          fx.rig.shake(0.18, 4);
        } else if (name === 'release') {
          st.released = true;
          // the swell bursts upward into the wall
          waveAt(st, 0.2, 4, drops.pos); waveAt(st, 0.8, 4, drops.p);
          drops.vel.set(0, 4, 0).addScaledVector(st.F, 1); drops.radial = 2; drops.size = 2; drops.spread = 2;
          drops.burst(900 * p.spray);
          spray.pos.copy(drops.pos); spray.p.copy(drops.p); spray.vel.set(0, 3, 0); spray.size = 2; spray.radial = 1;
          spray.burst(50 * p.spray);
          fx.rig.shake(0.3, 6);
        } else if (name === 'done') {
          st.live = false;
          st.light?.release(); st.light = null;
          st.force?.release(); st.force = null;
        }
      },

      update(c, dt) {
        const p = S.params, st = ST[c.index];
        if (!st.live) return;
        st.age += dt;
        st.tau = c.phase === 'charge' ? c.t - c.durations.charge : c.phase === 'impact' ? c.t : c.durations.impact + c.t;
        step(c, st, dt);
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge;
          // drawback: the pool swirls and streams arc out of it into the swell
          if (k < 0.8) {
            const T = Math.max(c.durations.charge - c.t + 0.15, 0.25);
            launch(beads.vel, st.src, _a.copy(st.O).setY(0.3 * st.H * st.grow + 0.2), T);
            beads.pos.copy(st.src); beads.radius = 1.0; beads.size = 1.6; beads.life = T / 0.9;
            beads.rate(700 * p.spray, dt);
            fx.pool.swirl(st.src.x, st.src.z, 1 + 1.5 * k);
            st.rip -= dt;
            if (st.rip <= 0) { st.rip = 0.05; fx.pool.ripple(st.src.x + (fx.rand() - 0.5) * 2, st.src.z + (fx.rand() - 0.5) * 2, -0.012, 0.3); }
          }
          // the ground behind the target wells up
          welling.pos.copy(st.O).setY(0.1); welling.radius = 0.25 * st.H * (0.4 + k); welling.vel.set(0, 1.6, 0); welling.radial = 0.8; welling.size = 1.4;
          welling.rate(40 * p.mist * k, dt);
          return;
        }
        if (c.phase === 'linger' && st.wetDummy >= 0) {
          // a soaked dummy drips
          const dm = fx.dummies[st.wetDummy].pos, k = 1 - c.t / c.durations.linger;
          drip.pos.set(dm.x, 1.55, dm.z); drip.p.set(dm.x, 0.5, dm.z); drip.vel.set(0, -0.3, 0); drip.life = 0.8;
          drip.rate(60 * k, dt);
        }
      },

      // once per frame: live waves upload their instance data; lens droplets dry
      tick(dt) {
        let n = 0;
        const A = aA.array, B = aB.array, C = aC.array;
        for (const st of ST) {
          if (!st.live) continue;
          const o = n * 4;
          A[o] = st.O.x; A[o + 1] = st.O.y; A[o + 2] = st.O.z; A[o + 3] = st.seedF;
          B[o] = st.F.x; B[o + 1] = st.F.z; B[o + 2] = st.H * st.grow; B[o + 3] = st.W;
          C[o] = st.s; C[o + 1] = st.d; C[o + 2] = st.fade; C[o + 3] = st.age;
          if (++n >= MAX_WAVES) break;
        }
        geo.instanceCount = mgeo.instanceCount = n;
        mesh.visible = n > 0;
        maneU.x = S.params.mist;
        mane.visible = n > 0 && maneU.x > 0;
        if (n) aA.needsUpdate = aB.needsUpdate = aC.needsUpdate = true;
        // splash: from the first section landing until the last spray has fallen
        splash.begin();
        const sp = S.params.speed, spread = 0.5 * Math.abs(S.params.peel) * shape.w + 0.05;
        for (const st of ST) {
          if (!st.live) continue;
          const ac = st.tau - st.crashT;
          if (ac < -spread || ac > SPLASH_LIFE + spread) continue;
          splash.add(st.O, st.F, st.H, st.W, st.seedF, ac, st.crashD, 4.6 * Math.sqrt(st.H), 0.45 * st.H * sp);
        }
        splash.end(S.params.spray);
        if (lensWet > 0) { lensWet = Math.max(0, lensWet - dt / 5); fx.post.params.droplets = lensWet; }
      },
    };
  },
};
