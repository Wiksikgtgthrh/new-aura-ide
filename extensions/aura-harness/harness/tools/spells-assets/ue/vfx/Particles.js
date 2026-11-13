import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT } from '../engine/fullscreen.js';
import {
  U, COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, ARENA_GLSL, LIGHTS_GLSL, FORCES_GLSL, GROUND_GLSL,
  FX_BLENDING, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, LINES_BLENDING, ARENA,
} from './common.js';
import { Q } from '../engine/quality.js';

// One GPU particle pool for every spell (PLAN 2.5).
//  - State: three RGBA32F textures, ping-ponged and written by one MRT draw:
//      S0 = (pos.xyz, age)  S1 = (vel.xyz, life)  S2 = (kind + size * 0.1, seed, lastCollideTime, custom)
//    fp16 isn't enough: v * dt drops below fp16 precision at arena scale.
//  - Behaviour lives in a kind table texture (Niagara-style parameters, not code): sliders write
//    texels, nothing recompiles.
//  - Three render styles own row ranges so each draw is homogeneous:
//      glow   full-res additive velocity-stretched sparks / motes (lines scene)
//      media  half-res spherical billboards, weighted-blended OIT (fx scene)
//      debris instanced lit meshes (opaque scene)
//    Each range starts with the field-emitter blocks, then a ring buffer the CPU allocates from.
//  - Emission: per-frame records in a small float texture; texels inside a record respawn from
//    it. Records only exist on frames that emit, and a texel tests the frame's spans first.
//  - Kind morphing on collision replaces GPU sub-emitters (droplet -> splash, ember -> smoulder);
//    field emitters respawn dead texels on the floor where the ground field says so (steam, ground
//    flames, frost mist) with no CPU involvement.

const KW = 11;            // kind table texels per kind
const MAX_KINDS = 1024;   // ~120 spells x ~6 kinds; one 10x1024 RGBA32F table (160 KB)
const MAX_REC = 64;       // emission records per frame
const REC_W = 5;          // texels per record
const MAX_FIELD = 8;
const LOG_N = 2048;       // emission log entries per style
const STYLES = ['glow', 'media', 'debris'];
const PAINT_CHANNELS = ['heat', 'char', 'wet', 'frost', 'crack', 'acid', 'corruption', 'glow'];
const SHAPES = { sphere: 0, shell: 1, disk: 2, ring: 3, line: 4, cone: 5 };
const MESHES = ['rock', 'shard', 'leaf'];

const KIND_DEFAULTS = {
  style: 'glow', flicker: 0, drag: 0.5, gravity: 0, buoyancy: 0, curl: 0, curlScale: 0.15, forceResponse: 1,
  restitution: -1, friction: 0.2, life: [1, 1], size: [0.05, 0.05], stretch: 0, emissive: 1,
  temp: null, color: ['#ffffff', '#ffffff'], alpha: [1, 0], paints: null, paintAmount: 0.3,
  morph: null, killOnCollide: false, absorbing: false, toSmokeAt: 0, smokeAlbedo: 0.12, density: 3,
  distortion: 0, fadeIn: 0.05, fadeOut: 0.3, spin: 0, sizePow: 1, softness: 1, lightResponse: 1, mesh: 'rock',
  erosion: 0.5, orbit: false,
};

// --- shared GLSL ---------------------------------------------------------------------
const STATE_GLSL = (W) => /* glsl */`
uniform highp sampler2D uS0;
uniform highp sampler2D uS1;
uniform highp sampler2D uS2;
uniform highp sampler2D uKinds;
const int PW = ${W};
vec4 kindTexel(int kind, int i) { return texelFetch(uKinds, ivec2(i, kind), 0); }
ivec2 texelOf(int idx) { return ivec2(idx % PW, idx / PW); }
`;

// instance -> texel: field blocks first, then the live window of the ring
const INDEX_GLSL = /* glsl */`
uniform int uStyleStart;
uniform int uStyleCount;
uniform int uFieldCount;
uniform int uRingBase;
int particleIndex(int id) {
  int ring = uStyleCount - uFieldCount;
  int local = id < uFieldCount ? id : uFieldCount + (uRingBase + id - uFieldCount) % max(ring, 1);
  return uStyleStart + local;
}
`;

// colour / alpha / size over life, shared by every style
const LOOK_GLSL = /* glsl */`
struct Look { vec3 color; float alpha; float size; float smoke; float emissive; };
Look particleLook(int kind, float t, float sizeScale) {
  vec4 k2 = kindTexel(kind, 2), k3 = kindTexel(kind, 3), k4 = kindTexel(kind, 4), k5 = kindTexel(kind, 5);
  vec4 k7 = kindTexel(kind, 7), k8 = kindTexel(kind, 8);
  Look l;
  l.size = mix(k2.z, k2.w, pow(t, k8.w)) * sizeScale;
  float fade = smoothstep(0.0, max(k8.x, 1e-3), t) * (1.0 - smoothstep(1.0 - max(k8.y, 1e-3), 1.0, t));
  l.alpha = mix(k4.a, k5.a, t) * fade;
  l.emissive = k3.y;
  if (k3.z > 0.0) {
    float T = mix(k3.z, k3.w, t);
    l.color = blackbody(T) * pow(T / max(k3.z, 1.0), 3.0);   // hot starts bright and cools fast
  } else {
    l.color = mix(k4.rgb, k5.rgb, t);
  }
  l.smoke = k7.x > 0.0 ? smoothstep(k7.x, min(k7.x + 0.25, 1.0), t) : 0.0;
  return l;
}
`;

// --- sim ---------------------------------------------------------------------------------
const SIM_FRAG = (W) => /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
${COMMON_GLSL}
${NOISE_GLSL}
${ARENA_GLSL}
${FORCES_GLSL}
${GROUND_GLSL}
${STATE_GLSL(W)}
uniform highp sampler2D uEmitTex;
uniform int uEmitCount;
uniform vec2 uSpan[6];
uniform int uSpanCount;
uniform highp sampler2D uFieldTex;
uniform int uFieldCount;
uniform float uSimDt;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;

void spawn(int kind, vec3 pos, vec3 vel, float lifeScale, float sizeScale, float seed) {
  vec4 k2 = kindTexel(kind, 2);
  float life = mix(k2.x, k2.y, hash11(seed * 7.13)) * lifeScale;
  o0 = vec4(pos, 0.0);
  o1 = vec4(vel, max(life, 1e-3));
  o2 = vec4(float(kind) + clamp(sizeScale, 0.0, 9.99) * 0.1, seed, -1e4, 0.0);
}

bool tryEmit(int idx) {
  bool inSpan = false;
  for (int s = 0; s < 6; s++) {
    if (s >= uSpanCount) break;
    if (float(idx) >= uSpan[s].x && float(idx) < uSpan[s].y) { inSpan = true; break; }
  }
  if (!inSpan) return false;
  for (int r = 0; r < ${MAX_REC}; r++) {
    if (r >= uEmitCount) break;
    vec4 e0 = texelFetch(uEmitTex, ivec2(0, r), 0);
    int j = idx - int(e0.x);
    if (j < 0 || j >= int(e0.y)) continue;
    vec4 e1 = texelFetch(uEmitTex, ivec2(1, r), 0), e2 = texelFetch(uEmitTex, ivec2(2, r), 0);
    vec4 e3 = texelFetch(uEmitTex, ivec2(3, r), 0), e4 = texelFetch(uEmitTex, ivec2(4, r), 0);
    float seed = fract(e3.w + float(j) * 0.618034) * 1000.0 + float(j) * 0.001;
    vec4 h = hash41(seed);
    vec3 h2 = hash31(seed + 17.0);
    int shape = int(e0.w);
    vec3 pos = e1.xyz, radial = vec3(0.0);
    if (shape == 0) { vec3 d = randomInSphere(h.xyz); pos += d * e1.w; radial = normalize(d + 1e-5); }
    else if (shape == 1) { vec3 d = randomOnSphere(h.xy); pos += d * e1.w; radial = d; }
    else if (shape == 2 || shape == 3) {
      float a = h.x * 2.0 * PI, r = shape == 2 ? sqrt(h.y) : 1.0;
      radial = vec3(cos(a), 0.0, sin(a));
      pos += radial * r * e1.w;
    }
    else if (shape == 4) {
      vec3 d = randomInSphere(h2);
      pos = mix(e1.xyz, e3.xyz, h.x) + d * e1.w;
      radial = normalize(d + 1e-5);
    }
    else {   // cone around e3.xyz, half-angle e4.w
      pos += randomInSphere(h2) * e1.w;
      vec3 ax = normalize(e3.xyz + 1e-6);
      float ct = mix(1.0, cos(e4.w), h.x), st = sqrt(1.0 - ct * ct), ph = h.y * 2.0 * PI;
      radial = basisFrom(ax) * vec3(st * cos(ph), st * sin(ph), ct);
    }
    vec3 vel = e2.xyz + randomInSphere(hash31(seed + 31.0)) * e2.w + radial * e4.x * mix(0.6, 1.0, h.w);
    spawn(int(e0.z), pos, vel, e4.z, e4.y, seed);
    return true;
  }
  return false;
}

// field emitters: dead texels in a block respawn on the floor where the ground field qualifies
bool tryField(int idx) {
  for (int f = 0; f < ${MAX_FIELD}; f++) {
    if (f >= uFieldCount) break;
    vec4 f0 = texelFetch(uFieldTex, ivec2(0, f), 0);
    int j = idx - int(f0.x);
    if (j < 0 || j >= int(f0.y)) continue;
    vec4 wa = texelFetch(uFieldTex, ivec2(1, f), 0), wb = texelFetch(uFieldTex, ivec2(2, f), 0);
    vec4 f3 = texelFetch(uFieldTex, ivec2(3, f), 0);
    float seed = hash12(vec2(float(idx), mod(uFrame, 4096.0))) * 1000.0;
    vec4 h = hash41(seed);
    float a = h.x * 2.0 * PI, r = sqrt(h.y) * ${(ARENA.radius - 0.4).toFixed(2)};
    vec2 xz = vec2(cos(a), sin(a)) * r;
    float s = dot(groundA(xz), wa) + dot(groundB(xz), wb) - f0.w;
    if (h.z > s * f3.x * uSimDt) return true;   // stays dead this frame
    vec3 pos = vec3(xz.x, 0.04, xz.y);
    vec2 pq = abs(xz - vec2(${ARENA.pool.center.x.toFixed(3)}, ${ARENA.pool.center.y.toFixed(3)}));
    if (pq.x < ${ARENA.pool.half.x.toFixed(3)} && pq.y < ${ARENA.pool.half.y.toFixed(3)}) pos.y += ${ARENA.pool.water.toFixed(3)};
    vec3 vel = vec3(0.0, f3.w, 0.0) + randomInSphere(hash31(seed + 5.0)) * 0.3;
    spawn(int(f0.z), pos, vel, f3.y, f3.z * clamp(s * 2.0, 0.5, 1.5), seed);
    return true;
  }
  return false;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int idx = px.y * PW + px.x;
  vec4 s0 = texelFetch(uS0, px, 0);
  vec4 s1 = texelFetch(uS1, px, 0);
  bool dead = s0.w >= s1.w;
  if (dead) {
    o0 = vec4(0.0, -1000.0, 0.0, 1e9); o1 = vec4(0.0, 0.0, 0.0, 1.0); o2 = vec4(0.0, 0.0, -1e4, 0.0);
    if (!tryEmit(idx)) tryField(idx);
    return;
  }
  // a texel re-allocated by the ring this frame restarts even if still alive (pool full: oldest die)
  if (tryEmit(idx)) return;

  vec4 s2 = texelFetch(uS2, px, 0);
  int kind = int(s2.x);
  float sizeScale = fract(s2.x) * 10.0;
  vec4 k0 = kindTexel(kind, 0), k1 = kindTexel(kind, 1), k2 = kindTexel(kind, 2), k6 = kindTexel(kind, 6);
  vec4 k8 = kindTexel(kind, 8);
  float dt = uSimDt;
  vec3 pos = s0.xyz, vel = s1.xyz;
  float age = s0.w + dt, life = s1.w, t = age / life;
  float kill = 0.0;

  vec3 acc = vec3(0.0, k0.z * (1.0 - 0.6 * t) - k0.y, 0.0);
  if (k0.w != 0.0) acc += curl3(pos * k1.x + vec3(0.0, uTime * 0.05, 0.0) + s2.y * 0.01) * k0.w;
  if (k1.y != 0.0) acc += forceAccel(pos, vel, kill) * k1.y;
  vel += acc * dt;
  vel *= exp(-k0.x * dt);
  vec3 np = pos + vel * dt;

  // collision with the arena (floor, rim, pillars, dummies, dynamic capsules)
  float custom = s2.w, collide = s2.z;
  if (k1.z >= 0.0) {
    float rad = max(mix(k2.z, k2.w, t) * sizeScale * 0.5, 0.01);
    float d = arenaSDF(np);
    if (d < rad) {
      vec3 n = arenaNormal(np);
      np += n * (rad - d);
      float vn = dot(vel, n);
      if (vn < 0.0) {
        vec3 vt = vel - n * vn;
        vel = vt * (1.0 - k1.w) - n * vn * k1.z;
      }
      collide = uTime;
      int flags = int(k6.w);
      if ((flags & 2) != 0) kill = 1.0;
      if (k6.z > 0.5) {   // morph into another kind, keeping position and the bounce
        int m = int(k6.z) - 1;
        vec4 m2 = kindTexel(m, 2);
        kind = m; age = 0.0;
        life = mix(m2.x, m2.y, hash11(s2.y * 3.7));
      }
      // debris: remember when it came to rest (its spin freezes there)
      if (custom <= 0.0 && dot(vel, vel) < 0.04 && k6.x > 2.5) custom = age;
    }
  }
  // orbit hook: keep a Kepler-ish disk tidy (accretion), uses force 'orbit' for speed
  if (kill > 0.5) age = life;
  o0 = vec4(np, age);
  o1 = vec4(vel, life);
  o2 = vec4(float(kind) + sizeScale * 0.1, s2.y, collide, custom);
}`;

// --- glow: velocity-stretched additive quads, full res ---------------------------------
const GLOW_VERT = (W) => /* glsl */`
precision highp float;
precision highp int;
${COMMON_GLSL}
${NOISE_GLSL}
${STATE_GLSL(W)}
${INDEX_GLSL}
${LOOK_GLSL}
out vec2 vUv;
out vec3 vColor;
out float vSoft;
void main() {
  int idx = particleIndex(gl_InstanceID);
  ivec2 px = texelOf(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColor = vec3(0.0);
  if (s0.w >= s1.w) return;
  vec4 s2 = texelFetch(uS2, px, 0);
  int kind = int(s2.x);
  float t = s0.w / s1.w;
  Look l = particleLook(kind, t, fract(s2.x) * 10.0);
  vec4 k3 = kindTexel(kind, 3);
  vec3 headV = (viewMatrix * vec4(s0.xyz, 1.0)).xyz;
  vec3 tailV = (viewMatrix * vec4(s0.xyz - s1.xyz * k3.x, 1.0)).xyz;
  float viewZ = max(-headV.z, 0.05);
  float pxWorld = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float size = l.size, w = max(size, 1.5 * pxWorld);
  float aa = size / w;   // Humus phone-wire AA: keep energy when clamped to 1.5 px
  vec2 axis = tailV.xy - headV.xy;
  float len = length(axis);
  vec2 dir = len > 1e-4 ? axis / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  // quad: x in [-1, 1] spans head (-1) .. tail (+1) plus caps, y across
  vec2 off = dir * (position.x < 0.0 ? -w : len + w) + perp * position.y * w;
  vec3 pv = headV + vec3(off, 0.0);
  gl_Position = projectionMatrix * vec4(pv, 1.0);
  vUv = vec2(position.x < 0.0 ? -1.0 : 1.0, position.y);
  vSoft = len / (len + 2.0 * w);   // how much of the quad is the stretched body
  float nearFade = smoothstep(0.3, 1.2, viewZ);
  // stretching spreads the same energy over a longer streak (motion-blur conservation)
  float fk = kindTexel(kind, 10).x, ph = s2.y * 97.0 + s0.w * mix(9.0, 23.0, fract(s2.y * 13.7));
  vColor = l.color * l.emissive * l.alpha * aa * nearFade * (2.0 * w / (len + 2.0 * w)) * (1.0 - fk * (0.5 + 0.5 * sin(ph) * sin(ph * 0.37 + 1.3)));
}`;

const GLOW_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
in vec3 vColor;
in float vSoft;
out vec4 fragColor;
void main() {
  // capsule falloff: distance from the centre segment in quad units
  float x = vUv.x * 0.5 + 0.5;               // 0 head .. 1 tail
  float ends = 1.0 - vSoft;
  float dx = x < ends * 0.5 ? (ends * 0.5 - x) / max(ends * 0.5, 1e-3) : x > 1.0 - ends * 0.5 ? (x - 1.0 + ends * 0.5) / max(ends * 0.5, 1e-3) : 0.0;
  float d2 = dx * dx + vUv.y * vUv.y;
  float core = exp(-d2 * 4.0);
  float tailFade = mix(1.0, 0.35, x);        // brighter at the head
  fragColor = vec4(vColor * core * tailFade, 0.0);
}`;

// --- media: spherical billboards into the half-res WBOIT pass ---------------------------
const MEDIA_VERT = (W) => FX_VERT_HEAD + /* glsl */`
${COMMON_GLSL}
${NOISE_GLSL}
${ARENA_GLSL}
${LIGHTS_GLSL}
${STATE_GLSL(W)}
${INDEX_GLSL}
${LOOK_GLSL}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
out vec2 vUv;
out vec3 vSun;
out vec3 vAmb;
out vec3 vSunL;
out vec3 vUpL;
out vec3 vEmit;
out float vAlpha;
out float vViewZ;
out float vRadius;
out float vDensity;
out float vErode;
out float vDistort;
out vec3 vNoise;
void main() {
  int idx = particleIndex(gl_InstanceID);
  ivec2 px = texelOf(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAlpha = 0.0;
  if (s0.w >= s1.w) return;
  vec4 s2 = texelFetch(uS2, px, 0);
  int kind = int(s2.x);
  float t = s0.w / s1.w;
  Look l = particleLook(kind, t, fract(s2.x) * 10.0);
  vec4 k6 = kindTexel(kind, 6), k7 = kindTexel(kind, 7), k9 = kindTexel(kind, 9);
  vec3 cv = (viewMatrix * vec4(s0.xyz, 1.0)).xyz;
  float viewZ = -cv.z;
  if (viewZ < 0.05) return;
  // overdraw guard: never wider than 12% of the screen height
  float maxR = 0.12 * viewZ / projectionMatrix[1][1];
  float r = min(l.size * 0.5, maxR);
  float spin = s2.y + s0.w * kindTexel(kind, 8).z;
  vec2 c = vec2(cos(spin), sin(spin));
  vec2 q = mat2(c.x, -c.y, c.y, c.x) * position.xy;
  gl_Position = projectionMatrix * vec4(cv + vec3(q * r, 0.0), 1.0);
  vUv = position.xy;
  vViewZ = viewZ;
  vRadius = r;
  vDensity = k7.z;
  vErode = kindTexel(kind, 9).z * t;          // erosion grows with age
  vDistort = k7.w * l.alpha;
  vNoise = s0.xyz * 0.35 + s2.y;
  bool absorbing = (int(k6.w) & 1) != 0;
  float smoke = absorbing ? 1.0 : l.smoke;
  // lighting for the scattering part: sun with forward scattering, sky, spell lights
  gLightNoShadow = true;
  vec3 v = normalize(cameraPosition - s0.xyz);
  float g = 0.35;
  // flames glow; what scatters light is their soot, never their own blackbody colour
  vec3 albedo = l.emissive > 0.0 ? vec3(k7.y) : mix(l.color, vec3(k7.y), smoke);
  if (absorbing) albedo = l.color;
  vSun = albedo * uSunColor * hgPhase(dot(uSunDir, -v), g) * 4.0 * PI * 0.6;
  vAmb = albedo * (uAmbient * 1.4 + spellLightScatter(s0.xyz, v, g) * k9.x);
  // sun and up in the sprite's own frame (view space turned back by the spin), so the fragment
  // can shade the billboard as the sphere it stands for
  vec3 sv = mat3(viewMatrix) * uSunDir, up = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
  mat2 unspin = mat2(c.x, c.y, -c.y, c.x);
  vSunL = vec3(unspin * sv.xy, sv.z);
  vUpL = vec3(unspin * up.xy, up.z);
  // emission fades as fire turns to smoke
  vEmit = (l.emissive > 0.0 && !absorbing) ? l.color * l.emissive * (1.0 - smoke) : vec3(0.0);
  vAlpha = l.alpha;
  // pure emitters (flames before they smoke) are mostly glow, little occlusion
  vAlpha *= mix(0.25 + 0.75 * smoke, 1.0, step(l.emissive, 0.0));
  vAlpha *= smoothstep(0.2, 1.0, viewZ);
}`;

const MEDIA_FRAG = (W) => FX_FRAG_HEAD + /* glsl */`
${COMMON_GLSL}
${NOISE_GLSL}
${FX_OUT_GLSL}
in vec2 vUv;
in vec3 vSun;
in vec3 vAmb;
in vec3 vSunL;
in vec3 vUpL;
in vec3 vEmit;
in float vAlpha;
in float vViewZ;
in float vRadius;
in float vDensity;
in float vErode;
in float vDistort;
in vec3 vNoise;
void main() {
  if (vAlpha <= 0.001) discard;
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  // spherical billboard (Umenhoffer et al. 2006): visible thickness of a sphere, cut by the scene
  float h = sqrt(1.0 - r2) * vRadius;
  float sceneZ = sceneViewZ();
  float thick = clamp(min(vViewZ + h, sceneZ) - max(vViewZ - h, uNearFar.x), 0.0, 2.0 * h);
  // eroded by world-space noise so a sprite reads as a lumpy volume; a finer octave rags the edges
  float n = noise3(vNoise + vec3(vUv * 0.42, 0.0)) * 0.72 + noise3(vNoise * 2.7 + vec3(vUv * 1.1, 0.0)) * 0.28;
  float er = smoothstep(vErode, vErode + 0.35, n * (1.15 - r2 * 0.6));
  // billows and gaps from the first frame of a puff's life, not only once it erodes
  float b = smoothstep(0.22, 0.62, n);
  float a = (1.0 - exp(-vDensity * thick * (0.35 + 0.65 * b))) * er * vAlpha;
  // shading: a dense puff is a lit sphere with a dark side, a dark core against the sun and billows
  // that shadow each other (noise denser towards the sun = in shadow, one extra tap); thin wisps
  // scatter evenly. Normalised so a front-lit puff keeps about its old mean brightness.
  vec3 N = vec3(vUv, sqrt(1.0 - r2));
  float dense = 1.0 - exp(-vDensity * vRadius * 2.0);
  float ns = noise3(vNoise + vec3((vUv + vSunL.xy * 0.3) * 0.42, 0.0));
  float self = clamp(0.5 + (n - ns) * 4.5, 0.0, 1.0);
  float lam = clamp((dot(N, vSunL) + 0.35) / 1.35, 0.0, 1.0);
  float through = exp(-vDensity * thick);
  float sunShade = mix(through, lam, clamp(vSunL.z * 0.5 + 0.5, 0.0, 1.0)) * mix(1.0, self, 0.85) * 2.2;
  float ambShade = (0.65 + 0.35 * dot(N, vUpL)) * (0.5 + 0.5 * sqrt(r2)) * 1.7;
  vec3 vLit = vSun * mix(1.0, sunShade, dense) + vAmb * mix(1.0, ambShade, dense);
  vec2 dist = vDistort * (vec2(noise3(vNoise * 1.7 + uTime * 0.6), noise3(vNoise.zxy * 1.7 - uTime * 0.6)) - 0.5) * 0.02 * (1.0 - r2);
  // fire is hottest deep in a billow: thin edges and gaps run redder and much dimmer
  float core = b * (1.0 - r2);
  vec3 emit = vEmit * mix(vec3(0.5, 0.2, 0.08), vec3(1.5, 1.35, 1.2), core * core);
  fxOut(vLit, a, emit * a * 2.0, dist, vViewZ);
}`;

// --- painting the ground field where paint kinds collided this frame --------------------
const PAINT_VERT = (W) => /* glsl */`
precision highp float;
precision highp int;
uniform float uTime;
uniform vec4 uGroundRect;
${STATE_GLSL(W)}
${INDEX_GLSL}
out vec4 vA;
out vec4 vB;
void main() {
  int idx = particleIndex(gl_VertexID);
  ivec2 px = texelOf(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s2 = texelFetch(uS2, px, 0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 1.0;
  vA = vB = vec4(0.0);
  if (s2.z != uTime) return;   // collided this frame (the sim wrote exactly this uniform)
  int kind = int(s2.x);
  vec4 k6 = kindTexel(kind, 6), k9 = kindTexel(kind, 9);
  int ch = int(k6.y) - 1;
  if (ch < 0) return;
  vec2 uv = (s0.xz - uGroundRect.xy) * uGroundRect.w;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 3.0;
  float amt = kindTexel(kind, 9).w;
  if (ch < 4) vA[ch] = amt; else vB[ch - 4] = amt;
}`;

const PAINT_FRAG = /* glsl */`
precision highp float;
in vec4 vA;
in vec4 vB;
layout(location = 0) out vec4 gA;
layout(location = 1) out vec4 gB;
void main() {
  float f = 1.0 - length(gl_PointCoord * 2.0 - 1.0);
  if (f <= 0.0) discard;
  gA = vA * f; gB = vB * f;
}`;

// --- geometry for debris variants -----------------------------------------------------
function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 0.75 + 0.35 * Math.abs(Math.sin(x * 9.1 + y * 4.3) * Math.cos(z * 7.7 - x * 2.1));
    p.setXYZ(i, x * n, y * n * 0.8, z * n);
  }
  g.computeVertexNormals();
  return g;   // polyhedra are already non-indexed, so the normals are faceted
}
function shardGeometry() {
  // hexagonal ice shard: prism with a pointed tip, flat facets
  const g = new THREE.CylinderGeometry(0.0, 0.22, 1, 6, 1, false);
  g.translate(0, 0.25, 0);
  const tail = new THREE.CylinderGeometry(0.22, 0.12, 0.3, 6, 1, false);
  tail.translate(0, -0.4, 0);
  const merged = mergeTwo(g.toNonIndexed(), tail.toNonIndexed());
  merged.computeVertexNormals();
  return merged;
}
function leafGeometry() {
  const g = new THREE.PlaneGeometry(1, 0.6, 2, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.abs(p.getX(i)) * 0.25);
  g.computeVertexNormals();
  return g.toNonIndexed();
}
function mergeTwo(a, b) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const A = a.attributes[name], B = b.attributes[name];
    if (!A || !B) continue;
    const arr = new Float32Array(A.array.length + B.array.length);
    arr.set(A.array); arr.set(B.array, A.array.length);
    out.setAttribute(name, new THREE.BufferAttribute(arr, A.itemSize));
  }
  return out;
}

// --- JS ------------------------------------------------------------------------------
function colorArr(c) { const k = new THREE.Color(c); return [k.r, k.g, k.b]; }

export class Particles {
  constructor(renderer, { ground = null } = {}) {
    this.renderer = renderer;
    this.ground = ground;
    [this.W, this.H] = Q.particles;
    this.kinds = [];             // { name, def, id }
    this.kindIndex = new Map();
    this.fieldDefs = [];         // { kind, style, count, wa, wb, threshold, rate, lifeScale, sizeScale, up }
    this.kindData = new Float32Array(KW * MAX_KINDS * 4);
    this.kindTex = new THREE.DataTexture(this.kindData, KW, MAX_KINDS, THREE.RGBAFormat, THREE.FloatType);
    this.kindTex.magFilter = this.kindTex.minFilter = THREE.NearestFilter;
    this.emitData = new Float32Array(REC_W * MAX_REC * 4);
    this.emitTex = new THREE.DataTexture(this.emitData, REC_W, MAX_REC, THREE.RGBAFormat, THREE.FloatType);
    this.emitTex.magFilter = this.emitTex.minFilter = THREE.NearestFilter;
    this.fieldData = new Float32Array(4 * MAX_FIELD * 4);
    this.fieldTex = new THREE.DataTexture(this.fieldData, 4, MAX_FIELD, THREE.RGBAFormat, THREE.FloatType);
    this.fieldTex.magFilter = this.fieldTex.minFilter = THREE.NearestFilter;
    this.recCount = 0;
    this.built = false;
    this.time = 0;
    this.alive = 0;
    this.seed = 1;
    this.glow = this.media = this.debris = null;   // meshes after build()
  }

  // seeded LCG so ?shot / ?bench frames repeat exactly
  rand() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  reseed(n) { this.seed = n >>> 0 || 1; }

  // --- authoring (spell create() at load) ---
  addKind(name, def) {
    if (this.kindIndex.has(name)) return this.kindIndex.get(name);
    if (this.kinds.length >= MAX_KINDS) throw new Error('particle kinds full');
    const id = this.kinds.length;
    // media is lit smoke/dust/mist unless it says it glows (or is a blackbody flame)
    const lit = def.style === 'media' && !def.temp && !def.absorbing ? { emissive: 0 } : null;
    const k = { name, id, def: { ...KIND_DEFAULTS, ...lit, ...def } };
    this.kinds.push(k);
    this.kindIndex.set(name, id);
    return id;
  }
  kind(name) { return this.kindIndex.get(name); }

  // live slider edits: no recompile, just texels
  setKind(id, patch) {
    const k = this.kinds[typeof id === 'string' ? this.kindIndex.get(id) : id];
    Object.assign(k.def, patch);
    if (this.built) { this.writeKind(k); this.kindTex.needsUpdate = true; }
  }

  // GPU-driven emission from the ground field: weights on (heat, char, wet, frost) and
  // (crack, acid, corruption, glow), minus threshold, times rate = spawn chance per slot per second
  fieldEmitter(kind, { slots = 1024, a = [0, 0, 0, 0], b = [0, 0, 0, 0], threshold = 0.2, rate = 2, lifeScale = 1, sizeScale = 1, up = 0.5 } = {}) {
    const id = typeof kind === 'string' ? this.kindIndex.get(kind) : kind;
    this.fieldDefs.push({ kind: id, count: Math.max(64, Math.round(slots * Q.emission)), wa: a, wb: b, threshold, rate, lifeScale, sizeScale, up });
  }

  writeKind(k) {
    const d = k.def, o = k.id * KW * 4, D = this.kindData;
    const [ca, cb] = [colorArr(d.color[0]), colorArr(d.color[1] ?? d.color[0])];
    const style = STYLES.indexOf(d.style);
    const paint = d.paints ? PAINT_CHANNELS.indexOf(d.paints) + 1 : 0;
    const morph = d.morph != null ? (typeof d.morph === 'string' ? this.kindIndex.get(d.morph) : d.morph) + 1 : 0;
    const flags = (d.absorbing ? 1 : 0) | (d.killOnCollide ? 2 : 0) | (d.orbit ? 4 : 0);
    D.set([
      d.drag, d.gravity, d.buoyancy, d.curl,
      d.curlScale, d.forceResponse, d.restitution, d.friction,
      d.life[0], d.life[1], d.size[0], d.size[1] ?? d.size[0],
      d.stretch, d.emissive, d.temp ? d.temp[0] : 0, d.temp ? d.temp[1] ?? d.temp[0] : 0,
      ...ca, d.alpha[0],
      ...cb, d.alpha[1] ?? d.alpha[0],
      // debris is 3 + variant / 10 (the sim tests > 2.5, the debris VS reads the variant)
      style === 2 ? 3 + MESHES.indexOf(d.mesh) * 0.1 : style, paint, morph, flags,
      d.toSmokeAt, d.smokeAlbedo, d.density, d.distortion,
      d.fadeIn, d.fadeOut, d.spin, d.sizePow,
      d.lightResponse, d.softness, d.erosion, d.paintAmount,
      d.flicker, 0, 0, 0,   // glow only: 0..1 per-particle twinkle (embers)
    ], o);
  }

  // --- build once every spell has registered ---
  build() {
    const { W, H } = this;
    for (const k of this.kinds) this.writeKind(k);
    this.kindTex.needsUpdate = true;

    // row ranges: debris rows sized to Q.debris, the rest split glow 55% / media 45%
    const debrisRows = Math.max(1, Math.ceil(Q.debris / W));
    const rest = H - debrisRows;
    const glowRows = Math.round(rest * 0.55), mediaRows = rest - glowRows;
    const rows = { glow: [0, glowRows], media: [glowRows, mediaRows], debris: [glowRows + mediaRows, debrisRows] };
    this.style = {};
    for (const s of STYLES) {
      const [r0, nr] = rows[s];
      this.style[s] = { start: r0 * W, count: nr * W, field: 0, cursor: 0, log: new Float64Array(LOG_N * 3), head: 0, tail: 0, base: 0, window: 0 };
    }
    // field blocks at the start of their style's range
    let fi = 0;
    for (const fd of this.fieldDefs) {
      const st = this.style[this.kinds[fd.kind].def.style];
      const count = Math.min(fd.count, Math.floor(st.count / 4));
      const o = fi * 4 * 4;
      this.fieldData.set([st.start + st.field, count, fd.kind, fd.threshold, ...fd.wa, ...fd.wb, fd.rate, fd.lifeScale, fd.sizeScale, fd.up], o);
      st.field += count;
      fi++;
    }
    this.fieldCount = fi;
    this.fieldTex.needsUpdate = true;

    const rtOpts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false, count: 3 };
    this.rt = [new THREE.WebGLRenderTarget(W, H, rtOpts), new THREE.WebGLRenderTarget(W, H, rtOpts)];
    this.cur = 0;

    const stateU = { uS0: { value: null }, uS1: { value: null }, uS2: { value: null }, uKinds: { value: this.kindTex } };
    this.stateU = stateU;
    this.spans = Array.from({ length: 6 }, () => new THREE.Vector2());
    this.sim = new FullscreenQuad(new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FULLSCREEN_VERT, fragmentShader: SIM_FRAG(W),
      uniforms: {
        ...U, ...stateU,
        uEmitTex: { value: this.emitTex }, uEmitCount: { value: 0 }, uSpan: { value: this.spans }, uSpanCount: { value: 0 },
        uFieldTex: { value: this.fieldTex }, uFieldCount: { value: this.fieldCount }, uSimDt: { value: 1 / 60 },
      },
      depthTest: false, depthWrite: false,
    }));
    // initialise every texel dead: one sim step with nothing to emit
    this.clearState();

    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const styleU = (s) => ({
      uStyleStart: { value: this.style[s].start }, uStyleCount: { value: this.style[s].count },
      uFieldCount: { value: this.style[s].field }, uRingBase: { value: 0 },
    });

    // glow (lines scene)
    const gq = quad.clone();
    this.glow = new THREE.Mesh(gq, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GLOW_VERT(W), fragmentShader: GLOW_FRAG,
      uniforms: { ...U, ...stateU, ...styleU('glow') }, ...LINES_BLENDING,
    }));
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 10;
    this.glow.layers.enable(1);   // shows in the floor reflection

    // media (fx scene)
    const mq = quad.clone();
    this.media = new THREE.Mesh(mq, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: MEDIA_VERT(W), fragmentShader: MEDIA_FRAG(W),
      uniforms: { ...U, ...stateU, ...styleU('media') }, ...FX_BLENDING,
    }));
    this.media.frustumCulled = false;

    // debris (opaque scene): one mesh per variant, each skips instances of other variants
    const debrisU = styleU('debris');   // shared by the three variant materials
    this.debris = MESHES.map((variant, vi) => {
      const src = variant === 'rock' ? rockGeometry() : variant === 'shard' ? shardGeometry() : leafGeometry();
      const g = new THREE.InstancedBufferGeometry();
      for (const n of ['position', 'normal', 'uv']) if (src.attributes[n]) g.setAttribute(n, src.attributes[n]);
      g.instanceCount = 0;
      const mat = debrisMaterial(W, stateU, debrisU, vi, variant);
      mat.userData.u = debrisU;
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.layers.enable(1);
      return m;
    });

    // paint into the ground field: one Points draw per style window
    this.paint = [];
    if (this.ground?.paintScene) {
      for (const s of STYLES) {
        // the shader reads no attributes; three clamps the draw to position.count, so size it
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.style[s].count), 1));
        g.setDrawRange(0, 0);
        g.boundingSphere = new THREE.Sphere();   // three sorts by it; computing it from a 1-wide attribute gives NaN
        const m = new THREE.Points(g, new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3, vertexShader: PAINT_VERT(W), fragmentShader: PAINT_FRAG,
          uniforms: { uTime: U.uTime, uGroundRect: U.uGroundRect, ...stateU, ...styleU(s) },
          depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
        }));
        m.frustumCulled = false;
        m.userData.style = s;
        this.ground.paintScene.add(m);
        this.paint.push(m);
      }
    }
    this.built = true;
    this.bindState();
  }

  clearState() {
    this.recCount = 0;
    this.sim.material.uniforms.uEmitCount.value = 0;
    this.sim.material.uniforms.uSpanCount.value = 0;
    this.sim.material.uniforms.uFieldCount.value = 0;
    const r = this.renderer;
    // the textures start as zero: age 0 >= life 0 counts as dead
    for (const rt of this.rt) { r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(true, false, false); }
    r.setRenderTarget(null);
    for (const s of STYLES) Object.assign(this.style?.[s] ?? {}, { cursor: 0, head: 0, tail: 0, base: 0, window: 0 });
    this.sim.material.uniforms.uFieldCount.value = this.fieldCount ?? 0;
  }

  // --- emitters: reusable handles so continuous emission allocates nothing ---
  emitter(kind, opts = {}) {
    const id = typeof kind === 'string' ? this.kindIndex.get(kind) : kind;
    if (id === undefined) throw new Error(`unknown particle kind ${kind}`);
    const p = this;
    return {
      kind: id, shape: SHAPES[opts.shape ?? 'sphere'], pos: new THREE.Vector3(), radius: opts.radius ?? 0.1,
      vel: new THREE.Vector3(), spread: opts.spread ?? 0, p: new THREE.Vector3(), radial: opts.radial ?? 0,
      size: opts.size ?? 1, life: opts.life ?? 1, cone: opts.cone ?? 0.4, acc: 0,
      burst(count) { p.emit(this, count); },
      // continuous: fractional accumulator so low rates still emit
      rate(perSecond, dt) {
        this.acc += perSecond * dt * Q.emission * Q.auto.emission;
        const n = Math.floor(this.acc);
        if (n > 0) { this.acc -= n; p.emit(this, n, true); }
      },
      setShape(name) { this.shape = SHAPES[name]; return this; },
    };
  }

  emit(e, count, prescaled = false) {
    if (!this.built) return;
    const st = this.style[this.kinds[e.kind].def.style];
    const ring = st.count - st.field;
    let n = prescaled ? count : Math.round(count * Q.emission * Q.auto.emission);
    n = Math.min(n, ring);
    if (n <= 0) return;
    const def = this.kinds[e.kind].def, life = def.life[1] * e.life;
    // the ground field only simulates (and accepts paint) where it was touched: cover the reach
    const mk = typeof def.morph === 'string' ? this.kindIndex.get(def.morph) : def.morph;
    if ((def.paints || this.kinds[mk]?.def.paints) && this.ground?.touch) {
      const reach = Math.min(8, e.radius + 1 + 0.6 * life * (e.spread + e.vel.length()));
      this.ground.touch(e.pos.x, e.pos.z, reach, life);
    }
    let start = st.cursor;
    while (n > 0 && this.recCount < MAX_REC) {
      const take = Math.min(n, ring - start);
      const o = this.recCount * REC_W * 4, D = this.emitData;
      D[o] = st.start + st.field + start; D[o + 1] = take; D[o + 2] = e.kind; D[o + 3] = e.shape;
      D[o + 4] = e.pos.x; D[o + 5] = e.pos.y; D[o + 6] = e.pos.z; D[o + 7] = e.radius;
      D[o + 8] = e.vel.x; D[o + 9] = e.vel.y; D[o + 10] = e.vel.z; D[o + 11] = e.spread;
      D[o + 12] = e.p.x; D[o + 13] = e.p.y; D[o + 14] = e.p.z; D[o + 15] = this.rand();
      D[o + 16] = e.radial; D[o + 17] = e.size; D[o + 18] = e.life; D[o + 19] = e.cone;
      this.recCount++;
      // emission log (ring): entries expire in order, the oldest live one is the draw window base
      const h = st.head % LOG_N * 3;
      st.log[h] = start; st.log[h + 1] = take; st.log[h + 2] = this.time + life;
      st.head++;
      if (st.head - st.tail > LOG_N) st.tail++;
      start = (start + take) % ring;
      n -= take;
    }
    st.cursor = start;
  }

  bindState() {
    const s = this.rt[this.cur].textures;
    this.stateU.uS0.value = s[0]; this.stateU.uS1.value = s[1]; this.stateU.uS2.value = s[2];
  }

  // once per frame, before rendering. dt is the scaled sim step.
  update(dt, time) {
    if (!this.built) return;
    this.time = time;
    const u = this.sim.material.uniforms;
    // spans this frame: per style, from the first record start to the cursor (wrapping)
    let sc = 0;
    for (const s of STYLES) this.style[s].first = -1;
    for (let r = 0; r < this.recCount; r++) {
      const o = r * REC_W * 4, st = this.style[this.kinds[this.emitData[o + 2]].def.style];
      if (st.first < 0) st.first = this.emitData[o];
    }
    for (const s of STYLES) {
      const st = this.style[s];
      if (st.first < 0) continue;
      const ringStart = st.start + st.field, ring = st.count - st.field;
      const a = st.first, b = ringStart + st.cursor;
      if (b > a) this.spans[sc++].set(a, b);
      else { this.spans[sc++].set(a, ringStart + ring); this.spans[sc++].set(ringStart, b === ringStart ? ringStart + ring : b); }
    }
    u.uSpanCount.value = sc;
    u.uEmitCount.value = this.recCount;
    if (this.recCount) this.emitTex.needsUpdate = true;
    u.uSimDt.value = dt;
    this.bindState();          // read the current state ...
    this.cur ^= 1;
    this.sim.render(this.renderer, this.rt[this.cur]);   // ... write the other
    this.bindState();
    this.recCount = 0;

    // live windows: drop expired log entries, base = oldest live start
    this.alive = 0;
    for (const s of STYLES) {
      const st = this.style[s], ring = st.count - st.field, L = st.log;
      while (st.tail < st.head && L[st.tail % LOG_N * 3 + 2] < time) st.tail++;
      for (let j = st.tail; j < st.head; j++) this.alive += L[j % LOG_N * 3 + 1];
      const live = st.head > st.tail;
      st.base = live ? L[st.tail % LOG_N * 3] : st.cursor;
      st.window = live ? ((st.cursor - st.base + ring) % ring || ring) : 0;
      this.setDraw(s, st.base, st.field + st.window);
    }
    this.alive = Math.min(this.alive, this.W * this.H);
  }

  setDraw(s, base, n) {
    const meshes = s === 'glow' ? [this.glow] : s === 'media' ? [this.media] : this.debris;
    for (const m of meshes) {
      m.geometry.instanceCount = n;
      (m.material.uniforms ?? m.material.userData.u).uRingBase.value = base;
      m.visible = n > 0;
    }
    for (const p of this.paint) if (p.userData.style === s) {
      p.material.uniforms.uRingBase.value = base;
      p.geometry.setDrawRange(0, n);
      p.visible = n > 0;
    }
  }

  // everything visible for one warm-up frame (shader variants are built at first draw)
  warm(on) {
    for (const s of STYLES) {
      const st = this.style[s];
      if (on) this.setDraw(s, 0, 1); else this.setDraw(s, st.base, st.field + st.window);
    }
  }
}

function debrisMaterial(W, stateU, styleU, variant, name) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: name === 'shard' ? 0.08 : 0.85, metalness: 0, side: name === 'leaf' ? THREE.DoubleSide : THREE.FrontSide });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, stateU, styleU, { uVariant: { value: variant } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
${STATE_GLSL(W)}
${INDEX_GLSL}
uniform float uVariant;
varying vec3 vKindColor;
varying vec3 vKindEmit;
varying float vRough;
mat3 axisAngle(vec3 a, float t) {
  float c = cos(t), s = sin(t), C = 1.0 - c;
  return mat3(c + a.x*a.x*C, a.y*a.x*C + a.z*s, a.z*a.x*C - a.y*s,
              a.x*a.y*C - a.z*s, c + a.y*a.y*C, a.z*a.y*C + a.x*s,
              a.x*a.z*C + a.y*s, a.y*a.z*C - a.x*s, c + a.z*a.z*C);
}
vec3 hash3(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
mat3 gRot; vec3 gPos; float gScale; bool gDead;
void debrisSetup() {
  int idx = particleIndex(gl_InstanceID);
  ivec2 px = texelOf(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0), s2 = texelFetch(uS2, px, 0);
  int kind = int(s2.x);
  vec4 k2 = kindTexel(kind, 2), k4 = kindTexel(kind, 4), k5 = kindTexel(kind, 5), k6 = kindTexel(kind, 6), k8 = kindTexel(kind, 8);
  float t = s0.w / max(s1.w, 1e-4);
  gDead = s0.w >= s1.w || abs(fract(k6.x) * 10.0 - uVariant) > 0.5;
  vec3 h = hash3(s2.y);
  vec3 ax = normalize(h - 0.5 + 1e-4);
  float spinT = s2.w > 0.0 ? s2.w : s0.w;
  gRot = axisAngle(ax, h.x * 6.283 + k8.z * spinT);
  float fade = 1.0 - smoothstep(1.0 - max(k8.y, 1e-3), 1.0, t);
  gScale = mix(k2.z, k2.w, t) * fract(s2.x) * 10.0 * (0.6 + 0.8 * h.y) * mix(0.0, 1.0, fade) * smoothstep(0.0, 0.03, s0.w + 0.01);
  gPos = s0.xyz;
  vKindColor = k4.rgb * (0.75 + 0.5 * h.z);
  vKindEmit = k5.rgb * pow(1.0 - t, 2.0);
  vRough = k5.a;
}`)
      .replace('#include <beginnormal_vertex>', `debrisSetup();
vec3 objectNormal = gRot * normal;
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = gDead ? vec3(0.0, -1000.0, 0.0) : gRot * position * gScale + gPos;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
${COMMON_GLSL}
${WORLD_GLSL}
${LIGHTS_GLSL}
varying vec3 vKindColor;
varying vec3 vKindEmit;
varying float vRough;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
  // spell lights in world space (view-space normal/position rotated back)
  vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 wP = cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz;
  vec3 sd, ss;
  spellLightPBR(wP, wN, normalize(cameraPosition - wP), material.roughness, material.specularColor, material.diffuseColor, sd, ss);
  reflectedLight.directDiffuse += sd;
  reflectedLight.directSpecular += ss;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= vKindColor;`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = vRough > 0.0 ? vRough : roughness;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vKindEmit;`);
  };
  return mat;
}
