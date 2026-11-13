import * as THREE from 'three';
import { U, COMMON_GLSL, NOISE_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING, LINES_BLENDING } from '../../vfx/common.js';

// Shaders for Solar Flare (and Supernova's star, which imports them).
//
// References: SDO/HMI and Hinode SOT for the photosphere, SDO/AIA 171/304 for the loops.
// Star impostor: two camera-facing quads per star, both ray-traced against the true sphere.
//   core   (lines pass, full res): the photosphere. Turbulent granulation (inverted Worley cells
//          warped by the larger flows, two generations cross-fading so it boils, a finer octave),
//          active regions from the fbm channel (plage and faculae brightest towards the limb, spots
//          with a penumbra, thin dark filaments), limb darkening (redder at the limb, where the eye
//          sees cooler, higher gas). It writes the sphere's true depth, so loops behind it, smoke
//          behind it and the void lens all treat it as a solid ball.
//   corona (fx pass, half res): a ragged chromosphere rim of spicules, inner and outer corona from
//          the impact parameter of each view ray, streamers from noise over direction, a pulse
//          ring running outwards (Supernova), and heat-haze refraction over the inner corona.
// Loops: AnalyticRibbons, ONE fine strand each; a loop is a bundle of them. Each strand sits at its
//   own place in the flux tube's cross-section and twists along the loop; its brightness is patchy
//   along its length, plasma knots drain from the apex down both legs, and as it cools (heat 1 -> 0)
//   the light gathers in the legs.
// Burst: an emissive volume (Volumes.js) for the moment the sun bursts on impact: a turbulent
//   plasma bubble that hollows out as it grows and cools from the core colour to the limb's.

const STAR_U = /* glsl */`
uniform vec4 uStarA;   // centre xyz, photosphere radius m (0 = hidden)
uniform vec4 uStarB;   // granule cells per radius, spin rad/s, pulse 0..1, intensity
uniform vec4 uStarC;   // corona gain, corona extent (radii), streamer contrast, heat haze (m)
uniform vec4 uStarD;   // seed, limb darkening 0..1, spots 0..1, pulse ring radius (radii, 0 = none)
uniform vec3 uStarCore;
uniform vec3 uStarLimb;
`;

// quad at the centre plane, sized to the silhouette cone of a sphere ext x the photosphere
const quadVert = (ext) => /* glsl */`
out vec3 vW;
void main() {
  vW = vec3(0.0);
  float R = uStarA.w * ${ext};
  vec3 c = uStarA.xyz, toC = c - cameraPosition;
  float D = length(toC);
  if (uStarA.w <= 0.0 || D < R * 1.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 f = toC / D, r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), u = cross(r, f);
  vec3 p = c + (r * position.x + u * position.y) * (R / sqrt(1.0 - (R / D) * (R / D)));
  vW = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const CORE_VERT = COMMON_GLSL + STAR_U + quadVert('1.04');
const CORE_FRAG = COMMON_GLSL + NOISE_GLSL + STAR_U + /* glsl */`
uniform mat4 projectionMatrix;
in vec3 vW;
out vec4 fragColor;
void main() {
  vec3 c = uStarA.xyz;
  float R = uStarA.w;
  vec3 rd = normalize(vW - cameraPosition), oc = cameraPosition - c;
  float b = dot(oc, rd), rho = sqrt(max(dot(oc, oc) - b * b, 0.0));
  float cover = clamp((R - rho) / max(fwidth(rho), 1e-5) + 0.5, 0.0, 1.0);   // analytic limb AA
  if (cover <= 0.0) discard;
  float h = sqrt(max(R * R - rho * rho, 0.0)), mu = h / R;
  vec3 p = cameraPosition + rd * (-b - h), n = (p - c) / R;
  // the star turns about its local y, so the granules drift across the disk
  float a = uStarB.y * uTime, ca = cos(a), sa = sin(a);
  vec3 q = vec3(ca * n.x - sa * n.z, n.y, sa * n.x + ca * n.z);
  // turbulent granulation (Hinode SOT): bright convection cells, dark intergranular lanes, warped by
  // the larger flows, boiling (two generations of cells cross-fade) with a finer octave on top
  vec3 wq = q * 0.8 + vec3(uStarD.x, uTime * 0.02, 0.0);
  vec2 warp = vec2(texture(uNoise3D, wq).r, texture(uNoise3D, wq + vec3(0.37, 0.19, 0.53)).r) - 0.5;
  vec3 gp = (q + vec3(warp, -warp.x) * 0.3) * (uStarB.x * 1.6 / 8.0) + vec3(uStarD.x, 0.0, uStarD.x * 0.7);   // .a: 8 cells per tile
  float gen = uTime * 0.6, gf = smoothstep(0.0, 1.0, fract(gen));
  float g1 = texture(uNoise3D, gp + vec3(0.0, floor(gen) * 0.413, 0.0)).a;
  float g2 = texture(uNoise3D, gp + vec3(0.0, floor(gen + 1.0) * 0.413, 0.0)).a;
  float g3 = texture(uNoise3D, gp * 2.2 + vec3(0.31, -uTime * 0.03, 0.17)).a;
  float gran = mix(g1, g2, gf) * 0.78 + g3 * 0.22;
  // active regions (SDO HMI / AIA 1600): bright plage and faculae (strongest towards the limb),
  // spots with a penumbra inside them, and thin dark filaments snaking between
  float sup = texture(uNoise3D, q * 0.32 + vec3(uStarD.x * 0.37, uTime * 0.006, 0.0)).r;
  float fil = texture(uNoise3D, q * 0.5 + vec3(0.71, uStarD.x * 0.53, uTime * 0.004)).r;
  float plage = smoothstep(0.56, 0.7, sup);
  float filament = (1.0 - smoothstep(0.012, 0.04, abs(fil - 0.5))) * smoothstep(0.42, 0.58, sup) * (1.0 - plage * 0.6);
  float pen = smoothstep(0.69, 0.73, sup) * uStarD.z, umb = smoothstep(0.735, 0.76, sup) * uStarD.z;
  float heat = (0.3 + 1.05 * gran * gran) * (1.0 + plage * (0.18 + 0.55 * (1.0 - mu))) * (1.0 - 0.5 * filament) * (1.0 - 0.45 * pen - 0.4 * umb);
  // limb darkening, I ~ 1 - u (1 - sqrt(mu)), and the limb runs redder (cooler, higher gas)
  float limb = 1.0 - uStarD.y * (1.0 - pow(mu, 0.5));
  vec3 col = mix(uStarLimb, uStarCore, clamp(0.25 + 0.75 * mu + 0.25 * (heat - 0.6), 0.0, 1.0)) * heat * limb;
  col *= uStarB.w * (1.0 + uStarB.z * (0.5 + mu));
  vec4 cl = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_FragDepth = clamp(cl.z / cl.w * 0.5 + 0.5, 0.0, 1.0);
  fragColor = vec4(col, cover);
}`;

const CORONA_VERT = FX_VERT_HEAD + COMMON_GLSL + STAR_U + quadVert('uStarC.y');
const CORONA_FRAG = FX_FRAG_HEAD + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + STAR_U + /* glsl */`
uniform mat4 projectionMatrix;
in vec3 vW;
void main() {
  vec3 c = uStarA.xyz;
  float R = uStarA.w, E = uStarC.y;
  vec3 rd = normalize(vW - cameraPosition);
  vec3 qp = cameraPosition + rd * dot(c - cameraPosition, rd), dv = qp - c;   // closest approach
  float rho = length(dv), x = rho / R;
  if (x > E) discard;
  vec3 dir = dv / max(rho, 1e-5);
  float viewZ = -(viewMatrix * vec4(qp, 1.0)).z;
  float xo = max(x - 1.0, 0.0);
  // the chromosphere: a thin ragged rim of spicules standing off the limb, then the inner and the
  // faint outer corona
  float n1 = noise3(dir * 1.4 + uStarD.x), n2 = noise3(dir * 3.7 + vec3(0.0, xo * 0.1 - uTime * 0.05, uStarD.x));
  float spic = noise3(dir * 11.0 + vec3(uStarD.x, uTime * 0.15, 0.0));
  // spicule forest: ragged in height and patchy round the limb (clusters, gaps), never a clean ring
  float rim = exp(-max(xo - 0.07 * smoothstep(0.25, 0.85, spic), 0.0) / 0.014) * (0.15 + 1.1 * smoothstep(0.35, 0.75, n2));
  float prof = 0.5 * rim + 0.4 * exp(-xo / 0.2) + 0.1 * exp(-xo / 0.8);
  // streamers: noise over the direction (constant along a ray from the star), drifting outwards
  float st = mix(1.0, 0.2 + 1.7 * n1 * n1 + 0.8 * (n2 - 0.5), uStarC.z * smoothstep(0.0, 0.3, xo));
  // pulse front: a ragged shell of brighter plasma running out through the corona
  float ring = uStarD.w > 0.0 ? exp(-pow((x - uStarD.w + 0.25 * (n2 - 0.5)) / (0.1 + 0.08 * uStarD.w), 2.0)) * smoothstep(E * 0.8, 1.2, uStarD.w) * (0.3 + 1.2 * n1) : 0.0;
  float edge = smoothstep(E, E * 0.55, x) * smoothstep(0.9, 1.0, x);
  vec3 col = mix(uStarLimb * vec3(1.0, 0.8, 0.7), uStarCore, 0.5 * exp(-xo / 0.06) * (1.0 - 0.5 * rim));
  vec3 em = col * (prof * st + 0.5 * ring) * edge * uStarC.x * uStarB.w * (1.0 + 0.6 * uStarB.z);
  // heat haze over the inner corona (metres of apparent displacement -> uv)
  vec3 hq = dv / R * 0.6 + vec3(0.0, -uTime * 0.7, uStarD.x);
  vec2 hz = vec2(noise3(hq), noise3(hq + vec3(0.37, 0.11, 0.71))) - 0.5;
  float hpx = 0.5 * projectionMatrix[1][1] / max(viewZ, 1e-3);
  vec2 dist = hz * vec2(hpx * uFxResolution.y / uFxResolution.x, hpx) * (uStarC.w * R * exp(-xo / 0.7) * smoothstep(E, E * 0.6, x));
  float s = softFade(viewZ, 0.35);
  fxOut(vec3(0.0), 0.0, em * s, dist * s, viewZ);
}`;

// the photosphere is opaque: it covers what's behind it (alpha = limb coverage) and keeps the
// destination alpha, as LINES_BLENDING does (the planar reflection reads it as a mask)
const OPAQUE_EMISSIVE = {
  ...LINES_BLENDING, depthWrite: true,
  blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
};

// n star impostors, each { core, corona, u, busy }. Hidden until u.uStarA.w > 0 and visible.
export function createStars(fx, n) {
  const geo = new THREE.PlaneGeometry(2, 2);
  return Array.from({ length: n }, () => {
    const u = {
      uStarA: { value: new THREE.Vector4() }, uStarB: { value: new THREE.Vector4(6, 0.3, 0, 1) },
      uStarC: { value: new THREE.Vector4(1, 3, 0.8, 0.05) }, uStarD: { value: new THREE.Vector4(0, 0.6, 0.4, 0) },
      uStarCore: { value: new THREE.Color(1, 0.95, 0.85) }, uStarLimb: { value: new THREE.Color(1, 0.5, 0.1) },
    };
    const core = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: CORE_VERT, fragmentShader: CORE_FRAG,
      uniforms: { ...U, ...u }, ...OPAQUE_EMISSIVE, side: THREE.DoubleSide,
    }));
    core.frustumCulled = false;
    core.visible = false;
    core.renderOrder = -1;     // first in the lines pass: its depth hides whatever lines lie behind it
    core.layers.enable(1);     // in the floor reflection too
    fx.scenes.lines.add(core);
    const corona = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: CORONA_VERT, fragmentShader: CORONA_FRAG,
      uniforms: { ...U, ...u }, ...FX_BLENDING, side: THREE.DoubleSide,
    }));
    corona.frustumCulled = false;
    corona.visible = false;
    fx.scenes.fx.add(corona);
    return { core, corona, u, busy: false };
  });
}

// loop strands: p0 = foot A, strand width (m)   p1 = foot B, apex height above the chord (m)
//               p2 = apex direction (unit), flux-tube radius (m)
//               p3 = strand seed 0..1 (its place in the tube), twist (turns along the loop), top bulge, heat 0..1
export const LOOP_PATH = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  vec3 A = p0.xyz, ch = p1.xyz - A, U = p2.xyz;
  float s = sin(PI * t), lift = pow(s, 0.6);
  vec3 p = A + ch * (t + p3.z * (t - 0.5) * lift) + U * (p1.w * lift);
  vec3 side = normalize(cross(ch, U) + vec3(1e-6));
  // this strand's place in the tube (p3.x = radius 0..1, angle hashed from it), braided round the
  // axis along the loop (p3.y turns, either hand) and writhing slowly; the tube pinches at the feet
  float ph = fract(sin(p3.x * 91.7) * 4375.85) * 6.2832 + t * p3.y * 6.2832 + uTime * 0.25;
  p += (side * cos(ph) + U * sin(ph)) * (p2.w * p3.x * (0.25 + 0.75 * s));
  width = p0.w * (0.55 + 0.45 * s);
  return p;
}`;
export const LOOP_SHADE = /* glsl */`
uniform highp sampler3D uNoise3D;
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
  float y = r.uv.y, s = abs(2.0 * r.uv.x - 1.0);   // s: 0 at the apex .. 1 at the feet
  float sd = r.p3.x * 13.0, heat = r.p3.w;
  float core = exp(-y * y * 4.0);
  // fine structure: patchy brightness along the strand, slowly evolving
  // two scales, so a thread breaks into bright fragments and gaps (AIA: no strand glows evenly end to end)
  float patchy = smoothstep(0.38, 0.8, texture(uNoise3D, vec3(r.uv.x * 2.3 + sd, sd * 0.37, uTime * 0.04)).r)
               * (0.35 + 0.65 * smoothstep(0.3, 0.7, texture(uNoise3D, vec3(r.uv.x * 7.1 + sd * 1.7, sd * 0.53 + 0.4, uTime * 0.07)).r));
  // plasma knots sliding from the apex down both legs (draining under gravity)
  float k = smoothstep(0.55, 0.85, texture(uNoise3D, vec3(s * 2.0 - uTime * 0.45, sd * 0.71, 0.5 + sd * 0.11)).r);
  // brightest at the footpoints and the loop top; a hot loop glows along its length, a cooling one
  // drains: the top fades and the light gathers in the knots and the legs
  float feet = exp(-(1.0 - s) * 10.0), top = exp(-s * s * 14.0);
  float body = (0.06 + 0.94 * patchy) * mix(0.25 + 0.75 * s * s, 1.0, heat);
  return r.color * core * (0.7 * body + (0.3 + 0.7 * heat) * top + 1.1 * feet + 1.6 * k * (1.0 - 0.5 * heat));
}`;

// JS mirror of LOOP_PATH's centreline without the strand offset (coronal rain, sparks at the feet)
export function loopPoint(h, t, out) {
  const s = Math.sin(Math.PI * t), lift = Math.pow(s, 0.6), k = t + h.p3.z * (t - 0.5) * lift;
  return out.set(
    h.p0.x + (h.p1.x - h.p0.x) * k + h.p2.x * h.p1.w * lift,
    h.p0.y + (h.p1.y - h.p0.y) * k + h.p2.y * h.p1.w * lift,
    h.p0.z + (h.p1.z - h.p0.z) * k + h.p2.z * h.p1.w * lift,
  );
}

export const BURST_GLSL = /* glsl */`
uniform vec4 uBurst;    // radius m, age s, intensity, seed
uniform vec3 uBurstPos;
uniform vec3 uBurstCore;
uniform vec3 uBurstCol;
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  // pure emission (sigma under the integrator's occupied test, but not a literal 0 for fxc)
  sigma = 1e-6 * uBurst.x; albedo = vec3(0.0); emission = vec3(0.0);
  float R = uBurst.x, age = uBurst.y;
  vec3 q = (pw - uBurstPos) / R;
  float r = length(q);
  if (r > 1.0) return;
  // turbulent plasma: billowy fbm, band-limited to what the march can resolve (no radial filaments)
  vec3 np = q * 0.45 + vec3(uBurst.w, -age * 0.25, uBurst.w * 0.61);
  float n1 = noise3(np), n2 = noise3(np * 1.9 + vec3(0.13, 0.4, 0.7));
  float b = smoothstep(0.3, 0.75, n1 * 0.7 + n2 * 0.3);
  float hollow = smoothstep(0.0, 0.35, age), rr = r + (n2 - 0.5) * 0.3;
  float shell = smoothstep(1.0, 0.75, rr) * smoothstep(0.05 + 0.55 * hollow, 0.35 + 0.45 * hollow, rr);
  float heat = clamp(1.15 - age * 2.6 + 0.45 * b - 0.3 * r, 0.0, 1.0);
  emission = mix(uBurstCol, uBurstCore, heat * heat) * ((0.12 + 0.88 * heat) * shell * (0.15 + 1.6 * b) * uBurst.z / R);
}`;
