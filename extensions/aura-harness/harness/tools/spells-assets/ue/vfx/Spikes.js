import * as THREE from 'three';
import { U, COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL, IMPACTS_GLSL, occluders } from './common.js';
import { instanced, put4 } from './Ribbons.js';

// Erupting spikes (PLAN 3 Earth "Upheaval", Ice "Frost Nova"). Geometry is generated once at load:
// 4 rock variants (~380 triangles: stacked strata layers with ledges, faceted sides, a fractured
// top) and 4 ice variants (hexagonal crystal clusters, flat facets). All variants of a material sit
// in one vertex buffer and every instance collapses the triangles of the other three to zero area,
// so each material is ONE instanced draw (8 spikes x 4 variants x ~1.1k vertices is nothing; a
// draw per variant would be 4x the state changes).
//
// Rock: MeshStandardMaterial + onBeforeCompile in the opaque scene. Strata, a few straight
// fractures, derivative bump, spell lights, impacts (scorch / frost / magma) and per-spike heat ->
// blackbody glow deep in the fractures and on the broken face towards the source (hot basalt after a
// blast, a lava-crust breakout: the outer surface is cooled dark rock).
// Ice: ShaderMaterial in the refract scene, sampling the resolved opaque HDR. Each crystal is a
// convex polytope (6 side planes, 6 tip planes, base) whose planes travel as flat per-vertex
// attributes, so the refracted ray's exit distance is exact (analytic thickness), the exit face
// refracts a second time (or totally internally reflects), and the distance to the nearest edge
// drives the frost.
//
// Rise: ease-out-back out of the ground over `rise` s after `delay`; crumble after `life` s: sinks,
// shrinks, tilts and fades with alpha-to-coverage (dithered so 4x MSAA gives more than 5 levels).
// Each spike is a capsule occluder (kind 2) from the start of its rise until it starts crumbling.

const UP = new THREE.Vector3(0, 1, 0);

function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// --- rock geometry ------------------------------------------------------------------------
// unit space: base ring around y = 0 (buried down to -0.25), tip near y = 1, base radius ~1.
function rockVariant(seed) {
  const rand = lcg(seed * 7919 + 13);
  const sides = 7 + ((rand() * 3) | 0);
  const layers = 7 + ((rand() * 2) | 0);
  const tipY = 0.84 + rand() * 0.08;
  const ang = Array.from({ length: sides }, (_, i) => ((i + (rand() - 0.5) * 0.55) / sides) * Math.PI * 2);
  const bulge = Array.from({ length: sides }, () => 0.86 + rand() * 0.26);   // per-side: vertical facets
  const prof = (y) => 0.1 + 0.9 * Math.pow(Math.max(1 - Math.max(y, 0) / 1.02, 0), 0.9);
  const bounds = [-0.25];
  for (let l = 1; l < layers; l++) bounds.push(tipY * Math.pow(l / layers, 0.85) + (rand() - 0.5) * 0.03);
  bounds.push(tipY);

  const rings = [];   // { pts: [x, y, z][], layer, seam } ; seam rings start a ledge band
  for (let l = 0; l < layers; l++) {
    const ox = (rand() - 0.5) * 0.12, oz = (rand() - 0.5) * 0.12, k = 0.9 + rand() * 0.2, tw = (rand() - 0.5) * 0.12;
    const lr = rand();
    const y0 = bounds[l] + (l ? 0.006 : 0), y1 = bounds[l + 1];
    for (const [f, jit] of [[0, 0.04], [0.5, 0.1], [1, 0.04]]) {
      const y = y0 + (y1 - y0) * f;
      const r = prof(y) * k;
      rings.push({
        layer: lr, seam: f === 0 && l > 0,
        pts: ang.map((a, i) => {
          const rr = r * bulge[i] * (1 + (rand() - 0.5) * jit * 2);
          return [Math.cos(a + tw) * rr + ox * r, y, Math.sin(a + tw) * rr + oz * r];
        }),
      });
    }
  }
  // fractured top: apex off-centre, then everything above an oblique plane is flattened onto it
  const top = rings[rings.length - 1];
  const apex = [top.pts[0][0] * 0.2 + (rand() - 0.5) * 0.08, tipY + 0.08 + rand() * 0.1, top.pts[0][2] * 0.2 + (rand() - 0.5) * 0.08];
  const cn = new THREE.Vector3((rand() - 0.5) * 1.2, 1, (rand() - 0.5) * 1.2).normalize();
  const cut = tipY + 0.02 + rand() * 0.04;
  const flatten = (p) => {
    const d = (p[0] * cn.x + (p[1] - cut) * cn.y + p[2] * cn.z);
    return d > 0 ? [p[0] - cn.x * d, p[1] - cn.y * d, p[2] - cn.z * d] : p;
  };

  const pos = [], rock = [];
  const tri = (a, b, c, layer, seam) => {
    pos.push(...flatten(a), ...flatten(b), ...flatten(c));
    for (let i = 0; i < 3; i++) rock.push(layer, seam);
  };
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r], B = rings[r + 1];
    const seam = B.seam ? 1 : 0, layer = seam ? A.layer : B.layer;
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tri(A.pts[i], B.pts[j], A.pts[j], layer, seam);
      tri(A.pts[i], B.pts[i], B.pts[j], layer, seam);
    }
  }
  for (let i = 0; i < sides; i++) tri(top.pts[i], apex, top.pts[(i + 1) % sides], top.layer, 0);
  return { pos, rock };
}

// --- ice geometry -------------------------------------------------------------------------
// hexagonal prisms with pyramidal tips; per vertex the crystal's planes: c0 = (base, apothem),
// c1 = (axis, prism length), c2 = (side reference normal, tip length), all in unit space
function iceVariant(seed) {
  const rand = lcg(seed * 104729 + 7);
  const crystals = [];
  const tiltMain = new THREE.Vector3((rand() - 0.5) * 0.18, 1, (rand() - 0.5) * 0.18).normalize();
  crystals.push({ b: new THREE.Vector3(0, -0.25, 0), a: tiltMain, w: 0.3 + rand() * 0.06, L: 0.98 - rand() * 0.06, T: 0.24 + rand() * 0.1 });
  const n = 4 + ((rand() * 3) | 0);
  for (let i = 0; i < n; i++) {
    const az = ((i + rand() * 0.6) / n) * Math.PI * 2, tilt = 0.35 + rand() * 0.45;
    const a = new THREE.Vector3(Math.cos(az) * Math.sin(tilt), Math.cos(tilt), Math.sin(az) * Math.sin(tilt));
    const r0 = 0.25 + rand() * 0.25;
    const w = 0.1 + rand() * 0.12;
    crystals.push({ b: new THREE.Vector3(Math.cos(az) * r0, -0.25, Math.sin(az) * r0), a, w, L: 0.25 + rand() * 0.4 + w, T: w * (0.9 + rand() * 0.9) });
  }
  const pos = [], c0 = [], c1 = [], c2 = [];
  const s = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
  for (const c of crystals) {
    s.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).cross(c.a).normalize();   // any perpendicular, random spin
    u.crossVectors(c.a, s);
    const R = c.w / Math.cos(Math.PI / 6);   // circumradius
    const ring = (h) => Array.from({ length: 6 }, (_, k) => {
      const t = (k - 0.5) * Math.PI / 3;   // corners halfway between the side normals
      return v.copy(c.b).addScaledVector(c.a, h).addScaledVector(s, Math.cos(t) * R).addScaledVector(u, Math.sin(t) * R).toArray();
    });
    const lo = ring(0), hi = ring(c.L), apex = v.copy(c.b).addScaledVector(c.a, c.L + c.T).toArray();
    const tri = (p, q, r) => {
      pos.push(...p, ...q, ...r);
      for (let i = 0; i < 3; i++) {
        c0.push(c.b.x, c.b.y, c.b.z, c.w); c1.push(c.a.x, c.a.y, c.a.z, c.L); c2.push(s.x, s.y, s.z, c.T);
      }
    };
    for (let k = 0; k < 6; k++) {
      const j = (k + 1) % 6;
      // winding: outward normals (n_k between corner k and k+1 ... see ring())
      tri(lo[k], lo[j], hi[j]);
      tri(lo[k], hi[j], hi[k]);
      tri(hi[k], hi[j], apex);
    }
  }
  return { pos, c0, c1, c2 };
}

// all variants of one material in one buffer, + aVariant; flat normals from the triangles
function merged(variants, extra) {
  const g = new THREE.InstancedBufferGeometry();
  const pos = variants.flatMap((v) => v.pos);
  const variant = variants.flatMap((v, i) => new Array(v.pos.length / 3).fill(i));
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aVariant', new THREE.Float32BufferAttribute(variant, 1));
  for (const [name, size] of extra) g.setAttribute(name, new THREE.Float32BufferAttribute(variants.flatMap((v) => v[name]), size));
  g.computeVertexNormals();   // non-indexed -> face normals (both builders wind outward, CCW)
  return g;
}

// --- shared GLSL --------------------------------------------------------------------------
// per-instance: 3 affine rows, (variant, heat, fade, seed), (radius, height, front, glow)
const INSTANCE_VERT = /* glsl */`
attribute float aVariant;
attribute vec4 aM0;
attribute vec4 aM1;
attribute vec4 aM2;
attribute vec4 aSpike;
attribute vec4 aSize;
mat4 spikeMatrix() { return transpose(mat4(aM0, aM1, aM2, vec4(0.0, 0.0, 0.0, 1.0))); }
// inverse-transpose for rotation x scale matrices (three's instancing trick)
vec3 spikeNormal(mat3 m, vec3 n) { return m * (n / vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2]))); }
bool spikeOther() { return abs(aVariant - aSpike.x) > 0.5; }
`;

// --- rock material --------------------------------------------------------------------------
const ROCK_FRAG_PARS = COMMON_GLSL + NOISE_GLSL + WORLD_GLSL + LIGHTS_GLSL + IMPACTS_GLSL + /* glsl */`
varying vec3 vObj;     // object space in metres, unrotated and unanimated (texture space)
varying vec2 vRock;    // layer random, seam (ledge band)
varying vec4 vSpikeP;  // variant, heat, fade, seed
varying vec4 vSizeP;   // radius, height, -, -
varying vec3 vLean;    // the spike's axis in world space (rims lean away from what threw them up)
uniform vec4 uRockLook;   // strata contrast, vein width, heat glow scale, bump
uniform vec4 uSpikeOpts;  // x rock receives capsule shadows, y ice does
float gBump; float gHeat; float gVein; float gStrata; float gHalo; float gDirt; float gFace; float gGlow;
uniform vec3 uRockDust;   // dust settled on ledges and caked on the foot
// zero crossings of the fbm form a closed vein network; fwidth keeps them ~constant in pixels, and
// thin lines are scaled back so their coverage (and glow) is conserved instead of sparkling
float vein(float n, float w) { float fw = fwidth(n); return (1.0 - smoothstep(w, w + fw * 1.5, abs(n - 0.5))) * w / (w + 0.75 * fw); }
// one through-going fracture: a plane through the spike (mostly vertical, random strike), slightly
// jagged, limited to a patch of the plane and tapering to its tips. x: coverage, y: metres to it,
// z: taper (0 at the tips)
vec3 fracture(vec3 o, vec3 h, vec3 h2, float jag, float R, float H) {
  float th = h2.x * 6.2831853;
  vec3 n = normalize(vec3(cos(th), (h2.y - 0.5) * 0.7, sin(th)));
  vec3 q = o - vec3((h.x - 0.5) * 0.9 * R, (0.2 + 0.55 * h.y) * H, (h.z - 0.5) * 0.9 * R);
  float d = dot(q, n) + jag;
  float L = (0.22 + 0.33 * h2.z) * H;
  float taper = clamp(1.0 - dot(q - n * dot(q, n), q - n * dot(q, n)) / (L * L), 0.0, 1.0);
  float w = 0.004 + 0.012 * taper * taper;
  float fw = fwidth(d);
  return vec3((1.0 - smoothstep(w * 0.3, w + fw, abs(d))) * w / (w + 0.75 * fw) * step(0.0, taper - 0.02), abs(d), taper);
}
`;

const ROCK_ALBEDO = /* glsl */`
{
  vec3 o = vObj + vSpikeP.w * vec3(3.7, 1.3, 5.1);
  vec4 nA = noise3v(o * 0.33);
  vec4 nB = noise3v(o * 1.1 + 0.37);
  vec4 nC = noise3v(o * 3.4 + 0.71);   // grain: pits, crystals, fine roughness
  // strata: horizontal bands warped by low noise, thinner bright laminae inside the bright bands
  float b = vObj.y * 4.5 + (nA.r - 0.5) * 0.7 + vRock.x * 2.0;
  float s = fract(b);
  gStrata = smoothstep(0.62, 0.68, s) * (1.0 - smoothstep(0.84, 0.9, s)) * smoothstep(0.3, 0.55, nA.b);
  float lam = smoothstep(0.8, 0.92, fract(vObj.y * 17.0 + nB.r * 0.8)) * 0.35;
  vec3 basalt = vec3(0.04, 0.038, 0.036) * (0.7 + 0.6 * nB.r) * (0.85 + 0.3 * vRock.x) * (0.8 + 0.4 * nC.g);
  vec3 strata = vec3(0.12, 0.1, 0.08) * (0.8 + 0.4 * nA.g) * (0.85 + 0.3 * nC.b);
  vec3 albedo = mix(basalt, strata, clamp((gStrata + lam) * uRockLook.x, 0.0, 1.0));
  // world-space decals: scorch darkens, frost whitens up-facing faces, magma heats the veins
  vec3 wPos = cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz;
  vec4 wa, wb; vec3 gc;
  impactWeights(wPos, wa, wb, gc);
  albedo *= 1.0 - 0.7 * clamp(wa.x, 0.0, 1.0);
  vec3 wN = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
  // it came up out of the ground: dust caked on the foot, settled on up-facing ledges (sunlit, pale),
  // darker in the pits
  float hu = vObj.y / max(vSizeP.y, 0.01);
  float dirt = max(1.0 - smoothstep(0.02, 0.18 + 0.2 * nA.b, hu), smoothstep(0.45, 0.85, wN.y) * smoothstep(0.4, 0.62, nB.g + 0.1 * nC.r) * 0.75);
  dirt *= 1.0 - 0.85 * smoothstep(0.05, 0.35, vSpikeP.y);   // thrown up hot: soot, no settled dust
  albedo *= 1.0 - 0.55 * smoothstep(0.1, 0.6, vSpikeP.y);
  albedo = mix(albedo, uRockDust * (0.7 + 0.6 * nC.r), dirt);
  albedo *= 0.75 + 0.25 * smoothstep(0.25, 0.6, nC.a);
  albedo = mix(albedo, vec3(0.7, 0.8, 0.9), clamp(wa.y, 0.0, 1.0) * smoothstep(-0.2, 0.6, wN.y) * smoothstep(0.35, 0.6, nB.g));
  gHeat = clamp(vSpikeP.y + wa.w, 0.0, 1.0);
  // three straight-ish fractures through the spike (glowing deep inside when hot, a dull-red rim that
  // cools to dark within a few centimetres), fine dark cracks (albedo only), broken ledge seams
  // (dark; hot only on the face towards the source)
  float crack = vein(nB.r, uRockLook.y * 0.35);
  float sd = mod(vSpikeP.w, 4093.0), jag = (nB.r - 0.5) * 0.016 + (nC.g - 0.5) * 0.006;
  // (hottest where the fracture is widest and low down, nearer the heat; cooler towards its tips)
  float warm = 1.0 - 0.65 * smoothstep(0.1, 0.9, hu);
  gVein = 0.0; gHalo = 0.0; gGlow = 0.0;
  for (int k = 0; k < 3; k++) {
    vec3 hk = hash33(vec3(sd, float(k), 3.1));
    vec3 f = fracture(vObj, hk, hash33(vec3(sd, float(k), 8.7)), jag, vSizeP.x, vSizeP.y) * (k < 2 || hk.y > 0.5 ? 1.0 : 0.0);
    gVein = max(gVein, f.x);
    gGlow = max(gGlow, f.x * f.z * warm);
    gHalo = max(gHalo, exp(-f.y / 0.02) * f.z * warm);
  }
  // the broken face towards the source (the side the spike leans away from), lower part: hot rock
  // under a crust that has started to skin over in patches
  vec2 lean = vLean.xz / max(length(vLean), 1e-4);
  float face = smoothstep(0.2, 0.75, dot(normalize(wN.xz + 1e-5), -lean / max(length(lean), 1e-4))) * smoothstep(0.1, 0.35, length(lean)) * smoothstep(0.15, 0.5, length(wN.xz));
  gFace = face * (1.0 - smoothstep(0.0, 0.22, hu + (nB.g - 0.5) * 0.15)) * smoothstep(0.45, 0.75, nB.r + (nC.r - 0.5) * 0.3);
  albedo *= 1.0 - 0.6 * face * smoothstep(0.1, 0.5, vSpikeP.y);   // the fresh hot face: dark, unweathered basalt
  float seam = vRock.y * smoothstep(0.45, 0.7, nA.g);
  gVein = max(gVein, seam * face);
  gGlow = max(gGlow, seam * face * warm * 0.6);
  gBump = (nB.r * 0.45 + nA.r * 0.3 + nC.r * 0.25) - gVein * 0.6 - crack * 0.2 + gStrata * 0.15;
  gDirt = dirt;
  diffuseColor.rgb = albedo * (1.0 - max(max(gVein, seam) * 0.75, max(crack * 0.3, gHalo * 0.25)));
  // crumble: alpha-to-coverage, dithered so 4 samples give a smooth fade
  float fade = vSpikeP.z;
  diffuseColor.a = fade >= 1.0 ? 1.0 : clamp(fade + (ign(gl_FragCoord.xy) - 0.5) * 0.25, 0.0, 1.0);
  if (diffuseColor.a < 0.01) discard;
}
`;

// Mikkelsen 2010 surface-gradient bump from screen derivatives (three's perturbNormalArb idea)
const ROCK_BUMP = /* glsl */`
{
  vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
  float dhx = dFdx(gBump), dhy = dFdy(gBump);
  vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2) * uRockLook.w * 0.02;
  normal = normalize(abs(det) * normal - grad);
}
`;

const ROCK_EMIT = /* glsl */`
{
  // heat: deep in the fractures at the blackbody colour of ~800..1500 K, a dull-red rim beside them,
  // the broken face below them; the crust itself only near full heat
  float T = mix(800.0, 1500.0, gHeat);
  float h2 = gHeat * gHeat;
  totalEmissiveRadiance += (blackbody(T) * gGlow * h2 * 10.0
    + blackbody(T * 0.7) * (gHalo * h2 * 0.9 + gFace * h2 * 0.35 + smoothstep(0.85, 1.0, gHeat) * 0.05)) * uRockLook.z;
}
`;

const SPELL_LIGHTS = /* glsl */`
{
  gLightNoShadow = uSpikeOpts.x < 0.5;
  vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 wP = cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz;
  vec3 sd, ss;
  spellLightPBR(wP, wN, normalize(cameraPosition - wP), material.roughness, material.specularColor, material.diffuseColor, sd, ss);
  reflectedLight.directDiffuse += sd;
  reflectedLight.directSpecular += ss;
}
`;

function rockMaterial(own) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, alphaToCoverage: true });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, own);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
${INSTANCE_VERT}
attribute vec2 aRock;
varying vec3 vObj;
varying vec2 vRock;
varying vec4 vSpikeP;
varying vec4 vSizeP;
varying vec3 vLean;
mat4 gM;`)
      .replace('#include <beginnormal_vertex>', `gM = spikeMatrix();
vec3 objectNormal = spikeNormal(mat3(gM), normal);`)
      .replace('#include <begin_vertex>', `vec3 transformed = spikeOther() ? vec3(0.0) : (gM * vec4(position, 1.0)).xyz;
vObj = position * vec3(aSize.x, aSize.y, aSize.x);
vRock = aRock; vSpikeP = aSpike; vSizeP = aSize; vLean = mat3(gM) * vec3(0.0, 1.0, 0.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ROCK_FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + ROCK_ALBEDO)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(mix(0.88, 0.62, gStrata) - gVein * 0.25, 0.97, gDirt);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + ROCK_BUMP)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + ROCK_EMIT)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + SPELL_LIGHTS);
  };
  mat.customProgramCacheKey = () => 'ue-spike-rock';
  return mat;
}

// --- ice material ---------------------------------------------------------------------------
const ICE_VERT = INSTANCE_VERT + /* glsl */`
attribute vec4 c0;
attribute vec4 c1;
attribute vec4 c2;
out vec3 vWorld;
out vec3 vN;
out vec3 vLocal;
flat out vec4 vC0;
flat out vec4 vC1;
flat out vec4 vC2;
flat out vec3 vInv0;
flat out vec3 vInv1;
flat out vec3 vInv2;
flat out vec4 vSpikeP;
flat out vec4 vSizeP;
void main() {
  mat4 M = modelMatrix * spikeMatrix();
  mat3 L = mat3(M);
  vec4 wp = M * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(spikeNormal(L, normal));
  vLocal = position;
  mat3 inv = inverse(L);
  vInv0 = inv[0]; vInv1 = inv[1]; vInv2 = inv[2];
  vC0 = c0; vC1 = c1; vC2 = c2;
  vSpikeP = aSpike; vSizeP = aSize;
  gl_Position = spikeOther() ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * wp;
}`;

const ICE_FRAG = COMMON_GLSL + NOISE_GLSL + WORLD_GLSL + LIGHTS_GLSL + /* glsl */`
uniform mat4 projectionMatrix;   // three only declares it in the vertex stage
uniform highp sampler2D uSceneColor;
uniform highp sampler2D uSceneDepth;
uniform samplerCube uSkyCube;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uIceAbsorb;   // Beer-Lambert sigma per metre (red highest -> cyan)
uniform vec4 uIceLook;     // ior, frost, interior, glints
uniform vec3 uIceGlow;     // growth-front emission (linear HDR)
uniform vec4 uSpikeOpts;   // x rock receives capsule shadows, y ice does
in vec3 vWorld;
in vec3 vN;
in vec3 vLocal;
flat in vec4 vC0;
flat in vec4 vC1;
flat in vec4 vC2;
flat in vec3 vInv0;
flat in vec3 vInv1;
flat in vec3 vInv2;
flat in vec4 vSpikeP;
flat in vec4 vSizeP;
out vec4 fragColor;

// half-space dot(p, N) <= off: nearest exit along d, and the two largest signed distances (the
// fragment's own face ~0 and the nearest other face = distance to the nearest edge)
void icePlane(vec3 N, float off, vec3 o, vec3 d, inout float tMin, inout vec3 nExit, inout float s1, inout float s2) {
  float dn = dot(d, N), sd = dot(o, N) - off;
  if (dn > 1e-5) { float t = -sd / dn; if (t < tMin) { tMin = t; nExit = N; } }
  if (sd > s1) { s2 = s1; s1 = sd; } else if (sd > s2) s2 = sd;
}
float crystalExit(vec3 o, vec3 d, out vec3 nExit, out float edge) {
  vec3 b = vC0.xyz, a = vC1.xyz, s = vC2.xyz, u = cross(a, s);
  float w = vC0.w, L = vC1.w, T = vC2.w;
  vec3 apex = b + a * (L + T);
  float tMin = 1e3, s1 = -1e3, s2 = -1e3, il = inversesqrt(T * T + w * w);
  nExit = a;
  vec2 cs = vec2(1.0, 0.0);   // side k at k x 60 degrees, rotated by recurrence (no trig)
  for (int k = 0; k < 6; k++) {
    vec3 n = cs.x * s + cs.y * u;
    icePlane(n, dot(b, n) + w, o, d, tMin, nExit, s1, s2);
    vec3 m = (n * T + a * w) * il;
    icePlane(m, dot(apex, m), o, d, tMin, nExit, s1, s2);
    cs = vec2(cs.x * 0.5 - cs.y * 0.8660254, cs.y * 0.5 + cs.x * 0.8660254);
  }
  icePlane(-a, -dot(b, a), o, d, tMin, nExit, s1, s2);
  edge = -s2;
  return clamp(tMin, 0.0, 4.0);
}
vec2 toUV(vec3 p) { vec4 c = projectionMatrix * viewMatrix * vec4(p, 1.0); return c.xy / c.w * 0.5 + 0.5; }

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWorld);
  float NoV = max(dot(N, V), 1e-3);
  float ior = uIceLook.x;
  mat3 inv = mat3(vInv0, vInv1, vInv2);
  vec3 size = vec3(vSizeP.x, vSizeP.y, vSizeP.x);
  float hf = vLocal.y;   // 0 at the ground, ~1 at the main tip

  // --- through the crystal: enter, exact convex exit, refract out (or TIR) -----------------
  vec3 R = refract(-V, N, 1.0 / ior);
  vec3 nL, ld = inv * R;
  float edge;
  float thick = crystalExit(vLocal, ld, nL, edge);
  vec3 nX = normalize(nL * inv);   // exit face normal in world space (inverse transpose)
  vec3 R2 = refract(R, -nX, ior);
  float tir = dot(R2, R2) < 1e-4 ? 1.0 : 0.0;
  if (tir > 0.5) R2 = reflect(R, nX);
  vec3 pExit = vWorld + R * thick;

  vec2 uv = gl_FragCoord.xy / uResolution;
  float iceZ = linearDepth(gl_FragCoord.z);
  float sceneZ = linearDepth(texture(uSceneDepth, uv).r);
  float behind = clamp(sceneZ - iceZ, 0.2, 3.0);
  vec2 ruv = clamp(toUV(pExit + R2 * behind * 0.5), 0.002, 0.998);
  // the bent ray landed on something in front of the ice: fall back to the straight view (UW)
  float rZ = linearDepth(texture(uSceneDepth, ruv).r);
  ruv = mix(uv, ruv, smoothstep(iceZ - 0.05, iceZ + 0.25, rZ));
  vec3 bg = textureLod(uSceneColor, ruv, 0.0).rgb;
  float path = thick + tir * vSizeP.x * 0.6;   // TIR: one more trip through the body
  vec3 Tr = exp(-uIceAbsorb * path);

  // --- light: spell lights (GGX on the flat facet), sun, sky -------------------------------
  vec3 sd, ss;
  gLightNoShadow = uSpikeOpts.y < 0.5;   // capsule shadows per ice pixel cost more than they show
  spellLightPBR(vWorld, N, V, 0.04, vec3(0.018), vec3(1.0), sd, ss);
  float NoL = max(dot(N, uSunDir), 0.0);
  vec3 H = normalize(uSunDir + V);
  float a = 0.0016;   // GGX alpha for roughness 0.04
  float sunSpec = spellD_GGX(max(dot(N, H), 0.0), a) * spellV_Smith(NoV, NoL, a) * NoL * PI;
  vec3 irr = uAmbient + uSunColor * NoL + sd;        // diffuse radiance factor for white, this facet
  vec3 irrOmni = uAmbient + uSunColor * 0.5 + sd;    // light scattered inside (one light loop only)

  // --- fake interior: 3 taps along the refracted ray read as bubbles, veils and cracks -----
  float seedOff = vSpikeP.w * 0.13;
  float scat = 0.0;
  vec3 ldS = ld * size;   // object-space metres per metre of path
  for (int i = 1; i <= 3; i++) {
    float f = float(i) * 0.25;
    vec3 q = vLocal * size + ldS * thick * f;
    vec4 n = noise3v(q * 0.42 + seedOff);
    float veil = smoothstep(0.6, 0.95, n.r) * 0.35;
    float bubble = smoothstep(0.84, 0.95, n.a) * 1.6;
    float crack = smoothstep(0.03, 0.0, abs(n.g - 0.55)) * smoothstep(0.3, 0.6, n.r) * 1.4;
    scat += (veil + bubble + crack) * exp(-uIceAbsorb.r * thick * f);
  }
  scat *= uIceLook.z / 3.0;

  // --- frost: rough white on edges, at the base and in noisy patches ------------------------
  // (edge band scales with the crystal: thin crystals keep clear faces)
  vec4 fn = noise3v(vLocal * size * 1.7 + seedOff);
  float ew = vC0.w * 0.07;   // edge distance spans 0 .. 0.5 apothem across a face
  vec4 fe = noise3v(vLocal * size * 5.0 + seedOff);   // rime grows unevenly along the edges
  float ewl = ew * (0.2 + 1.8 * fe.r * fe.r);
  float frost = smoothstep(ewl, ewl * 0.15, edge - (fe.g - 0.5) * ew * 0.8);
  frost = max(frost, smoothstep(0.12, 0.0, hf + (fn.g - 0.5) * 0.12));
  frost = max(frost, smoothstep(0.84, 0.97, fn.b) * 0.3);
  // growth front: everything above it is still forming (milky, glowing), a bright band on it
  float front = vSizeP.z, glow = vSizeP.w;
  float above = smoothstep(front - 0.02, front + 0.02, hf) * glow;
  frost = clamp(max(frost, above) * uIceLook.y, 0.0, 1.0);

  // --- compose ------------------------------------------------------------------------------
  float F = 0.018 + 0.982 * pow(1.0 - NoV, 5.0);
  vec3 refl = textureLod(uSkyCube, reflect(-V, N), 0.0).rgb;
  // transmitted background + cyan in-scatter of the column (UW's water body) + interior features
  vec3 inscat = vec3(0.04, 0.34, 0.62) * irrOmni * 0.5;
  vec3 body = bg * Tr + inscat * (1.0 - Tr) + vec3(0.8, 0.92, 1.0) * irrOmni * scat * 0.2;
  body += tir * inscat * 0.4;
  vec3 col = body * (1.0 - F) + (refl * F + ss + uSunColor * F * sunSpec) * (1.0 - frost * 0.8);
  vec3 frostCol = vec3(0.82, 0.9, 1.0) * irr;
  col = mix(col, frostCol, frost * 0.85);

  // glints: tiny random facets whose hash changes with the view direction and time (they flick
  // on and off as you orbit, like real ice), lit by whatever reaches this face; faded when sub-pixel
  vec3 gq = vLocal * size * 26.0;
  vec3 cell = floor(gq);
  vec3 gh = hash33(cell + floor(V * 5.0) * 17.0);
  float tw = pow(0.5 + 0.5 * sin(uTime * 7.0 + gh.y * 60.0), 6.0);
  float spot = smoothstep(0.35, 0.0, length(fract(gq) - 0.5 - (gh - 0.5) * 0.4));
  float px = length(fwidth(gq));
  float glint = step(0.93, gh.x) * spot * tw * smoothstep(1.2, 0.4, px) * (0.4 + frost);
  col += glint * (irr * 6.0 + ss * 0.5) * uIceLook.w;

  float band = exp(-abs(hf - front) * 26.0) * glow;
  col += uIceGlow * (band * 3.0 + above * 0.35);

  float fade = vSpikeP.z;
  float alpha = fade >= 1.0 ? 1.0 : clamp(fade + (ign(gl_FragCoord.xy) - 0.5) * 0.25, 0.0, 1.0);
  if (alpha < 0.01) discard;
  fragColor = vec4(col, alpha);
}`;

// --- spikes ---------------------------------------------------------------------------------
const DEFAULTS = { height: 2, radius: 0.4, material: 'rock', delay: 0, rise: 0.15, life: 4, crumble: 0.6, heat: 0, seed: 0 };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _qt = new THREE.Quaternion();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _ax = new THREE.Vector3(), _v = new THREE.Vector3();
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1, y = x - 1; return 1 + c3 * y * y * y + c1 * y * y; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Spikes {
  constructor({ max = 48 } = {}) {
    this.max = max;
    this.uniforms = {
      ...U,
      uRockLook: { value: new THREE.Vector4(1, 0.022, 1, 1) },   // strata contrast, vein width, heat glow, bump
      uRockDust: { value: new THREE.Color(0.15, 0.13, 0.11) },
      uIceAbsorb: { value: new THREE.Vector3(2.6, 0.75, 0.3) },
      uIceLook: { value: new THREE.Vector4(1.31, 1, 1, 1) },       // ior, frost, interior, glints
      uIceGlow: { value: new THREE.Vector3(0.6, 1.6, 2.6) },
      // receive capsule shadows (rock, ice): off by default, each costs ~2 texel fetches per capsule
      // per shadowed light per pixel (0.2 ms for 8 spikes on a 3060); a uniform, so tiers can flip it
      uSpikeOpts: { value: new THREE.Vector4(0, 0, 0, 0) },
    };
    const rockGeo = merged([0, 1, 2, 3].map(rockVariant), [['rock', 2]]);
    rockGeo.setAttribute('aRock', rockGeo.attributes.rock);
    rockGeo.deleteAttribute('rock');
    const iceGeo = merged([0, 1, 2, 3].map(iceVariant), [['c0', 4], ['c1', 4], ['c2', 4]]);
    this.triangles = { rock: rockGeo.attributes.position.count / 12, ice: iceGeo.attributes.position.count / 12 };   // per variant

    this.kinds = {};
    for (const [name, geo] of [['rock', rockGeo], ['ice', iceGeo]]) {
      const attrs = ['aM0', 'aM1', 'aM2', 'aSpike', 'aSize'].map((n) => instanced(geo, n, max));
      geo.instanceCount = 0;
      const mat = name === 'rock' ? rockMaterial(this.uniforms) : new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms: this.uniforms, vertexShader: ICE_VERT, fragmentShader: ICE_FRAG,
        alphaToCoverage: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.kinds[name] = { mesh, geo, attrs, arrays: attrs.map((a) => a.array), count: 0 };
    }
    // rock first in the opaque pass: early-Z then skips the floor under every spike
    this.kinds.rock.mesh.renderOrder = -1;
    this.opaque = new THREE.Group();
    this.opaque.add(this.kinds.rock.mesh);
    this.refract = new THREE.Group();
    this.refract.add(this.kinds.ice.mesh);

    this.spikes = Array.from({ length: max }, (_, index) => ({
      index, active: false, ...DEFAULTS,
      pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0),
      age: 0, state: 'waiting',          // waiting | rising | standing | crumbling
      emerge: 0, fade: 1,
      matrix: new THREE.Matrix4(),       // current instance transform (unit spike -> world)
      capsule: { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0 },   // current, even if not registered
      occluder: null,
      // current tip (world); pos is the base on the ground, for debris
      top(out) { return out.set(0, 1.02, 0).applyMatrix4(this.matrix); },
      release() { this.active = false; this.occluder?.release(); this.occluder = null; },
    }));
  }

  // pos/dir: Vector3 (copied, dir normalised). Returns null when all `max` are live.
  spawn(opts = {}) {
    let h = null;
    for (const s of this.spikes) if (!s.active) { h = s; break; }
    if (!h) return null;
    Object.assign(h, DEFAULTS);
    h.dir.set(0, 1, 0);
    h.seed = (Math.random() * 16777216) | 0;
    for (const k in opts) {
      const v = opts[k];
      if (v && v.isVector3) h[k].copy(v); else h[k] = v;
    }
    h.dir.normalize();
    h.age = 0; h.state = 'waiting'; h.emerge = 0; h.fade = 1;
    h.occluder?.release(); h.occluder = null;
    h.active = true;
    this._pose(h, -h.height, 0.75, 1, 0);   // sunk: capsule data valid before the rise
    return h;
  }

  _pose(h, offset, radial, axial, tilt) {
    const yaw = ((h.seed * 0.6180339887) % 1) * Math.PI * 2;
    _qy.setFromAxisAngle(UP, yaw);
    _q.setFromUnitVectors(UP, h.dir);
    if (tilt) {
      _ax.set(Math.cos(h.seed), 0, Math.sin(h.seed));
      _q.multiply(_qt.setFromAxisAngle(_ax, tilt));
    }
    _q.multiply(_qy);
    _p.copy(h.pos).addScaledVector(h.dir, offset);
    _s.set(h.radius * radial, h.height * axial, h.radius * radial);
    h.matrix.compose(_p, _q, _s);
    const c = h.capsule;
    c.a.set(0, 0.1, 0).applyMatrix4(h.matrix);
    c.b.set(0, 0.78, 0).applyMatrix4(h.matrix);
    c.radius = h.radius * radial * 0.5;
  }

  update(dt) {
    let dirty = false;
    this.kinds.rock.count = this.kinds.ice.count = 0;
    for (const h of this.spikes) {
      if (!h.active) continue;
      h.age += dt;
      const t = h.age - h.delay;
      if (t < 0) { h.state = 'waiting'; continue; }
      if (t >= h.life + h.crumble) { h.release(); continue; }
      const ice = h.material === 'ice';
      let offset, radial = 1, axial = 1, tilt = 0;
      if (t < h.life) {
        const u = Math.min(1, t / Math.max(h.rise, 1e-3));
        h.state = u < 1 ? 'rising' : 'standing';
        h.emerge = easeOutBack(u);
        offset = (h.emerge - 1) * h.height;
        radial = 0.75 + 0.25 * Math.min(h.emerge, 1);
        h.fade = 1;
        if (!h.occluder) h.occluder = occluders.add(h.capsule.a, h.capsule.b, h.capsule.radius, 2);
      } else {
        if (h.state !== 'crumbling') { h.occluder?.release(); h.occluder = null; }
        h.state = 'crumbling';
        const v = (t - h.life) / Math.max(h.crumble, 1e-3);
        offset = -v * v * h.height * (ice ? 0.25 : 0.55);
        radial = 1 - (ice ? 0.45 : 0.3) * v;
        axial = 1 - (ice ? 0.35 : 0.2) * v;
        tilt = (ice ? 0.05 : 0.22) * v * v;
        h.fade = 1 - smooth(ice ? 0.1 : 0.25, 1, v);
      }
      this._pose(h, offset, radial, axial, tilt);
      if (h.occluder) { h.occluder.a.copy(h.capsule.a); h.occluder.b.copy(h.capsule.b); h.occluder.radius = h.capsule.radius; }

      // ice: the growth front sweeps base -> tip over ~4x the rise, its glow dies with it
      const fu = ice ? Math.min(1, t / Math.max(h.rise * 4, 0.3)) : 1;
      const K = this.kinds[ice ? 'ice' : 'rock'], X = K.arrays, o = K.count * 4, e = h.matrix.elements;
      dirty = put4(X[0], o, e[0], e[4], e[8], e[12]) || dirty;
      dirty = put4(X[1], o, e[1], e[5], e[9], e[13]) || dirty;
      dirty = put4(X[2], o, e[2], e[6], e[10], e[14]) || dirty;
      dirty = put4(X[3], o, h.seed & 3, h.heat, h.fade, (h.seed % 997) / 997) || dirty;
      dirty = put4(X[4], o, h.radius, h.height, fu * 1.3 - 0.05, ice ? 1 - smooth(0.75, 1, fu) : 0) || dirty;
      K.count++;
    }
    for (let i = 0; i < 2; i++) {
      const K = i ? this.kinds.ice : this.kinds.rock;
      K.geo.instanceCount = K.count;
      K.mesh.visible = K.count > 0;
      if (K.count && dirty) for (const a of K.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, K.count * 4); a.needsUpdate = true; }
    }
  }

  get live() { return this.kinds.rock.count + this.kinds.ice.count; }
}
