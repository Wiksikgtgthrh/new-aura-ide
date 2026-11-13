import * as THREE from 'three';
import { U, COMMON_GLSL, LINES_BLENDING, lights } from './common.js';
import { instanced, put4 } from './Ribbons.js';

// Procedural SDF sigil circles (PLAN 3 Light "Judgment", Arcane). Everything is distance fields
// on a plane quad, full-res additive in the lines scene: concentric rings, a rotating band of runes
// (12 glyphs built from segments and arcs), a star polygon drawn as one pen stroke per closed
// path, ticks / sunburst / spiral arms per style, and a halo from the union distance. Lines are
// box-filtered with fwidth and never drawn thinner than ~0.6 px: below that their energy is
// scaled down instead (Persson's phone-wire AA), so a far sigil dims rather than shimmers.
// Reveal is arc length: rings sweep in clockwise (seen from the normal side), runes flash on as
// the pen passes them, then the star strokes, then the core. One instanced draw for all sigils.
// Look (Doctor Strange mandala / burning-filament reference): every stroke is a white-hot filament
// inside a saturated sheath, with hot knots of energy streaming round the circle and a halo whose
// red falls off slower than its blue (dispersion). Grinder sparks spit off the outer ring as
// velocity streaks (void sucks them inwards). Each visible sigil also borrows a spell light: a
// rune-ring cookie under a floor sigil, a point light in front of an upright one, so the burning
// strokes light the floor, pillars and dummies around them.

// Needs COMMON_GLSL (PI, hash11). q: plane coords with |q| = 1 on the outer ring; px: pixel
// footprint in the same units (fwidth; pass a constant like 0.02 for a soft cookie). style 0 holy,
// 1 arcane, 2 void. Returns x line coverage (energy-normalised), y halo, z reveal-front sparkle.
export const SIGIL_GLSL = /* glsl */`
float sgSat(float x) { return clamp(x, 0.0, 1.0); }
float sgSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float sgCircle(vec2 p, vec2 c, float r) { return abs(length(p - c) - r); }
// arc of radius r about c, from angle a0 (radians, from +x towards +y) over da
float sgArc(vec2 p, vec2 c, float r, float a0, float da) {
  vec2 q = p - c;
  if (mod(atan(q.y, q.x) - a0, 2.0 * PI) < da) return abs(length(q) - r);
  return min(length(q - r * vec2(cos(a0), sin(a0))), length(q - r * vec2(cos(a0 + da), sin(a0 + da))));
}
// 12 runes (futhark-like, own shapes). Cell x in [-0.5, 0.5], y in [-1, 1]; distance to the strokes.
float sigilGlyph(int id, vec2 p) {
  float d = 1e3;
#define S(ax, ay, bx, by) d = min(d, sgSeg(p, vec2(ax, ay), vec2(bx, by)))
  switch (id) {
    case 0: S(-0.25, -0.9, -0.25, 0.9); S(-0.25, 0.15, 0.35, 0.6); S(-0.25, -0.35, 0.35, 0.1); break;
    case 1: S(0.0, -0.9, 0.0, 0.9); S(0.0, 0.9, -0.38, 0.45); S(0.0, 0.9, 0.38, 0.45); break;
    case 2: S(0.0, 0.85, 0.4, 0.0); S(0.4, 0.0, 0.0, -0.85); S(0.0, -0.85, -0.4, 0.0); S(-0.4, 0.0, 0.0, 0.85); break;
    case 3: S(0.0, -0.9, 0.0, 0.9); d = min(d, sgCircle(p, vec2(0.0, 0.3), 0.28)); break;
    case 4: S(-0.3, 0.85, 0.3, 0.3); S(0.3, 0.3, -0.3, -0.3); S(-0.3, -0.3, 0.3, -0.85); break;
    case 5: S(0.0, -0.9, 0.0, 0.9); S(0.0, 0.2, -0.4, 0.8); S(0.0, 0.2, 0.4, 0.8); break;
    case 6: d = sgArc(p, vec2(0.12, 0.0), 0.55, 0.5 * PI, PI); d = min(d, sgCircle(p, vec2(0.12, 0.0), 0.08)); break;
    case 7: S(-0.35, -0.9, -0.35, 0.9); S(0.35, -0.9, 0.35, 0.9); S(-0.35, 0.3, 0.35, -0.3); break;
    case 8: S(-0.4, -0.8, -0.4, 0.8); S(0.4, -0.8, 0.4, 0.8); S(-0.4, 0.8, 0.4, -0.8); S(-0.4, -0.8, 0.4, 0.8); break;
    case 9: d = sgCircle(p, vec2(0.0), 0.42); S(0.0, -0.8, 0.0, 0.8); S(-0.42, 0.0, 0.42, 0.0); break;
    case 10: S(0.0, 0.85, 0.38, 0.35); S(0.38, 0.35, 0.0, -0.15); S(0.0, -0.15, -0.38, 0.35); S(-0.38, 0.35, 0.0, 0.85);
             S(-0.25, 0.18, 0.35, -0.9); S(0.25, 0.18, -0.35, -0.9); break;
    default: S(0.35, 0.8, -0.3, 0.0); S(-0.3, 0.0, 0.35, -0.8); S(0.05, 0.0, 0.42, 0.0); break;
  }
#undef S
  return d;
}

float gSgPx;     // pixel footprint for the helpers below
float gSgCore;   // set by sigilPattern: white-hot inner filament coverage (energy-normalised)
float gSgDist;   // set by sigilPattern: distance to the nearest revealed stroke (plane units)
// smooth periodic value noise: period in cells
float sgNoise(float x, float period) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(mod(i, period) + 0.37), hash11(mod(i + 1.0, period) + 0.37), f);
}
// add one stroke: d distance, w half width, k brightness (0 = not revealed). acc.z: the inner 35%
// of the stroke, the incandescent core (also never thinner than ~0.5 px, energy-scaled instead)
void sgLine(float d, float w, float k, inout vec3 acc) {
  if (k <= 0.0) return;
  float we = max(w, gSgPx * 0.6);
  acc.x = max(acc.x, sgSat((we - d) / gSgPx + 0.5) * (w / we) * k);
  acc.y = min(acc.y, d);
  float wc = 0.35 * w, wce = max(wc, gSgPx * 0.5);
  acc.z = max(acc.z, sgSat((wce - d) / gSgPx + 0.5) * (wc / wce) * k);
}
// grinder sparks thrown off the outer ring: one per angular slot and cycle (~30% of slots fire),
// born on the ring, flying out (dir 1) or in (dir -1), slanted along the spin, as short streaks
float sgSparks(float r, float cw, float time, float seed, float dir) {
  const float n = 96.0;
  float a = cw * n, cell = floor(a);
  vec4 h = hash41(cell * 1.618 + seed * 7.31);
  float t = time / (0.3 + 0.45 * h.x) + h.y * 17.0;
  float ph = fract(t);
  if (hash11(floor(t) * 3.17 + cell * 0.71 + seed) > 0.3) return 0.0;
  float v = (r - 1.0) * dir - 0.004 - ph * (0.03 + 0.07 * h.z);    // radial: 0 at the spark head
  float u = (fract(a) - 0.5 - (h.w - 0.5) * 0.5) * 6.2832 * r / n + v * 0.6;   // tangential, slanted
  float len = 0.012 + 0.03 * ph;                                    // the streak grows as it speeds up
  float d = length(vec2(u, max(v, 0.0) + max(-v - len, 0.0)));
  float w = 0.0022, we = max(w, gSgPx * 0.6);
  float k = 1.0 - ph;
  return sgSat((we - d) / gSgPx + 0.5) * (w / we) * k * k * 2.5;
}
// clockwise sweep mask: visible where cw < p (p >= 1: whole ring, no seam)
float sgSweep(float p, float cw, float r) { return p >= 1.0 ? 1.0 : sgSat((p - cw) * 6.2832 * r / gSgPx + 0.5); }
vec2 sgPolar(float r, float cw) { float a = cw * 6.2832; return r * vec2(sin(a), -cos(a)); }
float sgPen(vec2 q, float r, float p) {
  if (p <= 0.0 || p >= 1.0) return 0.0;
  vec2 e = q - sgPolar(r, p);
  return exp(-dot(e, e) * 2500.0);
}
// ring drawn clockwise from north up to p: a true arc SDF (round caps, seamless halo)
void sgRing(vec2 q, float r, float cw, float R, float w, float p, float k, inout vec3 acc, inout float front) {
  if (p <= 0.0) return;
  float d = p >= 1.0 || cw <= p ? abs(r - R) : min(length(q - vec2(0.0, -R)), length(q - sgPolar(R, p)));
  sgLine(d, w, k, acc);
  front += sgPen(q, R, p);
}
// rune band: n cells centred on radius rc, half height hh; rotates with rot (radians)
void sgRunes(float r, float cw, float rot, float n, float rc, float hh, float seed, float p, float time, float glitch, inout vec3 acc) {
  if (abs(r - rc) > hh * 1.3) return;
  float a = fract(cw + rot / 6.2832) * n;
  float cell = floor(a);
  vec2 g = vec2((fract(a) - 0.5) * (6.2832 * rc / n) / hh, (r - rc) / hh);
  int id = int(hash11(cell * 7.31 + seed * 13.7) * 12.0);
  float at = (cell + 0.5) / n;                   // where the pen passes this rune
  float on = sgSat((p - at) * n * 2.0 + 0.5);
  float flash = 1.0 + 1.5 * exp(-max(p - at, 0.0) * n * 1.2) * on;
  float pulse = 0.75 + 0.5 * pow(0.5 + 0.5 * sin(time * 2.2 - cell * 0.9), 6.0);
  if (glitch > 0.0) pulse *= step(0.12, hash11(cell + floor(time * 9.0) * 3.1));   // void: runes drop out
  sgLine(sigilGlyph(id, g) * hh, 0.07 * hh, on * flash * pulse, acc);
}
// star polygon {n/k} on radius R, g closed strokes, each drawn chord after chord as p goes 0 -> 1
void sgStar(vec2 q, float R, int n, int k, int g, float rot, float p, float w, inout vec3 acc, inout float front) {
  if (p <= 0.0 || dot(q, q) > (R + 0.03) * (R + 0.03)) return;
  int per = n / g;
  float st = 6.2832 * float(k) / float(n);
  mat2 step_ = mat2(cos(st), sin(st), -sin(st), cos(st));   // one chord further round
  for (int s = 0; s < g; s++) {
    float a0 = rot + 6.2832 * float(s) / float(n);
    vec2 A = R * vec2(sin(a0), -cos(a0));
    for (int m = 0; m < per; m++) {
      float cp = sgSat(p * float(per) - float(m));
      if (cp <= 0.0) break;
      vec2 B = step_ * A;
      vec2 E = mix(A, B, cp);
      sgLine(sgSeg(q, A, E), w, 1.0, acc);
      if (cp < 1.0) front += exp(-dot(q - E, q - E) * 2500.0);
      A = B;
    }
  }
}
// n radial strokes from r0 to r1 (every major-th one longer by ext)
void sgSpokes(float r, float cw, float rot, float n, float r0, float r1, float major, float ext, float w, float k, inout vec3 acc) {
  float a = fract(cw + rot / 6.2832) * n;
  float i = floor(a + 0.5);
  float lo = mod(i, major) < 0.5 ? r0 - ext : r0;
  float t = (a - i) * 6.2832 * r / n;
  sgLine(length(vec2(t, max(max(lo - r, r - r1), 0.0))), w, k, acc);
}

vec3 sigilPattern(vec2 q, float px, int style, float reveal, float rot, float seed, float time) {
  gSgPx = max(px, 1e-4);
  float r = length(q);
  float cw = fract(atan(q.x, -q.y) / 6.2832);   // 0 at "north", clockwise seen from the normal side
  float pO = sgSat(reveal / 0.35), pR = sgSat((reveal - 0.12) / 0.45), pI = sgSat((reveal - 0.3) / 0.35);
  float pS = sgSat((reveal - 0.42) / 0.4), pC = sgSat((reveal - 0.7) / 0.3);
  vec3 acc = vec3(0.0, 1e3, 0.0);
  float front = 0.0;
  if (style == 2 ? (r > 0.86 && r < 1.01) : r > 0.99) front += sgSparks(r, cw, time, seed, style == 2 ? -1.0 : 1.0) * pO;
  // energy running round the rings
  float shimmer = 0.85 + 0.3 * sin(cw * 56.5 + r * 30.0 - time * 3.0) * sin(cw * 31.4 - time * 1.7);
  if (style == 0) {          // holy: double ring, runes, ticks, hexagram, sunburst
    sgRing(q, r, cw, 1.0, 0.010, pO, shimmer, acc, front);
    sgRing(q, r, cw, 0.965, 0.0035, pO, 1.0, acc, front);
    sgRing(q, r, cw, 0.82, 0.004, pR, 1.0, acc, front);
    sgRunes(r, cw, rot, 16.0, 0.89, 0.042, seed, pR, time, 0.0, acc);
    if (r > 0.77 && r < 0.815) sgSpokes(r, cw, rot, 72.0, 0.79, 0.81, 6.0, 0.012, 0.0022, sgSweep(pR, cw, 0.8), acc);
    sgRing(q, r, cw, 0.76, 0.003, pI, 1.0, acc, front);
    sgStar(q, 0.76, 6, 2, 2, -rot * 0.6, pS, 0.0045, acc, front);
    sgRing(q, r, cw, 0.38, 0.004, pI, 1.0, acc, front);
    if (r < 0.36) sgSpokes(r, cw, -rot * 0.6, 24.0, 0.17, 0.33, 2.0, -0.06, 0.003, pC, acc);
    sgRing(q, r, cw, 0.12, 0.006, pC, 1.0, acc, front);
    sgLine(max(r - 0.03, 0.0), 0.006, pC, acc);
  } else if (style == 1) {   // arcane: dashed counter ring, two rune bands, heptagram
    sgRing(q, r, cw, 1.0, 0.009, pO, shimmer, acc, front);
    float dash = step(fract(cw * 48.0 - time * 0.12), 0.6);
    sgLine(abs(r - 0.972), 0.0035, sgSweep(pO, cw, 0.972) * dash, acc);
    sgRing(q, r, cw, 0.94, 0.003, pR, 1.0, acc, front);
    sgRing(q, r, cw, 0.83, 0.004, pR, 1.0, acc, front);
    sgRunes(r, cw, rot, 20.0, 0.885, 0.038, seed, pR, time, 0.0, acc);
    sgRing(q, r, cw, 0.8, 0.003, pI, 1.0, acc, front);
    sgStar(q, 0.8, 7, 2, 1, -rot * 0.5, pS, 0.004, acc, front);
    sgRing(q, r, cw, 0.5, 0.004, pI, 1.0, acc, front);
    sgRing(q, r, cw, 0.42, 0.0025, pC, 1.0, acc, front);
    sgRunes(r, cw, -rot * 1.4, 8.0, 0.36, 0.05, seed + 3.0, pC, time, 0.0, acc);
    sgRing(q, r, cw, 0.3, 0.0025, pC, 1.0, acc, front);
    sgStar(q, 0.2, 4, 1, 1, rot, pC, 0.004, acc, front);
    sgLine(max(r - 0.025, 0.0), 0.006, pC, acc);
  } else {                   // void: broken ring, glitching runes, octagram, inward spiral arms
    float gap = step(sin(cw * 31.4159 + rot * 3.0), 0.82);
    sgLine(abs(r - 1.0), 0.011, sgSweep(pO, cw, 1.0) * gap * shimmer, acc);
    front += sgPen(q, 1.0, pO);
    sgRing(q, r, cw, 0.95, 0.003, pO, 1.0, acc, front);
    sgRing(q, r, cw, 0.81, 0.004, pR, 1.0, acc, front);
    sgRunes(r, cw, rot, 12.0, 0.88, 0.046, seed, pR, time, 1.0, acc);
    sgStar(q, 0.78, 8, 3, 1, -rot * 0.4, pS, 0.004, acc, front);
    if (r > 0.1 && r < 0.66) {
      // 5 logarithmic arms (theta = 2.2 ln r), turning inwards; distance across the arm
      float arms = 5.0, k = 2.2;
      float ph = fract(cw - k * log(r) / 6.2832 + time * 0.08 + rot / 6.2832) * arms;
      float d = abs(fract(ph) - 0.5) * 6.2832 * r / arms / sqrt(1.0 + k * k);
      sgLine(d, 0.0035 * smoothstep(0.1, 0.25, r) * smoothstep(0.66, 0.45, r), pI, acc);
    }
    sgRing(q, r, cw, 0.3, 0.003, pI, 1.0, acc, front);
    sgRing(q, r, cw, 0.1, 0.008, pC, 1.4, acc, front);
  }
  // hot knots of energy streaming round the circle (two periodic octaves along the angle, drifting
  // opposite ways) and a slow whole-sigil flicker: the strokes burn unevenly, never a flat colour
  float flow = sgNoise(cw * 24.0 - time * 1.7 + seed, 24.0) * 0.65 + sgNoise(cw * 80.0 + time * 4.1 + r * 13.0 + seed, 80.0) * 0.35;
  float energy = (0.45 + 1.15 * flow * flow) * (0.9 + 0.2 * sgNoise(time * 7.0 + seed * 3.0, 4096.0));
  gSgCore = acc.z * energy;
  gSgDist = acc.y;
  // halo from the union distance + a wide glow hugging the outer ring + faint inner fill
  float halo = (exp(-acc.y / 0.012) * 0.3 + exp(-acc.y / 0.05) * 0.07) * step(acc.y, 1e2);
  halo += 0.12 * exp(-abs(r - 1.0) / 0.04) * pO;
  return vec3(acc.x * mix(1.0, energy, 0.75), halo * mix(1.0, energy, 0.5), front);
}
`;

const VERT = /* glsl */`
in vec4 aPos;    // centre, radius (m)
in vec4 aNrm;    // plane normal, rotation (rad)
in vec4 aCol;    // linear colour x intensity, reveal
in vec4 aSty;    // style, seed, -, -
out vec2 vQ;
flat out vec4 vCol;
flat out vec4 vSty;
flat out float vRot;
void main() {
  mat3 B = basisFrom(normalize(aNrm.xyz));
  vec2 c = position.xy * 1.1;   // room for the outer glow (it is ~1% by r = 1.1)
  vec3 wp = aPos.xyz + (B[0] * c.x + B[1] * c.y) * aPos.w + B[2] * 0.015;
  vQ = c;
  vCol = aCol; vSty = aSty; vRot = aNrm.w;
  gl_Position = aPos.w > 0.0 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */`
in vec2 vQ;
flat in vec4 vCol;
flat in vec4 vSty;
flat in float vRot;
out vec4 fragColor;
void main() {
  float r = length(vQ);
  if (r > 1.1) discard;
  float px = length(fwidth(vQ)) * 0.7071;
  vec3 s = sigilPattern(vQ, px, int(vSty.x + 0.5), vCol.a, vRot, vSty.y, uTime);
  // most of the disc is empty: no blend into the 4x MSAA target where nothing shows
  if (s.x + s.y + s.z < 0.003) discard;
  vec3 c = vCol.rgb;
  float peak = max(c.r, max(c.g, c.b));
  // plasma layering: white-hot filament core, saturated sheath, then a deeper-hued halo whose red
  // spreads wider than its blue (dispersion fringe); pen front and sparks burn white
  vec3 deep = c * c / max(peak, 1e-4);
  vec3 disp = exp(min(gSgDist, 0.15) / 0.04 * vec3(0.3, 0.0, -0.3));
  vec3 col = vec3(peak) * gSgCore * 2.2 + mix(c, vec3(peak), 0.12) * s.x * 1.1
           + mix(c, deep, 0.45) * s.y * disp + vec3(peak) * s.z * 1.5;
  if (uDebug > 0.5 && uDebug < 1.5) col = vec3(0.04, 0.012, 0.004);   // overdraw view
  fragColor = vec4(col, 1.0);
}`;

const STYLES = { holy: 0, arcane: 1, void: 2 };
const STYLE_COLORS = { holy: [1.0, 0.72, 0.3], arcane: [0.55, 0.32, 1.0], void: [0.62, 0.12, 1.0] };
const DEFAULTS = { radius: 1.5, intensity: 4, reveal: 1, rotation: 0, style: 'holy', seed: 0 };
// light borrowed per visible sigil: intensity = LIGHT_GAIN x sigil intensity x radius (bigger and
// brighter circles throw more light), range ~2 radii
const LIGHT_GAIN = 1.6;
let seedState = 12345;   // deterministic default seeds (callers normally pass their cast's)

export class Sigils {
  constructor({ max = 8 } = {}) {
    this.max = max;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = ['aPos', 'aNrm', 'aCol', 'aSty'].map((n) => instanced(geo, n, max));
    this._arrays = this.attrs.map((a) => a.array);
    geo.instanceCount = 0;
    this.geometry = geo;
    this.uniforms = { ...U };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.uniforms, ...LINES_BLENDING, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: COMMON_GLSL + VERT, fragmentShader: COMMON_GLSL + SIGIL_GLSL + FRAG,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.sigils = Array.from({ length: max }, (_, index) => ({
      index, active: false, ...DEFAULTS,
      pos: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), color: new THREE.Color(), light: null,
      release() { this.active = false; },
    }));
  }

  // pos/normal: Vector3, color: Color (copied). Live fields: pos, normal, radius, color, intensity,
  // reveal (0..1), rotation (rad), style, seed. Returns null when all are live.
  acquire(opts = {}) {
    for (const h of this.sigils) {
      if (h.active) continue;
      Object.assign(h, DEFAULTS);
      h.normal.set(0, 1, 0);
      seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0;
      h.seed = seedState % 1000;
      const style = opts.style ?? 'holy';
      h.color.setRGB(...(STYLE_COLORS[style] ?? STYLE_COLORS.holy));
      for (const k in opts) {
        const v = opts[k];
        if (v && (v.isVector3 || v.isColor)) h[k].copy(v); else h[k] = v;
      }
      h.active = true;
      return h;
    }
    return null;
  }

  update() {
    let n = 0, dirty = false;
    const X = this._arrays, P = X[0], N = X[1], C = X[2], S = X[3];
    for (const h of this.sigils) {
      const on = h.active && h.intensity > 0 && h.reveal > 0;
      this.light(h, on);
      if (!on) continue;
      const o = n * 4, k = h.intensity;
      dirty = put4(P, o, h.pos.x, h.pos.y, h.pos.z, h.radius) || dirty;
      dirty = put4(N, o, h.normal.x, h.normal.y, h.normal.z, h.rotation) || dirty;
      dirty = put4(C, o, h.color.r * k, h.color.g * k, h.color.b * k, h.reveal) || dirty;
      dirty = put4(S, o, STYLES[h.style] ?? 0, h.seed, 0, 0) || dirty;
      n++;
    }
    if (dirty || n !== this.geometry.instanceCount) for (const a of this.attrs) a.needsUpdate = true;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  // the burning strokes light what is near them (pool handle per visible sigil, none when the pool
  // is full). Floor sigil: rune-ring cookie (common.js pattern 2, ring at r = 1) from just above
  // its centre, so the floor glows under the strokes. Upright sigil: a point light in front of it.
  light(h, on) {
    if (!on) { if (h.light) { h.light.release(); h.light = null; } return; }
    const L = h.light ?? (h.light = lights.acquire());
    if (!L) return;
    const floor = h.normal.y > 0.7, R = h.radius, t = U.uTime.value;
    L.type = floor ? 2 : 0;
    L.pos.copy(h.pos).addScaledVector(h.normal, (floor ? 0.3 : 0.2) * R);
    L.range = 2.2 * R + 1.5;
    L.color.copy(h.color);
    L.cookie[0] = floor ? 2 : 0; L.cookie[1] = 1 / Math.max(R, 1e-3); L.cookie[2] = h.rotation;
    const flicker = 0.9 + 0.1 * Math.sin(t * 23 + h.seed) * Math.sin(t * 7.3 + h.seed * 0.37);
    L.intensity = LIGHT_GAIN * h.intensity * Math.min(1, h.reveal * 1.5) * R * flicker;
  }
}
