import * as THREE from 'three';
import { blackbodyRGB } from '../../vfx/noise.js';
import { NOISE_GLSL } from '../../vfx/common.js';

// Fire Tornado (SPELLBOOK hybrid, fire + wind). Anticipation: a two-armed spiral burns inward across
// the floor at the target like a fuse (heat + char, so ground flames sprout along it), hot air
// spirals in at floor level and embers lift. Eruption: the funnel bursts up out of the spiral's
// eye with a ground shock. Sustain: a Rankine vortex joins the shared force field (every loose
// particle of every spell is dragged round and up), 12 flame-shaded analytic helix ribbons wind up
// the funnel (licking tongues racing upward, cooling to soot at the top; half-res glow + heat haze,
// crisp cores at full res), media flames are flung round and up it, embers spiral up and rain out
// of the top, smoke rolls off the crown, heat-haze sprites spiral round it and a dust skirt churns
// at its foot. It wanders a little, scorches a ring under itself, sets dummies burning and spins
// them, and swirls the pool if it gets close. Death: the spin winds down, the flame fails from the
// top, the crown turns to smoke and the embers fall.

const NH = 12;   // helix flame ribbons per tornado (fx: glow + haze)
const NC = 6;    // of those, crisp full-res cores
const NA = 2;    // spiral arms scorched into the floor
const TAU = Math.PI * 2;
const TH = 3.3 * Math.PI;   // spiral sweep (rad)

// p0 = foot xyz, p1 = (height, radius foot, radius top, turns), p2 = (angle, lean x, lean z, width),
// p3 = (seed, reveal, distortion m, heat)
const PATH_GLSL = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  float r = mix(p1.y, p1.z, pow(t, 1.5)) * (1.0 + 0.1 * sin(t * 7.0 + p3.x * 6.2831853 + uTime * 3.1));
  float th = p2.x + t * p1.w * 6.2831853;
  width = p2.w * mix(0.55, 1.5, t) * smoothstep(0.0, 0.05, t);
  return p0.xyz + vec3(p2.y, 0.0, p2.z) * (t * t) + vec3(cos(th) * r, t * p1.x, sin(th) * r);
}`;

const SHADE_GLSL = NOISE_GLSL + /* glsl */`
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uCool;
vec3 fireRamp(float h) { return h < 0.5 ? mix(uCool, uMid, h * 2.0) : mix(uMid, uHot, h * 2.0 - 1.0); }
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  float u = r.uv.x, v = r.uv.y, av = abs(v), seed = r.p3.x;
  // tongues of flame racing up the ribbon
  float n = noise3(vec3(u * 0.8 - uTime * 0.7 + seed, av * 0.08 + seed * 0.3, uTime * 0.05));
  float n2 = noise3(vec3(u * 2.1 - uTime * 1.6 + seed * 1.9, v * 0.12, 0.4 + seed));
  float fl = n * 0.6 + n2 * 0.4;
  float ends = smoothstep(0.0, 0.04, u) * (1.0 - smoothstep(r.p3.y - 0.25, r.p3.y, u));
  float h = clamp(((1.0 - u) * 1.05 + (fl - 0.5) * 0.6 - av * 0.35) * r.p3.w, 0.0, 1.0);
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
#ifdef RIBBON_FX
  float tongue = smoothstep(0.32, 0.72, fl + (1.0 - u) * 0.22);
  float edge = smoothstep(0.0, 0.5, (1.0 - av) - (fl - 0.45) * 1.2);
  float g = edge * tongue * exp(-1.2 * v * v) * ends;
  // where the flame has cooled at the crown it is soot: dark, occluding
  // and the flame itself covers what is behind it (additive-only orange over sky reads pink)
  media = vec3(0.03, 0.025, 0.021);
  alpha = max(0.3 * smoothstep(0.5, 0.95, u) * edge * ends * smoothstep(0.35, 0.65, n), min(g * 0.4, 0.65));
  distortion = r.p3.z * v * exp(-3.0 * v * v) * 2.33 * ends;
  return fireRamp(h) * r.color * g;
#else
  float core = exp(-5.0 * v * v) * smoothstep(0.38, 0.8, fl + (1.0 - u) * 0.2) * ends;
  return fireRamp(clamp(h + 0.2, 0.0, 1.0)) * r.color * core;
#endif
}`;

// flame-ish kinds, retinted from temperature + tint like fire.js: [kind, hot x T, cold x T]
const HOT_KINDS = [['flame', 1.25, 0.38], ['ember', 1.1, 0.5], ['draft', 1.2, 0.55], ['spark', 1.45, 0.6]];
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export default {
  id: 'fire-tornado', name: 'Fire Tornado', element: 'hybrid', order: 20, hue: '#ff6a1a',
  shape: 'area', radius: 0.5,
  params: { size: 1, height: 1, spin: 1, duration: 4.5, wander: 1, temperature: 1900, intensity: 1, flames: 1, embers: 1, smoke: 1, dust: 1, haze: 1, scorch: 1, tint: '#ffffff' },
  ranges: {
    size: [0.4, 2, 0.01], height: [0.4, 1.8, 0.01], spin: [0.2, 2.5, 0.01], duration: [1.5, 10, 0.1], wander: [0, 3, 0.01], temperature: [900, 6500, 10],
    intensity: [0, 3, 0.01], flames: [0, 3, 0.01], embers: [0, 3, 0.01], smoke: [0, 3, 0.01], dust: [0, 3, 0.01], haze: [0, 3, 0.01], scorch: [0, 2, 0.01],
  },
  presets: {
    firestorm: { size: 1.35, height: 1.3, spin: 1.4, embers: 1.8, smoke: 1.5, duration: 6 },
    'blue whirl': { temperature: 6500, tint: '#8fb8ff', smoke: 0.2, dust: 0.4, spin: 1.6, height: 0.8 },
    'hell spout': { temperature: 1450, tint: '#ff5a4a', smoke: 2.2, flames: 1.4, haze: 1.6 },
  },
  timing: { charge: 1.0, impact: 0.3, linger: 4.5 },
  kinds: {
    // big licks the vortex flings round and up the funnel
    flame: { style: 'media', drag: 1.6, buoyancy: 3.0, curl: 2.4, curlScale: 0.45, forceResponse: 1.6, life: [0.3, 0.65], size: [0.14, 0.5], sizePow: 0.6, emissive: 1.1, temp: [2375, 720], toSmokeAt: 0.5, smokeAlbedo: 0.04, alpha: [0.8, 0], density: 8, distortion: 0.8, erosion: 1.8, fadeIn: 0.06, fadeOut: 0.3 },
    ember: { style: 'glow', drag: 0.4, buoyancy: 0.9, gravity: 1.6, curl: 1.6, curlScale: 0.5, forceResponse: 2.2, life: [1.4, 3.2], size: [0.03, 0.012], stretch: 0.04, emissive: 4, temp: [2090, 950], restitution: 0.3, friction: 0.4, paints: 'char', paintAmount: 0.04 },
    // hot air drawn in along the floor while it gathers
    draft: { style: 'glow', drag: 0.6, curl: 1.0, curlScale: 0.3, forceResponse: 2.2, life: [0.35, 0.7], size: [0.028, 0.008], stretch: 0.07, emissive: 2.4, temp: [2280, 1045], alpha: [0.9, 0], fadeIn: 0.25, fadeOut: 0.4 },
    spark: { style: 'glow', drag: 0.5, gravity: 9.8, restitution: 0.4, friction: 0.3, forceResponse: 1.5, life: [0.3, 1.0], size: [0.024, 0.008], stretch: 0.02, emissive: 6, temp: [2750, 1140], paints: 'heat', paintAmount: 0.04 },
    // the smoke column the flame turns into: lit grey-brown soot that keeps rotating as it rises
    smoke: { style: 'media', emissive: 0, drag: 1.2, buoyancy: 1.8, curl: 1.8, curlScale: 0.35, forceResponse: 1.2, life: [2.4, 4.4], size: [0.5, 2.6], sizePow: 0.5, color: ['#231e1a', '#4f4741'], alpha: [0.5, 0], density: 2.2, erosion: 1.2, fadeIn: 0.2, fadeOut: 0.45 },
    // refraction-only shimmer round the column (density 0: distortion only)
    haze: { style: 'media', drag: 0.3, forceResponse: 2.5, life: [0.9, 1.5], size: [0.9, 1.8], alpha: [1, 0], density: 0, distortion: 2.6, fadeIn: 0.25, fadeOut: 0.4 },
    // ash and grit churned up round the foot: dark, so the fire's own light doesn't turn it into glowing puffs
    dust: { style: 'media', emissive: 0, drag: 1.2, buoyancy: 0.2, curl: 1.0, curlScale: 0.25, forceResponse: 1.3, life: [0.9, 1.7], size: [0.25, 0.95], color: ['#2e2721', '#463c33'], alpha: [0.3, 0], density: 1.6, erosion: 1.1, fadeIn: 0.15 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const E = {
      draft: P.emitter('fire-tornado.draft', { shape: 'ring', radius: 3, spread: 0.4, radial: -3 }),
      lift: P.emitter('fire-tornado.ember', { shape: 'disk', radius: 2.5, spread: 0.6 }),
      flame: P.emitter('fire-tornado.flame', { shape: 'ring', radius: 1, spread: 0.6, radial: 0.3 }),
      foot: P.emitter('fire-tornado.flame', { shape: 'ring', radius: 0.7, spread: 0.8, radial: -0.4 }),
      ember: P.emitter('fire-tornado.ember', { shape: 'ring', radius: 1, spread: 0.8 }),
      burst: P.emitter('fire-tornado.flame', { shape: 'disk', radius: 0.8, spread: 1.6, radial: 2 }),
      spark: P.emitter('fire-tornado.spark', { shape: 'sphere', radius: 0.4, spread: 6, radial: 4 }),
      smoke: P.emitter('fire-tornado.smoke', { shape: 'ring', radius: 1.5, spread: 0.6, radial: 0.8 }),
      haze: P.emitter('fire-tornado.haze', { shape: 'ring', radius: 1, spread: 0.4 }),
      skirt: P.emitter('fire-tornado.dust', { shape: 'ring', radius: 1.6, spread: 0.5, radial: 1.2 }),
    };

    const hot = new THREE.Color(), mid = new THREE.Color(), cool = new THREE.Color();
    const shared = { uHot: { value: hot }, uMid: { value: mid }, uCool: { value: cool } };
    const ribs = new fx.AnalyticRibbons({ max: NH * 3, segments: 64, pathGLSL: PATH_GLSL, shadeGLSL: SHADE_GLSL, target: 'fx', uniforms: shared });
    const cores = new fx.AnalyticRibbons({ max: NC * 3, segments: 64, pathGLSL: PATH_GLSL, shadeGLSL: SHADE_GLSL, target: 'lines', uniforms: shared });
    fx.scenes.fx.add(ribs.mesh);
    fx.scenes.lines.add(cores.mesh);

    const state = Array.from({ length: 16 }, () => ({
      helix: new Array(NH).fill(null), cores: new Array(NC).fill(null), vortex: null, light: null,
      hp: new Float32Array(NH * 5), arm: new Float32Array(NA * 2),
      centre: new THREE.Vector3(), base: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), lean: new THREE.Vector3(),
      env: 0, age: 0, th: TH, nextSplat: 0, hitT: 0, seedF: 0, phase0: 0, H: 0,
    }));

    const _a = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), col = new THREE.Color(), tintCol = new THREE.Color();
    const SPLAT = { x: 0, z: 0, radius: 1, heat: 0, char: 0, pattern: 'radial', seed: 0, x2: 0, z2: 0, width: 0 };
    const SHOCK = { pos: new THREE.Vector3(), radius0: 0.4, radius1: 6, duration: 0.6, thickness: 0.7, distortion: 0.04, intensity: 0, ground: true };

    let lastT = -1, lastTint = '';
    const HOT = HOT_KINDS.map(([k, a, b]) => ({ name: `fire-tornado.${k}`, a, b, white: { temp: [0, 0] }, tinted: { temp: null, color: [new THREE.Color(), new THREE.Color()] } }));
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

    function splat(x, z, radius, heat, char, pattern, seed, x2 = x, z2 = z, width = 0) {
      SPLAT.x = x; SPLAT.z = z; SPLAT.radius = radius; SPLAT.heat = heat; SPLAT.char = char; SPLAT.pattern = pattern;
      SPLAT.seed = seed; SPLAT.x2 = x2; SPLAT.z2 = z2; SPLAT.width = width;
      fx.ground.splat(SPLAT);
    }
    // funnel radius at normalised height (before size)
    const rAt = (hn) => 0.4 + 0.85 * Math.pow(hn, 1.5);
    // --- flame mass: every combusting volume of the spell goes through these three calls (the
    // eruption, the flames the vortex carries up the column, the roaring foot), so the whole mass
    // can move onto the shared FluidVolume combustion solver in one place. Particles meanwhile.
    const flameMass = {
      erupt(x, z, p) {
        const sz = p.size;
        E.burst.pos.set(x, 0.3, z); E.burst.radius = 0.6 * sz; E.burst.vel.set(0, 7, 0); E.burst.size = sz; E.burst.burst(220 * p.flames);
      },
      column(b, lean, H, p, e, dt) {   // flames riding the vortex at random heights
        const sz = p.size;
        for (let j = 0; j < 3; j++) {
          const hn = j === 0 ? fx.rand() * 0.25 : fx.rand() * 0.85;
          E.flame.pos.set(b.x + lean.x * hn * hn, hn * H, b.z + lean.z * hn * hn);
          E.flame.radius = rAt(hn) * sz * 0.6;
          E.flame.vel.set(0, 2.5, 0); E.flame.size = sz * (0.7 + 0.8 * hn);
          E.flame.rate(260 * p.flames * e, dt);
        }
      },
      foot(b, p, e, dt) {
        const sz = p.size;
        E.foot.pos.set(b.x, 0.15, b.z); E.foot.radius = 0.75 * sz; E.foot.vel.set(0, 3.5, 0); E.foot.size = sz;
        E.foot.rate(300 * p.flames * e, dt);
      },
    };
    // the spiral scorch: radius at angle th (0 = the eye)
    const spiralR = (th, sz) => (0.3 + 0.9 * th / Math.PI) * sz;

    function releaseAll(st) {
      for (let i = 0; i < NH; i++) { st.helix[i]?.release(); st.helix[i] = null; }
      for (let i = 0; i < NC; i++) { st.cores[i]?.release(); st.cores[i] = null; }
      st.vortex?.release(); st.vortex = null;
      st.light?.release(); st.light = null;
    }

    // --- anticipation: the spiral burns inward like a fuse; hot air and embers are drawn in ---
    function gather(c, st, p, dt) {
      const k = Math.min(1, c.t / c.durations.charge), sz = p.size, cx = st.centre.x, cz = st.centre.z;
      const th = TH * (1 - smooth(0, 0.95, k));
      // one segment per arm every ~50 ms, overlapping the last so the joins don't bead
      if (st.th - th > 0.32 || (k >= 1 && st.th > 0)) {
        for (let a = 0; a < NA; a++) {
          const o = st.phase0 + a * Math.PI, t0 = Math.min(TH, st.th + 0.12);
          const r0 = spiralR(t0, sz), r1 = spiralR(th, sz);
          splat(cx + Math.cos(t0 + o) * r0, cz + Math.sin(t0 + o) * r0, 0.3, 0.95 * p.scorch, 0.85 * p.scorch, 'line', (c.seed + a * 13 + th * 7) % 97,
            cx + Math.cos(th + o) * r1, cz + Math.sin(th + o) * r1, (0.12 + 0.1 * th / TH) * sz);
          // sparks spit where the fuse burns
          E.spark.pos.set(cx + Math.cos(th + o) * r1, 0.1, cz + Math.sin(th + o) * r1); E.spark.vel.set(0, 2, 0); E.spark.burst(14 * p.embers);
        }
        st.th = th;
      }
      E.draft.pos.set(cx, 0.15, cz); E.draft.radius = 3.2 * sz; E.draft.rate(500 * p.flames * (0.3 + 0.7 * k), dt);
      E.lift.pos.set(cx, 0.1, cz); E.lift.radius = 2.4 * sz; E.lift.vel.set(0, 1.4, 0); E.lift.rate(160 * p.embers * k, dt);
      const V = st.vortex;
      if (V) { V.pos.set(cx, 0, cz); V.dir.copy(_up); V.p[0] = 1.0 * sz; V.p[1] = 10 * sz * k * p.spin; V.p[2] = 1.5 * k; V.p[3] = 1.5 * k; V.w = 3; }
      if (st.light) { st.light.pos.set(cx, 0.4, cz); st.light.end.set(cx, 0.6, cz); st.light.intensity = 10 * k * p.intensity; }
    }

    // --- the funnel ---
    function place(c, st, p, dt) {
      const b = st.base, w = p.wander * p.size, a = st.age;
      st.prev.copy(b);
      b.set(st.centre.x + Math.sin(a * 0.9 + st.seedF * 6) * 0.45 * w * smooth(0, 1.5, a), 0, st.centre.z + Math.sin(a * 0.7 + st.seedF * 4 + 1.3) * 0.45 * w * smooth(0, 1.5, a));
      if (dt > 0) st.vel.lerp(_a.subVectors(b, st.prev).divideScalar(dt), 1 - Math.exp(-dt * 4));
      c.pos.copy(b);
    }

    function funnel(c, st, p, dt) {
      const sz = p.size, e = st.env, b = st.base, a = st.age;
      const H = st.H = Math.max(0.4, 7 * sz * p.height * (1 - Math.exp(-a * 4)) * (0.6 + 0.4 * e));
      const V = st.vortex;
      if (V) {
        V.pos.copy(b); V.dir.copy(_up);
        V.p[0] = 0.85 * sz; V.p[1] = 30 * p.spin * sz * e; V.p[2] = 7 * e; V.p[3] = 1.0 * e;
        V.w = H * 1.1;
      }
      // the top lags its motion and sways
      st.lean.set(-st.vel.x * 0.35 + Math.sin(a * 1.1 + st.seedF * 4) * 0.45 * sz, 0, -st.vel.z * 0.35 + Math.cos(a * 0.8 + st.seedF * 2) * 0.45 * sz);
      const reveal = 1.15 * smooth(0, 0.6, a) * (1 - 0.45 * (1 - e)), unwind = 1 + (1 - e) * 0.7, omega = 3.4 * p.spin * (0.4 + 0.6 * e);
      for (let i = 0; i < NH; i++) {
        const o = i * 5, hp = st.hp, h = st.helix[i];
        const ang = hp[o + 4] - a * omega * (0.8 + 0.25 * hp[o]);
        if (h) {
          h.p0.set(b.x, 0.02, b.z, 0);
          h.p1.set(H * hp[o + 3], hp[o + 1] * sz, hp[o + 2] * sz * unwind, -hp[o]);
          h.p2.set(ang, st.lean.x, st.lean.z, 0.45 * sz);
          h.p3.set(hp[o + 4] / TAU, reveal, 0.06 * p.haze * e, 0.6 + 0.4 * e);
          h.intensity = 1.1 * p.intensity * Math.min(1, e * 1.4);
        }
        const k = i < NC ? st.cores[i] : null;
        if (k && h) {
          k.p0.copy(h.p0); k.p1.copy(h.p1); k.p2.copy(h.p2); k.p3.copy(h.p3);
          k.p2.w = 0.05 * sz;
          k.intensity = 0.55 * p.intensity * Math.min(1, e * 1.4);
        }
      }
      // what the vortex carries: flames round the funnel, a roaring foot, embers, smoke, haze, dust
      const lean = st.lean;
      flameMass.column(b, lean, H, p, e, dt);
      flameMass.foot(b, p, e, dt);
      const hn = fx.rand();
      E.ember.pos.set(b.x + lean.x * hn * hn, hn * H * 0.7, b.z + lean.z * hn * hn); E.ember.radius = rAt(hn) * sz;
      E.ember.vel.set(0, 2.5, 0); E.ember.rate(380 * p.embers * e, dt);
      E.lift.pos.set(b.x, 0.1, b.z); E.lift.radius = 2.2 * sz; E.lift.vel.set(0, 1.2, 0); E.lift.rate(160 * p.embers * e, dt);
      // the flame sheds a sheath of soot over its upper half that keeps turning as it rises
      const hs = 0.55 + 0.45 * fx.rand();
      E.smoke.pos.set(b.x + lean.x * hs * hs, H * hs, b.z + lean.z * hs * hs); E.smoke.radius = rAt(hs) * sz * 0.85; E.smoke.vel.set(0, 1.6, 0); E.smoke.size = sz * (0.6 + 0.7 * hs);
      E.smoke.rate((34 + 30 * (1 - e)) * p.smoke * Math.min(1, a * 2) * (c.phase === 'linger' && c.t > c.durations.linger - 0.5 ? 0 : 1), dt);
      const hh = 0.1 + 0.7 * fx.rand();
      E.haze.pos.set(b.x + lean.x * hh * hh, hh * H, b.z + lean.z * hh * hh); E.haze.radius = rAt(hh) * sz * 0.8; E.haze.size = sz; E.haze.vel.set(0, 1.5, 0);
      E.haze.rate(40 * p.haze * e, dt);
      E.skirt.pos.set(b.x, 0.15, b.z); E.skirt.radius = 1.7 * sz; E.skirt.size = sz;
      E.skirt.rate(70 * p.dust * e, dt);
      // a scorched ring under it, and its wandering track
      if (a >= st.nextSplat && e > 0.3) {
        st.nextSplat = a + 0.25;
        // little heat per splat: they pile up (heat lasts ~2.5 s), and the floor should smoulder and
        // char under the foot rather than sprout a carpet of ground flames
        splat(b.x, b.z, 1.3 * sz, 0.03 * p.scorch, 0.35 * p.scorch, 'ring', (c.seed + a * 11) % 97, b.x, b.z, 0.5 * sz);
      }
      // dummies in reach burn and are dragged round the funnel
      st.hitT -= dt;
      if (st.hitT <= 0) {
        st.hitT = 0.25;
        for (const dm of fx.dummies) {
          const dx = dm.pos.x - b.x, dz = dm.pos.z - b.z, d = Math.hypot(dx, dz), R = 2.4 * sz;
          if (d < R) {
            dm.status.burn = Math.max(dm.status.burn, (1.2 - d / R) * e);
            dm.hit(_a.set(dz, 0, -dx).normalize(), 0.4 * e * p.spin * (1 - d / R));
          }
        }
      }
      // the pool swirls when it passes near
      const pool = fx.ARENA.pool;
      const qx = Math.max(Math.abs(b.x - pool.center.x) - pool.half.x, 0), qz = Math.max(Math.abs(b.z - pool.center.y) - pool.half.y, 0);
      const pd = Math.hypot(qx, qz), reach = 3 * sz;
      if (pd < reach && fx.pool) {
        fx.pool.swirl(THREE.MathUtils.clamp(b.x, pool.center.x - pool.half.x, pool.center.x + pool.half.x), THREE.MathUtils.clamp(b.z, pool.center.y - pool.half.y, pool.center.y + pool.half.y), 3 * e * p.spin * (1 - pd / reach));
      }
      const L = st.light;
      if (L) {
        const flick = 0.8 + 0.2 * Math.sin(c.age * 29 + c.seed) * Math.sin(c.age * 11.3) + 0.06 * Math.sin(c.age * 67);
        L.pos.set(b.x, 0.3, b.z); L.end.set(b.x + lean.x * 0.4, Math.max(0.6, H * 0.6), b.z + lean.z * 0.4);
        L.intensity = 34 * p.intensity * flick * e + 2.5 * p.intensity * (1 - e) * Math.max(0, 1 - c.t / c.durations.linger);
      }
    }

    return {
      onParam(k) { if (k === 'tint' || k === 'temperature') retint(); },
      tick() { ribs.update(); cores.update(); },

      phase(c, name) {
        const p = S.params, st = state[c.index];
        retint();
        if (name === 'charge') {
          releaseAll(st);
          c.durations.linger = p.duration;
          st.centre.set(c.to.x, 0, c.to.z);
          st.base.copy(st.centre); st.prev.copy(st.centre); st.vel.set(0, 0, 0);
          st.env = 0; st.age = 0; st.th = TH; st.nextSplat = 0; st.hitT = 0; st.H = 0;
          st.seedF = (c.seed % 997) / 997; st.phase0 = st.seedF * TAU;
          st.vortex = fx.forces.acquire();
          if (st.vortex) st.vortex.type = 1;
          st.light = fx.lights.acquire();
          if (st.light) { st.light.type = 1; st.light.range = 12 * p.size; st.light.shadow = true; st.light.intensity = 0; lightColor(p.temperature, st.light.color); }
        } else if (name === 'impact') {
          // eruption out of the spiral's eye
          const x = st.centre.x, z = st.centre.z, sz = p.size;
          st.age = 0;
          for (let i = 0; i < NH; i++) {
            const o = i * 5;
            st.hp[o] = 2.2 + 1.1 * fx.rand();               // turns
            st.hp[o + 1] = 0.22 + 0.28 * fx.rand();         // foot radius
            st.hp[o + 2] = 0.95 + 0.55 * fx.rand();         // top radius
            st.hp[o + 3] = 0.75 + 0.3 * fx.rand();          // height fraction
            st.hp[o + 4] = (i + 0.35 * fx.rand()) * TAU / NH;
            st.helix[i] = ribs.acquire();
            if (st.helix[i]) st.helix[i].intensity = 0;
            if (i < NC) { st.cores[i] = cores.acquire(); if (st.cores[i]) st.cores[i].intensity = 0; }
          }
          flameMass.erupt(x, z, p);
          E.spark.pos.set(x, 0.4, z); E.spark.vel.set(0, 4, 0); E.spark.burst(500 * p.embers);
          E.skirt.pos.set(x, 0.15, z); E.skirt.radius = 1.2 * sz; E.skirt.burst(40 * p.dust);
          SHOCK.pos.set(x, 0.05, z); SHOCK.radius1 = 6 * sz; SHOCK.distortion = 0.05 * p.haze;
          fx.shocks?.spawn(SHOCK);
          splat(x, z, 1.6 * sz, 0.45 * p.scorch, 0.7 * p.scorch, 'noise', c.seed % 89);
          fx.impacts.add('scorch', _a.set(x, 1, z), 2.8 * sz, 1, p.duration + 3, lightColor(p.temperature, col));
          fx.flash(0.12 * p.intensity);
          fx.rig.shake(0.4, 8);
          if (!fx.reduced) fx.rig.punch(1.5, 0.1);
        } else if (name === 'done') releaseAll(st);
      },

      update(c, dt) {
        const p = S.params, st = state[c.index];
        if (c.phase === 'charge') { gather(c, st, p, dt); return; }
        st.age += dt;
        st.env = c.phase === 'linger' ? 1 - smooth(c.durations.linger - 1.4, c.durations.linger, c.t) : smooth(0, c.durations.impact, c.t);
        place(c, st, p, dt);
        funnel(c, st, p, dt);
      },
    };
  },
};
