import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { U } from './common.js';

// Procedural noise, baked on the GPU at load (no assets):
//   noise3D  N^3 RGBA8, tileable on all axes. r = Perlin-Worley fbm (Schneider 2015: Perlin fbm
//            dilated by Worley fbm), g/b/a = inverted Worley F1 fbm at base frequencies 2/4/8.
//   curl3D   64^3 RGBA8, tileable. rgb = curl * 0.5 + 0.5 of a 3-field gradient-noise vector
//            potential (Bridson et al. 2007), divergence-free by construction.
//   blackbody 256x1 RGBA16F, CPU: Planck x Wyman-Sloan-Shirley 2013 CIE fit -> linear sRGB, Y = 1.
// Sampling contract: NOISE_GLSL in common.js.

const HASH = /* glsl */`
precision highp float;
precision highp int;
in vec2 vUv;
uniform float uZ;
// always 1. Loop bounds read it so ANGLE's D3D compiler (FXC) can't unroll the 27-cell
// searches into megabytes of HLSL: unrolled, these two bakes spend ~300 ms compiling.
uniform int uOne;
out vec4 outColor;
// pcg3d (Jarzynski & Olano 2020): cheap and free of lattice artefacts
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
// lattice point -> hash, wrapped at period P so every octave tiles the unit cube. c is always
// within one period of [0, P), so a select replaces two integer modulos per component.
uvec3 hashL(ivec3 c, int P, uint seed) {
  c += P * (ivec3(lessThan(c, ivec3(0))) - ivec3(greaterThanEqual(c, ivec3(P))));
  return pcg3d(uvec3(c) + seed * uvec3(0x9E3779B9u, 0x85EBCA6Bu, 0xC2B2AE35u));
}
vec3 hash3(ivec3 c, int P, uint seed) { return vec3(hashL(c, P, seed) >> 8u) * (1.0 / 16777216.0); }
// inverted Worley F1: 1 at feature points, ~0 on cell borders. x in cells (= p * P)
float worley(vec3 x, int P, uint seed) {
  ivec3 i = ivec3(floor(x));
  vec3 f = fract(x);
  float d = 8.0;
  for (int z = -uOne; z <= uOne; z++) for (int y = -uOne; y <= uOne; y++) for (int k = -uOne; k <= uOne; k++) {
    ivec3 o = ivec3(k, y, z);
    vec3 r = vec3(o) + hash3(i + o, P, seed) - f;
    d = min(d, dot(r, r));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
// quintic gradient noise, ~[-1, 1]; corners in a loop (one inlined hash instead of eight)
float gnoise(vec3 x, int P, uint seed) {
  ivec3 i = ivec3(floor(x));
  vec3 f = fract(x), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float v = 0.0;
  for (int c = 0; c < 8 * uOne; c++) {
    ivec3 o = ivec3(c & 1, (c >> 1) & 1, c >> 2);
    vec3 s = mix(1.0 - u, u, vec3(o));
    v += s.x * s.y * s.z * dot(hash3(i + o, P, seed) * 2.0 - 1.0, f - vec3(o));
  }
  return v;
}
// gradients (d/dx) of three independent gradient-noise fields at once, as mat3 columns. One
// hash per corner carries all three gradients (10 bits per component).
mat3 gnoiseGrad3(vec3 x, int P, uint seed) {
  ivec3 i = ivec3(floor(x));
  vec3 f = fract(x), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0), du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  mat3 J = mat3(0.0);
  for (int c = 0; c < 8 * uOne; c++) {
    ivec3 o = ivec3(c & 1, (c >> 1) & 1, c >> 2);
    vec3 fo = f - vec3(o), s = mix(1.0 - u, u, vec3(o)), ds = mix(-du, du, vec3(o));
    float w = s.x * s.y * s.z;
    vec3 dw = vec3(ds.x * s.y * s.z, s.x * ds.y * s.z, s.x * s.y * ds.z);
    uvec3 h = hashL(i + o, P, seed);
    vec3 g0 = vec3((h >> 22u) & 1023u) / 511.5 - 1.0, g1 = vec3((h >> 12u) & 1023u) / 511.5 - 1.0, g2 = vec3((h >> 2u) & 1023u) / 511.5 - 1.0;
    J[0] += w * g0 + dot(g0, fo) * dw;
    J[1] += w * g1 + dot(g1, fo) * dw;
    J[2] += w * g2 + dot(g2, fo) * dw;
  }
  return J;
}
`;

// Ranges measured from a readback histogram of the raw fbm (dev/fields.js "noise stats"):
// stretch the 1st..99th percentile to 0..1 so volume thresholds have the whole byte range.
const NOISE_FRAG = HASH + /* glsl */`
float stretch(float x, float lo, float hi) { return clamp((x - lo) / (hi - lo), 0.0, 1.0); }
void main() {
  vec3 p = vec3(vUv, uZ);
  float pf = 0.0, amp = 1.0;
  for (int o = 0; o < 5 * uOne; o++) { pf += gnoise(p * float(4 << o), 4 << o, 7u) * amp; amp *= 0.5; }
  float perlin = clamp(pf * 0.5 + 0.5, 0.0, 1.0);
  // Worley octaves at 2, 4, 8, 16, 32 cells; channel c is the fbm starting at octave c with
  // weights 0.625 / 0.25 / 0.125 (Schneider 2015), so g/b/a share octaves like his detail noise
  vec3 gba = vec3(0.0);
  for (int o = 0; o < 5 * uOne; o++) {
    vec3 k = float(o) - vec3(0.0, 1.0, 2.0);
    vec3 wt = 0.625 * step(abs(k), vec3(0.5)) + 0.25 * step(abs(k - 1.0), vec3(0.5)) + 0.125 * step(abs(k - 2.0), vec3(0.5));
    gba += wt * worley(p * float(2 << o), 2 << o, uint(o + 1));
  }
  // dilate Perlin by the low Worley fbm: remap(perlin, 0, 1, worley, 1) -> billowy, round cells
  float pw = gba.y + perlin * (1.0 - gba.y);
  outColor = vec4(stretch(pw, PW_LO, PW_HI), stretch(gba.x, W_LO, W_HI), stretch(gba.y, W_LO, W_HI), stretch(gba.z, W_LO, W_HI));
}`;

// vector potential = three gradient-noise fbms; octave amplitudes fall faster than 1/f so the
// big swirls dominate and the fine octaves only roughen them
const CURL_FRAG = HASH + /* glsl */`
void main() {
  vec3 p = vec3(vUv, uZ);
  mat3 J = mat3(0.0);   // column k = grad of potential k
  float amp = 1.0;
  for (int o = 0; o < 3 * uOne; o++) {
    J += gnoiseGrad3(p * float(4 << o), 4 << o, 11u) * amp;   // d/dp = d/dx * P; amplitude 1/P -> amp
    amp *= 0.6;
  }
  vec3 curl = vec3(J[2].y - J[1].z, J[0].z - J[2].x, J[1].x - J[0].y) * CURL_SCALE;
  outColor = vec4(curl * 0.5 + 0.5, 1.0);
}`;

// calibration knobs, from dev/fields.js "noise stats" (1st / 99th percentiles of the raw sums;
// curl scale puts the mean |curl| at 0.5)
export const NOISE_TUNING = { PW_LO: 0.53, PW_HI: 0.90, W_LO: 0.21, W_HI: 0.75, CURL_SCALE: 0.37 };

const defines = (keys) => Object.fromEntries(keys.map((k) => [k, NOISE_TUNING[k].toFixed(4)]));

// material + mesh for one 3D bake; compiled up front so both programs build in parallel
// (KHR_parallel_shader_compile) while the first one is already drawing
function bakePass(renderer, frag, keys) {
  const mat = rawPass(frag, { uZ: { value: 0 }, uOne: { value: 1 } }, { defines: defines(keys) });
  const quad = new FullscreenQuad(mat);
  renderer.compile(quad.mesh, bakeCam);
  return quad;
}
const bakeCam = new THREE.Camera();

function bake3D(renderer, quad, size) {
  const rt = new THREE.WebGL3DRenderTarget(size, size, size, {
    type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, generateMipmaps: false,
  });
  rt.texture.wrapR = THREE.RepeatWrapping;
  const mat = quad.material;
  const gl = renderer.getContext(), px = new Uint8Array(4);
  const t0 = performance.now();
  for (let z = 0; z < size; z++) {
    mat.uniforms.uZ.value = (z + 0.5) / size;
    renderer.setRenderTarget(rt, z);
    renderer.render(quad.mesh, bakeCam);
    if (z === 0) { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); rt.compileMs = performance.now() - t0; }
  }
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  rt.drawMs = performance.now() - t0 - rt.compileMs;
  mat.dispose();
  return rt;
}

// --- blackbody (CPU) -------------------------------------------------------------------
const LAMBDA0 = 360, LAMBDA_STEP = 5, LAMBDA_N = 95;   // 360..830 nm
const cmf = new Float64Array(LAMBDA_N * 3);
{
  // Wyman, Sloan & Shirley 2013, multi-lobe piecewise-Gaussian fit to CIE 1931 2-degree
  const g = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
  for (let i = 0; i < LAMBDA_N; i++) {
    const l = LAMBDA0 + i * LAMBDA_STEP;
    cmf[i * 3] = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
    cmf[i * 3 + 1] = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
    cmf[i * 3 + 2] = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  }
}

// Planck spectrum against the CMFs -> XYZ / Y -> linear sRGB (D65), negatives clipped,
// then rescaled so Rec.709 luminance is exactly 1 again
function planckRGB(kelvin, out, o) {
  const c2 = 1.4387769e7;   // hc / k in nm K
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i < LAMBDA_N; i++) {
    const l = LAMBDA0 + i * LAMBDA_STEP;
    const b = 1 / (l ** 5 * (Math.exp(c2 / (l * kelvin)) - 1));
    X += b * cmf[i * 3]; Y += b * cmf[i * 3 + 1]; Z += b * cmf[i * 3 + 2];
  }
  X /= Y; Z /= Y; Y = 1;
  const r = Math.max(0, 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
  const g = Math.max(0, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z);
  const b = Math.max(0, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  out[o] = r / lum; out[o + 1] = g / lum; out[o + 2] = b / lum;
}

const BB_N = 256;
const bbLUT = new Float32Array(BB_N * 3);   // CPU copy, texel centres at u = (i + 0.5) / 256
const kelvinAt = (u) => 500 * Math.pow(40, u);
for (let i = 0; i < BB_N; i++) planckRGB(kelvinAt((i + 0.5) / BB_N), bbLUT, i * 3);

// same mapping and linear filtering as blackbody() in NOISE_GLSL (minus fp16 rounding)
export function blackbodyRGB(kelvin, outColor = new THREE.Color()) {
  const u = Math.min(1, Math.max(0, Math.log(kelvin / 500) / Math.log(40)));
  const x = Math.min(BB_N - 1, Math.max(0, u * BB_N - 0.5));
  const i = Math.min(BB_N - 2, Math.floor(x)), t = x - i, a = i * 3, b = a + 3;
  return outColor.setRGB(bbLUT[a] + (bbLUT[b] - bbLUT[a]) * t, bbLUT[a + 1] + (bbLUT[b + 1] - bbLUT[a + 1]) * t,
    bbLUT[a + 2] + (bbLUT[b + 2] - bbLUT[a + 2]) * t, THREE.LinearSRGBColorSpace);
}

function makeBlackbodyTexture() {
  const data = new Uint16Array(BB_N * 4);
  for (let i = 0; i < BB_N; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = THREE.DataUtils.toHalfFloat(bbLUT[i * 3 + c]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(data, BB_N, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// throws on failure; returns a one-line summary
export function blackbodySelfCheck() {
  const assert = (ok, msg) => { if (!ok) throw new Error('blackbody self-check: ' + msg); };
  const c = new THREE.Color();
  const w = blackbodyRGB(6500, c).toArray();
  assert(Math.max(...w) / Math.min(...w) < 1.15, `6500 K not near white (${w.map((x) => x.toFixed(3))})`);
  const o = blackbodyRGB(1900, new THREE.Color()).toArray();
  assert(o[0] > o[1] && o[1] > o[2], `1900 K not orange (${o.map((x) => x.toFixed(3))})`);
  let prev = -1;
  for (let i = 0; i < BB_N; i++) {
    const r = bbLUT[i * 3], g = bbLUT[i * 3 + 1], b = bbLUT[i * 3 + 2];
    assert(Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - 1) < 1e-6, `luminance != 1 at texel ${i}`);
    const hue = (b + 1e-6) / (r + 1e-6);      // blue/red rises monotonically with temperature
    assert(hue >= prev, `hue not monotone at texel ${i}`);
    prev = hue;
  }
  return `blackbody ok: 6500K (${w.map((x) => x.toFixed(3))}), 1900K (${o.map((x) => x.toFixed(3))})`;
}

// --- bake -------------------------------------------------------------------------------
export function bakeNoise(renderer, { noiseSize = 128 } = {}) {
  const t0 = performance.now();
  const prevTarget = renderer.getRenderTarget();
  const noisePass = bakePass(renderer, NOISE_FRAG, ['PW_LO', 'PW_HI', 'W_LO', 'W_HI']);
  const curlPass = bakePass(renderer, CURL_FRAG, ['CURL_SCALE']);
  const noise = bake3D(renderer, noisePass, noiseSize);
  const curl = bake3D(renderer, curlPass, 64);
  const blackbody = makeBlackbodyTexture();
  renderer.setRenderTarget(prevTarget);
  // bake3D fenced each stage with a 1-texel read, so this is wall time to finished textures
  const ms = performance.now() - t0;
  U.uNoise3D.value = noise.texture;
  U.uCurl3D.value = curl.texture;
  U.uBlackbody.value = blackbody;
  console.info(`noise bake: ${noiseSize}^3 noise + 64^3 curl + blackbody in ${ms.toFixed(1)} ms (waiting on compile ${(noise.compileMs + curl.compileMs).toFixed(1)}, draw noise ${noise.drawMs.toFixed(1)} curl ${curl.drawMs.toFixed(1)})`);
  return { noise3D: noise.texture, curl3D: curl.texture, blackbody, ms, targets: [noise, curl] };
}
