import * as THREE from 'three';
import { U, COMMON_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING } from '../../vfx/common.js';
import { instanced } from '../../vfx/Ribbons.js';

// Aurora Veil (Light + Arcane hybrid). A holy circle draws itself under the target and motes rise
// from it along the field lines; high above, a faint quiet arc of aurora forms. Then the substorm
// breaks: the arc brightens, folds deepen and travel along it, rays race sideways, more curtains
// unroll from the middle out, and a magenta fringe flares along the razor-sharp lower border.
// Each curtain is one instanced strip (fx pass, half-res emission only): the vertex shader folds a
// vertical sheet with three travelling waves (the top lags a little, like drapery); the fragment
// shader builds vertical rays from drifting noise along the sheet, a sharp bright lower border
// with a thin pink fringe, a green body fading upward into magenta / purple tops, and brightness
// ~ 1 / |n.v| so the folds seen edge-on blaze. Under them the light is what real aurora gives a
// snowfield or a lake (timelapse reference): faint, soft, slowly wandering. A green line light along
// every lower border (one shadowed), each sliding along its curtain with the brightest folds and
// breathing with the pulsating patches, and a dim magenta light up high: they light the floor,
// pillars and dummies and mirror in the polished floor as soft streaks. Nothing is painted with
// glow (it would light the grout lines); the cleansing is a negative corruption splat under each
// curtain. Faint green precipitation drifts down; a gentle vortex lifts loose particles along the
// "field lines"; the pool lights up; dummies under the veil are cleansed of corruption.

const MAX_CASTS = 16, MAX_CURTAINS = 4, MAX_INST = 16, COLS = 112, ROWS = 9;
const V0 = -0.15, V1 = 1.2;   // strip height range in curtain heights: veil skirt below the border, margin above the tops

const CURTAIN_VERT = /* glsl */`
in vec4 aP0;   // centre xyz, length m
in vec4 aP1;   // axis xz, lower border y, height m
in vec4 aP2;   // seed, fold amplitude m, fold clock, ray clock
in vec4 aP3;   // energy, reveal 0..1, fringe, rays
out vec3 vW;
out vec3 vN;
out vec2 vUV;
out float vS;
out float vViewZ;
out vec4 vP2;
out vec4 vP3;
// three travelling waves along the sheet: a long S, a medium fold, small curls
float fold(float s, float tau, float ph, out float d) {
  const float k0 = 0.17, k1 = 0.43, k2 = 1.05;
  float x0 = k0 * s + tau * 0.31 + ph, x1 = k1 * s - tau * 0.83 + ph * 2.3, x2 = k2 * s + tau * 1.7 + ph * 4.1;
  d = 1.6 * k0 * cos(x0) + 1.25 * k1 * cos(x1) + 0.45 * k2 * cos(x2);
  return 1.6 * sin(x0) + 1.25 * sin(x1) + 0.45 * sin(x2);
}
void main() {
  vUV = position.xy; vP2 = aP2; vP3 = aP3; vW = vec3(0.0); vN = vec3(0.0, 0.0, 1.0); vS = 0.0; vViewZ = 1.0;
  if (aP3.x <= 0.0 || aP3.y <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float u = position.x, v = position.y, L = aP0.w;
  float s = (u - 0.5) * L;
  vec3 ax = vec3(aP1.x, 0.0, aP1.y), pp = vec3(-aP1.y, 0.0, aP1.x);
  // the top lags the bottom a little and swings wider
  float A = aP2.y * (1.0 + 0.3 * v), df;
  float f = fold(s, aP2.z - v * 0.8, aP2.x, df) * A;
  df *= A;
  // a gentle bow away from the caster at the ends
  float b = 0.24 * L * (u - 0.5) * (u - 0.5), db = 0.48 * (u - 0.5);
  vec3 w = aP0.xyz + ax * s + pp * (f + b);
  // small curls ripple along the lower border
  w.y = aP1.z + (0.22 * sin(s * 0.9 - aP2.z * 1.7 + aP2.x) + 0.1 * sin(s * 2.7 + aP2.z * 3.1)) * (1.0 - v) + v * aP1.w;
  vN = normalize(pp - ax * (df + db));
  vW = w; vS = s;
  vec4 view = viewMatrix * vec4(w, 1.0);
  vViewZ = -view.z;
  gl_Position = projectionMatrix * view;
}`;

const CURTAIN_FRAG = /* glsl */`
uniform vec3 uAvBody;
uniform vec3 uAvTop;
uniform vec3 uAvFringe;
uniform float uAvScale;
uniform float uAvVeil;
in vec3 vW;
in vec3 vN;
in vec2 vUV;
in float vS;
in float vViewZ;
in vec4 vP2;
in vec4 vP3;
float vnoise(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash11(i), hash11(i + 1.0), f); }
void main() {
  float u = vUV.x, v = vUV.y;
  float E = vP3.x, reveal = vP3.y, fringe = vP3.z, rays = vP3.w, drift = vP2.w;
  // unrolls from the middle outwards, soft ends
  float du = abs(u - 0.5) * 2.0;
  float ends = smoothstep(1.0, 0.6, du) * smoothstep(reveal * 1.2, reveal * 1.2 - 0.3, du);
  if (ends <= 0.0) discard;
  // rays: drifting noise along the sheet (metres), sharpened into thin vertical streaks
  float x = vS + vP2.x * 17.0;
  float r = vnoise(x * 1.7 + drift) * 0.5 + vnoise(x * 4.3 - drift * 1.7 + 7.0) * 0.33 + vnoise(x * 11.0 + drift * 2.9 + 3.0) * 0.17;
  r = smoothstep(0.18, 0.82, r) * (0.82 + 0.36 * vnoise(x * 27.0 + drift * 4.0));   // fine striation
  float sharp = 1.5 + 2.0 * rays;
  float ray = mix(0.8, pow(r, sharp) * (0.6 + sharp), min(rays, 1.0));
  // some rays reach much higher than others
  float top = 0.4 + 0.6 * vnoise(x * 0.8 + drift * 0.4 + 11.0);
  // altitude: razor lower border, bright green base falling off upward, magenta-purple tops
  float border = smoothstep(0.0, 0.025, v);
  float body = exp(-v * 1.5 / top) * (0.45 + 0.55 * exp(-v * 5.0));
  float upper = smoothstep(0.4, 0.75, v) * smoothstep(top + 0.3, top - 0.1, v);
  // rays carry the green high; the faint red-purple only shows where the green has died away, and
  // each ray frays out upward at its own height
  float fray = 0.55 + 0.45 * vnoise(x * 6.0 + v * 9.0 - drift * 3.0);
  vec3 col = uAvBody * body * (0.2 + 0.8 * ray) + uAvTop * upper * (0.15 + 0.85 * ray) * fray * 0.07;
  col = col * border + uAvFringe * exp(-v * v * 1800.0) * fringe * (0.5 + ray) * 0.6;
  // pulsating patches
  float cell = floor(x * 0.55);
  float puls = 0.78 + 0.22 * sin(uTime * (1.2 + 2.2 * hash11(cell)) + hash11(cell + 5.0) * 6.283);
  // a thin glowing sheet: path length through it ~ 1 / |cos|, so folds seen edge-on blaze
  float nv = abs(dot(vN, normalize(cameraPosition - vW)));
  float edge = clamp(0.32 / sqrt(nv * nv + 0.03), 0.35, 1.8);
  float soft = softFade(vViewZ, 0.6);
  vec3 e = col * (E * ends * puls * edge * uAvScale) * soft;
  // the veil: a thin dusk-blue dimming of the sky around the curtains so they read in daylight
  // dimming most where the sheet glows, so it never reads as a dark panel
  float a = uAvVeil * min(E, 1.0) * ends * smoothstep(-0.15, 0.06, v) * smoothstep(0.95, 0.3, v) * soft * (0.3 + 0.7 * min(body * (0.4 + ray), 1.0));
  fxOut(vec3(0.006, 0.01, 0.03), a, e, vec2(0.0), vViewZ);
}`;

// module scratch (nothing is allocated after create)
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const sstep = THREE.MathUtils.smoothstep;
// per-curtain layout: offset along the cast (m), shift along the curtain (fraction of length),
// border altitude offset (m), height and length scale, energy weight
const LAYOUT = [
  [0, 0, 0, 1, 1, 1],
  [-2.8, 0.12, 0.6, 0.85, 0.8, 0.7],
  [2.6, -0.14, 1.2, 0.9, 0.72, 0.8],
  [-5.4, 0.05, 2.3, 0.8, 0.9, 0.55],
];

export default {
  id: 'aurora-veil', name: 'Aurora Veil', element: 'light', order: 20, hue: '#2dff8a',
  shape: 'area',
  params: {
    curtains: 3, length: 18, height: 8, base: 3.4, fold: 1, rays: 1, speed: 1, duration: 5.5,
    intensity: 1, light: 1, precipitation: 1, veil: 1,
    color: '#19ff66', top: '#b23cff', fringe: '#ff3fa8',
  },
  ranges: {
    curtains: [1, MAX_CURTAINS, 1], length: [8, 26, 0.1], height: [4, 14, 0.1], base: [2.5, 8, 0.05],
    fold: [0, 2.5, 0.01], rays: [0, 2, 0.01], speed: [0.2, 3, 0.01], duration: [2, 12, 0.1],
    intensity: [0.1, 3, 0.01], light: [0, 3, 0.01], precipitation: [0, 3, 0.01], veil: [0, 2, 0.01],
  },
  presets: {
    substorm: { curtains: 4, fold: 1.7, rays: 1.6, speed: 2, intensity: 1.4, light: 1.3 },
    'quiet arc': { curtains: 1, length: 24, fold: 0.45, rays: 0.6, speed: 0.45, duration: 8, intensity: 0.8 },
    'blood aurora': { color: '#ff2b47', top: '#a01cff', fringe: '#ffb0d0', rays: 1.3 },
  },
  timing: { charge: 1.2, impact: 1, linger: 5.5 },
  kinds: {
    // faint green precipitation drifting down from the lower borders, painting glow where it lands
    rain: { style: 'glow', drag: 1.5, gravity: 0.6, curl: 1.1, curlScale: 0.6, forceResponse: 0.8, life: [2.2, 3.6], size: [0.022, 0.008], stretch: 0.04, emissive: 4, color: ['#d8fff0', '#2dff8a'], alpha: [1, 0], fadeIn: 0.25, fadeOut: 0.5 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    // founding kinds by full name: light's rising motes (charge), arcane's sparkles (breakup fringe)
    const motes = P.emitter('light.mote', { shape: 'ring', radius: 2.4, spread: 0.3 });
    const sparkle = P.emitter('arcane.sparkle', { shape: 'line', radius: 0.25, spread: 1.2 });
    const rain = P.emitter('aurora-veil.rain', { shape: 'line', radius: 0.35, spread: 0.35 });

    // colours (linear), shared by reference with the material
    const body = new THREE.Color(), topC = new THREE.Color(), fringe = new THREE.Color(), poolCol = new THREE.Color();
    const vBody = new THREE.Vector3(), vTop = new THREE.Vector3(), vFringe = new THREE.Vector3();
    let cB = '', cT = '', cF = '';
    function syncColors() {
      const p = S.params;
      if (p.color === cB && p.top === cT && p.fringe === cF) return;
      cB = p.color; cT = p.top; cF = p.fringe;
      body.set(cB); topC.set(cT); fringe.set(cF);
      vBody.set(body.r, body.g, body.b); vTop.set(topC.r, topC.g, topC.b); vFringe.set(fringe.r, fringe.g, fringe.b);
      poolCol.copy(body).lerp(fringe, 0.15);
      P.setKind('aurora-veil.rain', { color: ['#e0fff2', cB] });
    }

    // reusable option objects (the systems copy what they need)
    const SIG = { pos: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), radius: 2.4, color: body, intensity: 0, reveal: 0, rotation: 0, style: 'holy', seed: 0 };
    const SPLAT = { x: 0, z: 0, x2: 0, z2: 0, radius: 1.6, width: 1.6, corruption: 0, pattern: 'line', seed: 0 };

    // --- curtains: one instanced strip mesh (u along, v up) ---
    const pos = [], idx = [];
    for (let j = 0; j <= ROWS; j++) for (let i = 0; i <= COLS; i++) pos.push(i / COLS, V0 + (V1 - V0) * j / ROWS, 0);
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const a = j * (COLS + 1) + i, b = a + 1, c2 = a + COLS + 1, d2 = c2 + 1;
      idx.push(a, b, d2, a, d2, c2);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const a0 = instanced(geo, 'aP0', MAX_INST), a1 = instanced(geo, 'aP1', MAX_INST), a2 = instanced(geo, 'aP2', MAX_INST), a3 = instanced(geo, 'aP3', MAX_INST);
    geo.instanceCount = 0;
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, side: THREE.DoubleSide, ...FX_BLENDING,
      uniforms: { ...U, uAvBody: { value: vBody }, uAvTop: { value: vTop }, uAvFringe: { value: vFringe }, uAvScale: { value: 6 }, uAvVeil: { value: 0.4 } },
      vertexShader: FX_VERT_HEAD + COMMON_GLSL + CURTAIN_VERT,
      fragmentShader: FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + CURTAIN_FRAG,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    fx.scenes.fx.add(mesh);

    // --- per cast record (cast.js keeps 16) ---
    const ST = Array.from({ length: MAX_CASTS }, () => ({
      on: false, centre: new THREE.Vector3(), dir: new THREE.Vector3(), axis: new THREE.Vector3(),
      n: 0, E: 0, fold: 0, fringe: 0, tau: 0, drift: 0, driftV: 0, rise: 0, splatT: 0,
      sigil: null, topLight: null, vortex: null,
      cur: Array.from({ length: MAX_CURTAINS }, () => ({
        c: new THREE.Vector3(), y0: 0, H: 0, L: 0, w: 1, seed: 0, reveal: 0, light: null,
      })),
    }));

    function release(d) {
      for (const k of d.cur) { k.light?.release(); k.light = null; k.reveal = 0; }
      d.sigil?.release(); d.topLight?.release(); d.vortex?.release();
      d.sigil = d.topLight = d.vortex = null;
      d.on = false;
    }

    // ends of curtain k's lower border (fold ignored) into _a, _b
    function borderEnds(d, k, y) {
      const h = k.L * 0.42;
      _a.copy(k.c).addScaledVector(d.axis, -h).setY(y);
      _b.copy(k.c).addScaledVector(d.axis, h).setY(y);
    }

    syncColors();

    return {
      onParam(key) { if (key === 'color' || key === 'top' || key === 'fringe') syncColors(); },

      phase(c, name) {
        const p = S.params, d = ST[c.index];
        syncColors();
        if (name === 'charge') {
          d.on = true;
          c.durations.charge = 1.2; c.durations.impact = 1; c.durations.linger = p.duration;
          if (c.target >= 0) d.centre.copy(fx.dummies[c.target].pos).setY(0); else d.centre.set(c.to.x, 0, c.to.z);
          d.dir.set(c.dir.x, 0, c.dir.z);
          if (d.dir.lengthSq() < 1e-6) d.dir.set(0, 0, -1);
          d.dir.normalize();
          d.axis.set(-d.dir.z, 0, d.dir.x);
          d.n = Math.round(p.curtains);
          d.E = 0; d.fold = 0.35; d.fringe = 0; d.rise = 0; d.splatT = 0;
          d.tau = fx.rand() * 20; d.drift = fx.rand() * 20; d.driftV = 0.3;
          for (let i = 0; i < MAX_CURTAINS; i++) {
            const k = d.cur[i], L = LAYOUT[i];
            k.L = p.length * L[4]; k.H = p.height * L[3]; k.y0 = p.base + L[2]; k.w = L[5];
            k.c.copy(d.centre).addScaledVector(d.dir, L[0]).addScaledVector(d.axis, L[1] * p.length);
            k.seed = fx.rand() * 10; k.reveal = 0; k.light = null;
            if (i < d.n) {
              k.light = fx.lights.acquire();
              if (k.light) { k.light.type = 1; k.light.intensity = 0; k.light.color.copy(body); k.light.range = k.y0 + 6; k.light.shadow = i === 0; }
            }
          }
          d.topLight = fx.lights.acquire();
          if (d.topLight) { d.topLight.intensity = 0; d.topLight.color.copy(topC); d.topLight.range = 16; }
          SIG.pos.set(d.centre.x, 0.02, d.centre.z); SIG.intensity = 0; SIG.reveal = 0; SIG.rotation = d.tau; SIG.seed = c.seed % 1000;
          d.sigil = fx.sigils.acquire(SIG);
          d.vortex = null;
        } else if (name === 'impact') {
          // the substorm breaks
          const I = p.intensity;
          fx.flash(0.1 * I);
          fx.rig.shake(0.16, 6);
          fx.pool?.flash(poolCol, 0.5 * I * p.light);
          for (let i = 0; i < d.n; i++) {
            const k = d.cur[i];
            borderEnds(d, k, k.y0);
            sparkle.pos.copy(_a); sparkle.p.copy(_b); sparkle.vel.set(0, -0.6, 0);
            sparkle.burst(220 * p.precipitation * k.w);
          }
          d.vortex = fx.forces.acquire();
          if (d.vortex) { d.vortex.type = 1; d.vortex.pos.copy(d.centre); d.vortex.dir.copy(UP); d.vortex.w = p.base + 2; d.vortex.p[0] = 2; d.vortex.p[1] = 0; d.vortex.p[2] = 0; d.vortex.p[3] = 0.25; }
        } else if (name === 'done') release(d);
      },

      update(c, dt) {
        const p = S.params, d = ST[c.index], I = p.intensity;
        if (!d.on) return;
        let Et = 0, foldT = 0.35, fringeT = 0, sigI = 0, sigR = 1;
        if (c.phase === 'charge') {
          // anticipation: a faint quiet arc high up, the circle draws, motes rise along the field
          const k = c.t / c.durations.charge;
          Et = 0.55 * sstep(k, 0, 0.9);
          d.cur[0].reveal = sstep(k, 0, 0.85);
          d.driftV = 0.3;
          sigR = sstep(k, 0, 0.8); sigI = (0.5 + 1.3 * k) * I;
          motes.pos.set(d.centre.x, 0.05, d.centre.z); motes.vel.set(0, 2 + 3 * k, 0);
          motes.rate(380 * k * p.precipitation, dt);
        } else if (c.phase === 'impact') {
          // breakup: brighten, fold, rays race, the other curtains unroll from the middle out
          const t = c.t / c.durations.impact;
          Et = t < 0.3 ? 1.8 : 1.25;
          for (let i = 0; i < d.n; i++) d.cur[i].reveal = Math.max(d.cur[i].reveal, sstep(t, 0.06 * i, 0.45 + 0.13 * i));
          foldT = 1.2 + 0.8 * (1 - sstep(t, 0.2, 1));
          fringeT = 1 - 0.6 * t;
          d.driftV = 0.6 + 4 * (1 - sstep(t, 0, 0.8));
          sigI = (1.0 + 1.0 * (1 - t)) * I;
        } else {
          // linger: ripples and pulsates, rays drift, the lower border climbs as it fades
          const t = c.t / c.durations.linger;
          for (let i = 0; i < d.n; i++) d.cur[i].reveal = 1;
          Et = 1.15 * (1 - sstep(t, 0.55, 1));
          foldT = 1.2; fringeT = 0.35 * (1 - t);
          d.driftV = 0.6;
          d.rise = 1.6 * sstep(t, 0.45, 1);
          sigR = 1 - sstep(t, 0.1, 0.6); sigI = 1.0 * I * (1 - sstep(t, 0, 0.4));
        }
        // eased (never a pop): fast up, slow down
        d.E += (Et - d.E) * (1 - Math.exp(-dt / (Et > d.E ? 0.12 : 0.6)));
        d.fold += (foldT - d.fold) * (1 - Math.exp(-dt / 0.3));
        d.fringe += (fringeT - d.fringe) * (1 - Math.exp(-dt / 0.15));
        d.tau += dt * p.speed * (0.5 + 0.6 * d.fold);
        d.drift += dt * p.speed * d.driftV;
        if (d.sigil) { d.sigil.reveal = sigR; d.sigil.intensity = sigI; d.sigil.rotation = d.tau * 0.15; }

        // lights: a green line light along each lower border, a magenta one up high
        const E = d.E, live = c.phase !== 'charge';
        // the light on the ground: a shorter segment of each border that slides along it with the
        // folds and breathes with the pulsations, so the glow on the floor wanders slowly
        for (let i = 0; i < d.n; i++) {
          const k = d.cur[i];
          if (!k.light) continue;
          const slide = 0.22 * Math.sin(d.tau * 0.35 + i * 2.1 + k.seed), breath = 0.7 + 0.3 * Math.sin(d.tau * 0.9 + i * 1.7) * Math.sin(d.tau * 0.37 + k.seed);
          borderEnds(d, k, k.y0 + d.rise - 0.2);
          _a.lerp(_b, 0.18 + slide); _b.lerp(_a, (0.18 - slide) / (0.82 - slide));
          k.light.pos.copy(_a); k.light.end.copy(_b);
          k.light.intensity = 4.5 * E * k.w * k.reveal * I * p.light * breath;
        }
        if (d.topLight) {
          d.topLight.pos.copy(d.centre).setY(p.base + d.rise + p.height * 0.55);
          d.topLight.intensity = 2.2 * E * I * p.light;
        }
        // the veil burns corruption away under each curtain (a negative splat: no glow painted)
        d.splatT -= dt;
        if (live && d.splatT <= 0 && E > 0.3) {
          d.splatT = 0.35;
          for (let i = 0; i < d.n; i++) {
            const k = d.cur[i];
            borderEnds(d, k, 0);
            SPLAT.x = _a.x; SPLAT.z = _a.z; SPLAT.x2 = _b.x; SPLAT.z2 = _b.z;
            SPLAT.corruption = -0.25 * E * k.reveal; SPLAT.seed = (c.seed + i * 13) % 100;
            fx.ground.splat(SPLAT);
          }
        }
        // precipitation from the lower borders
        if (live) for (let i = 0; i < d.n; i++) {
          const k = d.cur[i];
          borderEnds(d, k, k.y0 + d.rise);
          rain.pos.copy(_a); rain.p.copy(_b); rain.vel.set(0, -0.9, 0);
          rain.rate(90 * p.precipitation * E * k.w * k.reveal, dt);
        }
        // dummies under the veil are cleansed
        if (live && E > 0.3) for (const dm of fx.dummies) {
          const r = Math.hypot(dm.pos.x - d.centre.x, dm.pos.z - d.centre.z);
          if (r < p.length * 0.5) dm.status.corrupt = Math.max(0, dm.status.corrupt - dt * 0.9 * E);
        }
        // a gentle updraft lifts loose particles along the field lines
        if (d.vortex) { d.vortex.p[1] = 5 * E; d.vortex.p[2] = 1.4 * E; }
      },

      tick() {
        syncColors();
        const A0 = a0.array, A1 = a1.array, A2 = a2.array, A3 = a3.array, p = S.params;
        let m = 0;
        for (const d of ST) {
          if (!d.on || d.E < 0.002) continue;
          for (let i = 0; i < d.n && m < MAX_INST; i++) {
            const k = d.cur[i];
            if (k.reveal < 0.002) continue;
            const o = m * 4;
            A0[o] = k.c.x; A0[o + 1] = 0; A0[o + 2] = k.c.z; A0[o + 3] = k.L;
            A1[o] = d.axis.x; A1[o + 1] = d.axis.z; A1[o + 2] = k.y0 + d.rise; A1[o + 3] = k.H;
            A2[o] = k.seed; A2[o + 1] = 1.1 * p.fold * d.fold; A2[o + 2] = d.tau + i * 3.1; A2[o + 3] = d.drift + i * 5.3;
            A3[o] = d.E * k.w * p.intensity; A3[o + 1] = k.reveal; A3[o + 2] = d.fringe; A3[o + 3] = p.rays;
            m++;
          }
        }
        mat.uniforms.uAvVeil.value = 0.65 * p.veil;
        geo.instanceCount = m;
        mesh.visible = m > 0;
        if (m > 0) a0.needsUpdate = a1.needsUpdate = a2.needsUpdate = a3.needsUpdate = true;
      },
    };
  },
};
