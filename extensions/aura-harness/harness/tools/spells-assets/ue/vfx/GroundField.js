import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { ARENA, COMMON_GLSL, U } from './common.js';

// Ground reaction field: a floor-aligned 40 x 40 m ping-pong pair (RGBA16F MRT, linear, clamp)
//   A = (heat, char, wet, frost)      B = (crack, acid, corruption, glow)
// The sim pass steps every reaction, applies this frame's splats (uniform-bounded loop) and
// adds this frame's particle paint (paintScene, drawn additively into a cleared paint target).
// Frost, crack and corruption above 1 are "potential": a front advances into a neighbour with
// max(neighbour) - drop, so the initial potential sets the reach. Fronts are gated by a baked
// mask (frost: dendrite tips + noise, crack: voronoi vein network, corruption: warped veins).
// Slow decays use stochastic rounding: fp16 has 10 mantissa bits, so a tau = 25 s decay at
// 144 Hz (0.03% per frame) would otherwise round to no change at all.
//
// Partial update: a 1024^2 MRT pass is bandwidth bound (~0.11 ms on a 3060 even as a plain
// copy), so a frame only touches part of the field. Splats (and touch()) register regions
// that are stepped every frame (up to 4 "fast" boxes clustered from the live regions, padded
// by how far their fronts can reach); the rest is stepped in 32 rotating row bands with each
// band's accumulated dt, so slow decays still run everywhere. Last frame's rects are copied
// so both ping-pong targets stay identical outside what was stepped. Boxes may overlap (an
// overlap is just computed twice, identically). Paint only lands inside the fast boxes:
// spells that paint with particles must touch() their area.

export const MAX_SPLATS = 16, MAX_PROBES = 16;
const SPLAT_VEC4 = 5, MAX_REGIONS = 32, MAX_BOXES = 4, BANDS = 32;
const PATTERNS = { radial: 0, lichtenberg: 1, ring: 2, noise: 3, line: 4 };
// craters: where a heavy radial crack splat (crack >= 2: a meteor, not a spike's base) landed, so
// the floor draws its fractures radiating from there and concentric between them. (x, z, radius,
// strength fading with the cracks); the arena material reads them by reference.
// ponytail: one field, so module-level; the oldest/weakest of 4 is overwritten
export const CRACK_SOURCES = Array.from({ length: 4 }, () => new THREE.Vector4());
// hot line cracks (fissure vents): A = (x, z, x2, z2), B = (half-width, strength, seed, -); the arena
// floor draws the main fissure and en-echelon side cracks along them instead of the cell network
export const FISSURE_A = Array.from({ length: 4 }, () => new THREE.Vector4());
export const FISSURE_B = Array.from({ length: 4 }, () => new THREE.Vector4());

// particle paint: RawShaderMaterial (GLSL3) with ...PAINT_BLENDING and PAINT_FRAG_HEAD, drawn
// into paintScene with paintCamera (ortho, ground rect). Outputs are per-frame increments.
export const PAINT_BLENDING = {
  transparent: true, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
};
export const PAINT_FRAG_HEAD = /* glsl */`
layout(location = 0) out vec4 gA;   // heat, char, wet, frost       (added)
layout(location = 1) out vec4 gB;   // crack, acid, corruption, glow (added)
`;

const f = (x) => x.toFixed(4);
// per-frame helpers live at module level: no closures allocated in update()
const area = (b) => (b.z - b.x) * (b.w - b.y);
const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.z >= b.z && a.w >= b.w;
const decay = (dt, tau) => Math.exp(-dt / tau);
const G = ARENA.ground, P = ARENA.pool;

const FIELD_GLSL = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
${COMMON_GLSL}
// always 1. Loop bounds read it so ANGLE's D3D compiler (FXC) keeps loops rolled (fast compile)
uniform int uOne;
const vec2 G_MIN = vec2(${f(G.min.x)}, ${f(G.min.y)});
const float G_SIZE = ${f(G.size)};
vec2 texelWorld(vec2 fragCoord, float n) { return G_MIN + fragCoord / n * G_SIZE; }
bool inPool(vec2 xz) { return all(lessThan(abs(xz - vec2(${f(P.center.x)}, ${f(P.center.y)})), vec2(${f(P.half.x)}, ${f(P.half.y)}))); }
float vnoise(vec2 x) {
  vec2 i = floor(x), u = fract(x);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 x) { return vnoise(x) * 0.5 + vnoise(x * 2.03 + 17.1) * 0.3 + vnoise(x * 4.11 + 3.7) * 0.2; }
// value noise periodic in x (period per) and optionally y (perY > 0); integer periods only
float vnoiseP(vec2 x, float per, float perY) {
  vec2 i = floor(x), u = fract(x);
  u = u * u * (3.0 - 2.0 * u);
  vec2 i0 = vec2(mod(i.x, per), perY > 0.0 ? mod(i.y, perY) : i.y);
  vec2 i1 = vec2(mod(i.x + 1.0, per), perY > 0.0 ? mod(i.y + 1.0, perY) : i.y + 1.0);
  return mix(mix(hash12(i0), hash12(vec2(i1.x, i0.y)), u.x), mix(hash12(vec2(i0.x, i1.y)), hash12(i1), u.x), u.y);
}
`;

// Static gate mask, baked once at field resolution (world-locked):
//   r frost needles (ridged streaks on hexagonal axes), g crack veins (voronoi edges, 2 scales), b corruption veins (warped), a fbm
const MASK_FRAG = FIELD_GLSL + /* glsl */`
uniform float uNeedle;   // needles across per metre: 9, fewer on a coarse field (a needle under ~2 texels is noise, and fronts gated on noise grow a maze)
in vec2 vUv;
out vec4 outColor;
// distance to the nearest voronoi edge (F2-F1 bisector distance, Quilez), in cells
float voronoiEdge(vec2 x, float seed) {
  vec2 i = floor(x), fr = fract(x), mg, mr;
  float md = 8.0;
  for (int y = -uOne; y <= uOne; y++) for (int k = -uOne; k <= uOne; k++) {
    vec2 g = vec2(k, y), o = hash33(vec3(i + g, seed)).xy, r = g + o - fr;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int y = -2 * uOne; y <= 2 * uOne; y++) for (int k = -2 * uOne; k <= 2 * uOne; k++) {
    vec2 g = mg + vec2(k, y), o = hash33(vec3(i + g, seed)).xy, r = g + o - fr;
    if (dot(mr - r, mr - r) > 1e-5) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return md;
}
void main() {
  vec2 w = G_MIN + vUv * G_SIZE;
  // five fbms in one rolled loop: crack warp xy, corruption warp xy, frost wobble
  float nv[5];
  for (int j = 0; j < 5 * uOne; j++) nv[j] = fbm2(w * (j < 2 ? 0.9 : j < 4 ? 1.7 : 5.0) + float(j) * 9.1);
  // ice grows needles along its hexagonal axes: thin ridged streaks at 0/60/120 degrees
  // (long along the axis, ~3 cm across), wobbled a little so they aren't ruler-straight
  float frost = 0.0;
  for (int k = 0; k < 3 * uOne; k++) {
    float an = float(k) * 1.0472;
    vec2 q = mat2(cos(an), sin(an), -sin(an), cos(an)) * w + vec2(0.0, (nv[4] - 0.5) * 0.25);
    frost = max(frost, 1.0 - abs(vnoise(vec2(q.x * 1.3, q.y * uNeedle) + float(k) * 31.7) * 2.0 - 1.0));
  }
  vec2 wc = w + (vec2(nv[0], nv[1]) - 0.5) * 0.6;
  vec2 wv = w + (vec2(nv[2], nv[3]) - 0.5) * 1.4;
  // edge distance in metres for: crack plates (~1.4 m), sub-cracks (~0.45 m), and corruption's
  // strongly warped ~0.9 m cells (organic tendrils). One rolled loop = one inlined voronoi.
  vec3 e;
  for (int l = 0; l < 3 * uOne; l++) {
    float cell = l == 0 ? 1.4 : l == 1 ? 0.45 : 0.9;
    e[l] = voronoiEdge((l == 2 ? wv : wc) / cell, float(l + 1)) * cell;
  }
  // >= 2 texels wide at 1024^2, so a diagonal vein stays 4-connected for the fronts. Noise
  // removes about half the sub-crack edges: cracks fork and dead-end instead of closing cells.
  float gaps = vnoise(w * 1.6 + 70.0);
  float crack = max((1.0 - smoothstep(0.02, 0.08, e.x)) * smoothstep(0.25, 0.35, gaps),
                    (1.0 - smoothstep(0.01, 0.06, e.y)) * 0.75 * smoothstep(0.5, 0.6, gaps));
  float corr = 1.0 - smoothstep(0.02, 0.08, e.z);
  // a: tileable fbm, 60 cells across the field; the sim samples it as splat noise (snoise)
  float a = 0.0, amp = 0.5;
  for (int o = 0; o < 3 * uOne; o++) { float per = 60.0 * float(1 << o); a += vnoiseP(vUv * per, per, per) * amp; amp *= o == 0 ? 0.6 : 0.67; }
  outColor = vec4(frost, crack, corr, clamp((a - 0.5) * 1.6 + 0.5, 0.0, 1.0));
}`;

const SIM_FRAG = FIELD_GLSL + /* glsl */`
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uMask;
uniform vec4 uSplat[${MAX_SPLATS * SPLAT_VEC4}];
uniform int uSplatCount;
uniform float uSeed;
uniform float uRound;   // dither offset in ulps: -0.5 if fp16 writes round to nearest, 0 if they truncate
// per-step factors, [0..6] for the fast boxes (this frame's dt), [7..13] for the band (its
// accumulated dt):
//   0 heat decay, heat diffusion alpha, char gain, char decay
//   1 evaporation, wet decay, melt, frost decay
//   2 frost advance p, frost drop/texel, frost threshold, frost drop factor on water
//   3 crack p, crack drop, crack decay, acid decay
//   4 corruption p, corruption drop, corruption decay, glow decay
//   5 acid alpha, pool quench, cleanse, dt
//   6 neighbour decay for the frost, crack, corruption fronts (1 in fast steps), unused
uniform vec4 uK[14];
uniform vec4 uFast[${MAX_BOXES}];   // texel rects [x0, y0, x1, y1): stepped with uK[0..6] (+ splats) ...
uniform vec4 uBand;   // ... or with uK[7..13]; any other drawn texel is copied unchanged
uniform sampler2D uPaintA;   // this frame's particle paint (increments), added in fast texels
uniform sampler2D uPaintB;
uniform int uPaintOn;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;

// smooth tileable noise from the mask's fbm channel; x in noise cells (60 per field width).
// A fetch instead of inlined value noise: the splat loop compiles ~10x faster under FXC.
float snoise(vec2 x) { return textureLod(uMask, x * (1.0 / 60.0), 0.0).a; }

// coverage of splat i at world xz w (single exit: early returns in this loop slow FXC down)
float splatShape(int i, vec2 w) {
  vec4 s0 = uSplat[i * 5], s3 = uSplat[i * 5 + 3], s4 = uSplat[i * 5 + 4];
  int pat = int(s0.w);
  float R = s0.z, seed = s3.x, m = 0.0;
  float ca = cos(s3.y), sa = sin(s3.y);
  vec2 nd = mat2(ca, sa, -sa, ca) * (w - s0.xy) / R;
  float r = length(nd);
  float n = snoise(nd * 3.0 + seed * 7.31);
  if (pat == 4) {   // line (x, z) -> (x2, z2), half-width s4.x: jagged, tapered at both ends
    vec2 ab = s3.zw - s0.xy, q = w - s0.xy;
    float L = max(length(ab), 1e-3);
    vec2 t = ab / L;
    float along = dot(q, t);
    float off = dot(q, vec2(-t.y, t.x)) + (snoise(vec2(along * 2.2, seed * 7.31)) - 0.5) * s4.x * 3.0;
    float h = clamp(along / L, 0.0, 1.0);
    float hw = s4.x * (0.35 + 0.65 * sqrt(clamp(min(h, 1.0 - h) * 6.0, 0.0, 1.0)));
    m = smoothstep(hw, hw * 0.2, abs(off)) * (0.7 + 0.3 * snoise(w * 9.0 + seed)) * step(-hw, along) * step(along, L + hw);
  } else if (r < 1.6) {
    if (pat == 0) m = smoothstep(1.0, 0.35, r + (n - 0.5) * 0.45) * (0.65 + 0.5 * n);
    else if (pat == 2) {   // ring at R, width s4.x (metres); s4.y > 0: lobed and broken (radius wanders)
      vec2 cs = nd / max(r, 1e-3);
      float lob = (snoise(cs * 1.4 + seed * 3.7) - 0.5) * 3.0 * s4.y;
      float x = (r - 1.0 - lob) * R / s4.x + (n - 0.5) * 1.2;
      m = exp(-x * x * 2.0) * (0.6 + 0.6 * n) * mix(1.0, smoothstep(0.3, 0.55, snoise(cs * 2.7 + seed * 1.9)), min(s4.y * 3.0, 1.0));
    } else if (pat == 3) m = smoothstep(1.0, 0.6, r) * smoothstep(0.45, 0.62, snoise(nd * 2.2 + seed * 3.1 + 0.5) + (1.0 - r) * 0.15);
    else {
      // lichtenberg: polar ridged noise stretched along the radius, so ridges run outward.
      // Angle is periodic (no seam). Each octave doubles the channels, starts further out,
      // wanders more, thins with radius and only shows near its parent channel: a fork.
      float th = atan(nd.y, nd.x) / 6.2831853 + 0.5;
      float lr = log(max(r, 0.03)), near = 1.0;
      for (int o = 0; o < 4 * uOne; o++) {
        float fo = float(o), k = 7.0 * float(1 << o);
        float warp = (snoise(nd * (1.5 + fo) + seed + fo * 3.3) - 0.5) * (0.25 / k + 0.02);   // turns
        float ridge = 1.0 - abs(vnoiseP(vec2((th + warp) * k, lr * 0.6 + seed * 13.0 + fo * 5.1), k, 0.0) * 2.0 - 1.0);
        float reach = smoothstep(0.05 + fo * 0.12, 0.15 + fo * 0.15, r);
        m = max(m, pow(ridge, (30.0 + fo * 12.0) * (0.5 + 1.5 * r)) * near * reach * (1.0 - fo * 0.1));
        near *= smoothstep(0.2, 0.6, ridge);
      }
      float core = smoothstep(0.32, 0.0, r + (n - 0.5) * 0.3);
      m = max(core, m) * smoothstep(1.0, 0.55, r + (n - 0.5) * 0.3);
    }
  }
  return m;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), hi = textureSize(uA, 0) - 1;
  float n = float(hi.x + 1);
  vec4 a = texelFetch(uA, p, 0), b = texelFetch(uB, p, 0);
  vec2 fc = gl_FragCoord.xy;
  bool fast = false;
  for (int i = 0; i < ${MAX_BOXES} * uOne; i++) fast = fast || (all(greaterThanEqual(fc, uFast[i].xy)) && all(lessThan(fc, uFast[i].zw)));
  bool band = all(greaterThanEqual(fc, uBand.xy)) && all(lessThan(fc, uBand.zw));
  // copy: keeps both ping-pong targets identical outside what was stepped
  if (!fast && !band) { oA = a; oB = b; return; }
  vec4 uK0 = fast ? uK[0] : uK[7], uK1 = fast ? uK[1] : uK[8], uK2 = fast ? uK[2] : uK[9];
  vec4 uK3 = fast ? uK[3] : uK[10], uK4 = fast ? uK[4] : uK[11], uK5 = fast ? uK[5] : uK[12];
  vec4 uK6 = fast ? uK[6] : uK[13];
  ivec2 pl = ivec2(max(p.x - 1, 0), p.y), pr = ivec2(min(p.x + 1, hi.x), p.y);
  ivec2 pd = ivec2(p.x, max(p.y - 1, 0)), pu = ivec2(p.x, min(p.y + 1, hi.y));
  vec4 aL = texelFetch(uA, pl, 0), aR = texelFetch(uA, pr, 0), aD = texelFetch(uA, pd, 0), aU = texelFetch(uA, pu, 0);
  vec4 bL = texelFetch(uB, pl, 0), bR = texelFetch(uB, pr, 0), bD = texelFetch(uB, pd, 0), bU = texelFetch(uB, pu, 0);
  // diagonals of frost only: an 8-neighbour count tells a dendrite tip (1) from a flat front (3)
  float fDL = texelFetch(uA, ivec2(pl.x, pd.y), 0).w, fDR = texelFetch(uA, ivec2(pr.x, pd.y), 0).w;
  float fUL = texelFetch(uA, ivec2(pl.x, pu.y), 0).w, fUR = texelFetch(uA, ivec2(pr.x, pu.y), 0).w;
  vec4 mask = texelFetch(uMask, p, 0);
  vec2 w = texelWorld(gl_FragCoord.xy, n);
  vec3 rnd = hash33(vec3(gl_FragCoord.xy, uSeed));
  float dt = uK5.w;

  float heat = a.x, chr = a.y, wet = a.z, frost = a.w;
  float crack = b.x, acid = b.y, corr = b.z, glow = b.w;
  float fVis = min(frost, 1.0);

  // heat: 5-tap diffusion, decay, water evaporates (latent heat cools), frost melts to wet
  heat += (aL.x + aR.x + aD.x + aU.x - 4.0 * heat) * uK0.y;
  heat *= uK0.x;
  float evap = min(wet, uK1.x * heat);
  wet -= evap;
  heat -= evap * 0.35;
  // branch-free on purpose here and below: FXC (ANGLE/D3D) compile time grows with every if
  frost = heat > 0.05 ? min(frost, 1.0) : frost;      // heat kills potential: no spreading into fire
  float melt = min(frost, uK1.z * heat);
  frost -= melt;
  wet += melt;
  heat = max(heat - melt * 0.5, 0.0);
  // char grows where hot and dry, then fades
  chr += uK0.z * smoothstep(0.15, 0.7, heat) * (1.0 - min(wet, 1.0));
  chr *= uK0.w;
  wet *= uK1.y;

  // frost front: dendrite tips advance at full rate, flat fronts at a fifth; water freezes
  // freely and with a smaller drop, so puddles and the pool ice over in sheets
  float frozenN = step(0.2, aL.w) + step(0.2, aR.w) + step(0.2, aD.w) + step(0.2, aU.w)
                + step(0.2, fDL) + step(0.2, fDR) + step(0.2, fUL) + step(0.2, fUR);
  float fMax = max(max(max(aL.w, aR.w), max(aD.w, aU.w)), max(max(fDL, fDR), max(fUL, fUR)) - uK2.y * 0.414);
  bool onWater = wet > 0.3;
  // New frost nucleates by a Packard-style snowflake rule: where exactly one 8-neighbour is
  // frozen (a tip), flanks (2-3 neighbours) rarely, so fingers stay thin and fork instead of
  // merging into a disc. Inside existing frost the potential flows freely to feed the tips.
  float fGate = onWater || frost > 0.2 ? 1.0 : step(uK2.z, mask.r) * (frozenN < 1.5 ? 1.0 : frozenN < 2.5 ? 0.02 : 0.001);
  // band steps decay the neighbours too (uK6): over its long dt, undecayed neighbours would
  // refill every texel and stall the decay of whole frozen areas. Per frame it's negligible
  // and the fast steps keep the reach the look was tuned with.
  // the drop per texel (so a front's reach) varies over ~3 m patches, x0.55..1.6: frost reaches
  // further where the stone is colder, and a splat's front grows into lobes, never a circle
  float fReach = onWater ? uK2.w : 0.55 + 1.05 * textureLod(uMask, w * ${f(1 / 150)}, 0.0).a;
  float fGrow = fMax * uK6.x - uK2.y * fReach;
  float fOld = fVis;
  frost *= uK1.w;
  frost = max(frost, fGrow * step(rnd.x, uK2.x * fGate) * step(heat, 0.05));
  wet += max(fOld - min(frost, 1.0), 0.0) * 0.8 * step(heat, 0.05);   // natural thaw -> puddle

  // crack front along the vein network
  float cMax = max(max(bL.x, bR.x), max(bD.x, bU.x));
  crack *= uK3.z;
  crack = max(crack, (cMax * uK6.y - uK3.y) * step(rnd.y, uK3.x * step(0.45, mask.g)));

  // corruption: spreads as a lobed stain (faster where the fbm is high), falling off with distance
  // from its source; the arena material draws the crack network through it, so the field itself
  // carries no veins (a vein-gated front read as one even tiling of glowing cells)
  float vMax = max(max(bL.z, bR.z), max(bD.z, bU.z));
  corr *= uK4.z;
  float vGate = 0.15 + 0.85 * mask.a * mask.a;
  corr = max(corr, (vMax * uK6.z - uK4.y) * step(rnd.z, uK4.x * vGate));
  corr = max(corr - uK5.z * glow, 0.0);              // holy light burns corruption away

  // acid: slow decay, slight spread; glow: fast decay
  acid += (bL.y + bR.y + bD.y + bU.y - 4.0 * acid) * uK5.x;
  acid *= uK3.w;
  glow *= uK4.w;

  // the pool stays full; frost on it is the ice sheet (frost x wet), heat is quenched
  float pool = inPool(w) ? 1.0 : 0.0;
  wet = max(wet, pool);
  heat *= mix(1.0, uK5.y, pool);

  vec4 A = vec4(heat, chr, wet, frost), B = vec4(crack, acid, corr, glow);
  if (fast && uPaintOn == 1) { A += texelFetch(uPaintA, p, 0); B += texelFetch(uPaintB, p, 0); }
  int splats = fast ? uSplatCount : 0;   // splats always lie inside the fast boxes
  for (int i = 0; i < splats; i++) {
    float m = splatShape(i, w);
    vec4 s1 = uSplat[i * 5 + 1], s2 = uSplat[i * 5 + 2];
    A.xyz += s1.xyz * m;
    B.yw += s2.yw * m;
    // potential channels take the max (re-splatting doesn't stack reach); negative erases
    A.w = s1.w >= 0.0 ? max(A.w, s1.w * m) : A.w + s1.w * m;
    B.x = s2.x >= 0.0 ? max(B.x, s2.x * m) : B.x + s2.x * m;
    B.z = s2.z >= 0.0 ? max(B.z, s2.z * m) : B.z + s2.z * m;
  }

  A = clamp(A, vec4(0.0), vec4(2.0, 1.0, 1.0, 4.0));
  B = clamp(B, vec4(0.0), vec4(4.0, 1.0, 4.0, 8.0));
  // stochastic rounding (1 ulp of dither, placed for how this GPU converts to fp16) keeps the
  // tiny per-step decays unbiased; then snap dust to exact zero so idle texels stay 0
  vec4 ulpA = exp2(floor(log2(max(A, 6.2e-5))) - 10.0), ulpB = exp2(floor(log2(max(B, 6.2e-5))) - 10.0);
  A += (rnd.x + uRound) * ulpA;
  B += (fract(rnd.x + 0.618) + uRound) * ulpB;
  oA = A * step(1.0 / 1024.0, A);
  oB = B * step(1.0 / 1024.0, B);
}`;

export class GroundField {
  // partial: false steps the whole field every frame (reference / debugging, ~0.1 ms at 1024^2)
  constructor(renderer, size = 1024, { partial = true } = {}) {
    this.renderer = renderer;
    this.size = size;
    this.partial = partial;
    const opts = {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, count: 2,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, generateMipmaps: false,
    };
    this.targets = [new THREE.WebGLRenderTarget(size, size, opts), new THREE.WebGLRenderTarget(size, size, opts)];
    this.parity = 0;
    // live-tunable rates (world units, seconds); turned into per-step factors in update()
    this.params = {
      heatTau: 2.5, heatDiffusion: 0.012, charRate: 1.4, charTau: 25,
      evaporation: 0.9, wetTau: 45, melt: 1.2, frostTau: 7,
      frostSpeed: 1.6, frostDrop: 0.4, frostThreshold: 0.88, frostWaterDrop: 0.2,
      crackSpeed: 4, crackDrop: 0.6, crackTau: 9,
      corruptionSpeed: 1.1, corruptionDrop: 0.4, corruptionTau: 14,
      acidTau: 14, acidSpread: 0.0015, glowTau: 1, poolQuench: 0.3, cleanse: 1.5,
    };

    // the sim texelFetches r/g/b; splats sample a (tileable) filtered, so repeat + linear
    this.mask = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      depthBuffer: false, generateMipmaps: false,
    });
    const maskQuad = new FullscreenQuad(rawPass(MASK_FRAG, { uOne: { value: 1 }, uNeedle: { value: 9 * Math.min(1, size / 1024) } }));

    this.splatVecs = Array.from({ length: MAX_SPLATS * SPLAT_VEC4 }, () => new THREE.Vector4());
    this.splatCount = 0;
    this.seed = 0;
    this.simMat = rawPass(SIM_FRAG, {
      uA: { value: null }, uB: { value: null }, uMask: { value: this.mask.texture },
      uSplat: { value: this.splatVecs }, uSplatCount: { value: 0 }, uSeed: { value: 0 }, uRound: { value: -0.5 }, uOne: { value: 1 },
      uK: { value: Array.from({ length: 14 }, () => new THREE.Vector4()) },
      uFast: { value: Array.from({ length: MAX_BOXES }, () => new THREE.Vector4()) }, uBand: { value: new THREE.Vector4() },
      uPaintA: { value: null }, uPaintB: { value: null }, uPaintOn: { value: 0 },
    });
    // partial-update bookkeeping (world-space regions -> texel rects); all preallocated
    this.time = 0;
    this.regions = Array.from({ length: MAX_REGIONS }, () => ({ x0: 0, z0: 0, x1: 0, z1: 0, until: -1 }));
    this.boxes = this.simMat.uniforms.uFast.value;   // texel rects [x0, y0, x1, y1) stepped this frame
    this.boxCount = 0;
    this._lastBoxes = Array.from({ length: MAX_BOXES }, () => new THREE.Vector4());
    this._lastBoxCount = 0;
    this._lastBand = new THREE.Vector4();
    this._q = new THREE.Vector4();
    this._u = new THREE.Vector4();
    this.band = 0;
    this.bandDt = new Float32Array(BANDS);
    this._full = true;                        // next update steps everything (after clear)
    this.quad = new FullscreenQuad(this.simMat);

    // particle paint: x right, y = +z (camera below the floor looking up keeps both axes positive).
    // Its own target, so overlapping fast boxes can't add the same paint twice.
    this.paintTarget = new THREE.WebGLRenderTarget(size, size, { ...opts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.simMat.uniforms.uPaintA.value = this.paintTarget.textures[0];
    this.simMat.uniforms.uPaintB.value = this.paintTarget.textures[1];
    this._clearColor = new THREE.Color();
    this.paintScene = new THREE.Scene();
    this.paintCamera = new THREE.OrthographicCamera(G.min.x, G.min.x + G.size, G.min.y + G.size, G.min.y, 0, 200);
    this.paintCamera.position.set(0, -100, 0);
    this.paintCamera.up.set(0, 0, 1);
    this.paintCamera.lookAt(0, 0, 0);
    this.paintCamera.updateMatrixWorld();

    this._initProbes();
    // issue every compile now: with KHR_parallel_shader_compile they build concurrently and
    // only the mask bake waits; the sim program (~0.4 s cold under ANGLE/D3D11, FXC) keeps
    // compiling in the background until the first update()
    const cam = new THREE.Camera(), prev = renderer.getRenderTarget();
    // fp16 render-target writes truncate on some GPUs (ANGLE/D3D11 measured: 1 + 0.75 ulp -> 1)
    // and round on others; a truncating GPU with +-0.5 ulp dither decays ~20% too fast
    const roundQuad = new FullscreenQuad(rawPass(/* glsl */`
precision highp float;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() { o0 = vec4(1.0 + 0.75 / 1024.0); o1 = vec4(0.0); }`));
    for (const q of [maskQuad, this.quad, this.probeQuad, roundQuad]) renderer.compile(q.mesh, cam);
    maskQuad.render(renderer, this.mask);
    maskQuad.material.dispose();
    roundQuad.render(renderer, this.paintTarget);
    const half = new Uint16Array(4);
    renderer.readRenderTargetPixels(this.paintTarget, 0, 0, 1, 1, half, undefined, 0);
    roundQuad.material.dispose();
    this.fp16Truncates = half[0] === 0x3c00;
    this.simMat.uniforms.uRound.value = this.fp16Truncates ? 0 : -0.5;
    renderer.setRenderTarget(prev);
    this.clear();
  }

  get current() { return this.targets[this.parity]; }

  // queue a splat for the next update (<= 16 per frame; extras are dropped)
  splat({ x = 0, z = 0, radius = 1, heat = 0, char = 0, wet = 0, frost = 0, crack = 0, acid = 0, corruption = 0, glow = 0,
    pattern = 'radial', seed = Math.random() * 100, angle = 0, x2 = x, z2 = z, width = 0, lobe = 0 } = {}) {
    if (this.splatCount >= MAX_SPLATS) return false;
    const v = this.splatVecs, o = this.splatCount * SPLAT_VEC4;
    v[o].set(x, z, radius, PATTERNS[pattern] ?? 0);
    v[o + 1].set(heat, char, wet, frost);
    v[o + 2].set(crack, acid, corruption, glow);
    v[o + 3].set(seed % 100, angle, x2, z2);
    const w = width || (pattern === 'line' ? radius : radius * 0.18);
    v[o + 4].set(w, lobe, 0, 0);   // line half-width / ring width, ring lobes
    this.splatCount++;
    if (pattern === 'radial' && crack >= 2) {
      let i = 0;
      for (let j = 1; j < 4; j++) if (CRACK_SOURCES[j].w < CRACK_SOURCES[i].w) i = j;
      CRACK_SOURCES[i].set(x, z, radius, crack);
    }
    if (pattern === 'line' && crack >= 1.5 && heat > 0.1 && w >= 0.25) {
      // a growing vent re-splats from the same start every frame: update its slot, else the weakest
      let i = -1, m = 0;
      for (let j = 0; j < 4; j++) {
        const a = FISSURE_A[j];
        if (FISSURE_B[j].y > 0 && Math.abs(a.x - x) < 0.05 && Math.abs(a.y - z) < 0.05) i = j;
        if (FISSURE_B[j].y < FISSURE_B[m].y) m = j;
      }
      if (i < 0) { i = m; FISSURE_B[i].set(0, 0, 0, 0); }
      FISSURE_A[i].set(x, z, x2, z2);
      FISSURE_B[i].set(Math.max(w, FISSURE_B[i].x), Math.max(crack, FISSURE_B[i].y), seed % 97, 0);
    }

    // region the splat's effects live in: its footprint, plus how far fronts and heat can
    // travel, for as long as they keep moving (afterwards the bands carry the slow decay)
    const p = this.params;
    const ext = pattern === 'line' ? w * 2.5 : radius * 1.6;
    const reach = Math.max(frost / p.frostDrop, crack / p.crackDrop, corruption / p.corruptionDrop, 0);
    const life = Math.min(20, Math.max(heat > 0 ? 3 * p.heatTau : 0, glow > 0 ? 3 * p.glowTau : 0,
      frost > 0 ? reach / p.frostSpeed * 1.5 + 1 : 0, crack > 0 ? reach / p.crackSpeed * 1.5 + 1 : 0,
      corruption > 0 ? reach / p.corruptionSpeed * 2 + 1 : 0, 0.5));
    const m = ext + reach + (heat > 0 ? 0.6 : 0.1);
    this._region(Math.min(x, x2) - m, Math.min(z, z2) - m, Math.max(x, x2) + m, Math.max(z, z2) + m, life);
    // ice on the pool spreads in a sheet much further than on stone: keep the whole pool live
    if (frost > 0 && Math.abs(x - P.center.x) < P.half.x + m && Math.abs(z - P.center.y) < P.half.y + m)
      this._region(P.center.x - P.half.x, P.center.y - P.half.y, P.center.x + P.half.x, P.center.y + P.half.y, life);
    return true;
  }

  // keep a world area stepped every frame for `seconds` (e.g. where particles paint)
  touch(x, z, radius, seconds = 1) { this._region(x - radius, z - radius, x + radius, z + radius, seconds); }

  _region(x0, z0, x1, z1, seconds) {
    let r = null, soonest = this.regions[0];
    for (const q of this.regions) {
      if (q.until < this.time) { r = q; break; }
      if (q.until < soonest.until) soonest = q;
    }
    let until = this.time + seconds;
    if (!r) {
      // ponytail: all slots live -> merge into the soonest-expiring one (a superset, still correct)
      r = soonest;
      x0 = Math.min(x0, r.x0); z0 = Math.min(z0, r.z0); x1 = Math.max(x1, r.x1); z1 = Math.max(z1, r.z1);
      until = Math.max(until, r.until);
    }
    r.x0 = x0; r.z0 = z0; r.x1 = x1; r.z1 = z1; r.until = until;
  }

  update(dt) {
    this.time += dt;
    const cd = decay(dt, this.params.crackTau);
    for (const c of CRACK_SOURCES) c.w *= cd;
    for (const b of FISSURE_B) b.y *= cd;
    const n = this.size, k = this.simMat.uniforms.uK.value;
    const band = this.simMat.uniforms.uBand.value;
    for (const b of this.boxes) b.set(0, 0, 0, 0);
    if (this._full || !this.partial) {
      this.boxes[0].set(0, 0, n, n);
      this.boxCount = 1;
      band.set(0, 0, 0, 0);
      this._full = false;
    } else {
      this._cluster();
      const h = n / BANDS;
      band.set(0, this.band * h, n, (this.band + 1) * h);
    }
    for (let i = 0; i < BANDS; i++) this.bandDt[i] += dt;
    if (band.w === 0) this.bandDt.fill(0);   // full step: every band is current
    this._factors(k, 0, dt, false);
    this._factors(k, 7, this.bandDt[this.band], true);
    // ponytail: texels that just left the fast boxes get their band's whole accumulated dt
    // (slightly early decay at a region's edge); per-texel step times would need a channel
    this.bandDt[this.band] = 0;
    this._step();
    this.band = (this.band + 1) % BANDS;
    this._readProbes();
  }

  // live regions -> <= 4 texel boxes (overlap allowed). A region joins a box when the union
  // is cheaper than drawing both, else opens a box; with all 4 open it joins the cheapest.
  // Then boxes whose union is cheaper than the pair are fused.
  // ponytail: greedy, order dependent; fine for a handful of spells, k-means if arenas get busy
  _cluster() {
    const n = this.size, B = this.boxes, q = this._q, u = this._u, s = n / G.size;
    let nb = 0;
    for (const r of this.regions) {
      if (r.until < this.time) continue;
      q.set(Math.round((r.x0 - G.min.x) * s), Math.round((r.z0 - G.min.y) * s), Math.round((r.x1 - G.min.x) * s), Math.round((r.z1 - G.min.y) * s));
      q.clampScalar(0, n);
      if (q.z <= q.x || q.w <= q.y) continue;
      // join the box where the union costs least extra over drawing both; only when that
      // saves texels, unless all boxes are taken
      let best = -1, extra = Infinity;
      for (let i = 0; i < nb; i++) {
        const b = B[i];
        u.set(Math.min(b.x, q.x), Math.min(b.y, q.y), Math.max(b.z, q.z), Math.max(b.w, q.w));
        const e = area(u) - area(b) - area(q);
        if ((e < 0 || nb === MAX_BOXES) && e < extra) { best = i; extra = e; }
      }
      if (best < 0) { B[nb++].copy(q); continue; }
      const b = B[best];
      b.set(Math.min(b.x, q.x), Math.min(b.y, q.y), Math.max(b.z, q.z), Math.max(b.w, q.w));
    }
    for (let i = 0; i < nb; i++) for (let j = i + 1; j < nb; j++) {
      const a = B[i], b = B[j];
      u.set(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.z, b.z), Math.max(a.w, b.w));
      if (area(u) >= area(a) + area(b)) continue;
      a.copy(u);
      b.copy(B[--nb]); B[nb].set(0, 0, 0, 0);
      j = i;   // a grew: recheck it against everything after it
    }
    this.boxCount = nb;
  }

  // per-step factors for a step of length dt into uK[o .. o + 6] (layout in SIM_FRAG)
  _factors(k, o, dt, band) {
    const p = this.params, dx = G.size / this.size, adv = dt / dx;   // front advance probability = speed * adv
    k[o].set(decay(dt, p.heatTau), Math.min(0.2, p.heatDiffusion * dt / (dx * dx)), p.charRate * dt, decay(dt, p.charTau));
    k[o + 1].set(p.evaporation * dt, decay(dt, p.wetTau), p.melt * dt, decay(dt, p.frostTau));
    k[o + 2].set(Math.min(1, p.frostSpeed * adv), p.frostDrop * dx, p.frostThreshold, p.frostWaterDrop);
    k[o + 3].set(Math.min(1, p.crackSpeed * adv), p.crackDrop * dx, decay(dt, p.crackTau), decay(dt, p.acidTau));
    k[o + 4].set(Math.min(1, p.corruptionSpeed * adv), p.corruptionDrop * dx, decay(dt, p.corruptionTau), decay(dt, p.glowTau));
    k[o + 5].set(Math.min(0.2, p.acidSpread * dt / (dx * dx)), decay(dt, p.poolQuench), p.cleanse * dt, dt);
    if (band) k[o + 6].set(k[o + 1].w, k[o + 3].z, k[o + 4].z, 0);
    else k[o + 6].set(1, 1, 1, 0);
  }

  _step() {
    const r = this.renderer, u = this.simMat.uniforms;
    const src = this.targets[this.parity], dst = this.targets[this.parity ^ 1];
    u.uA.value = src.textures[0];
    u.uB.value = src.textures[1];
    u.uSplatCount.value = this.splatCount;
    u.uSeed.value = this.seed = (this.seed + 1) % 4096;
    const prevTarget = r.getRenderTarget();
    // scissored draws over everything stepped now or last frame (an overlap just recomputes
    // the same texels): this frame's boxes, last frame's boxes unless one now covers them,
    // this band, last frame's band
    const B = this.boxes, L = this._lastBoxes, nb = this.boxCount;
    const painting = this.paintScene.children.length > 0 && nb > 0;
    u.uPaintOn.value = painting ? 1 : 0;
    if (painting) {
      r.getClearColor(this._clearColor);
      const ca = r.getClearAlpha(), autoClear = r.autoClear;
      r.setRenderTarget(this.paintTarget);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);   // full, unscissored: a fast clear
      r.autoClear = false;
      r.render(this.paintScene, this.paintCamera);
      r.autoClear = autoClear;
      r.setClearColor(this._clearColor, ca);
    }
    dst.scissorTest = true;
    for (let i = 0; i < nb; i++) this._draw(B[i], dst);
    for (let i = 0; i < this._lastBoxCount; i++) if (!this._covered(L[i])) this._draw(L[i], dst);
    this._draw(u.uBand.value, dst);
    if (!this._covered(this._lastBand)) this._draw(this._lastBand, dst);
    dst.scissorTest = false;
    r.setRenderTarget(prevTarget);
    for (let i = 0; i < nb; i++) L[i].copy(B[i]);
    this._lastBoxCount = nb;
    this._lastBand.copy(u.uBand.value);
    this.splatCount = 0;
    this.parity ^= 1;
    U.uGroundA.value = dst.textures[0];
    U.uGroundB.value = dst.textures[1];
  }

  _draw(q, dst) {
    if (q.z <= q.x || q.w <= q.y) return;
    dst.scissor.set(q.x, q.y, q.z - q.x, q.w - q.y);
    this.quad.render(this.renderer, dst);
  }

  _covered(q) {
    for (let i = 0; i < this.boxCount; i++) if (contains(this.boxes[i], q)) return true;
    return false;
  }

  clear() {
    const r = this.renderer, prev = r.getRenderTarget();
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of this.targets) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setClearColor(cc, ca);
    r.setRenderTarget(prev);
    this.splatCount = 0;
    for (const c of CRACK_SOURCES) c.set(0, 0, 0, 0);
    for (const b of FISSURE_B) b.set(0, 0, 0, 0);
    for (const q of this.regions) q.until = -1;
    this._lastBoxCount = 0;
    this._lastBand.set(0, 0, 0, 0);
    this._full = true;
    // the pool (wet = 1) is restamped by every step; the next update() steps the whole field
    U.uGroundA.value = this.current.textures[0];
    U.uGroundB.value = this.current.textures[1];
  }

  // --- probes: async PBO + fence readback (UW WaterQuery pattern, persistent buffers) ---
  _initProbes() {
    this.probes = new Float32Array(MAX_PROBES * 8);   // per probe: heat, char, wet, frost, crack, acid, corruption, glow
    this.probeCount = 0;          // probes in the last completed read
    this._probeN = 0;
    this._probeXZ = Array.from({ length: MAX_PROBES }, () => new THREE.Vector2());
    this.probeRT = new THREE.WebGLRenderTarget(MAX_PROBES * 2, 1, {
      type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false,
    });
    this.probeMat = rawPass(/* glsl */`
precision highp float;
uniform sampler2D uGroundA;
uniform sampler2D uGroundB;
uniform vec2 uProbe[${MAX_PROBES}];
out vec4 outColor;
void main() {
  int x = int(gl_FragCoord.x);
  vec2 uv = (uProbe[x >> 1] - vec2(${f(G.min.x)}, ${f(G.min.y)})) / ${f(G.size)};
  outColor = (x & 1) == 0 ? texture(uGroundA, uv) : texture(uGroundB, uv);
}`, { uGroundA: U.uGroundA, uGroundB: U.uGroundB, uProbe: { value: this._probeXZ } });
    this.probeQuad = new FullscreenQuad(this.probeMat);
    const gl = this.renderer.getContext();
    // storage is allocated at the first readPixels: Chrome counts the allocation as a write, and a
    // fence between it and the readback write discards its fast readback copy
    this._pbo = [0, 1].map(() => ({ buffer: gl.createBuffer(), sync: null, count: 0, sized: false }));
  }

  // points: [[x, z], ...] (<= 16). Results land in this.probes a few frames later.
  setProbes(points) {
    this._probeN = Math.min(points.length, MAX_PROBES);
    for (let i = 0; i < this._probeN; i++) this._probeXZ[i].set(points[i][0], points[i][1]);
  }

  _readProbes() {
    const gl = this.renderer.getContext();
    for (const s of this._pbo) {
      if (!s.sync || gl.getSyncParameter(s.sync, gl.SYNC_STATUS) !== gl.SIGNALED) continue;
      gl.deleteSync(s.sync);
      s.sync = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.probes, 0, s.count * 8);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.probeCount = s.count;
    }
    if (!this._probeN) return;
    const s = !this._pbo[0].sync ? this._pbo[0] : !this._pbo[1].sync ? this._pbo[1] : null;
    if (!s) return;
    const r = this.renderer, prev = r.getRenderTarget();
    this.probeQuad.render(r, this.probeRT);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.buffer);
    if (!s.sized) { gl.bufferData(gl.PIXEL_PACK_BUFFER, MAX_PROBES * 8 * 4, gl.STREAM_READ); s.sized = true; }
    gl.readPixels(0, 0, this._probeN * 2, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    s.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    s.count = this._probeN;
    r.setRenderTarget(prev);
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.mask.dispose(); this.probeRT.dispose(); this.paintTarget.dispose(); this.simMat.dispose(); this.probeMat.dispose();
    const gl = this.renderer.getContext();
    for (const s of this._pbo) { gl.deleteBuffer(s.buffer); if (s.sync) gl.deleteSync(s.sync); }
  }
}
