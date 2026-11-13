import * as THREE from 'three';
import { ARENA, arenaRaycast, COMMON_GLSL, NOISE_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING } from '../vfx/common.js';
import { arenaUniforms } from '../scene/arenaMaterial.js';

// Light (PLAN 3). Judgment, matched against crepuscular rays through a storm shelf and film "wrath
// of god" shots: a storm deck races out from over the target and the sun goes (a raymarched slab of
// cloud with a billowed underside, dimming the shared sun and sky light); it spins, a hole tears open
// in it and blazes, a thin ray drops through, then the shaft slams open. The shaft is two volumes: a
// wide sheath of dust lit through the cloud gaps (god-ray blades diverging from the hole, a rolling
// 3D dust field, HG in-scatter) and a kernel of braided plasma lanes racing down it (structure, not a
// clipped stripe), plus full-res helical threads. The light itself hits the arena: one shadowed point
// light on the axis (hard capsule shadows off every pillar and dummy), the deck lit from its hole.
// Impact: an air and a ground shock, a force shell, a rolling dust ring lit from inside, rock thrown,
// molten spatter, the floor fractured and glowing (ground-field heat, crack, char, magma impacts).
// Radiant Lance: a held beam from the focus: a full-res core ribbon, the same volume as a soft
// sheath, motes streaming along it, a contact flare, glow splats where it lands, a line light.

// shape +y = the direction the light travels; pl.xz is the cross-section (|pl.xz| = 1 at radius)
const HALO = 1.6;          // proxy radius / beam radius
const BEAM_GLSL = /* glsl */`
#define HALO ${HALO.toFixed(2)}
uniform vec4 uBeam;      // radiance per metre, god-ray contrast, HG g, head (m from the source)
uniform vec4 uBeam2;     // radius m, length m (source -> contact), source fade (fraction), contact flare
uniform vec3 uBeamSrc;
uniform vec3 uBeamDir;
uniform vec3 uBeamCore;
uniform vec3 uBeamGlow;
uniform vec4 uOccA[4];   // occluders crossing the beam: a.xyz, radius
uniform vec4 uOccB[4];   // b.xyz, -
uniform float uOccN;
uniform float uBeamSeed;
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  // pure emission. sigma stays under the integrator's 1e-4 'occupied' test but isn't a literal 0:
  // fxc folds the dead e / sigma branch and warns about a division by zero
  sigma = 1e-6 * uBeam2.x; albedo = vec3(0.0); emission = vec3(0.0);
  // the proxy is HALO x wider than the beam: r is in beam radii, the rim beyond 1 is a soft halo
  float R = uBeam2.x, L = uBeam2.y;
  float r = length(pl.xz) * uVolScale.x / R;
  if (r >= HALO) return;
  float s = dot(pw - uBeamSrc, uBeamDir);
  // cross-section in metres, turning slowly; streaks keep their size while the pillar slams open
  float a = uTime * 0.13;
  vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * (pl.xz * uVolScale.x);
  // god rays: noise over the cross-section, stretched ~100x along the axis, pouring downstream
  vec4 n = noise3v(vec3(q * 0.42, s * 0.006 - uTime * 0.045) + uBeamSeed);
  float rays = clamp((n.r * 0.6 + n.b * 0.4) * 2.0 - 0.55, 0.0, 1.0);
  rays = mix(1.0, 0.18 + 1.7 * rays * rays, uBeam.y);
  float body = (0.55 + 0.45 * exp(-r * r * 3.0)) * smoothstep(1.0, 0.55, r)
             + 0.2 * exp(-max(r - 0.6, 0.0) * 3.0) * smoothstep(HALO, HALO - 0.3, r);
  float core = exp(-r * r * 30.0);
  float along = smoothstep(0.0, uBeam2.z, s / L) * smoothstep(uBeam.w, uBeam.w - 0.8, s)
              * smoothstep(L + 0.6 * R, L, s);
  // occluders between this sample and the source shadow it (capsule vs light path, soft edge)
  float vis = 1.0;
  int no = int(uOccN);
  for (int i = 0; i < 4; i++) {
    if (i >= no) break;
    float sp, d = segSegDist(pw, pw - uBeamDir * max(s, 0.0), uOccA[i].xyz, uOccB[i].xyz, sp);
    // near-parallel light: a fixed soft edge (the closest-point parameter is unstable when the
    // light path runs along a capsule, so it can't drive the penumbra)
    vis *= smoothstep(uOccA[i].w - 0.03, uOccA[i].w + 0.08, d);
  }
  // HG in-scatter of the beam's own light towards the eye, normalised to 1 seen side-on. Looking
  // down a long column the chord grows ~L/R; ease that back (taste, not physics)
  float mu = dot(uBeamDir, normalize(cameraPosition - pw));
  float g = uBeam.z, g2 = g * g;
  float phase = pow((1.0 + g2) / max(1.0 + g2 - 2.0 * g * mu, 1e-3), 1.5) / (1.0 + 5.0 * mu * mu * mu * mu);
  // flare where the light lands
  vec3 dc = pw - uBeamSrc - uBeamDir * L;
  float flare = uBeam2.w * exp(-dot(dc, dc) / (R * R * 0.3)) * step(s, uBeam.w + 0.01);
  float e = (body * rays + core * 1.4) * along * vis * phase + flare;
  emission = mix(uBeamGlow, uBeamCore, clamp(core * 1.3 + flare * 0.5, 0.0, 1.0)) * (e * uBeam.x);
}`;

// full-res core: a straight strip, p0 = (source, width), p1 = (end, -),
// p2 = (seed, length m, source fade fraction, head m)
const CORE_PATH = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  width = p0.w;
  return mix(p0.xyz, p1.xyz, t);
}`;
const CORE_SHADE = /* glsl */`
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
  float y = r.uv.y, s = r.uv.x * r.p2.y;
  float hot = exp(-y * y * 22.0), soft = exp(-y * y * 3.5) * 0.3;
  // energy racing along the beam
  float flow = 0.82 + 0.18 * sin(s * 2.7 - uTime * 40.0 + r.p2.x) * sin(s * 1.1 - uTime * 21.0 + r.p2.x * 1.7);
  float k = smoothstep(0.0, r.p2.z, r.uv.x) * smoothstep(r.p2.w, r.p2.w - 0.5, s);
  vec3 c = r.color;
  float peak = max(c.r, max(c.g, c.b));
  return (mix(c, vec3(peak), 0.65) * hot + c * soft) * flow * k;
}`;

// Judgment's kernel: braided plasma lanes. Same uniforms as BEAM_GLSL (placeBeam fills them)
const KERNEL_GLSL = /* glsl */`
#define HALO ${HALO.toFixed(2)}
uniform vec4 uBeam;      // radiance per metre, lane contrast, HG g, head (m from the source)
uniform vec4 uBeam2;     // radius m, length m, -, contact flare
uniform vec3 uBeamSrc;
uniform vec3 uBeamDir;
uniform vec3 uBeamCore;
uniform vec3 uBeamGlow;
uniform vec4 uOccA[4];
uniform vec4 uOccB[4];
uniform float uOccN;
uniform float uBeamSeed;
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  sigma = 1e-6 * uBeam2.x; albedo = vec3(0.0); emission = vec3(0.0);
  float R = uBeam2.x, L = uBeam2.y;
  float r = length(pl.xz) * uVolScale.x / R;
  if (r >= HALO) return;
  float s = dot(pw - uBeamSrc, uBeamDir);
  float along = smoothstep(0.0, 1.5, s) * smoothstep(uBeam.w, uBeam.w - 0.8, s) * smoothstep(L + 0.6 * R, L, s);
  if (along <= 0.0) return;
  // lanes: a twisting cross-section, stretched ~30x along the axis and pouring downstream
  float a = s * 0.2 + uTime * 1.1, ca = cos(a), sa = sin(a);
  vec2 q = mat2(ca, -sa, sa, ca) * (pl.xz * uVolScale.x);
  vec4 n = noise3v(vec3(q * 0.42, s * 0.022 - uTime * 0.7) + uBeamSeed);
  float lane = 1.0 - abs(2.0 * n.r - 1.0);
  lane *= lane * lane;
  // knots of brighter plasma racing down the lanes
  float knot = noise3(vec3(q * 0.16, s * 0.05 - uTime * 2.1) + uBeamSeed * 1.7);
  float lanes = mix(1.0, 0.16 + 3.4 * lane * (0.35 + 1.6 * knot), uBeam.y);
  float env = exp(-r * r * 2.0) * smoothstep(HALO, 0.75, r);
  float hot = exp(-r * r * 7.0);
  // occluders between this sample and the source shadow it
  float vis = 1.0;
  int no = int(uOccN);
  for (int i = 0; i < 4; i++) {
    if (i >= no) break;
    float sp, d = segSegDist(pw, pw - uBeamDir * max(s, 0.0), uOccA[i].xyz, uOccB[i].xyz, sp);
    vis *= smoothstep(uOccA[i].w - 0.03, uOccA[i].w + 0.08, d);
  }
  float mu = dot(uBeamDir, normalize(cameraPosition - pw));
  float g = uBeam.z, g2 = g * g;
  float phase = pow((1.0 + g2) / max(1.0 + g2 - 2.0 * g * mu, 1e-3), 1.5) / (1.0 + 5.0 * mu * mu * mu * mu);
  vec3 dc = pw - uBeamSrc - uBeamDir * L;
  float flare = uBeam2.w * exp(-dot(dc, dc) / (R * R * 0.5)) * step(s, uBeam.w + 0.01);
  float e = (env * (0.2 + 0.8 * lanes) + hot * lanes * 0.9) * along * vis * phase + flare;
  // amber in the thin gas, white only in the hottest lanes
  emission = mix(uBeamGlow, uBeamCore, clamp(hot * lanes * 0.75 + flare * 0.4 + 0.15, 0.0, 1.0)) * (e * uBeam.x);
}`;

// Judgment's sheath: dust in the light that gets through the cloud gaps. Pure in-scatter, so it costs
// two noise taps a sample and never occludes the world. The fan spreads from the hole: the
// cross-section is normalised by the local radius, so each blade is a true diverging ray.
const SHEATH_GLSL = /* glsl */`
#define HALO ${HALO.toFixed(2)}
uniform vec4 uBeam;      // radiance per metre, ray contrast, HG g, head (m from the source)
uniform vec4 uBeam2;     // radius m (x HALO = outer edge), length m, dust boil at the floor 0..1, -
uniform vec3 uBeamSrc;
uniform vec3 uBeamDir;
uniform vec3 uBeamCore;
uniform vec3 uBeamGlow;
uniform float uBeamSeed;
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  sigma = 1e-6 * uBeam2.x; albedo = vec3(0.0); emission = vec3(0.0);
  float R = uBeam2.x * HALO, L = uBeam2.y;
  float s = dot(pw - uBeamSrc, uBeamDir), k = clamp(s / L, 0.0, 1.0);
  float Rz = R * (0.42 + 0.58 * k);
  vec2 q = pl.xz * uVolScale.x / Rz;
  float r = length(q);
  if (r >= 1.0) return;
  float along = smoothstep(0.0, 0.05, k) * smoothstep(uBeam.w, uBeam.w - 1.0, s) * smoothstep(L + 0.5, L, s);
  if (along <= 0.0) return;
  // the gaps in the cloud: two scales of blade, nearly frozen, they only slide as the deck turns
  vec4 n = noise3v(vec3(q * 0.34 + uBeamSeed, uTime * 0.03));
  float blades = smoothstep(0.32, 0.72, n.r * 0.7 + n.g * 0.3);
  blades = mix(1.0, 0.03 + 1.7 * blades * blades, uBeam.y);
  // dust: rolling, falling, bunched: fades out where the march can't resolve it
  vec3 dp = pw * 0.2 + vec3(0.13 * sin(pw.y * 0.4 + uTime * 0.5), uTime * 0.2, 0.0) + uBeamSeed;
  float dust = noise3(dp);
  dust = 0.12 + 2.5 * dust * dust + uBeam2.z * 1.8 * exp(-(L - s) * 0.5) * smoothstep(0.25, 0.7, dust);
  float body = smoothstep(1.0, 0.62, r) * (0.3 + 0.7 * exp(-r * r * 2.6));
  float mu = dot(uBeamDir, normalize(cameraPosition - pw));
  float g = uBeam.z, g2 = g * g;
  float phase = pow((1.0 + g2) / max(1.0 + g2 - 2.0 * g * mu, 1e-3), 1.5) / (1.0 + 3.0 * mu * mu * mu * mu);
  emission = mix(uBeamGlow, uBeamCore, exp(-r * r * 5.0) * 0.55) * (body * blades * dust * along * phase * uBeam.x);
}`;

// full-res helical threads wound round the kernel: p0 = source, width; p1 = end, seed;
// p2 = helix radius, twist rad/m, -, head m; p3 = spin rad/s, length m, -, -
const THREAD_PATH = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  vec3 ax = p1.xyz - p0.xyz, dir = ax / max(p3.y, 1e-3);
  mat3 B = basisFrom(dir);
  float s = t * p3.y, seed = p1.w;
  float ph = s * p2.y + seed * 6.283 + uTime * p3.x;
  float rr = p2.x * (0.5 + 0.4 * sin(s * 0.41 + seed * 5.0 + uTime * 2.3) + 0.1 * sin(s * 1.7 - uTime * 8.0 + seed * 9.0));
  width = p0.w * (0.6 + 0.4 * sin(s * 0.9 + seed * 3.0 - uTime * 5.0));
  return p0.xyz + ax * t + (B[0] * cos(ph) + B[1] * sin(ph)) * rr;
}`;
const THREAD_SHADE = /* glsl */`
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
  float y = r.uv.y, s = r.uv.x * r.p3.y;
  float prof = exp(-y * y * 5.0);
  float flow = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(s * 1.3 - uTime * 34.0 + r.p1.w * 19.0) * sin(s * 0.37 - uTime * 11.0 + r.p1.w * 7.0), 2.0);
  float k = smoothstep(0.5, 3.0, s) * smoothstep(r.p2.w, r.p2.w - 0.5, s);
  return r.color * prof * flow * k;
}`;

// the storm deck: a slab of cloud raymarched from its underside (half-res, one quad). Lit from the
// hole with one shadow tap towards it; the sky behind it is hidden, the bright horizon band under
// the deck stays (the shelf-cloud look). Nothing else writes the sun: see stormApply.
const DECK_VERT = FX_VERT_HEAD + /* glsl */`
out vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const DECK_FRAG = FX_FRAG_HEAD + '#define texture(s, p) textureLod(s, p, 0.0)\n' + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + /* glsl */`
uniform vec4 uDeck;      // base y, thickness, cover 0..1, front radius m
uniform vec4 uDeck2;     // spin angle rad (integrated), drift, steps, -
uniform vec2 uDeckC;     // swirl centre xz
uniform vec4 uHole[2];   // x, z, radius m, light
uniform vec3 uDeckLit;
uniform vec3 uDeckHot;
uniform vec3 uDeckDark;
in vec3 vW;
float deckD(vec3 p) {
  vec2 dv = p.xz - uDeckC;
  float rc = length(dv), a = uDeck2.x / (1.0 + rc * 0.085), ca = cos(a), sa = sin(a);
  vec2 q = vec2(ca * dv.x - sa * dv.y, sa * dv.x + ca * dv.y) + uDeckC;
  float h = (p.y - uDeck.x) / uDeck.y;
  vec4 n = noise3v(vec3(q * 0.011, uDeck2.y));
  float m = noise3(vec3(q * 0.03, h * 0.12 + uDeck2.y * 1.7));
  float d = n.r * 0.5 + m * 0.62 - 0.56 + (h - 0.5) * 1.05;
  d += (smoothstep(uDeck.w, uDeck.w - 24.0, rc) * uDeck.z - 1.0) * 1.3;
  for (int i = 0; i < 2; i++) {
    float R = uHole[i].z;
    if (R <= 0.01) continue;
    float r = distance(p.xz, uHole[i].xy), rim = R * (0.72 + 0.6 * n.g);
    d -= (1.0 - smoothstep(rim, rim + 3.5 + 0.35 * R, r)) * 1.4;
  }
  return d;
}
void main() {
  vec3 rd = normalize(vW - cameraPosition);
  if (rd.y < 0.012) discard;
  // stacked horizontal slices, front to back: a sample plane is fixed in the world, so each layer is
  // continuous however far away it is (a march along the ray shows its steps as contour bands)
  int N = int(uDeck2.z);
  float tAll = uDeck.y / rd.y, dt = tAll / float(N);
  vec3 p = vW + rd * (dt * 0.5);
  float T = 1.0, zS = 0.0, zW = 0.0;
  vec3 scat = vec3(0.0);
  // billows finer than the slices (shading only), and the broad light and dark of the storm
  float fine = noise3(vec3(vW.xz * 0.11, uDeck2.y * 3.0)), big = noise3(vec3(vW.xz * 0.007 + 0.3, uDeck2.y * 0.5));
  for (int i = 0; i < 16; i++) {
    if (i >= N || T < 0.03) break;
    float d = deckD(p);
    if (d > 0.0) {
      float sg = 2.2 * clamp(d * 4.0, 0.0, 1.0);
      float h = clamp((p.y - uDeck.x) / uDeck.y, 0.0, 1.0);
      vec3 lit = vec3(0.0);
      for (int k = 0; k < 2; k++) {
        float I = uHole[k].w;
        if (I <= 0.0) continue;
        vec3 v = vec3(uHole[k].x, uDeck.x + 0.35 * uDeck.y, uHole[k].y) - p;
        float l = length(v), tau = max(deckD(p + v / max(l, 1e-3) * min(2.6, l)), 0.0) * 2.4;
        lit += uDeckLit * (I * (exp(-l / 5.0) * 1.1 + 0.12 * exp(-l / 14.0)) * (exp(-tau) * 0.85 + 0.15));
      }
      vec3 c = (uDeckDark * (1.2 - 1.05 * h) * (0.3 + 1.6 * big) + lit) * (0.7 + 0.6 * fine);
      float tr = exp(-sg * min(dt, 5.0)), a = T * (1.0 - tr);
      scat += a * c;
      zS += a * (dot(p - vW, rd)); zW += a;
      T *= tr;
    }
    p += rd * dt;
  }
  // through the hole: the blaze above the cloud, streaked by angle
  vec3 em = vec3(0.0);
  vec3 pt = vW + rd * tAll;
  for (int k = 0; k < 2; k++) {
    float R = uHole[k].z;
    if (R <= 0.01) continue;
    vec2 dv = pt.xz - uHole[k].xy;
    float l = length(dv), r = l / R, st = noise3(vec3(dv / max(l, 1e-3) * 0.6, uTime * 0.05));
    em += uDeckHot * (uHole[k].w * smoothstep(1.3, 0.15, r) * (0.3 + 1.7 * st * st));
  }
  float far = smoothstep(150.0, 70.0, distance(vW.xz, cameraPosition.xz));
  float alpha = (1.0 - T) * far;
  if (alpha < 0.002 && dot(em, em) < 1e-6) discard;
  vec3 fwd = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float z = dot(vW - cameraPosition, fwd) + (zW > 0.0 ? zS / zW : 0.0) * dot(rd, fwd);
  fxOut(scat / max(1.0 - T, 1e-3), alpha, em * T * far, vec2(0.0), z);
}`;

const SKY = 22;            // m: the shaft's source (above the deck)
const DECK_Y = 13, DECK_H = 8;   // storm deck base, thickness (m); a low ceiling keeps the hole in frame
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _r = new THREE.Vector3(), _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3();
const clamp = THREE.MathUtils.clamp, sstep = THREE.MathUtils.smoothstep;
const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
// reused option objects (the systems copy what they need)
const SPLAT = { x: 0, z: 0, radius: 1, glow: 0, heat: 0, char: 0, crack: 0, pattern: 'radial', seed: 0 };
const SHOCK = { pos: _c, radius0: 0.5, radius1: 7, duration: 0.8, thickness: 0.7, distortion: 0.035, color: null, intensity: 3, ground: true };
const SIGIL = { pos: _a, normal: _b, radius: 1.5, color: null, intensity: 0, reveal: 0, rotation: 0, style: 'holy', seed: 0 };

// distance between segments p1-q1 and p2-q2 (Ericson 5.1.9), for culling occluders to the beam
function segSeg(p1, q1, p2, q2) {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _r.subVectors(p1, p2);
  const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
  let s = 0, t = 0;
  if (a < 1e-9) t = e < 1e-9 ? 0 : clamp(f / e, 0, 1);
  else {
    const c = _d1.dot(_r);
    if (e < 1e-9) s = clamp(-c / a, 0, 1);
    else {
      const b = _d1.dot(_d2), den = a * e - b * b;
      s = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return _c1.copy(p1).addScaledVector(_d1, s).distanceTo(_c2.copy(p2).addScaledVector(_d2, t));
}

export default {
  id: 'light', name: 'Light', key: '8', hue: '#ffe08a',
  shape: 'beam', formShapes: { Judgment: 'strike' }, forms: ['Judgment', 'Radiant Lance'],
  params: { intensity: 1, width: 2, sigil: 1.5, tilt: 18, rays: 0.85, scatter: 0.35, motes: 1, feathers: 1, glow: 1, storm: 1, dust: 1, molten: 1, lance: 0.6, core: '#fff4dc', color: '#ffb84a' },
  ranges: {
    intensity: [0, 3, 0.01], width: [0.5, 4, 0.01], sigil: [0.6, 3, 0.01], tilt: [0, 25, 0.1], rays: [0, 1, 0.01],
    scatter: [0, 0.9, 0.01], motes: [0, 3, 0.01], feathers: [0, 3, 0.01], glow: [0, 3, 0.01], storm: [0, 1, 0.01], dust: [0, 3, 0.01], molten: [0, 3, 0.01], lance: [0.2, 1.5, 0.01],
  },
  presets: {
    dawn: { core: '#fff0e8', color: '#ff8a5c', tilt: 16, rays: 0.9 },
    seraphic: { core: '#ffffff', color: '#bcd4ff', intensity: 1.25, feathers: 2.2, scatter: 0.5 },
    'solar flare': { core: '#fff3c0', color: '#ff9a12', width: 3.2, intensity: 1.5, rays: 1, motes: 1.8 },
  },
  // per form in phase('charge'); sustain is the lance's minimum channel time
  timing: { charge: 1.3, impact: 0.55, linger: 3.4, sustain: 2 },
  kinds: {
    mote: { style: 'glow', drag: 1.3, buoyancy: 1.5, curl: 1.1, curlScale: 0.45, forceResponse: 0.7, life: [1.6, 3.4], size: [0.026, 0.01], stretch: 0.012, emissive: 4.5, color: ['#ffe7b0', '#ffa83a'], alpha: [1, 0], fadeIn: 0.12, fadeOut: 0.45 },
    feather: { style: 'glow', drag: 3, gravity: 0.4, curl: 2.6, curlScale: 1.2, forceResponse: 0.3, life: [2.4, 4.2], size: [0.045, 0.03], stretch: 0.16, emissive: 3.5, color: ['#fffaf0', '#ffe0a0'], alpha: [1, 0], fadeIn: 0.15, fadeOut: 0.35, restitution: 0.05, friction: 0.9 },
    stream: { style: 'glow', drag: 0.5, life: [0.25, 0.6], size: [0.022, 0.006], stretch: 0.03, emissive: 7, color: ['#fff8e6', '#ffb040'], alpha: [1, 0], fadeIn: 0.05, restitution: 0.25, friction: 0.5 },
    spark: { style: 'glow', drag: 0.9, gravity: 5, restitution: 0.35, friction: 0.35, life: [0.3, 0.9], size: [0.024, 0.008], stretch: 0.03, emissive: 9, color: ['#ffffff', '#ffbf50'], alpha: [1, 0] },
    // Judgment: dust caught in the shaft (flecks), the rolling shock ring, loose rock, molten spatter
    fleck: { style: 'glow', drag: 2.2, gravity: 0.15, curl: 1.6, curlScale: 0.5, forceResponse: 0.8, life: [0.9, 2.2], size: [0.012, 0.007], emissive: 3, color: ['#fff0d0', '#ffc070'], alpha: [1, 0], fadeIn: 0.25, fadeOut: 0.35 },
    dust: { style: 'media', drag: 3.4, buoyancy: 0.22, curl: 1.8, curlScale: 0.42, life: [1.2, 2.8], size: [0.24, 1.25], sizePow: 0.5, color: ['#6a5f55', '#35302b'], alpha: [0.5, 0], fadeIn: 0.03, fadeOut: 0.55, density: 1.6, erosion: 0.9, lightResponse: 0.07, forceResponse: 0.7, restitution: 0, friction: 0.05 },
    rock: { style: 'debris', mesh: 'rock', gravity: 10.5, drag: 0.1, restitution: 0.3, friction: 0.6, life: [1.8, 3.2], size: [0.055, 0.055], spin: 8, color: ['#14110e', new THREE.Color(0.5, 0.12, 0.02)], alpha: [1, 0.85], fadeOut: 0.14, forceResponse: 0.2 },
    molten: { style: 'glow', drag: 0.45, gravity: 9.8, restitution: 0.2, friction: 0.7, life: [0.5, 1.5], size: [0.03, 0.009], stretch: 0.028, emissive: 6, temp: [2500, 1000], paints: 'heat', paintAmount: 0.05 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const mote = P.emitter('light.mote', { shape: 'disk', radius: 1, spread: 0.6 });
    const ringMote = P.emitter('light.mote', { shape: 'ring', radius: 1.5, spread: 0.25 });
    const gather = P.emitter('light.mote', { shape: 'shell', radius: 1, spread: 0.2, radial: -2.4, life: 0.25 });
    const feather = P.emitter('light.feather', { shape: 'line', radius: 0.8, spread: 0.6 });
    const stream = P.emitter('light.stream', { shape: 'line', radius: 0.12, spread: 0.6 });
    const spark = P.emitter('light.spark', { shape: 'sphere', radius: 0.25, spread: 3, radial: 4 });
    const fleck = P.emitter('light.fleck', { shape: 'line', radius: 1.5, spread: 0.25 });
    const dust = P.emitter('light.dust', { shape: 'ring', radius: 1, spread: 0.4, radial: 11 });
    const rock = P.emitter('light.rock', { shape: 'disk', radius: 1, spread: 2, radial: 4.5 });
    const molten = P.emitter('light.molten', { shape: 'disk', radius: 0.8, spread: 3, radial: 3.5 });

    // colours: parsed only when the param string changes (Color.set allocates)
    const coreCol = new THREE.Color(), glowCol = new THREE.Color(), lightCol = new THREE.Color(), sigCol = new THREE.Color();
    const coreV = new THREE.Vector3(), glowV = new THREE.Vector3(), deckLit = new THREE.Vector3(), deckHot = new THREE.Vector3();
    let coreHex = '', glowHex = '';
    function colours(p) {
      if (p.core === coreHex && p.color === glowHex) return;
      coreHex = p.core; glowHex = p.color;
      coreCol.set(p.core); glowCol.set(p.color);
      coreV.set(coreCol.r, coreCol.g, coreCol.b); glowV.set(glowCol.r, glowCol.g, glowCol.b);
      lightCol.copy(glowCol).lerp(coreCol, 0.4);
      sigCol.copy(glowCol).lerp(coreCol, 0.25);
      deckLit.set(lightCol.r, lightCol.g, lightCol.b);
      deckHot.set(coreCol.r, coreCol.g, coreCol.b);
    }
    SHOCK.color = glowCol;
    SIGIL.color = sigCol;

    // beam volumes: one program, four handles (3 pillars or lances at once + 1)
    const beams = [];
    for (let i = 0; i < 4; i++) {
      const v = fx.volumes.add({
        shape: 'capsule', glsl: BEAM_GLSL, maxSteps: 16,
        uniforms: {
          uBeam: { value: new THREE.Vector4() }, uBeam2: { value: new THREE.Vector4(1, 1, 0.5, 0) },   // safe for the warm-up frame
          uBeamSrc: { value: new THREE.Vector3() }, uBeamDir: { value: new THREE.Vector3(0, -1, 0) },
          uBeamCore: { value: coreV }, uBeamGlow: { value: glowV },
          uOccA: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uOccB: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
          uOccN: { value: 0 }, uBeamSeed: { value: 0 },
        },
      });
      v.busy = false;
      beams.push(v);
    }
    const cores = new fx.AnalyticRibbons({ max: 6, segments: 12, pathGLSL: CORE_PATH, shadeGLSL: CORE_SHADE, target: 'lines' });
    fx.scenes.lines.add(cores.mesh);

    // Judgment: kernel + sheath volumes, helical threads, the storm deck (one per arena, two holes)
    const beamU = () => ({
      uBeam: { value: new THREE.Vector4() }, uBeam2: { value: new THREE.Vector4(1, 1, 0.5, 0) },
      uBeamSrc: { value: new THREE.Vector3() }, uBeamDir: { value: new THREE.Vector3(0, -1, 0) },
      uBeamCore: { value: coreV }, uBeamGlow: { value: glowV }, uBeamSeed: { value: 0 },
    });
    const kernels = [], sheaths = [];
    for (let i = 0; i < 2; i++) {
      const ke = fx.volumes.add({
        shape: 'capsule', glsl: KERNEL_GLSL, maxSteps: 16,
        uniforms: { ...beamU(), uOccA: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uOccB: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) }, uOccN: { value: 0 } },
      });
      const sh = fx.volumes.add({ shape: 'capsule', glsl: SHEATH_GLSL, maxSteps: 12, uniforms: beamU() });
      ke.busy = sh.busy = false;
      kernels.push(ke); sheaths.push(sh);
    }
    const threads = new fx.AnalyticRibbons({ max: 8, segments: 48, pathGLSL: THREAD_PATH, shadeGLSL: THREAD_SHADE, target: 'lines' });
    fx.scenes.lines.add(threads.mesh);
    const holes = [new THREE.Vector4(), new THREE.Vector4()];
    const deckU = {
      uDeck: { value: new THREE.Vector4(DECK_Y, DECK_H, 0, 0) }, uDeck2: { value: new THREE.Vector4(0, 0.37, fx.Q.mobile ? 5 : 9, 0) }, uDeckC: { value: new THREE.Vector2() },
      uHole: { value: holes }, uDeckLit: { value: deckLit }, uDeckHot: { value: deckHot }, uDeckDark: { value: new THREE.Vector3() },
    };
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(Math.PI / 2), new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: DECK_VERT, fragmentShader: DECK_FRAG, uniforms: { ...fx.U, ...deckU }, ...FX_BLENDING, side: THREE.DoubleSide,
    }));
    deck.position.set(0, DECK_Y, 0); deck.scale.set(170, 1, 170);
    deck.frustumCulled = false; deck.visible = false;
    fx.scenes.fx.add(deck);
    // under the deck the floor and the pool stop mirroring the bright sky (uEnvScale, stormApply)
    const holeBusy = [false, false];
    let cover = 0, front = 0, dim = 0, spin = 0;   // this frame's strongest cast, written by update()
    // the deck takes the sun and most of the sky light; written back as the storm clears. Whoever
    // sets the sun while it's dimmed (a time-of-day change) wins: the new values become the base.
    const sunBase = new THREE.Vector3(), ambBase = new THREE.Vector3(), sunW = new THREE.Vector3(), ambW = new THREE.Vector3();
    let dimmed = false;
    // x: how far the sun and sky light are taken; cv: how much sky the deck hides (the floor mirrors
    // the deck from the moment it is overhead until it has gone, longer than the sun stays out)
    function stormApply(x, cv) {
      const Su = fx.U.uSunColor.value, Am = fx.U.uAmbient.value, e = Math.max(x, 0.9 * cv);
      if (!dimmed) { if (e <= 0) return; sunBase.copy(Su); ambBase.copy(Am); dimmed = true; }
      else if (!Su.equals(sunW) || !Am.equals(ambW)) { sunBase.copy(Su); ambBase.copy(Am); }
      Su.copy(sunBase).multiplyScalar(1 - 0.9 * x); Am.copy(ambBase).multiplyScalar(1 - 0.72 * x);
      sunW.copy(Su); ambW.copy(Am);
      // what the floor mirrors is the deck's dark underside now, not the sky
      arenaUniforms.uEnvScale.value = 1 - 0.86 * e;
      if (e <= 0) dimmed = false;
    }

    // per cast record (cast.js keeps 16): no allocation per cast
    const ST = Array.from({ length: 16 }, () => ({
      src: new THREE.Vector3(), end: new THREE.Vector3(), g: new THREE.Vector3(), dir: new THREE.Vector3(),
      vol: null, core: null, sigil: null, light: null, vortex: null, holy: null,
      sheath: null, fill: null, blast: null, thr: [null, null, null, null], hole: -1, blastR: 0,
      R: 0, R1: 0, L: 0, splatT: 0, hitT: 0, rot: 0,
    }));

    // place a beam handle along src -> end (contact), radius R; cull occluders crossing it
    function placeBeam(v, src, end, R) {
      _a.subVectors(end, src);
      const L = Math.max(_a.length(), 1e-3);
      _a.divideScalar(L);
      v.quaternion.setFromUnitVectors(_up, _a);
      v.position.copy(src).addScaledVector(_a, 0.5 * L);
      v.scale.set(R * HALO, 0.5 * L + R * HALO, R * HALO);
      const u = v.uniforms;
      u.uBeamSrc.value.copy(src);
      u.uBeamDir.value.copy(_a);
      u.uBeam2.value.x = R; u.uBeam2.value.y = L;
      if (!u.uOccN) return;
      let n = 0;
      for (const o of fx.occluders.list) {
        if (n >= 4) break;
        if (segSeg(src, end, o.a, o.b) > R * HALO + o.radius + 0.1) continue;
        u.uOccA.value[n].set(o.a.x, o.a.y, o.a.z, o.radius);
        u.uOccB.value[n].set(o.b.x, o.b.y, o.b.z, 0);
        n++;
      }
      u.uOccN.value = n;
    }
    function coreRibbon(h, src, end, width, intensity, fade, head) {
      if (!h) return;
      h.p0.set(src.x, src.y, src.z, width);
      h.p1.set(end.x, end.y, end.z, 0);
      h.p2.x = (h.index * 7.31) % 6.28; h.p2.y = src.distanceTo(end); h.p2.z = fade; h.p2.w = head;
      h.color.copy(coreCol);
      // the strip degenerates seen end-on: fade it there
      _c.subVectors(end, src).normalize();
      const al = Math.abs(_c.dot(_b.subVectors(src, fx.camera.position).normalize()));
      h.intensity = intensity * (1 - al ** 6);
    }
    function splat(x, z, radius, glow, pattern, seed, heat = 0, char = 0, crack = 0) {
      SPLAT.x = x; SPLAT.z = z; SPLAT.radius = radius; SPLAT.glow = glow; SPLAT.pattern = pattern; SPLAT.seed = seed % 100;
      SPLAT.heat = heat; SPLAT.char = char; SPLAT.crack = crack;
      fx.ground.splat(SPLAT);
    }
    const focus = (k) => fx.arena.setFocus(fx.arena.focus.color, 2.5 + k);
    // the point on the pillar's axis at height y
    const axisAt = (d, y, out) => out.copy(d.g).lerp(d.src, (y - d.g.y) / (d.src.y - d.g.y));

    return {
      onParam(k) { if (k === 'core' || k === 'color') colours(S.params); },
      tick(dt) {
        cores.update(); threads.update();
        // the deck follows the strongest live Judgment; nothing to draw once it has cleared
        const camY = fx.camera.position.y, seen = cover * (1 - sstep(camY, DECK_Y - 3, DECK_Y - 1));
        deck.visible = seen > 0.002;
        if (deck.visible) {
          spin += dt * (0.14 + 0.45 * dim);
          deckU.uDeck.value.z = seen; deckU.uDeck.value.w = front;
          deckU.uDeck2.value.x = spin; deckU.uDeck2.value.y = 0.37 + spin * 0.012;
          const q = deckU.uDeckDark.value, Am = fx.U.uAmbient.value;
          q.set(Am.x * 0.45 + 0.012, Am.y * 0.5 + 0.014, Am.z * 0.6 + 0.02);
        }
        stormApply(dim, seen);
        cover = 0; dim = 0; front = 0;
      },

      phase(c, name) {
        const p = S.params, d = ST[c.index], J = c.form !== 'Radiant Lance';
        colours(p);
        if (name === 'charge') {
          const T = c.durations;
          if (J) { T.charge = 1.3; T.impact = 0.55; T.linger = 3.4; } else { T.charge = 0.45; T.impact = 0.3; T.linger = 1.4; }
          d.R = 0; d.splatT = 0; d.hitT = 0; d.rot = (c.seed % 628) / 100; d.holy = null; d.vortex = null;
          d.vol = d.sheath = d.core = d.fill = d.blast = null; d.hole = -1;
          if (J) {
            for (let i = 0; i < kernels.length; i++) if (!kernels[i].busy) {
              d.vol = kernels[i]; d.sheath = sheaths[i]; d.vol.busy = d.sheath.busy = true; d.vol.visible = d.sheath.visible = false;
              d.vol.uniforms.uBeamSeed.value = (c.seed % 997) / 97; d.sheath.uniforms.uBeamSeed.value = (c.seed % 389) / 41;
              break;
            }
            for (let j = 0; j < 4; j++) { const h = d.thr[j] = threads.acquire(); if (h) h.intensity = 0; }
            for (let i = 0; i < 2; i++) if (!holeBusy[i]) { holeBusy[i] = true; d.hole = i; holes[i].set(0, 0, 0, 0); break; }
            d.fill = fx.lights.acquire();
            if (d.fill) { d.fill.color.setRGB(1, 0.42, 0.12); d.fill.intensity = 0; d.fill.range = 13; }
          } else {
            for (const v of beams) if (!v.busy) { d.vol = v; break; }
            if (d.vol) { d.vol.busy = true; d.vol.visible = false; d.vol.uniforms.uBeamSeed.value = (c.seed % 997) / 97; }
            d.core = cores.acquire();
            if (d.core) d.core.intensity = 0;
          }
          d.light = fx.lights.acquire();
          if (d.light) { d.light.color.copy(lightCol); d.light.intensity = 0; d.light.shadow = true; }
          if (J) {
            // ground point under the target, and a sky source tilted sideways to the cast direction
            const pool = ARENA.pool;
            const inPool = Math.abs(c.to.x - pool.center.x) < pool.half.x && Math.abs(c.to.z - pool.center.y) < pool.half.y;
            d.g.set(c.to.x, inPool ? pool.water : 0, c.to.z);
            // the source leans away from the caster, a little sideways: the hole stays in frame
            const side = (c.seed & 1) ? 1 : -1, tan = Math.tan(THREE.MathUtils.degToRad(p.tilt)) * SKY;
            _a.set(-c.dir.z, 0, c.dir.x).normalize().multiplyScalar(side * tan * 0.35);
            d.src.set(d.g.x + _a.x + c.dir.x * tan, d.g.y + SKY, d.g.z + _a.z + c.dir.z * tan);
            d.dir.subVectors(d.g, d.src).normalize();
            d.end.copy(d.g);
            d.L = d.src.distanceTo(d.g);
            d.R1 = 0.5 * p.width;
            _a.copy(d.g); _b.set(0, 1, 0);
            SIGIL.radius = p.sigil; SIGIL.seed = c.seed % 1000; SIGIL.rotation = d.rot;
            d.sigil = fx.sigils.acquire(SIGIL);
            if (d.sigil) { d.sigil.reveal = 0; d.sigil.intensity = 0; }
            if (d.light) { d.light.type = 2; d.light.range = 11; d.light.pos.copy(d.g).setY(d.g.y + 2.8); d.light.cookie[0] = 2; d.light.cookie[1] = 1 / p.sigil; d.light.cookie[2] = -d.rot; }
          } else {
            d.src.copy(c.from);
            d.dir.subVectors(c.to, c.from).normalize();
            _a.copy(c.from).addScaledVector(d.dir, 0.32); _b.copy(d.dir);
            SIGIL.radius = 0.5; SIGIL.seed = c.seed % 1000; SIGIL.rotation = d.rot;
            d.sigil = fx.sigils.acquire(SIGIL);
            if (d.sigil) { d.sigil.reveal = 0; d.sigil.intensity = 0; }
            if (d.light) { d.light.type = 0; d.light.range = 6; d.light.pos.copy(c.from); }
          }
        } else if (name === 'travel') {
          // the lance lands on the first surface between the focus and the target
          const dist = c.from.distanceTo(c.to);
          const hit = arenaRaycast(c.from, d.dir, dist + 0.6);
          if (hit > 0.3) d.end.copy(c.from).addScaledVector(d.dir, hit); else d.end.copy(c.to);
          d.L = c.from.distanceTo(d.end);
          d.R1 = 0.5 * p.lance;
          if (d.light) { d.light.type = 1; d.light.range = 9; d.light.pos.copy(c.from); d.light.end.copy(d.end); }
          d.holy = fx.impacts.add('holy', d.end, 1.1, 1.2 * p.glow, 1.2, lightCol);
          fx.flash(0.12 * p.intensity);
          fx.rig.shake(0.15, 16);
        } else if (name === 'impact') {
          if (J) slam(c, p, d);
          else {
            // the lance lets go: a last burst where it landed
            spark.pos.copy(d.end); spark.vel.set(0, 1.5, 0); spark.burst(260 * p.motes);
            mote.pos.copy(d.end); mote.radius = 0.3; mote.vel.set(0, 2.2, 0); mote.burst(200 * p.motes);
            splat(d.end.x, d.end.z, 1.4, 0.8 * p.glow, 'ring', c.seed + 3);
            fx.rig.shake(0.18, 14);
          }
        } else if (name === 'done') {
          if (d.vol) { d.vol.visible = false; d.vol.busy = false; }
          if (d.sheath) { d.sheath.visible = false; d.sheath.busy = false; }
          for (let j = 0; j < 4; j++) { d.thr[j]?.release(); d.thr[j] = null; }
          if (d.hole >= 0) { holeBusy[d.hole] = false; holes[d.hole].set(0, 0, 0, 0); d.hole = -1; }
          d.core?.release(); d.sigil?.release(); d.light?.release(); d.vortex?.release(); d.fill?.release(); d.blast?.release();
          d.vol = d.sheath = d.core = d.sigil = d.light = d.vortex = d.holy = d.fill = d.blast = null;
          focus(0);
        }
      },

      update(c, dt) {
        const p = S.params, d = ST[c.index], v = d.vol, L = d.light;
        colours(p);
        d.rot += dt * (c.form === 'Radiant Lance' ? 2.6 : 0.35);
        if (d.sigil) d.sigil.rotation = d.rot;
        if (c.form === 'Radiant Lance') return lance(c, p, d, dt);

        const base = 4.4 * p.intensity, F = d.fill, st = p.storm;
        let Rk = 0, Rs = 0, Ik = 0, Is = 0, head = d.L + 5, thr = 0, thrW = 0.035, holeR = 0, holeI = 0, cov = 0, fr = 200, dm = 0;
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge;
          if (d.sigil) { d.sigil.reveal = sstep(k, 0, 0.85); d.sigil.intensity = (2 + 4 * k) * p.intensity; }
          if (L) { L.intensity = 30 * k * k * p.intensity; L.cookie[2] = -d.rot; }
          ringMote.pos.copy(d.g).setY(d.g.y + 0.05); ringMote.radius = p.sigil * 0.92; ringMote.vel.set(0, 0.7, 0);
          ringMote.rate(450 * k * p.motes, dt);
          // the air pulled in under it: dust creeping towards the sigil
          dust.pos.copy(d.g).setY(d.g.y + 0.1); dust.radius = p.sigil * 2.2; dust.radial = -2.6; dust.vel.set(0, 0.3, 0); dust.size = 0.45;
          dust.rate(40 * k * p.dust, dt);
          // the storm races out from over the target; the sun goes; the hole tears open and burns
          cov = st; fr = 10 + 170 * k * k; dm = st * sstep(k, 0.05, 0.8);
          const x = clamp((k - 0.4) / 0.6, 0, 1);
          holeR = 3.4 * x * x; holeI = 9 * x * x * x * p.intensity;
          // the pilot ray: 0.24 m wide, descending through the hole over the last 40%
          if (k > 0.6) {
            const y = (k - 0.6) / 0.4;
            Rk = 0.12; Ik = base * 3.5; head = d.L * y * y + 0.6; thr = 26 * y * p.intensity; thrW = 0.02;
          }
          focus(4 * k);
        } else if (c.phase === 'impact') {
          const t = c.t;
          Rk = Math.max(0.12, d.R1 * easeOutBack(Math.min(t / 0.12, 1)));
          Rs = d.R1 * 3.1 * (1 - Math.exp(-t * 14));
          Ik = base * (1 + 2.0 * Math.exp(-t / 0.07));
          Is = 0.42 * p.intensity * (1 + 1.3 * Math.exp(-t / 0.14));
          thr = 16 * p.intensity * (1 + 1.5 * Math.exp(-t / 0.07));
          cov = st; dm = st; holeR = 3.4 + 4 * (1 - Math.exp(-t * 6)); holeI = 9 * p.intensity * (1 + 2 * Math.exp(-t / 0.1));
          if (L) { L.intensity = 3000 * p.intensity * (1 + 1.2 * Math.exp(-t / 0.09)); }
          if (F) F.intensity = 70 * p.molten * (1 + Math.exp(-t / 0.2));
          if (d.sigil) d.sigil.intensity = 7 * p.intensity * Math.exp(-t / 0.15) + 1.5 * p.intensity;
          if (d.holy) d.holy.age = 0;
          beamParticles(d, p, Rs, dt, 1);
          focus(4);
        } else {
          // linger: the shaft holds, collapses to a thread and goes; the hole closes, the storm clears
          const t = c.t, Lg = c.durations.linger, y = clamp((t - 1.0) / 0.5, 0, 1), q = (1 - y) * (1 - y);
          Rk = y < 1 ? THREE.MathUtils.lerp(d.R1, 0.04, y ** 1.5) : 0;
          Rs = d.R1 * 3.1 * (1 - 0.65 * y);
          Ik = base * q; Is = 0.42 * p.intensity * q; thr = 16 * p.intensity * q;
          holeR = Math.max(0, 7.4 * (1 - sstep(t, 0.9, 2.1))); holeI = 9 * p.intensity * q;
          cov = st * (1 - sstep(t, 1.5, Lg)); dm = st * (1 - sstep(t, 1.1, Lg - 0.8));
          if (L) L.intensity = 3000 * p.intensity * q + 14 * p.intensity * Math.max(0, 1 - t / 2);
          if (F) F.intensity = 70 * p.molten * Math.exp(-t / 1.1);
          if (d.sigil) { d.sigil.intensity = 1.5 * p.intensity * (1 - t / Lg); d.sigil.reveal = 1 - sstep(t / Lg, 0.3, 0.8); }
          if (d.vortex && t > 1.6) { d.vortex.release(); d.vortex = null; }
          beamParticles(d, p, Math.max(Rs, 0.3), dt, q);
          focus(4 * (1 - y));
        }
        if (d.blast) {
          d.blastR += dt * 21;
          d.blast.p[0] = d.blastR; d.blast.p[2] = 130 * Math.max(0, 1 - d.blastR / 17);
          if (d.blastR > 17) { d.blast.release(); d.blast = null; }
        }
        // the deck
        cover = Math.max(cover, cov); front = Math.max(front, fr); dim = Math.max(dim, dm);
        if (d.hole >= 0) {
          axisAt(d, DECK_Y + 0.4 * DECK_H, _a);
          holes[d.hole].set(_a.x, _a.z, holeR, holeI);
          if (d.hole === 0 || !holeBusy[0]) deckU.uDeckC.value.set(_a.x, _a.z);
        }
        // the shaft's volumes and threads
        const ke = d.vol, sh = d.sheath;
        if (ke) {
          ke.visible = Rk > 0.01 && Ik > 0.01;
          if (ke.visible) {
            placeBeam(ke, d.src, d.g, Rk);
            ke.uniforms.uBeam.value.set(Ik, p.rays, p.scatter, head);
            ke.uniforms.uBeam2.value.w = 0.18;
          }
        }
        if (sh) {
          sh.visible = Rs > 0.05 && Is > 0.005;
          if (sh.visible) {
            placeBeam(sh, d.src, d.g, Rs / HALO);
            sh.uniforms.uBeam.value.set(Is, p.rays, p.scatter, head);
            sh.uniforms.uBeam2.value.z = c.phase === 'charge' ? 0 : clamp(p.dust, 0, 2);
          }
        }
        for (let j = 0; j < 4; j++) {
          const h = d.thr[j];
          if (!h) continue;
          h.intensity = thr * (0.6 + 0.4 * ((j * 2.3) % 1));
          if (thr <= 0.01) continue;
          h.p0.set(d.src.x, d.src.y, d.src.z, thrW * (j === 0 ? 1.3 : 1));
          h.p1.set(d.g.x, d.g.y, d.g.z, ((c.seed % 83) * 0.137 + j * 0.31) % 1);
          h.p2.set(Math.max(Rk, 0.05) * (0.16 + 0.11 * j), (j & 1 ? -1 : 1) * (0.5 + 0.13 * j), 0, head);
          h.p3.set(1.2 + j * 0.4, d.L, 0, 0);
          h.color.copy(coreCol);
        }
        if (c.phase !== 'charge' && Rk > 0.2) {
          d.splatT -= dt;
          if (d.splatT <= 0) {
            d.splatT = 0.2;
            const m = p.molten;
            splat(d.g.x, d.g.z, Rk * 2.2, 0.3 * p.glow, 'noise', c.seed + c.age * 10, 0.8 * m, 0.3 * m, 0);
          }
        }
      },
    };

    // Judgment lands: the pillar slams open (the rest animates in update)
    function slam(c, p, d) {
      const g = d.g, R1 = d.R1, m = p.molten;
      fx.flash(0.5 * p.intensity);
      fx.rig.shake(0.6, 13);
      if (!fx.reduced) { fx.rig.punch(2.6, 0.08); fx.rig.hitstop(0.05); }
      // the floor: fused and fractured under the contact, a wide scorch and glow round it
      splat(g.x, g.z, R1 * 2.4, 0.9 * p.glow, 'radial', c.seed, 1.8 * m, 0.9 * m, 0);
      splat(g.x, g.z, R1 * 3.6, 0.3 * p.glow, 'noise', c.seed + 7, 1.0 * m, 0.8 * m, 0);
      splat(g.x, g.z, R1 * 2.0, 0, 'lichtenberg', c.seed + 3, 0, 0.2, 3.2 * m);
      splat(g.x, g.z, p.sigil * 1.05, 1.2 * p.glow, 'ring', c.seed + 1);
      d.holy = fx.impacts.add('holy', _a.copy(g).setY(g.y - 1), 2.4, 0.5 * p.glow, 3.5, lightCol);
      // the shock: one along the floor out to the wall, one in the air
      _c.copy(g).setY(g.y + 0.02); SHOCK.radius0 = R1 * 0.6; SHOCK.radius1 = 15; SHOCK.duration = 0.75; SHOCK.thickness = 0.9; SHOCK.distortion = 0.05; SHOCK.intensity = 2.6 * p.intensity; SHOCK.ground = true;
      fx.shocks?.spawn(SHOCK);
      _c.setY(g.y + 1.4); SHOCK.radius0 = R1; SHOCK.radius1 = 9; SHOCK.duration = 0.4; SHOCK.thickness = 1.1; SHOCK.distortion = 0.1; SHOCK.intensity = 0; SHOCK.ground = false;
      fx.shocks?.spawn(SHOCK);
      d.blast = fx.forces.acquire();
      if (d.blast) { d.blast.type = 4; d.blast.pos.copy(g).setY(g.y + 0.3); d.blast.p[0] = R1; d.blast.p[1] = 2.2; d.blast.p[2] = 130; d.blast.p[3] = 0; d.blastR = R1; }
      // the dust ring: a fast thin front and a slower heavy bank, both lit from inside by the shaft
      dust.pos.copy(g).setY(g.y + 0.12); dust.radius = R1 * 1.25; dust.vel.set(0, 0.5, 0);
      dust.radial = 13; dust.size = 1; dust.burst(150 * p.dust);
      dust.radial = 6; dust.size = 1.3; dust.burst(70 * p.dust);
      rock.pos.copy(g).setY(g.y + 0.1); rock.radius = R1 * 1.2; rock.vel.set(0, 5.5, 0); rock.burst(44 * m);
      molten.pos.copy(g).setY(g.y + 0.06); molten.radius = R1 * 0.9; molten.vel.set(0, 3.2, 0); molten.burst(420 * m);
      spark.pos.copy(g).setY(g.y + 0.1); spark.radius = R1 * 0.5; spark.vel.set(0, 3, 0); spark.burst(300 * p.motes);
      mote.pos.copy(g).setY(g.y + 0.05); mote.radius = R1; mote.vel.set(0, 3.5, 0); mote.spread = 1.6; mote.radial = 1.2; mote.burst(400 * p.motes);
      mote.spread = 0.6; mote.radial = 0;
      feather.pos.copy(axisAt(d, g.y + 2, _a)); feather.p.copy(axisAt(d, g.y + 9, _b)); feather.radius = R1 * 0.8; feather.vel.set(0, -0.2, 0);
      feather.burst(16 * p.feathers);
      fx.pool?.ripple?.(g.x, g.z, 0.05, 2);
      // the light stops being a rune projector and hits the whole arena from the axis, hard
      if (d.light) { d.light.type = 0; d.light.cookie[0] = 0; d.light.range = 44; axisAt(d, g.y + 11, d.light.pos); d.light.color.copy(lightCol); }
      if (d.fill) d.fill.pos.copy(g).setY(g.y + 0.9);
      d.vortex = fx.forces.acquire();
      if (d.vortex) { d.vortex.type = 1; d.vortex.w = 9; d.vortex.p[0] = R1 * 0.7; d.vortex.p[1] = 3.5; d.vortex.p[2] = 1.4; d.vortex.p[3] = 0.4; d.vortex.pos.copy(g); d.vortex.dir.set(0, 1, 0); }
      // smite + cleanse whatever stands in or near it
      for (const dm of fx.dummies) {
        const dist = Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z);
        if (dist > R1 + 1.2) continue;
        dm.status.corrupt = 0;
        dm.hit(dist > 0.05 ? _a.subVectors(dm.pos, g) : c.dir, 0.35 * (1 - dist / (R1 + 1.2)) + 0.15);
      }
    }

    // motes rising through the pillar, feathers tumbling down it
    function beamParticles(d, p, R, dt, k) {
      if (k <= 0) return;
      mote.pos.copy(d.g).setY(d.g.y + 0.05); mote.radius = R * 0.28; mote.vel.set(0, 1.2, 0);
      mote.rate(420 * p.motes * k, dt);
      feather.pos.copy(axisAt(d, d.g.y + 2, _a)); feather.p.copy(axisAt(d, d.g.y + 9, _b)); feather.radius = R * 0.25; feather.vel.set(0, -0.3, 0);
      feather.rate(45 * p.feathers * k, dt);
      // dust glinting in the shaft
      fleck.pos.copy(axisAt(d, d.g.y + 0.5, _a)); fleck.p.copy(axisAt(d, d.g.y + 11, _b)); fleck.radius = R * 0.62; fleck.vel.set(0, -0.12, 0);
      fleck.rate(1300 * p.dust * k, dt);
      dust.pos.copy(d.g).setY(d.g.y + 0.1); dust.radius = Math.max(R * 0.32, 0.4); dust.radial = 3; dust.vel.set(0, 0.8, 0); dust.size = 0.8;
      dust.rate(34 * p.dust * k, dt);
    }

    function lance(c, p, d, dt) {
      const v = d.vol, L = d.light, base = 30 * p.intensity;
      let R = 0, I = 0, core = 0, head = d.L + 1;
      if (c.phase === 'charge') {
        const k = c.t / c.durations.charge;
        if (d.sigil) { d.sigil.reveal = k ** 0.7; d.sigil.intensity = 5 * k * p.intensity; }
        gather.pos.copy(c.from); gather.rate(900 * k * p.motes, dt);
        if (L) L.intensity = 14 * k * p.intensity;
        focus(5 * k);
      } else if (c.phase === 'travel') {
        const t = c.t;
        head = Math.min(d.L + 1, t * 160);
        R = d.R1 * (1 + 0.05 * Math.sin(c.age * 47) * Math.sin(c.age * 13));
        I = base * (1 + 1.2 * Math.exp(-t / 0.08));
        core = 16 * p.intensity * (1 + Math.exp(-t / 0.08));
        if (d.sigil) { d.sigil.reveal = 1; d.sigil.intensity = 7 * p.intensity; }
        if (L) L.intensity = 45 * p.intensity * (1 + Math.exp(-t / 0.1)) * (0.92 + 0.08 * Math.sin(c.age * 31));
        if (d.holy) d.holy.age = 0;
        if (head >= d.L) {
          stream.pos.copy(c.from); stream.p.copy(d.end); stream.vel.copy(d.dir).multiplyScalar(9); stream.rate(1500 * p.motes, dt);
          spark.pos.copy(d.end); spark.radius = 0.15; spark.vel.copy(d.dir).multiplyScalar(-1.5); spark.rate(350 * p.motes, dt);
          mote.pos.copy(d.end); mote.radius = 0.25; mote.vel.set(0, 1.4, 0); mote.rate(250 * p.motes, dt);
          d.splatT -= dt;
          if (d.splatT <= 0) { d.splatT = 0.15; splat(d.end.x, d.end.z, d.end.y < 0.4 ? 1.1 : 0.8, 0.3 * p.glow, 'radial', c.seed + c.age * 10); }
          d.hitT -= dt;
          if (d.hitT <= 0 && c.target >= 0) {
            d.hitT = 0.35;
            const dm = fx.dummies[c.target];
            if (dm && dm.pos.distanceTo(_a.copy(d.end).setY(0)) < 1.2) { dm.status.corrupt = 0; dm.hit(d.dir, 0.12); }
          }
        }
        focus(5);
      } else {
        const t = c.t, y = c.phase === 'impact' ? clamp(t / c.durations.impact, 0, 1) : 1;
        R = y < 1 ? d.R1 * (1 - y) ** 2 + 0.01 : 0;
        I = base * (1 - y) ** 2;
        core = 16 * p.intensity * (1 - y) ** 3;
        if (L) L.intensity *= Math.exp(-dt / 0.12);
        if (d.sigil) { d.sigil.intensity = 7 * p.intensity * (1 - y * 0.5); d.sigil.reveal = c.phase === 'linger' ? 1 - sstep(t / c.durations.linger, 0, 0.7) : 1; }
        focus(5 * (1 - y));
      }
      if (v) {
        v.visible = R > 0.01 && I > 0.01;
        if (v.visible) {
          placeBeam(v, c.from, d.end, R);
          v.uniforms.uBeam.value.set(I, p.rays * 0.6, p.scatter, head);
          v.uniforms.uBeam2.value.z = Math.min(0.5, 0.35 / d.L); v.uniforms.uBeam2.value.w = 1.6;
        }
      }
      coreRibbon(d.core, c.from, d.end, 0.2 * p.lance, core, Math.min(0.5, 0.2 / d.L), head);
    }
  },
};
