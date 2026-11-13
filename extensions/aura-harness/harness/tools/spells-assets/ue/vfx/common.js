import * as THREE from 'three';
// ── АДАПТЕР (наша правка): земля арены заменена рельефом мира Ultra-Water. ──
import { islandHeight as groundHeight } from '../../uw/scene/islandHeight.js';

// The shared world every spell, sim and material sees. One file so the GLSL and its JS mirror
// stay side by side:
//   - ARENA: the fixed layout (floor, rim wall, pillars, dummies, pool, caster focus)
//   - U: uniforms shared by reference across every material ({ ...U, own uniforms })
//   - the world texture: lights, forces, impacts and capsule occluders packed into one 64x4
//     RGBA32F DataTexture, uploaded once per frame and read with texelFetch (no uniform-array
//     limits, no per-material uploads)
//   - GLSL chunks to read all of the above, and arenaSDF()/arenaRaycast() mirrored in JS
//
// Conventions: metres, y up, floor at y = 0, linear HDR. Spells never touch the texture;
// they hold handles from lights/forces/impacts/occluders and set plain fields.

// --- arena layout -------------------------------------------------------------------
const pillarAngles = Array.from({ length: 8 }, (_, i) => (i + 0.5) * Math.PI / 4);
export const ARENA = {
  // ── АДАПТЕР (наша правка): арены-коробки у нас нет. ──
  // Заклинания читают radius как границу мира (ветер: `R > ARENA.radius - 0.8`),
  // поэтому границу уводим далеко; стену, колонны и манекены убираем.
  radius: 100000,
  wallThickness: 0.0,
  wallHeight: 0.0,
  pillarRing: 14,
  pillarRadius: 0.6,
  pillarHeight: 0,
  pillars: [],
  focus: new THREE.Vector3(0, 1.6, 12),          // caster's focus orb, on a pedestal
  pedestal: { pos: new THREE.Vector3(0, 0, 12), radius: 0.35, height: 1.15 },
  dummies: [],                      // цели — наши враги (см. src/world/spells.ts)
  dummyRadius: 0.35,     // capsule (x, 0.35, z) -> (x, 1.55, z)
  dummyHeight: 1.9,
  pool: { center: new THREE.Vector2(9.75, 0), half: new THREE.Vector2(2.25, 4.5), depth: 0.15, water: -0.03 },
  ground: { min: new THREE.Vector2(-20, -20), size: 40 },   // ground field covers this square
};

// --- shared uniforms ----------------------------------------------------------------
export const WORLD_W = 64;
export const MAX_LIGHTS = 16, MAX_FORCES = 16, MAX_IMPACTS = 16, MAX_OCCLUDERS = 32;
const worldData = new Float32Array(WORLD_W * 4 * 4);
const worldTex = new THREE.DataTexture(worldData, WORLD_W, 4, THREE.RGBAFormat, THREE.FloatType);
worldTex.magFilter = worldTex.minFilter = THREE.NearestFilter;
worldTex.needsUpdate = true;

const placeholder3D = new THREE.Data3DTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, 1);
placeholder3D.needsUpdate = true;
const placeholder2D = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
placeholder2D.needsUpdate = true;

export const U = {
  uTime: { value: 0 },                 // seconds, scaled by time scale, wraps at 3600
  uDt: { value: 1 / 60 },
  uFrame: { value: 0 },
  uWorld: { value: worldTex },
  uWorldCounts: { value: new THREE.Vector4() },     // lights, forces, impacts, occluders
  uNoise3D: { value: placeholder3D },  // noise.js: 128^3 RGBA8 tileable (r perlin-worley fbm, gba worley f2/f4/f8)
  uCurl3D: { value: placeholder3D },   // noise.js: 64^3 RGBA8 tileable curl, rgb = curl * 0.5 + 0.5
  uBlackbody: { value: placeholder2D },// noise.js: 256x1 RGBA16F, see blackbody() below for the mapping
  uGroundA: { value: placeholder2D },  // GroundField: heat, char, wet, frost
  uGroundB: { value: placeholder2D },  // GroundField: crack, acid, corruption, glow
  uGroundRect: { value: new THREE.Vector4(ARENA.ground.min.x, ARENA.ground.min.y, ARENA.ground.size, 1 / ARENA.ground.size) },
  uSceneDepth: { value: null },        // full-res resolved depth (DepthTexture, [0,1] non-linear)
  uSceneColor: { value: null },        // resolved opaque HDR (refraction)
  uResolution: { value: new THREE.Vector2(1, 1) },
  uFxResolution: { value: new THREE.Vector2(1, 1) },
  uNearFar: { value: new THREE.Vector2(0.1, 400) },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Vector3(1, 1, 1) },  // radiance scale, as UW's sky.sunColor
  uAmbient: { value: new THREE.Vector3(0.1, 0.1, 0.12) },   // average sky irradiance / pi, for particles
  uSkyCube: { value: null },
  uDebug: { value: 0 },                // debug view id (0 = off), read by FX materials for overdraw
};

// --- GLSL ---------------------------------------------------------------------------
const f = (x) => x.toFixed(4);

export const COMMON_GLSL = /* glsl */`
#ifndef PI
#define PI 3.14159265359
#endif
uniform float uTime;
uniform float uDt;
uniform float uFrame;
uniform vec2 uResolution;
uniform vec2 uFxResolution;
uniform vec2 uNearFar;
uniform float uDebug;
// Hash without Sine (Dave Hoskins, MIT)
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash21(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash31(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec4 hash41(float p) { vec4 p4 = fract(vec4(p) * vec4(0.1031, 0.1030, 0.0973, 0.1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
// interleaved gradient noise (Jimenez 2014), rotated per frame
float ign(vec2 px) { px += 5.588238 * mod(uFrame, 64.0); return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
float linearDepth(float d) { return uNearFar.x * uNearFar.y / (uNearFar.y - d * (uNearFar.y - uNearFar.x)); }
vec3 randomInSphere(vec3 r) { float z = r.x * 2.0 - 1.0, a = r.y * 2.0 * PI; float s = sqrt(1.0 - z * z); return vec3(s * cos(a), z, s * sin(a)) * pow(r.z, 1.0 / 3.0); }
vec3 randomOnSphere(vec2 r) { float z = r.x * 2.0 - 1.0, a = r.y * 2.0 * PI; float s = sqrt(1.0 - z * z); return vec3(s * cos(a), z, s * sin(a)); }
mat3 basisFrom(vec3 n) { vec3 t = abs(n.y) < 0.99 ? normalize(cross(n, vec3(0, 1, 0))) : vec3(1, 0, 0); return mat3(t, cross(t, n), n); }
float hgPhase(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }
`;

export const NOISE_GLSL = /* glsl */`
uniform highp sampler3D uNoise3D;
uniform highp sampler3D uCurl3D;
uniform sampler2D uBlackbody;
// p in tile units (one tile = one repeat of the texture)
vec4 noise3v(vec3 p) { return texture(uNoise3D, p); }
float noise3(vec3 p) { return texture(uNoise3D, p).r; }
float worley3(vec3 p) { return texture(uNoise3D, p).g; }
vec3 curl3(vec3 p) { return texture(uCurl3D, p).rgb * 2.0 - 1.0; }
// two-octave fbm from the baked fbm channel (already 4 octaves deep)
float fbm3(vec3 p) { return texture(uNoise3D, p).r * 0.7 + texture(uNoise3D, p * 2.63 + 0.37).r * 0.3; }
// Blackbody chromaticity in linear sRGB, normalised to luminance 1. u = log(K / 500) / log(40),
// i.e. 500 K .. 20000 K logarithmically. Intensity is a separate artist curve.
vec3 blackbody(float kelvin) { return texture(uBlackbody, vec2(clamp(log(kelvin / 500.0) / log(40.0), 0.0, 1.0), 0.5)).rgb; }
`;

export const WORLD_GLSL = /* glsl */`
uniform highp sampler2D uWorld;
uniform vec4 uWorldCounts;
vec4 worldTexel(int row, int i) { return texelFetch(uWorld, ivec2(i, row), 0); }
`;

// floor (pool recess), rim wall ring, then every capsule in the occluder list
export const ARENA_GLSL = WORLD_GLSL + /* glsl */`
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float arenaStatic(vec3 p) {
  vec2 pq = abs(p.xz - vec2(${f(ARENA.pool.center.x)}, ${f(ARENA.pool.center.y)}));
  float floorY = (pq.x < ${f(ARENA.pool.half.x)} && pq.y < ${f(ARENA.pool.half.y)}) ? ${f(ARENA.pool.water)} : 0.0;
  float d = p.y - floorY;
  vec2 q = vec2(abs(length(p.xz) - ${f(ARENA.radius + ARENA.wallThickness / 2)}) - ${f(ARENA.wallThickness / 2)},
                abs(p.y - ${f(ARENA.wallHeight / 2)}) - ${f(ARENA.wallHeight / 2)});
  return min(d, length(max(q, 0.0)) + min(max(q.x, q.y), 0.0));
}
float arenaSDF(vec3 p) {
  float d = arenaStatic(p);
  int n = int(uWorldCounts.w);
  for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
    if (i >= n) break;
    vec4 a = worldTexel(3, i * 2), b = worldTexel(3, i * 2 + 1);
    d = min(d, sdCapsule(p, a.xyz, b.xyz, a.w));
  }
  return d;
}
vec3 arenaNormal(vec3 p) {
  const vec2 e = vec2(0.01, 0.0);
  return normalize(vec3(arenaSDF(p + e.xyy) - arenaSDF(p - e.xyy), arenaSDF(p + e.yxy) - arenaSDF(p - e.yxy), arenaSDF(p + e.yyx) - arenaSDF(p - e.yyx)));
}
`;

// Spell lights: point (type 0), line (1, segment pos -> end), cookie (2, point light with a
// projected pattern: cookie.x = 1 caustic, 2 rune ring; cookie.y scale, cookie.z rotation).
// Karis 2013 windowed inverse-square falloff; line lights use the representative point. The
// first lights flagged shadow (the CPU keeps at most Q.shadowLights of them) get analytic
// capsule shadows from the occluder list (UE4 capsule shadows), penumbra growing with distance.
export const LIGHTS_GLSL = /* glsl */`
bool gLightNoShadow = false;   // set true in volume/media shaders: capsule shadows per step cost too much
struct SpellLight { vec3 pos; float range; vec3 color; int type; vec3 end; float shadow; vec4 cookie; };
SpellLight spellLight(int i) {
  vec4 a = worldTexel(0, i * 4), b = worldTexel(0, i * 4 + 1), c = worldTexel(0, i * 4 + 2), d = worldTexel(0, i * 4 + 3);
  return SpellLight(a.xyz, a.w, b.rgb, int(b.a), c.xyz, c.w, d);
}
float lightFalloff(float d, float range) {
  float x = d / range; x *= x; x *= x;
  float w = clamp(1.0 - x, 0.0, 1.0);
  return w * w / (d * d + 1.0);
}
vec3 closestOnSegment(vec3 a, vec3 b, vec3 p) {
  vec3 ab = b - a;
  return a + ab * clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
}
// closest point on segment a-b to the ray o + t*r (t >= 0)
vec3 closestOnSegmentToRay(vec3 a, vec3 b, vec3 o, vec3 r) {
  vec3 ab = b - a, ao = a - o;
  float abr = dot(ab, r), abab = dot(ab, ab);
  float t = (dot(ao, r) * abr - dot(ao, ab)) / max(abab - abr * abr, 1e-5);
  return a + ab * clamp(t, 0.0, 1.0);
}
// distance between segments p1-q1 and p2-q2; s = parameter on the first (Ericson 5.1.9)
float segSegDist(vec3 p1, vec3 q1, vec3 p2, vec3 q2, out float s) {
  vec3 d1 = q1 - p1, d2 = q2 - p2, r = p1 - p2;
  float a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2);
  float denom = a * e - b * b;
  s = denom > 1e-6 ? clamp((b * f - c * e) / denom, 0.0, 1.0) : 0.0;
  float t = (b * s + f) / max(e, 1e-6);
  if (t < 0.0) { t = 0.0; s = clamp(-c / max(a, 1e-6), 0.0, 1.0); }
  else if (t > 1.0) { t = 1.0; s = clamp((b - c) / max(a, 1e-6), 0.0, 1.0); }
  return length(p1 + d1 * s - (p2 + d2 * t));
}
float capsuleShadow(vec3 p, vec3 lp) {
  vec3 dir = lp - p;
  float len = length(dir);
  p += dir * min(0.15 / max(len, 1e-3), 0.5);   // start off the surface (own capsule)
  float vis = 1.0;
  int n = int(uWorldCounts.w);
  for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
    if (i >= n) break;
    vec4 a = worldTexel(3, i * 2), b = worldTexel(3, i * 2 + 1);
    if (abs(b.w - 3.0) < 0.5) continue;   // shields are glass: they collide but cast no shadow
    // bounding-sphere reject first: most capsules are nowhere near this shadow ray
    vec3 m = 0.5 * (a.xyz + b.xyz), q = closestOnSegment(p, lp, m) - m;
    float R = 0.5 * length(b.xyz - a.xyz) + a.w + 0.04 + 0.18 * len;
    if (dot(q, q) > R * R) continue;
    float s, d = segSegDist(p, lp, a.xyz, b.xyz, s);
    float pen = 0.04 + 0.18 * s * len;
    vis *= smoothstep(a.w - pen * 0.5, a.w + pen, d);
  }
  return vis;
}
float lightCookie(SpellLight L, vec3 p) {
  if (L.cookie.x < 0.5) return 1.0;
  vec2 q = (p.xz - L.pos.xz) * L.cookie.y;
  float c = cos(L.cookie.z), s = sin(L.cookie.z);
  q = mat2(c, -s, s, c) * q;
  if (L.cookie.x < 1.5) {   // caustic: folded sines, cheap and shimmering
    vec2 w = q * 3.0 + vec2(sin(q.y * 2.1 + uTime * 1.3), cos(q.x * 1.7 - uTime * 1.1));
    float k = abs(sin(w.x) * sin(w.y));
    return 0.35 + 2.2 * pow(1.0 - k, 6.0);
  }
  float r = length(q);   // rune ring
  float ring = smoothstep(0.06, 0.0, abs(r - 1.0)) + smoothstep(0.04, 0.0, abs(r - 0.78));
  float spokes = smoothstep(0.92, 1.0, abs(cos(atan(q.y, q.x) * 6.0))) * step(r, 1.0) * step(0.78, r);
  return 0.2 + 3.0 * clamp(ring + spokes, 0.0, 1.0);
}
// light vector + radiance arriving at p from light i (no BRDF). For line lights the point used
// is the closest one to the reflection ray r for specular (pass r) or to p for diffuse (r = 0).
vec3 spellLightRaw(SpellLight L, vec3 p, vec3 r, out vec3 l, out vec3 lp) {
  lp = L.pos;
  if (L.type == 1) lp = dot(r, r) > 0.0 ? closestOnSegmentToRay(L.pos, L.end, p, r) : closestOnSegment(L.pos, L.end, p);
  vec3 d = lp - p;
  float dist = length(d);
  l = d / max(dist, 1e-4);
  vec3 c = L.color * lightFalloff(dist, L.range);
  if (L.type == 2) c *= lightCookie(L, p);
  return c;
}
// shadow only where the light actually arrives (outside its range the falloff is exactly 0)
float spellLightShadow(SpellLight L, vec3 p, vec3 lp, vec3 c) {
  return (L.shadow > 0.5 && !gLightNoShadow && dot(c, c) > 0.0) ? capsuleShadow(p, lp) : 1.0;
}
vec3 spellLightIncoming(SpellLight L, vec3 p, vec3 r, out vec3 l) {
  vec3 lp, c = spellLightRaw(L, p, r, l, lp);
  return c * spellLightShadow(L, p, lp, c);
}
// sum of spell-light irradiance / pi on a surface (n) or, with n = 0, omnidirectional (media)
vec3 spellLightDiffuse(vec3 p, vec3 n) {
  vec3 sum = vec3(0.0), l;
  int count = int(uWorldCounts.x);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= count) break;
    vec3 c = spellLightIncoming(spellLight(i), p, vec3(0.0), l);
    sum += c * (dot(n, n) > 0.0 ? max(dot(n, l), 0.0) : 0.5);
  }
  return sum;
}
// in-scatter for media / volumes: Henyey-Greenstein phase towards the viewer (v = to camera)
vec3 spellLightScatter(vec3 p, vec3 v, float g) {
  vec3 sum = vec3(0.0), l;
  int count = int(uWorldCounts.x);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= count) break;
    vec3 c = spellLightIncoming(spellLight(i), p, vec3(0.0), l);
    sum += c * hgPhase(dot(l, -v), g) * 4.0 * PI;
  }
  return sum;
}
float spellD_GGX(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float spellV_Smith(float nv, float nl, float a) { return 0.5 / mix(2.0 * nl * nv, nl + nv, a); }
// GGX + Lambert from every spell light; diffuse and specular returned apart (radiance)
void spellLightPBR(vec3 p, vec3 n, vec3 v, float roughness, vec3 f0, vec3 diffColor, out vec3 diffuse, out vec3 specular) {
  diffuse = vec3(0.0); specular = vec3(0.0);
  float a = max(roughness * roughness, 0.002);
  float nv = max(dot(n, v), 1e-4);
  vec3 r = reflect(-v, n), l;
  int count = int(uWorldCounts.x);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= count) break;
    SpellLight L = spellLight(i);
    vec3 lp, cd = spellLightRaw(L, p, vec3(0.0), l, lp);
    if (dot(cd, cd) == 0.0) continue;
    float sh = spellLightShadow(L, p, lp, cd);   // one shadow per light: the specular point reuses it
    cd *= sh;
    diffuse += cd * diffColor * max(dot(n, l), 0.0) / PI;
    vec3 cs = L.type == 1 ? spellLightRaw(L, p, r, l, lp) * sh : cd;
    vec3 h = normalize(l + v);
    float nl = max(dot(n, l), 0.0), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
    vec3 F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
    float aL = L.type == 1 ? min(a + 0.25 / max(2.0 * distance(lp, p), 0.25), 1.0) : a;   // line lights are ~0.25 m tubes, not hard streaks
    specular += cs * F * (spellD_GGX(nh, aL) * spellV_Smith(nv, nl, aL) * nl) * (a / aL);
  }
}
`;

// Forces act on every particle (scaled by its kind's force response) and warp fire volumes.
//   0 wind      t2.xyz dir, t1 = (speed m/s, gustiness, coupling, -)
//   1 vortex    pos = base, t2.xyz axis, t1 = (core R, circulation G, updraft W, inflow), t2.w height
//   2 attractor t1 = (strength, softening, kill radius, range)   (negative strength repels)
//   3 orbit     Kepler disk: t2.xyz axis, t1 = (GM, inner, outer, coupling)
//   4 shock     expanding shell: t1 = (radius, thickness, impulse, -)
//   5 push      cone gust: t2.xyz dir, t1 = (speed, radius, length, coupling)
export const FORCES_GLSL = /* glsl */`
vec3 forceAccel(vec3 p, vec3 v, inout float kill) {
  vec3 acc = vec3(0.0);
  int n = int(uWorldCounts.y);
  for (int i = 0; i < ${MAX_FORCES}; i++) {
    if (i >= n) break;
    vec4 a = worldTexel(1, i * 4), k = worldTexel(1, i * 4 + 1), b = worldTexel(1, i * 4 + 2);
    int type = int(a.w);
    vec3 d = p - a.xyz;
    if (type == 0) {
      float gust = 1.0 + k.y * sin(uTime * 1.7 + dot(p, vec3(0.13, 0.05, 0.11))) * sin(uTime * 0.53 + p.x * 0.07);
      acc += (b.xyz * k.x * gust - v) * k.z;
    } else if (type == 1) {
      vec3 ax = b.xyz;
      float h = dot(d, ax);
      vec3 radial = d - ax * h;
      float r = length(radial);
      if (h > -0.5 && h < b.w && r < k.x * 6.0) {
        vec3 er = radial / max(r, 1e-3), et = cross(ax, er);
        float vt = r < k.x ? k.y / (2.0 * PI) * r / (k.x * k.x) : k.y / (2.0 * PI * r);
        float up = k.z * exp(-r * r / (k.x * k.x * 2.0));
        vec3 target = et * vt + ax * up - er * k.w * smoothstep(k.x * 6.0, k.x, r) * (1.0 - smoothstep(0.0, 2.0, h) * 0.6);
        acc += (target - v) * 3.0 * smoothstep(k.x * 6.0, k.x * 3.0, r);
      }
    } else if (type == 2) {
      float r2 = dot(d, d);
      if (r2 < k.w * k.w) {
        acc -= normalize(d) * k.x / (r2 + k.y * k.y);
        if (r2 < k.z * k.z) kill = 1.0;
      }
    } else if (type == 3) {
      vec3 ax = b.xyz;
      float h = dot(d, ax);
      vec3 radial = d - ax * h;
      float r = length(radial);
      if (r > k.y * 0.5 && r < k.z) {
        vec3 et = cross(ax, radial / r);
        vec3 target = et * sqrt(k.x / r) - ax * h * 4.0;
        acc += (target - v) * k.w;
      }
      if (r < k.y) kill = max(kill, step(abs(h), 0.5));
    } else if (type == 4) {
      float r = length(d);
      float shell = 1.0 - clamp(abs(r - k.x) / max(k.y, 1e-3), 0.0, 1.0);
      acc += d / max(r, 1e-3) * k.z * shell;
    } else if (type == 5) {
      float along = dot(d, b.xyz);
      float off = length(d - b.xyz * along);
      if (along > -0.5 && along < k.z && off < k.y) acc += (b.xyz * k.x - v) * k.w * (1.0 - off / k.y);
    }
  }
  return acc;
}
`;

// Spherical "volume decals" for surfaces: weights per impact type at p (amount x falloff x fade).
// A: x scorch/heat, y frost, z wet, w magma glow.  B: x acid, y holy glow, z corruption, w electric.
// Each impact also carries a colour (t2.rgb) for the glow types.
export const IMPACTS_GLSL = /* glsl */`
void impactWeights(vec3 p, out vec4 wa, out vec4 wb, out vec3 glowColor) {
  wa = vec4(0.0); wb = vec4(0.0); glowColor = vec3(0.0);
  int n = int(uWorldCounts.z);
  for (int i = 0; i < ${MAX_IMPACTS}; i++) {
    if (i >= n) break;
    vec4 a = worldTexel(2, i * 4), b = worldTexel(2, i * 4 + 1), c = worldTexel(2, i * 4 + 2);
    float w = b.z * smoothstep(1.0, 0.55, length(p - a.xyz) / a.w);
    if (w <= 0.0) continue;
    int t = int(b.x);
    if (t < 4) wa[t] += w; else wb[t - 4] += w;
    glowColor += c.rgb * w;
  }
}
`;

export const GROUND_GLSL = /* glsl */`
uniform sampler2D uGroundA;
uniform sampler2D uGroundB;
uniform vec4 uGroundRect;   // min x, min z, size, 1 / size
vec2 groundUV(vec2 xz) { return (xz - uGroundRect.xy) * uGroundRect.w; }
vec4 groundA(vec2 xz) { return texture(uGroundA, groundUV(xz)); }   // heat, char, wet, frost
vec4 groundB(vec2 xz) { return texture(uGroundB, groundUV(xz)); }   // crack, acid, corruption, glow
`;

// --- FX pass (half-res MRT, weighted-blended OIT; McGuire & Bavoil 2013) -------------
// Every FX-pass material is a RawShaderMaterial (GLSL3) using FX_VERT_HEAD / FX_FRAG_HEAD and
// ...FX_BLENDING, and ends with fxOut(). One blend state for the three attachments:
//   0 media    (w*c*a, a)  -> rgb sum, alpha = revealage product
//   1 weight   (w*a, distortion.xy, a)
//   2 emission (rgb, 0)    -> additive, never occluded by media unless the composite says so
export const FX_BLENDING = {
  transparent: true, depthWrite: false, depthTest: true,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

export const FX_VERT_HEAD = /* glsl */`
precision highp float;
precision highp int;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
in vec3 position;
`;

export const FX_FRAG_HEAD = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform highp sampler2D uSceneDepth;
layout(location = 0) out vec4 fxMedia;
layout(location = 1) out vec4 fxWeight;
layout(location = 2) out vec4 fxEmit;
`;

// needs COMMON_GLSL. viewZ positive distance along the view axis.
export const FX_OUT_GLSL = /* glsl */`
// full-res scene depth under this half-res fragment (nearest of the 2x2 would be ideal; the
// prepass already made the FX depth the farthest, this is the soft-fade reference)
// farthest depth of this half-res pixel's full-res block, the same value the depth prepass
// wrote: soft fade and volume clipping must agree with the depth test, or smoke gaps open
// along every silhouette when the composite picks the far tap there
float sceneViewZ() {
  ivec2 b = ivec2(floor(floor(gl_FragCoord.xy) * uResolution / uFxResolution));
  ivec2 m = ivec2(uResolution) - 1;
  float d = texelFetch(uSceneDepth, min(b, m), 0).r;
  d = max(d, texelFetch(uSceneDepth, min(b + ivec2(1, 0), m), 0).r);
  d = max(d, texelFetch(uSceneDepth, min(b + ivec2(0, 1), m), 0).r);
  d = max(d, texelFetch(uSceneDepth, min(b + ivec2(1, 1), m), 0).r);
  return linearDepth(d);
}
float softFade(float viewZ, float dist) { return clamp((sceneViewZ() - viewZ) / dist, 0.0, 1.0); }
float wboitWeight(float viewZ, float a) {
  return a * clamp(10.0 / (1e-5 + pow(viewZ / 10.0, 2.0) + pow(viewZ / 200.0, 6.0)), 0.01, 30.0);
}
// col: lit media colour, a: coverage, emit: additive HDR emission, dist: screen-space UV offset
void fxOut(vec3 col, float a, vec3 emit, vec2 dist, float viewZ) {
  a = clamp(a, 0.0, 0.999);   // 0.995 let a bright HDR sky print through opaque soot
  if (uDebug > 0.5 && uDebug < 1.5) { fxMedia = vec4(0.0, 0.0, 0.0, 0.0); fxWeight = vec4(0.0); fxEmit = vec4(0.04, 0.012, 0.004, 0.0); return; }
  float w = wboitWeight(viewZ, a);
  fxMedia = vec4(col * a * w, a);
  fxWeight = vec4(a * w, dist, a);
  fxEmit = vec4(emit, 0.0);
}
`;

// full-res additive emissive (sparks, motes, bolt cores, sigils) into the HDR target. Pure
// ONE/ONE on rgb whatever alpha the shader writes (three's AdditiveBlending scales by src alpha),
// destination alpha kept (the planar reflection uses alpha as its 'something drawn' mask).
export const LINES_BLENDING = {
  transparent: true, depthWrite: false, depthTest: true,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
};

// --- JS side: pools packed into the world texture -------------------------------------
function makePool(n, init) {
  const items = Array.from({ length: n }, (_, i) => ({ index: i, active: false, ...init() }));
  return {
    items,
    acquire() {
      const it = items.find((x) => !x.active);
      if (!it) return null;
      Object.assign(it, init(), { active: true });
      return it;
    },
  };
}

// light: pos, range, color (linear), intensity, type 0 point / 1 line / 2 cookie, end (line),
// shadow (wants capsule shadows), cookie [pattern, scale, rotation, 0]
export const lights = makePool(MAX_LIGHTS, () => ({
  pos: new THREE.Vector3(), range: 8, color: new THREE.Color(1, 1, 1), intensity: 0, type: 0,
  end: new THREE.Vector3(), shadow: false, cookie: [0, 1, 0, 0],
  release() { this.active = false; },
}));

export const forces = makePool(MAX_FORCES, () => ({
  pos: new THREE.Vector3(), type: 0, p: [0, 0, 0, 0], dir: new THREE.Vector3(0, 1, 0), w: 0,
  release() { this.active = false; },
}));

// impacts fade on their own: amount * (1 - age / life), oldest replaced when full
const IMPACT_TYPES = { scorch: 0, frost: 1, wet: 2, magma: 3, acid: 4, holy: 5, corruption: 6, electric: 7 };
const impactList = Array.from({ length: MAX_IMPACTS }, () => ({ pos: new THREE.Vector3(), radius: 1, type: 0, age: 1e9, life: 1, amount: 0, color: new THREE.Color() }));
const DEFAULT_IMPACT = new THREE.Color(1, 0.4, 0.1);
export const impacts = {
  types: IMPACT_TYPES,
  add(type, pos, radius, amount = 1, life = 6, color = null) {
    let it = impactList[0];
    for (const x of impactList) if (x.age / x.life > it.age / it.life) it = x;
    it.pos.copy(pos); it.radius = radius; it.type = typeof type === 'string' ? IMPACT_TYPES[type] : type;
    it.amount = amount; it.life = life; it.age = 0;
    it.color.copy(color ?? DEFAULT_IMPACT);
    return it;
  },
  clear() { for (const x of impactList) x.age = 1e9; },
};

// capsules (a, b, radius); static ones are added once by the arena, dynamic ones (spikes,
// shields) are acquired and released. kind: 0 stone, 1 dummy, 2 spike, 3 shield, 4 pedestal
const occluderList = [];
export const occluders = {
  list: occluderList,
  add(a, b, radius, kind = 0) {
    if (occluderList.length >= MAX_OCCLUDERS) return null;
    const o = { a: a.clone(), b: b.clone(), radius, kind, release() { const i = occluderList.indexOf(o); if (i >= 0) occluderList.splice(i, 1); } };
    occluderList.push(o);
    return o;
  },
};

// The CPU keeps at most `maxLights` lights and `maxShadowed` shadowed ones (the brightest).
const lightOrder = [];
export function packWorld(dt, { maxLights = MAX_LIGHTS, maxShadowed = 4 } = {}) {
  const d = worldData;
  d.fill(0);
  // lights, brightest first so a tier cut drops the dim ones
  lightOrder.length = 0;
  for (const l of lights.items) if (l.active && l.intensity > 1e-3) lightOrder.push(l);
  lightOrder.sort((a, b) => b.intensity * b.range - a.intensity * a.range);
  const nl = Math.min(lightOrder.length, maxLights);
  let shadowed = 0;
  for (let i = 0; i < nl; i++) {
    const l = lightOrder[i], o = (0 * WORLD_W + i * 4) * 4;
    const sh = l.shadow && shadowed < maxShadowed ? (shadowed++, 1) : 0;
    d.set([l.pos.x, l.pos.y, l.pos.z, l.range, l.color.r * l.intensity, l.color.g * l.intensity, l.color.b * l.intensity, l.type,
      l.end.x, l.end.y, l.end.z, sh, l.cookie[0], l.cookie[1], l.cookie[2], l.cookie[3]], o);
  }
  let nf = 0;
  for (const fo of forces.items) {
    if (!fo.active) continue;
    const o = (1 * WORLD_W + nf * 4) * 4;
    d.set([fo.pos.x, fo.pos.y, fo.pos.z, fo.type, fo.p[0], fo.p[1], fo.p[2], fo.p[3], fo.dir.x, fo.dir.y, fo.dir.z, fo.w], o);
    nf++;
  }
  let ni = 0;
  for (const it of impactList) {
    it.age += dt;
    if (it.age >= it.life) continue;
    const o = (2 * WORLD_W + ni * 4) * 4;
    const fade = 1 - it.age / it.life;
    d.set([it.pos.x, it.pos.y, it.pos.z, it.radius, it.type, it.age, it.amount * fade * fade, 0, it.color.r, it.color.g, it.color.b, 0], o);
    ni++;
  }
  const no = occluderList.length;
  for (let i = 0; i < no; i++) {
    const c = occluderList[i], o = (3 * WORLD_W + i * 2) * 4;
    d.set([c.a.x, c.a.y, c.a.z, c.radius, c.b.x, c.b.y, c.b.z, c.kind], o);
  }
  U.uWorldCounts.value.set(nl, nf, ni, no);
  worldTex.needsUpdate = true;
}

// --- JS mirror of arenaSDF (click targeting, projectile impacts, spawn placement) -----
const _pa = new THREE.Vector3(), _ba = new THREE.Vector3();
function sdCapsule(p, a, b, r) {
  _pa.subVectors(p, a); _ba.subVectors(b, a);
  const h = Math.min(1, Math.max(0, _pa.dot(_ba) / Math.max(_ba.dot(_ba), 1e-6)));
  return _pa.addScaledVector(_ba, -h).length() - r;
}
export function arenaStatic(p) {
  // ── АДАПТЕР (наша правка): вместо пола арены и бортика — рельеф острова. ──
  return p.y - groundHeight(p.x, p.z);
}
export function arenaSDF(p) {
  let d = arenaStatic(p);
  for (const c of occluderList) d = Math.min(d, sdCapsule(p, c.a, c.b, c.radius));
  return d;
}
const _rp = new THREE.Vector3();
// sphere trace; returns distance along dir or -1
export function arenaRaycast(origin, dir, maxDist = 200) {
  let t = 0;
  for (let i = 0; i < 256 && t < maxDist; i++) {
    const d = arenaSDF(_rp.copy(origin).addScaledVector(dir, t));
    if (d < 0.002) return t;
    t += Math.max(d, 0.01);
  }
  return -1;
}
