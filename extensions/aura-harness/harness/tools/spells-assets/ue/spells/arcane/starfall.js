import * as THREE from 'three';
import { U, COMMON_GLSL, LINES_BLENDING, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING, ARENA, arenaSDF } from '../../vfx/common.js';
import { instanced } from '../../vfx/Ribbons.js';

// Starfall (Arcane hero). A pocket of night opens over the target: a raymarched lens of dark
// nebula (absorbing, albedo 0 so it skips lighting) whose log-spiral arms unfurl from the centre
// and turn with differential rotation, sprinkled with twinkling stars. An arcane circle draws
// itself on the floor and motes rise from its rim. Then stars ignite inside the canopy and streak
// down in parallel (one radiant per cast, like a meteor shower): each a 4-point diffraction-spike
// head sprite, a full-res white-hot train with glitter cells and a half-res soft glow train,
// shedding sparkles, carrying a shadowed light. Each lands in a starburst flare with sparks,
// stardust that settles and paints glow, a ground shock ring and a glow + corruption ring (violet
// veins that outlive the glow). The last and largest star hits the target: a nova, a push shell
// on loose particles, knockback, flash, hitstop. Stars stop on anything solid (arenaSDF), ripple
// an Aegis they hit (arcane inst.hit) and the pool.

const TAU = Math.PI * 2;
const MAX_CASTS = 16, MAX_STARS = 25, MAX_SKY = 150, MAX_SKY_SPRITES = 300, MAX_SPRITES = 128, MAX_POPS = 48, MAX_TRAILS = 32;
const SLOTS = 3;   // shadowed lights per cast, handed from star to star

// --- canopy: a lens of night sky (volume) --------------------------------------------------------
const CANOPY_GLSL = /* glsl */`
uniform vec4 uSky;     // grow 0..1 (revealed radius), dissolve 0..1, emission, spin (rad)
uniform vec4 uSky2;    // arms, twist, night density (1/m), seed
uniform vec4 uSky3;    // impact pulse, -, -, -
uniform vec3 uSkyCore;
uniform vec3 uSkyColor;
uniform vec3 uSkyGlow;
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  sigma = 0.0; albedo = vec3(0.0); emission = vec3(0.0);
  float e2 = dot(pl, pl);
  if (e2 >= 1.0) return;
  float r = length(pl.xz), y = pl.y;
  float reveal = smoothstep(uSky.x * 1.25, uSky.x * 1.25 - 0.35, r);
  if (reveal <= 0.0) return;
  // differential rotation: the core turns faster than the rim (a whirlpool of night)
  float spin = uSky.w * (0.45 + 0.75 / (0.35 + r));
  float c = cos(spin), s = sin(spin);
  vec2 q = mat2(c, -s, s, c) * pl.xz;
  float arms = 0.5 + 0.5 * cos(atan(q.y, q.x) * uSky2.x + log(max(r, 0.03)) * uSky2.y);
  vec3 np = vec3(q * uVolScale.x * 0.085, y * uVolScale.y * 0.08) + uSky2.w;
  float n1 = noise3(np), n2 = noise3(np * 2.7 + 0.31);
  float n = n1 * 0.65 + n2 * 0.35;
  // a lens, thickest in the middle, its rim frayed by the noise; dissolve eats the thin parts first
  float body = smoothstep(1.0, 0.78, sqrt(e2) + (n - 0.5) * 0.45);
  float keep = smoothstep(uSky.y * 1.3 - 0.25, uSky.y * 1.3, n + 0.3 * (1.0 - r));
  float d = body * reveal * keep;
  if (d <= 0.0) return;
  sigma = uSky2.z * d * (0.6 + 0.6 * n);
  // a real night: near-black airglow, the arms a faint Milky-Way band of unresolved star clouds
  // (granular, mostly blue-white, a hint of the spell's colour) cut by dark dust lanes
  float lane = arms * (0.25 + 1.2 * n);
  float grain = noise3(np * 7.3 + 1.7);
  float wisp = (smoothstep(0.55, 1.0, lane) + smoothstep(0.3, 0.9, lane) * 0.15) * (0.35 + 1.1 * grain * grain);
  float core = exp(-r * r * 22.0) * exp(-y * y * 4.0);
  vec3 col = mix(vec3(0.62, 0.68, 0.95), mix(uSkyGlow, uSkyColor, smoothstep(0.6, 1.2, lane)), 0.4);
  float rim = body * (1.0 - body) * 4.0 * reveal;
  emission = ((vec3(0.004, 0.006, 0.02) + col * wisp * 0.42 * (0.3 + 0.7 * smoothstep(1.0, 0.1, r)) + mix(uSkyCore, vec3(1.0, 0.9, 0.75), 0.5) * core * 0.7) * d
           + mix(uSkyGlow, uSkyColor, 0.5) * rim * 0.1) * uSky.z * (1.0 + 1.2 * uSky3.x);
}`;

// --- canopy stars: half-res emission sprites in the fx pass (the night's revealage would hide
// lines-pass stars inside it) ---------------------------------------------------------------------
const SKY_VERT = /* glsl */`
in vec4 aA;   // centre, size m
in vec4 aB;   // rgb * intensity, -
out vec2 vQ;
out vec3 vCol;
out float vViewZ;
void main() {
  vQ = vec2(0.0); vCol = vec3(0.0); vViewZ = 1.0;
  if (aA.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 view = viewMatrix * vec4(aA.xyz, 1.0);
  float viewZ = max(-view.z, 0.05);
  float pxW = 2.0 * viewZ / (projectionMatrix[1][1] * uFxResolution.y);
  float s = max(aA.w, 3.0 * pxW), aa = aA.w / s;
  vQ = position.xy;
  view.xy += position.xy * s;
  gl_Position = projectionMatrix * view;
  vCol = aB.rgb * aa * aa;
  vViewZ = viewZ;
}`;
const SKY_FRAG = /* glsl */`
in vec2 vQ;
in vec3 vCol;
in float vViewZ;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 >= 1.0) discard;
  vec2 a = abs(vQ);
  float sp = exp(-a.y * 16.0) * pow(1.0 - a.x, 3.0) + exp(-a.x * 16.0) * pow(1.0 - a.y, 3.0);
  float e = 1.0 - r2;
  fxOut(vec3(0.0), 0.0, vCol * (exp(-r2 * 30.0) * 1.5 + sp * 0.4) * e * e, vec2(0.0), vViewZ);
}`;

// --- sprites: star heads and impact flares (one instanced lines draw) -----------------------------
const SPRITE_VERT = /* glsl */`
in vec4 aA;   // centre, size m (0 = dead)
in vec4 aB;   // rgb * intensity, type: [0,1) falling star (spin phase), [1,2] flare (1 + age)
out vec2 vQ;
out vec3 vCol;
out float vT;
void main() {
  vQ = vec2(0.0); vCol = vec3(0.0); vT = 0.0;
  if (aA.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 view = viewMatrix * vec4(aA.xyz, 1.0);
  float viewZ = max(-view.z, 0.05);
  float pxW = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float s = max(aA.w, 6.0 * pxW), aa = aA.w / s;   // never under 6 px: keep the energy instead
  float rot = aB.w < 1.0 ? (aB.w - 0.5) * 0.5 : 0.0;
  vec2 cs = vec2(cos(rot), sin(rot));
  vQ = mat2(cs.x, cs.y, -cs.y, cs.x) * position.xy;
  view.xy += position.xy * s;
  gl_Position = projectionMatrix * view;
  vCol = aB.rgb * aa * aa * smoothstep(0.2, 0.8, viewZ);
  vT = aB.w;
}`;

const SPRITE_FRAG = /* glsl */`
in vec2 vQ;
in vec3 vCol;
in float vT;
out vec4 fragColor;
// a thin cross whose energy falls off along each arm (diffraction spikes)
float spikes(vec2 q, float w, float p) {
  vec2 a = abs(q);
  return exp(-a.y * w) * pow(max(1.0 - a.x, 0.0), p) + exp(-a.x * w) * pow(max(1.0 - a.y, 0.0), p);
}
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 >= 1.0) discard;
  vec3 white = vec3(max(vCol.r, max(vCol.g, vCol.b)));
  vec2 dq = mat2(0.7071, 0.7071, -0.7071, 0.7071) * vQ;
  vec3 col;
  if (vT < 1.0) {
    // falling star: white-hot core, halo, long spikes and short diagonals
    float core = exp(-r2 * 900.0), inner = exp(-r2 * 110.0);
    float halo = exp(-r2 * 16.0) * 0.3 + exp(-sqrt(r2) * 7.0) * 0.1;
    float sp = spikes(vQ, 150.0, 3.0) + 0.4 * spikes(dq * 1.9, 170.0, 4.0);
    col = white * (core * 3.0 + inner * 0.7) + vCol * (inner + halo + sp * 0.7);
  } else {
    // impact flare (age x): a blinding core that collapses, an expanding ring, spikes that shrink
    float x = clamp(vT - 1.0, 0.0, 1.0), f = 1.0 - x, r = sqrt(r2);
    float y = (r - 0.06 - 0.8 * x) / (0.02 + 0.07 * x);
    float ring = exp(-y * y) * f * f;
    float fl = exp(-r2 * (40.0 + 260.0 * x)) * f * f * f;
    float L = 0.3 + 0.7 * f;
    float sp = (spikes(vQ / L, 130.0, 2.5) + 0.45 * spikes(dq * 1.6 / L, 150.0, 3.5)) * f * f;
    col = white * fl * 2.5 + vCol * (ring * 1.3 + fl * 2.0 + sp * 0.9 + exp(-r2 * 6.0) * 0.12 * f);
  }
  float edge = 1.0 - r2;
  col *= edge * edge;
  if (uDebug > 0.5 && uDebug < 1.5) col = vec3(0.04, 0.012, 0.004);
  fragColor = vec4(col, 1.0);
}`;

// --- trains: straight analytic ribbons, head (t = 0) to tail -------------------------------------
// p0 = head, width; p1 = tail, -; p2 = seed, length m, -, -
const TRAIN_PATH = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  width = p0.w * pow(1.0 - t, 1.1);
  return mix(p0.xyz, p1.xyz, t);
}`;
const TRAIN_UNIFORMS = /* glsl */`
uniform vec3 uSfCore;
uniform vec3 uSfColor;
uniform vec3 uSfGlow;
`;
const TRAIN_CORE = TRAIN_UNIFORMS + /* glsl */`
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
  float t = r.uv.x, y = r.uv.y, s = t * r.p2.y;
  vec3 c = mix(uSfCore, uSfColor, smoothstep(0.02, 0.3, t));
  c = mix(c, uSfGlow, smoothstep(0.4, 1.0, t));
  float core = exp(-y * y * 9.0), soft = exp(-y * y * 2.2) * 0.3;
  float fall = pow(1.0 - t, 2.4) + 0.25 * exp(-t * 30.0);
  // glitter: sparse cells along the train flash on and off
  float g = s * 6.0 + r.p2.x, cell = floor(g);
  float on = step(0.76, hash11(cell * 1.37 + floor(uTime * 18.0 + hash11(cell + 3.1) * 9.0)));
  float gx = (fract(g) - 0.5) * 3.0;
  float sp = on * exp(-gx * gx) * exp(-y * y * 3.0) * (1.0 - t);
  return r.color * (c * (core + soft) * fall + uSfCore * sp * 1.6);
}`;
const TRAIN_GLOW = TRAIN_UNIFORMS + /* glsl */`
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
  float t = r.uv.x, y = r.uv.y;
  vec3 c = mix(uSfColor, uSfGlow, smoothstep(0.05, 0.8, t));
  float g = max(exp(-y * y * 3.5) - 0.03, 0.0);
  float k = 1.0 - t;
  return r.color * c * g * k * k * k;
}`;

// module scratch (nothing is allocated after create)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const sstep = THREE.MathUtils.smoothstep;
const inPool = (x, z) => Math.abs(x - ARENA.pool.center.x) < ARENA.pool.half.x && Math.abs(z - ARENA.pool.center.y) < ARENA.pool.half.y;

export default {
  id: 'starfall', name: 'Starfall', element: 'arcane', order: 10, hue: '#ff4fd8',
  shape: 'area',
  params: {
    stars: 18, radius: 3.2, duration: 1.6, height: 8.5, angle: 26, speed: 30, trail: 6, size: 1,
    sparkles: 1, intensity: 1, sky: 1, night: 1,
    color: '#ff4fd8', core: '#fff1fc', glow: '#7a3dff',
  },
  ranges: {
    stars: [3, MAX_STARS - 1, 1], radius: [1.5, 6, 0.01], duration: [0.6, 3, 0.01], height: [6, 16, 0.1],
    angle: [0, 50, 0.5], speed: [12, 60, 0.1], trail: [1, 9, 0.01], size: [0.4, 2.5, 0.01],
    sparkles: [0, 3, 0.01], intensity: [0.1, 3, 0.01], sky: [0, 2, 0.01], night: [0, 2, 0.01],
  },
  presets: {
    'meteor shower': { stars: 24, duration: 1.3, angle: 38, speed: 44, trail: 6, size: 0.75 },
    'grand comets': { stars: 6, size: 1.7, trail: 7.5, speed: 24, duration: 1.8, angle: 18 },
    twilight: { color: '#b06cff', core: '#f3e8ff', glow: '#3b2dff', sky: 1.3, night: 1.4 },
  },
  timing: { charge: 1.1, impact: 2, linger: 2.4 },
  kinds: {
    // stardust: thrown out by each impact, settles and twinkles out, paints glow where it lands
    dust: { style: 'glow', drag: 1.8, gravity: 3, curl: 0.9, curlScale: 0.5, restitution: 0.2, friction: 0.85, life: [1.1, 2.4], size: [0.024, 0.008], stretch: 0.008, emissive: 6, color: ['#fff1fc', '#ff4fd8'], alpha: [1, 0], fadeIn: 0.02, fadeOut: 0.55, paints: 'glow', paintAmount: 0.05 },
    // wisps of the night drifting up from the impact field after the barrage
    // the bolide's persistent smoke train: lit dust that hangs in the air and twists (real fireballs leave one in daylight)
    smoke: { style: 'media', emissive: 0, drag: 2.2, buoyancy: 0.08, curl: 0.9, curlScale: 0.22, life: [2.6, 4.4], size: [0.16, 0.85], sizePow: 0.55, color: ['#8c8494', '#5d5866'], alpha: [0.34, 0], fadeIn: 0.05, fadeOut: 0.5, density: 1.6, erosion: 0.6, forceResponse: 0.7 },
    wisp: { style: 'glow', drag: 1.6, buoyancy: 0.55, curl: 1.3, curlScale: 0.35, forceResponse: 0.6, life: [1.4, 2.8], size: [0.018, 0.006], stretch: 0.01, emissive: 4, color: ['#fff1fc', '#7a3dff'], alpha: [1, 0], fadeIn: 0.3, fadeOut: 0.5 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    // the arcane family's own sparks and sparkles, by full name
    const spark = P.emitter('arcane.spark', { shape: 'sphere', radius: 0.08, spread: 3.2, radial: 3.5 });
    const glitter = P.emitter('arcane.sparkle', { shape: 'sphere', radius: 0.06, spread: 0.8 });
    const gather = P.emitter('arcane.sparkle', { shape: 'shell', radius: 3, spread: 0.2, radial: -1.6 });
    const rise = P.emitter('arcane.mote', { shape: 'ring', radius: 3, spread: 0.2 });
    const dust = P.emitter('starfall.dust', { shape: 'sphere', radius: 0.1, spread: 2.2, radial: 2.4 });
    const wisp = P.emitter('starfall.wisp', { shape: 'disk', radius: 3, spread: 0.25 });
    const smoke = P.emitter('starfall.smoke', { shape: 'sphere', radius: 0.06, spread: 0.25 });
    // meteorite ejecta and the dust it raises: earth's own pebbles and dust, by full name
    const ejecta = P.emitter('earth.pebble', { shape: 'sphere', radius: 0.12, spread: 2.2, radial: 4.5 });
    const puff = P.emitter('earth.dust', { shape: 'sphere', radius: 0.25, spread: 0.8, radial: 1.6 });

    // colours (linear), shared by reference with every material
    const col = new THREE.Color(), core = new THREE.Color(), glow = new THREE.Color(), lightCol = new THREE.Color(), skyLightCol = new THREE.Color();
    const vCore = new THREE.Vector3(), vCol = new THREE.Vector3(), vGlow = new THREE.Vector3();
    let cC = '', cK = '', cG = '';
    function syncColors() {
      const p = S.params;
      if (p.color === cC && p.core === cK && p.glow === cG) return;
      cC = p.color; cK = p.core; cG = p.glow;
      col.set(cC); core.set(cK); glow.set(cG);
      vCore.set(core.r, core.g, core.b); vCol.set(col.r, col.g, col.b); vGlow.set(glow.r, glow.g, glow.b);
      lightCol.copy(col).lerp(core, 0.35);
      skyLightCol.copy(glow).lerp(col, 0.5);
      P.setKind('starfall.dust', { color: [cK, cC] });
      P.setKind('starfall.wisp', { color: [cK, cG] });
    }

    // reusable option objects (the systems copy what they need)
    const SIG = { pos: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), radius: 3, color: new THREE.Color(), intensity: 0, reveal: 0, rotation: 0, style: 'arcane', seed: 0 };
    const SHOCK = { pos: new THREE.Vector3(), radius0: 0.1, radius1: 2, duration: 0.4, thickness: 0.3, distortion: 0.03, color: col, intensity: 1, ground: true };
    const SPLAT = { x: 0, z: 0, radius: 1, glow: 0, corruption: 0, heat: 0, char: 0, crack: 0, pattern: 'ring', seed: 0 };

    // --- canopies: two volume handles (two casts at once) ---
    const canopies = [];
    for (let i = 0; i < 2; i++) {
      const v = fx.volumes.add({
        shape: 'sphere', glsl: CANOPY_GLSL, maxSteps: 12,
        uniforms: {
          uSky: { value: new THREE.Vector4() }, uSky2: { value: new THREE.Vector4(3, 2.2, 0.3, 0) }, uSky3: { value: new THREE.Vector4() },
          uSkyCore: { value: vCore }, uSkyColor: { value: vCol }, uSkyGlow: { value: vGlow },
        },
      });
      v.busy = false;
      canopies.push(v);
    }

    // --- trains: full-res cores + half-res glow ---
    const trainU = { uSfCore: { value: vCore }, uSfColor: { value: vCol }, uSfGlow: { value: vGlow } };
    const cores = new fx.AnalyticRibbons({ max: MAX_TRAILS, segments: 16, pathGLSL: TRAIN_PATH, shadeGLSL: TRAIN_CORE, target: 'lines', uniforms: trainU });
    const glows = new fx.AnalyticRibbons({ max: MAX_TRAILS, segments: 12, pathGLSL: TRAIN_PATH, shadeGLSL: TRAIN_GLOW, target: 'fx', uniforms: trainU });
    fx.scenes.lines.add(cores.mesh);
    fx.scenes.fx.add(glows.mesh);

    // --- sprites ---
    const sgeo = new THREE.InstancedBufferGeometry();
    sgeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    sgeo.setIndex([0, 1, 2, 0, 2, 3]);
    const aA = instanced(sgeo, 'aA', MAX_SPRITES), aB = instanced(sgeo, 'aB', MAX_SPRITES);
    sgeo.instanceCount = 0;
    const sprites = new THREE.Mesh(sgeo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: { ...U }, ...LINES_BLENDING,
      vertexShader: COMMON_GLSL + SPRITE_VERT, fragmentShader: COMMON_GLSL + SPRITE_FRAG,
    }));
    sprites.frustumCulled = false;
    sprites.visible = false;
    fx.scenes.lines.add(sprites);
    const kgeo = new THREE.InstancedBufferGeometry();
    kgeo.setAttribute('position', sgeo.attributes.position);
    kgeo.setIndex(sgeo.index);
    const kA = instanced(kgeo, 'aA', MAX_SKY_SPRITES), kB = instanced(kgeo, 'aB', MAX_SKY_SPRITES);
    kgeo.instanceCount = 0;
    const skyStars = new THREE.Mesh(kgeo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: { ...U }, ...FX_BLENDING,
      vertexShader: FX_VERT_HEAD + COMMON_GLSL + SKY_VERT, fragmentShader: FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + SKY_FRAG,
    }));
    skyStars.frustumCulled = false;
    skyStars.visible = false;
    fx.scenes.fx.add(skyStars);
    const pops = Array.from({ length: MAX_POPS }, () => ({ pos: new THREE.Vector3(), age: 1, life: 0, size: 0, r: 0, g: 0, b: 0 }));
    let popHead = 0;
    function addPop(pos, size, c, k, life) {
      const q = pops[popHead]; popHead = (popHead + 1) % MAX_POPS;
      q.pos.copy(pos); q.size = size; q.life = life; q.age = 0;
      q.r = c.r * k; q.g = c.g * k; q.b = c.b * k;
    }

    // --- per cast record (cast.js keeps 16) ---
    const ST = Array.from({ length: MAX_CASTS }, () => ({
      on: false, centre: new THREE.Vector3(), sky: new THREE.Vector3(), fall: new THREE.Vector3(), tilt: new THREE.Vector3(), q: new THREE.Quaternion(),
      R: 3, Rc: 4, Hc: 1.3, n: 0, launched: 0, landed: 0, bt: 0, grow: 0, dis: 0, spin: 0, pulse: 0, sky01: 0,
      vol: null, sigil: null, light: null, push: null, pushT: 0, finaleDone: false, order: new Int8Array(MAX_STARS),
      skyStars: new Float32Array(MAX_SKY * 4),
      stars: Array.from({ length: MAX_STARS }, () => ({
        at: 0, s: new THREE.Vector3(), l: new THREE.Vector3(), pos: new THREE.Vector3(), dir: new THREE.Vector3(),
        len: 0, dist: 0, v: 0, size: 1, state: 0, age: 0, train: 0, core: null, glow: null, finale: false, ph: 0,
      })),
      slots: Array.from({ length: SLOTS }, () => ({ h: null, star: null, flash: 0, follow: 0 })),
    }));

    // lands stars on anything solid: floor, rim, pillars, dummies, spikes, shields
    function stopAt(st) {
      return st.dist >= st.len || (st.dist > 1 && st.pos.y < ARENA.pillarHeight + 0.5 && arenaSDF(st.pos) < 0.04);
    }

    function schedule(c, p, d) {
      const n = Math.round(p.stars), D = p.duration;
      d.n = n + 1; d.launched = 0; d.landed = 0; d.finaleDone = false;
      // landing points: a jittered sunflower over the disc, launched in shuffled order
      for (let i = 0; i < n; i++) d.order[i] = i;
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(fx.rand() * (i + 1)), t = d.order[i]; d.order[i] = d.order[j]; d.order[j] = t; }
      const a0 = fx.rand() * TAU;
      for (let k = 0; k <= n; k++) {
        const st = d.stars[k], fin = k === n;
        st.finale = fin; st.state = 0; st.age = 0; st.train = 0; st.core = st.glow = null; st.ph = fx.rand();
        if (fin) {
          if (c.target >= 0) st.l.copy(fx.dummies[c.target].pos).setY(0); else st.l.copy(d.centre);
          st.size = p.size * 1.9;
        } else {
          const i = d.order[k];
          const r = d.R * Math.sqrt((i + 0.5) / n) * (0.8 + 0.3 * fx.rand()), a = a0 + i * 2.39996 + (fx.rand() - 0.5) * 0.6;
          st.l.set(d.centre.x + Math.cos(a) * r, 0, d.centre.z + Math.sin(a) * r);
          st.size = p.size * (0.7 + 0.5 * fx.rand());
        }
        if (inPool(st.l.x, st.l.z)) st.l.y = ARENA.pool.water;
        // fall along the cast's radiant, out of the canopy's lower face (its tilted mid plane, lowered)
        st.dir.copy(d.fall);
        _a.copy(d.sky).addScaledVector(d.tilt, -d.Hc * 0.3);
        st.len = _b.subVectors(st.l, _a).dot(d.tilt) / st.dir.dot(d.tilt);
        st.s.copy(st.l).addScaledVector(st.dir, -st.len);
        st.v = p.speed * (fin ? 0.75 : 0.85 + 0.3 * fx.rand());
        // launch times spread over the barrage, a little denser in the middle; the finale last
        st.at = fin ? D * 0.95 : D * 0.82 * sstep((k + 0.5 * fx.rand()) / n, -0.15, 1.15);
        st.dist = 0; st.pos.copy(st.s);
      }
    }

    function launch(c, p, d, st) {
      st.state = 1; st.age = 0; st.dist = 0; st.pos.copy(st.s);
      st.core = cores.acquire(); st.glow = glows.acquire();
      if (st.core) st.core.color.setRGB(1, 1, 1);
      if (st.glow) st.glow.color.setRGB(1, 1, 1);
      addPop(st.s, 0.6 * st.size, core, 3 * p.intensity, 0.3);   // the star ignites in the canopy
      // a light follows it: the dimmest slot
      let best = null, bi = 1e9;
      for (const sl of d.slots) {
        if (!sl.h) continue;
        const k = Math.max(sl.flash, sl.follow);
        if (k < bi) { bi = k; best = sl; }
      }
      if (best) { best.star = st; best.flash = 0; best.h.range = 7 * st.size; }
      d.launched++;
    }

    function land(c, p, d, st) {
      st.state = 2; st.age = 0;
      st.train = Math.min(st.dist, p.trail * st.size);
      d.landed++;
      d.pulse = Math.min(1.5, d.pulse + (st.finale ? 1.2 : 0.35));
      const g = st.pos, fin = st.finale, z = st.size;
      // light: the slot that followed this star flashes here
      for (const sl of d.slots) if (sl.star === st) {
        sl.star = null; sl.follow = 0;
        sl.flash = (fin ? 55 : 38) * z * p.intensity;
        sl.h.range = (fin ? 9 : 5.5) * Math.sqrt(z);
        sl.h.pos.copy(g).addScaledVector(UP, 0.45);
      }
      addPop(g, (fin ? 2.2 : 1.25) * z, col, 6 * p.intensity, fin ? 0.6 : 0.35);
      // a white sub-flash keeps the centre hot while the coloured ring expands
      addPop(_a.copy(g).addScaledVector(UP, 0.05), 0.55 * z, core, (fin ? 3.5 : 5) * p.intensity, fin ? 0.3 : 0.18);
      spark.pos.copy(g).addScaledVector(UP, 0.05); spark.vel.set(0, fin ? 3 : 1.8, 0).addScaledVector(st.dir, -1.2);
      spark.burst((fin ? 420 : 80) * p.sparkles * Math.min(z, 1.5));
      dust.pos.copy(spark.pos); dust.vel.set(0, fin ? 3.5 : 2, 0); dust.radial = fin ? 3.4 : 2.2;
      dust.burst((fin ? 260 : 36) * p.sparkles);
      glitter.pos.copy(spark.pos); glitter.vel.set(0, 1, 0); glitter.spread = fin ? 3 : 1.6;
      glitter.burst((fin ? 260 : 50) * p.sparkles);
      glitter.spread = 0.8;
      spark.vel.set(0, 0, 0); glitter.vel.set(0, 0, 0);
      // ground: shock ring, glow + corruption (violet veins outlive the glow and creep along the stone)
      const onFloor = g.y < 2.6;   // on the floor, or on something standing on it (a dummy, a shield)
      SHOCK.pos.set(g.x, (inPool(g.x, g.z) ? ARENA.pool.water : 0) + 0.03, g.z); SHOCK.radius0 = 0.1; SHOCK.radius1 = (fin ? 6.5 : 1.8) * z;
      SHOCK.duration = fin ? 0.7 : 0.38; SHOCK.thickness = fin ? 0.8 : 0.3; SHOCK.distortion = fin ? 0.05 : 0.02;
      SHOCK.intensity = (fin ? 3 : 1.4) * p.intensity; SHOCK.ground = onFloor;
      fx.shocks?.spawn(SHOCK);
      if (onFloor) {
        SPLAT.x = g.x; SPLAT.z = g.z; SPLAT.seed = (c.seed + d.landed * 17) % 100;
        SPLAT.radius = (fin ? 1.6 : 0.75) * z; SPLAT.glow = fin ? 0.9 : 0.4; SPLAT.corruption = fin ? 1.5 : 0.75; SPLAT.pattern = fin ? 'radial' : 'ring';
        SPLAT.heat = fin ? 0.9 : 0.35; SPLAT.char = fin ? 0.7 : 0.3; SPLAT.crack = fin ? 0.8 : 0.15 * z;
        fx.ground.splat(SPLAT);
        SPLAT.heat = SPLAT.char = SPLAT.crack = 0;
        if (fin) { SPLAT.radius = d.R; SPLAT.glow = 0.6; SPLAT.corruption = 0.6; SPLAT.pattern = 'ring'; fx.ground.splat(SPLAT); }
        if (!inPool(g.x, g.z)) {
          ejecta.pos.copy(g).addScaledVector(UP, 0.08); ejecta.vel.set(0, fin ? 4.5 : 2.6, 0).addScaledVector(st.dir, -1.5);
          ejecta.burst((fin ? 70 : 5) * Math.min(z, 1.6));
          puff.pos.copy(g).addScaledVector(UP, 0.2); puff.vel.set(0, fin ? 1.2 : 0.6, 0);
          puff.burst((fin ? 46 : 5) * Math.min(z, 1.6));
        }
      }
      if (inPool(g.x, g.z)) fx.pool?.ripple(g.x, g.z, fin ? 0.08 : 0.035, fin ? 1 : 0.5);
      // an Aegis in the way ripples
      fx.spells.arcane?.inst?.hit?.(g, fin ? 1.4 : 0.6);
      // dummies: knockback from the blast
      const reach = (fin ? 3.2 : 1.3) * z;
      for (const dm of fx.dummies) {
        const dist = Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z);
        if (dist > reach) continue;
        _b.set(dm.pos.x - g.x, 0, dm.pos.z - g.z);
        if (dist < 0.05) _b.copy(st.dir);
        dm.hit(_b, (fin ? 1.1 : 0.3) * (1 - dist / reach) + 0.1);
      }
      if (fin) {
        d.finaleDone = true;
        fx.impacts.add('holy', _a.copy(g).setY(Math.max(g.y, 0) + 0.8), 3.2 * z, 0.7, 3.5, col);
        fx.flash(0.14 * p.intensity);
        fx.rig.shake(0.5, 13);
        if (!fx.reduced) { fx.rig.punch(2.5, 0.08); fx.rig.hitstop(0.06); }
        // a pressure shell pushes loose particles outward
        d.push = fx.forces.acquire();
        if (d.push) { d.push.type = 4; d.push.pos.copy(g).setY(Math.max(g.y, 0) + 0.3); d.push.p[0] = 0.3; d.push.p[1] = 1.2; d.push.p[2] = 60; d.push.p[3] = 0; d.pushT = 0; }
      } else fx.rig.shake(0.07 * z, 22);
    }

    function release(d) {
      for (const st of d.stars) { st.core?.release(); st.glow?.release(); st.core = st.glow = null; st.state = 3; }
      for (const sl of d.slots) { sl.h?.release(); sl.h = null; sl.star = null; sl.flash = sl.follow = 0; }
      if (d.vol) { d.vol.visible = false; d.vol.busy = false; }
      d.sigil?.release(); d.light?.release(); d.push?.release();
      d.vol = d.sigil = d.light = d.push = null;
      d.on = false;
    }

    // a train's ribbons from the star's state
    function placeTrain(st, I) {
      const len = st.state === 1 ? Math.min(st.dist, S.params.trail * st.size) : st.train;
      _c.copy(st.pos).addScaledVector(st.dir, -Math.max(len, 0.01));
      const h = st.core, g = st.glow;
      if (h) {
        h.p0.set(st.pos.x, st.pos.y, st.pos.z, 0.11 * st.size);
        h.p1.set(_c.x, _c.y, _c.z, 0);
        h.p2.set(st.ph * 97, Math.max(len, 0.01), 0, 0);
        h.intensity = 9 * I;
      }
      if (g) {
        g.p0.set(st.pos.x, st.pos.y, st.pos.z, 0.85 * st.size);
        g.p1.set(_c.x, _c.y, _c.z, 0);
        g.p2.set(0, Math.max(len, 0.01), 0, 0);
        g.intensity = 2 * I;
      }
    }

    syncColors();

    return {
      onParam(k) { if (k === 'color' || k === 'core' || k === 'glow') syncColors(); },

      phase(c, name) {
        const p = S.params, d = ST[c.index];
        syncColors();
        if (name === 'charge') {
          d.on = true; d.grow = 0; d.dis = 0; d.spin = (c.seed % 628) / 100; d.pulse = 0; d.bt = 0; d.sky01 = 0;
          c.durations.charge = 1.1; c.durations.impact = p.duration + 0.55; c.durations.linger = 2.4;
          d.R = p.radius; d.Rc = p.radius * 1.7 + 1.0; d.Hc = 1.3 + 0.12 * p.radius;
          if (c.target >= 0) d.centre.copy(fx.dummies[c.target].pos).setY(0); else d.centre.set(c.to.x, 0, c.to.z);
          // the radiant: sideways to the cast (diagonal on screen from behind the caster), a bit towards it
          const side = (c.seed & 1) ? 1 : -1, tanA = Math.tan(THREE.MathUtils.degToRad(p.angle));
          _a.set(-c.dir.z * side, 0, c.dir.x * side).addScaledVector(_b.set(-c.dir.x, 0, -c.dir.z), 0.35);
          if (_a.lengthSq() < 1e-6) _a.set(1, 0, 0);
          _a.normalize();
          d.fall.copy(_a).multiplyScalar(tanA).addScaledVector(UP, -1).normalize();
          const H = Math.max(p.height, d.Hc + 5);
          // the canopy sits up the radiant from the target and turns its face to the caster's side
          d.sky.copy(d.centre).addScaledVector(d.fall, -H / -d.fall.y);
          d.tilt.set(c.dir.x, 0, c.dir.z);
          if (d.tilt.lengthSq() < 1e-6) d.tilt.set(0, 0, -1);
          d.tilt.normalize().multiplyScalar(0.7).add(UP).normalize();
          d.q.setFromUnitVectors(UP, d.tilt);
          schedule(c, p, d);
          // twinkling stars inside the canopy: angle, radius 0..1, height -1..1, phase
          for (let i = 0; i < MAX_SKY; i++) {
            const o = i * 4;
            d.skyStars[o] = fx.rand() * TAU; d.skyStars[o + 1] = Math.sqrt(fx.rand()) * 0.88;
            d.skyStars[o + 2] = -0.75 + fx.rand() * 0.9; d.skyStars[o + 3] = fx.rand();
          }
          d.vol = null;
          for (const v of canopies) if (!v.busy) { d.vol = v; break; }
          if (d.vol) {
            d.vol.busy = true; d.vol.visible = false;
            d.vol.uniforms.uSky2.value.set(3, 2.4, 1.6 * p.night, (c.seed % 997) * 0.013);
          }
          SIG.pos.set(d.centre.x, 0.02, d.centre.z); SIG.radius = d.R; SIG.color.copy(col);
          SIG.intensity = 0; SIG.reveal = 0; SIG.rotation = d.spin; SIG.seed = c.seed % 1000;
          d.sigil = fx.sigils.acquire(SIG);
          d.light = fx.lights.acquire();
          if (d.light) { d.light.range = d.Rc * 2.2 + 4; d.light.intensity = 0; d.light.color.copy(skyLightCol); d.light.pos.copy(d.sky).addScaledVector(d.tilt, -d.Hc - 0.6); }
          for (const sl of d.slots) {
            sl.h = fx.lights.acquire(); sl.star = null; sl.flash = sl.follow = 0;
            if (sl.h) { sl.h.intensity = 0; sl.h.color.copy(lightCol); sl.h.shadow = true; sl.h.range = 7; }
          }
          d.push = null;
          // night falls on the floor: a dim violet-veined disc under the canopy
          SPLAT.x = d.centre.x; SPLAT.z = d.centre.z; SPLAT.radius = d.R * 1.1; SPLAT.glow = 0; SPLAT.corruption = 0.45 * p.night;
          SPLAT.pattern = 'noise'; SPLAT.seed = c.seed % 100;
          if (p.night > 0) fx.ground.splat(SPLAT);
        } else if (name === 'impact') {
          d.bt = 0;
          fx.rig.shake(0.1, 9);
        } else if (name === 'done') release(d);
      },

      update(c, dt) {
        const p = S.params, d = ST[c.index], I = p.intensity;
        if (!d.on) return;
        d.spin += dt * (0.35 + 0.5 * d.pulse);
        d.pulse = Math.max(0, d.pulse - dt * 3);
        let k = 1, sigI = 0;
        if (c.phase === 'charge') {
          k = c.t / c.durations.charge;
          d.grow = sstep(k, 0.02, 0.95);
          d.sky01 = sstep(k, 0.15, 0.9);
          if (d.sigil) { d.sigil.reveal = sstep(k, 0, 0.85); sigI = (1 + 2.5 * k) * I; }
          rise.pos.set(d.centre.x, 0.05, d.centre.z); rise.radius = d.R; rise.vel.set(0, 2.5 + 3 * k, 0);
          rise.rate(700 * k * p.sparkles, dt);
          gather.pos.copy(d.sky); gather.radius = d.Rc * 0.8; gather.rate(600 * d.grow * p.sparkles, dt);
          fx.arena.setFocus(fx.arena.focus.color, 2.5 + 3 * k);
        } else if (c.phase === 'impact') {
          d.grow = 1; d.sky01 = 1;
          d.bt += dt;
          sigI = (1.6 + 2.5 * d.pulse) * I;
          if (d.sigil) d.sigil.reveal = 1;
          while (d.launched < d.n && d.bt >= d.stars[d.launched].at) launch(c, p, d, d.stars[d.launched]);
          fx.arena.setFocus(fx.arena.focus.color, 2.5 + 2 * (1 - c.t / c.durations.impact));
        } else {
          // linger: the night thins away, the circle unwinds
          const t = c.t / c.durations.linger;
          d.dis = sstep(t, 0.05, 0.85);
          d.sky01 = 1 - sstep(t, 0, 0.7);
          if (d.sigil) d.sigil.reveal = 1 - sstep(t, 0.2, 0.9);
          sigI = 1.6 * I * (1 - t);
          if (t < 0.6) { wisp.pos.set(d.centre.x, 0.1, d.centre.z); wisp.radius = d.R; wisp.vel.set(0, 0.5, 0); wisp.rate(220 * p.sparkles * (1 - t / 0.6), dt); }
          fx.arena.setFocus(fx.arena.focus.color, 2.5);
        }
        if (d.sigil) { d.sigil.intensity = sigI; d.sigil.rotation = d.spin * 0.25; }

        // stars: fly, land, drain
        for (let i = 0; i < d.launched; i++) {
          const st = d.stars[i];
          if (st.state === 1) {
            st.age += dt;
            const v = st.v + 25 * st.age;
            st.dist = Math.min(st.len, st.dist + v * dt);
            st.pos.copy(st.s).addScaledVector(st.dir, st.dist);
            if (stopAt(st)) land(c, p, d, st);
            else {
              glitter.pos.copy(st.pos); glitter.vel.copy(st.dir).multiplyScalar(-1.5); glitter.rate(260 * p.sparkles * Math.min(st.size, 1.5), dt); glitter.vel.set(0, 0, 0);
              const sm = st.finale ? 1 : Math.max(0, st.size - 1.2);
              if (sm > 0) { smoke.pos.copy(st.pos); smoke.vel.copy(st.dir).multiplyScalar(-0.6); smoke.rate(170 * sm, dt); }
            }
          } else if (st.state === 2) {
            st.age += dt;
            st.train = Math.max(0, st.train - dt * 6);   // a persistent train: lingers, shortens into the impact
            if (st.train <= 0.02 || st.age > 0.7) { st.state = 3; st.core?.release(); st.glow?.release(); st.core = st.glow = null; }
          }
          if (st.state === 1 || st.state === 2) {
            const f = st.state === 1 ? Math.min(1, st.age / 0.06) : Math.exp(-st.age * 4.5) * (1 - st.age / 0.7);
            placeTrain(st, I * f * (st.finale ? 1.6 : 1) * Math.min(st.size, 1.6));
          }
        }

        // lights
        for (const sl of d.slots) {
          if (!sl.h) continue;
          sl.flash *= Math.exp(-dt / 0.11);
          const st = sl.star;
          if (st && st.state === 1) { sl.h.pos.copy(st.pos); sl.follow = 9 * st.size * I * Math.min(1, st.age / 0.08); } else sl.follow = 0;
          sl.h.intensity = Math.max(sl.flash, sl.follow);
        }
        if (d.light) {
          d.light.pos.copy(d.sky).addScaledVector(d.tilt, -d.Hc - 0.6);
          d.light.intensity = (5 * d.sky01 + 6 * d.pulse) * I * p.sky;
        }
        if (d.push) {
          d.pushT += dt;
          d.push.p[0] = 0.3 + 9 * d.pushT; d.push.p[2] = 60 * Math.max(0, 1 - d.pushT / 0.5);
          if (d.pushT > 0.5) { d.push.release(); d.push = null; }
        }
        // canopy
        const v = d.vol;
        if (v) {
          v.visible = d.grow > 0.01 && d.dis < 0.995 && p.sky + p.night > 0;
          if (v.visible) {
            v.position.copy(d.sky);
            v.quaternion.copy(d.q);
            v.scale.set(d.Rc, d.Hc, d.Rc);
            v.uniforms.uSky.value.set(d.grow, d.dis, 1.4 * I * p.sky, d.spin);
            v.uniforms.uSky2.value.z = 1.6 * p.night;
            v.uniforms.uSky3.value.x = d.pulse;
          }
        }
      },

      tick(dt) {
        syncColors();
        cores.update(); glows.update();
        const A = aA.array, B = aB.array, I = S.params.intensity;
        const time = U.uTime.value, KA = kA.array, KB = kB.array;
        let n = 0, m = 0;
        for (const d of ST) {
          if (!d.on) continue;
          // falling star heads
          for (let i = 0; i < d.launched && n < MAX_SPRITES; i++) {
            const st = d.stars[i];
            if (st.state !== 1) continue;
            const fl = 0.8 + 0.2 * Math.sin(st.age * 41 + st.ph * 13) * Math.sin(st.age * 17 + st.ph * 7) + 0.25 * Math.max(0, Math.sin(st.age * 9 + st.ph * 31) - 0.7) / 0.3;
            const o = n * 4, f = Math.min(1, st.age / 0.05), k = (st.finale ? 9 : 6) * I * f * fl;
            A[o] = st.pos.x; A[o + 1] = st.pos.y; A[o + 2] = st.pos.z; A[o + 3] = (st.finale ? 2.4 : 1.5) * st.size * (1 + 0.08 * Math.sin(st.age * 50 + st.ph * 9));
            B[o] = (col.r * 0.6 + core.r * 0.4) * k; B[o + 1] = (col.g * 0.6 + core.g * 0.4) * k; B[o + 2] = (col.b * 0.6 + core.b * 0.4) * k;
            B[o + 3] = (st.ph + st.age * 0.5) % 1;
            n++;
          }
          // canopy stars, turning with the nebula (same differential rotation)
          const vis = d.sky01 * S.params.sky;
          if (vis > 0.01) for (let i = 0; i < MAX_SKY && m < MAX_SKY_SPRITES; i++) {
            const q = i * 4, r01 = d.skyStars[q + 1];
            if (r01 > d.grow * 1.2 - 0.1) continue;
            const ang = d.skyStars[q] - d.spin * (0.45 + 0.75 / (0.35 + r01));
            const ph = d.skyStars[q + 3], tw = 0.55 + 0.45 * Math.sin(time * (3 + 5 * ph) + ph * 40);
            const o = m * 4, kk = 5 * I * vis * tw * tw * (0.3 + ph * ph);
            _a.set(Math.cos(ang) * r01 * d.Rc, d.skyStars[q + 2] * d.Hc, Math.sin(ang) * r01 * d.Rc).applyQuaternion(d.q).add(d.sky);
            KA[o] = _a.x; KA[o + 1] = _a.y; KA[o + 2] = _a.z;
            KA[o + 3] = 0.04 + 0.14 * ph * ph * ph;
            const w = ph * 0.7;   // some white, some tinted
            KB[o] = (core.r * (1 - w) + col.r * w) * kk; KB[o + 1] = (core.g * (1 - w) + col.g * w) * kk; KB[o + 2] = (core.b * (1 - w) + col.b * w) * kk;
            m++;
          }
        }
        for (const q of pops) {
          if (q.age >= q.life) continue;
          q.age += dt;
          if (q.age >= q.life || n >= MAX_SPRITES) continue;
          const o = n * 4;
          A[o] = q.pos.x; A[o + 1] = q.pos.y; A[o + 2] = q.pos.z; A[o + 3] = q.size;
          B[o] = q.r; B[o + 1] = q.g; B[o + 2] = q.b; B[o + 3] = 1 + q.age / q.life;
          n++;
        }
        sgeo.instanceCount = n;
        sprites.visible = n > 0;
        if (n > 0) aA.needsUpdate = aB.needsUpdate = true;
        kgeo.instanceCount = m;
        skyStars.visible = m > 0;
        if (m > 0) kA.needsUpdate = kB.needsUpdate = true;
      },
    };
  },
};
