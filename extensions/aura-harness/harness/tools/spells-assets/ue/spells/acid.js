import * as THREE from 'three';
import {
  COMMON_GLSL, NOISE_GLSL, ARENA_GLSL, LIGHTS_GLSL, GROUND_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING, MAX_OCCLUDERS,
} from '../vfx/common.js';
import { REFRACT_GLSL } from '../vfx/Refraction.js';
import { arenaUniforms } from '../scene/arenaMaterial.js';
import { FluidVolume } from '../vfx/FluidVolume.js';

// Acid (PLAN 3), matched against film acid (Alien's blood eating through a deck: yellow-green
// liquid, white acrid fumes, violent froth, dark pitted stone) and chlorine release footage (the
// Jack Rabbit II trials: a pale yellow-green cloud that slumps and runs along the ground).
// Toxic Bloom: a lobbed blob of glowing acid (the shared metaball renderer, acid preset) splashes
// onto the target: beads slap the floor and flatten, some cling to the dummy and ooze down it. The
// liquid then stands on the floor as its own refract-pass layer (the ground field's acid, shaped by
// noise into a pool with fingers and stranded beads: meniscus, murky Beer-Lambert body over the
// eaten stone, drifting luminous swirls, a two-scale froth of swelling and popping bubbles where it
// touches material and along its eating front, a dark pocked etch round it). Froth domes of mixed
// size cluster on it and pop into spits and vapour; pale heavy vapour rolls out along the floor,
// white fumes rise where it reacts; drips fall off the dummy as it dissolves.
// Corrosion Cloud: the blob bursts into a simulated dense gas over the target (the shared 3D fluid,
// its soot channel used as a heavy gas that carries no heat), matched to the chlorine plumes of the
// Jack Rabbit II trials and the Graniteville release: it falls as a slug, slumps and runs out
// along the floor as a low, dense, pale carpet (a gravity current), lobes and fingers at its front,
// billowing only near the source, soft edges curling into wisps, thinning to a haze. Never self-lit:
// sun and sky shadowed through its own depth light the tops pale and leave the underside olive;
// drips spit, etch and pit the floor. Without a free fluid slot: a raymarched cloud.
// The liquid body (charge, flight, splash) is isolated in the BLOB section below, so it can move to
// the shared particle fluid ('acid' preset) by swapping those five functions.

const N_BUB = 768;       // froth dome ring (High tier)
const POP = 0.08;        // s, spray ring after a dome's life
const SURF = 0.011;      // m, the liquid's surface over the floor
const MAX_POOLS = 3;

// --- froth domes: sphere impostors in the fx pass (WBOIT), sitting half-sunk in the liquid ------
// Motion is analytic (no state): surface point + drift + wobble, mirrored in JS for the pops.
const BUBBLE_VERT = FX_VERT_HEAD + COMMON_GLSL + /* glsl */`
uniform float uNow;
in vec4 aB0;   // surface point xyz, birth (module clock, s)
in vec4 aB1;   // radius m, life s, -, seed 0..1
in vec4 aB2;   // drift x, drift z (m/s), wobble amplitude m, wobble rad/s
out vec2 vUv;
out vec3 vC;          // view-space centre
flat out vec4 vB;     // radius m, age 0..1, pop 0..1, seed
flat out float vSurf; // world height of the liquid surface
out float vGain;
void main() {
  float tau = uNow - aB0.w, life = aB1.y;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vB = vec4(0.0); vC = vec3(0.0); vUv = vec2(0.0); vGain = 0.0; vSurf = 0.0;
  if (tau < 0.0 || tau > life + ${POP.toFixed(3)} || life <= 0.0) return;
  float ph = aB1.w * 6.2832, k = clamp(tau / life, 0.0, 1.0);
  vec3 c = aB0.xyz + vec3(aB2.x * tau + aB2.z * sin(aB2.w * tau + ph), 0.0, aB2.y * tau + aB2.z * cos(aB2.w * 0.83 * tau + aB1.w * 11.0));
  // swells up out of the liquid, then sits on it as a dome (centre below the surface)
  float r = aB1.x * (0.4 + 0.6 * sqrt(min(k * 3.0, 1.0)));
  c.y += r * mix(-0.9, -0.3, smoothstep(0.0, 0.3, k));
  float pop = clamp((tau - life) / ${POP.toFixed(3)}, 0.0, 1.0);
  vec3 cv = (viewMatrix * vec4(c, 1.0)).xyz;
  float viewZ = -cv.z;
  if (viewZ < 0.25) return;
  // never below one fx pixel, energy kept
  float pxW = 2.0 * viewZ / (projectionMatrix[1][1] * uFxResolution.y);
  float rr = max(r, pxW);
  vGain = (r / rr) * (r / rr) * smoothstep(0.25, 1.0, viewZ);
  float ext = (1.0 + 1.3 * pop) * 1.08;   // slack for perspective, room for the spray ring
  gl_Position = projectionMatrix * vec4(cv + vec3(position.xy * rr * ext, 0.0), 1.0);
  vUv = position.xy * ext;
  vC = cv;
  vB = vec4(rr, k, pop, aB1.w);
  vSurf = aB0.y;
}`;

const BUBBLE_FRAG = FX_FRAG_HEAD + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + /* glsl */`
uniform mat4 projectionMatrix;
uniform samplerCube uSkyCube;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uTint;    // acid glow, linear (the pool's light from below)
uniform vec3 uHot;     // spray of a pop, linear
uniform vec2 uIri;     // reflection gain, interference saturation 0..1
in vec2 vUv;
in vec3 vC;
flat in vec4 vB;
flat in float vSurf;
in float vGain;

// Spectrally integrated cos(2 pi opd / lambda) against the CIE XYZ matching functions, with the
// Gaussian fits in Fourier space of Belcour & Barla 2017 ("A Practical Extension to Microfacet
// Theory for the Modeling of Varying Iridescence"), to linear sRGB, normalised so opd 0 is white.
const mat3 XYZ2RGB = mat3(3.2404542, -0.9692660, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.0415560, 1.0572252);
vec3 filmCos(float opd) {
  float ph = 6.2831853e-9 * opd;   // opd in nm
  vec3 var = vec3(4.3278e9, 9.3046e9, 6.6121e9);
  vec3 xyz = vec3(5.4856e-13, 4.4201e-13, 5.2481e-13) * sqrt(6.2831853 * var) * cos(vec3(1.6810e6, 1.7953e6, 2.2084e6) * ph) * exp(-var * ph * ph);
  xyz.x += 9.7470e-14 * sqrt(6.2831853 * 4.5282e9) * cos(2.2399e6 * ph) * exp(-4.5282e9 * ph * ph);
  return XYZ2RGB * (xyz / 1.0685e-7) / vec3(1.2048, 0.9483, 0.9088);
}
// liquid film in air: R(lambda) ~ sin^2(delta / 2), spectral mean 0.5 (1 - filmCos), through Airy's
// F s / (1 + F s). A viscous acid film is microns thick, so it reflects near-white; only as it
// drains thin before the pop do interference colours come up, and black just before it bursts.
vec3 filmReflect(float NoV, float dnm) {
  float cosT = sqrt(1.0 - (1.0 - NoV * NoV) / 1.85);   // n = 1.36
  float R0 = 0.023 + 0.977 * pow(1.0 - NoV, 5.0);
  vec3 s = clamp(0.5 * (1.0 - filmCos(2.72 * dnm * cosT)), 0.0, 1.0);
  float F = 4.0 * R0 / max((1.0 - R0) * (1.0 - R0), 1e-3);
  return F * s / (1.0 + F * s);
}
float film(vec3 n, float age, float seed) {
  float sw = noise3(n * 0.23 + vec3(seed * 7.1, uTime * 0.045 + seed, seed * 3.7));
  float drain = mix(1.4, 0.5, n.y * 0.5 + 0.5);
  return mix(2400.0, 30.0, age * age * age) * drain * (0.4 + 1.2 * sw);
}
// the sky above, the glowing liquid below
vec3 envAt(vec3 r) { return textureLod(uSkyCube, r, 1.5).rgb + uTint * smoothstep(0.15, -0.5, r.y); }
void main() {
  float r2 = dot(vUv, vUv), pop = vB.z, viewZ = -vC.z;
  if (pop > 0.0) {   // burst: a ring of fine spray thrown off the rim
    float x = (sqrt(r2) - (1.0 + 1.2 * pop)) / 0.16;
    float ring = exp(-x * x) * (1.0 - pop);
    if (ring < 0.01) discard;
    fxOut(vec3(0.0), 0.0, uHot * ring * vGain * 0.5, vec2(0.0), viewZ);
    return;
  }
  if (r2 >= 1.0) discard;
  float z = sqrt(1.0 - r2);
  mat3 toW = transpose(mat3(viewMatrix));
  vec3 pv = vC + vec3(vUv, z) * vB.x;
  vec3 pw = toW * (pv - viewMatrix[3].xyz);
  // what is under the liquid surface doesn't show: a dome, anti-aliased over a pixel
  float px = 2.0 * viewZ / (projectionMatrix[1][1] * uFxResolution.y);
  float above = clamp((pw.y - vSurf) / px + 0.5, 0.0, 1.0);
  if (above <= 0.0) discard;
  viewZ -= z * vB.x;
  vec3 rd = toW * normalize(pv);
  vec3 nF = toW * vec3(vUv, z), nB = toW * vec3(vUv, -z);
  float NoV = clamp(dot(nF, -rd), 0.0, 1.0);
  vec3 RF = filmReflect(NoV, film(nF, vB.y, vB.w)), RB = filmReflect(NoV, film(nB, vB.y, vB.w));
  float mF = dot(RF, vec3(0.3333)), mB = dot(RB, vec3(0.3333));
  RF = mix(vec3(mF), RF, uIri.y); RB = mix(vec3(mB), RB, uIri.y);
  vec3 rF = reflect(rd, nF), rB = reflect(rd, nB);
  vec3 col = envAt(rF) * RF + envAt(rB) * RB * (1.0 - RF);
  col += uSunColor * pow(max(dot(rF, uSunDir), 0.0), 600.0) * 25.0 * RF;
  // the film is the acid itself: tinted, lit through by the pool's glow, most along the rim
  float rim = pow(1.0 - NoV, 2.0);
  float edge = clamp((1.0 - sqrt(r2)) * vB.x / px * 1.5, 0.0, 1.0) * vGain * above;
  float a = clamp((mF + mB) * 0.5 * uIri.x + 0.06 + 0.4 * rim, 0.0, 0.85) * edge;
  if (a < 0.002) discard;
  fxOut(col * uIri.x * edge / max(a, 1e-4), a, uTint * (0.2 + 1.1 * rim) * edge, vec2(0.0), viewZ);
}`;

// --- the standing liquid: a refract-pass layer over the floor ----------------------------------
const POOL_VERT = /* glsl */`
out vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const POOL_FRAG = /* glsl */`
uniform vec4 uPoolA;    // centre x, z, radius m, liquid 0..1 (how much of the field's acid stands)
uniform vec4 uPoolB;    // reaction 0..1, -, corrosion 0..2, seed
uniform vec3 uGlowCol;  // linear liquid glow (x glow)
uniform vec3 uHotCol;   // linear reaction glow
uniform vec3 uAbsorb;   // 1/m
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform sampler2D uStoneNoise;   // the arena's mipmapped noise: r, g fbm (4 cells/tile), a fbm (32)
${COMMON_GLSL}
${NOISE_GLSL}
${ARENA_GLSL}
${LIGHTS_GLSL}
${GROUND_GLSL}
${REFRACT_GLSL}
in vec3 vW;
out vec4 fragColor;

// froth: a jittered grid of bubbles (cell metres), each swelling and popping on its own clock,
// present in a cell with probability dens. Coverage of the dome under p, nb its normal (world).
float froth(vec2 p, float cell, float dens, float rate, out vec3 nb) {
  vec2 g = p / cell, i0 = floor(g);
  float best = 9.0, cov = 0.0;
  nb = vec3(0.0, 1.0, 0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = i0 + vec2(float(x), float(y));
    vec3 hh = hash33(vec3(c, cell * 97.0));
    if (hh.z > dens) continue;
    float life = fract(hh.x * 7.31 + uTime * rate * (0.5 + hh.y));
    float rad = (0.3 + 0.45 * hh.y) * sqrt(life);
    vec2 o = g - c - 0.5 - (hh.yx - 0.5) * 0.6;
    float l = length(o), d = l / rad;
    if (d < 1.0 && l < best) {
      best = l;
      nb = vec3(o.x / rad, sqrt(1.0 - d * d), o.y / rad);
      cov = 1.0 - smoothstep(0.8, 1.0, d);
    }
  }
  return cov;
}

void main() {
  gLightNoShadow = true;
  vec2 xz = vW.xz;
  // liquid where the field's acid (blurred: surface tension rounds everything off below a few cm),
  // shifted by broad noise into lobes, clears the bar: a pool with rounded fingers, stranded beads
  // and a soft eating front; h > 0 is liquid
  const vec2 e = vec2(0.07, -0.07);
  float ac = min(0.25 * (groundB(xz + e.xx).y + groundB(xz + e.xy).y + groundB(xz + e.yx).y + groundB(xz + e.yy).y), 1.6);
  vec2 sd = vec2(uPoolB.w, uPoolB.w * 1.7);
  float big = texture(uStoneNoise, xz * 0.19 + sd).r, fine = texture(uStoneNoise, xz * 0.8 + sd.yx).a;
  float rad = length(xz - uPoolA.xy) / uPoolA.z;
  float h = ac * 1.3 * uPoolA.w - 0.45 + (big - 0.5) * 1.1 + (fine - 0.5) * 0.15 - smoothstep(0.7, 1.0, rad) * 2.0;
  float depth = 0.004 + 0.016 * smoothstep(0.0, 0.5, h);   // m
  // every screen derivative before any branch: the AA width and the surface slope (the depth's
  // derivatives solved back to world xz: a steep meniscus where it thins at the edge)
  float fw = max(fwidth(h), 1e-4);
  vec2 dx = dFdx(xz), dy = dFdy(xz);
  float hx = dFdx(depth), hy = dFdy(depth), det = dx.x * dy.y - dx.y * dy.x;
  vec2 g = abs(det) > 1e-14 ? vec2(hx * dy.y - hy * dx.y, hy * dx.x - hx * dy.x) / det : vec2(0.0);
  float pxw = max(length(dx), length(dy));   // pixel footprint (m)
  float cov = smoothstep(-fw, fw, h);
  float etch = smoothstep(-0.5, -0.03, h) * smoothstep(0.03, 0.15, ac) * min(uPoolB.z, 1.0);
  if (cov <= 0.0 && etch <= 0.004) discard;

  vec3 v = normalize(cameraPosition - vW);
  vec3 under = textureLod(uSceneColor, gl_FragCoord.xy / uResolution, 0.0).rgb;
  // the eaten stone round the liquid. The stain itself (rust-brown blotches, etched grain, salt
  // bloom) is the floor's own acid response; here it is only damp, darker and browner towards the
  // liquid, in soft blotches (a hard threshold on the fine noise printed a camouflage of specks),
  // and wet and glossy at the edge
  float damp = etch * smoothstep(-0.55, -0.05, h + (big - 0.5) * 0.3);
  vec3 col = under * mix(vec3(1.0), vec3(0.5, 0.45, 0.36), damp);
  float wet = smoothstep(-0.15, 0.0, h);
  col += envReflect(reflect(-v, vec3(0.0, 1.0, 0.0)), 0.15) * fresnel(v.y, 0.03) * wet * 0.8;
  float alpha = etch * 0.92;

  if (cov > 0.0) {
    // what stands in it (dummies, pillars, spikes): the occluder capsules at their foot
    float contact = 0.0;
    int nOcc = int(uWorldCounts.w);
    for (int i = 0; i < ${MAX_OCCLUDERS}; i++) {
      if (i >= nOcc) break;
      vec4 a = worldTexel(3, i * 2), b = worldTexel(3, i * 2 + 1);
      float y0 = min(a.y, b.y);
      if (y0 - a.w > 0.3) continue;
      float d = sdCapsule(vec3(xz.x, max(y0, 0.0), xz.y), a.xyz, b.xyz, a.w);
      contact = max(contact, 1.0 - smoothstep(-0.05, 0.35, d));
    }
    float react = uPoolB.x;
    float boil = clamp(contact * 1.3 + 0.3 * smoothstep(0.5, 1.2, ac) - 0.1, 0.0, 1.0) * react;
    // simmering surface: slow undulation, choppy where it boils; fades once a pixel spans it
    vec3 rq = vec3(xz * 1.1, uTime * 0.3);
    vec2 rip = vec2(noise3(rq), noise3(rq + vec3(0.37, 0.61, 0.0))) - 0.5;
    g = clamp(g * 3.0, -2.5, 2.5) + rip * (0.08 + 0.9 * boil) * (1.0 - smoothstep(0.004, 0.03, pxw));
    vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
    float NoV = max(dot(n, v), 1e-3);
    float F = fresnel(NoV, 0.025);
    vec3 refl = envReflect(reflect(-v, n), 0.05);
    vec3 H = normalize(uSunDir + v);
    float NoL = max(dot(n, uSunDir), 0.0);
    vec3 spec = uSunColor * (PI * spellD_GGX(max(dot(n, H), 0.0), 0.02) * spellV_Smith(NoV, NoL, 0.02) * NoL * fresnel(dot(v, H), 0.025));
    vec3 dS, sS;
    spellLightPBR(vW, n, v, 0.1, vec3(0.025), vec3(0.0), dS, sS);
    // body: the stone seen through the murky liquid (absorbed and clouded over the path down and
    // back up: only the thin edges show what is under it)
    float behind;
    vec3 floorC = sceneRefract(vW, n, v, 1.36, depth * 8.0, behind);
    float path = depth * (1.0 + 1.0 / max(NoV, 0.2));
    vec3 T = exp(-(uAbsorb + 50.0) * path);
    vec3 murk = (uAmbient * 1.2 + uSunColor * max(uSunDir.y, 0.0) * 0.2) * vec3(0.06, 0.075, 0.025) + dS * 0.05;
    vec3 body = floorC * T + murk * (1.0 - T);
    // its own light: luminous veins drifting through a darker body, brightest where deep and
    // where it eats
    float fineFlow = (noise3(vec3(xz * 3.4 + sd, uTime * 0.12)) - 0.5) * (1.0 - smoothstep(0.003, 0.012, pxw));
    float sw = noise3(vec3(xz * 0.45 + sd, uTime * 0.035)) * 0.6 + noise3(vec3(xz * 1.3 + sd.yx, uTime * 0.06 + 0.5)) * 0.4 + fineFlow * 0.3;
    float vein = smoothstep(0.3, 0.8, sw);
    float deep = 1.0 - exp(-depth * 110.0);
    vec3 emit = mix(uGlowCol, uHotCol, 0.2 + 0.5 * boil) * deep * (0.15 + 0.85 * vein * vein) * (0.4 + 0.6 * react + 0.8 * boil) * 0.7;
    vec3 liq = mix(body, refl, F) + spec + sS + emit;

    // froth where it reacts (along what stands in it, a little along its eating front), in clumps
    float clump = smoothstep(0.38, 0.62, texture(uStoneNoise, xz * 0.6 + sd * 1.3).g);
    float foamW = clamp(boil * 1.3 * (0.35 + 0.65 * clump) + smoothstep(0.08, 0.0, h) * 0.3 * react * clump, 0.0, 1.0);
    if (foamW > 0.02) {
      vec3 nb1, nb2;
      float c1 = froth(xz, 0.034, foamW * 0.6, 0.8, nb1);
      float c2 = froth(xz + 0.37, 0.012, foamW * 0.9, 1.5, nb2);
      // cells smaller than a few pixels fade to their mean (no shimmer): fine froth reads milky
      float s1 = smoothstep(1.5, 4.0, 0.034 / pxw), s2 = smoothstep(1.5, 4.0, 0.012 / pxw);
      bool one = c1 * s1 > 0.0;
      float fc = one ? c1 : max(mix(foamW * 0.3, c1, s1), mix(foamW * 0.45, c2, s2));
      float sharp = one ? s1 : s2;
      vec3 nf = normalize(mix(vec3(0.0, 1.0, 0.0), one ? nb1 : nb2, sharp * 0.9));
      float NoVf = max(dot(nf, v), 0.0);
      vec3 rf = reflect(-v, nf);
      // big domes are clear (the liquid through a film, glints, a bright rim), small ones milky
      float milk = one ? 0.12 : mix(0.75, 0.45, s2);
      vec3 milkCol = (uAmbient * 1.5 + uSunColor * max(dot(nf, uSunDir), 0.0) * 0.5) * vec3(0.6, 0.64, 0.48) + uHotCol * (0.15 + 0.4 * boil);
      float Ff = fresnel(NoVf, 0.03);
      vec3 foamCol = mix(liq * 0.9 + uHotCol * 0.06, milkCol, milk) * (1.0 - Ff) + envReflect(rf, 0.04) * Ff
                   + uSunColor * pow(max(dot(rf, uSunDir), 0.0), 500.0) * 8.0 * sharp
                   + uHotCol * 0.35 * pow(1.0 - NoVf, 3.0) * sharp;
      liq = mix(liq, foamCol, fc);
    }
    col = mix(col, liq, cov);
    alpha = max(alpha, cov);
  }
  fragColor = vec4(col, alpha);
}`;

// --- corrosion cloud: raymarched body (Volumes) ---------------------------------------------------
const CLOUD_GLSL = /* glsl */`
uniform vec4 uCloud;       // glow, age s, density 0..1, seed
uniform vec4 uCloudShape;  // slump 0..1, -, -, -
uniform vec3 uCloudGlow;   // linear glow colour
uniform vec3 uCloudAlb;    // gas albedo, linear (pale yellow-green)
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  float age = uCloud.y, rr = length(pl.xz), slump = uCloudShape.x;
  // slow roll about the vertical (faster inside); the gas pattern drifts down (heavy)
  float ang = age * (0.12 + 0.2 * (1.0 - rr)), ca = cos(ang), sa = sin(ang);
  vec3 q = vec3(ca * pl.x - sa * pl.z, pl.y, sa * pl.x + ca * pl.z) * uVolScale;
  q.y += age * 0.16;
  q = q * 0.3 + uCloud.w;
  // two taps per sample: the coarse one's worley, the fine one's fbm
  vec4 nc = noise3v(q), nv = noise3v(q * 2.3 + vec3(0.37, age * 0.02, 0.0));
  float n = nc.r * 0.7 + nv.r * 0.3;
  // a domed top; a belly that sags and hangs lobes as the heavy gas slumps
  float body = 1.0 - length(pl * vec3(1.0, pl.y > 0.0 ? 1.15 + 0.45 * slump : 0.9 - 0.15 * slump, 1.0));
  float lobes = (1.0 - smoothstep(-0.6, 0.1, pl.y)) * (nc.g - 0.5) * 0.9;
  float d = body + (n - 0.5) * 1.2 + (nv.g - 0.5) * 0.35 + lobes;
  // faded well inside the bounding sphere, so the noise never shows its clipped silhouette
  sigma = smoothstep(0.0, 0.3, d) * 1.5 * uCloud.z * smoothstep(1.0, 0.55, length(pl));
  albedo = uCloudAlb;
  // glowing droplet pockets drifting in the core, breathing; their light fills the gas round them
  float core = smoothstep(0.12, 0.7, d);
  float pocket = smoothstep(0.52, 0.85, nv.r) * 4.0;
  float pulse = 0.6 + 0.4 * sin(age * 1.7 + n * 11.0);
  emission = uCloudGlow * uCloud.x * (core * core * (0.01 + 0.2 * pocket) * pulse) * sigma;
}`;

const SPL = { x: 0, z: 0, radius: 1, acid: 0, pattern: 'noise', seed: 0 };   // reused ground splat
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export default {
  id: 'acid', name: 'Acid', key: '9', hue: '#8aff3c',
  shape: 'projectile', forms: ['Toxic Bloom', 'Corrosion Cloud'], radius: 0.3,
  lob: 4,   // cast.js: gravity on in flight; phase 'travel' replaces the launch with an exact arc
  params: { size: 1, speed: 10, glow: 1, drips: 1, fog: 1, bubbles: 1, iridescence: 0.35, corrosion: 1, cloudTime: 8, color: '#7cff2a', fogColor: '#bfd895', cloudColor: '#bfe08a' },
  ranges: {
    size: [0.4, 2.5, 0.01], speed: [4, 30, 0.1], glow: [0, 3, 0.01], drips: [0, 3, 0.01], fog: [0, 2, 0.01],
    bubbles: [0, 3, 0.01], iridescence: [0, 1, 0.01], corrosion: [0, 2, 0.01], cloudTime: [3, 15, 0.1],
  },
  presets: {
    bile: { color: '#d8ff3a', fogColor: '#dcd8a0', cloudColor: '#e0eb86', glow: 0.85 },
    venom: { color: '#c24dff', fogColor: '#d2c0dc', cloudColor: '#b98ad8', bubbles: 1.6 },
    radioactive: { color: '#a0ff00', fogColor: '#c8e2a8', cloudColor: '#b0f070', glow: 2.2, fog: 0.7, iridescence: 0.15 },
  },
  timing: { charge: 0.6, impact: 0.3, linger: 6 },
  kinds: {
    // a falling drop of acid; on landing it bounces into a spit (morph) that etches the floor
    drip: { style: 'glow', drag: 0.25, gravity: 9.8, restitution: 0.45, friction: 0.6, life: [1.4, 2.2], size: [0.018, 0.012], stretch: 0.014, emissive: 1.0, color: ['#c8ff70', '#3c8a10'], alpha: [1, 0.85], fadeIn: 0.02, fadeOut: 0.1, paints: 'acid', paintAmount: 0.25, morph: 'acid.sizzle', forceResponse: 0.2 },
    // spits: tiny hot droplets thrown up by the reaction and by bursting froth; never lie on the floor
    sizzle: { style: 'glow', drag: 1.2, gravity: 6, life: [0.12, 0.35], size: [0.011, 0.004], stretch: 0.012, emissive: 5, color: ['#f6ffd0', '#7cff2a'], alpha: [1, 0], fadeIn: 0.01, fadeOut: 0.4, restitution: -1, paints: 'acid', paintAmount: 0.18 },
    // heavy vapour: pale, lit by the sun and the liquid's glow, rolling out along the floor
    fog: { style: 'media', drag: 0.9, buoyancy: -2.2, curl: 0.9, curlScale: 0.14, life: [2.8, 4.8], size: [0.32, 0.95], sizePow: 0.5, emissive: 0, color: ['#bfd895', '#7a8a5a'], alpha: [0.22, 0], fadeIn: 0.12, fadeOut: 0.5, density: 0.8, erosion: 0.85, restitution: 0, friction: 0.03, lightResponse: 0.8, forceResponse: 0.8 },
    // droplet haze over the liquid: pale, lit by the sun and the pool, never self-lit
    miasma: { style: 'media', drag: 1.1, buoyancy: -1.6, curl: 1.2, curlScale: 0.18, life: [2.5, 4.5], size: [0.35, 0.9], sizePow: 0.6, emissive: 0, color: ['#b4c88a', '#6f7d50'], alpha: [0.35, 0], fadeIn: 0.15, fadeOut: 0.4, density: 1.6, erosion: 0.75, restitution: 0, friction: 0.05, forceResponse: 0.8, lightResponse: 0.8 },
    // white acrid fumes rising where it reacts
    fume: { style: 'media', drag: 1.4, buoyancy: 0.55, curl: 1.2, curlScale: 0.3, life: [1.4, 2.8], size: [0.12, 0.85], sizePow: 0.7, emissive: 0, color: ['#eef2e2', '#b9c2a8'], alpha: [0.3, 0], fadeIn: 0.15, density: 1.6, erosion: 0.6, lightResponse: 0.9 },
    // droplets drawn in while the blob gathers
    bead: { style: 'glow', drag: 1.5, life: [0.4, 0.8], size: [0.013, 0.006], stretch: 0.01, emissive: 3, color: ['#e8ffa8', '#7cff2a'], alpha: [0.2, 1], fadeIn: 0.3, fadeOut: 0.1, restitution: -1 },
  },

  create(fx) {
    const S = this, P = fx.particles, Q = fx.Q;
    const dripE = P.emitter('acid.drip', { shape: 'sphere', radius: 0.22, spread: 0.3 });
    const splashE = P.emitter('acid.drip', { shape: 'sphere', radius: 0.3, spread: 1.5, radial: 3.2 });
    const rainE = P.emitter('acid.drip', { shape: 'disk', radius: 2, spread: 0.15 });
    const runE = P.emitter('acid.drip', { shape: 'ring', radius: 0.3, spread: 0.05 });
    const sizzleE = P.emitter('acid.sizzle', { shape: 'disk', radius: 1.6, spread: 1.2 });
    const spitE = P.emitter('acid.sizzle', { shape: 'ring', radius: 0.36, spread: 0.9 });
    const popE = P.emitter('acid.sizzle', { shape: 'sphere', radius: 0.02, spread: 0.7 });
    const moteE = P.emitter('acid.bead', { shape: 'shell', radius: 1.1, spread: 0.15, radial: -2.2 });
    const fogE = P.emitter('acid.fog', { shape: 'disk', radius: 0.6, spread: 0.6, radial: 3.6 });
    const miasmaE = P.emitter('acid.miasma', { shape: 'disk', radius: 0.8, spread: 0.5, radial: 2.4 });
    const vaporE = P.emitter('acid.fume', { shape: 'sphere', radius: 0.25, spread: 0.4, size: 0.7, life: 0.6 });
    const steamE = P.emitter('acid.fume', { shape: 'ring', radius: 0.32, spread: 0.25 });
    const puffE = P.emitter('acid.fume', { shape: 'sphere', radius: 0.02, spread: 0.15, size: 0.35, life: 0.6 });
    const cloudE = P.emitter('acid.fog', { shape: 'sphere', radius: 2.2, spread: 0.3, life: 0.6 });
    const sinkE = P.emitter('acid.fog', { shape: 'disk', radius: 1.8, spread: 0.3 });
    const glowE = P.emitter('acid.miasma', { shape: 'sphere', radius: 1.6, spread: 0.3 });
    // the field fumes and spits by itself wherever it holds strong acid (anyone's)
    P.fieldEmitter('acid.fume', { slots: 768, b: [0, 1, 0, 0], threshold: 0.35, rate: 5, up: 0.25 });
    P.fieldEmitter('acid.sizzle', { slots: 256, b: [0, 1, 0, 0], threshold: 0.6, rate: 8, up: 1.1 });

    // --- froth domes ---------------------------------------------------------------------------
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(N_BUB * 4), 4); a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a; };
    const A0 = attr('aB0'), A1 = attr('aB1'), A2 = attr('aB2');
    const B0 = A0.array, B1 = A1.array, B2 = A2.array;
    geo.instanceCount = 0;
    const bubU = { uNow: { value: 0 }, uTint: { value: new THREE.Color() }, uHot: { value: new THREE.Color() }, uIri: { value: new THREE.Vector2(1, 0.35) } };
    const bubbles = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: BUBBLE_VERT, fragmentShader: BUBBLE_FRAG,
      uniforms: { ...fx.U, ...bubU }, ...FX_BLENDING,
    }));
    bubbles.frustumCulled = false;
    bubbles.visible = false;
    fx.scenes.fx.add(bubbles);
    let now = 0, ring = 0, bubbleUntil = -1, dirty = false;

    function spawnBubble(x, z, r, life, delay, drift) {
      const i = ring++ % N_BUB, o = i * 4, a = fx.rand() * 6.2832;
      B0[o] = x; B0[o + 1] = SURF; B0[o + 2] = z; B0[o + 3] = now + delay;
      B1[o] = r; B1[o + 1] = life; B1[o + 2] = 0; B1[o + 3] = fx.rand();
      B2[o] = Math.cos(a) * drift; B2[o + 1] = Math.sin(a) * drift; B2[o + 2] = r * (0.1 + 0.3 * fx.rand()); B2[o + 3] = 2 + 4 * fx.rand();
      bubbleUntil = Math.max(bubbleUntil, now + delay + life + POP);
      dirty = true;
    }
    function bubbleAt(i, tau, out) {
      const o = i * 4, ph = B1[o + 3] * 6.2832;
      return out.set(
        B0[o] + B2[o] * tau + B2[o + 2] * Math.sin(B2[o + 3] * tau + ph),
        B0[o + 1],
        B0[o + 2] + B2[o + 1] * tau + B2[o + 2] * Math.cos(B2[o + 3] * 0.83 * tau + B1[o + 3] * 11));
    }
    // a clump of froth round (x, z): mixed sizes, mostly small, a few big boil domes (share big)
    function froth(x, z, spread, n, big, delay) {
      n *= Q.emission * Q.auto.emission;
      n = Math.floor(n + fx.rand());
      for (let k = 0; k < n; k++) {
        const a = fx.rand() * 6.2832, d = Math.sqrt(fx.rand()) * spread, u = fx.rand();
        const boil = fx.rand() < big;
        const r = boil ? 0.02 + 0.035 * fx.rand() : 0.004 + 0.016 * u * u;
        const life = boil ? 0.25 + 0.4 * fx.rand() : 0.4 + 1.5 * fx.rand();
        spawnBubble(x + Math.cos(a) * d, z + Math.sin(a) * d, r, life, delay * fx.rand(), 0.005 + 0.025 * fx.rand());
      }
    }

    // --- standing liquid layers (refract pass), one per live cast ------------------------------
    const poolGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    const pools = [];
    for (let i = 0; i < MAX_POOLS; i++) {
      const u = {
        uPoolA: { value: new THREE.Vector4() }, uPoolB: { value: new THREE.Vector4() },
        uGlowCol: { value: new THREE.Color() }, uHotCol: { value: new THREE.Color() }, uAbsorb: { value: new THREE.Color() },
      };
      const m = new THREE.Mesh(poolGeo, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
        uniforms: { ...fx.U, uStoneNoise: arenaUniforms.uStoneNoise, ...u },
        transparent: true, depthWrite: false, blending: THREE.NormalBlending,
      }));
      m.visible = false;
      m.renderOrder = -1;   // under the other refract-pass translucents
      fx.scenes.refract.add(m);
      pools.push({ mesh: m, u, busy: false });
    }
    function poolAcquire(x, z, R, seed) {
      for (const pl of pools) if (!pl.busy) {
        pl.busy = true;
        pl.mesh.visible = true;
        pl.mesh.position.set(x, 0.005, z);
        pl.mesh.scale.set(R, 1, R);
        pl.u.uPoolA.value.set(x, z, R, 0);
        pl.u.uPoolB.value.set(0, 0, 0, (seed % 97) * 0.0731);
        return pl;
      }
      return null;
    }
    function poolRelease(pl) { if (pl) { pl.busy = false; pl.mesh.visible = false; } }
    function poolStyle(pl, p, liquid, react) {
      const u = pl.u;
      u.uPoolA.value.w = liquid;
      u.uPoolB.value.x = react; u.uPoolB.value.z = p.corrosion;
      u.uGlowCol.value.copy(glowLin).multiplyScalar(1.1 * p.glow);
      u.uHotCol.value.copy(hotLin).multiplyScalar(1.4 * p.glow);
      // murky: blue and red absorbed, the liquid's own hue transmitted
      const c = glowLin;
      u.uAbsorb.value.setRGB(6 + 30 * (1 - c.r) ** 1.5, 6 + 30 * (1 - c.g) ** 1.5, 6 + 30 * (1 - c.b) ** 1.5);
    }

    // --- the gas: the shared fluid, in its soot channel ------------------------------------------
    const fluid = FluidVolume.get(fx);
    // shares the fluid's render program, so warming this spell alone compiles it
    const fluidStub = new THREE.Mesh(poolGeo, fluid.domains[0].material);
    fluidStub.visible = false; fluidStub.frustumCulled = false;
    fx.scenes.fx.add(fluidStub);
    const SRC = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), radius: 1, fuel: 0, temp: 0, soot: 0, radial: 0, noise: 0, noiseScale: 1, seed: 0, coupling: 0, burst: false };
    function gasSrc(f, x, y, z, radius, soot, temp, burst, noise, noiseScale, seed, vx, vy, vz, radial, coupling) {
      SRC.pos.set(x, y, z); SRC.radius = radius; SRC.soot = soot; SRC.temp = temp; SRC.burst = burst; SRC.noise = noise; SRC.noiseScale = noiseScale; SRC.seed = seed;
      SRC.vel.set(vx, vy, vz); SRC.radial = radial; SRC.coupling = coupling;
      f.emit(SRC);
    }

    // --- per-cast state (indexed by the cast record, preallocated) ------------------------------
    const clouds = [];
    for (let i = 0; i < 2; i++) {
      const v = fx.volumes.add({
        shape: 'sphere', glsl: CLOUD_GLSL, maxSteps: 12,
        uniforms: { uCloud: { value: new THREE.Vector4() }, uCloudShape: { value: new THREE.Vector4() }, uCloudGlow: { value: new THREE.Color() }, uCloudAlb: { value: new THREE.Color() } },
      });
      v.g = 0.35; v.ambient = 1.1; v.sun = 1.0;
      clouds.push(v);
    }
    const st = Array.from({ length: 16 }, () => ({
      orb: null, light: null, vortex: null, cloud: null, gas: null, pool: null,
      blob: new Float32Array(8 * 8), splashT: -1, splashFall: true, nextSplat: 0, froth: 0,
    }));
    const col = new THREE.Color(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
    const glowLin = new THREE.Color(), hotLin = new THREE.Color(), _white = new THREE.Color(1, 1, 1), _hot = new THREE.Color(1, 1, 0.72);
    let kindsColor = '', kindsFog = '';

    // particle and metaball colours follow the params (texels only, nothing recompiles)
    const hex = (c) => `#${c.getHexString()}`;
    function syncColors() {
      const p = S.params;
      glowLin.set(p.color);
      hotLin.copy(glowLin).lerp(_hot, 0.45);
      if (p.color === kindsColor && p.fogColor === kindsFog) return;
      kindsColor = p.color; kindsFog = p.fogColor;
      const dark = hex(col.set(p.color).multiplyScalar(0.3)), light = hex(col.set(p.color).lerp(_white, 0.7)), drop = hex(col.set(p.color).lerp(_white, 0.3));
      P.setKind('acid.drip', { color: [drop, dark] });
      P.setKind('acid.sizzle', { color: [light, p.color] });
      P.setKind('acid.bead', { color: [light, p.color] });
      P.setKind('acid.miasma', { color: [hex(col.set(p.fogColor).lerp(glowLin, 0.2)), hex(col.set(p.fogColor).lerp(glowLin, 0.2).multiplyScalar(0.55))] });   // pale gas, a hint of the acid's hue
      P.setKind('acid.fog', { color: [p.fogColor, hex(col.set(p.fogColor).multiplyScalar(0.6))] });
      P.setKind('acid.fume', { color: [hex(col.set(p.fogColor).lerp(_white, 0.7)), hex(col.set(p.fogColor).lerp(_white, 0.25).multiplyScalar(0.85))] });
    }

    // === BLOB: the liquid body (charge, flight, splash). Swap these five for the shared particle
    // fluid's 'acid' preset when it lands; nothing else touches s.orb or s.blob. ==================
    function blobAcquire(s, p) {
      s.orb = fx.metaballs?.acquire({ preset: 'acid' }) ?? null;
      if (s.orb) blobStyle(s.orb, p);
    }
    function blobStyle(h, p) {
      const c = glowLin;
      h.emission.copy(c).lerp(hotLin, 0.3).multiplyScalar(4.5 * p.glow);
      h.scatterColor.copy(c).multiplyScalar(0.05);
      h.absorption.setRGB(2.5 + 25 * (1 - c.r) ** 2, 2.5 + 25 * (1 - c.g) ** 2, 2.5 + 25 * (1 - c.b) ** 2);
      h.wobble = 0.03;
      h.turbidity = 14;   // murky: the floor under a bead shouldn't show through
      h.bubbles = 0.5;
    }
    // the gathering / flying blob: a core, four churning satellites, a teardrop tail and a drop
    // tearing off it (vel null while it gathers)
    function blobShape(s, pos, R, t, vel, spiral) {
      const h = s.orb;
      if (!h) return;
      h.set(0, pos.x, pos.y, pos.z, R * 0.3 * (1 + 0.07 * Math.sin(t * 7.3)));
      for (let i = 1; i <= 4; i++) {
        const a = t * (1.9 + i * 0.37) + i * 2.4, b = t * 1.3 + i * 1.7;
        const d = R * (0.19 + 0.05 * Math.sin(t * 3.1 + i)) + spiral;
        h.set(i, pos.x + d * Math.cos(a) * Math.cos(b), pos.y + d * Math.sin(b), pos.z + d * Math.sin(a) * Math.cos(b), R * (0.15 + 0.04 * Math.sin(t * 4.7 + i * 2.1)));
      }
      if (!vel) { h.count = 5; return; }
      _a.copy(vel).normalize();
      for (let j = 0; j < 2; j++) {
        const back = R * (0.3 + 0.18 * j);
        h.set(5 + j, pos.x - _a.x * back, pos.y - _a.y * back - 0.03 * j, pos.z - _a.z * back, R * (0.17 - 0.06 * j));
      }
      const u = (t * 1.7) % 1, back = R * (0.42 + 0.9 * u);
      h.set(7, pos.x - _a.x * back, pos.y - _a.y * back - 0.5 * u * u * R, pos.z - _a.z * back, R * 0.1 * (1 - u * u));
      h.count = 8;
    }
    // impact: the blob breaks into 8 (fall: they slap the floor and flatten into beads, the ones
    // that hit the target cling and ooze down it; burst: they blow outward and thin out)
    // B per blob: x y z, vx vy vz, r0, stuck
    function blobSplash(s, pos, size, fall) {
      const B = s.blob;
      for (let i = 0; i < 8; i++) {
        const o = i * 8, a = fx.rand() * 6.2832, sp = i === 0 ? 0.3 : (fall ? 1.2 + 2.4 * fx.rand() : 2.5 + 2 * fx.rand());
        const up = i === 0 ? -0.5 : (fall ? 0.4 + 1.8 * fx.rand() : (fx.rand() - 0.3) * 3);
        B[o] = pos.x; B[o + 1] = pos.y; B[o + 2] = pos.z;
        B[o + 3] = Math.cos(a) * sp; B[o + 4] = up; B[o + 5] = Math.sin(a) * sp;
        B[o + 6] = size * (i === 0 ? 0.26 : 0.07 + 0.08 * fx.rand());
        B[o + 7] = 0;
      }
      s.splashT = 0; s.splashFall = fall;
      if (s.orb) s.orb.bubbles = 0.15;
    }
    function blobUpdate(s, dt, dm) {
      const h = s.orb, B = s.blob;
      s.splashT += dt;
      const dur = s.splashFall ? 1.8 : 0.45, u = s.splashT / dur;
      if (u >= 1 || !h) { blobRelease(s); return; }
      for (let i = 0; i < 8; i++) {
        const o = i * 8;
        if (s.splashFall) B[o + 4] -= 9.81 * dt; else { B[o + 3] *= 0.9; B[o + 4] *= 0.9; B[o + 5] *= 0.9; }
        B[o] += B[o + 3] * dt; B[o + 1] += B[o + 4] * dt; B[o + 2] += B[o + 5] * dt;
        // fall: the beads drain into the pool layer over the second half (they shrink)
        const r = s.splashFall ? B[o + 6] * (1 - sstep(0.3, 1, u)) ** 0.7 : B[o + 6] * (1 - u) ** 0.6;
        if (s.splashFall && dm) {
          // clinging to the target: held on its surface, sliding down slowly
          const dx = B[o] - dm.pos.x, dz = B[o + 2] - dm.pos.z, d = Math.hypot(dx, dz), lim = 0.3 + r * 0.35;
          if (d < lim && B[o + 1] > 0.25 && B[o + 1] < 1.75) {
            const k = lim / Math.max(d, 1e-3);
            B[o] = dm.pos.x + dx * k; B[o + 2] = dm.pos.z + dz * k;
            B[o + 3] = 0; B[o + 5] = 0; B[o + 4] = Math.max(B[o + 4], -0.35);
          }
        }
        // on the floor: a flattened bead (centre below the floor), sliding to a stop
        const fy = -0.45 * r;
        if (s.splashFall && B[o + 1] < fy) { B[o + 1] = fy; B[o + 4] = 0; const f = Math.exp(-dt * 6); B[o + 3] *= f; B[o + 5] *= f; }
        h.set(i, B[o], B[o + 1], B[o + 2], r);
      }
      h.count = 8;
    }
    function blobRelease(s) { s.orb?.release(); s.orb = null; s.splashT = -1; }
    // === end BLOB ================================================================================

    function dissolveNear(x, z, R, base, add) {
      for (const dm of fx.dummies) {
        const d = Math.hypot(dm.pos.x - x, dm.pos.z - z);
        if (d < R) {
          dm.status.dissolve = Math.max(dm.status.dissolve, base * (1 - d / R) + add);
          dm.hit(_b.set(dm.pos.x - x, 0, dm.pos.z - z), 0.35 * (1 - d / R));
        }
      }
    }
    // a dummy being eaten: acid running off its bulge and arm tips, white fumes off its body,
    // spits round its foot where the pool boils against it (k 0..1)
    function eatDummy(dm, k, dt) {
      const p = S.params;
      // a few fixed drip points: under the sack's bulge and at the arm tips
      const j = Math.floor(fx.rand() * 6), a = dm.pos.x * 1.7 + dm.pos.z * 2.3 + j * 2.1;
      if (j < 4) runE.pos.set(dm.pos.x + Math.cos(a) * 0.27, 0.78, dm.pos.z + Math.sin(a) * 0.22);
      else runE.pos.set(dm.pos.x + (j === 4 ? -0.58 : 0.58), 1.22, dm.pos.z);
      runE.radius = 0.01; runE.vel.set(0, -0.1, 0); runE.rate(14 * k * p.drips, dt);
      steamE.pos.set(dm.pos.x, 0.15 + 1.3 * fx.rand(), dm.pos.z); steamE.radius = 0.32; steamE.vel.set(0, 0.25, 0); steamE.size = 0.7; steamE.rate(45 * k * p.fog, dt);
      spitE.pos.set(dm.pos.x, 0.03, dm.pos.z); spitE.radius = 0.38; spitE.vel.set(0, 1.4, 0); spitE.rate(90 * k * p.glow, dt);
    }

    return {
      onParam(k) { if (k === 'color' || k === 'fogColor') syncColors(); },

      phase(c, name) {
        const p = S.params, s = st[c.index], size = p.size, cloud = c.form === 'Corrosion Cloud';
        if (name === 'charge') {
          syncColors();
          s.splashT = -1; s.nextSplat = 0; s.froth = 0; s.cloud = null; s.gas = null; s.vortex = null; s.pool = null;
          c.durations.linger = cloud ? p.cloudTime : S.timing.linger;
          blobAcquire(s, p);
          s.light = fx.lights.acquire();
          if (s.light) { s.light.range = 7; s.light.intensity = 0; s.light.color.copy(glowLin); s.light.shadow = true; }
        } else if (name === 'release') {
          fx.rig.shake(0.08, 9);
        } else if (name === 'travel') {
          // an exact ballistic arc onto the target: flight time from the horizontal speed
          const D = Math.hypot(c.to.x - c.pos.x, c.to.z - c.pos.z), T = Math.max(0.35, D / Math.max(p.speed, 1));
          c.vel.subVectors(c.to, c.pos).multiplyScalar(1 / T);
          c.vel.y += 0.5 * 9.81 * T;
        } else if (name === 'impact') {
          if (s.orb) blobSplash(s, c.pos, size, !cloud);
          if (cloud) bloomCloud(c, p, s);
          else bloom(c, p, s);
        } else if (name === 'done') {
          blobRelease(s);
          s.light?.release(); s.light = null;
          s.vortex?.release(); s.vortex = null;
          if (s.cloud) s.cloud.visible = false;
          s.cloud = null;
          s.gas?.release(); s.gas = null;
          poolRelease(s.pool); s.pool = null;
        }
      },

      update(c, dt) {
        const p = S.params, s = st[c.index], L = s.light, size = p.size, cloud = c.form === 'Corrosion Cloud';
        const flick = 0.85 + 0.15 * Math.sin(c.age * 23 + c.seed) * Math.sin(c.age * 9.1);
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge;
          if (s.orb) { blobStyle(s.orb, p); blobShape(s, c.pos, size * (0.15 + 0.85 * (1 - (1 - k) ** 2)), c.age, null, (1 - k) * 0.5 * size); }
          moteE.pos.copy(c.pos); moteE.rate(260 * k * p.glow, dt);
          vaporE.pos.copy(c.pos); vaporE.vel.set(0, 0, 0); vaporE.radius = 0.3 * size; vaporE.size = 0.5 * size; vaporE.rate(20 * k * p.fog, dt);
          if (L) { L.pos.copy(c.pos); L.intensity = 6 * k * flick * p.glow; }
        } else if (c.phase === 'travel') {
          blobShape(s, c.pos, size, c.age, c.vel, 0);
          dripE.pos.copy(c.pos); dripE.vel.copy(c.vel).multiplyScalar(0.25); dripE.radius = 0.22 * size; dripE.rate(110 * p.drips, dt);
          vaporE.pos.copy(c.pos); vaporE.vel.copy(c.vel).multiplyScalar(0.1); vaporE.radius = 0.25 * size; vaporE.size = 0.7 * size; vaporE.rate(60 * p.fog, dt);
          if (L) { L.pos.copy(c.pos); L.intensity = 9 * flick * p.glow; }
        } else {
          if (s.splashT >= 0) blobUpdate(s, dt, c.target >= 0 ? fx.dummies[c.target] : null);
          if (cloud) updateCloud(c, p, s, dt, flick);
          else updatePool(c, p, s, dt, flick);
        }
      },

      // froth domes: clock, pops, upload (main calls this every frame)
      tick(dt) {
        const prev = now;
        now += dt;
        if (bubbleUntil < now - 0.5) { bubbles.visible = false; return; }
        bubbles.visible = true;
        geo.instanceCount = N_BUB;
        bubU.uNow.value = now;
        bubU.uIri.value.set(1, S.params.iridescence);
        bubU.uTint.value.copy(glowLin).multiplyScalar(0.35 * S.params.glow);
        bubU.uHot.value.copy(hotLin).multiplyScalar(S.params.glow);
        if (dirty) { A0.needsUpdate = A1.needsUpdate = A2.needsUpdate = true; dirty = false; }
        // pops: spits (and a wisp off the big ones) where the dome was, at most 4 a frame
        let pops = 0;
        for (let i = 0; i < N_BUB && pops < 4; i++) {
          const o = i * 4, life = B1[o + 1], tau = now - B0[o + 3];
          if (life <= 0 || tau < life || prev - B0[o + 3] >= life) continue;
          const r = B1[o];
          if (r < 0.006 && fx.rand() < 0.7) continue;
          bubbleAt(i, life, popE.pos);
          popE.radius = r; popE.vel.set(0, 0.8 + 30 * r, 0); popE.burst(1 + r * 140);
          if (r > 0.014) { puffE.pos.copy(popE.pos); puffE.size = 0.25 + 6 * r; puffE.burst(1); }
          pops++;
        }
      },
    };

    // --- Toxic Bloom impact ---------------------------------------------------------------------
    function bloom(c, p, s) {
      const pos = c.pos, size = p.size;
      const R = 2.6 * size;
      splashE.pos.copy(pos); splashE.vel.set(0, 1.2, 0); splashE.radius = 0.3 * size; splashE.burst(180 * p.drips);
      sizzleE.pos.copy(pos).setY(0.05); sizzleE.radius = 0.9 * size; sizzleE.vel.set(0, 1.6, 0); sizzleE.burst(160 * p.glow);
      fogE.pos.copy(pos).setY(0.25); fogE.radius = 0.8 * size; fogE.radial = 4.2 * size; fogE.size = size; fogE.burst(150 * p.fog);
      vaporE.pos.copy(pos).setY(0.4); vaporE.vel.set(0, 0.8, 0); vaporE.radius = 0.5 * size; vaporE.size = 1.2 * size; vaporE.burst(50 * p.fog);
      miasmaE.pos.copy(pos).setY(0.2); miasmaE.radius = 0.7 * size; miasmaE.size = 0.8 * size; miasmaE.burst(30 * p.fog);
      SPL.x = pos.x; SPL.z = pos.z; SPL.pattern = 'noise';
      SPL.radius = 1.4 * size; SPL.acid = 0.85 * p.corrosion; SPL.seed = c.seed % 97; fx.ground.splat(SPL);
      SPL.pattern = 'radial'; SPL.radius = 0.7 * size; SPL.acid = 0.6 * p.corrosion; SPL.seed = c.seed % 89; fx.ground.splat(SPL);
      fx.shocks?.spawn({ pos: _a.copy(pos).setY(0.05), radius0: 0.3, radius1: 3.2 * size, duration: 0.45, thickness: 0.5, distortion: 0.025, ground: true, intensity: 0 });
      s.pool = poolAcquire(pos.x, pos.z, 3.4 * size, c.seed);
      // the first violent froth: at the target's foot and scattered through the splash
      for (let k = 0; k < 14; k++) {
        const a = fx.rand() * 6.2832, d = 0.3 + 1.2 * Math.sqrt(fx.rand()) * size;
        froth(pos.x + Math.cos(a) * d, pos.z + Math.sin(a) * d, 0.12, 9 * p.bubbles, 0.12, 0.5);
      }
      dissolveNear(pos.x, pos.z, R, 0.45 * p.corrosion, 0.2 * p.corrosion);
      if (c.target >= 0) { const dm = fx.dummies[c.target]; dm.status.dissolve = Math.max(dm.status.dissolve, 0.6 * p.corrosion); }
      if (s.light) { s.light.intensity = 12 * p.glow; s.light.range = 9 * size; s.light.pos.copy(pos).setY(Math.max(pos.y, 0.5)); }
      fx.flash(0.06 * p.glow);
      fx.rig.shake(0.25, 14);
      if (!fx.reduced) fx.rig.punch(1.2, 0.06);
      s.nextSplat = 0.1;
    }
    // the pool spreads for a second, rolls vapour out, then glows, froths and fumes while it eats;
    // over the last two seconds it soaks in (the liquid layer shrinks to beads and goes)
    function updatePool(c, p, s, dt, flick) {
      const size = p.size, pos = c.pos;
      const T = c.phase === 'impact' ? c.t : c.durations.impact + c.t;
      const left = c.durations.impact + c.durations.linger - T;
      const fade = clamp01(left / 2.5), react = (0.25 + 0.75 * Math.exp(-T / 2.2)) * fade;
      if (s.pool) poolStyle(s.pool, p, sstep(0, 0.35, T) * (0.35 + 0.65 * fade), react);
      s.nextSplat -= dt;
      if (T < 1.3 && s.nextSplat <= 0) {
        s.nextSplat = 0.12;
        SPL.x = pos.x; SPL.z = pos.z; SPL.pattern = 'noise'; SPL.radius = (1.4 + 1.3 * T) * size; SPL.acid = 0.13 * p.corrosion; SPL.seed = (c.seed + T * 37) % 97;
        fx.ground.splat(SPL);
      }
      if (T < 1.6) {
        const k = 1 - T / 1.6;
        fogE.pos.copy(pos).setY(0.25); fogE.radius = 1.0 * size; fogE.radial = 2.4 * size; fogE.size = size; fogE.rate(240 * p.fog * k, dt);
      }
      // the liquid keeps fuming: a heavy low layer rolling off it, white wisps rising out of it
      fogE.pos.copy(pos).setY(0.15); fogE.radius = 1.4 * size; fogE.radial = 0.9 * size; fogE.size = 0.8 * size; fogE.rate(30 * p.fog * fade, dt);
      vaporE.pos.copy(pos).setY(0.05); vaporE.vel.set(0, 0.4, 0); vaporE.radius = 1.1 * size; vaporE.size = 0.9 * size; vaporE.rate(30 * p.fog * react, dt);
      // froth: clumps where it touches what stands in it, and through the pool
      s.froth += 34 * react * p.bubbles * dt;
      while (s.froth >= 1) {
        s.froth -= 1;
        let x, z;
        const dm = c.target >= 0 ? fx.dummies[c.target] : null;
        if (dm && fx.rand() < 0.55 && Math.hypot(dm.pos.x - pos.x, dm.pos.z - pos.z) < 2 * size) {
          const a = fx.rand() * 6.2832, d = 0.36 + 0.12 * fx.rand();
          x = dm.pos.x + Math.cos(a) * d; z = dm.pos.z + Math.sin(a) * d;
        } else {
          const a = fx.rand() * 6.2832, d = 1.5 * size * Math.sqrt(fx.rand());
          x = pos.x + Math.cos(a) * d; z = pos.z + Math.sin(a) * d;
        }
        froth(x, z, 0.08, 6, 0.08, 0.05);
      }
      // standing in it keeps eating
      for (const dm of fx.dummies) {
        if (Math.hypot(dm.pos.x - pos.x, dm.pos.z - pos.z) > 1.8 * size) continue;
        if (c.phase === 'linger' && left > 1) dm.status.dissolve = Math.min(0.85, dm.status.dissolve + (0.08 + 0.05 * p.corrosion) * dt);
        eatDummy(dm, react, dt);
      }
      if (s.light) {
        const glowT = 4.5 * flick * p.glow * (0.4 + 0.6 * react) * Math.min(1, left / 2);
        s.light.intensity = Math.max(s.light.intensity * Math.exp(-dt / 0.25), glowT);
        s.light.pos.y += (0.6 - s.light.pos.y) * Math.min(1, dt * 4);
      }
    }

    // --- Corrosion Cloud ------------------------------------------------------------------------
    function bloomCloud(c, p, s) {
      const size = p.size, to = c.to;
      s.cloud = null;
      const f = s.gas = fluid.acquire({ size: [15 * size, 3 * size, 15 * size], res: Math.round(fluid.res * 1.3) });
      if (f) {
        f.position.set(to.x, 0.5 * f.size.y - f.h, to.z);
        Object.assign(f, {
          ignition: 10, burnRate: 0, heatPerFuel: 0, sootYield: 0, expansion: 0, cooling: 1.6, radiative: 0, sootDecay: 0.03, fuelDecay: 2,
          buoyancy: 0, sootWeight: 6, vorticity: 6, damping: 0.04, forceCoupling: 0.6,
          // chlorine is never emissive: its colour is absorption and scattering only
          emission: 0, temperature: 2400, sootDensity: 6, flameDensity: 0, fuelDensity: 0, g: 0.3, sun: 1.6, sky: 1.0, fireLight: 0,
          // soft edges that curl into fine wisps (a strong curl displacement), billows broad and low
          // (a light Worley erosion); a camera standing in it sees the near gas thin over metres
          // (a light cell erosion: strong, it carves cumulus cauliflower, cotton wool, where a dense
          // gas rolls in smooth, slumping lobes)
          upres: 2.8, upresScale: 2.2, edgeFade: 4,
          detailFreq: 0.3 / size, detailErode: 0.12, detailHeat: 0, nearFade: 2.6 * size,
          // cost: a wide, mostly thin layer marched end to end. Below 0.05 /m the haze is treated
          // as empty (skipped), and the lattice is 1.4 voxels, for about 0.4 ms at its widest
          emptyBelow: 0.05, stepScale: 1.4,
        });
        f.detailCenter.set(to.x, 0, to.z);
        // chlorine reads near off-white where thin and yellow-green where deep: a pale albedo, the
        // colour coming from the light losing red and blue on its way in (chroma). The arena's low sun
        // and sky are both orange (sun ~ 3.1 : 1.2 : 0.24), which turns any yellow-green albedo khaki:
        // the albedo's red is pulled down so the lit gas reads as Jack Rabbit II's pale yellow-green
        f.sootColor.set(p.cloudColor);
        f.sootColor.r *= 0.72; f.sootColor.b *= 1.25;
        f.sootColor.lerp(_white, 0.25);
        f.chroma = 1.4;
        f.tint.copy(glowLin);
        // the blob bursts: a dense, lumpy slug over the target, its lobes already slumping outwards
        const sd = c.seed % 97;
        gasSrc(f, to.x, 0.9 * size, to.z, 1.2 * size, 1.9, 0, true, 1, 1.8, sd, 0, -2.6, 0, 2.8, 6);
        for (let i = 0; i < 5; i++) {
          const a = sd + i * 1.2566 + 0.4 * Math.sin(i * 2.3 + sd), r = (0.95 + 0.25 * Math.sin(i * 1.7 + sd)) * size, ca = Math.cos(a), sa = Math.sin(a);
          gasSrc(f, to.x + ca * r, (0.45 + 0.2 * Math.sin(i * 2.9 + sd)) * size, to.z + sa * r, (0.65 + 0.2 * Math.cos(i * 1.3 + sd)) * size, 1.7, 0, true, 1, 2.4, sd + i * 3.1,
            ca * 3.0, -1.6, sa * 3.0, 1.2, 6);
        }
      } else {
        for (const v of clouds) if (!v.visible) { s.cloud = v; break; }
        if (s.cloud) {
          s.cloud.visible = true;
          s.cloud.uniforms.uCloud.value.set(0, 0, 0, (c.seed % 97) * 0.173);
          s.cloud.uniforms.uCloudAlb.value.set(p.cloudColor);
        }
        cloudE.pos.set(to.x, 1.6 * size, to.z); cloudE.radius = 1.2 * size; cloudE.size = 1.4 * size; cloudE.burst(120 * p.fog);
        miasmaE.pos.copy(c.pos); miasmaE.radius = 0.6 * size; miasmaE.size = size; miasmaE.burst(90 * p.fog);
      }
      s.vortex = fx.forces.acquire();
      if (s.vortex) {
        const v = s.vortex;
        v.type = 1; v.p[0] = 0.6 * size; v.p[1] = 2.6 * size; v.p[2] = -0.1; v.p[3] = 0; v.w = 4 * size;
        v.pos.set(to.x, 0, to.z); v.dir.set(0, 1, 0);
      }
      s.pool = poolAcquire(to.x, to.z, 3.6 * size, c.seed);
      sizzleE.pos.copy(c.pos); sizzleE.radius = 0.4 * size; sizzleE.vel.set(0, 0.5, 0); sizzleE.burst(160 * p.glow);
      if (s.light) { s.light.intensity = 3 * p.glow; s.light.range = 8 * size; }
      SPL.x = to.x; SPL.z = to.z; SPL.pattern = 'noise'; SPL.radius = 1.6 * size; SPL.acid = 0.3 * p.corrosion; SPL.seed = c.seed % 91;
      fx.ground.splat(SPL);
      fx.flash(0.05 * p.glow);
      fx.rig.shake(0.18, 10);
      s.nextSplat = 0.5;
    }
    function updateCloud(c, p, s, dt, flick) {
      const size = p.size, to = c.to;
      const T = c.phase === 'impact' ? c.t : c.durations.impact + c.t;
      const left = c.durations.impact + c.durations.linger - T;
      const grow = 1 - Math.exp(-T * 2.2), fade = clamp01(left / 2);
      // heavy gas: it sinks and spreads as it ages, its belly sagging towards the floor
      const sink = sstep(0.3, 0.85 * (c.durations.impact + c.durations.linger), T);
      const f = s.gas;
      const cy = size * (1.75 - 0.8 * sink), R = (f ? 4.6 : 2.5) * size * (0.45 + 0.55 * grow) * (1 + 0.3 * sink);
      const hy = 1.25 * size * (0.5 + 0.5 * grow) * (1 - 0.3 * sink), base = f ? 2.2 * size : cy - 0.65 * hy;
      if (f) {
        // the slug goes on feeding from above for a while, then the floor layer feeds the current; the
        // gas thins fast only at the end
        const seed = c.seed % 97, k = Math.max(0, 1 - T / 1.1);
        if (k > 0) gasSrc(f, to.x, 1.0 * size, to.z, 1.1 * size, 3.2 * k * p.fog, 0, false, 1, 2.2, seed + T * 0.5, 0, -2.0, 0, 2.4, 1.5);
        const k2 = sstep(0.3, 0.8, T) * clamp01((p.cloudTime - 3.5 - T) / 1.5);
        if (k2 > 0) {
          gasSrc(f, to.x, 0.4 * size, to.z, 1.2 * size, 1.2 * k2 * p.fog, 0, false, 1, 1.4, seed + 11 + T * 0.3, 0, -0.1, 0, 2.2, 1.5);
          // the front: lobes pushing out along the floor from under the mass, each on its own heading
          // and clock, so it runs out in tongues with clefts between them (a gravity current's head)
          const front = (1.2 + 2.6 * (1 - Math.exp(-T / 2.2))) * size;
          for (let i = 0; i < 5; i++) {
            const a = i * 1.2566 + seed + 0.5 * Math.sin(T * 0.37 + i * 2.1), w = 0.75 + 0.25 * Math.sin(i * 3.7 + seed), r = front * w;
            const ca = Math.cos(a), sa = Math.sin(a), pulse = Math.sin(T * 1.6 + i * 2.4);
            if (pulse <= 0) continue;   // in surges: each one rolls up its own head
            gasSrc(f, to.x + ca * r, 0.32, to.z + sa * r, (0.55 + 0.35 * w) * size, 1.8 * pulse * pulse * k2 * p.fog, 0, false, 1, 2.6, seed + i * 3 + T * 0.6, ca * 1.5, -0.05, sa * 1.5, 0, 1.8);
          }
        }
        // old gas thins out, so it never fills the box; the layer stops being pressed flat once it has
        // landed, and keeps its billows
        f.sootDecay = 0.2 + 0.3 * sstep(2.5, 5, T) + 1.5 * (1 - fade) * (1 - fade);
        f.sootWeight = 4.2 - 2.4 * sstep(1.2, 3.5, T);   // (heavy: chlorine is 2.5x air, it slumps within a second)
      } else {
        if (s.cloud) {
          s.cloud.position.set(to.x, cy, to.z);
          s.cloud.scale.set(R, hy, R);
          s.cloud.uniforms.uCloud.value.set(0.7 * p.glow, T, grow * fade, s.cloud.uniforms.uCloud.value.w);
          s.cloud.uniforms.uCloudShape.value.x = sink;
          s.cloud.uniforms.uCloudGlow.value.copy(glowLin).lerp(hotLin, 0.3);
        }
        cloudE.pos.set(to.x, cy, to.z); cloudE.radius = 0.75 * R; cloudE.size = 1.3 * size; cloudE.rate(70 * p.fog * fade, dt);
        glowE.pos.set(to.x, cy, to.z); glowE.radius = 0.5 * R; glowE.size = size; glowE.rate(40 * p.fog * fade, dt);
        // gas pouring off its underside, running out along the floor
        sinkE.pos.set(to.x, base, to.z); sinkE.radius = 0.55 * R; sinkE.vel.set(0, -0.7, 0); sinkE.size = size; sinkE.rate(70 * p.fog * fade * grow, dt);
        fogE.pos.set(to.x, 0.2, to.z); fogE.radius = 0.5 * R; fogE.radial = 1.3 * size; fogE.size = 0.9 * size; fogE.rate(45 * p.fog * fade * grow, dt);
      }
      // (a gas leaves condensate, not a lake: scattered beads and small puddles that barely glow)
      if (s.pool) poolStyle(s.pool, p, 0.42 * fade, 0.2 * fade);
      // corrosive rain out of it
      if (T > 0.4) { rainE.pos.set(to.x, base, to.z); rainE.radius = 0.7 * R; rainE.vel.set(0, -1.5, 0); rainE.rate(170 * p.drips * fade, dt); }
      s.nextSplat -= dt;
      if (s.nextSplat <= 0 && fade > 0.2) {
        s.nextSplat = 0.45;
        SPL.x = to.x; SPL.z = to.z; SPL.pattern = 'noise'; SPL.radius = 0.85 * R; SPL.acid = 0.11 * p.corrosion; SPL.seed = (c.seed + T * 13) % 97;
        fx.ground.splat(SPL);
      }
      // where the rain pools it fizzes
      s.froth += 14 * fade * grow * p.bubbles * dt;
      while (s.froth >= 1) {
        s.froth -= 1;
        const a = fx.rand() * 6.2832, d = 0.7 * R * Math.sqrt(fx.rand());
        froth(to.x + Math.cos(a) * d, to.z + Math.sin(a) * d, 0.05, 4, 0.05, 0.05);
      }
      // inside the cloud: dissolving gradually, fuming, running
      if (fade > 0.2) for (const dm of fx.dummies) {
        if (Math.hypot(dm.pos.x - to.x, dm.pos.z - to.z) > R * 0.85) continue;
        dm.status.dissolve = Math.min(0.97, dm.status.dissolve + (0.1 + 0.11 * p.corrosion) * dt);
        eatDummy(dm, 0.5 * grow * fade, dt);
      }
      if (s.light) {
        const pulse = (f ? 0.5 : 1) * (2.6 + 1.1 * Math.sin(T * 2.1) + 0.6 * Math.sin(T * 5.3)) * flick * p.glow * fade * grow;
        s.light.intensity = Math.max(s.light.intensity * Math.exp(-dt / 0.3), pulse);
        s.light.pos.set(to.x, f ? 0.5 : cy * 0.8, to.z);
      }
    }
  },
};
