import * as THREE from 'three';
import { U, COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL } from './common.js';
import { REFRACT_GLSL } from './Refraction.js';
import { Q } from '../engine/quality.js';

// Raymarched liquid blobs (water whip, acid orb) for the refract pass. Each handle is a chain of
// up to 16 smooth-unioned spheres, one instanced draw of 1-4 oriented boxes (back faces, so the
// camera may be inside) refitted along the chain every frame. Per pixel:
//   1. only the lowest-numbered box the ray crosses goes on (the boxes overlap); then the ray vs
//      each sphere's shells (groups of 4 first): the short list of spheres that can shape this
//      ray's surface, the [t0, t1] range to march and the liquid chord. Box corners discard here.
//   2. sphere trace (<= 32 steps, Q.volumeSteps / 24) of the listed spheres' smooth union, plus
//      wobble and acid blisters cached near the surface, with secant steps. Misses that pass within
//      a pixel of the surface keep partial coverage: alpha-to-coverage makes the MSAA silhouette.
//   3. analytic gradient normal, thickness = chord - hit, then Fresnel sky + sun + spell-light
//      specular over the refracted, Beer-Lambert-tinted scene (+ the acid's inner glow).
// gl_FragDepth is the hit, so later passes (smoke, sparks) are occluded by the liquid.
// Presets are uniforms only: one program for every handle, no recompiles.

// UW's WATER_PRESETS ('tropical', 'toxic green'): absorption and turbidity divided by UW's
// 'clarity' knob, since a whip is ~0.4 m thick where UW's sea is metres deep (at clarity 1 water
// reads as clear glass). Acid is murkier still, so its own glow rather than the sky shows through.
const uw = (a, clarity) => a.map((x) => x / clarity);
export const METABALL_PRESETS = {
  water: {
    absorption: uw([0.36, 0.045, 0.06], 0.12), turbidity: 0.02 / 0.12, scatterColor: [0.0, 0.085, 0.085], emission: [0, 0, 0],
    k: 0.25, wobble: 0.02, bubbles: 0, corrosion: 0, ior: 1.33, roughness: 0.03, refraction: 1.6, rim: 0.5,
  },
  acid: {
    absorption: uw([0.45, 0.1, 1.1], 0.04), turbidity: 0.08 / 0.04, scatterColor: [0.05, 0.1, 0.004], emission: [0.14, 1.0, 0.05],
    k: 0.3, wobble: 0.025, bubbles: 1, corrosion: 1, ior: 1.36, roughness: 0.07, refraction: 1.2, rim: 0.4,
  },
};

const BUBBLE_CELL = 0.12;                       // m, one blister per cell
const BUBBLE_H = BUBBLE_CELL * 0.33 * 0.35;     // tallest blister (m)

const MAX_BOXES = 4;
const SHELL = 0.3;   // x k: where the march starts past each sphere (see the shader)

const VERT = /* glsl */`
out vec3 vWorld;
flat out int vBox;
void main() {
  vBox = gl_InstanceID;
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const frag = (NS) => /* glsl */`
#define NS ${NS}
#define BUBBLE_CELL ${BUBBLE_CELL.toFixed(4)}
#define BUBBLE_H ${BUBBLE_H.toFixed(5)}
#define SHELL ${SHELL.toFixed(2)}
#define NG ${NS + 3 >> 2}
#define MAX_BOXES ${MAX_BOXES}
// spheres: world centre xyz, radius w (m). The same data twice: a uniform array for loops where
// every pixel reads sphere i together (constant broadcast), and a texture row (texel i = sphere i)
// for the march, where each pixel reads its own short list (divergent constant reads serialize)
uniform vec4 uSpheres[NS];
uniform highp sampler2D uSphereTex;
uniform int uRow;
uniform int uCount;          // <= NS (clamped on the CPU)
uniform vec4 uGroups[NG];    // bounding sphere of spheres 4g..4g+3 (m)
uniform mat4 uBoxInv[MAX_BOXES];   // world -> proxy box g ([-1, 1]^3)
flat in int vBox;
uniform vec4 uShape;         // smooth-union k (m), wobble (m), bubbles 0..1, corrosion 0..1
uniform vec4 uOptics;        // ior, roughness, refraction lens scale, rim
uniform vec3 uAbsorption;    // 1/m
uniform float uTurbidity;    // 1/m, grey extinction (scattered out; comes back as in-scatter)
uniform vec3 uScatter;       // in-scatter albedo of the body
uniform vec3 uEmission;      // HDR radiance, already x intensity x Q.emission
uniform int uSteps;
uniform float uMetaDebug;    // 1 march-step heat map, 2 proxy box, 3 flat coverage, 4 thickness (r = m), 5 stats (steps, list, coverage)
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
${COMMON_GLSL}
${NOISE_GLSL}
${WORLD_GLSL}
${LIGHTS_GLSL}
${REFRACT_GLSL}
in vec3 vWorld;
out vec4 fragColor;

// the spheres this ray passes close enough to matter (2-4 on a whip, up to 6 on an orb), as 4-bit
// indices packed 8 per uint, so the SDF loops over those few instead of all NS
uvec2 gList;
int gN;
vec3 gAnchor;    // sphere 0: surface detail travels with the blob
vec4 sph(int i) { return texelFetch(uSphereTex, ivec2(i, uRow), 0); }
vec4 sphere(int j) { return sph(int(((j < 8 ? gList.x : gList.y) >> uint((j & 7) * 4)) & 15u)); }

// polynomial smooth min (iq) with sphere s; compact support: plain min once |a - b| > k
void blend(inout float d, vec3 p, vec4 s, float k) {
  float a = length(p - s.xyz) - s.w, h = max(k - abs(a - d), 0.0) / k;
  d = min(a, d) - h * h * k * 0.25;
}
float base(vec3 p) {
  float d = 1e4, k = max(uShape.x, 1e-4);
  for (int j = 0; j < gN; j++) blend(d, p, sphere(j), k);
  return d;
}
// the same with its exact gradient: d smin / d a = 1 - h/2 for the smaller argument, h/2 for the
// larger, so the normal costs one pass instead of four SDF taps
void blendGrad(inout float d, inout vec3 g, vec3 p, vec4 s, float k) {
  vec3 dp = p - s.xyz;
  float l = length(dp), a = l - s.w, h = max(k - abs(a - d), 0.0) / k;
  vec3 ga = dp / max(l, 1e-6);
  g = a < d ? mix(ga, g, 0.5 * h) : mix(g, ga, 0.5 * h);
  d = min(a, d) - h * h * k * 0.25;
}
vec3 baseGrad(vec3 p) {
  float d = 1e4, k = max(uShape.x, 1e-4);
  vec3 g = vec3(0.0, 1.0, 0.0);
  for (int j = 0; j < gN; j++) blendGrad(d, g, p, sphere(j), k);
  return g;
}

// three crossed travelling waves: a smooth liquid wobble with a known slope (|grad| <= 7.2)
const vec3 W1 = vec3(5.1, 3.3, -2.7), W2 = vec3(-2.2, 6.3, 3.9), W3 = vec3(3.7, -1.9, 5.8);
float wobble(vec3 q) {
  float t = uTime;
  return (sin(dot(q, W1) + t * 3.1) + sin(dot(q, W2) - t * 2.3) + sin(dot(q, W3) + t * 4.2)) * (1.0 / 3.0);
}
vec3 wobbleGrad(vec3 q) {
  float t = uTime;
  return (W1 * cos(dot(q, W1) + t * 3.1) + W2 * cos(dot(q, W2) - t * 2.3) + W3 * cos(dot(q, W3) + t * 4.2)) * (1.0 / 3.0);
}

// acid blisters: one bubble per cell, jittered so it never crosses the cell wall, swelling over
// its life and gone at the wrap (the pop). Returns the height (<= BUBBLE_H, slope <= 0.55),
// g its gradient, glow the flare just before the pop.
float blister(vec3 q, out vec3 g, out float glow) {
  vec3 c = floor(q / BUBBLE_CELL), h = hash33(c);
  float life = fract(h.x * 7.0 + uTime * (0.25 + 0.5 * h.y));
  vec3 o = q - (c + 0.5 + (h - 0.5) * 0.3) * BUBBLE_CELL;
  float rad = max(BUBBLE_CELL * 0.33 * sqrt(life), 1e-4);
  float s = max(1.0 - dot(o, o) / (rad * rad), 0.0);   // 1 - x^2, x = distance / radius
  g = -1.4 * s * o / rad;
  glow = s * s * smoothstep(0.7, 1.0, life);
  return 0.35 * rad * s * s;
}

// outward displacement (m), |detail| <= pad
float detail(vec3 p) {
  vec3 q = p - gAnchor, g;
  float glow, d = uShape.y * wobble(q);
  if (uShape.z > 0.0) d += uShape.z * blister(q, g, glow);
  return d;
}

// fine travelling ripples, shading only: a few mm, invisible on the silhouette and not worth a
// sin pair in every march step, but they make reflections and refraction shimmer like liquid
const vec3 R1 = vec3(17.0, 9.0, -11.0), R2 = vec3(-8.0, 19.0, 12.0);
vec3 rippleGrad(vec3 q) {
  float a = dot(q, R1) + uTime * 7.0, b = dot(q, R2) - uTime * 5.3;
  return R1 * cos(a) * sin(b) + R2 * sin(a) * cos(b);
}

#define HIT_PX 0.5

void main() {
  gLightNoShadow = true;   // capsule shadows on a liquid highlight aren't worth their loop
  int ZERO = min(int(uFrame), 0);
  vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
  gAnchor = uSpheres[0].xyz;
  float k = uShape.x, pad = uShape.y + uShape.z * BUBBLE_H;
  float pxs = 2.0 / (projectionMatrix[1][1] * uResolution.y);   // pixel footprint per metre of distance

  // opaque depth bounds the march: writing gl_FragDepth turns early-z off, so this is the only
  // cull for blobs behind walls
  vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float cosV = max(dot(rd, fwd), 1e-4);
  float tScene = linearDepth(texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r) / cosV;

  // the proxy boxes overlap (neighbours share a sphere, and a whip seen end-on stacks them): every
  // box would march the whole ray to the same result, so the lowest-numbered box the ray crosses
  // takes the pixel. Tested 0.1% shrunk, so a pixel on a box edge is kept twice, never dropped.
  for (int j = 0; j < vBox; j++) {
    vec3 lo = (uBoxInv[j] * vec4(ro, 1.0)).xyz, ld = (uBoxInv[j] * vec4(rd, 0.0)).xyz;
    vec3 il = 1.0 / (ld + 1e-12), ta = (-0.999 - lo) * il, tb = (0.999 - lo) * il, tn = min(ta, tb), tf = max(ta, tb);
    float tN = max(max(tn.x, tn.y), tn.z), tF = min(min(tf.x, tf.y), tf.z);
    if (tF > tN && tF * cosV > uNearFar.x) discard;
  }

  // one ray test per sphere against three shells:
  //   r + k + pad          its blend reach: in the list. smin is plain min beyond k, so a sphere
  //                        whose reach the ray misses can't shape the surface this ray sees
  //   r + 0.3k + pad + 2px smin bulges k/4 past two equal spheres, so the surface and its
  //                        antialiased fringe lie inside these: the march range (rays missing all
  //                        of them discard here). ponytail: three near-equal spheres bulge 0.39 k
  //                        and get clipped by a few mm in that crease; SHELL 0.5 if it ever shows.
  //   r + k/4              the liquid chord: thickness runs to the exit of the farthest one crossed
  float t0 = 1e9, t1 = 0.0, tExit = 0.0;
  gList = uvec2(0u);
  gN = 0;
  for (int g = 0; g < NG; g++) {
   if (g * 4 >= uCount) break;
   // a group of 4 the ray misses skips 4 tests (a whip ray is near 1-2 of its 4 groups)
   vec4 G = uGroups[g];
   vec3 og = G.xyz - ro;
   float bg = dot(og, rd), Rg = G.w + k + pad + 2.0 * pxs * max(bg, 0.0);
   if (dot(og, og) - bg * bg >= Rg * Rg) continue;
   for (int i = g * 4; i < g * 4 + 4; i++) {
    if (i >= uCount) break;
    vec4 s = uSpheres[i];
    vec3 oc = s.xyz - ro;
    float b = dot(oc, rd), c = dot(oc, oc) - b * b;   // squared distance ray -> centre
    float R = s.w + k + pad;
    if (c >= R * R) continue;
    if (gN < 8) gList.x |= uint(i) << uint(gN * 4); else gList.y |= uint(i) << uint((gN - 8) * 4);
    gN++;
    R = s.w + SHELL * k + pad + 2.0 * pxs * max(b, 0.0);
    float h = R * R - c;
    if (h <= 0.0) continue;
    h = sqrt(h);
    t0 = min(t0, b - h);
    t1 = max(t1, b + h);
    R = s.w + 0.25 * k;
    h = R * R - c;
    if (h > 0.0) tExit = max(tExit, b + sqrt(h));
   }
  }
  t0 = max(t0, 0.0);
  t1 = min(t1, tScene);
  if (uMetaDebug > 1.5 && uMetaDebug < 2.5) { gl_FragDepth = gl_FragCoord.z; fragColor = vec4(0.03, 0.0, 0.05, 1.0); return; }
  if (t0 >= t1) discard;

  // sphere trace. Far from the blob (base > 2 pad) the undisplaced SDF minus pad is an exact bound
  // and skips the detail. Near it the displacement D is cached: evaluated on arrival and again
  // wherever the cached value says we're on the surface (it varies over ~1 m, so it barely moves
  // across the last few cm; ~2 evaluations per ray instead of one per step). Steps are relaxed by
  // the displacement's Lipschitz bound.
  float relax = 1.0 / (1.0 + 7.2 * uShape.y + 0.55 * uShape.z);
  float t = t0, best = 1e9, tBest = t0, D = 0.0, tP = t0, dP = 1e9;
  int steps = 0;
  bool hit = false, haveD = false;
  for (int i = ZERO; i < uSteps; i++) {
    steps = i + 1;
    vec3 p = ro + rd * t;
    float b = base(p), px = t * pxs;
    bool far = b > 2.0 * pad;
    if (!far && !haveD) { D = detail(p); haveD = true; }
    float d = far ? b - pad : b - D;
    // the bar rises with the steps taken: grazing rays creep along the surface, so they stop
    // within a pixel or two of it instead of spending the whole budget
    float bar = (HIT_PX + float(i) * 0.03125) * px;
    if (!far && d < bar) { D = detail(p); d = b - D; }   // confirm with the displacement here
    if (!far && d < 0.0 && dP < 1e8) { t -= (t - tP) * -d / (dP - d); hit = true; break; }   // crossed: interpolate
    if (d < best * px) { best = d / px; tBest = t; }
    if (d < bar) { hit = true; break; }
    // near the surface d falls almost linearly along the ray, so the secant through the last two
    // samples lands close to the root: up to 3 safe radii per step (~30% fewer steps); an overshoot
    // through the surface is caught by the line above
    float r = far ? d : max(d * relax, b - pad);
    if (!far && dP < 1e8 && dP > d) r = clamp(d * (t - tP) / (dP - d), r, 3.0 * r);
    tP = t;
    dP = far ? 1e9 : d;
    t += r;
    if (t > t1) break;
  }
  // a miss that grazed within a pixel keeps partial coverage (alpha-to-coverage -> MSAA edge)
  float cov = hit ? 1.0 : 1.0 - smoothstep(HIT_PX, HIT_PX + 1.0, best);
  if (uMetaDebug > 4.5) { gl_FragDepth = gl_FragCoord.z; fragColor = vec4(float(steps), float(gN), cov, 1.0); return; }
  if (uMetaDebug > 0.5 && uMetaDebug < 1.5) {
    float s = float(steps) / float(uSteps);
    gl_FragDepth = gl_FragCoord.z;
    fragColor = vec4(vec3(s, 1.0 - abs(s * 2.0 - 1.0), 1.0 - s) * 2.0 * max(cov, 0.15), 1.0);
    return;
  }
  if (cov < 0.01) discard;

  // analytic normal: smooth union + wobble + blister + ripple gradients (ripples fade once a pixel
  // spans a good part of their ~0.3 m wavelength, so they never shimmer as aliasing)
  float tHit = hit ? t : tBest, px = tHit * pxs, glow = 0.0;
  vec3 p = ro + rd * tHit, q = p - gAnchor, gb = baseGrad(p), gbl = vec3(0.0);
  if (uShape.z > 0.0) blister(q, gbl, glow);
  float rip = uShape.y * 0.25 * (1.0 - smoothstep(0.004, 0.03, px));
  vec3 n = normalize(gb - uShape.y * wobbleGrad(q) - uShape.z * gbl - rip * rippleGrad(q));
  float thick = clamp(tExit - tHit, 0.0, max(tScene - tHit, 0.0));

  vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  if (uMetaDebug > 3.5) { fragColor = vec4(vec3(thick, thick * 0.5, thick * 0.25), cov); return; }
  if (uMetaDebug > 2.5) { fragColor = vec4(1.0, 0.0, 1.0, cov); return; }

  // --- shading ------------------------------------------------------------------------
  vec3 v = -rd;
  float NoV = max(dot(n, v), 0.0);
  float rough = uOptics.y;
  float F = fresnelRough(NoV, 0.02, rough);
  vec3 refl = envReflect(reflect(rd, n), rough);
  // sun: GGX, alpha floored so the disc acts as a small area light (UW)
  float aS = max(rough * rough, 0.015);
  vec3 H = normalize(uSunDir + v);
  float NoL = max(dot(n, uSunDir), 0.0);
  vec3 spec = uSunColor * (PI * spellD_GGX(max(dot(n, H), 0.0), aS) * spellV_Smith(max(NoV, 1e-4), NoL, aS) * NoL * fresnel(dot(v, H), 0.02));
  vec3 dSpell, sSpell;
  spellLightPBR(p, n, v, max(rough, 0.06), vec3(0.02), uScatter, dSpell, sSpell);
  spec += sSpell;

  // body: the scene through the liquid, absorbed over the thickness, plus in-scatter of the sky,
  // sun and spell lights; forward scatter glows looking into the sun (UW's crest SSS)
  float behind;
  vec3 refr = sceneRefract(p, n, v, uOptics.x, thick * uOptics.z, behind);
  vec3 T = beerLambert(uAbsorption + uTurbidity, thick);
  float fwdS = pow(clamp(dot(rd, uSunDir), 0.0, 1.0), 12.0);
  vec3 inscatter = uScatter * (uAmbient + uSunColor * (max(uSunDir.y, 0.0) + 1.5 * fwdS)) + dSpell;
  vec3 body = refr * T + inscatter * (1.0 - T);

  // acid: a glowing core swirling inside the body (noise at two depths along the ray, so it has
  // parallax), concentrated where thick and dimming to a dark corroded skin at the silhouette;
  // blisters flare as they pop. Contrast keeps it saturated under AgX instead of a flat pastel.
  float edge = smoothstep(0.05, 0.6, NoV);
  vec3 emit = vec3(0.0);
  if (dot(uEmission, uEmission) > 0.0) {
    vec3 qs = q + vec3(0.0, uTime * 0.06, 0.0);
    float swirl = noise3((qs + rd * thick * 0.3) * 0.7) * 0.6 + noise3((qs + rd * thick * 0.7) * 1.3 + 0.5) * 0.4;
    float core = 1.0 - exp(-thick * 2.0);
    emit = uEmission * (core * core * (0.1 + 2.5 * swirl * swirl) * mix(1.0, edge * edge, uShape.w) + glow * uShape.z * 4.0);
  }
  body *= mix(1.0, 0.25 + 0.75 * edge, uShape.w);

  // thin bright rim at the silhouette: sky + sun for water, the own glow for acid
  float rim = pow(1.0 - NoV, 5.0) * uOptics.w;
  vec3 col = mix(body, refl, F) + spec + emit + rim * mix(uAmbient + uSunColor * 0.3, uEmission * 0.8, uShape.w);
  fragColor = vec4(col, cov);
}`;

const _u = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0), RIGHT = new THREE.Vector3(1, 0, 0);

// Oriented box around spheres first..last (d = [x, y, z, r] per sphere), inflated by pad, written
// into m as the BoxGeometry(2, 2, 2) -> world matrix. x runs along the chain (first -> last), y
// towards the middle sphere (the bend), z normal to both: a curve fills it far better than an AABB.
export function fitBox(d, first, last, pad, m) {
  const f = first * 4, l = last * 4, mid = ((first + last) >> 1) * 4;
  _u.set(d[l] - d[f], d[l + 1] - d[f + 1], d[l + 2] - d[f + 2]);
  if (_u.lengthSq() < 1e-10) _u.set(1, 0, 0); else _u.normalize();
  _v.set(d[mid] - d[f], d[mid + 1] - d[f + 1], d[mid + 2] - d[f + 2]);
  _v.addScaledVector(_u, -_v.dot(_u));
  if (_v.lengthSq() < 1e-10) _v.crossVectors(_u, Math.abs(_u.y) < 0.9 ? UP : RIGHT);
  _v.normalize();
  _w.crossVectors(_u, _v);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (let i = f; i <= l; i += 4) {
    const x = d[i], y = d[i + 1], z = d[i + 2], r = d[i + 3] + pad;
    const pu = x * _u.x + y * _u.y + z * _u.z, pv = x * _v.x + y * _v.y + z * _v.z, pw = x * _w.x + y * _w.y + z * _w.z;
    a0 = Math.min(a0, pu - r); a1 = Math.max(a1, pu + r);
    b0 = Math.min(b0, pv - r); b1 = Math.max(b1, pv + r);
    c0 = Math.min(c0, pw - r); c1 = Math.max(c1, pw + r);
  }
  const cu = (a0 + a1) / 2, cv = (b0 + b1) / 2, cw = (c0 + c1) / 2;
  const hu = (a1 - a0) / 2, hv = (b1 - b0) / 2, hw = (c1 - c0) / 2;
  m.set(
    _u.x * hu, _v.x * hv, _w.x * hw, _u.x * cu + _v.x * cv + _w.x * cw,
    _u.y * hu, _v.y * hv, _w.y * hw, _u.y * cu + _v.y * cv + _w.y * cw,
    _u.z * hu, _v.z * hv, _w.z * hw, _u.z * cu + _v.z * cv + _w.z * cw,
    0, 0, 0, 1,
  );
}

// How many boxes a chain gets: its path length over twice its thickness (a whip: 3-4 boxes hugging
// its curve; an orb whose satellites circle a core: 1). Boxes overlap by one sphere; a pixel goes to
// the first box its ray crosses, which marches the whole ray: no seams. More boxes fit tighter but
// cost more in that test (measured: 6 boxes on the whip were slower than 3).
function boxCount(d, n, pad) {
  let path = 0, rMax = 0;
  for (let i = 0; i < n * 4; i += 4) {
    rMax = Math.max(rMax, d[i + 3]);
    if (i) path += Math.hypot(d[i] - d[i - 4], d[i + 1] - d[i - 3], d[i + 2] - d[i - 2]);
  }
  return Math.max(1, Math.min(MAX_BOXES, n - 1, Math.round(path / (4 * (rMax + pad)))));
}

// bounding sphere of each 4 consecutive spheres: [x, y, z, r] per group (centre = mean)
function groupBounds(d, n, out) {
  for (let g = 0; g * 4 < n; g++) {
    const a = g * 16, e = Math.min(n, g * 4 + 4) * 4, c = e / 4 - g * 4;
    let x = 0, y = 0, z = 0, r = 0;
    for (let i = a; i < e; i += 4) { x += d[i] / c; y += d[i + 1] / c; z += d[i + 2] / c; }
    for (let i = a; i < e; i += 4) r = Math.max(r, Math.hypot(d[i] - x, d[i + 1] - y, d[i + 2] - z) + d[i + 3]);
    out[g * 4] = x; out[g * 4 + 1] = y; out[g * 4 + 2] = z; out[g * 4 + 3] = r;
  }
}

function applyPreset(h, name) {
  const p = METABALL_PRESETS[name] ?? METABALL_PRESETS.water;
  h.absorption.fromArray(p.absorption);
  h.scatterColor.fromArray(p.scatterColor);
  h.emission.fromArray(p.emission);
  for (const k of ['k', 'wobble', 'bubbles', 'corrosion', 'ior', 'roughness', 'refraction', 'rim', 'turbidity']) h[k] = p[k];
}

export class Metaballs {
  constructor({ max = 4, spheres = 16 } = {}) {
    if (spheres > 16) throw new Error('Metaballs: at most 16 spheres (4-bit per-ray sphere list)');
    this.spheres = spheres;
    this.group = new THREE.Group();   // add to the refract scene; keep it at the identity
    this.steps = { value: 32 };
    this.debug = { value: 0 };        // 1 step heat map, 2 proxy boxes, 3 flat coverage, 4 thickness, 5 stats
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    const fragmentShader = frag(spheres);
    this.data = new Float32Array(spheres * 4 * max);
    this.tex = new THREE.DataTexture(this.data, spheres, max, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter;
    const sphereTex = { value: this.tex };
    this.handles = Array.from({ length: max }, (_, row) => {
      const data = this.data.subarray(row * spheres * 4, (row + 1) * spheres * 4);
      const uniforms = {
        ...U,
        uSpheres: { value: data }, uSphereTex: sphereTex, uRow: { value: row }, uCount: { value: 0 },
        uGroups: { value: new Float32Array((spheres + 3 >> 2) * 4) },
        uBoxInv: { value: Array.from({ length: MAX_BOXES }, () => new THREE.Matrix4()) },
        uShape: { value: new THREE.Vector4() }, uOptics: { value: new THREE.Vector4() },
        uAbsorption: { value: new THREE.Color() }, uTurbidity: { value: 0 }, uScatter: { value: new THREE.Color() }, uEmission: { value: new THREE.Color() },
        uSteps: this.steps, uMetaDebug: this.debug,
      };
      const mesh = new THREE.InstancedMesh(geometry, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms, vertexShader: VERT, fragmentShader,
        side: THREE.BackSide, alphaToCoverage: true,
      }), MAX_BOXES);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;   // boxes move every frame; an off-screen draw rasterizes nothing
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      this.group.add(mesh);
      const h = {
        mesh, data, active: false, count: 0, visible: true, intensity: 1,
        absorption: new THREE.Color(), scatterColor: new THREE.Color(), emission: new THREE.Color(),
        set(i, x, y, z, r) { const o = i * 4; data[o] = x; data[o + 1] = y; data[o + 2] = z; data[o + 3] = r; },
        release() { h.active = false; mesh.visible = false; },
      };
      applyPreset(h, 'water');
      return h;
    });
  }

  // preset: 'water' | 'acid'. Returns null when every handle is in use.
  acquire({ preset = 'water' } = {}) {
    const h = this.handles.find((x) => !x.active);
    if (!h) return null;
    applyPreset(h, preset);
    Object.assign(h, { active: true, visible: true, count: 0, intensity: 1 });
    return h;
  }

  // once per frame, after the spells set their spheres and before the refract pass
  update() {
    this.tex.needsUpdate = true;   // 1 KB
    this.steps.value = Math.max(8, Math.min(32, Math.round(32 * Q.volumeSteps / 24 * (Q.auto?.steps ?? 1))));
    const e = Q.emission * (Q.auto?.emission ?? 1);
    for (const h of this.handles) {
      const m = h.mesh, n = Math.min(h.count, this.spheres);
      m.visible = h.active && h.visible && n > 0;
      if (!m.visible) continue;
      const u = m.material.uniforms;
      u.uCount.value = n;
      u.uShape.value.set(h.k, h.wobble, h.bubbles, h.corrosion);
      u.uOptics.value.set(h.ior, h.roughness, h.refraction, h.rim * h.intensity);
      u.uAbsorption.value.copy(h.absorption);
      u.uTurbidity.value = h.turbidity;
      u.uScatter.value.copy(h.scatterColor);
      u.uEmission.value.copy(h.emission).multiplyScalar(h.intensity * e);
      // the march shell + the AA fringe (2 px up to ~20 m at 3.3 MP)
      const pad = h.k * SHELL + h.wobble + h.bubbles * BUBBLE_H + 0.03, boxes = boxCount(h.data, n, pad);
      for (let b = 0; b < boxes; b++) {
        fitBox(h.data, Math.floor(b * (n - 1) / boxes), Math.floor((b + 1) * (n - 1) / boxes), pad, _m);
        m.setMatrixAt(b, _m);
        u.uBoxInv.value[b].copy(_m).invert();
      }
      groupBounds(h.data, n, u.uGroups.value);
      m.count = boxes;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.tex.dispose();
    this.handles[0]?.mesh.geometry.dispose();
    for (const h of this.handles) h.mesh.material.dispose();
  }
}

// every sphere's extreme points must land inside its fitted box, every sphere inside its group's
// bound (dev/metaballs.js runs this)
export function metaballsSelfCheck() {
  const d = new Float32Array(16 * 4), gb = new Float32Array(16), m = new THREE.Matrix4(), inv = new THREE.Matrix4(), p = new THREE.Vector3();
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let trial = 0; trial < 50; trial++) {
    const n = 1 + (trial % 16);
    for (let i = 0; i < n * 4; i++) d[i] = i % 4 === 3 ? 0.05 + rnd() * 0.4 : (rnd() - 0.5) * (trial % 3 ? 6 : 0.01);
    fitBox(d, 0, n - 1, 0.02, m);
    inv.copy(m).invert();
    for (let i = 0; i < n; i++) for (let a = 0; a < 6; a++) {
      const s = a & 1 ? -1 : 1, r = d[i * 4 + 3];
      p.set(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]).setComponent(a >> 1, d[i * 4 + (a >> 1)] + s * r).applyMatrix4(inv);
      if (Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)) > 1 + 1e-4) throw new Error(`fitBox: sphere ${i} of ${n} pokes out (${p.toArray().map((x) => x.toFixed(3))})`);
    }
    groupBounds(d, n, gb);
    for (let i = 0; i < n; i++) {
      const o = i * 4, g = (i >> 2) * 4;
      if (Math.hypot(d[o] - gb[g], d[o + 1] - gb[g + 1], d[o + 2] - gb[g + 2]) + d[o + 3] > gb[g + 3] + 1e-4) throw new Error(`groupBounds: sphere ${i} of ${n} outside its group`);
    }
  }
  return 'metaballs ok: fitBox and groupBounds hold 50 random chains';
}
