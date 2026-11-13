import * as THREE from 'three';
import { U, COMMON_GLSL, NOISE_GLSL, LINES_BLENDING, arenaSDF } from '../vfx/common.js';
import { blackbodyRGB } from '../vfx/noise.js';
import { REFRACT_GLSL } from '../vfx/Refraction.js';

// Void (PLAN 3). Singularity, matched to Interstellar's Gargantua (James, von Tunzelmann, Franklin &
// Thorne 2015) and the EHT / NASA GSFC black hole visualisations: the charge drains the light around
// the focus (absorbing media, motes falling in) and a horizon forms inside it, its disk igniting.
// It drifts out at ~6 m/s, wobbling. The hole and its disk are traced per pixel by Lens.js (slot =
// void slot): Schwarzschild photon paths through a thin, banded, differentially rotating Kepler disk
// (blackbody T ~ r^-3/4, Doppler + gravitational shift, I ~ g^4), so the near side crosses in front
// of the shadow, the far side arches over and under it, a razor photon ring hugs the shadow, and the
// arena behind bends into the Einstein ring. Matter streams in on plunging Kepler orbits (real 1/r^2
// gravity from the void's attractor, which every particle in the arena feels), drawn by this
// module's own Doppler streak pass. Six dark tendrils, corruption seeping along the floor's veins.
// Collapse: 0.3 s implosion (the disk plunges, spins up and heats, the shadow shrinks, the lens
// spikes), then the hole lets go: an expanding photographic-negative shell, the disk blown out as a
// white-hot ring, the attractor flipped into a shock shell, sparks, dark smoke, a heavy distortion ring.
// Rift, after the film tradition of spacetime wounds (Annihilation's shimmer refraction, Interstellar's
// wormhole interior): a jagged tear drawn in the refract pass. Around it the scene behind really is
// sheared, pushed aside and shattered into glass-like shards; its edge burns with a thin white line;
// inside, a funnel of burning wall narrows with depth to a throat of stars, every layer with its own
// parallax. Rocks and dust are torn off the floor and dragged in by the attractor, corruption spreads
// outward beneath it, and it snaps shut with a shock.
//
// The infall motes are a normal 'glow' kind (black in the shared draw) so they live in the shared
// pool and feel every force; one extra draw over the glow window shades them.

const MAX_VOIDS = 2, TENDRILS = 8;
const UP = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
// hole scale: shadow radius (m) at size 1, b_c = 3 sqrt(3) / 2 r_s, Einstein ring / shadow, disk
// outer edge (r_s; the ISCO is 3), disk emission scale
const SHADOW = 0.34, B_CRIT = 2.598, EINSTEIN = 2.0, DISK_OUT = 13, DISK_I = 10;

// floor-reflection stand-in for the traced disk (layer 1 only)
const PROXY_VERT = /* glsl */`
out vec2 vP;
void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PROXY_FRAG = /* glsl */`
uniform vec3 uCol;
uniform float uIn;
in vec2 vP;
out vec4 fragColor;
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float a = smoothstep(uIn * 0.8, uIn * 1.3, r) * (1.0 - smoothstep(0.3, 1.0, r)) * pow(max(r / uIn, 1.0), -1.6);
  fragColor = vec4(uCol * a * (0.65 + 0.35 * sin(r * 61.0) * sin(r * 23.0 + 1.3)), 0.0);
}`;

const DISK_VERT = (W) => /* glsl */`
precision highp float;
precision highp int;
${COMMON_GLSL}
${NOISE_GLSL}
uniform highp sampler2D uS0;
uniform highp sampler2D uS1;
uniform highp sampler2D uS2;
uniform int uStyleStart;
uniform int uStyleCount;
uniform int uFieldCount;
uniform int uRingBase;
uniform int uKind;
uniform vec4 uVoidA[${MAX_VOIDS}];   // centre, inner radius (0 = slot unused)
uniform vec4 uVoidB[${MAX_VOIDS}];   // centre velocity, -
uniform vec4 uDisk;       // inner temperature K, intensity, beaming k, mote size (m)
uniform vec3 uTint;
out vec2 vUv;
out vec3 vColor;
out float vSoft;
const int PW = ${W};
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColor = vec3(0.0); vUv = vec2(0.0); vSoft = 0.0;
  int ring = uStyleCount - uFieldCount, id = gl_InstanceID;
  int idx = uStyleStart + (id < uFieldCount ? id : uFieldCount + (uRingBase + id - uFieldCount) % max(ring, 1));
  ivec2 px = ivec2(idx % PW, idx / PW);
  vec4 s2 = texelFetch(uS2, px, 0);
  if (int(s2.x) != uKind) return;
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  if (s0.w >= s1.w) return;
  int vi = -1; float best = 1e9;
  for (int i = 0; i < ${MAX_VOIDS}; i++) {
    if (uVoidA[i].w <= 0.0) continue;
    float d = distance(s0.xyz, uVoidA[i].xyz);
    if (d < best) { best = d; vi = i; }
  }
  if (vi < 0) return;
  vec4 A = uVoidA[vi];
  vec3 headV = (viewMatrix * vec4(s0.xyz, 1.0)).xyz;
  float viewZ = max(-headV.z, 0.05);
  float t = s0.w / s1.w;
  float fade = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.7, 1.0, t));
  // Doppler beaming in the hole's frame: brightness D^3, approaching side bluer
  vec3 rel = s1.xyz - uVoidB[vi].xyz;
  float sp = length(rel);
  float mu = sp > 1e-3 ? dot(rel / sp, normalize(cameraPosition - s0.xyz)) : 0.0;
  float D = max(1.0 + uDisk.z * mu, 0.05);
  // thin disk: T ~ r^-3/4, hot inner edge
  float x = max(best / A.w, 0.7);
  float T = uDisk.x * pow(x, -0.75) * mix(1.0, D, 0.45);
  vec3 col = blackbody(T) * uTint * (uDisk.y * pow(x, -2.0) * D * D * D * fade);
  vec3 tailV = (viewMatrix * vec4(s0.xyz - rel * 0.022, 1.0)).xyz;
  float pxWorld = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float size = uDisk.w * (0.7 + 0.6 * hash11(s2.y * 3.1)), w = max(size, 1.5 * pxWorld);
  vec2 axis = tailV.xy - headV.xy;
  float len = length(axis);
  vec2 dir = len > 1e-4 ? axis / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 off = dir * (position.x < 0.0 ? -w : len + w) + perp * position.y * w;
  gl_Position = projectionMatrix * vec4(headV + vec3(off, 0.0), 1.0);
  vUv = vec2(position.x < 0.0 ? -1.0 : 1.0, position.y);
  vSoft = len / (len + 2.0 * w);
  vColor = col * (size / w) * smoothstep(0.3, 1.2, viewZ) * (2.0 * w / (len + 2.0 * w));
}`;

const DISK_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
in vec3 vColor;
in float vSoft;
out vec4 fragColor;
void main() {
  float x = vUv.x * 0.5 + 0.5, ends = 1.0 - vSoft;
  float dx = x < ends * 0.5 ? (ends * 0.5 - x) / max(ends * 0.5, 1e-3) : x > 1.0 - ends * 0.5 ? (x - 1.0 + ends * 0.5) / max(ends * 0.5, 1e-3) : 0.0;
  fragColor = vec4(vColor * exp(-(dx * dx + vUv.y * vUv.y) * 4.0) * mix(1.0, 0.35, x), 0.0);
}`;

// tendrils: p0 = base, seed   p1 = dir, length   p2 = width, amplitude, twist, extension
//           p3 = wave speed, wave number, -, darkness
const TENDRIL_PATH = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  vec3 dir = normalize(p1.xyz);
  mat3 B = basisFrom(dir);
  float s = t * p2.w, L = p1.w, seed = p0.w;
  float ph = uTime * p3.x - s * p3.y + seed * 6.2832;
  vec2 wv = vec2(sin(ph), 0.8 * cos(ph * 0.71 + seed * 3.0)) + 0.35 * vec2(sin(ph * 2.3 + 1.7), sin(ph * 1.9 + seed));
  float tw = p2.z * s + seed, c = cos(tw), sn = sin(tw);
  wv = mat2(c, -sn, sn, c) * wv;
  width = p2.x * pow(1.0 - t, 0.75) * smoothstep(0.0, 0.06, t + 0.01) * step(0.02, p2.w);
  return p0.xyz + dir * (s * L) + (B[0] * wv.x + B[1] * wv.y) * (p2.y * s * s * L);
}`;

const TENDRIL_SHADE = /* glsl */`
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  float v = abs(r.uv.y), t = r.uv.x;
  media = vec3(0.003, 0.0, 0.008);
  alpha = (1.0 - v * v * v * v) * r.p3.w;
  float edge = smoothstep(0.45, 0.85, v) * (1.0 - smoothstep(0.9, 1.0, v));
  float flick = 0.75 + 0.25 * sin(t * 11.0 - uTime * 9.0 + r.p0.w * 9.0) * sin(t * 4.3 + uTime * 3.1);
  distortion = r.uv.y * exp(-3.0 * r.uv.y * r.uv.y) * 0.05;
  return r.color * edge * flick * (0.4 + t);
}`;

// the rift, in the refract pass. Two draws of one program: the wound writes depth (what is behind it
// is gone, for particles too), the sheared halo around it doesn't.
const RIFT_H = 1.7, RIFT_W = 0.5, JAG_M = 12;   // half height, half width, metres per jag texture repeat
const RIFT_VERT = /* glsl */`
uniform vec3 uC;
uniform vec3 uR;
uniform vec3 uUp;
uniform vec2 uHalf;
out vec2 vQ;
out vec3 vW;
void main() {
  vQ = position.xy * uHalf;
  vW = uC + uR * vQ.x + uUp * vQ.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;

const RIFT_FRAG = (funnel, stars) => /* glsl */`
uniform sampler2D uJag;     // r centre line, g b left and right edge, a edge burn: piecewise linear, so torn
uniform vec3 uR;
uniform vec3 uUp;
uniform vec3 uN;            // towards the camera's side
uniform vec3 uRim;
uniform vec3 uHot;
uniform vec4 uRift;         // half height, half width, seed, open
uniform vec4 uRift2;        // reach, shear, flare, -
uniform float uMode;        // 0 the wound, 1 the halo
in vec2 vQ;
in vec3 vW;
out vec4 fragColor;

// signed distance across the torn outline at q (metres in the tear's plane), negative inside.
// grow narrows it: the walls of the wound, further in.
float tearD(vec2 q, float grow, out float cx, out float burn) {
  float H = uRift.x * uRift2.x, y = q.y / max(H, 1e-3);
  vec4 o = textureLod(uJag, vec2(q.y / ${JAG_M}.0 + uRift.z, 0.5), 0.0);
  cx = (o.r - 0.5) * 0.62;
  burn = o.a;
  float env = pow(max(1.0 - y * y, 0.0), 0.6) * (1.0 + 0.3 * sin(y * 2.3 + uRift.z * 40.0));
  float w = uRift.y * uRift.w * grow * env;
  float d = max(cx - w * (0.35 + 1.3 * o.g) - q.x, q.x - cx - w * (0.35 + 1.3 * o.b));
  return d + max(abs(y) - 1.0, 0.0) * H;
}

// inside: a funnel of burning wall closing on a throat, then stars at their own depths
vec3 wound(vec2 q, vec3 rd, float dStart) {
  vec3 rp = vec3(dot(rd, uR), dot(rd, uUp), max(-dot(rd, uN), 0.3));
  vec2 sl = rp.xy / rp.z;
  float zP = 0.0, dP = dStart, seed = uRift.z * 50.0, cx, b;
  for (int i = 1; i <= ${funnel}; i++) {
    float f = float(i) / ${funnel}.0, z = 2.4 * f * f;
    vec2 p = q + sl * z;
    float dd = tearD(p, mix(1.0, 0.3, 1.0 - exp(-z / 0.9)), cx, b);
    if (dd > 0.0) {
      float zh = mix(zP, z, clamp(-dP / (dd - dP), 0.0, 1.0));
      p = q + sl * zh;
      // the torn wall, streaked along the depth it falls into
      float n1 = noise3(vec3(p.y * 3.1, zh * 1.3 - uTime * 0.8, seed)), n2 = noise3(vec3(p.y * 11.0, zh * 2.6 - uTime * 1.4, seed + 3.0));
      float st = n1 * n1 * n1 * (0.2 + 2.4 * n2 * n2);
      return uRim * ((exp(-zh * 4.5) * (0.02 + 1.3 * st) + 0.006 * exp(-zh * 0.8)) * uRift2.z) + uHot * (exp(-zh / 0.025) * 0.5 * uRift2.z);
    }
    zP = z; dP = dd;
  }
  vec3 sky = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    float fk = float(k), D = 4.0 + 6.0 * fk;
    vec2 uv = (q / D + sl) * (1.9 + fk * 0.7) + seed;
    float n = noise3(vec3(uv, fk * 3.7 + uTime * 0.03)), m = n * (0.35 + 1.1 * noise3(vec3(uv * 2.7, fk * 5.1)));
    sky += (k == 0 ? uRim * 0.4 : k == 1 ? vec3(0.07, 0.02, 0.2) : vec3(0.2, 0.015, 0.09)) * (m * m);
  }
  for (int j = 0; j < ${stars}; j++) {
    float fj = float(j), D = 5.0 * pow(2.4, fj);
    vec2 uv = (q / D + sl) * (60.0 + 45.0 * fj) + fj * 37.0 + seed, ic = floor(uv), fr = uv - ic - 0.5;
    float h = hash12(ic + fj * 13.0);
    if (h < 0.76) continue;
    vec2 o = vec2(hash12(ic + 3.1), hash12(ic + 7.7)) - 0.5;
    vec2 e = fr - o * 0.7;
    float g = fract(h * 57.0);
    sky += mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.68, 0.6), fract(h * 19.0)) * ((0.5 + 11.0 * g * g * g * g) * exp(-dot(e, e) * 110.0));
  }
  return sky;
}

void main() {
  vec2 q = vQ;
  float cx, burn, d = tearD(q, 1.0, cx, burn);
  float zs = refrViewZ(vW), px = zs * 2.0 / (projectionMatrix[1][1] * uResolution.y);
  if (uMode < 0.5 ? d > px : (d < -px || d > 1.9)) discard;
  float inside = smoothstep(px, -px, d), shear = uRift2.y, seed = uRift.z * 50.0;
  vec3 col = vec3(0.0);
  float dO = max(d, 0.0), near = exp(-dO / 0.2);
  if (inside < 1.0) {
    // space is pushed aside and slid past itself, opposite ways on the two sides of the tear ...
    float side = q.x < cx ? -1.0 : 1.0, fall = exp(-dO / 0.5) * smoothstep(1.9, 1.0, dO);
    vec2 off = vec2(-side * 0.3, side * 0.5 + 0.05 * sin(uTime * 1.7 + q.y * 2.0)) * (fall * shear);
    // ... and close in it has shattered like glass: each shard looks somewhere else
    vec2 g = q * 2.7 + seed, ig = floor(g), id = vec2(0.0), id2 = vec2(0.0);
    float F1 = 9.0, F2 = 9.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 c = ig + vec2(float(x), float(y)), h = vec2(hash12(c), hash12(c + 19.7));
      float l = length(g - c - h);
      if (l < F1) { F2 = F1; F1 = l; id2 = id; id = h; } else if (l < F2) { F2 = l; id2 = h; }
    }
    float shard = exp(-dO / 0.38);
    off += (id - 0.5) * (0.42 * shard * shear);
    vec2 uv0 = gl_FragCoord.xy / uResolution, duv = refrUV(vW + uR * off.x + uUp * off.y) - uv0;
    // a lookup landing on something in front of the tear falls back to straight through
    duv *= smoothstep(zs - 0.3, zs + 0.3, linearDepth(textureLod(uSceneDepth, uv0 + duv, 0.0).r));
    float ca = 0.012 + 0.05 * near;
    col = vec3(textureLod(uSceneColor, uv0 + duv * (1.0 + ca), 0.0).r, textureLod(uSceneColor, uv0 + duv, 0.0).g, textureLod(uSceneColor, uv0 + duv * (1.0 - ca), 0.0).b);
    col *= 1.0 - min(0.6 * near * shear, 0.8);      // the wound drinks the light around it
    // the shards' broken edges catch the fire
    float crack = (1.0 - smoothstep(0.0, max(0.035, 2.0 * px), F2 - F1)) * exp(-dO / 0.16) * step(0.3, id.x * id2.y + id2.x * id.y);
    col += uRim * (crack * (0.08 + 0.8 * burn * burn) * uRift2.z * min(shear * 2.0, 1.0));
  }
  if (inside > 0.0) col = mix(col, wound(q, normalize(vW - cameraPosition), min(d, -1e-3)), inside);
  // the edge: a thin, broken line of white fire with a violet burn around it
  float ad = abs(d), rw = max(0.0045, 0.9 * px);
  float cr = smoothstep(0.42, 0.72, burn) * (0.15 + 2.2 * noise3(vec3(q.y * 4.3, uTime * 1.9, seed)));
  col += (uHot * (exp(-ad / rw) * (0.1 + 2.6 * cr)) + uRim * (exp(-ad / (rw * 3.5)) * (0.03 + 0.9 * cr) + exp(-ad / 0.12) * 0.035)) * uRift2.z;
  fragColor = vec4(col, 1.0);
}`;

function jagTexture() {
  const n = 1024, a = new Uint8Array(n * 4);
  let h = 0x2f6e2b1;
  const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0; return ((h ^ (h >>> 13)) >>> 0) / 4294967296; };
  const octave = (segs) => { const v = Array.from({ length: segs }, rnd); return (t) => { const x = t * segs, i = Math.floor(x), f = x - i; return v[i % segs] * (1 - f) + v[(i + 1) % segs] * f; }; };
  const channel = (...os) => { const fs = os.map(([segs, amp]) => [octave(segs), amp]); return (t) => fs.reduce((sum, [fn, amp]) => sum + fn(t) * amp, 0); };
  const ch = [channel([22, 0.62], [70, 0.27], [220, 0.11]), channel([30, 0.5], [90, 0.32], [270, 0.18]), channel([26, 0.5], [84, 0.32], [250, 0.18]), channel([40, 0.55], [170, 0.45])];
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) a[i * 4 + k] = 255 * ch[k](i / n);
  const tex = new THREE.DataTexture(a, n, 1, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping; tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
  return tex;
}

// module scratch (no allocations per frame)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _r = new THREE.Vector3(), _t = new THREE.Vector3();
const _col = new THREE.Color(), _col2 = new THREE.Color();
const SPLAT = { x: 0, z: 0, radius: 1, corruption: 0, crack: 0, glow: 0, pattern: 'noise', seed: 0 };
const SHOCK = { pos: new THREE.Vector3(), radius0: 0.2, radius1: 8, duration: 0.6, thickness: 1, distortion: 0.12, intensity: 0, ground: false, color: null };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export default {
  id: 'void', name: 'Void', key: '7', hue: '#8a3dff',
  shape: 'projectile', forms: ['Singularity', 'Rift'], speed: 6, radius: 0.35,
  params: { size: 1, speed: 6, gravity: 1, lensing: 1, disk: 1, temperature: 4800, beaming: 0.35, tendrils: 1, corruption: 1, collapse: 1, hold: 2.6, tint: '#ffffff', edge: '#9a4dff' },
  ranges: { size: [0.4, 2, 0.01], speed: [2, 16, 0.1], gravity: [0.3, 3, 0.01], lensing: [0, 3, 0.01], disk: [0, 2, 0.01], temperature: [2500, 20000, 10], beaming: [0, 0.95, 0.01], tendrils: [0, 3, 0.01], corruption: [0, 3, 0.01], collapse: [0, 3, 0.01], hold: [0.8, 6, 0.1] },
  presets: {
    gargantua: { temperature: 4600, beaming: 0.6, tendrils: 0.25, lensing: 1.6, size: 1.3, tint: '#ffd6a8' },
    'violet disk': { temperature: 14000, tint: '#9b62ff', edge: '#c070ff' },
    abyssal: { temperature: 3400, tint: '#ff7088', edge: '#ff2a60', corruption: 2, tendrils: 1.8 },
  },
  timing: { charge: 1.0, impact: 0.55, linger: 3.2 },
  kinds: {
    // shaded by the spell's own Doppler pass; black in the shared glow draw
    disk: { style: 'glow', orbit: true, drag: 0, life: [0.6, 1.2], size: [0.012, 0.012], emissive: 0, color: ['#000000', '#000000'], alpha: [1, 1], forceResponse: 1 },
    mote: { style: 'glow', drag: 0.2, life: [0.7, 1.1], size: [0.016, 0.006], stretch: 0.03, emissive: 2.4, color: ['#a780ff', '#6a2dff'], alpha: [0.3, 1], fadeIn: 0.3, fadeOut: 0.1, forceResponse: 1 },
    spark: { style: 'glow', drag: 1.1, gravity: 1.5, life: [0.5, 1.5], size: [0.028, 0.008], stretch: 0.04, emissive: 7, color: ['#f4ecff', '#7b2dff'], alpha: [1, 0], forceResponse: 0.3 },
    drain: { style: 'media', absorbing: true, drag: 0.4, life: [0.8, 1.3], size: [1.1, 0.2], sizePow: 0.6, color: ['#020104', '#000000'], alpha: [0.75, 0.95], density: 3.5, erosion: 0.35, fadeIn: 0.35, fadeOut: 0.1, forceResponse: 1 },
    smoke: { style: 'media', absorbing: true, drag: 2.4, buoyancy: 0.2, curl: 0.9, curlScale: 0.25, life: [1.6, 3.2], size: [0.8, 2.8], sizePow: 0.6, color: ['#0d0718', '#07050c'], alpha: [0.85, 0], density: 2.2, erosion: 0.5, fadeIn: 0.04, forceResponse: 0.35 },
    // torn off the floor by the rift
    debris: { style: 'debris', mesh: 'rock', gravity: 2.2, drag: 0.15, restitution: 0.2, friction: 0.5, life: [1.6, 3], size: [0.05, 0.05], spin: 7, color: ['#17131d', new THREE.Color(0.05, 0.015, 0.1)], alpha: [1, 1], fadeOut: 0.1, forceResponse: 1 },
    dust: { style: 'media', drag: 0.9, curl: 1.5, curlScale: 0.4, life: [1.1, 2.2], size: [0.26, 0.8], sizePow: 0.5, color: ['#4a4450', '#26222c'], alpha: [0.34, 0], fadeIn: 0.25, fadeOut: 0.2, density: 1.4, erosion: 0.9, lightResponse: 0.4, forceResponse: 1 },
    // Rift's seal: molten spatter thrown off the seam, falling
    spatter: { style: 'glow', drag: 0.7, gravity: 7, restitution: 0.25, friction: 0.5, life: [0.35, 0.9], size: [0.022, 0.006], stretch: 0.045, emissive: 6, color: ['#f0d8ff', '#8a3dff'], alpha: [1, 0], forceResponse: 0.4 },
    ash: { style: 'media', absorbing: true, drag: 1.4, curl: 1.4, curlScale: 0.5, life: [1.0, 2.2], size: [0.09, 0.03], color: ['#000000', '#030106'], alpha: [0.95, 0], density: 25, erosion: 0.15, fadeIn: 0.1, forceResponse: 0.6 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const diskEm = P.emitter('void.disk', { shape: 'sphere', radius: 0.05, spread: 0.2 });
    const moteEm = P.emitter('void.mote', { shape: 'shell', radius: 2.4, spread: 0.3, radial: -1.5 });
    const drainEm = P.emitter('void.drain', { shape: 'shell', radius: 1.8, spread: 0.2, radial: -0.8 });
    const sparkEm = P.emitter('void.spark', { shape: 'shell', radius: 0.3, spread: 3, radial: 14 });
    const smokeEm = P.emitter('void.smoke', { shape: 'sphere', radius: 0.6, spread: 1, radial: 5 });
    const ashEm = P.emitter('void.ash', { shape: 'line', radius: 0.05, spread: 0.4, radial: 1.6 });
    const debrisEm = P.emitter('void.debris', { shape: 'sphere', radius: 0.12, spread: 0.7 });
    const dustEm = P.emitter('void.dust', { shape: 'sphere', radius: 0.25, spread: 0.3 });
    // Rift's seal: spatter off the two closing points as the seam zips shut, then a sheet of it
    // sprayed off the whole seam (grinder sparks off a weld line, not a ball from one point)
    const zipEm = P.emitter('void.spatter', { shape: 'sphere', radius: 0.05, spread: 1.2, radial: 2.6 });
    const seamEm = P.emitter('void.spatter', { shape: 'line', radius: 0.03, spread: 1.0, radial: 4.5 });
    const seamSmoke = P.emitter('void.smoke', { shape: 'line', radius: 0.12, spread: 0.5, radial: 1.4 });
    const SCAR = { a: new THREE.Vector3(), b: new THREE.Vector3(), branches: 2, subBranches: 2, jag: 0.06, width: 0.014, color: new THREE.Color(), glowColor: new THREE.Color(), intensity: 0, glowWidth: 7, reveal: 1, snapToArena: false, seed: 1, branchSeed: 1 };

    // --- accretion disk motes: one draw over the shared glow window (only void.disk texels shade)
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    quad.instanceCount = 0;
    const VA = [new THREE.Vector4(), new THREE.Vector4()], VB = [new THREE.Vector4(), new THREE.Vector4()];
    const tint = new THREE.Color(1, 1, 1), edge = new THREE.Color(), hue = new THREE.Color(this.hue);
    const disk = new THREE.Mesh(quad, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: DISK_VERT(P.W), fragmentShader: DISK_FRAG, ...LINES_BLENDING,
      uniforms: {
        ...U, uS0: { value: null }, uS1: { value: null }, uS2: { value: null },
        uStyleStart: { value: 0 }, uStyleCount: { value: 0 }, uFieldCount: { value: 0 }, uRingBase: { value: 0 },
        uKind: { value: P.kind('void.disk') }, uVoidA: { value: VA }, uVoidB: { value: VB },
        uDisk: { value: new THREE.Vector4() }, uTint: { value: tint },
      },
    }));
    disk.frustumCulled = false;
    disk.layers.enable(1);   // in the floor reflection too
    disk.visible = false;
    fx.scenes.lines.add(disk);
    let linked = false;
    // the pool's state textures, ring window and instance count exist after particles.build(): share them
    function link() {
      linked = true;
      const g = P.glow.material.uniforms, u = disk.material.uniforms;
      u.uS0 = P.stateU.uS0; u.uS1 = P.stateU.uS1; u.uS2 = P.stateU.uS2;
      u.uStyleStart = g.uStyleStart; u.uStyleCount = g.uStyleCount; u.uFieldCount = g.uFieldCount; u.uRingBase = g.uRingBase;
      disk.geometry = P.glow.geometry;
      quad.dispose();
    }

    // --- tendrils (dark ribbons with violet edges), both forms
    const ribbons = new fx.AnalyticRibbons({ max: MAX_VOIDS * TENDRILS, segments: 40, target: 'fx', pathGLSL: TENDRIL_PATH, shadeGLSL: TENDRIL_SHADE });
    fx.scenes.fx.add(ribbons.mesh);

    // --- per-void resources: horizon sphere + disk stand-in for the floor reflection only (the main
    // view's hole and disk are traced by Lens.js), rift tear, tendril state
    const horizonGeo = new THREE.SphereGeometry(1, 40, 20);
    const horizonMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    const tearGeo = new THREE.PlaneGeometry(2, 2);
    const jag = jagTexture();
    const riftFrag = COMMON_GLSL + NOISE_GLSL + REFRACT_GLSL + RIFT_FRAG(fx.Q.mobile ? 5 : 10, fx.Q.mobile ? 2 : 3);
    const slots = Array.from({ length: MAX_VOIDS }, (_, i) => {
      const sphere = new THREE.Mesh(horizonGeo, horizonMat);
      sphere.visible = false;
      sphere.layers.set(1);
      fx.scenes.opaque.add(sphere);
      const proxyU = { uCol: { value: new THREE.Color() }, uIn: { value: 0.2 } };
      const proxy = new THREE.Mesh(tearGeo, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: PROXY_VERT, fragmentShader: PROXY_FRAG, uniforms: proxyU, ...LINES_BLENDING, side: THREE.DoubleSide,
      }));
      proxy.visible = false;
      proxy.layers.set(1);
      fx.scenes.lines.add(proxy);
      const riftU = {
        ...U, uJag: { value: jag }, uC: { value: new THREE.Vector3() }, uR: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) }, uN: { value: new THREE.Vector3(0, 0, 1) },
        uHalf: { value: new THREE.Vector2(1, 1) }, uRim: { value: new THREE.Color() }, uHot: { value: new THREE.Color() },
        uRift: { value: new THREE.Vector4() }, uRift2: { value: new THREE.Vector4() },
      };
      const riftMesh = (mode) => {
        const m = new THREE.Mesh(tearGeo, new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3, vertexShader: RIFT_VERT, fragmentShader: riftFrag, uniforms: { ...riftU, uMode: { value: mode } }, side: THREE.DoubleSide, depthWrite: mode === 0,
        }));
        m.frustumCulled = false;
        m.visible = false;
        fx.scenes.refract.add(m);
        return m;
      };
      const riftIn = riftMesh(0), riftOut = riftMesh(1);
      return {
        i, busy: false, R: 0, E: 0, lens: 0, sphere, proxy, proxyU, riftIn, riftOut, riftU, held: false, wrote: new THREE.Vector3(),
        rOn: false, open: 0, reach: 0, shear: 0, flare: 0, lean: 0, face: new THREE.Vector3(),
        // traced disk: r_s (m), inner / outer (r_s), intensity, temperature scale, spin rate, phase, bending, shadow
        dOn: false, mote: false, rs: 0.1, din: 3, dout: 13, dI: 0, dT: 1, phase: 0, bend: 1, shad: 1, twist: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), axis: new THREE.Vector3(), e1: new THREE.Vector3(), e2: new THREE.Vector3(),
        tend: [], tdir: Array.from({ length: TENDRILS }, () => new THREE.Vector3()), tcyc: new Int32Array(TENDRILS),
        trate: new Float32Array(TENDRILS), toff: new Float32Array(TENDRILS), tlen: new Float32Array(TENDRILS), tlash: new Uint8Array(TENDRILS),
      };
    });
    const takeSlot = () => { for (const s of slots) if (!s.busy) { s.busy = true; return s; } return null; };
    // per cast record scratch (cast.js pools 16 records)
    const recs = Array.from({ length: 16 }, () => ({ base: new THREE.Vector3(), prev: new THREE.Vector3(), side: new THREE.Vector3() }));

    let lensWas = false, invT = -1, invAmt = 1;
    const shell = fx.lens.shell;

    const gm = (p) => 45 * p.size * p.gravity;
    const seeded = (c, k) => (((c.seed * 2654435761) ^ (k * 40503)) >>> 0) % 1000;

    return {
      onParam(k, v) { if (k === 'tint') tint.set(v); if (k === 'edge') edge.set(v); },
      travel(c, dt) {
        const p = S.params, d = c.data, r = recs[c.index];
        if (c.form === 'Rift') { c.pos.copy(d.s ? d.s.pos : c.to); c.vel.set(0, 0, 0); return c.t >= p.hold; }
        d.dist += p.speed * dt;
        r.base.copy(c.from).addScaledVector(c.dir, Math.min(d.dist, d.total));
        const w = 0.2 * p.size * Math.min(1, d.dist / 1.2);
        r.prev.copy(c.pos);
        c.pos.copy(r.base).addScaledVector(r.side, Math.sin(c.t * 3.7 + d.ph) * w).addScaledVector(UP, Math.sin(c.t * 2.6 + d.ph * 1.7) * w * 0.6);
        if (dt > 0) c.vel.subVectors(c.pos, r.prev).divideScalar(dt);
        c.travelled = d.dist;
        return d.dist >= d.total || (d.dist > 1 && arenaSDF(c.pos) < 0.35 * p.size) || c.t > 10;
      },

      phase(c, name) {
        const p = S.params, d = c.data, r = recs[c.index];
        tint.set(p.tint); edge.set(p.edge);
        if (name === 'charge') {
          if (c.form === 'Rift') c.durations.charge = 0.6;
          d.s = takeSlot(); d.light = fx.lights.acquire(); d.grav = fx.forces.acquire();
          d.banged = false; d.splatT = 0; d.dist = 0; d.shockR = 0; d.ph = fx.rand() * 6.28; d.scar = null;
          d.total = c.from.distanceTo(c.to);
          if (d.light) { d.light.range = 9; d.light.intensity = 0; d.light.shadow = true; }
          if (d.grav) { d.grav.type = 2; d.grav.pos.copy(c.from); d.grav.p[0] = 0; d.grav.p[1] = 0.3; d.grav.p[2] = 0.15; d.grav.p[3] = 6; }
          const s = d.s;
          if (s) {
            s.R = s.E = s.lens = s.dI = 0; s.dOn = s.mote = false; s.tend.length = 0;
            s.pos.copy(c.from); s.vel.set(0, 0, 0);
            if (c.form === 'Rift') {
              // the tear hangs in front of the target (between it and the caster), its low tip just off the floor
              _a.subVectors(c.to, c.from).setY(0).normalize();
              s.pos.copy(c.to).addScaledVector(_a, c.target >= 0 ? -1.15 : 0);
              s.pos.y = RIFT_H * p.size + 0.15;
              s.face.copy(_a).negate(); s.lean = (fx.rand() - 0.5) * 0.3;
              s.riftU.uRift.value.set(RIFT_H * p.size, RIFT_W * p.size, seeded(c, 3) / 1000, 0);
              s.riftU.uHalf.value.set((RIFT_W + 2) * p.size + 0.4, (RIFT_H + 2) * p.size + 0.2);
              s.riftU.uRim.value.copy(edge).multiplyScalar(2.2);
              s.riftU.uHot.value.copy(edge).lerp(_col.setRGB(1, 1, 1), 0.82).multiplyScalar(3.4);
              s.rOn = true; s.open = 0; s.reach = 0.3; s.shear = 0; s.flare = 0.3;
              if (d.grav) { d.grav.pos.copy(s.pos); d.grav.p[1] = 0.4; d.grav.p[2] = 0.5; d.grav.p[3] = 9; }
            } else {
              // disk tilted ~13 degrees towards the camera: Gargantua's near-edge-on view
              _a.subVectors(fx.camera.position, c.from).setY(0).normalize();
              s.axis.copy(UP).addScaledVector(_a, 0.23).normalize();
              s.e1.crossVectors(s.axis, c.dir).normalize();
              if (s.e1.lengthSq() < 0.5) s.e1.set(1, 0, 0);
              s.e2.crossVectors(s.axis, s.e1);
              s.phase = fx.rand() * 30; s.bend = 1; s.shad = 1; s.dT = 1; s.din = 3; s.dout = DISK_OUT;
              s.mote = true;
            }
          }
          r.side.crossVectors(c.dir, UP).normalize();
        } else if (name === 'release') {
          fx.arena.setFocus(hue, 0.4);
          fx.rig.shake(0.15, 8);
          const s = d.s;
          if (!s) return;
          if (c.form === 'Singularity') {
            for (let i = 0; i < 6; i++) {
              const h = ribbons.acquire();
              if (!h) break;
              s.tend.push(h);
              s.toff[i] = fx.rand() * 6.28;
              s.tlen[i] = (1.6 + 0.8 * fx.rand()) * p.size;
            }
          } else {
            // thin dark whips, fewer than the wound has room for: the tear is the subject
            for (let i = 0; i < 3; i++) {
              const h = ribbons.acquire();
              if (!h) break;
              s.tend.push(h);
              s.trate[i] = 1 / (1.1 + 0.6 * fx.rand());
              s.toff[i] = -0.35 - 0.7 * fx.rand();
              s.tcyc[i] = -99;
            }
            corrupt(s.pos, 1.5 * p.size, 0.7 * p.corruption, c, 'radial');
            corrupt(s.pos, 3.2 * p.size, 0.22 * p.corruption, c, 'lichtenberg', 1.5);
            fx.impacts.add('corruption', s.pos, 3 * p.size, 0.8, p.hold + 4, edge);
          }
        } else if (name === 'impact') {
          d.banged = false;
        } else if (name === 'done') {
          d.light?.release(); d.grav?.release(); d.scar?.release();
          d.light = d.grav = d.scar = null;
          const s = d.s;
          if (s) {
            for (const h of s.tend) h.release();
            s.tend.length = 0;
            s.busy = false; s.dOn = s.mote = false; s.lens = 0; s.R = 0;
            s.sphere.visible = s.proxy.visible = false; s.rOn = false;
          }
          d.s = null;
          fx.arena.setFocus(hue, 2.5);
        }
      },

      update(c, dt) {
        const p = S.params, d = c.data, s = d.s, L = d.light, G = d.grav;
        const R0 = SHADOW * p.size, rs0 = R0 / B_CRIT, I0 = DISK_I * p.disk;
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge;
          fx.arena.setFocus(hue, 2.5 * (1 - k) * (1 - k) + 0.04);
          if (c.form === 'Rift') {
            // a hairline first, the air around it starting to slide
            if (s) { s.open = 0.03 * k; s.reach = 0.3 + 0.55 * k * k; s.shear = 0.14 * k * k; s.flare = 0.3 + 0.8 * k; }
            if (G) G.p[0] = 12 * k * p.gravity;
            return;
          }
          moteEm.pos.copy(c.from); moteEm.radius = 2.4; moteEm.rate(1800 * k, dt);
          drainEm.pos.copy(c.from); drainEm.radius = 1.8; drainEm.rate(90, dt);
          if (G) G.p[0] = 4 + 30 * k;
          if (s && c.form === 'Singularity') {
            // the horizon condenses, then the disk ignites from the inside out as the infall arrives
            const g = smooth(0.4, 1, k), ig = smooth(0.55, 1, k);
            s.R = R0 * g; s.E = EINSTEIN * s.R; s.lens = p.lensing * g; s.rs = Math.max(rs0 * g, 1e-3); s.shad = Math.min(1, g * 4);
            s.din = 3; s.dout = 3 + 4 * ig; s.dI = I0 * ig * ig; s.dOn = p.disk > 0 && g > 0.01; s.twist = 0;
            s.phase += dt * (1 + 2 * (1 - ig));
            hole(s, c.from);
            if (L) { L.pos.copy(c.from); diskColor(p, L.color); L.intensity = 6 * p.disk * ig; }
          }
          return;
        }
        if (c.form === 'Rift') { rift(c, dt, p, d, s, L, G); return; }

        // --- Singularity
        if (c.phase === 'travel') {
          fx.arena.setFocus(hue, Math.min(2.5, 0.4 + c.t * 2));
          const GM = gm(p);
          if (G) { G.pos.copy(c.pos); G.p[0] = GM; G.p[1] = 0.12; G.p[2] = rs0 * 1.6; G.p[3] = 30; }
          if (s) {
            s.pos.copy(c.pos); s.vel.copy(c.vel);
            s.R = R0; s.E = EINSTEIN * R0; s.lens = p.lensing; s.rs = rs0; s.shad = 1; s.bend = 1;
            s.din = 3; s.dout = 7 + (DISK_OUT - 7) * smooth(0, 0.45, c.t); s.dI = I0 * (1 + 0.06 * Math.sin(c.age * 5.3) * Math.sin(c.age * 3.1)); s.dT = 1; s.dOn = p.disk > 0;
            s.twist = 0.25 * p.lensing;
            s.phase += dt;
            hole(s, c.pos);
            if (p.disk > 0) infall(s, dt, GM, 1500 * p.disk);
            tendrils(s, c, p, Math.min(1, c.t / 0.35));
          }
                    d.splatT -= dt;
          if (d.splatT <= 0 && p.corruption > 0) { d.splatT = 0.2; corrupt(c.pos, 0.8 * p.size, 1.25 * p.corruption, c, 'noise'); }
          if (L) { L.pos.copy(c.pos); diskColor(p, L.color); L.intensity = 16 * p.disk; }
          for (const dm of fx.dummies) {
            const dist = Math.hypot(dm.pos.x - c.pos.x, dm.pos.z - c.pos.z);
            if (dist < 2.5 * p.size) dm.status.corrupt = Math.max(dm.status.corrupt, 0.6 * (1 - dist / (2.5 * p.size)));
          }
          swirlPool(c.pos);
          return;
        }

        if (c.phase === 'impact') {
          const t = c.t;
          if (t < 0.3) {
            // implosion: the disk plunges, spins up and heats, the horizon shrinks, the lens spikes
            const k = t / 0.3, GM = gm(p), cp = Math.min(p.collapse, 1.5);
            if (G) { G.pos.copy(c.pos); G.p[0] = GM * (1 + 10 * k * p.collapse); G.p[2] = rs0 * 1.6; }
            if (s) {
              s.vel.set(0, 0, 0);
              s.rs = rs0 * (1 - 0.55 * k * k * cp / 1.5); s.R = s.rs * B_CRIT;
              s.E = EINSTEIN * R0; s.lens = p.lensing * (1 + 0.5 * k * k); s.twist = p.lensing * (0.25 + 1.2 * k * k * cp);
              s.din = 3 - 1.3 * k; s.dout = DISK_OUT * (1 - 0.55 * k) * rs0 / s.rs;
              s.dI = I0 * (1 + 3 * k * k * cp); s.dT = 1 + 0.7 * k * cp;
              s.phase += dt * (1 + 6 * k * k);
              hole(s, s.pos);
              if (p.disk > 0) infall(s, dt, GM * (1 + 4 * k), 4000 * p.disk * (1 - k));
              tendrils(s, c, p, 1 - k);
            }
            if (L) { L.intensity = 16 * p.disk * (1 + 1.5 * k * k); diskColor(p, L.color, 1 + 0.7 * k); }
            return;
          }
          if (!d.banged) bang(c, p, d, s, R0);
          const k = (t - 0.3) / 0.12, kr = (t - 0.3) / 0.4;
          if (s) {
            s.lens = Math.max(0, p.lensing * 1.5 * (1 - k)); s.twist = p.lensing * 1.4 * Math.max(0, 1 - k);
            // the disk, let go, flies out as a white-hot ring
            if (kr < 1 && p.disk > 0) {
              const rw = 0.5 + 6 * p.size * (1 - (1 - kr) ** 2.5);
              s.din = 0.85 * rw / s.rs; s.dout = 1.25 * rw / s.rs;
              s.dI = I0 * 0.9 * Math.max(p.collapse, 0.3) * (1 - kr) ** 3;
              s.dT = 1.5 - 0.7 * kr; s.phase += dt * 3;
              hole(s, s.pos);
            } else { s.dOn = false; s.proxy.visible = false; }
          }
        }
        // after the bang: the shock shell runs out and lets go
        if (G && G.type === 4) {
          d.shockR += dt * 16;
          G.p[0] = d.shockR; G.p[2] = 170 * p.collapse * Math.max(0, 1 - d.shockR / 14);
          if (d.shockR > 14) { G.release(); d.grav = null; }
        }
        if (L) L.intensity *= Math.exp(-dt * 5);
        if (s && c.phase === 'linger') { s.lens = 0; s.dOn = false; s.proxy.visible = false; }
      },

      tick(dt) {
        if (!linked && P.built) link();
        const p = S.params, LN = fx.lens;
        let lensOn = false, moteOn = false;
        for (const s of slots) {
          const on = s.busy && (s.lens > 0 || s.dOn);
          if (on) {
            LN.set(s.i, s.pos, Math.max(s.E, 1e-3), Math.max(s.R, 1e-4), Math.max(s.lens, 1e-3));
            if (s.dOn) {
              const D = LN.lenses[s.i].disk;
              D.on = true; D.axis.copy(s.axis); D.rs = s.rs; D.inner = s.din; D.outer = s.dout;
              D.temperature = p.temperature * s.dT; D.beaming = 0.5 + 1.5 * p.beaming; D.intensity = s.dI; D.tint.copy(tint);
              D.phase = s.phase; D.spin = 2.4; D.bend = s.bend; D.shadow = s.shad; D.twist = s.twist;
            }
            s.wrote.copy(s.pos); s.held = true;
          } else if (s.held) {
            // only clear the slot if it still holds what we wrote (Supernova may have taken it)
            const l = LN.lenses[s.i];
            if (l.pos.equals(s.wrote)) { l.strength = 0; l.disk.on = false; }
            s.held = false;
          }
          lensOn = lensOn || on;
          const mk = s.busy && s.mote;
          VA[s.i].set(s.pos.x, s.pos.y, s.pos.z, mk ? 3 * s.rs : 0);
          VB[s.i].set(s.vel.x, s.vel.y, s.vel.z, s.R);
          moteOn = moteOn || mk;
          s.riftIn.visible = s.riftOut.visible = s.rOn;
          if (s.rOn) riftPose(s);
        }
        // the collapse's photographic-negative shell, ~0.2 s
        if (invT >= 0) {
          invT += dt;
          const k = invT / 0.2;
          if (k >= 1) { shell.amount = 0; invT = -1; }
          else { shell.radius = 0.25 + 6 * p.size * (1 - (1 - k) ** 2); shell.thickness = 0.08 + 0.2 * shell.radius; shell.amount = invAmt * (1 - k) ** 1.5; }
          lensOn = true;
        }
        // other users (Supernova) may hold a slot: only switch the pass off when nobody does
        if (lensOn) LN.active = true;
        else if (lensWas && !LN.warming && !(LN.lenses[0].strength > 1e-4) && !(LN.lenses[1].strength > 1e-4)) LN.active = false;
        lensWas = lensOn;
        disk.material.uniforms.uDisk.value.set(p.temperature * 0.8, 1.2, p.beaming, 0.007 * Math.sqrt(p.size));
        disk.visible = moteOn;
        ribbons.update();
      },
    };

    function diskColor(p, out, k = 1) { blackbodyRGB(p.temperature * 0.85 * k, out); out.r *= tint.r; out.g *= tint.g; out.b *= tint.b; return out; }

    // the reflection-only horizon and disk stand-in follow the traced hole
    function hole(s, pos) {
      s.sphere.visible = s.shad > 0.01; s.sphere.position.copy(pos); s.sphere.scale.setScalar(Math.max(s.R, 1e-3));
      s.proxy.visible = s.dOn;
      if (s.dOn) {
        s.proxy.position.copy(pos); s.proxy.quaternion.setFromUnitVectors(Z, s.axis); s.proxy.scale.setScalar(s.dout * s.rs);
        diskColor(S.params, s.proxyU.uCol.value, s.dT).multiplyScalar(s.dI * 1.6);
        s.proxyU.uIn.value = s.din / s.dout;
      }
    }

    // the tear turns part way to the camera (faces it where the caster's line is edge-on), so orbiting
    // still swings the funnel across the opening and it never goes edge-on
    function riftPose(s) {
      const u = s.riftU, ca = Math.cos(s.lean), sa = Math.sin(s.lean);
      _a.subVectors(fx.camera.position, s.pos).setY(0).normalize();
      const k = Math.max(-1, Math.min(1, s.face.dot(_a) * 4));
      _b.copy(_a).addScaledVector(s.face, 0.7 * k).normalize();
      _r.crossVectors(UP, _b).normalize();
      u.uC.value.copy(s.pos); u.uN.value.copy(_b);
      u.uR.value.copy(_r).multiplyScalar(ca).addScaledVector(UP, -sa);
      u.uUp.value.copy(UP).multiplyScalar(ca).addScaledVector(_r, sa);
      u.uRift.value.w = s.open;
      u.uRift2.value.set(s.reach, s.shear, s.flare, 0);
    }

    function corrupt(pos, radius, amount, c, pattern, crack = 0) {
      SPLAT.x = pos.x; SPLAT.z = pos.z; SPLAT.radius = radius; SPLAT.corruption = amount; SPLAT.crack = crack; SPLAT.pattern = pattern;
      SPLAT.seed = (c.seed + c.age * 37) % 100;
      fx.ground.splat(SPLAT);
    }

    function swirlPool(pos) {
      const pool = fx.ARENA.pool;
      if (pos.y < 3 && Math.abs(pos.x - pool.center.x) < pool.half.x + 1 && Math.abs(pos.z - pool.center.y) < pool.half.y + 1) fx.pool?.swirl?.(pos.x, pos.z, 1.5);
    }

    // infall: gas peeled in from beyond the disk's rim on plunging, sub-Keplerian orbits about the
    // moving centre (Galilean: gravity doesn't care that the hole drifts), streaking in under real 1/r^2
    function infall(s, dt, GM, rate) {
      const rim = s.dout * s.rs;
      for (let i = 0; i < 4; i++) {
        const rr = rim * (0.8 + 0.7 * fx.rand()), a = fx.rand() * Math.PI * 2, el = (fx.rand() - 0.5) * 0.7;
        _r.copy(s.e1).multiplyScalar(Math.cos(a)).addScaledVector(s.e2, Math.sin(a));
        _t.crossVectors(s.axis, _r);
        const v = Math.sqrt(GM / rr);
        diskEm.pos.copy(s.pos).addScaledVector(_r, rr * Math.cos(el)).addScaledVector(s.axis, rr * Math.sin(el));
        diskEm.vel.copy(s.vel).addScaledVector(_t, v * (0.35 + 0.35 * fx.rand())).addScaledVector(_r, -0.3 * v).addScaledVector(s.axis, -v * Math.sin(el) * 0.8);
        diskEm.radius = 0.05 * rr; diskEm.spread = 0.05 * v;
        diskEm.rate(rate / 4, dt);
      }
    }

    // singularity tendrils: six arms leaving the horizon above and below the disk, dragged round with it
    function tendrils(s, c, p, ext) {
      const n = s.tend.length;
      for (let i = 0; i < n; i++) {
        const h = s.tend[i], a = s.toff[i] + i * 1.047 + c.age * 1.1, el = (i % 2 ? 1 : -1) * (0.45 + 0.2 * Math.sin(c.age * 1.3 + i));
        _a.copy(s.e1).multiplyScalar(Math.cos(a)).addScaledVector(s.e2, Math.sin(a)).addScaledVector(s.axis, el).normalize();
        _b.copy(s.pos).addScaledVector(_a, s.R * 1.1);
        h.p0.set(_b.x, _b.y, _b.z, s.toff[i]);
        h.p1.set(_a.x, _a.y, _a.z, s.tlen[i]);
        h.p2.set(0.08 * p.size, 0.12, -2.2, ext);
        h.p3.set(5, 7, 0, 0.85);
        h.color.copy(edge);
        h.intensity = 1.2 * p.tendrils;
      }
    }

    function bang(c, p, d, s, R0) {
      d.banged = true;
      const pos = c.pos, cp = p.collapse;
      if (s) {
        s.sphere.visible = false; s.R = 0; s.E = 2.6 * R0; s.shad = 0; s.bend = 0;
        for (const h of s.tend) h.release();
        s.tend.length = 0;
      }
      if (d.grav) { d.grav.type = 4; d.grav.pos.copy(pos); d.grav.p[0] = 0.3; d.grav.p[1] = 1.4; d.grav.p[2] = 170 * cp; d.grav.p[3] = 0; d.shockR = 0.3; }
      invT = 0; shell.pos.copy(pos); shell.radius = 0.25; shell.amount = 0; invAmt = fx.reduced ? 0.35 : Math.min(1, 0.6 + 0.4 * cp);
      sparkEm.pos.copy(pos); sparkEm.radial = 14 * Math.sqrt(cp); sparkEm.burst(3000 * cp);
      smokeEm.pos.copy(pos); smokeEm.size = p.size; smokeEm.burst(50 * Math.max(cp, 0.3));
      SHOCK.pos.copy(pos); SHOCK.radius0 = 0.2; SHOCK.radius1 = 9 * p.size; SHOCK.duration = 0.7; SHOCK.thickness = 1.4; SHOCK.distortion = 0.18 * cp; SHOCK.ground = false;
      fx.shocks?.spawn(SHOCK);
      SHOCK.pos.setY(0.05); SHOCK.radius1 = 7 * p.size; SHOCK.duration = 0.55; SHOCK.thickness = 0.7; SHOCK.distortion = 0.08 * cp; SHOCK.ground = true;
      fx.shocks?.spawn(SHOCK);
      corrupt(pos, 2.2 * p.size, 2.3 * p.corruption, c, 'radial');
      fx.impacts.add('corruption', pos, 4 * p.size, 1, 10, edge);
      if (d.light) { _col.copy(edge).lerp(diskColor(p, _col2, 2), 0.5); d.light.color.copy(_col); d.light.intensity = 50 * cp; d.light.range = 14; d.light.pos.copy(pos); }
      fx.flash(0.3 * cp);
      fx.rig.shake(0.65 * cp, 13);
      if (!fx.reduced) { fx.rig.punch(3.5, 0.09); fx.rig.hitstop(0.07); }
      for (const dm of fx.dummies) {
        const dist = Math.hypot(dm.pos.x - pos.x, dm.pos.z - pos.z), reach = 4 * p.size;
        if (dist < reach) {
          dm.status.corrupt = Math.max(dm.status.corrupt, 1 - dist / reach + 0.4);
          dm.hit(_a.subVectors(dm.pos, pos).setY(0).normalize(), (1 - dist / reach) * cp);
        }
      }
    }

    function rift(c, dt, p, d, s, L, G) {
      const pos = s ? s.pos : c.to, sz = p.size, H = RIFT_H * sz;
      if (c.phase === 'travel') {
        fx.arena.setFocus(hue, Math.min(2.5, 0.4 + c.t * 2));
        // it tears open from the middle to the tips, then the wound breathes
        const open = smooth(0, 0.5, c.t), reach = 0.85 + 0.15 * smooth(0, 0.25, c.t);
        if (s) {
          s.open = (0.03 + 0.97 * open) * (1 + 0.05 * Math.sin(c.age * 3.1) * Math.sin(c.age * 7.3));
          s.reach = reach; s.shear = p.lensing * (0.14 + 0.86 * smooth(0, 0.35, c.t)); s.flare = 1.1 + 1.2 * (1 - open);
          riftTendrils(s, c, p, 1);
        }
        if (G) { G.pos.copy(pos); G.p[0] = 34 * sz * p.gravity; G.p[1] = 0.4; G.p[2] = 0.5; G.p[3] = 9; }
        // the floor comes apart and is dragged in: rocks flung up off a ring, dust peeled along the ground
        for (let i = 0; i < 2; i++) {
          const a = fx.rand() * 6.283, r = (1.6 + 4.2 * fx.rand()) * sz;
          debrisEm.pos.set(pos.x + Math.cos(a) * r, 0.1, pos.z + Math.sin(a) * r);
          debrisEm.vel.set(0, 1.4 + 2.2 * fx.rand(), 0);
          debrisEm.rate(26 * open, dt);
          const a2 = fx.rand() * 6.283, r2 = (2 + 3.6 * fx.rand()) * sz;
          dustEm.pos.set(pos.x + Math.cos(a2) * r2, 0.18, pos.z + Math.sin(a2) * r2);
          dustEm.vel.set(0, 0.5, 0);
          dustEm.rate(11 * open, dt);
        }
        // a few sparks and motes spit off the burning edge, a thin dark ash where it tears
        _a.copy(pos).addScaledVector(UP, (fx.rand() - 0.5) * 1.7 * H);
        sparkEm.pos.copy(_a); sparkEm.radial = 2.2; sparkEm.rate(18 * open, dt);
        moteEm.pos.copy(pos); moteEm.radius = 2.6 * sz; moteEm.rate(45 * open, dt);
        ashEm.pos.copy(pos).addScaledVector(UP, -0.9 * H); ashEm.p.copy(pos).addScaledVector(UP, 0.9 * H); ashEm.rate(50 * open, dt);
        // corruption spreads out from under it, in patches
        d.splatT -= dt;
        if (d.splatT <= 0 && p.corruption > 0) {
          d.splatT = 0.3;
          const a = fx.rand() * 6.283, r = (0.8 + 2.8 * smooth(0, p.hold, c.t) * (0.5 + 0.5 * fx.rand())) * sz;
          _a.set(pos.x + Math.cos(a) * r, 0, pos.z + Math.sin(a) * r);
          corrupt(_a, (0.9 + 0.5 * fx.rand()) * sz, 0.42 * p.corruption, c, 'noise');
        }
        if (L) { L.pos.copy(pos); L.color.copy(edge); L.intensity = 11 * open * (0.8 + 0.2 * Math.sin(c.age * 31) * Math.sin(c.age * 13)); }
        for (const dm of fx.dummies) {
          const dist = Math.hypot(dm.pos.x - pos.x, dm.pos.z - pos.z);
          if (dist < 3.2 * sz) dm.status.corrupt = Math.max(dm.status.corrupt, 1.2 - dist / (3.2 * sz));
        }
        return;
      }
      if (c.phase === 'impact') {
        // it snaps shut, the edge flaring, the shear whipping back
        const k = Math.min(1, c.t / 0.16);
        const up = s ? s.riftU.uUp.value : UP;
        if (s && s.rOn) {
          s.open = (1 - k) * (1 - k); s.shear = p.lensing * (1 + 0.8 * Math.sin(k * 3.14)) * (1 - k * k); s.flare = 2 + 7 * k;
          riftTendrils(s, c, p, 1 - k);
          // it zips shut from both tips towards the middle, spitting at the closing points
          const yz = 0.92 * H * (1 - k);
          zipEm.pos.copy(pos).addScaledVector(up, yz); zipEm.burst(16 * p.collapse);
          zipEm.pos.copy(pos).addScaledVector(up, -yz); zipEm.burst(16 * p.collapse);
          if (k >= 1) s.rOn = false;
        }
        if (k >= 1 && !d.banged) {
          d.banged = true;
          seamEm.pos.copy(pos).addScaledVector(up, -0.55 * H); seamEm.p.copy(pos).addScaledVector(up, 0.55 * H);
          seamEm.vel.set(0, 0.8, 0); seamEm.burst(240 * p.collapse);
          ashEm.pos.copy(seamEm.pos); ashEm.p.copy(seamEm.p); ashEm.burst(90);
          // the scar: the closed seam still burning, a thin jagged line that cools in half a second
          SCAR.a.copy(pos).addScaledVector(up, -0.85 * H); SCAR.b.copy(pos).addScaledVector(up, 0.85 * H);
          SCAR.color.copy(edge).lerp(_col.setRGB(1, 1, 1), 0.6); SCAR.glowColor.copy(edge).multiplyScalar(0.12);
          SCAR.intensity = 26 * p.collapse; SCAR.seed = (c.seed * 7 + 3) & 0xffffff; SCAR.branchSeed = (c.seed * 13 + 5) & 0xffffff;
          d.scar = fx.bolts.acquire(SCAR);
          // a thin sheet of smoke breathed out along the seam, not a ball at its middle
          seamSmoke.pos.copy(SCAR.a); seamSmoke.p.copy(SCAR.b); seamSmoke.size = 0.4 * sz; seamSmoke.burst(22);
          SHOCK.pos.copy(pos); SHOCK.radius0 = 0.1; SHOCK.radius1 = 5 * sz; SHOCK.duration = 0.5; SHOCK.thickness = 0.9; SHOCK.distortion = 0.12 * p.collapse; SHOCK.ground = false;
          fx.shocks?.spawn(SHOCK);
          if (G) { G.type = 4; G.pos.copy(pos); G.p[0] = 0.2; G.p[1] = 1; G.p[2] = 60 * p.collapse; d.shockR = 0.2; }
          if (L) L.intensity = 12 * p.collapse;
          fx.flash(0.12 * p.collapse);
          fx.rig.shake(0.3 * p.collapse, 14);
          if (s) { for (const h of s.tend) h.release(); s.tend.length = 0; }
        }
      }
      if (G && G.type === 4) {
        d.shockR += dt * 12;
        G.p[0] = d.shockR; G.p[2] = 60 * p.collapse * Math.max(0, 1 - d.shockR / 6);
        if (d.shockR > 6) { G.release(); d.grav = null; }
      }
      if (d.scar) { d.scar.intensity *= Math.exp(-dt * 6); if (d.scar.intensity < 0.3) { d.scar.release(); d.scar = null; } }
      if (L) L.intensity *= Math.exp(-dt * 6);
    }

    // rift tendrils: each lashes out (fast), thrashes, retracts, then picks a new direction
    function riftTendrils(s, c, p, gate) {
      const n = s.tend.length, tgt = c.target >= 0 ? fx.dummies[c.target].pos : null;
      for (let i = 0; i < n; i++) {
        const h = s.tend[i], ph = c.t * s.trate[i] + s.toff[i], cyc = Math.floor(ph), f = ph - cyc;
        if (cyc !== s.tcyc[i]) {
          s.tcyc[i] = cyc; s.tlash[i] = 0;
          const dir = s.tdir[i];
          dir.set(fx.rand() - 0.5, (fx.rand() - 0.35) * 0.9, fx.rand() - 0.5).normalize();
          if (tgt && fx.rand() < 0.6) dir.addScaledVector(_a.copy(tgt).setY(0.5 + 1.2 * fx.rand()).sub(s.pos).normalize(), 1.4).normalize();
          s.tlen[i] = (2.4 + 1.1 * fx.rand()) * p.size;
        }
        const e = gate * (ph < 0 ? 0 : f < 0.2 ? 1 - (1 - f / 0.2) ** 3 : f < 0.7 ? 1 : 1 - smooth(0.7, 1, f));
        const dir = s.tdir[i], y = ((i + 0.5) / n - 0.5) * 2.2 * p.size;
        _b.copy(s.pos).addScaledVector(UP, y);
        h.p0.set(_b.x, _b.y, _b.z, i * 0.37 + 0.1);
        h.p1.set(dir.x, dir.y, dir.z, s.tlen[i]);
        h.p2.set(0.055 * p.size, 0.16, 1.2, e);
        h.p3.set(10, 9, 0, 0.85);
        h.color.copy(edge);
        h.intensity = 0.55 * p.tendrils;
        // the lash lands: knock the target, spit sparks at the tip
        if (gate >= 1 && ph > 0 && f >= 0.2 && !s.tlash[i]) {
          s.tlash[i] = 1;
          _b.addScaledVector(dir, s.tlen[i]);
          sparkEm.pos.copy(_b); sparkEm.radial = 4; sparkEm.burst(40);
          if (tgt && _b.distanceTo(_a.copy(tgt).setY(1.1)) < 1.4) { const dm = fx.dummies[c.target]; dm.hit(_a.copy(dir).setY(0).normalize(), 0.25); dm.status.corrupt = 1; }
        }
      }
    }
  },
};
