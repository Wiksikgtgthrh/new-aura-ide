import * as THREE from 'three';
import { U, ARENA, COMMON_GLSL, ARENA_GLSL, GROUND_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING, LINES_BLENDING, arenaSDF } from './common.js';
import { STRIP_GLSL, instanced, put4 } from './Ribbons.js';
import { arenaUniforms } from '../scene/arenaMaterial.js';
import { Q } from '../engine/quality.js';

// Lightning (PLAN 2.5 "Bolt path", 3 Lightning). Every bolt is evaluated per vertex from a handful
// of per-instance numbers, after Reed & Wyvill 1994:
//   P(t) = mix(A,B,t) + (U n1(t) + V n2(t)) L jag sum_k rough^k noise(t f 2^k + seed_k) sqrt(sin(pi t))
// with piecewise-linear lattice noise, which makes each octave exactly one level of midpoint
// displacement. One instance = one bolt = a main channel (256 segments), 8 branches (32) and
// 12 sub-branches (12), 656 segments. All cores are one full-res draw (lines scene), all glows one
// half-res draw (fx scene, emission only). Branch layout comes from branchSeed, so a restrike is
// the same seed with a new branchSeed: the channel stays, the branches change (real return strokes
// re-use the ionised channel).
//
// Optional per-bolt fields (their defaults draw the plain bolt other spells were written against):
//   rough        octave gain, 0.5 smooth .. ~0.65 (real channels: fractal dimension ~1.3)
//   fine         1 adds an eighth octave, one zigzag per segment
//   vary         0..1 width and brightness change along the strand, knots where it heads at the eye
//   stroke       0..1 how far the return stroke has climbed from b towards a (1 = all of it)
//   dart         t of a dart leader's head running a -> b, < 0 off
//   branchLevel  0..1 branch brightness and width relative to the channel
//   residual     0..1 the cooling channel: it widens and breaks up into beads
// A floor mirror image of every bolt (High and up: a child of cores, one more draw) stands in for
// the planar reflection, which no tier affords: puddles and the pool show the real jagged channel.
//
// Hashes are integer PCG (Jarzynski & Olano 2020) so the JS mirror point() matches the GPU bit for
// bit; seeds are integers in [0, 2^24) (they travel as float attributes).

const STRANDS = [   // segments, count, first strand id
  { seg: 256, n: 1 }, { seg: 32, n: 8 }, { seg: 12, n: 12 },
];
const MAIN = { freq: 2, octaves: 7 };   // finest lattice = 2 * 2^6 = 128 cells; `fine` adds one more, one cell per segment

const BOLT_VERT = /* glsl */`
in vec4 aA;      // a.xyz, seed
in vec4 aB;      // b.xyz, branch seed
in vec4 aShape;  // branches, sub-branches, jag, core width (m)
in vec4 aCore;   // core rgb * intensity, reveal
in vec4 aGlow;   // glow rgb * intensity, glow width multiplier
in vec4 aMisc;   // snap to arena, octave gain, extra octave, variation along the strand
in vec4 aFx;     // return-stroke reach, dart head, branch level, residual
out vec2 vUv;    // along the strand, across (-1..1)
out vec3 vColor;
out vec3 vEdge;  // the core's saturated sheath
out float vViewZ;
out float vS;    // metres along the strand
#ifdef BOLT_MIRROR
out vec3 vW;     // mirrored world position
#endif
float gGain = 0.5;   // octave gain, per bolt

uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float urand(uint v) { return float(pcg(v)) * (1.0 / 4294967296.0); }
// piecewise-linear value noise on the integer lattice, -1..1
float lnoise(float x, uint salt) {
  float i = floor(x);
  uint k = uint(i) + salt;
  return mix(urand(k), urand(k + 1u), x - i) * 2.0 - 1.0;
}
vec3 perp(vec3 t) { return normalize(cross(t, abs(t.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))); }
// freeEnd 1: envelope sqrt(sin(pi t / 2)) pins only the start, so branch tips wander
vec3 boltPath(vec3 A, vec3 B, float t, uint seed, float jag, float freq, int octaves, float freeEnd) {
  vec3 d = B - A;
  float L = length(d);
  vec3 T = d / max(L, 1e-6), Ub = perp(T), Vb = cross(T, Ub);
  float n1 = 0.0, n2 = 0.0, amp = 1.0, f = freq;
  for (int k = 0; k < 8; k++) {
    if (k >= octaves) break;
    uint s = pcg(seed + uint(k) * 0x9E3779B9u);
    n1 += amp * lnoise(t * f, s);
    n2 += amp * lnoise(t * f, s ^ 0x5bd1e995u);
    amp *= gGain; f *= 2.0;
  }
  float env = sqrt(max(sin(PI * t * (1.0 - 0.5 * freeEnd)), 0.0));
  return mix(A, B, t) + (Ub * n1 + Vb * n2) * (L * jag * env);
}
// 25-50 degrees off the parent tangent, random azimuth
vec3 deviate(vec3 T, uint h) {
  float th = radians(mix(25.0, 50.0, urand(h + 1u))), ph = 2.0 * PI * urand(h + 2u);
  vec3 Ub = perp(T), Vb = cross(T, Ub);
  return cos(th) * T + sin(th) * (cos(ph) * Ub + sin(ph) * Vb);
}
// ground-crawl arcs: project onto the nearest arena surface (exact for planes and capsules)
vec3 snapArena(vec3 p) { return p - arenaNormal(p) * (arenaSDF(p) - 0.03); }

void main() {
  vUv = vec2(0.0); vColor = vec3(0.0); vEdge = vec3(0.0); vViewZ = 1.0; vS = 0.0;
#ifdef BOLT_MIRROR
  vW = vec3(0.0);
  if (aShape.w < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // only real channels: not arcs hugging the floor
#endif
  float t = position.x;
  int strand = int(position.z), nb = int(aShape.x), ns = int(aShape.y);
  vec3 A = aA.xyz, B = aB.xyz;
  uint seed = pcg(uint(aA.w)), bseed = uint(aB.w);
  float L = length(B - A), jag = aShape.z, reveal = aCore.w;
  gGain = aMisc.y;
  float vary = aMisc.w, stroke = aFx.x, dart = aFx.y, res = aFx.w;

  // strand frame: main channel, branch off it, or sub-branch off a branch
  vec3 sA = A, sB = B;
  uint sSeed = seed;
  float freq = ${MAIN.freq.toFixed(1)}, freeEnd = 0.0, vis = reveal, wMul = 1.0, iMul = 1.0, sJag = jag, len = L, tm = t;
  int oct = ${MAIN.octaves} + int(aMisc.z);
  if (strand > 0) {
    bool sub = strand > 8;
    int bi = sub ? (strand - 9) % max(nb, 1) : strand - 1;
    if (sub ? (strand - 9 >= ns || nb == 0) : bi >= nb) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    uint bh = pcg(bseed + uint(bi) * 0x632BE5ABu);
    float tb = mix(0.05, 0.75, urand(bh));
    tm = tb;
    sA = boltPath(A, B, tb, seed, jag, freq, oct, 0.0);
    // smoothed parent tangent (the per-segment one is as jagged as the bolt)
    vec3 Tm = normalize(boltPath(A, B, tb + 0.05, seed, jag, freq, oct, 0.0) - sA);
    len = mix(0.15, 0.4, urand(bh + 3u)) * L;
    sB = sA + deviate(Tm, bh) * len;
    sSeed = pcg(bh + 4u); freq = 2.0; oct = 5; freeEnd = 1.0; sJag = jag * 1.3;
    vis = (reveal - tb) * L / len;     // the leader runs on along the branch at the same speed
    wMul = 0.55; iMul = 0.45;
    if (sub) {
      uint sh = pcg(bseed + uint(strand) * 0x2C1B3C6Du);
      float ts = mix(0.1, 0.7, urand(sh));
      vec3 q0 = boltPath(sA, sB, ts, sSeed, sJag, freq, oct, 1.0);
      vec3 Tq = normalize(boltPath(sA, sB, ts + 0.1, sSeed, sJag, freq, oct, 1.0) - q0);
      float len2 = mix(0.3, 0.6, urand(sh + 3u)) * len;
      vis = (vis - ts) * len / len2;
      sA = q0; sB = q0 + deviate(Tq, sh) * len2; len = len2;
      sSeed = pcg(sh + 4u); freq = 1.5; oct = 3;
      wMul = 0.35; iMul = 0.25;
    }
    // branches thin and dim towards their tips, and carry far less current than the channel
    wMul *= (1.0 - 0.6 * t) * (0.6 + 0.4 * aFx.z); iMul *= (1.0 - 0.7 * t) * aFx.z * (1.0 - res) * (1.0 - res);
  }
  if (vis <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  // the fronts below ramp over a distance like the ribbon's width, or the wide glow shows a flat cap
#ifdef BOLT_GLOW
  float soft = 1.5;
#else
  float soft = 0.25;
#endif
  // return stroke: lit up from the ground end, its front burning hottest; a dim leader above it
  if (stroke < 1.0) {
    float below = (tm - (1.0 - stroke)) * L;
    iMul *= mix(0.1, 1.0 + 3.0 * exp(-max(below, 0.0) / 1.5), smoothstep(-soft, 0.0, below));
  }
  // dart leader: a bright head running down the old channel, a fading tail, the cold channel ahead
  if (dart >= 0.0) {
    float behind = (dart - tm) * L;
    iMul *= mix(0.12, 1.0 + 7.0 * exp(-max(behind, 0.0) / 2.0), smoothstep(-soft, 0.0, behind));
  }
  // the channel is never uniform: log-normal brightness knots, a width that wanders and swells
  // towards the ground, where the current is highest
  float wVar = 1.0, x = t * len;
  if (vary > 0.0) {
    uint hv = sSeed ^ 0x3C6EF372u;
    float n2 = lnoise(x * 1.9, hv + 97u);
    iMul *= exp(vary * (0.75 * lnoise(x * 0.45, hv) + 0.45 * n2 + 0.25 * lnoise(x * 5.3, hv + 311u)));
    wVar = 1.0 + vary * (0.4 * lnoise(x * 0.8, hv + 191u) + 0.2 * n2);
    if (strand == 0) { wVar *= 1.0 + vary * 0.7 * t * t; iMul *= 1.0 + vary * 0.6 * t * t; }
  }
  // the cooling channel diffuses and breaks into beads
  if (res > 0.0) {
    float b = 0.5 + 0.35 * lnoise(x * 1.3, sSeed + 733u) + 0.15 * lnoise(x * 4.1, sSeed + 1009u);
    iMul *= smoothstep(res * 1.15 - 0.3, res * 1.15 + 0.05, b);
    wVar *= 1.0 + 1.2 * res;
  }
#ifdef BOLT_GLOW
  oct = max(oct - 2, 2);   // the wide glow follows the big kinks only: no fans at every zigzag
  float hs = strand == 0 ? 8.0 : strand <= 8 ? 4.0 : 2.0;
#else
  float hs = strand == 0 ? 4.0 : strand <= 8 ? 2.0 : 1.0;
#endif

  // stepped leader: vertices past the tip fold onto it (zero-area triangles)
  float tt = min(t, vis), h = hs / float(strand == 0 ? ${STRANDS[0].seg} : strand <= 8 ? ${STRANDS[1].seg} : ${STRANDS[2].seg});
  vec3 p = boltPath(sA, sB, tt, sSeed, sJag, freq, oct, freeEnd);
  vec3 pP = boltPath(sA, sB, max(tt - h, 0.0), sSeed, sJag, freq, oct, freeEnd);
  vec3 pN = boltPath(sA, sB, min(tt + h, 1.0), sSeed, sJag, freq, oct, freeEnd);
  if (aMisc.x > 0.5) { p = snapArena(p); pP = snapArena(pP); pN = snapArena(pN); }
  // the growing leader's tip burns brighter over its last ~30 cm
  if (vis < 1.0) iMul *= 1.0 + 3.0 * exp(-(vis - tt) * len / 0.3);

  // the strip's side comes from a tangent a few segments long, so the zigzag can't twist the ribbon
  vec3 Ts = pN - pP, eye = p - cameraPosition;
  float mu = dot(Ts, eye);
  mu *= mu / max(dot(Ts, Ts) * dot(eye, eye), 1e-6);   // cos^2 of the angle to the eye ray
  // looking down a stretch of channel integrates more of it: knots where it heads at the eye
  iMul *= 1.0 + vary * 2.0 * mu * mu;
#ifdef BOLT_MIRROR
  // below the floor; ripples and a rough surface smear it the further it is from the plane
  float hgt = max(p.y, 0.0), blur = 2.0 + 0.3 * min(hgt, 10.0);
  p.xz += vec2(sin(hgt * 3.7 + uTime * 5.0), cos(hgt * 2.9 - uTime * 4.0)) * 0.012 * min(hgt, 8.0);
  p.y = -p.y; Ts.y = -Ts.y;
  vW = p;
  wVar *= blur; iMul /= blur;
#endif

  vViewZ = -(viewMatrix * vec4(p, 1.0)).z;
  vS = x;
  vec3 side = stripSide(p, Ts);
  float aa;
#ifdef BOLT_GLOW
  float hw = wireHalfWidth(aShape.w * wMul * wVar * aGlow.w, vViewZ, pxPerMetre(uFxResolution.y), aa);
  // a wide ribbon seen end-on is a fan, and a branch passing the lens a wedge across the frame
  hw = min(hw * smoothstep(0.0, 0.25, 1.0 - mu), 0.07 * vViewZ);
  // no flat end caps: the ribbon fades out over about its own width
  vColor = aGlow.rgb * iMul * aa * smoothstep(0.0, min(1.5 * hw, 0.3 * len), min(t, min(vis, 1.0) - t) * len);
#else
  float hw = min(wireHalfWidth(aShape.w * wMul * wVar, vViewZ, pxPerMetre(uResolution.y), aa), 0.012 * vViewZ);
  vColor = aCore.rgb * iMul * aa;
  vEdge = aGlow.rgb * iMul * aa;
#endif
  vUv = vec2(t, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p + side * position.y * hw, 1.0);
}`;

// A hot filament twisting inside a softer body inside a saturated sheath: the tone mapper clips the
// middle of a return stroke, the falloff and the wander are what keep it from being a flat stripe.
const CORE_FRAG = /* glsl */`
in vec2 vUv;
in vec3 vColor;
in vec3 vEdge;
in float vS;
out vec4 fragColor;
void main() {
  float y = vUv.y, r2 = y * y, env = 1.0 - r2;
  float o = y - 0.3 * sin(vS * 9.0 + 2.1 * sin(vS * 3.7));
  float body = exp(-r2 * 5.0);
  fragColor = vec4((vColor * (0.62 * exp(-o * o * 26.0) + 0.38 * body) + vEdge * 2.0 * (1.0 - body)) * env * env, 1.0);
}`;

// The mirrored strip, kept only where the eye ray meets a visible floor or the pool: Fresnel, and
// the same puddle mask and char the floor material uses.
const MIRROR_FRAG = COMMON_GLSL + GROUND_GLSL + /* glsl */`
uniform sampler2D uSceneDepth;
uniform sampler2D uStoneNoise;
in vec2 vUv;
in vec3 vColor;
in vec3 vW;
out vec4 fragColor;
void main() {
  vec3 rd = vW - cameraPosition;
  vec3 q = cameraPosition + rd * (-cameraPosition.y / min(rd.y, -1e-4));
  float qz = -(viewMatrix * vec4(q, 1.0)).z;
  if (dot(q.xz, q.xz) > ${(ARENA.radius * ARENA.radius).toFixed(1)} || linearDepth(texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r) < qz - 0.12) discard;
  vec2 pq = abs(q.xz - vec2(${ARENA.pool.center.x.toFixed(3)}, ${ARENA.pool.center.y.toFixed(3)}));
  float refl = 1.0;
  if (pq.x > ${ARENA.pool.half.x.toFixed(3)} || pq.y > ${ARENA.pool.half.y.toFixed(3)}) {
    vec4 g = groundA(q.xz);
    float wt = clamp(g.z, 0.0, 1.0);
    float puddle = smoothstep(0.35, 0.7, wt * (0.6 + 0.8 * texture(uStoneNoise, q.xz * 0.11 + 0.31).g));
    refl = mix(0.16, 1.0, max(puddle, wt * 0.5)) * (1.0 - 0.9 * clamp(g.y, 0.0, 1.0));
  }
  float nv = 1.0 - clamp((cameraPosition.y - q.y) / length(cameraPosition - q), 0.0, 1.0), nv2 = nv * nv;
  float env = 1.0 - vUv.y * vUv.y;
  // the real channel is thousands of times brighter than anything else in the frame, so even 2-5%
  // Fresnel off a wet slab reads strongly: boosted, with the grazing end capped
  fragColor = vec4(vColor * (env * env * refl * min(8.0 * (0.02 + 0.98 * nv2 * nv2 * nv), 1.0)), 1.0);
}`;

const GLOW_FRAG = /* glsl */`
in vec2 vUv;
in vec3 vColor;
in float vViewZ;
void main() {
  float v2 = vUv.y * vUv.y;
  // a tight halo hugging the core plus the wide glow; both reach 0 at the strip edge, bloom does the rest
  float g = 0.55 * (exp(-v2 * 3.0) - 0.0498) + 0.45 * (exp(-v2 * 18.0));
  fxOut(vec3(0.0), 0.0, vColor * max(g, 0.0) * softFade(vViewZ, 0.5), vec2(0.0), vViewZ);
}`;

// --- JS mirror of the main channel -------------------------------------------------------
function pcg(v) {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
const urand = (v) => pcg(v >>> 0) / 4294967296;
function lnoise(x, salt) {
  const i = Math.floor(x), k = (i + salt) >>> 0;
  const a = urand(k), b = urand((k + 1) >>> 0);
  return (a + (b - a) * (x - i)) * 2 - 1;
}
const _d = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), RIGHT = new THREE.Vector3(1, 0, 0);
function boltPathJS(A, B, t, seed, jag, freq, octaves, gain, out) {
  _d.subVectors(B, A);
  const L = _d.length();
  _d.multiplyScalar(1 / Math.max(L, 1e-6));
  _u.crossVectors(_d, Math.abs(_d.y) < 0.99 ? UP : RIGHT).normalize();
  _v.crossVectors(_d, _u);
  let n1 = 0, n2 = 0, amp = 1, f = freq;
  for (let k = 0; k < octaves; k++) {
    const s = pcg((seed + Math.imul(k, 0x9E3779B9)) >>> 0);
    n1 += amp * lnoise(t * f, s);
    n2 += amp * lnoise(t * f, (s ^ 0x5bd1e995) >>> 0);
    amp *= gain; f *= 2;
  }
  const k = L * jag * Math.sqrt(Math.max(Math.sin(Math.PI * t), 0));
  return out.lerpVectors(A, B, t).addScaledVector(_u, n1 * k).addScaledVector(_v, n2 * k);
}
const sdfAt = (p, dx, dy, dz) => arenaSDF(_q.set(p.x + dx, p.y + dy, p.z + dz));
function snapJS(p) {
  const e = 0.01, d = arenaSDF(p);
  _d.set(sdfAt(p, e, 0, 0) - sdfAt(p, -e, 0, 0), sdfAt(p, 0, e, 0) - sdfAt(p, 0, -e, 0), sdfAt(p, 0, 0, e) - sdfAt(p, 0, 0, -e)).normalize();
  return p.addScaledVector(_d, -(d - 0.03));
}

const DEFAULTS = {
  seed: 1, branchSeed: 1, branches: 8, subBranches: 12, jag: 0.11, width: 0.03,
  intensity: 60, glowWidth: 12, reveal: 1, snapToArena: false,
  rough: 0.5, fine: 0, vary: 0, stroke: 1, dart: -1, branchLevel: 1, residual: 0,
};

export class Bolts {
  constructor({ max = 32 } = {}) {
    this.max = max;
    const geo = new THREE.InstancedBufferGeometry();
    const pos = [], index = [];
    let strand = 0;
    for (const { seg, n } of STRANDS) {
      for (let j = 0; j < n; j++, strand++) {
        const base = pos.length / 3;
        for (let i = 0; i <= seg; i++) pos.push(i / seg, -1, strand, i / seg, 1, strand);
        for (let i = 0; i < seg; i++) {
          const a = base + i * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    this.attrs = ['aA', 'aB', 'aShape', 'aCore', 'aGlow', 'aMisc', 'aFx'].map((n) => instanced(geo, n, max));
    this._arrays = this.attrs.map((x) => x.array);
    geo.instanceCount = 0;
    this.geometry = geo;
    this.segments = STRANDS.reduce((s, x) => s + x.seg * x.n, 0);

    this.uniforms = { ...U };
    const head = COMMON_GLSL + ARENA_GLSL + STRIP_GLSL + BOLT_VERT;
    this.cores = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.uniforms, ...LINES_BLENDING, side: THREE.DoubleSide,
      vertexShader: head, fragmentShader: CORE_FRAG,
    }));
    this.glows = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.uniforms, ...FX_BLENDING, side: THREE.DoubleSide, defines: { BOLT_GLOW: 1 },
      vertexShader: FX_VERT_HEAD + head,
      fragmentShader: FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + GLOW_FRAG,
    }));
    this.cores.frustumCulled = this.glows.frustumCulled = false;
    this.cores.visible = this.glows.visible = false;
    if (Q.reflectFx) {
      const mirror = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms: { ...this.uniforms, uStoneNoise: arenaUniforms.uStoneNoise }, ...LINES_BLENDING, depthTest: false, side: THREE.DoubleSide, defines: { BOLT_MIRROR: 1 },
        vertexShader: head, fragmentShader: MIRROR_FRAG,
      }));
      mirror.frustumCulled = false;
      this.cores.add(mirror);
    }

    this.bolts = Array.from({ length: max }, (_, index) => ({
      index, active: false, ...DEFAULTS,
      a: new THREE.Vector3(), b: new THREE.Vector3(),
      color: new THREE.Color(), glowColor: new THREE.Color(),
      // JS mirror of the main channel (sparks, the line light); out is returned
      point(t, out) {
        boltPathJS(this.a, this.b, t, pcg(this.seed >>> 0), this.jag, MAIN.freq, MAIN.octaves + (this.fine ? 1 : 0), this.rough, out);
        return this.snapToArena ? snapJS(out) : out;
      },
      release() { this.active = false; },
    }));
  }

  // a, b: Vector3 (copied); colours: THREE.Color (copied). glowColor is multiplied by intensity,
  // so keep it ~0.05-0.2 in magnitude. Returns null when all 32 are live.
  acquire(opts = {}) {
    for (const h of this.bolts) {
      if (h.active) continue;
      Object.assign(h, DEFAULTS);
      h.seed = (Math.random() * 16777216) | 0;
      h.branchSeed = (Math.random() * 16777216) | 0;
      h.color.setRGB(0.82, 0.9, 1.0);          // ~20000 K: near-white with a blue cast
      h.glowColor.setRGB(0.05, 0.075, 0.2);
      for (const k in opts) {
        const v = opts[k];
        if (v && v.isVector3) h[k].copy(v); else if (v && v.isColor) h[k].copy(v); else h[k] = v;
      }
      h.active = true;
      return h;
    }
    return null;
  }

  update() {
    let top = 0, dirty = false;
    const X = this._arrays, a = X[0], b = X[1], s = X[2], c = X[3], g = X[4], m = X[5], e = X[6];
    for (const h of this.bolts) {
      const o = h.index * 4, on = h.active && h.intensity > 0 && h.reveal > 0;
      dirty = put4(c, o, h.color.r * h.intensity, h.color.g * h.intensity, h.color.b * h.intensity, on ? h.reveal : 0) || dirty;
      if (!on) continue;
      top = h.index + 1;
      dirty = put4(a, o, h.a.x, h.a.y, h.a.z, h.seed) || dirty;
      dirty = put4(b, o, h.b.x, h.b.y, h.b.z, h.branchSeed) || dirty;
      dirty = put4(s, o, h.branches, h.subBranches, h.jag, h.width) || dirty;
      dirty = put4(g, o, h.glowColor.r * h.intensity, h.glowColor.g * h.intensity, h.glowColor.b * h.intensity, h.glowWidth) || dirty;
      dirty = put4(m, o, h.snapToArena ? 1 : 0, h.rough, h.fine ? 1 : 0, h.vary) || dirty;
      dirty = put4(e, o, h.stroke, h.dart, h.branchLevel, h.residual) || dirty;
    }
    if (dirty) for (const x of this.attrs) x.needsUpdate = true;
    this.geometry.instanceCount = top;
    this.cores.visible = this.glows.visible = top > 0;
  }
}
