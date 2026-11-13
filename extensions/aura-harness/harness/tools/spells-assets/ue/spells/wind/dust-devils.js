import * as THREE from 'three';

// Dust Devils (Wind hero). Three small twisters spin up round the target and dance. Each is a
// point vortex in the floor plane with its own circulation (1 : 0.8 : 0.62), so every devil is
// carried round by the others' induced flow (u = G / 2 pi r, the same G its force field swirls
// dust with) on top of a soft tether and a slow wander: they weave and braid instead of orbiting
// rigidly. Each devil is a Rankine vortex in the shared force field (every loose particle in the
// arena is caught), a raymarched dust column (a capsule volume: dust in a wall round a clear core,
// helical streaks wound up it and turning with it, a squat turbulent skirt at the foot, the top
// flaring out and thinning), a few sunlit dust sheets peeling off it (helix analytic ribbons with
// streaky breakup + lens distortion), a skirt of particles rolling at its foot, leaves, grit and
// glints, and it scours a dark track into the floor as it goes (char 'line' splats).
// Anticipation: three whorls stir on the floor while the caster's focus gathers wind. Release: the
// whorls shoot up into funnels. Climax: the tether tightens and the devils spiral into one another
// over the target, each merge pumping the survivor up, until the merged column blows out in a
// rolling dust ring with a shock force through every particle. Aftermath: leaves rain down, the
// dust settles, the braided tracks stay on the floor (~25 s).

const N = 3;       // devils
const NH = 5;      // dust-sheet ribbons per devil (fx)
const NV = 6;      // column volumes (two live casts)
const STATES = 16; // one per cast record
const TAU = Math.PI * 2;
const GAM = [1, 0.8, 0.62];     // relative circulation (and size)
const H0 = 5.2;                 // funnel height at size 1 (m)
const MERGE = 1.6;              // longest merge spiral (s)
const TAIL = 1.6;               // after the blow-out (s)

// p0 (foot xyz, seed)  p1 (height, foot radius, top radius, turns)  p2 (angle, lean x, lean z, width)
// p3 (bend x, bend z, reveal, alpha). The axis snakes: lean (the top lags the walk) + a mid bend.
// turns == 0 is the column itself: a strip up the axis as wide as the funnel (an impostor).
const PATH_GLSL = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  float rr = mix(p1.y, p1.z, pow(t, 1.35)) * (1.0 + 0.11 * sin(t * 8.0 + p0.w * 6.2831853 - uTime * 3.3));
  bool column = p1.w == 0.0;
  float th = p2.x + t * p1.w * 6.2831853, r = column ? 0.0 : rr;
  width = column ? 2.0 * rr : p2.w * mix(0.4, 1.3, t);
  vec3 axis = vec3(p2.y, 0.0, p2.z) * (t * t) + vec3(p3.x, 0.0, p3.y) * sin(3.14159265 * t);
  return p0.xyz + axis + vec3(cos(th) * r, t * p1.x, sin(th) * r);
}`;

// Lit like the media particles (sun HG phase + sky): streaky dust flowing up the helix, with a
// weak cylindrical lens.
const DUST_SHADE = /* glsl */`
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uSunDir;
uniform highp sampler3D uNoise3D;
uniform float uDistort;
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  float u = r.uv.x, v = r.uv.y;
  vec3 vd = normalize(cameraPosition - r.p0.xyz - vec3(0.0, r.p1.x * u, 0.0));
  vec3 light = uSunColor * hgPhase(dot(uSunDir, -vd), 0.35) * 4.0 * PI * 0.6 + uAmbient * 1.4;
  float ends = smoothstep(0.0, 0.07, u) * (1.0 - smoothstep(0.7, 1.0, u)) * (1.0 - smoothstep(r.p3.z - 0.15, r.p3.z, u));
  vec4 n = texture(uNoise3D, vec3(u * 1.3 - uTime * 0.42 + r.p0.w, v * 0.11 + r.p0.w * 0.7, u * 0.2 + r.p0.w * 0.31));
  float edge = exp(-2.2 * v * v);
  float body = 0.3 + 0.7 * smoothstep(0.3, 0.7, n.r + 0.25 * (edge - 0.5));
  alpha = r.p3.w * edge * body * ends * (1.0 - 0.5 * u);
  media = r.color * light * (0.8 + 0.3 * n.g);
  distortion = uDistort * v * exp(-3.0 * v * v) * 2.33 * ends * min(r.p3.w * 3.0, 1.0);
  return vec3(0.0);
}`;

// The column (a capsule volume per devil). Cylindrical coordinates round the snaking axis: dust in
// a wall round a clearer core, thickest low down; tileable noise indexed by the twisted azimuth
// (three tiles per turn, so the atan seam tiles) minus the spin, so streaks wind up the column and
// turn with it while their texture climbs; a squat skirt with a noise-torn edge at the foot; the
// top flares, tears and thins out.
const DEVIL_GLSL = /* glsl */`
uniform vec4 uDev;    // foot x, z, height m, seed
uniform vec4 uDev2;   // lean x, z (top offset), bend x, z (mid offset)
uniform vec4 uDev3;   // foot radius, top radius, spin rad, density
uniform vec3 uSand;
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  sigma = 0.0; albedo = vec3(0.0); emission = vec3(0.0);
  float H = uDev.z, t = pw.y / H;
  if (t < 0.0 || t > 1.2) return;
  float tc = min(t, 1.0), s = uDev3.y;
  vec2 q = pw.xz - (uDev.xy + uDev2.xy * tc * tc + uDev2.zw * sin(PI * tc));
  float r = length(q);
  float R = mix(uDev3.x, s, pow(tc, 1.35));
  float Rk = 1.5 * s, hk = 0.4 * s + 0.12;
  if (r > max(1.9 * R, 1.5 * Rk)) return;
  float tw = atan(q.y, q.x) + uDev3.z + pw.y * 1.3 / max(s, 0.3);
  vec3 np = vec3(r * 0.6 / s + uDev.w, tw * (3.0 / 6.2831853), pw.y * 0.2 / s - uTime * 0.45);
  float n1 = noise3(np);
  float n2 = noise3(np * vec3(2.3, 2.0, 2.6) + vec3(0.21, 0.0, 0.43));
  float detail = 1.0 - smoothstep(0.15, 0.5, gVolDt / s);
  float n = n1 * 0.65 + (0.35 * n2 - 0.175) * detail + 0.0875 * (1.0 - detail);
  float streak = smoothstep(0.38, 0.7, n);
  float wall = exp(-pow((r - 0.72 * R) / (0.32 * R), 2.0)) + 0.15 * exp(-r * r / (0.15 * R * R));
  float top = 1.0 - smoothstep(0.65, 1.1, t + (n1 - 0.5) * 0.4);
  float skirt = exp(-pw.y / hk) * (1.0 - smoothstep(0.35 * Rk, Rk, r + (n1 - 0.5) * 0.8 * Rk));
  sigma = uDev3.w * ((wall * (1.25 - 0.7 * tc) * top) * mix(0.1, 1.0, streak) + 0.9 * skirt * (0.4 + n2)) / s;
  albedo = uSand * (0.8 + 0.35 * n2);
}`;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const backOut = (x) => { x = Math.min(1, Math.max(0, x)); const c = 1.7; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
// reused option objects (the shared systems read fields; a literal per call would allocate)
const TRK = { x: 0, z: 0, x2: 0, z2: 0, radius: 0.2, width: 0.2, char: 0, crack: 0, pattern: 'line', seed: 0 };
const RNG = { x: 0, z: 0, radius: 2, width: 0.5, char: 0, crack: 0, pattern: 'ring', seed: 0 };
const SHK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 4, duration: 0.6, thickness: 0.6, distortion: 0.04, intensity: 0, ground: true };

export default {
  id: 'dust-devils', name: 'Dust Devils', element: 'wind', order: 10, hue: '#d8b88a',
  shape: 'area', radius: 0.3,
  params: {
    size: 1, strength: 1, weave: 1, spread: 1, duration: 4.4, dust: 1, debris: 1, streaks: 1, grit: 1, refraction: 1, tracks: 1,
    sand: '#a28b6c', air: '#fff1dc',
  },
  ranges: {
    size: [0.5, 1.8, 0.01], strength: [0.3, 2.5, 0.01], weave: [0.2, 2.5, 0.01], spread: [0.4, 2, 0.01], duration: [1.5, 9, 0.1],
    dust: [0, 3, 0.01], debris: [0, 3, 0.01], streaks: [0, 3, 0.01], grit: [0, 3, 0.01], refraction: [0, 3, 0.01], tracks: [0, 2, 0.01],
  },
  presets: {
    'red planet': { sand: '#a3532c', air: '#ffcfae', grit: 0.4, tracks: 1.6, dust: 1.3 },
    'ash devils': { sand: '#4b4743', air: '#d9dce6', grit: 0, debris: 0.4, dust: 1.4, streaks: 0.6 },
    'autumn whirl': { sand: '#7c6a4c', air: '#fff6e0', debris: 2.8, dust: 0.55, size: 1.2, weave: 1.4 },
  },
  timing: { charge: 0.9, impact: 0.4, linger: 4.4 + MERGE + TAIL - 0.4 },
  kinds: {
    dust: { style: 'media', drag: 0.35, buoyancy: 0.25, curl: 0.5, curlScale: 0.3, forceResponse: 2.4, life: [1.0, 1.7], size: [0.22, 0.8], sizePow: 0.6, color: ['#a28b6c', '#b29977'], alpha: [0.18, 0], density: 2.4, erosion: 0.55, fadeIn: 0.2, fadeOut: 0.4, lightResponse: 1.3 },
    skirt: { style: 'media', drag: 1.3, buoyancy: 0.12, curl: 0.6, curlScale: 0.25, forceResponse: 1.4, life: [0.8, 1.5], size: [0.3, 1.05], color: ['#a28b6c', '#b29977'], alpha: [0.15, 0], density: 1.7, erosion: 0.6, fadeIn: 0.12, fadeOut: 0.45 },
    burst: { style: 'media', drag: 2.0, buoyancy: 0.08, curl: 1.1, curlScale: 0.35, forceResponse: 0.6, life: [1.8, 3.0], size: [0.5, 1.9], sizePow: 0.55, color: ['#a28b6c', '#b29977'], alpha: [0.18, 0.04], density: 1.8, erosion: 0.55, fadeIn: 0.05, fadeOut: 0.6 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const E = {
      gather: P.emitter('wind.streak', { shape: 'shell', radius: 1.5, spread: 0.4, radial: -3.5 }),
      gust: P.emitter('wind.streak', { shape: 'sphere', radius: 0.3, spread: 2, radial: 5 }),
      dust: P.emitter('dust-devils.dust', { shape: 'ring', radius: 0.5, spread: 0.35, radial: 0.15 }),
      skirt: P.emitter('dust-devils.skirt', { shape: 'ring', radius: 0.9, spread: 0.4, radial: 1.1 }),
      stir: P.emitter('dust-devils.skirt', { shape: 'disk', radius: 0.8, spread: 0.3, radial: 0.4 }),
      kick: P.emitter('dust-devils.skirt', { shape: 'sphere', radius: 0.3, spread: 1.2 }),
      burst: P.emitter('dust-devils.burst', { shape: 'ring', radius: 0.8, spread: 0.7, radial: 6.5 }),
      plume: P.emitter('dust-devils.burst', { shape: 'sphere', radius: 0.7, spread: 0.8 }),
      leaf: P.emitter('wind.leaf', { shape: 'ring', radius: 0.9, spread: 0.9, radial: -0.4 }),
      leafBurst: P.emitter('wind.leaf', { shape: 'ring', radius: 0.6, spread: 1.6, radial: 4 }),
      pebble: P.emitter('wind.pebble', { shape: 'ring', radius: 0.6, spread: 0.8 }),
      mote: P.emitter('wind.mote', { shape: 'ring', radius: 0.6, spread: 0.6 }),
      haze: P.emitter('wind.haze', { shape: 'ring', radius: 0.5, spread: 0.3 }),
    };

    const distortU = { value: 0.05 };
    const ribs = new fx.AnalyticRibbons({ max: 48, segments: 48, pathGLSL: PATH_GLSL, shadeGLSL: DUST_SHADE, target: 'fx', uniforms: { uDistort: distortU } });
    fx.scenes.fx.add(ribs.mesh);
    const sandLin = new THREE.Color();
    const vols = [];
    for (let i = 0; i < NV; i++) {
      const v = fx.volumes.add({
        shape: 'capsule', glsl: DEVIL_GLSL, maxSteps: 24,
        uniforms: { uDev: { value: new THREE.Vector4() }, uDev2: { value: new THREE.Vector4() }, uDev3: { value: new THREE.Vector4() }, uSand: { value: sandLin } },
      });
      v.visible = false; v.g = 0.4; v.shadowTap = 0.5;
      vols.push({ v, used: false });
    }

    const devil = () => ({
      x: 0, z: 0, vx: 0, vz: 0, sx: 0, sz: 0, scale: 1, env: 0, fade: 1, boost: 0, spin: 0, ph: 0, absorbed: false,
      force: null, vol: null, helix: new Array(NH).fill(null), hp: new Float32Array(NH * 5),
      mx: 0, mz: 0, lx: 0, lz: 0, bx: 0, bz: 0,
    });
    const states = Array.from({ length: STATES }, () => ({
      d: [devil(), devil(), devil()], cx: 0, cz: 0, L: 0, hitT: 0, merging: false, collapsed: false, tc: 0, mergeAt: 0, merged: -1,
      light: null, shock: null, shockT: 0, seedF: 0, a0: 0, ph0: 0, contact: new Float32Array(N * 3),
    }));

    const sand = new THREE.Color(), air = new THREE.Color(), tmp = new THREE.Color();
    const col = { sand: '', air: '' };
    function applyColors(p) {
      sand.set(p.sand); air.set(p.air); sandLin.set(p.sand);
      if (col.sand !== p.sand) {
        col.sand = p.sand;
        const hi = `#${tmp.set(p.sand).multiplyScalar(1.1).getHexString()}`;
        for (const k of ['dust-devils.dust', 'dust-devils.skirt', 'dust-devils.burst']) P.setKind(k, { color: [p.sand, hi] });
      }
    }

    function releaseAll(st) {
      for (const dv of st.d) {
        if (dv.vol) { dv.vol.used = false; dv.vol.v.visible = false; dv.vol = null; }
        for (let i = 0; i < NH; i++) { dv.helix[i]?.release(); dv.helix[i] = null; }
        dv.force?.release(); dv.force = null;
      }
      st.light?.release(); st.light = null;
      st.shock?.release(); st.shock = null;
    }

    // --- the dance: a three-strand braid (each devil's track circles the target while its radius
    // swings in and out, 120 degrees apart, so the tracks cross over and under one another), plus the
    // point-vortex flow each devil induces on the others: when two pass close they swing round
    // each other and are flung apart. Substepped; the tether tightens to merge them at the end.
    function braid(st, p, i, L, out) {
      const R = 2.0 * p.spread * (1 + 0.45 * Math.sin(1.6 * p.weave * L + i * TAU / N + st.ph0));
      const a = st.a0 + 0.75 * p.weave * L + i * TAU / N;
      out.x = st.cx + Math.cos(a) * R; out.z = st.cz + Math.sin(a) * R;
    }
    function dance(st, p, dt) {
      const steps = Math.max(1, Math.ceil(dt * 90)), h = dt / steps, d = st.d, s0 = d[0];
      const mk = st.merging ? smooth(0, 0.8, st.L - st.mergeAt) : 0;
      const k = 1.6 + 2.4 * mk, lag = 1 - Math.exp(-h * (3 + 3 * mk)), delta2 = 0.3;
      for (let n = 0; n < steps; n++) {
        const L = st.L - dt + (n + 1) * h;
        for (let i = 0; i < N; i++) {
          const a = d[i];
          if (a.absorbed) continue;
          let ux = 0, uz = 0;
          for (let j = 0; j < N; j++) {
            const b = d[j];
            if (j === i || b.absorbed) continue;
            const dx = a.x - b.x, dz = a.z - b.z, g = 13 * p.strength * b.scale * b.env / (TAU * (dx * dx + dz * dz + delta2));
            ux += g * dz; uz -= g * dx;   // the same sense as the force field's swirl
          }
          // tether: the braid track while dancing; merging, the others home on the biggest, which
          // spirals into the target
          braid(st, p, i, L, _a);
          let tx = _a.x + (st.cx - _a.x) * mk, tz = _a.z + (st.cz - _a.z) * mk;
          if (i > 0 && mk > 0) { tx += (s0.x - tx) * mk; tz += (s0.z - tz) * mk; }
          ux -= k * (a.x - tx); uz -= k * (a.z - tz);
          const sp = Math.hypot(ux, uz), cap = 6;
          if (sp > cap) { ux *= cap / sp; uz *= cap / sp; }
          a.vx += (ux - a.vx) * lag; a.vz += (uz - a.vz) * lag;
        }
        for (let i = 0; i < N; i++) {
          const a = d[i];
          if (a.absorbed) continue;
          a.x += a.vx * h; a.z += a.vz * h;
          const r = Math.hypot(a.x, a.z);   // stay inside the pillar ring
          if (r > 12.5) { a.x *= 12.5 / r; a.z *= 12.5 / r; }
        }
      }
    }

    // ribbons, force, emission and world response for one devil. grow: height fraction
    function devilFrame(c, st, p, dv, i, dt, grow, unwind, charging) {
      const e = dv.env * dv.fade, s = dv.scale * (1 + dv.boost), H = H0 * s * grow;
      const sm = 1 - Math.exp(-dt * 3);
      dv.sx += (dv.vx - dv.sx) * sm; dv.sz += (dv.vz - dv.sz) * sm;
      dv.spin += dt * 3.4 * p.strength / Math.sqrt(s) * (0.4 + 0.6 * e) * (1 + 2 * dv.boost);
      // the top lags the walk and sways; the middle bends across it
      dv.lx = -dv.sx * 0.45 * s + Math.sin(st.L * 1.1 + dv.ph * 3) * 0.3 * s;
      dv.lz = -dv.sz * 0.45 * s + Math.cos(st.L * 0.9 + dv.ph * 2) * 0.3 * s;
      dv.bx = Math.sin(st.L * 1.7 + dv.ph) * 0.28 * s; dv.bz = Math.cos(st.L * 1.4 + dv.ph * 1.3) * 0.28 * s;
      const F = dv.force;
      if (F) {
        F.pos.set(dv.x, 0, dv.z); F.dir.copy(_up);
        F.p[0] = 0.45 * s; F.p[1] = 13 * s * p.strength * e; F.p[2] = 3.6 * p.strength * e; F.p[3] = 0.6 * p.strength * e;
        F.w = Math.max(H, 1) * 1.05;
      }
      const on = e > 0.01 ? 1 : 0, hp = dv.hp, vo = dv.vol?.v;
      if (vo) {
        const rT = 0.78 * s * unwind, ra = Math.max(1.9 * rT, 2.25 * rT) + 0.5 * Math.hypot(dv.lx, dv.lz) + Math.hypot(dv.bx, dv.bz) + 0.1;
        vo.uniforms.uDev.value.set(dv.x, dv.z, Math.max(H, 0.3), st.seedF * 5 + i * 0.37);
        vo.uniforms.uDev2.value.set(dv.lx, dv.lz, dv.bx, dv.bz);
        vo.uniforms.uDev3.value.set(0.24 * s * unwind, rT, -dv.spin, 1.6 * e * p.dust);
        vo.position.set(dv.x + 0.5 * dv.lx, 0.5 * H, dv.z + 0.5 * dv.lz);
        vo.scale.set(ra, 0.5 * H + 0.3, ra);
        vo.visible = on > 0;
      }
      for (let j = 0; j < NH; j++) {
        const r = dv.helix[j], o = j * 5;
        if (!r) continue;
        r.p0.set(dv.x, 0.02, dv.z, hp[o + 4] / TAU + st.seedF + i * 0.31);
        r.p1.set(H * hp[o + 3], hp[o + 1] * s * unwind, hp[o + 2] * s * unwind, -hp[o]);
        r.p2.set(hp[o + 4] - dv.spin * (0.85 + 0.1 * hp[o]), dv.lx, dv.lz, 0.5 * s);
        r.p3.set(dv.bx, dv.bz, 1.15, 0.38 * e * p.dust);
        r.color.copy(sand); r.intensity = on;
      }
      if (e < 0.02) return;
      // what the wind carries
      if (charging) {
        E.stir.pos.set(dv.x, 0.1, dv.z); E.stir.radius = 0.7 * s; E.stir.size = 0.5 * s; E.stir.vel.set(0, 0.3, 0);
        E.stir.rate(170 * p.dust * e, dt);
        E.leaf.pos.set(dv.x, 0.15, dv.z); E.leaf.radius = 0.8 * s; E.leaf.vel.set(0, 1.6, 0); E.leaf.rate(30 * p.debris * e, dt);
        return;
      }
      const hn = Math.pow(fx.rand(), 1.3);
      E.dust.pos.set(dv.x + dv.lx * hn * hn + dv.bx * Math.sin(Math.PI * hn), hn * H, dv.z + dv.lz * hn * hn + dv.bz * Math.sin(Math.PI * hn));
      E.dust.radius = (0.25 + 0.6 * Math.pow(hn, 1.35)) * s; E.dust.size = s * (0.45 + 0.5 * hn);
      E.dust.vel.set(dv.sx * 0.3, 0.9, dv.sz * 0.3);
      E.dust.rate(90 * p.dust * e, dt);
      E.skirt.pos.set(dv.x, 0.12, dv.z); E.skirt.radius = 0.75 * s; E.skirt.size = s; E.skirt.vel.set(dv.sx * 0.4, 0.25, dv.sz * 0.4);
      E.skirt.rate(100 * p.dust * e, dt);
      E.mote.pos.set(dv.x, 0.3 + 1.2 * fx.rand() * s, dv.z); E.mote.radius = 0.6 * s; E.mote.vel.set(0, 1.4, 0);
      E.mote.rate(70 * p.grit * e, dt);
      E.leaf.pos.set(dv.x, 0.2, dv.z); E.leaf.radius = 0.9 * s; E.leaf.vel.set(0, 2.6, 0); E.leaf.rate(7 * p.debris * e, dt);
      E.pebble.pos.set(dv.x, 0.15, dv.z); E.pebble.radius = 0.55 * s; E.pebble.vel.set(0, 3.8, 0); E.pebble.rate(9 * p.debris * e, dt);
      const hz = 0.15 + 0.6 * fx.rand();
      E.haze.pos.set(dv.x + dv.lx * hz * hz, hz * H, dv.z + dv.lz * hz * hz); E.haze.radius = 0.5 * s; E.haze.size = 0.5 * s; E.haze.vel.set(0, 0.8, 0);
      E.haze.rate(6 * p.refraction * e, dt);
      // a dark scoured track behind it
      const mdx = dv.x - dv.mx, mdz = dv.z - dv.mz;
      if (mdx * mdx + mdz * mdz > 0.36 && p.tracks > 0 && e > 0.4) {
        TRK.x = dv.mx; TRK.z = dv.mz; TRK.x2 = dv.x; TRK.z2 = dv.z; TRK.width = 0.26 * s; TRK.radius = 0.26 * s;
        TRK.char = 0.45 * p.tracks * e; TRK.crack = 0; TRK.seed = (c.seed + i * 17 + Math.floor(st.L * 10)) % 100;
        fx.ground.splat(TRK);
        dv.mx = dv.x; dv.mz = dv.z;
      }
      // the pool's ripples swirl when a devil walks over or near it
      const pool = fx.ARENA.pool;
      const qx = Math.max(Math.abs(dv.x - pool.center.x) - pool.half.x, 0), qz = Math.max(Math.abs(dv.z - pool.center.y) - pool.half.y, 0);
      const pd = Math.hypot(qx, qz), reach = 1.6 * s;
      if (pd < reach && fx.pool) {
        fx.pool.swirl(Math.min(Math.max(dv.x, pool.center.x - pool.half.x), pool.center.x + pool.half.x),
          Math.min(Math.max(dv.z, pool.center.y - pool.half.y), pool.center.y + pool.half.y), 2.2 * e * p.strength * (1 - pd / reach));
      }
    }

    // dummies caught by a devil get buffeted round it; first contact kicks dust off them
    function buffet(st, p, dt) {
      st.hitT -= dt;
      for (let k = 0; k < st.contact.length; k++) st.contact[k] = Math.max(0, st.contact[k] - dt);
      if (st.hitT > 0) return;
      st.hitT = 0.15;
      for (let i = 0; i < N; i++) {
        const dv = st.d[i], e = dv.env * dv.fade, s = dv.scale * (1 + dv.boost), R = 1.3 * s;
        if (e < 0.2) continue;
        for (let m = 0; m < fx.dummies.length && m < 3; m++) {
          const dm = fx.dummies[m], dx = dm.pos.x - dv.x, dz = dm.pos.z - dv.z, dd = Math.hypot(dx, dz);
          if (dd > R) continue;
          dm.hit(_b.set(dz - dx * 0.3, 0, -dx - dz * 0.3), 0.28 * e * p.strength * (1 - dd / R) + 0.05);
          if (st.contact[i * 3 + m] <= 0) {
            st.contact[i * 3 + m] = 1.2;
            E.kick.pos.set(dm.pos.x, 0.5, dm.pos.z); E.kick.vel.set(dz * 1.5, 1.2, -dx * 1.5); E.kick.size = 0.8; E.kick.burst(40 * p.dust);
          }
        }
      }
    }

    function blowOut(c, st, p) {
      const s0 = st.d[0], s = s0.scale * (1 + s0.boost), x = s0.x, z = s0.z;
      st.collapsed = true; st.tc = st.L;
      for (const dv of st.d) if (dv !== s0) { dv.absorbed = true; dv.fade = 0; dv.force?.release(); dv.force = null; }
      E.burst.pos.set(x, 0.3, z); E.burst.radius = 0.9 * s; E.burst.radial = 6.5 * Math.sqrt(p.size); E.burst.size = 1.1 * s; E.burst.vel.set(0, 0.5, 0);
      E.burst.burst(300 * p.dust);
      E.burst.radial = 3 * Math.sqrt(p.size); E.burst.spread = 1.4; E.burst.burst(140 * p.dust); E.burst.spread = 0.7;
      E.plume.pos.set(x, 2.2 * s, z); E.plume.radius = 1.0 * s; E.plume.size = s; E.plume.vel.set(0, 1.6, 0); E.plume.burst(110 * p.dust);
      E.leafBurst.pos.set(x, 0.6, z); E.leafBurst.vel.set(0, 5.5, 0); E.leafBurst.burst(70 * p.debris);
      E.pebble.pos.set(x, 0.2, z); E.pebble.radius = 0.8; E.pebble.vel.set(0, 4.5, 0); E.pebble.burst(40 * p.debris);
      E.gust.pos.set(x, 1.2, z); E.gust.vel.set(0, 1, 0); E.gust.burst(220 * p.streaks);
      SHK.pos.set(x, 0.05, z); SHK.radius0 = 0.4; SHK.radius1 = 6.5 * s; SHK.duration = 0.7; SHK.thickness = 0.8; SHK.distortion = 0.06 * p.refraction; SHK.ground = true;
      fx.shocks?.spawn(SHK);
      SHK.pos.set(x, 1.4, z); SHK.radius1 = 3.5 * s; SHK.duration = 0.4; SHK.thickness = 0.6; SHK.distortion = 0.035 * p.refraction; SHK.ground = false;
      fx.shocks?.spawn(SHK);
      RNG.x = x; RNG.z = z; RNG.radius = 2.4 * s; RNG.width = 0.55 * s; RNG.char = 0.4 * p.tracks; RNG.seed = c.seed % 97;
      if (p.tracks > 0) fx.ground.splat(RNG);
      st.shock = fx.forces.acquire();
      if (st.shock) { st.shock.type = 4; st.shock.pos.set(x, 0.8, z); st.shock.p[0] = 0.3; st.shock.p[1] = 1.2; st.shock.p[2] = 45 * p.strength; st.shock.p[3] = 0; }
      st.shockT = 0;
      for (const dm of fx.dummies) {
        const dx = dm.pos.x - x, dz = dm.pos.z - z, dd = Math.hypot(dx, dz), R = 3.2 * s;
        if (dd < R) dm.hit(_b.set(dx, 0, dz), 1.1 * p.strength * (1 - dd / R) + 0.2);
      }
      fx.rig.shake(0.32, 8);
      if (!fx.reduced) { fx.rig.punch(1.6, 0.1); fx.rig.hitstop(0.035); }
      c.durations.linger = Math.min(c.durations.linger, c.t + TAIL);
    }

    return {
      onParam(k) { if (k === 'sand' || k === 'air') applyColors(S.params); },
      tick() { ribs.update(); },

      phase(c, name) {
        const p = S.params, st = states[c.index];
        applyColors(p);
        if (name === 'charge') {
          releaseAll(st);
          st.L = 0; st.hitT = 0; st.merging = false; st.collapsed = false; st.shockT = 0; st.merged = -1;
          st.seedF = (c.seed % 997) / 997;
          st.contact.fill(0);
          st.mergeAt = p.duration;
          c.durations.linger = p.duration + MERGE + TAIL - c.durations.impact;
          // centre on the target, inside the pillar ring
          st.cx = c.to.x; st.cz = c.to.z;
          const r = Math.hypot(st.cx, st.cz);
          if (r > 11) { st.cx *= 11 / r; st.cz *= 11 / r; }
          st.a0 = Math.atan2(c.to.z - c.from.z, c.to.x - c.from.x) + Math.PI / 2 + fx.rand() * 0.6;
          st.ph0 = fx.rand() * TAU;
          for (let i = 0; i < N; i++) {
            const dv = st.d[i];
            braid(st, p, i, 0, dv);
            dv.vx = dv.vz = dv.sx = dv.sz = 0;
            dv.scale = p.size * GAM[i]; dv.env = 0; dv.fade = 1; dv.boost = 0; dv.spin = fx.rand() * TAU; dv.ph = fx.rand() * TAU;
            dv.absorbed = false; dv.mx = dv.x; dv.mz = dv.z;
            for (let j = 0; j < NH; j++) {
              const o = j * 5;
              dv.hp[o] = 2.0 + 1.0 * fx.rand();               // turns
              dv.hp[o + 1] = 0.22 + 0.1 * fx.rand();          // foot radius
              dv.hp[o + 2] = 0.8 + 0.35 * fx.rand();          // top radius
              dv.hp[o + 3] = 0.82 + 0.22 * fx.rand();         // height
              dv.hp[o + 4] = (j + 0.35 * fx.rand()) * TAU / NH;
              dv.helix[j] = ribs.acquire();
            }
            dv.force = fx.forces.acquire();
            if (dv.force) dv.force.type = 1;
            dv.vol = null;
            for (let k = 0; k < NV; k++) if (!vols[k].used) { dv.vol = vols[k]; vols[k].used = true; break; }
          }
          st.light = fx.lights.acquire();
          if (st.light) { st.light.range = 5; st.light.intensity = 0; st.light.color.copy(air).lerp(sand, 0.4); }
        } else if (name === 'release') {
          st.light?.release(); st.light = null;
          fx.rig.shake(0.12, 9);
          E.gust.pos.copy(c.from); E.gust.vel.subVectors(c.to, c.from).setY(0).setLength(7); E.gust.burst(120 * p.streaks);
          for (const dv of st.d) {
            const s = dv.scale;
            E.skirt.pos.set(dv.x, 0.12, dv.z); E.skirt.radius = 0.7 * s; E.skirt.size = s; E.skirt.vel.set(0, 0.6, 0); E.skirt.burst(70 * p.dust);
            E.leafBurst.pos.set(dv.x, 0.3, dv.z); E.leafBurst.vel.set(0, 3.5, 0); E.leafBurst.burst(8 * p.debris);
            SHK.pos.set(dv.x, 0.05, dv.z); SHK.radius0 = 0.2; SHK.radius1 = 3.2 * s; SHK.duration = 0.5; SHK.thickness = 0.5; SHK.distortion = 0.04 * p.refraction; SHK.ground = true;
            fx.shocks?.spawn(SHK);
          }
        } else if (name === 'done') releaseAll(st);
      },

      update(c, dt) {
        const p = S.params, st = states[c.index], d = st.d;
        distortU.value = 0.03 * p.refraction;
        if (c.phase === 'charge') {
          // the focus gathers wind; three whorls stir on the floor
          const k = Math.min(1, c.t / c.durations.charge), f = c.from;
          E.gather.pos.copy(f); E.gather.rate(520 * p.streaks * (0.3 + 0.7 * k), dt);
          if (st.light) { st.light.pos.copy(f); st.light.intensity = 3 * k; }
          for (let i = 0; i < N; i++) {
            d[i].env = 0.25 + 0.45 * k;
            devilFrame(c, st, p, d[i], i, dt, 0.12 + 0.16 * k, 1.25 - 0.25 * k, true);
          }
          return;
        }
        st.L += dt;
        const L = st.L;
        if (!st.merging && L >= st.mergeAt) st.merging = true;
        if (!st.collapsed) dance(st, p, dt);
        const s0 = d[0];
        // merging: a devil that reaches the biggest is swallowed and pumps it up
        if (st.merging && !st.collapsed) {
          let left = 0;
          for (let i = 1; i < N; i++) {
            const dv = d[i];
            if (dv.absorbed) continue;
            if (dv.fade < 1) dv.fade = Math.max(0, dv.fade - dt / 0.3);
            else if (Math.hypot(dv.x - s0.x, dv.z - s0.z) < 0.5 * (dv.scale + s0.scale)) {
              dv.fade -= 1e-3;
              s0.boost += 0.2;
              E.kick.pos.set(s0.x, 0.6, s0.z); E.kick.vel.set(0, 2, 0); E.kick.size = 1.2 * s0.scale; E.kick.burst(70 * p.dust);
              fx.rig.shake(0.08, 10);
            }
            if (dv.fade <= 0) { dv.absorbed = true; dv.force?.release(); dv.force = null; }
            else left++;
          }
          // all swallowed: the merged devil stands a beat at full height, then blows out
          if (left === 0 && st.merged < 0) st.merged = L;
          if ((st.merged >= 0 && L > st.merged + 0.5) || L > st.mergeAt + MERGE) blowOut(c, st, p);
        }
        // envelopes: spin up after release; the survivor unwinds after the blow-out
        const up = smooth(0, 0.6, L), grow = 0.28 + 0.72 * backOut(L / 0.55);
        for (let i = 0; i < N; i++) {
          const dv = d[i];
          if (dv.absorbed && i > 0) { dv.env = 0; devilFrame(c, st, p, dv, i, dt, grow, 1, false); continue; }
          let g = grow, unwind = 1;
          if (st.collapsed) {
            const x = smooth(0, 0.9, L - st.tc);
            dv.env = 1 - x; unwind = 1 + 1.3 * x; g = grow * (1 + 0.25 * x);
          } else dv.env = 0.55 + 0.45 * up;
          dv.boost = Math.min(dv.boost, 0.5);
          devilFrame(c, st, p, dv, i, dt, g, unwind, false);
        }
        buffet(st, p, dt);
        // the blow-out's shock shell runs out through every loose particle
        if (st.shock) {
          st.shockT += dt;
          const x = st.shockT / 0.7;
          if (x >= 1) { st.shock.release(); st.shock = null; }
          else { st.shock.p[0] = 0.3 + 7 * Math.pow(x, 0.5); st.shock.p[2] = 45 * p.strength * (1 - x); }
        }
      },
    };
  },
};
