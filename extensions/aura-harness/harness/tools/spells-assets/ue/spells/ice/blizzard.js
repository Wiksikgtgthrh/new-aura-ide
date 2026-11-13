import * as THREE from 'three';
import { COMMON_GLSL, NOISE_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING } from '../../vfx/common.js';

// Blizzard (wind + ice). Reference: whiteout and ground-blizzard footage (Antarctic katabatic storms,
// prairie blizzards): snow driven sideways in dense streaks at every depth, motion-blurred near the
// lens and soft far off; drift snow snaking along the ground in streams; gusts that thicken and thin
// the air; visibility collapsing to a bright, cold grey; frost building on the floor and the dummies.
// Nothing glows: it is all lit by the low sun (forward-scattered into the camera) and the sky.
//   streaks  createStreakField (exported; the shelved Sandstorm's grains used it too): N instanced flakes and no
//            sim. Hashed start points in a box are advected by the wind analytically and wrapped into
//            the box, drawn velocity-stretched over an exposure (long faint streaks near the lens,
//            short sharp ones far off) into the half-res WBOIT pass, lit like a medium.
//   air      the whiteout: an analytic medium in a back-faced cylinder round the storm (8 taps), a
//            plume stretched downwind and banded by gusts advected with the wind, plus the drift
//            layer: an exponential sheet on the floor torn into snaking streams.
//   world    a push gust (and a gentle vortex) drags every loose particle downwind; lit flakes and
//            spindrift veils, a little hail; the floor frosts from the heart out with drift streaks
//            in the lee, dummies ice over and are buffeted; the pool swirls; a flash-freeze as it dies.

const NB = 2;     // storms that can run at once (each owns an air cylinder and a streak field)
const TOP = 7.5;  // the storm's ceiling (m)
const TAU = Math.PI * 2;

// --- stateless streak field ----------------------------------------------------------------------
const SF_U = /* glsl */`
uniform vec4 uSF0;   // box centre xyz, clock s
uniform vec4 uSF1;   // box size xyz, advection m (integral of the wind speed)
uniform vec4 uSF2;   // wind direction xyz (y = fall), streak length m (speed x exposure)
uniform vec4 uSF3;   // diameter m, opacity, flutter m, speed spread 0..1
uniform vec4 uSF4;   // sun gain, sky gain, near blur m, near fade m
uniform vec4 uSF5;   // light desaturation 0..1 (an overcast storm greys the low sun), -, -, -
uniform vec3 uSFColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
`;
const SF_VERT = (gate) => FX_VERT_HEAD + COMMON_GLSL + NOISE_GLSL + SF_U + gate + /* glsl */`
out vec2 vUv;
out vec3 vCol;
out float vA;
out float vViewZ;
out float vSoft;
vec3 sfFlutter(float t, vec3 ph) {
  return uSF3.z * vec3(sin(t * 2.3 + ph.x * 6.283), 0.6 * sin(t * 3.7 + ph.y * 6.283), sin(t * 1.9 + ph.z * 6.283));
}
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = vec2(0.0); vCol = vec3(0.0); vA = 0.0; vViewZ = 1.0; vSoft = 0.0;
  float id = float(gl_InstanceID);
  vec3 h = hash31(id * 0.7131 + 0.5), g = hash31(id * 1.731 + 19.19);
  float k = 1.0 - uSF3.w + 2.0 * uSF3.w * g.x;          // this flake's share of the wind
  vec3 fl = sfFlutter(uSF0.w, g);
  vec3 p0 = h * uSF1.xyz + uSF2.xyz * (uSF1.w * k) + fl;
  vec3 lo = uSF0.xyz - 0.5 * uSF1.xyz;
  vec3 p = lo + mod(p0 - lo, uSF1.xyz);                  // wrapped into the (moving) box
  vec3 q = abs(p - uSF0.xyz) / (0.5 * uSF1.xyz);
  float gate = (1.0 - smoothstep(0.7, 1.0, max(q.x, max(q.y, q.z)))) * streakGate(p);
  if (gate < 0.004 || p.y < 0.01) return;
  vec3 tail = p - uSF2.xyz * (uSF2.w * k);
  vec3 hv = (viewMatrix * vec4(p, 1.0)).xyz, tv = (viewMatrix * vec4(tail, 1.0)).xyz;
  float viewZ = -hv.z;
  if (viewZ < uSF4.w * 0.3 || -tv.z < 0.05) return;
  float pxW = 2.0 * viewZ / (projectionMatrix[1][1] * uFxResolution.y);   // metres per FX pixel
  float r = 0.5 * uSF3.x * (0.55 + 0.9 * g.y);
  float w = max(r + uSF4.z * max(0.0, 1.6 - viewZ), 0.7 * pxW);           // defocus near the lens
  float aa = r / w;
  vec2 axis = tv.xy - hv.xy;
  float len = length(axis);
  vec2 dir = len > 1e-5 ? axis / len : vec2(1.0, 0.0), perp = vec2(-dir.y, dir.x);
  vec2 off = dir * (position.x < 0.0 ? -w : len + w) + perp * position.y * w;
  gl_Position = projectionMatrix * vec4(hv + vec3(off, 0.0), 1.0);
  vUv = vec2(position.x < 0.0 ? -1.0 : 1.0, position.y);
  vSoft = len / (len + 2.0 * w);
  vViewZ = viewZ;
  // the streak spreads the flake's coverage along its length (sqrt: long near streaks stay visible)
  vA = uSF3.y * gate * aa * sqrt(2.0 * w / (len + 2.0 * w)) * smoothstep(uSF4.w * 0.3, uSF4.w, viewZ);
  vec3 v = normalize(cameraPosition - p);
  vec3 L = uSunColor * (hgPhase(dot(uSunDir, -v), 0.6) * 4.0 * PI * uSF4.x * streakSun(p)) + uAmbient * uSF4.y;
  vCol = uSFColor * mix(L, vec3(dot(L, vec3(0.2126, 0.7152, 0.0722))), uSF5.x);
}`;
const SF_FRAG = FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + /* glsl */`
in vec2 vUv;
in vec3 vCol;
in float vA;
in float vViewZ;
in float vSoft;
void main() {
  if (vA <= 0.002) discard;
  float x = vUv.x * 0.5 + 0.5, e = 0.5 * (1.0 - vSoft);
  float dx = x < e ? (e - x) / max(e, 1e-3) : x > 1.0 - e ? (x - 1.0 + e) / max(e, 1e-3) : 0.0;
  float a = vA * exp(-(dx * dx + vUv.y * vUv.y) * 3.0) * mix(1.0, 0.45, x);
  fxOut(vCol, a, vec3(0.0), vec2(0.0), vViewZ);
}`;

// gateGLSL defines `float streakGate(vec3 p)` (0..1 presence) and `float streakSun(vec3 p)` (sun
// visibility) with whatever uniforms it declares (pass them in `uniforms`). Returns
// { mesh, u, set(count) }; fill u.uSF0..4 / uSFColor each frame.
export function createStreakField(fx, { max, gateGLSL, uniforms = {} }) {
  const plane = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = plane.index;
  geo.setAttribute('position', plane.getAttribute('position'));
  geo.instanceCount = 0;
  const u = {
    uSF0: { value: new THREE.Vector4() }, uSF1: { value: new THREE.Vector4(1, 1, 1, 0) }, uSF2: { value: new THREE.Vector4(1, 0, 0, 0.1) },
    uSF3: { value: new THREE.Vector4(0.01, 1, 0, 0) }, uSF4: { value: new THREE.Vector4(0.5, 1, 0, 0.4) }, uSF5: { value: new THREE.Vector4() }, uSFColor: { value: new THREE.Color(1, 1, 1) },
  };
  const mesh = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: SF_VERT(gateGLSL), fragmentShader: SF_FRAG,
    uniforms: { ...fx.U, ...uniforms, ...u }, ...FX_BLENDING, side: THREE.DoubleSide,
  }));
  mesh.frustumCulled = false;
  mesh.visible = false;
  fx.scenes.fx.add(mesh);
  return {
    mesh, u, max,
    // instance count at this tier (emission follows the quality tier and the auto ladder)
    set(n) {
      const c = Math.min(max, Math.round(n * fx.Q.emission * fx.Q.auto.emission));
      geo.instanceCount = c; mesh.visible = c > 0;
    },
  };
}

// --- the whiteout ----------------------------------------------------------------------------------
const AIR_U = /* glsl */`
uniform vec4 uBz0;   // centre x, z, radius m, clock s
uniform vec4 uBz1;   // wind dir x, z, advection m, envelope 0..1
uniform vec4 uBz2;   // air density 1/m, drift density 1/m, scale height m, gust 0..1
uniform vec4 uBz3;   // proxy radius m, top m, plume stretch downwind, seed
// storm frame: x along the wind, y across it, from the centre
vec2 bzFrame(vec3 p) { vec2 q = p.xz - uBz0.xy; return vec2(dot(q, uBz1.xy), q.x * uBz1.y - q.y * uBz1.x); }
// a round heart with a plume streaming downwind, 0..1
float bzShape(vec2 f, float r) { return 1.0 - smoothstep(0.4, 1.0, length(vec2(f.x > 0.0 ? f.x / uBz3.z : f.x, f.y)) / r); }
`;

// the proxy is a unit cylinder (y 0..1) scaled to (radius, top, radius): pass its centre and size on
const AIR_VERT = FX_VERT_HEAD + /* glsl */`
out vec3 vW;
flat out vec4 vCyl;   // centre x, z, radius, top
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vCyl = vec4(modelMatrix[3].x, modelMatrix[3].z, length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const AIR_FRAG = FX_FRAG_HEAD + '#define texture(s, p) textureLod(s, p, 0.0)\n' + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + AIR_U + /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uBzAir;     // snow albedo
uniform vec2 uBzLight;   // sun gain, sky gain
in vec3 vW;
flat in vec4 vCyl;
float bzAir(vec3 p) {
  vec2 f = bzFrame(p);
  float s = bzShape(f, 1.7 * uBz0.z);
  if (s <= 0.0) return 0.0;
  float y = max(p.y, 0.0);
  // gust bands: dense and thin sheets of driven snow streaming downwind
  float n = noise3(vec3((f.x - uBz1.z) * 0.035, y * 0.22 - uBz0.w * 0.02, f.y * 0.16) + uBz3.w);
  float gust = mix(1.0, 0.1 + 3.6 * n * n, uBz2.w);
  return uBz2.x * uBz1.w * s * gust * exp(-y / uBz2.z) * (1.0 - smoothstep(0.5 * uBz3.y, uBz3.y, y));
}
// drift streams on the floor, 0..1: torn by noise racing downwind, snaking across it
float bzDrift(vec2 xz) {
  vec2 f = bzFrame(vec3(xz.x, 0.0, xz.y));
  float s = bzShape(f, 2.0 * uBz0.z);
  if (s <= 0.0) return 0.0;
  // soft veils streaming along the wind (stretched ~4:1), snaking slowly, racing past
  float b = f.y + 0.6 * sin(f.x * 0.3 + uBz0.w * 0.9 + uBz3.w * 5.0);
  float n = noise3(vec3((f.x - 1.6 * uBz1.z) * 0.07, uBz0.w * 0.05, b * 0.28) + uBz3.w * 1.7);
  return s * smoothstep(0.3, 0.75, n);
}
void main() {
  vec3 o = cameraPosition, rd = normalize(vW - o);
  float cosV = dot(rd, -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float tS = sceneViewZ() / cosV, t0 = 0.0, t1 = tS;
  vec2 oc = o.xz - vCyl.xy;
  float A = dot(rd.xz, rd.xz), B = dot(oc, rd.xz), C = dot(oc, oc) - vCyl.z * vCyl.z;
  if (A > 1e-6) {
    float disc = B * B - A * C;
    if (disc <= 0.0) discard;
    float sq = sqrt(disc);
    t0 = max((-B - sq) / A, 0.0); t1 = min(t1, (-B + sq) / A);
  } else if (C > 0.0) discard;
  if (rd.y > 1e-4) t1 = min(t1, (vCyl.w - o.y) / rd.y);
  else if (rd.y < -1e-4) t0 = max(t0, (vCyl.w - o.y) / rd.y);
  else if (o.y > vCyl.w) discard;
  if (t1 <= t0) discard;
  // an overcast storm: the low sun comes through greyed and diffused, the sky light is cold
  vec3 sunC = mix(uSunColor, vec3(dot(uSunColor, vec3(0.2126, 0.7152, 0.0722))), 0.85);
  vec3 sunL = sunC * (hgPhase(dot(uSunDir, rd), 0.4) * 4.0 * PI * uBzLight.x);
  vec3 sky = vec3(dot(uAmbient, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.88, 0.95, 1.1) * uBzLight.y;
  vec3 col = vec3(0.0);
  float T = 1.0, zs = 0.0, ws = 0.0, dt = (t1 - t0) / 8.0, sP = bzAir(o + rd * t0);
  for (int i = 1; i <= 8; i++) {
    float t = t0 + dt * float(i);
    float s = bzAir(o + rd * t), sg = 0.5 * (s + sP);
    sP = s;
    if (sg < 1e-5) continue;
    float a = T * (1.0 - exp(-sg * dt));
    // the sun dims through the storm's bulk; the sky light reaches everywhere, a little less deep in
    col += a * (sunL * exp(-sg * 7.0) + sky * (0.55 + 0.45 * exp(-sg * 4.0)));
    zs += a * (t - 0.5 * dt); ws += a;
    T *= exp(-sg * dt);
  }
  // the drift sheet where the ray lands on the floor inside the storm
  if (tS <= t1 + 0.05 && rd.y < -0.01 && o.y + rd.y * tS < 0.1) {
    float L = min(0.25 / -rd.y, 2.5);
    float d = 0.6 * bzDrift((o + rd * tS).xz) + 0.4 * bzDrift((o + rd * (tS - L)).xz);
    float a = T * (1.0 - exp(-uBz2.y * uBz1.w * d * L));
    col += a * (sunL * 0.5 + sky * 1.35);
    zs += a * tS; ws += a;
    T *= 1.0 - a / max(T, 1e-4);
  }
  float alpha = 1.0 - T;
  if (alpha < 0.003) discard;
  fxOut(uBzAir * col / max(alpha, 1e-4), alpha, vec3(0.0), vec2(0.0), (ws > 0.0 ? zs / ws : t0) * cosV);
}`;

// the snow field's presence follows the air: thick in the heart, a plume downwind
const SNOW_GATE = AIR_U + /* glsl */`
float streakGate(vec3 p) {
  float s = sqrt(bzShape(bzFrame(p), 2.6 * uBz0.z));   // blown snow reaches well past the heart
  return uBz1.w * s * (0.35 + 0.65 * exp(-p.y / (1.6 * uBz2.z))) * (1.0 - smoothstep(0.6 * uBz3.y, uBz3.y, p.y));
}
float streakSun(vec3 p) { return 1.0 - 0.45 * uBz1.w * bzShape(bzFrame(p), 1.6 * uBz0.z); }
`;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export default {
  id: 'blizzard', name: 'Blizzard', element: 'ice', order: 20, hue: '#dff4ff',
  shape: 'area',
  params: {
    radius: 4, duration: 6, strength: 1, wind: 10, angle: 25, snow: 1, visibility: 1, spindrift: 1, streaks: 1, hail: 1,
    refraction: 1, frost: 1, freeze: 1, air: '#dcecff', glow: '#86d2ff',
  },
  ranges: {
    radius: [2, 6, 0.01], duration: [2, 12, 0.1], strength: [0.2, 2.5, 0.01], wind: [3, 20, 0.1], angle: [-90, 90, 1],
    snow: [0, 3, 0.01], visibility: [0, 3, 0.01], spindrift: [0, 3, 0.01], streaks: [0, 3, 0.01], hail: [0, 3, 0.01],
    refraction: [0, 3, 0.01], frost: [0, 2, 0.01], freeze: [0, 2, 0.01],
  },
  presets: {
    whiteout: { radius: 5, snow: 1.8, visibility: 1.9, spindrift: 2, streaks: 0.8, hail: 0.4, air: '#eef6ff' },
    'polar vortex': { strength: 1.8, wind: 15, streaks: 1.6, visibility: 1.2, spindrift: 1.4, air: '#c8e2ff', glow: '#4f9dff' },
    sleet: { hail: 2.6, snow: 0.7, visibility: 0.7, spindrift: 0.6, strength: 1.3, air: '#d2e6f0', glow: '#9fd8e6' },
  },
  timing: { charge: 1.0, impact: 0.35, linger: 7.6 },
  kinds: {
    // driven snow near the heart: small lit flakes swept round by the gusts (white albedo, lit by the
    // sun, the sky and the spell lights: peach on the sun side, blue in shadow)
    flake: { style: 'media', drag: 1.2, gravity: 1.1, curl: 1.1, curlScale: 0.45, forceResponse: 3, restitution: 0, friction: 0.9, life: [1.6, 3], size: [0.035, 0.025], color: ['#ffffff', '#e8f4ff'], alpha: [1, 0.85], density: 4, erosion: 0, lightResponse: 1.2, fadeIn: 0.2, fadeOut: 0.3 },
    // spindrift: thin lit veils of blown snow hugging the floor
    drift: { style: 'media', drag: 0.6, gravity: 0.15, curl: 0.9, curlScale: 0.3, forceResponse: 2.5, restitution: 0, friction: 0.05, life: [0.9, 1.7], size: [0.25, 0.8], sizePow: 0.6, color: ['#eef4fa', '#d6e2ee'], alpha: [0.16, 0], density: 1.6, erosion: 0.65, lightResponse: 1, fadeIn: 0.25, fadeOut: 0.45 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const E = {
      gather: P.emitter('wind.streak', { shape: 'shell', radius: 1.7, spread: 0.4, radial: -3.5 }),
      mote: P.emitter('ice.mote', { shape: 'shell', radius: 1.3, spread: 0.1, radial: -2.2 }),
      snow: P.emitter('blizzard.flake', { shape: 'disk', radius: 3, spread: 0.9 }),
      drift: P.emitter('blizzard.drift', { shape: 'line', radius: 0.3, spread: 0.5 }),
      hail: P.emitter('ice.chip', { shape: 'disk', radius: 3, spread: 1.2 }),
      glint: P.emitter('ice.glint', { shape: 'disk', radius: 3, spread: 1.5 }),
    };

    // per storm slot: the air cylinder and the streak field share one set of storm uniforms
    const slots = [];
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 40, 1, false).translate(0, 0.5, 0);
    for (let i = 0; i < NB; i++) {
      const su = {
        uBz0: { value: new THREE.Vector4() }, uBz1: { value: new THREE.Vector4(1, 0, 0, 0) },
        uBz2: { value: new THREE.Vector4(0.1, 1, 2, 1) }, uBz3: { value: new THREE.Vector4(10, 7, 2, 0) },
      };
      const air = new THREE.Mesh(cyl, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: AIR_VERT, fragmentShader: AIR_FRAG, ...FX_BLENDING,
        side: THREE.BackSide, depthTest: false, depthWrite: false,
        uniforms: { ...fx.U, ...su, uBzAir: { value: new THREE.Color(1, 1, 1) }, uBzLight: { value: new THREE.Vector2(0.22, 1.3) } },
      }));
      air.frustumCulled = false; air.visible = false;
      fx.scenes.fx.add(air);
      const field = createStreakField(fx, { max: 20000, gateGLSL: SNOW_GATE, uniforms: su });
      slots.push({ busy: false, su, air, field });
    }

    const state = Array.from({ length: 16 }, () => ({
      slot: null, push: null, vortex: null, light: null, g: new THREE.Vector3(), W: new THREE.Vector3(1, 0, 0),
      age: 0, env: 0, adv: 0, clock: 0, gust: 1, seedF: 0, nextSplat: 0, nextHit: 0, nextLee: 0, frozeAll: false,
    }));

    const air = new THREE.Color(), glow = new THREE.Color(), tmp = new THREE.Color(), _white = new THREE.Color(1, 1, 1);
    const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    // the snow takes the air colour (setKind keeps the arrays, so one per kind)
    const look = { air: '' }, flakeCol = ['', ''], driftCol = ['', ''];
    function applyLook(p) {
      air.set(p.air); glow.set(p.glow);
      if (look.air === p.air) return;
      look.air = p.air;
      flakeCol[0] = `#${tmp.set(p.air).lerp(_white, 0.6).getHexString()}`; flakeCol[1] = p.air;
      P.setKind('blizzard.flake', { color: flakeCol });
      driftCol[0] = `#${tmp.set(p.air).lerp(_white, 0.3).getHexString()}`; driftCol[1] = `#${tmp.set(p.air).multiplyScalar(0.86).getHexString()}`;
      P.setKind('blizzard.drift', { color: driftCol });
    }
    const SPL = { x: 0, z: 0, x2: 0, z2: 0, radius: 1, frost: 0, pattern: 'radial', seed: 0, width: 0 };
    function splat(x, z, radius, frost, pattern, seed, width = 0, x2 = x, z2 = z) {
      SPL.x = x; SPL.z = z; SPL.x2 = x2; SPL.z2 = z2; SPL.radius = radius; SPL.frost = frost; SPL.pattern = pattern; SPL.seed = seed % 100; SPL.width = width;
      fx.ground.splat(SPL);
    }

    function releaseAll(st) {
      if (st.slot) { st.slot.busy = false; st.slot.air.visible = false; st.slot.field.set(0); st.slot = null; }
      st.push?.release(); st.push = null;
      st.vortex?.release(); st.vortex = null;
      st.light?.release(); st.light = null;
    }

    // storm uniforms for this frame: e = how much storm there is (0..1)
    function frame(st, p, dt, e) {
      const s = st.slot;
      if (!s) return;
      const g = st.g, W = st.W, R = p.radius, sp = p.strength;
      // gusts: the wind surges and slackens (two slow beats and a sharper one)
      st.gust = 0.78 + 0.22 * Math.sin(st.clock * 1.13 + st.seedF * 9) * Math.sin(st.clock * 0.41 + 1) + 0.18 * Math.max(0, Math.sin(st.clock * 2.7 + st.seedF * 4)) ** 6;
      const v = p.wind * sp * st.gust * (0.25 + 0.75 * e);
      st.adv += v * dt; st.clock += dt;
      const u = s.su, rh = 3.3 * R + 1;   // the proxy cylinder: round the heart and the plume downwind
      u.uBz0.value.set(g.x, g.z, R, st.clock);
      u.uBz1.value.set(W.x, W.z, st.adv, e);
      u.uBz2.value.set(0.09 * p.visibility * (0.7 + 0.5 * st.gust), 1.4 * p.spindrift, 4.5, 1);
      u.uBz3.value.set(0, TOP, 2.2, st.seedF * 13);
      s.air.position.set(g.x + W.x * 1.2 * R, 0, g.z + W.z * 1.2 * R);
      s.air.scale.set(rh, TOP, rh);
      s.air.material.uniforms.uBzAir.value.copy(air);
      s.air.visible = e > 0.01;
      // the snow: a box reaching from the lens towards the storm (dense near streaks wherever the
      // camera is; the gate keeps them in the storm); the flakes ride the wind with a little fall
      const f = s.field, fu = f.u, cam = fx.camera.position;
      const cx = g.x + W.x * 1.1 * R - cam.x, cz = g.z + W.z * 1.1 * R - cam.z, cd = Math.hypot(cx, cz), ck = cd > 5 ? 5 / cd : 1;
      fu.uSF0.value.set(cam.x + cx * ck, 0.5 * TOP, cam.z + cz * ck, st.clock);
      fu.uSF1.value.set(20, TOP, 20, st.adv);
      fu.uSF2.value.set(W.x, -0.16, W.z, v * (1 / 40) * p.streaks + 0.01);
      fu.uSF3.value.set(0.02, 1, 0.12, 0.3);
      fu.uSF4.value.set(0.4, 2.6, 0.03 * p.refraction, 0.3);
      fu.uSF5.value.set(0.85, 0, 0, 0);
      fu.uSFColor.value.copy(air).lerp(_white, 0.75);
      f.set(e > 0.01 ? 16000 * p.snow : 0);
    }

    // --- charge: the orb drinks in wind and cold; over the target the wind gets up ---
    function charge(c, st, p, dt) {
      const T = c.durations.charge, k = Math.min(1, c.t / T), f = c.from, g = st.g, R = p.radius;
      E.gather.pos.copy(f); E.gather.rate(260 * p.streaks * (0.3 + 0.7 * k), dt);
      if (k < 0.8) { E.mote.pos.copy(f); E.mote.vel.set(0, 0, 0); E.mote.rate(600 * (1 - k / 0.8), dt); }
      const e = 0.3 * k * k;
      st.env = e;
      gusts(st, p, e, R);
      // the first spindrift lifts off the floor upwind
      if (driftLine(st, R, 1.1)) { E.drift.vel.set(st.W.x * 4, 0.3, st.W.z * 4); E.drift.size = 0.8; E.drift.rate(30 * p.spindrift * k, dt); }
      if (st.light) { st.light.pos.set(g.x, 1.6, g.z); st.light.intensity = 1.5 * k; }
      frame(st, p, dt, e);
    }

    // a line across the wind, upwind of the heart, for spindrift (endpoints into E.drift.pos / .p)
    function driftLine(st, R, back) {
      const g = st.g, W = st.W;
      const cx = g.x - W.x * R * back, cz = g.z - W.z * R * back;
      E.drift.pos.set(cx + W.z * R, 0.12, cz - W.x * R);
      E.drift.p.set(cx - W.z * R, 0.12, cz + W.x * R);
      return true;
    }

    // the push gust and the vortex follow the storm
    function gusts(st, p, e, R) {
      const g = st.g, W = st.W, sp = p.strength;
      if (st.push) {
        st.push.pos.set(g.x - W.x * 2.2 * R, 0.8, g.z - W.z * 2.2 * R); st.push.dir.copy(W);
        st.push.p[0] = p.wind * sp * st.gust; st.push.p[1] = 2.4 * R; st.push.p[2] = 6 * R; st.push.p[3] = 1.6 * e;
      }
      const V = st.vortex;
      if (V) { V.pos.copy(g); V.dir.copy(_up); V.p[0] = 0.45 * R; V.p[1] = 10 * R * sp * e; V.p[2] = 0.4 * e; V.p[3] = 0.6 * e; V.w = 5; }
    }

    // --- the storm ---
    function storm(c, st, p, dt) {
      const g = st.g, W = st.W, R = p.radius, e = st.env, sp = p.strength;
      const k = Math.min(1, st.age / Math.max(p.duration, 0.1));   // how far the freeze has got
      gusts(st, p, e, R);
      // lit flakes swirling in the heart, spindrift veils racing over the floor, a little hail
      E.snow.pos.set(g.x - W.x * 0.5 * R, 0.6 + 3.2 * fx.rand(), g.z - W.z * 0.5 * R); E.snow.radius = 0.9 * R;
      E.snow.vel.set(W.x * 5, -0.8, W.z * 5); E.snow.rate(700 * p.snow * e, dt);
      if (driftLine(st, R, 0.9)) {
        E.drift.vel.set(W.x * p.wind * 0.8, 0.25, W.z * p.wind * 0.8); E.drift.size = 0.7 + 0.4 * fx.rand();
        E.drift.rate(45 * p.spindrift * e * st.gust, dt);
      }
      E.hail.pos.set(g.x, 4.2, g.z); E.hail.radius = 0.9 * R; E.hail.vel.set(W.x * 3, -7, W.z * 3); E.hail.size = 0.6;
      E.hail.rate(8 * p.hail * e, dt);
      E.glint.pos.set(g.x, 3.0, g.z); E.glint.radius = 0.9 * R; E.glint.vel.set(W.x * 4, -2, W.z * 4);
      E.glint.rate(24 * p.hail * e, dt);

      // the floor freezes from the heart outwards (the frost potential at the centre rises with the
      // storm's age, so the field's front creeps out), rime lands inside, and snow streaks in the lee
      if (p.frost > 0 && st.age >= st.nextSplat && e > 0.2) {
        st.nextSplat = st.age + 0.3;
        splat(g.x, g.z, 1, (0.3 + 0.4 * Math.max(0, R * (0.25 + 0.75 * k) - 0.6)) * p.frost, 'radial', c.seed + 3);
        const a = fx.rand() * TAU, r = R * Math.sqrt(fx.rand()) * (0.3 + 0.7 * k);
        const x = g.x + Math.cos(a) * r, z = g.z + Math.sin(a) * r, len = 1.2 + 2.5 * fx.rand();
        splat(x, z, 0.9, 1.1 * p.frost * e, 'line', c.seed + 7 + (st.nextSplat * 10 | 0), 0.12 + 0.12 * fx.rand(), x + W.x * len, z + W.z * len);
      }
      // the dummies inside ice over (deeper at the heart), are buffeted downwind, and snow drifts in their lee
      st.nextHit -= dt;
      const hit = st.nextHit <= 0;
      if (hit) st.nextHit = 0.35;
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i], dx = dm.pos.x - g.x, dz = dm.pos.z - g.z, d = Math.hypot(dx, dz);
        if (d > 1.6 * R) continue;
        const near = 1 - 0.45 * Math.min(1, d / R);
        if (p.freeze > 0) dm.status.frozen = Math.max(dm.status.frozen, Math.min(1, k * p.freeze * near * 1.2));
        if (hit && e > 0.1) dm.hit(_b.set(W.x + 0.3 * (fx.rand() - 0.5), 0, W.z + 0.3 * (fx.rand() - 0.5)), 0.2 * e * sp * st.gust * near);
        if (p.frost > 0 && st.age >= st.nextLee && e > 0.3) splat(dm.pos.x + W.x * 0.4, dm.pos.z + W.z * 0.4, 0.5, 1.2 * p.frost, 'line', c.seed + 31 + i, 0.18, dm.pos.x + W.x * 2.4, dm.pos.z + W.z * 2.4);
      }
      if (st.age >= st.nextLee) st.nextLee = st.age + 0.9;
      // the pool's ripple sim swirls under the storm
      const pool = fx.ARENA.pool;
      const qx = Math.max(Math.abs(g.x - pool.center.x) - pool.half.x, 0), qz = Math.max(Math.abs(g.z - pool.center.y) - pool.half.y, 0);
      const pd = Math.hypot(qx, qz), reach = 1.6 * R;
      if (pd < reach && fx.pool) {
        const cx = Math.min(Math.max(g.x, pool.center.x - pool.half.x), pool.center.x + pool.half.x);
        const cz = Math.min(Math.max(g.z, pool.center.y - pool.half.y), pool.center.y + pool.half.y);
        fx.pool.swirl(cx, cz, 2.0 * e * sp * (1 - pd / reach));
      }
      // a faint cold fill inside the storm: sky light bounced round in the snow
      if (st.light) { st.light.pos.set(g.x, 1.4, g.z); st.light.range = 1.8 * R + 2; st.light.intensity = 2.5 * e; }
      frame(st, p, dt, e);
    }

    // --- as the wind dies, everything still inside snaps to ice ---
    function flashFreeze(c, st, p) {
      const g = st.g, R = p.radius;
      st.frozeAll = true;
      if (p.frost > 0) {
        splat(g.x, g.z, R * 0.95, 1.2 * p.frost, 'noise', c.seed + 19);
        splat(g.x + st.W.x * R * 0.5, g.z + st.W.z * R * 0.5, R * 1.1, 1.0 * p.frost, 'noise', c.seed + 23);
      }
      fx.impacts.add('frost', _a.set(g.x, 0.8, g.z), R * 1.3, 1, 7, glow);
      E.glint.pos.set(g.x, 0.15, g.z); E.glint.radius = R; E.glint.vel.set(0, 1.6, 0); E.glint.burst(220 * p.hail);
      for (const dm of fx.dummies) if (Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z) < 1.2 * R && p.freeze > 0) dm.status.frozen = 1;
      fx.rig.shake(0.15, 14);
    }

    return {
      onParam(k) { if (k === 'air' || k === 'glow') applyLook(S.params); },

      phase(c, name) {
        const p = S.params, st = state[c.index];
        applyLook(p);
        if (name === 'charge') {
          releaseAll(st);
          c.durations.linger = p.duration + 1.6;
          st.g.set(c.to.x, 0, c.to.z);
          // the wind blows across the cast, swung towards the caster's side by `angle`
          let dx = c.to.x - c.from.x, dz = c.to.z - c.from.z;
          const l = Math.hypot(dx, dz) || 1, an = p.angle * Math.PI / 180;
          dx /= l; dz /= l;
          st.W.set(-dz * Math.cos(an) - dx * Math.sin(an), 0, dx * Math.cos(an) - dz * Math.sin(an)).normalize();
          st.age = 0; st.env = 0; st.adv = 0; st.clock = 0; st.gust = 1; st.nextSplat = 0; st.nextHit = 0; st.nextLee = 0.6; st.frozeAll = false;
          st.seedF = (c.seed % 997) / 997;
          st.slot = null;
          for (const s of slots) if (!s.busy) { st.slot = s; s.busy = true; break; }
          st.push = fx.forces.acquire();
          if (st.push) { st.push.type = 5; st.push.p[3] = 0; }
          st.vortex = fx.forces.acquire();
          if (st.vortex) { st.vortex.type = 1; st.vortex.p[1] = 0; }
          st.light = fx.lights.acquire();
          if (st.light) { st.light.range = 9; st.light.intensity = 0; st.light.color.copy(glow).lerp(_white, 0.55); st.light.shadow = false; }
        } else if (name === 'release') {
          fx.rig.shake(0.08, 9);
        } else if (name === 'impact') {
          // the storm hits: a gust front of snow rolls over the target, frost rings the heart
          st.age = 0;
          const g = st.g, R = p.radius, W = st.W;
          E.snow.pos.set(g.x - W.x * R, 1.2, g.z - W.z * R); E.snow.radius = R; E.snow.vel.set(W.x * 9, 0.5, W.z * 9); E.snow.burst(500 * p.snow);
          if (driftLine(st, R, 1.0)) { E.drift.vel.set(W.x * 10, 0.6, W.z * 10); E.drift.size = 1.1; E.drift.burst(60 * p.spindrift); }
          if (p.frost > 0) splat(g.x, g.z, 0.55 * R, 0.9 * p.frost, 'noise', c.seed + 5);
          fx.impacts.add('frost', _a.set(g.x, 0.8, g.z), R * 1.1, 0.5, p.duration + 3, glow);
          for (const dm of fx.dummies) if (Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z) < 1.4 * R) dm.hit(_b.copy(W).setY(0.1), 0.45 * p.strength);
          fx.rig.shake(0.25, 7);
          if (!fx.reduced) fx.rig.punch(0.6, 0.12);
        } else if (name === 'done') releaseAll(st);
      },

      update(c, dt) {
        const p = S.params, st = state[c.index];
        if (c.phase === 'charge') { st.age += dt; charge(c, st, p, dt); return; }
        st.age += dt;
        const L = c.durations.linger;
        // the storm comes in hard on impact, holds, and dies over the last 1.6 s
        st.env = c.phase === 'linger' ? 1 - smooth(L - 1.6, L - 0.1, c.t) : 0.3 + 0.7 * smooth(0, 0.35, c.t);
        if (c.phase === 'linger' && !st.frozeAll && c.t >= L - 1.4) flashFreeze(c, st, p);
        storm(c, st, p, dt);
      },
    };
  },
};
