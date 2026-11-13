import { COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL } from '../../vfx/common.js';
import { REFRACT_GLSL } from '../../vfx/Refraction.js';

// Tsunami meshes (refract pass), one instanced draw each per live wave.
//
// Wave sheet: u runs along the crest (0..1 across the width), v along the profile from the rear
// base, over the crest and the lip, round the lip tip, back under it and down the face to the
// toe. The profile is a uniform Catmull-Rom spline through NP control points; every control point
// is itself a Catmull-Rom blend across NK key poses (swell, wall, pitching lip, barrel, crash,
// bore, spent sheet), so the phase s morphs the shape smoothly. The break peels from the u = 1
// end, the crest line bows back at the ends and drops off there, and low-frequency noise roughens
// the silhouette. The sheet is single-sided: its front faces always look at air, so the far side
// of the water body never costs a fragment.
//
// Splash curtain: where the lip lands, a sheet of ballistic parcels is thrown up and forward (the
// founding water's crown, unrolled along the crash line). Its columns launch one after another as
// the break peels, the rim tears into jets by alpha-clip and the sheet breaks into holes.

export const NP = 12, NK = 7;
export const NU = 96, NV = 132;
export const NUC = 72, NVC = 24;   // (10 rows creased the flying sheet into foil-like facets)

// per control point: water thickness behind the surface (x H), and base whitewater
const TH = [0.02, 0.1, 0.25, 0.4, 0.45, 0.2, 0.03, 0.12, 0.25, 0.45, 0.35, 0.05];
const FO = [0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.1, 0.0, 0.0, 0.1, 0.7];
const arr = (a) => `float[${a.length}](${a.map((x) => x.toFixed(3)).join(', ')})`;

const LATERAL = /* glsl */`
// crest-line height: a plateau that drops off towards the ends
float taper(float u) { float e = abs(2.0 * u - 1.0); return pow(max(1.0 - e * e * e, 0.0), 0.6); }
`;

const WAVE_FUNCS = /* glsl */`
uniform vec2 uPose[${NP * NK}];
uniform vec4 uShape;   // peel, bow (x H), lateral spread in the bore, crash time scale
${NOISE_GLSL}
${LATERAL}
in vec4 iA;   // origin on the floor xyz, seed 0..1
in vec4 iB;   // forward x, forward z, height H (m), width W (m)
in vec4 iC;   // phase s at the centre, travel d (m), dissolve 0..1, age (s)
const float TH[${NP}] = ${arr(TH)};
const float FO[${NP}] = ${arr(FO)};

vec2 cr2(vec2 a, vec2 b, vec2 c, vec2 d, float g) {
  return 0.5 * (2.0 * b + (c - a) * g + (2.0 * a - 5.0 * b + 4.0 * c - d) * g * g + (3.0 * b - a - 3.0 * c + d) * g * g * g);
}
int gK0, gK1, gK2, gK3;
float gF;
void poseWeights(float s) {
  float sc = clamp(s, 0.0, ${(NK - 1).toFixed(1)});
  gK1 = min(int(sc), ${NK - 2});
  gF = sc - float(gK1);
  gK0 = max(gK1 - 1, 0); gK2 = gK1 + 1; gK3 = min(gK1 + 2, ${NK - 1});
}
vec2 pose(int i) {
  return cr2(uPose[gK0 * ${NP} + i], uPose[gK1 * ${NP} + i], uPose[gK2 * ${NP} + i], uPose[gK3 * ${NP} + i], gF);
}
float phaseAt(float u, float s, float seed) {
  float brk = smoothstep(0.8, 2.0, s) * (1.0 - smoothstep(4.5, 5.5, s));
  // three incommensurate waves: irregular along the crest, not a row of equal peaks (tsunami.js mirrors it)
  float jit = (0.07 * sin(u * 7.3 + seed * 6.2831853) + 0.05 * sin(u * 17.9 + seed * 11.0) + 0.03 * sin(u * 31.1 + seed * 4.0)) * brk;
  return max(s + uShape.x * (u - 0.5) + jit, 0.0);   // the break peels from the u = 1 end
}
vec3 wavePos(float u, float v, out float th, out float fo, out float su, out float Hu, out float W) {
  float e = 2.0 * u - 1.0;
  su = phaseAt(u, iC.x, iA.w);
  Hu = iB.z * taper(u) * (1.0 + 0.07 * sin(u * 7.0 + iA.w * 6.2831853));
  poseWeights(su);
  float t = clamp(v, 0.0, 1.0) * ${(NP - 1).toFixed(1)};
  int i = min(int(t), ${NP - 2});
  float g = t - float(i);
  vec2 xy = cr2(pose(max(i - 1, 0)), pose(i), pose(i + 1), pose(min(i + 2, ${NP - 1})), g);
  th = mix(TH[i], TH[i + 1], g);
  fo = mix(FO[i], FO[i + 1], g);
  W = iB.w * (1.0 + uShape.z * smoothstep(3.0, 6.0, iC.x));
  // lumps riding the surface (profile plane, x H): the crest and lip are never a clean line
  vec3 nq = vec3(u * W * 0.11, t * 0.09 - iC.w * 0.12, iA.w);
  // (but the face below the barrel is drawn smooth while it stands: lumps there are vertical folds that
  // each catch the sunset like a draped curtain)
  vec2 lump = (vec2(noise3(nq), noise3(nq + vec3(0.37, 0.0, 0.53))) - 0.5) * 0.09 * smoothstep(0.3, 1.0, su) * step(xy.y, 2.0)
            * (1.0 - 0.7 * smoothstep(7.8, 9.3, t) * (1.0 - smoothstep(3.2, 3.8, su)));
  // once the lip has landed the mass churns: lumpy whitewater, not a smooth hump
  // (broad and low: metre-scale lumps a metre high read as a range of glass peaks; the churn's
  // detail is the foam's billows, in the shading)
  vec3 nc = vec3(u * W * 0.16, t * 0.15 - iC.w * 0.3, iA.w + 0.5);
  float churnK = smoothstep(3.3, 4.3, su) * (1.0 - smoothstep(5.0, 6.0, su));
  // (smooth gradient noise: the Perlin-Worley's cell creases folded the churn into crumpled ridges)
  lump += curl3(nc).xy * 0.05 * churnK;
  // and it heaves: metre-scale lumps rising and collapsing at about 1 Hz (time runs along the noise's
  // third axis, so they boil in place instead of sliding; the curl field's gradient noise is smooth,
  // where the Perlin-Worley's cell creases fold the mesh into crumpled ridges). (ponytail: ~1.5 m is
  // the finest the 96 x 132 sheet carries without spiking the silhouette; finer heave needs more rows)
  lump.y += curl3(vec3(u * W * 0.15, t * 0.2, iA.w * 3.0 + iC.w * 0.3)).x * 0.05 * churnK;
  xy += lump * smoothstep(-0.02, 0.06, xy.y);
  vec3 F = vec3(iB.x, 0.0, iB.y), S = vec3(-iB.y, 0.0, iB.x);
  return iA.xyz + F * (iC.y - uShape.y * iB.z * e * e + xy.x * Hu) + S * (e * 0.5 * W) + vec3(0.0, xy.y * Hu, 0.0);
}
`;

export const WAVE_VERT = WAVE_FUNCS + /* glsl */`
out vec3 vW;
out vec3 vN;
out vec2 vUv;     // u, profile parameter t (0..NP-1)
out vec4 vInfo;   // thickness (m), local phase, local height (m), seed
out vec4 vMisc;   // base foam, dissolve, width (m), age
void main() {
  float u = position.x, v = position.y;
  float th, fo, su, Hu, W, a1, a2, a3, a4, a5;
  vec3 p = wavePos(u, v, th, fo, su, Hu, W);
  float du = ${(1 / NU).toFixed(6)}, dv = ${(1 / NV).toFixed(6)};
  float us = u < 1.0 - 0.5 * du ? du : -du, vs = v < 1.0 - 0.5 * dv ? dv : -dv;
  vec3 pu = (wavePos(u + us, v, a1, a2, a3, a4, a5) - p) * sign(us);
  vec3 pv = (wavePos(u, v + vs, a1, a2, a3, a4, a5) - p) * sign(vs);
  vec3 n = cross(pu, pv);
  vN = dot(n, n) > 1e-14 ? normalize(n) : vec3(0.0, 1.0, 0.0);
  vW = p;
  vUv = vec2(u, v * ${(NP - 1).toFixed(1)});
  vInfo = vec4(th * Hu * mix(1.0, 0.35, smoothstep(4.0, 5.5, su)), su, max(Hu, 0.05), iA.w);
  vMisc = vec4(fo, iC.z, W, iC.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

// Shared water look: Ultra Water's ocean surface model (OceanSurface.js) on a breaking wall.
// Beer-Lambert body over the refracted arena, column in-scatter, Atlas-style crest SSS, roughness-
// aware Fresnel over the sky cube, GGX sun with geometric specular AA, and whitewater as a density
// eroded through a lace pattern into coverage (dense foam solid, thin foam a tinted bubble film).
export const SHADE = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uAbsorption;
uniform vec3 uScatter;
uniform vec3 uFoamColor;   // dense whitewater albedo
uniform vec3 uFoamTint;    // thin foam: the water showing through the bubbles
uniform vec4 uLook;        // foam amount, chop (m), turbidity (1/m: bubbles and sand), crest SSS
uniform sampler2D uFoamTex; // Ultra Water's baked foam (ParticleFluid.foamTexture)
${COMMON_GLSL}
${NOISE_GLSL}
${WORLD_GLSL}
${LIGHTS_GLSL}
${REFRACT_GLSL}
vec3 skyUp() { return envReflect(vec3(0.0, 1.0, 0.0), 1.0); }
// bump from a height field h (m) by screen derivatives (Mikkelsen 2010, surface gradient)
vec3 bump(vec3 pw, vec3 n, float h) {
  vec3 dpx = dFdx(pw), dpy = dFdy(pw);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - grad);
}
// refr: the arena behind; dep: metres of water on the view ray; hS: crest height driving the SSS
// (m); lip: thin breaking lip glow 0..1; rough: base roughness
vec3 waterSurface(vec3 pw, vec3 N, vec3 V, vec3 refr, float dep, float hS, float lip, float rough) {
  float NoV = max(dot(N, V), 1e-4), NoL = dot(N, uSunDir), nl = max(NoL, 0.0);
  // geometric specular AA (Kaplanyan): normal change across the pixel widens the lobe
  vec3 dndx = dFdx(N), dndy = dFdy(N);
  float geoVar = min(0.25 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18);
  float alpha = sqrt(rough * rough + geoVar);
  vec3 T = exp(-(uAbsorption + uLook.z) * dep);
  vec3 sun = uSunColor;
  float back = clamp(dot(uSunDir, -V), 0.0, 1.0);
  // the water column is lit by the whole sky above it (UW: the sky cube's zenith), the sun only as
  // far as it is up: a deep face stays blue under a low orange sun
  vec3 inscatter = uScatter * (skyUp() + sun * max(uSunDir.y, 0.0));
  float k1 = uLook.w * hS * pow(back, 4.0) * pow(0.5 - 0.5 * NoL, 3.0);
  float k2 = 0.06 * NoV * NoV;
  // (light that has scattered through a metre of water is mostly sky: whitened, so a low red sun
  // gives turquoise, not green or olive)
  vec3 sunW = mix(sun, vec3(dot(sun, vec3(0.2126, 0.7152, 0.0722))), 0.8);
  vec3 sss = (k1 + k2) * uScatter * sunW + 0.05 * nl * uScatter * sun;
  // a thin breaking lip: light through about a metre of water glows turquoise
  sss += lip * sunW * exp(-uAbsorption * 2.0) * 0.06 * (0.3 + 2.5 * pow(back, 3.0));
  vec3 body = refr * T + (inscatter + sss) * (1.0 - T);
  float F90 = max(1.0 - 0.7 * sqrt(alpha), 0.02);
  float F = 0.02 + (F90 - 0.02) * pow(1.0 - NoV, 5.0);
  vec3 refl = envReflect(reflect(-V, N), sqrt(alpha));
  // sun: GGX, alpha floored so the sun acts as a small area light
  float aS = max(alpha, 0.015), aS2 = aS * aS;
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(N, H), 0.0);
  float dd = NoH * NoH * (aS2 - 1.0) + 1.0;
  float D = aS2 / (PI * dd * dd);
  float vis = 0.5 / (nl * sqrt(NoV * NoV * (1.0 - aS2) + aS2) + NoV * sqrt(nl * nl * (1.0 - aS2) + aS2) + 1e-5);
  float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  vec3 dS, sS;
  spellLightPBR(pw, N, V, sqrt(alpha), vec3(0.02), vec3(0.0), dS, sS);
  return mix(body, refl, F) + sun * (PI * D * vis * Fs * nl) + sS;
}
// whitewater over the water colour: dens 0..1+, pat the lace pattern (high = bubbles gather),
// fh billow height 0..1. Returns the colour; cover = how much of the pixel is foam.
vec3 foamSurface(vec3 col, vec3 pw, vec3 N, vec3 V, float dens, float pat, float fh, out float cover) {
  // Up close the texture's Voronoi cells grow to metres on screen and tile dense churn with hard
  // outlines: there it becomes froth instead, soft billows at three scales (the noise's perlin-worley
  // fbm, boiling), grey in its folds. Faded in by the pixel footprint, and for dense churn by
  // distance (resolution-free: a crash mound within 15 m is froth on a phone as on 4K, its cells
  // being metres across in the frame either way), so a far wave and thin foam keep their lace.
  float churn = smoothstep(1.0, 1.4, dens) * (1.0 - smoothstep(10.0, 18.0, refrViewZ(pw)));
  float nearK = max(1.0 - smoothstep(0.004, 0.014, length(fwidth(pw))), churn) * smoothstep(0.6, 1.0, dens);
  if (nearK > 0.0) {   // (coherent: whole near regions take it, far foam skips the three taps;
    // explicit LOD, so ANGLE's HLSL keeps this a real branch: the noise has no mips anyway)
    vec3 q = pw + vec3(0.0, -0.4 * uTime, 0.0);
    float froth = textureLod(uNoise3D, q * 0.33, 0.0).r * 0.3 + textureLod(uNoise3D, q * 1.1 + 0.37, 0.0).r * 0.4 + textureLod(uNoise3D, q * 3.7 + 0.71, 0.0).r * 0.3;
    froth = clamp((froth - 0.5) * 1.8 + 0.5, 0.0, 1.0);   // noise3 sits low-contrast round 0.5
    fh = mix(fh, froth, nearK);
    pat = mix(pat, 0.4 + 0.5 * froth, nearK);
  }
  cover = smoothstep(1.05 - dens, 1.3 - dens, pat) * sqrt(clamp(dens, 0.0, 1.0));
  if (cover <= 0.0) return col;
  // billows: whitewater is lumpy, lace lies flat (deeper, the cell borders crease into a quilt; and
  // no bump from the trilinear froth, whose slope steps at every texel)
  vec3 fN = bump(pw, N, fh * (0.03 + 0.05 * min(dens, 1.0)) * (1.0 - nearK));
  float fl = dot(fN, uSunDir);
  float ao = mix(mix(0.45, 1.0, smoothstep(0.15, 0.75, fh)), mix(0.55, 1.0, smoothstep(0.15, 0.85, fh)), nearK);
  float solid = smoothstep(0.2, 0.9, dens * (0.55 + 0.7 * fh));
  vec3 alb = mix(uFoamTint, uFoamColor, max(solid, smoothstep(0.3, 0.9, pat) * 0.6));
  float back = clamp(dot(uSunDir, -V), 0.0, 1.0);
  // the side away from a low sun is sky-lit (blue-grey); only thin foam lets the sun through
  // (dense foam scatters many times: its light follows the surface's form softly, wrapped)
  float sl = clamp(fl * mix(0.75, 0.6, solid) + mix(0.25, 0.3, solid), 0.0, 1.0);
  // sky light from the half of the sky the foam faces (blue away from a sunset, gold towards it),
  // half of it from the whole sky so neighbouring lumps don't read as tilted plates
  // (a fold hides the low sun more than the sky: it goes blue-grey, not brown)
  vec3 lit = uSunColor * (0.08 + 0.92 * sl * sl) * ao * ao + mix(envReflect(fN, 1.0), skyUp(), 0.5) * 1.6 * mix(ao, 1.0, 0.4);
  // the sun through thin foam, and round the silhouette of thick foam (forward scatter: a dense mass
  // is opaque, so backlit it is the sky's grey-white with a bright rim, not lit through and beige)
  lit += uSunColor * pow(back, 3.0) * (0.4 * (1.0 - solid) + 0.35 * solid * pow(1.0 - max(dot(N, V), 0.0), 2.0));
  // the folds: light that has wandered through the froth into them is grey-white, not the sunset's
  lit = mix(vec3(dot(lit, vec3(0.2126, 0.7152, 0.0722))), lit, mix(0.4, 1.0, ao));
  lit += spellLightDiffuse(pw, fN) * ao;
  // no specular: froth is a diffuse scatterer (its glints are sub-pixel bubbles)
  return mix(col, 0.85 * alb * lit, cover * mix(0.8, 1.0, max(solid, nearK)));
}
// lace (high where bubbles gather on the cell borders) and billow height: Ultra Water's shore foam,
// its baked foam texture riding a flow map (p in metres on the surface, vel its drift in m/s) with
// two phases crossfaded every half period, which also makes it churn
void foamPattern(vec2 p, vec2 vel, out float pat, out float fh) {
  const float FT = 2.5;
  float f0 = fract(uTime / FT), f1 = fract(uTime / FT + 0.5), wb = abs(2.0 * f0 - 1.0);
  vec4 b0 = texture(uFoamTex, (p - vel * (f0 * FT)) * 0.15), b1 = texture(uFoamTex, (p - vel * (f1 * FT)) * 0.15 + 0.43);
  // a finer octave riding the same flow (lace only: as a bump it shows the 2x2 derivative quads);
  // it rides phase 0, so it fades out where that phase wraps
  vec4 b2 = texture(uFoamTex, (p - vel * (f0 * FT)) * 0.55 + 0.21);
  fh = mix(b0.g, b1.g, wb);
  pat = mix(b0.r, b1.r, wb) * 0.3 + (b2.r + b2.g - 1.0) * 0.2 * (1.0 - wb) + fh * 0.45 + texture(uFoamTex, p * 0.023 + 0.5).r * 0.25;
}
`;

export const WAVE_FRAG = /* glsl */`
${SHADE}
in vec3 vW;
in vec3 vN;
in vec2 vUv;
in vec4 vInfo;
in vec4 vMisc;
out vec4 fragColor;
void main() {
  gLightNoShadow = true;
  float u = vUv.x, t = vUv.y, thick = vInfo.x, s = vInfo.y, Hm = vInfo.z, seed = vInfo.w;
  float fo0 = vMisc.x, diss = vMisc.y, Wm = vMisc.z, age = vMisc.w;
  // surface coordinates (m): across the crest, and roughly along the profile
  vec2 sc = vec2((u - 0.5) * Wm, t * Hm * 0.3);

  // --- coverage: the lip tears into jets as it throws; late on, holes open until it's gone ---
  float lip = smoothstep(1.2, 2.0, s) * (1.0 - smoothstep(4.0, 4.8, s));
  float dTip = abs(t - 6.0);
  float x = sc.x / 0.3 + 1.6 * noise3(vec3(sc.x * 0.3, seed, 0.5));   // irregular spacing
  float cx = fract(x) - 0.5, hl = hash12(vec2(floor(x), seed * 31.0));
  float len = (0.03 + 0.16 * hl * hl) * lip * (1.0 - smoothstep(3.0, 3.5, s));   // jets while it throws, not once it lands
  float q = clamp(dTip / max(len, 1e-3), 0.0, 1.0);
  float fing = dTip < len ? (mix(0.12, 0.5, sqrt(q)) * (0.6 + 0.4 * hl) - abs(cx)) * 3.0 : 1.0;
  float nb = noise3(vec3(sc * 0.07, seed * 0.37 + age * 0.012));
  float thr = mix(-0.2, 1.05, max(smoothstep(4.9, 6.0, s) * 0.55, diss));
  float m = min(fing, (nb - thr) * 3.0);
  float cov = clamp(m / max(fwidth(m), 1e-4) + 0.5, 0.0, 1.0) * smoothstep(0.0, 0.03, min(u, 1.0 - u));
  if (cov < 0.02) discard;

  vec3 vd = normalize(cameraPosition - vW);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  // chop: water drawn up the face and over the lip, streaked along the profile. The face below the
  // barrel (Nazare / Jaws from the side) is dark, smooth glass: there the chop is low and round, not
  // stretched (stretched ridges each catch the sunset as a vertical ribbon and read as icicles)
  float faceK = smoothstep(7.0, 8.5, t) * (1.0 - smoothstep(3.2, 3.8, s));
  float h = noise3(vec3(sc.x * 0.1, sc.y * mix(0.05, 0.1, faceK) - age * 0.08, seed * 0.21)) * 0.6
          + noise3(vec3(sc.x * 0.3, sc.y * mix(0.12, 0.3, faceK) - age * 0.25, seed * 0.21 + 0.5)) * 0.3
          + noise3(vec3(sc.x * 1.1, sc.y * mix(0.35, 1.1, faceK) - age * 0.6, seed * 0.21 + 0.25)) * 0.12;
  // (the noise is trilinear: its slope steps at every texel, which shows as facets up close and under
  // the lit whitewater of the bore, whose lumps are the foam's billows instead)
  n = bump(vW, n, h * uLook.y * (1.0 - 0.85 * smoothstep(3.0, 4.0, s)) * (1.0 - 0.7 * faceK) * smoothstep(1.5, 6.0, refrViewZ(vW)));

  float behind;
  vec3 refr = sceneRefract(vW, n, vd, 1.33, 0.25 + thick * 0.4, behind);
  float contact = 1.0 - smoothstep(0.0, 0.35, behind);
  cov *= smoothstep(0.0, 0.07, behind);
  // the camera caught in the wash: no metre-wide sheets across the lens (spray and lens drops carry it)
  cov *= smoothstep(0.4, 1.5, refrViewZ(vW));
  if (cov < 0.02) discard;

  // A wave face is the front of a deep body of water: behind it is more ocean, not the arena, so
  // wherever the ray would go on into the body the path is long and the colour is the column's own
  // in-scatter (Nazaré's dark slate-blue face, Ultra Water's deep colour). Only the toe, the rear
  // edge, the thin backlit lip and the spent sheet show the floor through them.
  float tipThin = smoothstep(0.35, 0.0, dTip) * lip;
  float bodyPath = (1.0 - smoothstep(4.3, 5.4, s)) * smoothstep(0.2, 1.4, t) * (1.0 - smoothstep(9.6, 10.8, t)) * (1.0 - tipThin);
  // (only the thin lip, until it lands; and only as thin as it is: a metre of lip already glows less)
  float lipGlow = smoothstep(0.8, 0.0, abs(t - 6.0)) * lip * (1.0 - smoothstep(3.3, 3.8, s)) * exp(-1.5 * thick);
  // light through the thin lip is mostly the sky scattered in it, not the low sun's orange (which the
  // cyan transmission would turn green)
  refr = mix(refr, vec3(dot(refr, vec3(0.2126, 0.7152, 0.0722))), 0.6 * tipThin);
  // no direct light through the body: tens of metres of bubbly water scatter the beam away, so the
  // sun's disc and glow (HDR, bright enough to survive any Beer-Lambert path) must not shine teal
  // through the barrel. Backlit, only the thin lip is turquoise; the barrel is the column's dark blue.
  // (and the sun's disc, seen through the thin lip, is spread into a glow by its rough surface)
  // Close-range soup (the landed churn within ~15 m): through the tears in it shows dark,
  // bubble-clouded water, not the floor.
  float soup = smoothstep(3.4, 4.0, s) * (1.0 - smoothstep(5.2, 6.0, s)) * (1.0 - smoothstep(10.0, 18.0, refrViewZ(vW)));
  refr *= (1.0 - bodyPath) * (1.0 - 0.85 * soup) * min(1.0, 4.0 / max(dot(refr, vec3(0.2126, 0.7152, 0.0722)), 1e-3));
  vec3 col = waterSurface(vW, n, vd, refr, thick * 2.0 + bodyPath * Hm * 3.0 + soup * 3.0, max(vW.y, 0.0) * 0.25 * (1.0 - 0.95 * bodyPath), lipGlow, 0.03 + 0.2 * soup);   // (the soup's water is all chop and bubbles: no mirror, no foil)

  // --- whitewater density ---
  float brk = smoothstep(0.9, 2.6, s);
  float bore = smoothstep(3.3, 4.5, s);
  float crestD = fo0 * mix(0.25, 1.0, brk);
  // the face: a few faint scuffs of old foam drawn up it (meandering ridges of stretched noise), in
  // sparse patches and thin enough to stay a grey lace over the dark water: on a Nazare face the
  // white is the lip, the crest spray and the foot, never the face itself
  float sx = sc.x + 1.6 * noise3(vec3(sc.x * 0.05, sc.y * 0.02, seed * 0.3));
  float l1 = 1.0 - abs(2.0 * noise3(vec3(sx * 0.2, sc.y * 0.012 - age * 0.01, seed * 0.5 + 0.25)) - 1.0);
  float scuff = smoothstep(0.52, 0.66, noise3(vec3(sc.x * 0.05, sc.y * 0.04, seed * 0.7 + 0.4)));
  // (the face's, until it falls; and not up close, where the noise texels would show in the thin lines)
  float face = smoothstep(6.6, 8.2, t) * (1.0 - smoothstep(10.6, 11.0, t)) * (1.0 - smoothstep(2.7, 3.4, s)) * smoothstep(2.0, 6.0, refrViewZ(vW));
  float streakD = smoothstep(0.86, 0.97, l1) * scuff * face * 0.45 * mix(0.5, 1.0, brk);
  // the plunge churns everything ahead of the crest into a white bore, lace behind it
  float boreD = bore * mix(0.8, 1.7, smoothstep(2.0, 5.0, t)) * mix(1.0, 0.45, smoothstep(4.8, 6.0, s));
  // the jets torn off the lip; once it has pitched, the falling lip itself churns white
  float tipD = max(smoothstep(0.3, 0.0, dTip) * 1.2, smoothstep(0.8, 0.0, dTip) * smoothstep(2.6, 3.3, s) * 1.3) * lip;
  float dens = (max(max(crestD, boreD), max(tipD, contact * 0.9)) + streakD) * uLook.x;
  float pat, fh, cover;
  foamPattern(sc, vec2(0.0, -1.0 - 2.5 * bore), pat, fh);
  // (under the soup the water is a bubble cloud: dim grey-blue, not the amber of the sky it mirrors)
  vec3 water = mix(col, 0.25 * uFoamTint * dot(skyUp() + uSunColor * max(uSunDir.y, 0.0), vec3(0.2126, 0.7152, 0.0722)), 0.8 * soup);
  col = foamSurface(col, vW, n, vd, dens, pat, fh, cover);
  if (soup > 0.0) {
    // The soup is never one white mound (GoPro footage from inside Nazare / Teahupo'o whitewater): a
    // flow-advected coverage mask (the Perlin-Worley noise at two scales, stretched along the run and
    // drifting with it, the fine one boiling faster) tears it. Dark water shows through the tears,
    // thin foam is a grey-blue veil over it, only the fresh, thick tops are white; older soup tears
    // open more. (Coverage and albedo, no bump: the trilinear noise facets as a bump.)
    vec3 a = vec3(sc.x * 0.3, (sc.y + age * (1.0 + 2.5 * bore)) * 0.09, seed * 0.7 + age * 0.04);
    float m2 = textureLod(uNoise3D, a * vec3(3.1, 3.1, 2.0) + vec3(0.31, 0.17, age * 0.1), 0.0).r;
    float m = clamp((textureLod(uNoise3D, a, 0.0).r * 0.6 + m2 * 0.4 - 0.6) * 2.5 + 0.5, 0.0, 1.0);   // (the dilated noise sits high and the two octaves average flat)
    float th0 = mix(0.25, 0.5, smoothstep(3.9, 5.2, s));
    // (in the tears, streaks of thin foam still drift: the fine octave)
    float c = min(0.1 + 0.3 * smoothstep(0.62, 0.8, m2) + 0.25 * smoothstep(th0, th0 + 0.04, m) + 0.45 * smoothstep(th0 + 0.06, th0 + 0.22, m), 1.0);
    col = mix(water, col, mix(1.0, c, soup));
  }
  fragColor = vec4(col, cov);
}`;

export const CURTAIN_VERT = /* glsl */`
uniform vec4 uShape;   // peel, bow (x H), lateral spread, crash time scale (s per phase unit)
uniform vec4 uCurt;    // lip tip reach at the crash (x H), life (s), -, -
${NOISE_GLSL}
${LATERAL}
in vec4 iA;   // origin xyz, seed
in vec4 iB;   // forward x, forward z, height H (m), width W (m)
in vec4 iC;   // age at the centre (s; negative = still to land), travel at the crash (m), launch speed (m/s), front speed (m/s)
out vec3 vW;
out vec3 vN;
out vec2 vUv;
out vec4 vInfo;   // age / life (negative = not landed yet), seed, width (m), local height (m)
vec3 curtainAt(float u, float v) {
  float e = 2.0 * u - 1.0;
  float lag = (0.5 - u) * uShape.x * uShape.w;          // the u = 1 end landed first
  float age = clamp(iC.x - lag, 0.0, uCurt.y);
  float tau = age * (1.0 - v), a = age - tau;           // ejected at tau, flying for a
  float Hu = iB.z * taper(u);
  // irregular along the crest (no regular sine: that reads as a row of glass peaks)
  float wob = 1.0 + 0.05 * sin(u * iB.w * 0.45 + iA.w * 6.2831853) + 0.4 * (noise3(vec3(u * iB.w * 0.12, iA.w * 3.0, 0.4)) - 0.5)
            + 0.2 * (noise3(vec3(u * iB.w * 0.45, iA.w * 3.0, 0.8)) - 0.5);
  float sp = 0.85 * iC.z * sqrt(Hu / max(iB.z, 0.1)) * wob * mix(0.45, 1.0, v) * inversesqrt(1.0 + 4.0 * tau);
  vec3 F = vec3(iB.x, 0.0, iB.y), S = vec3(-iB.y, 0.0, iB.x);
  vec3 base = iA.xyz + F * (iC.y + iC.w * (lag + tau) - uShape.y * iB.z * e * e + uCurt.x * Hu) + S * (e * 0.5 * iB.w);
  vec3 dir = normalize(vec3(0.0, 1.0, 0.0) + F * mix(0.75, 0.3, v));   // the rim stands up
  vec3 p = base + dir * sp * a;
  p.y -= 4.905 * a * a;
  // churned, not a clean sheet: lumps that grow with flight (a smooth sheet reads as glass or satin)
  vec3 ln = vec3(u * iB.w * 0.6, v * 2.0, iA.w * 5.0 + age * 0.4);
  p += (vec3(noise3(ln), noise3(ln + vec3(0.31, 0.17, 0.0)), noise3(ln + vec3(0.0, 0.53, 0.29))) - 0.5) * (0.15 + 0.6 * a);
  return p;
}
void main() {
  float u = position.x, v = position.y;
  float age = iC.x - (0.5 - u) * uShape.x * uShape.w;
  vec3 p = curtainAt(u, v);
  float dv = v < 0.95 ? 0.05 : -0.05;
  vec3 n = cross(curtainAt(min(u + ${(1 / NUC).toFixed(5)}, 1.0), v) - p, (curtainAt(u, v + dv) - p) * sign(dv));
  vN = dot(n, n) > 1e-14 ? normalize(n) : vec3(0.0, 1.0, 0.0);
  vW = p;
  vUv = vec2(u, v);
  vInfo = vec4(age / uCurt.y, iA.w, iB.w, iB.z * taper(u));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

export const CURTAIN_FRAG = /* glsl */`
${SHADE}
in vec3 vW;
in vec3 vN;
in vec2 vUv;
in vec4 vInfo;
out vec4 fragColor;
void main() {
  gLightNoShadow = true;
  float u = vUv.x, v = vUv.y, life = vInfo.x, seed = vInfo.y, Wm = vInfo.z, Hu = vInfo.w;
  if (life <= 0.0 || life >= 1.0) discard;
  float xm = u * Wm;
  // the rim rolls up into a ragged lip of short, blunt jets (no spikes: surface tension rounds a
  // torn sheet within centimetres); holes open through the thinning sheet until it is spray
  float x = xm / 0.6 + 1.8 * noise3(vec3(xm * 0.2, seed, 0.2));
  float cx = fract(x) - 0.5, hl = hash12(vec2(floor(x), seed * 13.0));
  float len = (0.03 + 0.1 * hl) * smoothstep(0.0, 0.3, life);
  float qq = clamp((v - (1.0 - len)) / max(len, 1e-3), 0.0, 1.0);
  float fing = v < 1.0 - len ? 1.0 : (mix(0.5, 0.25, qq * qq) - abs(cx)) * 2.0;
  float nh = noise3(vec3(xm * 0.12, v * 0.5 + life * 0.2, seed * 0.17)) * 0.75 + noise3(vec3(xm * 0.5, v * 2.0 - life * 0.5, seed * 0.29)) * 0.25;
  float thr = mix(0.2, 1.0, pow(life, 0.5)) - 0.25 * (1.0 - v) * (1.0 - life);   // torn to spray within a few tenths of a second
  float m = min(fing, (nh - thr) * 3.0);
  // (the low crest ends throw spray, not sheet; and so does the sheet within a few metres of the lens:
  // seen from inside the splash its torn rim reads as flying glass shards, the plume and drops carry it)
  float cov = clamp(m / max(fwidth(m), 1e-4) + 0.5, 0.0, 1.0) * smoothstep(0.05, 0.25, min(u, 1.0 - u)) * smoothstep(2.5, 7.5, refrViewZ(vW));
  if (cov < 0.02) discard;
  vec3 vd = normalize(cameraPosition - vW);
  vec3 n = normalize(vN);
  if (dot(n, vd) < 0.0) n = -n;
  n = bump(vW, n, noise3(vec3(xm * 0.4, v * 1.5 - life, seed)) * uLook.y * 0.8);
  float behind;
  vec3 refr = sceneRefract(vW, n, vd, 1.33, 0.3, behind);
  vec3 col = waterSurface(vW, n, vd, refr, 0.5, Hu * 0.4 * v, 1.0 - life, 0.05);
  // churned water: dense white at the torn rim and jets, thinning to lace as the sheet breaks up
  float edge = 1.0 - smoothstep(0.0, 0.15, nh - thr);
  float dens = (1.25 + 0.35 * edge + 0.3 * qq + 0.2 * v - 0.3 * life) * min(uLook.x, 1.3);   // churned white through, never a glass sheet
  float pat, fh, cover;
  foamPattern(vec2(xm, v * 4.0 + seed * 7.0), vec2(0.0, 3.0), pat, fh);
  col = foamSurface(col, vW, n, vd, dens, pat, fh, cover);
  fragColor = vec4(col, cov * smoothstep(0.0, 0.05, behind));
}`;

// --- splash plume (fx pass): stateless spray puffs, as Ultra Water's Spray.js ---------------------
// Each instance is a puff thrown from the crash line (or later from the running bore front) and
// flown ballistically with air drag, all from the crash uniforms: no CPU work or simulation state,
// so this part can move onto a particle-fluid system without touching the rest. Lit by the sun with
// a forward-scattering Henyey-Greenstein lobe plus the sky.
export const PLUME_N = 900;   // puffs per crash
const PUFF_GLSL = /* glsl */`
out vec2 vUv;
out float vAlpha;
out vec3 vLight;
out float vSeed;
out float vViewZ;
// camera-facing quad of the given size at p; droplets: strong forward scattering of the sun + sky
void puff(vec3 p, float size, float seed) {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 upv = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 view = viewMatrix * vec4(p + (right * position.x + upv * position.y) * size, 1.0);
  gl_Position = projectionMatrix * view;
  vViewZ = -view.z;
  vUv = position.xy;
  vSeed = seed;
  float mu = dot(normalize(p - cameraPosition), uSunDir);
  const float g = 0.6;
  float phase = (1.0 - g * g) / (4.0 * 3.14159265 * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  // a dense droplet cloud scatters many times: bright as a cumulus on its lit side, sky-blue-grey in
  // its shade, glowing when the sun is behind it (not a dim film of single scattering)
  vLight = uSunColor * (0.45 + 3.0 * phase) + uAmbient * 1.5;
}
`;
export const PLUME_VERT = FX_VERT_HEAD + /* glsl */`
uniform vec4 uShape;   // peel, bow (x H), lateral spread, crash time scale (s per phase unit)
uniform vec4 uCurt;    // lip tip reach (x H), -
uniform vec4 uPA[4];   // per crash (as the curtain's instance data): origin xyz, seed
uniform vec4 uPB[4];   // forward x, z, height H, width W
uniform vec4 uPC[4];   // age at the centre (s), travel at the crash (m), launch speed, front speed
uniform vec4 uPlume;   // amount, size, -, -
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
${LATERAL}
${PUFF_GLSL}
float h1(float x) { return fract(sin(x * 12.9898 + 4.1414) * 43758.5453); }
void main() {
  vAlpha = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // dead puffs fall outside the clip volume
  int w = gl_InstanceID / ${PLUME_N};
  float k = float(gl_InstanceID - w * ${PLUME_N});
  vec4 A = uPA[w], B = uPB[w], C = uPC[w];
  float r1 = h1(k * 0.731 + 0.17), r2 = h1(k * 1.173 + 0.53), r3 = h1(k * 0.419 + 0.91), r4 = h1(k * 1.637 + 0.29);
  bool bore = r4 > 0.62;   // the rest: the plunge plume
  float u = 0.03 + 0.94 * r1, e = 2.0 * u - 1.0;
  float lag = (0.5 - u) * uShape.x * uShape.w;
  float te = bore ? 0.15 + 1.1 * r2 : 0.45 * r2 * r2;
  float age = C.x - lag - te;
  float life = bore ? 0.7 + 0.8 * r3 : 1.0 + 1.4 * r3;
  if (age <= 0.0 || age >= life || B.z <= 0.0) return;
  float Hu = B.z * taper(u), q = sqrt(Hu / B.z);
  vec3 F = vec3(B.x, 0.0, B.y), S = vec3(-B.y, 0.0, B.x);
  vec3 base = A.xyz + F * (C.y + C.w * (lag + te) - uShape.y * B.z * e * e + uCurt.x * Hu) + S * (e * 0.5 * B.w);
  float up = C.z * q * (bore ? 0.15 + 0.3 * r3 : 0.3 + 0.8 * fract(r3 * 7.13));
  float fw = (bore ? 1.2 : 0.5) * C.w + up * 0.35 * fract(r2 * 5.3);
  float sd = (fract(r1 * 31.7) - 0.5) * 2.4;
  const float KD = 1.2, G = 9.81;
  float ex = (1.0 - exp(-KD * age)) / KD;
  vec3 p = base + (F * fw + S * sd) * ex;
  float size = (bore ? 0.25 + 0.9 * age : 0.25 + 1.3 * age) * (0.5 + 0.9 * fract(r2 * 9.7)) * q * uPlume.y;
  p.y = max(A.y + (up + G / KD) * ex - G * age / KD, size * 0.4);
  puff(p, size, r1 + r2);
  vAlpha = uPlume.x * (bore ? 1.6 : 2.6) * smoothstep(0.0, 0.06, age) * pow(1.0 - age / life, 2.2)
         * smoothstep(1.5, 6.0, vViewZ);   // no giant blobs on the lens
}`;
export const PLUME_FRAG = FX_FRAG_HEAD + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + /* glsl */`
uniform vec3 uFoamColor;
in vec2 vUv;
in float vAlpha;
in vec3 vLight;
in float vSeed;
in float vViewZ;
void main() {
  float r = length(vUv);
  if (vAlpha <= 0.0 || r > 1.0) discard;
  // soft gaussian puff, broken up at low frequency so it reads as spray mist
  // droplet clusters: two noise scales eat the puff from the edge in, so it never reads as a disc
  float n = noise3(vec3(vUv * 0.22 + vSeed * 7.0, vSeed * 0.37)) * 0.65 + noise3(vec3(vUv * 0.6 + vSeed * 3.0, vSeed * 0.71)) * 0.35;
  float a = vAlpha * smoothstep(0.0, 0.35, n - r * r * 0.55) * exp(-1.5 * r * r) * softFade(vViewZ, 0.8);
  if (a < 0.002) discard;
  fxOut(vLight * uFoamColor, a, vec3(0.0), vec2(0.0), vViewZ);
}`;

// --- crest spray (fx pass): the mane blown back off the crest while it stands up and pitches ------
// One quad per puff (aPuff: u along the crest, emission phase, two randoms), drawn once per live wave
// with the wave's own instance data, so each puff rides the same crest the wave mesh draws. Puffs
// are emitted cyclically and fly back and up from the crest, slowed by drag.
export const MANE_N = 700;   // puffs per wave
export const MANE_VERT = FX_VERT_HEAD + WAVE_FUNCS + /* glsl */`
uniform vec4 uMane;   // amount, size, -, -
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec4 aPuff;
${PUFF_GLSL}
void main() {
  vAlpha = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  float u = aPuff.x;
  float s0 = phaseAt(u, iC.x, iA.w);
  float k = smoothstep(0.35, 1.2, s0) * (1.0 - smoothstep(2.9, 3.6, s0)) * iB.z / max(iB.z, 1e-3);
  if (k <= 0.0 || iB.z < 0.5) return;
  float life = 0.8 + 0.9 * aPuff.z;
  float age = fract(iC.w / life + aPuff.y) * life;
  float th, fo, su, Hu, W;
  vec3 c = wavePos(u, ${(4.6 / (NP - 1)).toFixed(4)} + 0.04 * aPuff.w, th, fo, su, Hu, W);
  vec3 F = vec3(iB.x, 0.0, iB.y), S = vec3(-iB.y, 0.0, iB.x);
  const float KD = 1.6;
  float ex = (1.0 - exp(-KD * age)) / KD;
  vec3 p = c + (-F * (1.5 + 2.5 * aPuff.w) + S * (aPuff.z - 0.5) * 1.2 + vec3(0.0, 1.2 + 1.6 * aPuff.z, 0.0)) * ex;
  p.y -= 1.5 * age * age;
  float q = sqrt(max(Hu, 0.0) / iB.z);
  float size = (0.25 + 1.4 * age) * (0.6 + 0.8 * aPuff.w) * q * uMane.y;
  puff(p, size, aPuff.y * 7.0 + aPuff.z);
  vAlpha = uMane.x * 1.4 * k * q * smoothstep(0.0, 0.12, age) * pow(1.0 - age / life, 2.0) * smoothstep(2.5, 8.0, vViewZ);
}`;
