import * as THREE from 'three';
import { ARENA, U, WORLD_W, MAX_LIGHTS, MAX_IMPACTS, MAX_OCCLUDERS, COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL, GROUND_GLSL } from '../vfx/common.js';
import { CRACK_SOURCES, FISSURE_A, FISSURE_B } from '../vfx/GroundField.js';

// Every lit arena surface (floor, stone, dummies) is one lean ShaderMaterial pipeline, so they all
// react to spells the same way and the idle arena stays cheap (the spells are the product):
//   1. state: impacts (spherical volume decals) + the ground field (full strength on the floor,
//      creeping up the foot of stone)
//   2. the surface itself (slabs, stone, wood...): one or two noise taps
//   3. responses: char, wet, frost, heat glow, crack, acid foam, corruption veins, holy glow,
//      electric crackle, all behind one branch on "anything there?" (most pixels skip it)
//   4. lighting: sun/moon GGX + Lambert with one hardware-PCF shadow tap, the sky cube for
//      ambient and (roughness-blurred) reflections, spell lights with capsule shadows
// Nothing here changes a define after load: every variation is a uniform.

// --- baked noise: 256^2 RGBA8, tileable, mipmapped ---------------------------------------
// r, g: value-noise fbm (two seeds), b: voronoi F2-F1 (0 on cell edges, 12 cells per tile;
// cracks, veins), a: fine fbm (grain, specks). Generated once in JS (~30 ms), no assets.
function hashi(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function bakeStoneNoise(N = 256) {
  const data = new Uint8Array(N * N * 4);
  const vnoise = (x, y, P, s) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P, x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
    const a = hashi(x0, y0, s), b = hashi(x1, y0, s), c = hashi(x0, y1, s), d = hashi(x1, y1, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (u, v, base, oct, s) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < oct; o++) { const f = base << o; sum += amp * vnoise(u * f, v * f, f, s + o * 31); norm += amp; amp *= 0.5; }
    return sum / norm;
  };
  const C = 12, pts = [];
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) pts.push(i + 0.1 + 0.8 * hashi(i, j, 91), j + 0.1 + 0.8 * hashi(i, j, 92));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, o = (y * N + x) * 4;
    const cx = u * C, cy = v * C, ix = Math.floor(cx), iy = Math.floor(cy);
    let f1 = 9, f2 = 9;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const gi = ix + di, gj = iy + dj, wi = ((gi % C) + C) % C, wj = ((gj % C) + C) % C;
      const px = pts[(wj * C + wi) * 2] + (gi - wi), py = pts[(wj * C + wi) * 2 + 1] + (gj - wj);
      const d = Math.hypot(px - cx, py - cy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    data[o] = fbm(u, v, 4, 5, 1) * 255;
    data[o + 1] = fbm(u, v, 4, 5, 7) * 255;
    data[o + 2] = Math.min(f2 - f1, 1) * 255;
    data[o + 3] = fbm(u, v, 32, 2, 13) * 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 2;   // low-frequency taps: 8x bought ~0.02 ms of nothing at 3.3 MP
  t.needsUpdate = true;
  return t;
}

// Shared by every arena material (and the pool). uReflection / uReflMatrix / uReflDistort stay
// for main.js's API (planar reflections are off: the sky cube does the reflections).
export const arenaUniforms = {
  uStoneNoise: { value: bakeStoneNoise() },
  uReflection: { value: null },
  uReflMatrix: { value: new THREE.Matrix4() },
  uReflDistort: { value: 0.35 },
  uRuneColor: { value: new THREE.Color(0.25, 0.85, 1.0).multiplyScalar(1.6) },
  uFocusColor: { value: new THREE.Color(1, 0.6, 0.25) },   // orb colour x intensity (pedestal runes)
  // the sun's static shadow map (arena.js points these at sunLight.shadow)
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowOn: { value: 0 },
  // sky-cube reflections x this: a spell that hides the sky (a storm deck) dims what the floor mirrors.
  // ponytail: one writer at a time (the last spell to tick wins); a per-spell min if two decks ever overlap
  uEnvScale: { value: 1 },
  uCrackSrc: { value: CRACK_SOURCES },   // craters the floor's fractures radiate from (GroundField)
  uFissA: { value: FISSURE_A }, uFissB: { value: FISSURE_B },   // hot fissure lines (GroundField)
};
{ // 1x1 transparent fallback
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  t.needsUpdate = true;
  arenaUniforms.uReflection.value = t;
}

// The world texture is RGBA32F, and a 32-bit-float RGBA fetch runs at a fraction of the normal
// rate: 16 lights x 2-3 texels per pixel cost more than the lighting maths. The same Float32Array
// rows are bound as uniform arrays instead (views of U.uWorld's data, so packWorld fills them
// with no copy); the loop index is the same for the whole warp, so each read is a constant-cache
// broadcast. Needs 192 fragment uniform vectors; on smaller GPUs it falls back to texel fetches.
const worldData = U.uWorld.value.image.data, ROW = WORLD_W * 4;
export const worldUniforms = {
  uWL: { value: worldData.subarray(0, ROW) },              // lights
  uWI: { value: worldData.subarray(2 * ROW, 3 * ROW) },    // impacts
  uWO: { value: worldData.subarray(3 * ROW, 4 * ROW) },    // occluders
};
let worldInUniforms = true;
export function configureWorldFetch(renderer) { worldInUniforms = renderer.capabilities.maxFragmentUniforms >= 448; }
export const worldDefines = () => (worldInUniforms ? { ARENA_WORLD_UNIFORMS: '' } : {});

const f = (x) => x.toFixed(4);
const P = ARENA.pool;

// --- GLSL ---------------------------------------------------------------------------------
// needs COMMON_GLSL + WORLD_GLSL + LIGHTS_GLSL (the dummy ice shell and the pool use it too)
export const LIGHT_FN_GLSL = /* glsl */`
#ifdef ARENA_WORLD_UNIFORMS
uniform vec4 uWL[${WORLD_W}];
uniform vec4 uWI[${WORLD_W}];
uniform vec4 uWO[${WORLD_W}];
#define WL(i) uWL[i]
#define WI(i) uWI[i]
#define WO(i) uWO[i]
#else
#define WL(i) worldTexel(0, i)
#define WI(i) worldTexel(2, i)
#define WO(i) worldTexel(3, i)
#endif
// All three loops below are split in two: a cheap pass sets one bit per item that can matter at
// this pixel, then the expensive body runs once per set bit. With the body behind a plain
// "if (culled) continue;" the D3D compiler (ANGLE) predicates it and every pixel paid for every
// light; a loop whose trip count is the bit count cannot be flattened.
#define NEXT_BIT(mask, i) { uint bit_ = mask & (~mask + 1u); mask ^= bit_; i = int(log2(float(bit_)) + 0.5); }

// LIGHTS_GLSL's capsuleShadow, culled: an occluder only matters if its capsule (plus the widest
// penumbra) reaches the bounding sphere of the shadow ray; stops once fully shadowed.
float arenaCapsuleShadow(vec3 p, vec3 lp) {
  vec3 dir = lp - p;
  float len = length(dir);
  p += dir * min(0.15 / max(len, 1e-3), 0.5);
  vec3 c = 0.5 * (p + lp);
  float R = 0.5 * length(lp - p) + 0.04 + 0.18 * len;
  int n = int(uWorldCounts.w);
  uint mask = 0u;
  for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
    if (i >= n) break;
    vec4 a = WO(i * 2);
    vec3 q = closestOnSegment(a.xyz, WO(i * 2 + 1).xyz, c) - c;
    float reach = R + a.w;
    if (dot(q, q) <= reach * reach) mask |= 1u << uint(i);
  }
  float vis = 1.0;
  while (mask != 0u) {
    int i; NEXT_BIT(mask, i)
    vec4 a = WO(i * 2), b = WO(i * 2 + 1);
    float s, d = segSegDist(p, lp, a.xyz, b.xyz, s);
    float pen = 0.04 + 0.18 * s * len;
    vis *= smoothstep(a.w - pen * 0.5, a.w + pen, d);
    if (vis < 0.003) return 0.0;
  }
  return vis;
}
// A light hovering over the pedestal (the focus orb, a spell charging at the focus) throws the
// pedestal's shadow as a soft disc on the floor around its foot: analytic, so the orb light needs
// no capsule shadow (a capsule's round top would also shade far too wide a disc).
float pedestalShadow(vec3 p, vec3 lp) {
  vec2 c = vec2(${f(ARENA.pedestal.pos.x)}, ${f(ARENA.pedestal.pos.z)});
  float hl = lp.y - p.y;
  if (length(lp.xz - c) > 0.3 || hl < 1.2) return 1.0;
  float d0 = 0.45 * hl / (hl - 1.15);   // umbra edge: the ray grazing the capital's rim
  return smoothstep(d0 * 0.8, d0 * 1.25, length(p.xz - c));
}
// Spell lights (LIGHTS_GLSL's spellLightPBR, restructured for the hot path): lights are culled
// on their window (range) before any shadow or BRDF work; a surface facing away skips the capsule
// shadow, and the shadow is traced once (at the diffuse point) and shared with the line light's
// specular point. base: luminance of the pixel's other lighting; a light adding less than 4% of it
// skips its capsule shadow (invisible there, and a wide dim light shadow-tracing 20 occluders over
// the whole screen cost ~0.4 ms at 3.3 MP). The pool and the ice shell pass 0: always traced.
void arenaSpellLights(vec3 p, vec3 n, vec3 v, float rough, vec3 f0, vec3 diffColor, float base, out vec3 diffuse, out vec3 specular) {
  diffuse = vec3(0.0); specular = vec3(0.0);
  int count = int(uWorldCounts.x);
  uint mask = 0u;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= count) break;
    vec4 la = WL(i * 4);
    vec3 lp = WL(i * 4 + 1).a == 1.0 ? closestOnSegment(la.xyz, WL(i * 4 + 2).xyz, p) : la.xyz;
    vec3 d = lp - p;
    if (dot(d, d) < la.w * la.w) mask |= 1u << uint(i);
  }
  if (mask == 0u) return;
  float a = max(rough * rough, 0.002);
  float nv = max(dot(n, v), 1e-4);
  vec3 r = reflect(-v, n);
  while (mask != 0u) {
    int i; NEXT_BIT(mask, i)
    vec4 la = WL(i * 4), lb = WL(i * 4 + 1), lc = WL(i * 4 + 2);
    int type = int(lb.a);
    vec3 lp = type == 1 ? closestOnSegment(la.xyz, lc.xyz, p) : la.xyz;
    vec3 d = lp - p;
    float dist = length(d);
    vec3 l = d / max(dist, 1e-4), ls = l;
    float dists = dist;
    if (type == 1) { vec3 sp = closestOnSegmentToRay(la.xyz, lc.xyz, p, r) - p; dists = length(sp); ls = sp / max(dists, 1e-4); }
    float nl = dot(n, l), nls = dot(n, ls);
    if (nl <= 0.0 && nls <= 0.0) continue;
    vec3 col = lb.rgb;
    if (type == 2) col *= lightCookie(SpellLight(la.xyz, la.w, lb.rgb, type, lc.xyz, lc.w, WL(i * 4 + 3)), p);
#ifdef ARENA_FLOOR
    col *= pedestalShadow(p, lp);
#endif
    vec3 dl = nl > 0.0 ? col * (lightFalloff(dist, la.w) * nl / PI) * diffColor : vec3(0.0), sl = vec3(0.0);
    if (nls > 0.0) {
      vec3 h = normalize(ls + v);
      float nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
      vec3 F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
      sl = col * F * (lightFalloff(dists, la.w) * spellD_GGX(nh, a) * spellV_Smith(nv, nls, a) * nls);
      // line lights: Karis's energy normalization, or a long segment's highlight clips into a white bar
      if (type == 1) sl *= a / min(a + length(lc.xyz - la.xyz) / (2.0 * dists), 1.0);
    }
    if (lc.w > 0.5 && !gLightNoShadow && dot(dl + sl, vec3(0.2126, 0.7152, 0.0722)) > 0.04 * base) {
      float sh = arenaCapsuleShadow(p, lp);
      dl *= sh; sl *= sh;
    }
    diffuse += dl; specular += sl;
  }
}
void arenaSpellLights(vec3 p, vec3 n, vec3 v, float rough, vec3 f0, vec3 diffColor, out vec3 diffuse, out vec3 specular) {
  arenaSpellLights(p, n, v, rough, f0, diffColor, 0.0, diffuse, specular);
}
`;

// IMPACTS_GLSL's impactWeights, culled the same way; the type is routed with a mask (dynamic vector
// indexing is emulated on D3D, and slow).
// Same world-texture layout as common.js (row 2: pos+radius, type/age/amount, colour).
const IMPACT_FN_GLSL = /* glsl */`
void arenaImpacts(vec3 p, out vec4 wa, out vec4 wb, out vec3 glowColor) {
  wa = vec4(0.0); wb = vec4(0.0); glowColor = vec3(0.0);
  int n = int(uWorldCounts.z);
  uint mask = 0u;
  for (int i = 0; i < ${MAX_IMPACTS}; i++) {
    if (i >= n) break;
    vec4 a = WI(i * 4);
    vec3 d = p - a.xyz;
    if (dot(d, d) < a.w * a.w) mask |= 1u << uint(i);
  }
  while (mask != 0u) {
    int i; NEXT_BIT(mask, i)
    vec4 a = WI(i * 4), b = WI(i * 4 + 1);
    float w = b.z * smoothstep(1.0, 0.55, length(p - a.xyz) / a.w);
    wa += w * vec4(equal(vec4(b.x), vec4(0.0, 1.0, 2.0, 3.0)));
    wb += w * vec4(equal(vec4(b.x), vec4(4.0, 5.0, 6.0, 7.0)));
    glowColor += WI(i * 4 + 2).rgb * w;
  }
}
`;

export const SURFACE_PARS = COMMON_GLSL + NOISE_GLSL + WORLD_GLSL + LIGHTS_GLSL + LIGHT_FN_GLSL + IMPACT_FN_GLSL + GROUND_GLSL + /* glsl */`
uniform sampler2D uStoneNoise;
uniform samplerCube uSkyCube;
uniform highp sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uRuneColor;
uniform vec3 uFocusColor;
uniform float uEnvScale;
uniform float uKind;
varying vec3 vWPos;
varying vec3 vNrm;
varying vec3 vLocal;
varying float vAO;
flat varying float vSeed;
float gAO = 1.0;        // cavity occlusion of ambient
float gSpecAO = 1.0;    // ... and of reflections
float gGroove = 0.0;    // in a narrow groove (floor grout): spell lights low over the floor can't reach in
float gHeatOpen = -1.0; // where heat glows through (>= 0 overrides crevice: the floor's grout barely glows)
float gFrostGlint = 0.0;// hoarfrost micro-facet glint, x sun
float stFrostImp = 0.0; // frost from impacts alone (the floor re-reads the field's own)
uniform vec4 uCrackSrc[4];
uniform vec4 uFissA[4];
uniform vec4 uFissB[4];
// metres from p to fissure i's line, and where along it (u) and across it (v)
float fissDist(int i, vec2 p, out float u, out float v, out float L) {
  vec2 ab = uFissA[i].zw - uFissA[i].xy;
  L = max(length(ab), 1e-3);
  vec2 T = ab / L, q = p - uFissA[i].xy;
  u = dot(q, T); v = dot(q, vec2(-T.y, T.x));
  return length(q - T * clamp(u, 0.0, L));
}
float gVent = 0.0;      // craterNear() of this floor pixel (computed once by the floor)
// how near a crater or a fissure vent this is (their own fractures carry the glow there, not the
// generic thermal crackle or the field's cell network)
float craterNear(vec2 p) {
  float c = 0.0, u, v, L;
  if (dot(vec4(uCrackSrc[0].w, uCrackSrc[1].w, uCrackSrc[2].w, uCrackSrc[3].w) + vec4(uFissB[0].y, uFissB[1].y, uFissB[2].y, uFissB[3].y), vec4(1.0)) <= 0.0) return 0.0;
  for (int i = 0; i < 4; i++) {
    c = max(c, smoothstep(2.6, 1.9, length(p - uCrackSrc[i].xy) / max(uCrackSrc[i].z, 0.1)) * min(uCrackSrc[i].w, 1.0));
    c = max(c, smoothstep(2.6, 1.8, fissDist(i, p, u, v, L)) * min(uFissB[i].y, 1.0));
  }
  return c;
}
// coverage of a crack d metres away, half-width w, pixel footprint px (a crack narrower than a pixel
// dims instead of aliasing)
float crackCov(float d, float w, float px) { return (1.0 - smoothstep(w * 0.3, w + px, d)) * w / (w + 0.75 * px); }
// F1, F2, F3 to jittered feature points (3x3 cells), and the nearest cell
vec3 vor3(vec2 x, float seed, out vec2 id) {
  vec2 c = floor(x), fr = x - c;
  vec3 d = vec3(8.0);
  id = c;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    float e = length(g + hash33(vec3(c + g, seed)).xy * 0.8 + 0.1 - fr);
    if (e < d.x) { d = vec3(e, d.xy); id = c + g; } else if (e < d.y) d = vec3(d.x, e, d.y); else d.z = min(d.z, e);
  }
  return d;
}
// Desiccation / lava-crust network: ~2.6 m primary plates, each broken into its own secondary cells
// (0.35-1.1 m; a fifth of the plates stay whole), so cell size varies several times over and the
// secondaries end on the primaries; every line tapers into its junctions (F3 - F2 -> 0 there).
// x: primary coverage, y: secondary coverage, z: metres to a primary
vec3 crackNet(vec2 p, float px, float wP, float wS) {
  vec2 idP, idS;
  vec3 a = vor3(p * ${f(1 / 2.6)}, 11.0, idP);
  vec3 hc = hash33(vec3(idP, 5.0));
  float sS = mix(0.35, 1.1, hc.x);
  vec3 b = vor3(p / sS, 12.0 + floor(hc.y * 8.0), idS);
  float eP = (a.y - a.x) * 1.3, eS = (b.y - b.x) * 0.5 * sS;
  float tP = mix(0.2, 1.0, smoothstep(0.0, 0.25, (a.z - a.y) * 2.6)), tS = mix(0.15, 1.0, smoothstep(0.0, 0.3, b.z - b.y));
  return vec3(crackCov(eP, wP * tP, px), crackCov(eS, wS * tS, px) * step(0.2, hc.z), eP);
}
#ifdef ARENA_FLOOR
// The rim wall's sun shadow, exact: where the wall meets the floor the shadow map's bias leaks a
// lit sliver a few cm wide, and on the polished floor facing a low sun it glints as a row of
// white dashes (one per shadow texel) along the far wall. A ray towards the sun leaves the arena
// through the wall's inner face (r = 17.98); it is clear only if it is above the coping by then.
float rimWallSun(vec2 p, vec3 s) {
  float dd = dot(s.xz, s.xz);
  if (dd < 1e-6) return 1.0;
  float b = dot(p, s.xz), c = dot(p, p) - ${f((ARENA.radius - 0.02) ** 2)};
  float t = (-b + sqrt(max(b * b - dd * c, 0.0))) / dd;
  return smoothstep(${f(ARENA.wallHeight - 0.04)}, ${f(ARENA.wallHeight + 0.04)}, t * s.y);
}
#endif

// running-bond blocks: distance to the nearest joint (uv units), id
float blocks(vec2 uv, vec2 size, float stagger, out vec2 id) {
  vec2 q = uv / size;
  q.x += floor(q.y) * stagger;
  id = floor(q);
  vec2 d = (0.5 - abs(fract(q) - 0.5)) * size;
  return min(d.x, d.y);
}
float segDist(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
// carved rune in a unit cell: 4 strokes between the nodes of a 3x3 lattice, picked by hash
float rune(vec2 q, float seed) {
  float d = 1e3;
  for (int k = 0; k < 4; k++) {
    vec4 h = hash41(seed * 13.7 + float(k) * 3.1);
    vec2 a = floor(h.xy * 2.999) * 0.5, b = floor(h.zw * 2.999) * 0.5;
    if (all(equal(a, b))) b = vec2(1.0) - a;
    d = min(d, segDist(q, a, b));
  }
  return d;
}
// split-sum environment BRDF, analytic (Karis 2014, mobile)
vec2 envBRDF(float rough, float nv) {
  vec4 r = rough * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}
`;

const VERT = (pars, main) => /* glsl */`
attribute float aAO;
varying vec3 vWPos;
varying vec3 vNrm;
varying vec3 vLocal;
varying float vAO;
flat varying float vSeed;
${pars}
void main() {
  vec4 lp = vec4(position, 1.0);
  vec3 nl = normal;
  vSeed = 0.0;
#ifdef USE_INSTANCING
  lp = instanceMatrix * lp;
  nl = mat3(instanceMatrix) * nl;
  vSeed = fract(sin(dot(instanceMatrix[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
#endif
  vec4 wp = modelMatrix * lp;
  vWPos = wp.xyz;
  vNrm = mat3(modelMatrix) * nl;
  vLocal = position;
  vAO = aAO;
  gl_Position = projectionMatrix * viewMatrix * wp;
${main}
}`;

// --- surfaces -------------------------------------------------------------------------------
// Each sets albedo / rough / metal / nW (world normal) / emit / crevice (0..1: grout, grooves,
// cracks; where heat and holy light seep out) and may read stA / stB (state).
const COPING = 0.35;
const FLOOR_SURFACE = /* glsl */`
{
  vec2 p = vWPos.xz;
  float r = length(p);
  vec2 dq = abs(p - vec2(${f(P.center.x)}, ${f(P.center.y)})) - vec2(${f(P.half.x)}, ${f(P.half.y)});
  float dBox = max(dq.x, dq.y);
  vec2 tid; float e, coping = 0.0;
  if (dBox < ${f(COPING)}) {
    // pool coping: slabs along each side
    bool sideX = dq.x > dq.y;
    float s = (sideX ? p.y : p.x) / 0.7;
    e = min(${f(COPING)} - dBox, (0.5 - abs(fract(s) - 0.5)) * 0.7);
    tid = vec2(floor(s), sideX ? 1.0 : 2.0);
    coping = 1.0;
  } else {
    e = min(blocks(p, vec2(1.2), 0.5, tid), dBox - ${f(COPING)});
  }
  vec3 h = hash33(vec3(tid, coping * 7.0 + 3.0));
  vec4 nA = texture(uStoneNoise, p * 0.09);
  // polished basalt: near black, cool grey, some slabs browner; mottled. Coping: paler stone.
  albedo = mix(vec3(0.036, 0.040, 0.046), vec3(0.052, 0.044, 0.037), h.y) * (0.7 + 0.6 * h.z) * (0.78 + 0.44 * nA.r);
  albedo = mix(albedo, vec3(0.11, 0.105, 0.098) * (0.8 + 0.3 * h.z), coping);
  rough = mix(mix(0.1, 0.32, h.x * h.x) * (0.8 + 0.4 * nA.a), 0.35, coping);
  // grout, and a slight random tilt per slab so the reflections break up slab by slab
  const float G = 0.004;
  float grout = 1.0 - smoothstep(G - px * 0.5, G + px * 0.5, e);
  vec2 slope = (h.yz - 0.5) * 0.03 * (1.0 - grout);
  albedo = mix(albedo, vec3(0.012), grout);
  rough = mix(rough, 0.8, grout);
  // grout is a recessed 8 mm joint: under a bright light it reads darker than the slab or the same,
  // never as a lit line (no holy glow out of it, spell lights shadowed by the slab edges)
  gGroove = grout;
  // contact occlusion: pillars, rim wall, pedestal, dummies
  float pa = atan(p.y, p.x) / ${f(Math.PI / 4)} - 0.5;
  float pk = (floor(pa + 0.5) + 0.5) * ${f(Math.PI / 4)};
  float dp = length(p - vec2(cos(pk), sin(pk)) * ${f(ARENA.pillarRing)}) - ${f(ARENA.pillarRadius)};
  float dd = length(p - vec2(${f(ARENA.pedestal.pos.x)}, ${f(ARENA.pedestal.pos.z)})) - 0.4;
${ARENA.dummies.map((d) => `  dd = min(dd, length(p - vec2(${f(d.x)}, ${f(d.z)})) - 0.25);`).join('\n')}
  gAO = mix(0.35, 1.0, smoothstep(0.0, 1.6, dp)) * mix(0.3, 1.0, smoothstep(0.0, 2.2, ${f(ARENA.radius)} - r)) * mix(0.45, 1.0, smoothstep(0.0, 0.7, dd));
  gSpecAO = mix(1.0, gAO, 0.6);
  // cracks: flat fissures along the voronoi network (the same tap), only where the field cracked;
  // crevice lets the heat response glow magma in them
  float ck = min(stB.x, 1.0);
  gVent = craterNear(p);
  float cr = smoothstep((0.02 + 0.1 * ck) * (0.5 + nA.g), 0.0, nA.b) * step(0.01, ck), crHot = cr;
  if (ck > 0.01) {
    // near a crater the field's vein-crawling crack fronts would cut the cell network into curly
    // fragments: there the crater's own fractures (below) are the cracks
    cr *= 1.0 - gVent;
    // round a crater the slab network gives way to fractures radiating from the pit (7, each
    // forking once further out, jagged, tapering to their tips) and broken concentric arcs
    // between them (quarry-blast rock, lava crust round a vent)
    vec4 nj = texture(uStoneNoise, p * 0.9 + vec2(0.37, 0.71));
    float jag = (nj.r - 0.5) * 0.16 + (nj.g - 0.5) * 0.07, rc = 0.0, rh = 0.0, wr = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 s = uCrackSrc[i];
      vec2 q = p - s.xy;
      float r = length(q), R = max(s.z, 0.1);
      float wi = smoothstep(1.9 * R, 1.35 * R, r) * min(s.w, 1.0);
      if (wi <= 0.0) continue;
      float h0 = fract(s.x * 0.173 + s.y * 0.311) * 13.0, th = atan(q.y, q.x) / 6.2831853 + 0.5, line = 0.0;
      float hot = smoothstep(1.25 * R, 0.4 * R, r + jag * 2.0);
      for (int o = 0; o < 2; o++) {
        float k = 7.0 * float(1 + o), fo = float(o);
        float an = th * k + h0 + fo * 0.37 + jag * k / (6.2831853 * max(r, 0.15));
        float ci = floor(an + 0.5), hs = fract(sin(ci * 12.9898 + fo * 78.233 + h0) * 43758.5453);
        float len = R * (0.95 + 0.75 * hs), st = fo < 0.5 ? 0.12 * R : (0.5 + 0.35 * hs) * R;
        float w = (0.006 + 0.03 * clamp(1.0 - r / len, 0.0, 1.0)) * smoothstep(len, 0.7 * len, r) * smoothstep(st, st + 0.25, r) * (fo < 0.5 ? 1.0 : 0.6 * step(0.3, hs));
        line = max(line, crackCov(abs(an - ci) * 6.2831853 * r / k, w, px));
      }
      for (int j = 0; j < 2; j++) {
        float fj = float(j), cell = floor(th * 7.0 + h0);
        float on = step(0.45, fract(sin(cell * 7.77 + fj * 3.3 + h0) * 43758.5453));
        float wob = sin(th * 18.85 + h0 + fj * 2.1) * 0.05 + sin(th * 43.98 + h0 * 1.7) * 0.025;   // smooth: no cusps
        line = max(line, crackCov(abs(r - R * (0.5 + 0.4 * fj) * (1.0 + wob) - jag * 0.5), 0.011 * on, px));
      }
      rc = max(rc, line); rh = max(rh, line * hot); wr = max(wr, wi);
    }
    crHot = mix(cr, rh, wr);
    cr = mix(cr, rc, wr);
  }
  if (uFissB[0].y + uFissB[1].y + uFissB[2].y + uFissB[3].y > 0.0) {
    // a fissure vent (Fagradalsfjall, Holuhraun): the long main fissure, wandering a little and
    // pinching out at its ends, a few short en-echelon cracks stepped beside it, slightly oblique;
    // spatter and a dark cooling crust along its lips. Hot only on and near the vent line.
    float fz = 0.0, fh = 0.0, fw = 0.0, fe = 0.0, vm = 9.0;
    for (int i = 0; i < 4; i++) {
      vec4 b = uFissB[i];
      if (b.y <= 0.0) continue;
      float u, v, L, dist = fissDist(i, p, u, v, L);
      float wi = smoothstep(2.4, 1.6, dist) * min(b.y, 1.0);
      if (wi <= 0.0) continue;
      vec4 nw = textureLod(uStoneNoise, vec2(u * 0.11, b.z * 0.371 + 0.13), 0.0);   // (no derivatives in this loop)
      vec4 nw2 = textureLod(uStoneNoise, vec2(u * 0.6, b.z * 0.533 + 0.71), 0.0);
      float v0 = (nw.r - 0.5) * 0.45 + (nw2.g - 0.5) * 0.14;
      float ends = clamp(min(u, L - u) / 0.7, 0.0, 1.0);
      // pinches and swells along its length; hot in pockets, not one even ribbon
      float line = crackCov(abs(v - v0), (0.006 + 0.03 * ends) * (0.3 + 1.4 * nw2.r) * step(0.0, ends), px);
      float hot = line * (0.45 + 0.55 * smoothstep(0.3, 0.7, nw.g));
      // en-echelon: one short crack per 1.3 m of fissure on alternating-ish sides
      float k = floor(u / 1.3);
      vec3 h = hash33(vec3(k, b.z, 7.0));
      float side = h.x < 0.5 ? -1.0 : 1.0, off = side * (0.45 + 0.45 * h.y) * clamp(b.x / 0.75, 0.5, 2.0), len = 0.5 + 0.7 * h.z;
      float du = u - k * 1.3 - (1.3 - len) * fract(h.x * 7.3), su = du / len;
      float ve = off + (du - 0.5 * len) * 0.22 * side + v0;
      float we = 0.009 * sin(3.14159 * clamp(su, 0.0, 1.0)) * step(0.0, su) * step(su, 1.0) * step(0.3, fract(h.y * 5.1)) * step(0.5, ends + 0.5);
      float ech = crackCov(abs(v - ve), we, px);
      line = max(line, ech);
      // the side cracks erupt too while the vent is young (their own glow: the field's heat stays on
      // the main line), then crust over
      fe = max(fe, ech * wi * smoothstep(1.0, 1.9, b.y) * (0.5 + 0.5 * h.z));
      fz = max(fz, line * wi); fh = max(fh, hot * wi); fw = max(fw, wi);
      vm = min(vm, abs(v - v0) + (1.0 - ends) * 0.5 + (1.0 - wi) * 2.0);
    }
    if (fw > 0.0) {
      // lips: a dark, fresh crust; spatter flung onto it, still glowing in spots right at the vent
      vec4 nsp = texture(uStoneNoise, p * 2.3 + vec2(0.53, 0.29));
      float lip = exp(-vm / 0.45) * fw;
      albedo *= 1.0 - 0.7 * lip;
      rough = mix(rough, 0.85, lip);
      float spatter = smoothstep(0.7, 0.85, nsp.r) * smoothstep(0.6, 0.8, nsp.g) * exp(-vm / 0.14) * fw;
      crHot = max(mix(crHot, fh, fw), spatter * 0.4);
      cr = max(mix(cr, fz, fw), spatter * 0.3);
      emit += blackbody(1250.0) * fe * 2.0;
    }
  }
  albedo *= 1.0 - 0.92 * cr;
  rough = mix(rough, 0.9, cr);
  gAO *= 1.0 - 0.8 * cr;
  gSpecAO *= 1.0 - 0.9 * cr;
  crevice = max(crevice, cr);
  gHeatOpen = max(grout * 0.04 * (1.0 - gVent), crHot);   // crater / vent fractures glow only in the hot core; no grout grid there
  nW = normalize(vec3(slope.x, 1.0, slope.y));
  sp2 = p;
}
`;

const STONE_SURFACE = /* glsl */`
{
  vec3 gn = nW;
  sp2 = abs(gn.y) > 0.7 ? vWPos.xz : abs(gn.x) > abs(gn.z) ? vWPos.zy : vWPos.xy;
  vec4 nA = texture(uStoneNoise, sp2 * 0.35 + vSeed);
  gAO = vAO;
  gSpecAO = vAO;
  if (uKind < 0.5) {
    // pillar: warm limestone, grime at the foot, two glowing rune bands
    float ang = atan(vLocal.z, vLocal.x), y = vLocal.y;
    albedo = vec3(0.30, 0.27, 0.235) * (0.72 + 0.5 * nA.r) * mix(0.5, 1.0, smoothstep(0.0, 1.6, y));
    rough = 0.55 + 0.3 * nA.a;
    float b0 = (y - 1.62) / 0.24, b1 = (y - 4.34) / 0.18;
    float bv = b0 > 0.0 && b0 < 1.0 ? b0 : b1 > 0.0 && b1 < 1.0 ? b1 : -1.0;
    if (bv >= 0.0) {
      float gu = (ang / 6.2831853 + 0.5) * 14.0;
      float gi = floor(gu);
      vec2 q = (vec2(fract(gu), bv) - 0.5) * vec2(1.5, 1.15) + 0.5;
      float dr = rune(q, gi + floor(y) * 31.0 + vSeed * 97.0);
      float aa = length(fwidth(q));
      float stroke = smoothstep(0.075 + aa, 0.075 - aa, dr) * step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
      float pulse = 0.65 + 0.35 * sin(uTime * 1.3 + gi * 0.7 + vSeed * 20.0);
      albedo *= 1.0 - 0.6 * stroke;
      emit += uRuneColor * stroke * pulse;
      crevice = max(crevice, stroke);
    }
  } else if (uKind < 1.5) {
    // rim wall: ashlar courses (coping blocks on top)
    float ang = atan(vWPos.z, vWPos.x), R = length(vWPos.xz);
    vec2 id;
    float e = gn.y > 0.7 ? blocks(vec2(ang * R, 0.5), vec2(1.0, 10.0), 0.0, id) : blocks(vec2(ang * R, vWPos.y - 0.14), vec2(1.15, 0.45), 0.5, id);
    vec3 h = hash33(vec3(id, 5.0));
    albedo = vec3(0.24, 0.215, 0.19) * (0.7 + 0.45 * h.x) * (0.75 + 0.45 * nA.r) * mix(0.55, 1.0, smoothstep(0.0, 0.6, vWPos.y));
    rough = 0.6 + 0.3 * nA.a;
    float joint = 1.0 - smoothstep(0.006 - px * 0.5, 0.006 + px * 0.5, e);
    albedo = mix(albedo, vec3(0.03), joint);
    crevice = joint;
    gAO *= 1.0 - 0.5 * joint;
  } else if (uKind < 2.5) {
    // pedestal: polished dark marble, brass bands, a rune band glowing in the focus colour
    float y = vLocal.y;
    float vein = smoothstep(0.03, 0.0, abs(nA.g - 0.5));
    albedo = mix(vec3(0.018, 0.026, 0.024), vec3(0.2, 0.21, 0.2), vein * 0.4);
    rough = 0.1;
    float brass = step(abs(y - 0.19), 0.025) + step(abs(y - 1.0), 0.02) + step(abs(y - 1.12), 0.02);
    albedo = mix(albedo, vec3(0.9, 0.62, 0.32), brass);
    metal = brass; rough = mix(rough, 0.22, brass);
    float bv = (y - 0.62) / 0.2;
    if (bv > 0.0 && bv < 1.0 && brass < 0.5) {
      float ang = atan(vLocal.z, vLocal.x);
      float gu = (ang / 6.2831853 + 0.5) * 8.0, gi = floor(gu);
      vec2 q = (vec2(fract(gu), bv) - 0.5) * vec2(1.4, 1.1) + 0.5;
      float aa = length(fwidth(q));
      float stroke = smoothstep(0.08 + aa, 0.08 - aa, rune(q, gi + 300.0)) * step(0.0, q.y) * step(q.y, 1.0);
      emit += uFocusColor * stroke * 1.5;
      albedo *= 1.0 - 0.7 * stroke;
    }
  } else if (uKind < 4.5) {
    // pool basin: small teal-black mosaic
    vec2 id;
    float e = blocks(sp2, vec2(0.11), 0.0, id);
    vec3 h = hash33(vec3(id, 9.0));
    albedo = mix(vec3(0.008, 0.03, 0.034), vec3(0.02, 0.05, 0.05), h.x) * (0.7 + 0.6 * h.y);
    float joint = 1.0 - smoothstep(0.0025 - px * 0.5, 0.0025 + px * 0.5, e);
    albedo = mix(albedo, vec3(0.06, 0.065, 0.06), joint);
    rough = mix(0.15 + 0.1 * h.z, 0.7, joint);
  } else {
    // brass (orb rings)
    albedo = vec3(0.92, 0.66, 0.34);
    metal = 1.0;
    rough = 0.25;
  }
}
`;

// responses to the state (a = heat, char, wet, frost; b = crack, acid, corruption, glow); at most
// two noise taps on top of the surface's
const RESPONSES = /* glsl */`
if (any(greaterThan(stA, vec4(0.004))) || any(greaterThan(stB, vec4(0.004))) || stElec > 0.004) {
  vec4 nS = texture(uStoneNoise, sp2 * 0.11 + 0.31);
  bool flat_ = nW.y > 0.9;
  // char: soot, uneven
  float ch = clamp(stA.y * (0.75 + 0.5 * nS.r), 0.0, 1.0);
  albedo *= 1.0 - 0.85 * ch;
  rough = mix(rough, 0.9, ch);
  metal *= 1.0 - ch;
  // wet: darker, glossy film; on the floor it pools where the noise is low
  float wt = clamp(stA.z, 0.0, 1.0);
  float puddle = flat_ ? smoothstep(0.35, 0.7, wt * (0.6 + 0.8 * nS.g)) : 0.0;
  albedo *= 1.0 - 0.4 * wt;
  rough = mix(rough, 0.04, max(wt * 0.75, puddle));
  nW = normalize(mix(nW, vec3(0.0, 1.0, 0.0), puddle));
  crevice *= 1.0 - puddle;
  // frost: hoarfrost, matched to frost-front macro timelapses. The field only says how much frost
  // there is; on the floor it is re-read through a smooth warp of about a texel, so no front ever
  // shows the field's grid (4 cm texels, 8 cm at Low). The crystals come from the MIPMAPPED stone
  // noise, so they filter down to their average with distance instead of aliasing into speckle.
  // Coverage: a solid carpet where the field plus lumps at three scales clears a threshold, and
  // ahead of it a fringe of crystals that nucleate on grain boundaries (two voronoi scales) and
  // needles (ridged fbm), sparse at first and closing up towards the carpet: a feathery, broken
  // front at every distance, never a smooth rim. Density varies (thin grey frost where the stone
  // shows, thicker drifts), and even the thickest stays well under snow-white. Sparkle: one hashed
  // micro-facet per 7 mm cell glints at the sun (view-dependent, still when the camera is), faded
  // out before a cell shrinks to a pixel. Over water: an ice sheet.
  float fr = clamp(stA.w, 0.0, 1.0);
  float cover = 0.0, sheet = 0.0;
  if (fr > 0.004) {
    vec4 nF = texture(uStoneNoise, sp2 * 2.3 + vec2(0.17, 0.61));   // 43 cm tile: 11 cm lumps, 3.6 cm grains, 1.3 cm grit
    vec4 nG = texture(uStoneNoise, sp2 * 0.6 + vec2(0.43, 0.09));   // 1.7 m tile: the front's lobes, 14 cm grains
#ifdef ARENA_FLOOR
    vec2 wq = (vec2(nG.g, nF.g) - 0.5) * 2.4 / vec2(textureSize(uGroundA, 0));
    // an impact's frost is a sphere's footprint: cut its fade band into lobes (the edge falls
    // anywhere from 0.1 to 0.9 of the band, on 1.7 m and 8 m noise) and keep its middle short of
    // saturation, so it never lands as one flat disc with a round rim
    float lobe = texture(uStoneNoise, sp2 * 0.13 + vec2(0.61, 0.37)).r * 0.55 + nG.r * 0.45;
    float fT = clamp(0.5 + (0.5 - lobe) * 2.2, 0.1, 0.9);
    float fi = smoothstep(fT - 0.12, fT + 0.12, stFrostImp) * (0.62 + 0.3 * lobe);
    fr = clamp(max(texture(uGroundA, groundUV(vWPos.xz) + wq).w, fi), 0.0, 1.0);
#endif
    float g = fr - 0.45 + (nS.r - 0.5) * 0.34 + (nG.r - 0.5) * 0.36 + (nF.r - 0.5) * 0.2;
    float lace = max(1.0 - smoothstep(0.0, 0.16, nF.b), 0.8 - 0.8 * smoothstep(0.0, 0.09, nG.b));
    float needle = pow(1.0 - abs(nF.g * 2.0 - 1.0), 6.0) * (1.0 - smoothstep(0.004, 0.012, px));   // a mipmapped ridge goes flat-bright: fade first
    float gf = max(lace, needle) * (0.7 + 0.6 * nF.a) - 1.0 + 1.25 * smoothstep(-0.34, 0.04, g);
    float aw = fwidth(g) * 0.7 + 0.004, af = fwidth(gf) * 0.7 + 0.01;
    cover = max(smoothstep(-aw, aw, g), smoothstep(-af, af, gf) * smoothstep(-0.36, -0.24, g));
    sheet = min(cover, max(puddle, wt));
    float rime = cover * (1.0 - sheet);
    // depth of the crystal carpet: thin and grey at the front and in patches, drifts deeper
    float thick = smoothstep(0.0, 0.45, g) * (0.3 + 0.7 * smoothstep(0.3, 0.75, nS.g * 0.4 + nG.a * 0.6 + 0.2 * (fr - 0.6)));
    vec3 rimeCol = mix(vec3(0.30, 0.34, 0.40), vec3(0.68, 0.74, 0.82), thick) * (0.8 + 0.4 * nF.a);
    albedo = mix(albedo, rimeCol, rime * mix(0.5, 0.9, thick));
    albedo = mix(albedo, albedo * vec3(0.7, 0.9, 1.1), sheet);
    rough = mix(mix(rough, 0.48, rime), 0.05, sheet);
    metal *= 1.0 - cover;
    crevice *= 1.0 - cover * 0.8;
    // glints: a random plate per cell, its normal anywhere within ~50 degrees of up
    vec2 gq = sp2 * 140.0;
    vec3 gh = hash33(vec3(floor(gq), 23.0));
    float fine = (1.0 - smoothstep(0.3, 0.75, px * 140.0)) * rime * step(0.55, gh.z);
    if (fine > 0.0) {
      vec3 nf = normalize(vec3((gh.x - 0.5) * 2.4, 1.0, (gh.y - 0.5) * 2.4));
      vec3 Hs = normalize(uSunDir + normalize(cameraPosition - vWPos));
      vec2 sd = fract(gq) - 0.5 - (gh.yx - 0.5) * 0.35;
      float aa = fwidth(gq.x) + fwidth(gq.y);
      float spot = 1.0 - smoothstep(0.16 - aa, 0.16 + aa, length(sd));
      gFrostGlint = spot * pow(max(dot(nf, Hs), 0.0), 900.0) * fine * 60.0;
    }
  }
  // heat: hot stone glows only where it is open (thermal cracks that open with heat, the field's
  // own cracks, pores) through a dark char crust; grout barely. Temperature follows the field
  // heat, radiance ~T^4 above the Draper point, so the glow dies off well inside the hot area
  // instead of ending in a disc; the crust itself only goes dull red right at the centre.
  float ht = clamp(stA.x, 0.0, 1.0);
  if (ht > 0.01) {
    vec4 nH = texture(uStoneNoise, sp2 * 0.55 + vec2(0.71, 0.23));   // 1.8 m tile: ~15 cm crack cells, 6 cm pores
    float crust = smoothstep(0.04, 0.45, ht);
    albedo *= 1.0 - 0.8 * crust;
    rough = mix(rough, 0.88, crust);
    metal *= 1.0 - crust;
    // local temperature: the field heat broken into hot and cooler patches (a plateau of saturated
    // field heat must not read as one uniform disc)
    float hl = clamp(ht * (0.6 + 0.55 * nH.r) * (0.85 + 0.3 * nS.g), 0.0, 1.0);
    // fractures across the slabs (~75 cm cells, the tap the responses already made), segment by
    // segment as the heat rises; a fine crackle (~15 cm) only in the hottest patches
    // (thin and coverage-preserving: a crack narrower than a pixel dims instead of aliasing; width and
    // glow vary along each crack, which also breaks the network into segments)
    float bw = (0.005 + 0.014 * hl) * (0.4 + 1.2 * nH.r), fb = fwidth(nS.b);
    float big = (1.0 - smoothstep(bw * 0.3, bw + fb, nS.b)) * bw / (bw + 0.75 * fb) * smoothstep(0.25, 0.55, hl) * smoothstep(0.42, 0.62, nH.g + 0.12 * hl);
    float fw = 0.006 + 0.012 * hl, ff = fwidth(nH.b);
    float fine = (1.0 - smoothstep(fw * 0.3, fw + ff, nH.b)) * fw / (fw + 0.75 * ff) * smoothstep(0.72, 0.95, hl) * smoothstep(0.45, 0.6, nH.g);
    float tc = max(big, fine * 0.7) * (1.0 - gVent);   // round a crater the glow comes out of its fractures (gHeatOpen) alone
    float op = max(tc, gHeatOpen >= 0.0 ? gHeatOpen : crevice);
    albedo *= 1.0 - 0.7 * tc;
    float pore = smoothstep(0.8, 0.86, nH.a) * smoothstep(0.55, 0.9, hl);   // a few open vesicles, hottest patches only
    float Tc = 620.0 + 1250.0 * hl, Ts = Tc - 200.0;
    float Rc = pow(Tc / 1500.0, 4.0) * smoothstep(760.0, 1050.0, Tc);
    float Rs = pow(Ts / 1500.0, 4.0) * smoothstep(760.0, 1100.0, Ts);
    emit += blackbody(Tc) * (Rc * 3.2 * op)
          + blackbody(Ts) * (Rs * (0.35 * pore + 0.08 * smoothstep(0.75, 1.0, hl) + 0.12 * tc * tc));
  }
  float ac = clamp(stB.y, 0.0, 1.0);
  if (ac > 0.01 || stElec > 0.004) {
    // one more tap: acid foam cells (the baked voronoi, scrolling), or electric's lines
    float tj = floor(uTime * 20.0);
    // (acid: a still tap, so the etched grain stays put; the fizz is animated per cell by phase)
    vec4 nF = texture(uStoneNoise, ac > 0.01 ? sp2 * 0.9 : sp2 * 0.21 + vec2(tj * 0.137, tj * 0.291));
    // acid eating stone (etched limestone and concrete): where it is still wet with acid the stone
    // is dark and glossy under a thin yellow-green film; round it the stain rusts yellow-brown (the
    // iron in the stone) in soft blotches, never one flat disc, its grain etched rough (a texture that
    // fades to its mean before it can alias into specks); a pale, chalky salt bloom dries along the
    // stain's edge. Only fresh acid fizzes: small grey-green bubbles cell by cell, a faint glow.
    float mott = nS.a * 0.6 + nS.r * 0.4 - 0.5;
    float stain = smoothstep(0.02, 0.45, ac + mott * 0.35);
    float wetA = smoothstep(0.35, 0.9, ac + mott * 0.5);
    float grain = (nF.a - 0.5) * (1.0 - smoothstep(0.004, 0.015, px));
    float bloom = stain * (1.0 - smoothstep(0.08, 0.35, ac + mott * 0.4)) * (0.6 + 0.8 * (nF.a - 0.5));
    float ph = fract(uTime * 0.7 + nF.r * 3.0);
    float foam = smoothstep(0.1 + 0.2 * ph, 0.04 + 0.16 * ph, nF.b) * (1.0 - smoothstep(0.8, 1.0, ph)) * step(nF.g, ac * 1.1 - 0.3);
    albedo = mix(albedo, albedo * vec3(0.78, 0.64, 0.42), stain * 0.8);
    albedo = mix(albedo, vec3(0.58, 0.57, 0.5), bloom * 0.45);
    albedo *= (1.0 + grain * 0.3 * stain) * (1.0 - 0.45 * wetA);
    albedo *= mix(vec3(1.0), vec3(0.85, 1.0, 0.6), wetA * 0.6);
    albedo = mix(albedo, vec3(0.4, 0.46, 0.3), foam * ac);
    rough = mix(mix(rough, 0.9, stain * (1.0 - wetA)), 0.12, max(wetA * 0.85, foam * ac));
    metal *= 1.0 - stain;
    emit += vec3(0.25, 1.0, 0.08) * ac * (0.004 + 0.1 * foam);
    // electric: thin wandering lines, reseeded at 20 Hz
    float line = smoothstep(0.03, 0.0, abs(nF.r - 0.5)) + 0.6 * smoothstep(0.02, 0.0, abs(nF.g - 0.5));
    vec3 ec = mix(vec3(0.45, 0.65, 1.0), stGlow, step(1e-3, dot(stGlow, stGlow)) * 0.6);
    emit += ec * line * min(stElec, 1.0) * 10.0;
  }
  // corruption: lava-crust / desiccation cracks (crackNet): dark, dead fissures through a blackened
  // stain, glowing only in a connected patch near the source, primaries further out than the
  // secondaries, fading with distance (the field's raw value: potential above 1 near the source,
  // falling off with the front) and with time
  float co = clamp(stB.z, 0.0, 1.0);
  if (co > 0.01) {
    vec4 nC = texture(uStoneNoise, sp2 * 0.23 + vec2(0.29, 0.83));   // 4.3 m tile: warp (apparent cell size wanders)
    vec4 nJ = texture(uStoneNoise, sp2 * 1.7 + vec2(0.61, 0.17));    // 59 cm: jag, width along the cracks
    float wv = 0.5 + nJ.b;
    vec3 cn = crackNet(sp2 + (nC.rg - 0.5) * 0.6 + (nJ.rg - 0.5) * 0.035, px, (0.006 + 0.016 * co) * wv, (0.003 + 0.005 * co) * wv);
    float crack = max(cn.x, cn.y * smoothstep(0.1, 0.4, co));
    float liveP = smoothstep(0.9, 2.0, stB.z), liveS = smoothstep(1.5, 2.6, stB.z);
    float halo = exp(-cn.z / 0.03) * liveP;
    float pulse = 0.75 + 0.25 * sin(uTime * 2.3 - length(sp2) * 1.5 + nC.b * 6.0);
    albedo = mix(albedo, vec3(0.02, 0.0, 0.03), co * 0.5);
    albedo *= 1.0 - 0.9 * crack;
    rough = mix(rough, 0.9, crack * co);
    // the glow is the crack's hot core (narrower than the dark gap), a faint bloom round it
    emit += (vec3(0.3, 0.04, 0.8) * (halo * 0.45) + vec3(0.7, 0.22, 1.0) * ((cn.x * cn.x * liveP + cn.y * cn.y * liveS * 0.6) * 3.0)) * (co * pulse);
    crevice = max(crevice, crack * co);
  }
  // holy glow: gold-white light pouring out of the joints, a soft sheen on the surface
  float gl = clamp(stB.w, 0.0, 1.0);
  vec3 gc = mix(vec3(1.0, 0.8, 0.48), stGlow, step(1e-3, dot(stGlow, stGlow)) * 0.5);
  emit += gc * gl * (0.35 + 3.0 * crevice) * 2.5;
}
`;

// state from impacts (and the field, per mode); mapped onto the field's channels so one set of
// responses serves both
const STATE = /* glsl */`
vec4 stA = vec4(0.0), stB = vec4(0.0);
float stElec = 0.0;
vec3 stGlow = vec3(0.0);
{
  vec4 wa, wb; vec3 gc;
  arenaImpacts(vWPos, wa, wb, gc);
  float wsum = dot(wa, vec4(1.0)) + dot(wb, vec4(1.0));
  stGlow = gc / max(wsum, 1e-4);
  // scorch: char + a little heat while fresh; magma: heat in fresh cracks
  stA += vec4(0.3 * wa.x * wa.x + wa.w, wa.x, wa.z, wa.y);
  stFrostImp = wa.y;
  stB += vec4(0.6 * wa.w, wb.x, wb.z, wb.y);
  stElec = wb.w;
#if defined(ARENA_FLOOR) || defined(ARENA_STONE)
  vec2 guv = groundUV(vWPos.xz);
  float gw = all(greaterThan(guv, vec2(0.0))) && all(lessThan(guv, vec2(1.0))) ? 1.0 : 0.0;
#ifdef ARENA_STONE
  gw *= 1.0 - smoothstep(0.03, 0.55, vWPos.y);   // creeps up the foot of walls and pillars
#endif
  if (gw > 0.0) {
    stA = max(stA, texture(uGroundA, guv) * gw);
    stB = max(stB, texture(uGroundB, guv) * gw);
  }
#endif
}
`;

// Lighting: sun (or moon) GGX + Lambert with one hardware-PCF shadow tap; ambient from the sky's
// baked irradiance (U.uAmbient, the same the particles use; walls see half the sky, undersides a
// little bounce); reflections from the sky cube blurred by roughness (on the floor the horizon
// darkens where the rim wall would hide it); spell lights. U.uSunColor is E / pi.
const FRAG = (surface, pars) => SURFACE_PARS + pars + /* glsl */`
out vec4 fragColor;
void main() {
  vec3 albedo = vec3(0.5), emit = vec3(0.0);
  float rough = 0.5, metal = 0.0, crevice = 0.0;
  vec3 nW = normalize(vNrm) * (gl_FrontFacing ? 1.0 : -1.0);
  vec2 sp2 = vWPos.xz;
  vec3 fwp = fwidth(vWPos);
  float px = max(max(fwp.x, fwp.y), fwp.z);
  ${STATE}
  ${surface}
  ${RESPONSES}
  vec3 V = normalize(cameraPosition - vWPos);
  float nv = max(dot(nW, V), 1e-4);
  float a = max(rough * rough, 0.002);
  vec3 f0 = mix(vec3(0.04), albedo, metal), dc = albedo * (1.0 - metal);
  vec3 col = vec3(0.0);
  float nl = dot(nW, uSunDir);
  if (nl > 0.0) {
    float sh = 1.0;
    if (uShadowOn > 0.5) {
      vec4 sc = uShadowMatrix * vec4(vWPos + nW * 0.03, 1.0);
      if (all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xyz, vec3(1.0)))) sh = texture(uShadowMap, vec3(sc.xy, sc.z - 0.0004));
#ifdef ARENA_FLOOR
      sh = min(sh, rimWallSun(vWPos.xz, uSunDir));
#endif
    }
    vec3 h = normalize(uSunDir + V);
    vec3 F = f0 + (1.0 - f0) * pow(1.0 - max(dot(V, h), 0.0), 5.0);
    col += uSunColor * (sh * nl) * (dc + PI * F * spellD_GGX(max(dot(nW, h), 0.0), a) * spellV_Smith(nv, nl, a))
         + uSunColor * (sh * gFrostGlint);
  }
  col += uAmbient * (0.55 + 0.45 * nW.y) * dc * gAO;
  vec3 R = reflect(-V, nW);
  vec3 env = textureLod(uSkyCube, R, 8.0 * sqrt(rough)).rgb;
#ifdef ARENA_FLOOR
  env *= mix(0.15, 1.0, smoothstep(0.0, 0.18, R.y));
#endif
  vec2 ab = envBRDF(rough, nv);
  col += env * (f0 * ab.x + ab.y) * (gSpecAO * uEnvScale);
  vec3 sd, ss;
  arenaSpellLights(vWPos, nW, V, rough, f0, dc, dot(col + emit, vec3(0.2126, 0.7152, 0.0722)), sd, ss);
  fragColor = vec4(col + (sd + ss) * (1.0 - 0.85 * gGroove) + emit, 1.0);
}`;

const SURFACES = { floor: FLOOR_SURFACE, stone: STONE_SURFACE };
const DEFINES = { floor: 'ARENA_FLOOR', stone: 'ARENA_STONE', dummy: 'ARENA_DUMMY' };

// mode: 'floor' | 'stone' | 'dummy'. surface: GLSL for a custom mode (dummies); uniforms: extra
// per-material uniforms (the status vectors for dummies); parsGLSL goes into both stages,
// vertexParsGLSL (attributes) and vertexGLSL (end of main) into the vertex one.
export function arenaMaterial({ mode = 'stone', kind = 0, uniforms = {}, surface = SURFACES[mode], parsGLSL = '', vertexParsGLSL = '', vertexGLSL = '' } = {}) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    defines: { ...worldDefines(), [DEFINES[mode]]: '' },
    uniforms: { ...U, ...arenaUniforms, ...worldUniforms, uKind: { value: kind }, ...uniforms },
    vertexShader: VERT(vertexParsGLSL + parsGLSL, vertexGLSL),
    fragmentShader: FRAG(surface, parsGLSL),
  });
}

// every geometry drawn with an arena material needs aAO (missing attributes read stale state)
export function withAO(geometry, value = 1) {
  if (!geometry.attributes.aAO) geometry.setAttribute('aAO', new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count).fill(value), 1));
  return geometry;
}

export const STONE = { pillar: 0, rim: 1, pedestal: 2, basin: 4, brass: 6 };
export const stoneMaterial = (kind) => arenaMaterial({ mode: 'stone', kind });
export const floorMaterial = () => arenaMaterial({ mode: 'floor' });
