import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { U, COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL, arenaSDF } from '../vfx/common.js';
import { blackbodyRGB } from '../vfx/noise.js';
import { FluidVolume } from '../vfx/FluidVolume.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Earth (PLAN 3).
// Upheaval: a crack races from the caster's side to the target along the vein network (a 'line'
// splat of crack potential re-stamped as its head advances) while the floor rumbles at 8 Hz,
// pebbles hop and dust seeps from it. Then a line of rock spikes erupts in sequence (staggered
// ease-out-back), each tearing a radial crack, throwing rock debris and chunks, rolling a ring of
// ground-hugging dust outward and a plume up; the last and biggest rams the target with a floor
// shock ring. The spikes crumble into falling rock; the cracks stay ~15 s.
// Meteor: rock chunks tear out of the floor around the caster and fly in to assemble a boulder
// (a particle swarm pulled in by an attractor fills the gaps), which is then lobbed on a heavy
// ballistic arc, glowing seams heating up in flight, and lands in a crater: crack splat, a rim of
// upturned slabs, debris, dust, shock ring, the heaviest shake.
// Magma: a tiny local GPU probe reads ground heat under every live spike (any heat source: fire,
// lightning, a molten preset); hot spikes glow (spike.heat), add a 'magma' impact (floor cracks
// glow around them) and crumble into glowing chunks.

const MAX_SPIKES = 12, MAX_RIM = 10, CHUNKS = 15, BOULDERS = 3, PROBES = 16;
const CORE_R = 0.62;  // m per meteorSize: the finished boulder's radius
const FRAG = 0.3;     // fragment geometry scale
const GRAVITY = 16;   // the boulder's arc: heavier than life reads as weight
const STATES = 16;    // one per cast record

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _s = new THREE.Vector3();
const _push = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _col = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// reused option objects: the shared systems destructure options, so a literal per call would allocate
const SPL = { x: 0, z: 0, radius: 1, heat: 0, char: 0, wet: 0, frost: 0, crack: 0, acid: 0, corruption: 0, glow: 0, pattern: 'radial', seed: 0, angle: 0, x2: 0, z2: 0, width: 0 };
const SPK = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), height: 1, radius: 0.4, material: 'rock', delay: 0, rise: 0.15, life: 3, crumble: 0.9, heat: 0, seed: 1 };
const SHK = { pos: new THREE.Vector3(), radius0: 0.2, radius1: 6, duration: 0.5, thickness: 0.6, distortion: 0.05, color: null, intensity: 0, ground: true };

// --- boulder geometry (built once at load) ---------------------------------------------------
function hash3i(x, y, z, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683) + Math.imul(s, 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi);
  const c = (i, j, k) => hash3i(xi + i, yi + j, zi + k, s);
  const L = (a, b, t) => a + (b - a) * t;
  return L(L(L(c(0, 0, 0), c(1, 0, 0), u), L(c(0, 1, 0), c(1, 1, 0), u), v), L(L(c(0, 0, 1), c(1, 0, 1), u), L(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
function fbm(x, y, z, s, oct) {
  let sum = 0, a = 0.5, n = 0;
  for (let o = 0; o < oct; o++) { sum += a * vnoise(x, y, z, s + o * 17); n += a; a *= 0.5; x *= 2.03; y *= 2.03; z *= 2.03; }
  return sum / n;
}
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

// A volcanic bomb: an icosphere (`detail` subdivisions per edge) pushed out by broad lumps, cut by
// fracture planes (broken faces with rounded edges), split into crust plates by grooves (spherical
// voronoi seams, where the molten core shows), with ridged crags and grain on top. Smooth normals.
// aCrack = seam (0..1), aAO = cavity occlusion from the depth below the lumpy envelope.
function boulderGeometry(detail, seed, plates, grain) {
  const rand = lcg(seed);
  const g0 = new THREE.IcosahedronGeometry(1, detail);
  g0.deleteAttribute('normal'); g0.deleteAttribute('uv');
  const g = mergeVertices(g0);
  const p = g.attributes.position, n = p.count;
  const planes = [];
  for (let k = 0; k < 7; k++) {
    const v = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    planes.push([v.x, v.y, v.z, 0.7 + rand() * 0.16]);
  }
  const pts = [];
  for (let k = 0; k < plates; k++) {
    const v = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();   // random: plates of every size
    pts.push(v.x, v.y, v.z);
  }
  const sy = 0.74 + rand() * 0.1, sz = 0.84 + rand() * 0.1;
  const crack = new Float32Array(n), ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
    let r = (0.92 + 0.5 * (fbm(x * 1.1 + 3.1, y * 1.1, z * 1.1, seed, 3) - 0.5)) * (1 + 0.12 * x);   // lumpy, one end heavier
    for (const [a, b, c, o] of planes) { const d = x * a + y * b + z * c; if (d > 0.05) r = smin(r, o / d, 0.07); }
    const env = r;
    let f1 = 9, f2 = 9;
    for (let k = 0; k < pts.length; k += 3) {
      const dx = x - pts[k], dy = y - pts[k + 1], dz = z - pts[k + 2], d = dx * dx + dy * dy + dz * dz;
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    const seam = (1 - smooth((Math.sqrt(f2) - Math.sqrt(f1)) / (0.05 + 0.06 * vnoise(x * 4, y * 4, z * 4, seed + 3))));
    r -= 0.05 * seam * seam;
    const ridge = 1 - Math.abs(2 * fbm(x * 3.3, y * 3.3 + 7.7, z * 3.3, seed + 5, 3) - 1);
    r += 0.04 * ridge * ridge - 0.018;
    r += grain * (fbm(x * 11, y * 11, z * 11 + 1.3, seed + 9, 2) - 0.5);
    p.setXYZ(i, x * r, y * r * sy, z * r * sz);
    crack[i] = seam;
    ao[i] = 1 - 0.8 * smooth((env - r - 0.008) / 0.06);
  }
  g.setAttribute('aCrack', new THREE.BufferAttribute(crack, 1));
  g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// Molten-crusted rock (MeshStandardMaterial + onBeforeCompile, opaque pass): a dark basalt crust,
// a paler ash skin on the lumps, cavities darker (baked AO on ambient, half on direct light), a
// derivative bump from two noise taps for the rough crust; the seams (geometry grooves) and a finer
// crazing glow at the blackbody colour of the heat, the face ramming the air hottest; a dull red
// halo under the crust around the seams.
const BOULDER_PARS = /* glsl */`
uniform vec3 uRock;
uniform vec4 uBoulder;      // heat 0..1, -, -, -
uniform vec3 uBoulderVel;   // world flight direction (0 when not flying)
varying vec3 vObj;
varying float vSeed;
varying float vCrack;
varying float vAO;
float gGlow; float gHalo; float gBump; float gRough;
`;
const BOULDER_ALBEDO = /* glsl */`
{
  vec3 o = vObj + vSeed;
  vec4 nA = noise3v(o * 0.55);
  vec4 nB = noise3v(o * 2.1 + 0.37);
  // crazing: the fbm's zero set, ~constant width in pixels, coverage-preserving with distance
  float fv = fwidth(nB.r), w = 0.016;
  float craze = (1.0 - smoothstep(w, w + fv * 1.5, abs(nB.r - 0.5))) * w / (w + 0.75 * fv) * smoothstep(0.4, 0.65, nA.g);
  // seams: open and hot in places, crusted over in others, so no even network of lines
  float seam = smoothstep(0.25, 0.9, vCrack) * smoothstep(0.3, 0.62, nA.g + 0.25 * nB.b);
  gGlow = max(seam, craze * 0.3);
  gHalo = smoothstep(0.0, 0.75, vCrack);
  vec3 crust = uRock * (0.6 + 0.8 * nB.g) * (0.8 + 0.4 * nA.r);
  crust = mix(crust, vec3(0.15, 0.14, 0.13) * (0.75 + 0.5 * nB.b), smoothstep(0.5, 0.8, nA.b) * 0.5);
  crust *= mix(0.4, 1.0, vAO);
  diffuseColor.rgb = crust * (1.0 - 0.85 * gGlow);
  gBump = nB.r * 0.5 + nB.a * 0.3 + nA.r * 0.2 - gGlow * 0.3;
  gRough = clamp(mix(0.94, 0.45, gGlow) - 0.12 * nB.b, 0.3, 1.0);
}
`;
const BOULDER_BUMP = /* glsl */`
{
  vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
  float dhx = dFdx(gBump), dhy = dFdy(gBump);
  vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  normal = normalize(abs(det) * normal - sign(det) * (dhx * r1 + dhy * r2) * 0.035);
}
`;
const BOULDER_EMIT = /* glsl */`
{
  float h = uBoulder.x;
  if (h > 0.001) {
    vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    float lead = dot(wN, uBoulderVel);
    float hh = clamp(h * (1.0 + 0.55 * max(lead, 0.0) - 0.3 * max(-lead, 0.0)), 0.0, 1.2);
    float T = mix(800.0, 1420.0, hh), Th = T * 0.78;
    float R = pow(T / 1500.0, 4.0) * smoothstep(800.0, 1050.0, T);
    float Rh = pow(Th / 1500.0, 4.0) * smoothstep(720.0, 1050.0, Th);
    totalEmissiveRadiance += blackbody(T) * (R * 7.0 * gGlow) + blackbody(Th) * (Rh * 0.3 * gHalo);
  }
}
`;
const BOULDER_LIGHT = /* glsl */`
{
  reflectedLight.indirectDiffuse *= vAO;
  reflectedLight.indirectSpecular *= vAO;
  reflectedLight.directDiffuse *= mix(0.5, 1.0, vAO);
  vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  vec3 wP = cameraPosition + (vec4(-vViewPosition, 0.0) * viewMatrix).xyz;
  vec3 sd, ss;
  gLightNoShadow = true;
  spellLightPBR(wP, wN, normalize(cameraPosition - wP), material.roughness, material.specularColor, material.diffuseColor, sd, ss);
  reflectedLight.directDiffuse += sd * vAO;
  reflectedLight.directSpecular += ss;
}
`;
function boulderMaterial(own) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, own);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aCrack;\nattribute float aAO;\nvarying vec3 vObj;\nvarying float vSeed;\nvarying float vCrack;\nvarying float vAO;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = position;\nvSeed = float(gl_InstanceID) * 7.31;\nvCrack = aCrack;\nvAO = aAO;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON_GLSL + NOISE_GLSL + WORLD_GLSL + LIGHTS_GLSL + BOULDER_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + BOULDER_ALBEDO)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + BOULDER_BUMP)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + BOULDER_EMIT)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + BOULDER_LIGHT);
  };
  mat.customProgramCacheKey = () => 'ue-earth-boulder2';
  return mat;
}

// ground heat under live spikes: PROBES texels, read back async (PBO + fence, 2-3 frames late)
const PROBE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uGroundA;
uniform vec4 uGroundRect;
uniform vec2 uProbe[${PROBES}];
out vec4 outColor;
void main() { outColor = texture(uGroundA, (uProbe[int(gl_FragCoord.x)] - uGroundRect.xy) * uGroundRect.w); }`;

export default {
  id: 'earth', name: 'Earth', key: '5', hue: '#c08a4a',
  shape: 'projectile', forms: ['Upheaval', 'Meteor'], speed: 8, radius: 0.5,
  params: {
    size: 1, height: 2.4, spikes: 7, stagger: 0.03, hold: 3, debris: 1, dust: 1, crack: 1, shake: 1,
    heat: 0, glow: 0, meteorSize: 1, arc: 3.5, meteorHeat: 0.6, rim: 6,
    rockColor: '#3b342d', dustColor: '#696159',
  },
  ranges: {
    size: [0.4, 2, 0.01], height: [0.8, 4.5, 0.01], spikes: [3, MAX_SPIKES, 1], stagger: [0, 0.12, 0.001], hold: [0.5, 8, 0.1],
    debris: [0, 3, 0.01], dust: [0, 3, 0.01], crack: [0, 2, 0.01], shake: [0, 2, 0.01], heat: [0, 1, 0.01], glow: [0, 2, 0.01],
    meteorSize: [0.5, 2, 0.01], arc: [1, 8, 0.1], meteorHeat: [0, 1, 0.01], rim: [0, MAX_RIM, 1],
  },
  presets: {
    molten: { heat: 0.85, meteorHeat: 1, glow: 1, dustColor: '#4a3c35', rockColor: '#2e2622' },
    desert: { dustColor: '#b39573', rockColor: '#6b5643', dust: 1.5, crack: 0.7 },
    tectonic: { spikes: 11, height: 3.4, size: 1.3, stagger: 0.045, shake: 1.4, debris: 1.4, meteorSize: 1.6, rim: 10 },
  },
  timing: { charge: 0.5, impact: 0.35, linger: 4.3 },
  kinds: {
    // debris (instanced rock meshes in the opaque pass): color[1] = emission, alpha[1] = roughness
    pebble: { style: 'debris', mesh: 'rock', gravity: 11, drag: 0.1, restitution: 0.45, friction: 0.5, life: [0.9, 1.6], size: [0.05, 0.05], spin: 9, color: ['#4a4038', '#000000'], alpha: [1, 0.85], fadeOut: 0.25, forceResponse: 0 },
    rock: { style: 'debris', mesh: 'rock', gravity: 11, drag: 0.08, restitution: 0.3, friction: 0.6, life: [3.2, 4.8], size: [0.09, 0.09], spin: 7, color: ['#3b342d', '#000000'], alpha: [1, 0.9], fadeOut: 0.12, forceResponse: 0 },
    chunk: { style: 'debris', mesh: 'rock', gravity: 11, drag: 0.05, restitution: 0.22, friction: 0.7, life: [3.6, 5], size: [0.19, 0.19], spin: 4, color: ['#3b342d', '#000000'], alpha: [1, 0.9], fadeOut: 0.12, forceResponse: 0 },
    magma: { style: 'debris', mesh: 'rock', gravity: 11, drag: 0.08, restitution: 0.25, friction: 0.65, life: [2.6, 4], size: [0.13, 0.13], spin: 6, color: ['#1c130e', new THREE.Color(5, 0.85, 0.1)], alpha: [1, 0.7], fadeOut: 0.15, forceResponse: 0, paints: 'heat', paintAmount: 0.05 },
    gather: { style: 'debris', mesh: 'rock', gravity: 2, drag: 0.6, restitution: -1, life: [0.6, 1.0], size: [0.11, 0.07], spin: 10, color: ['#3b342d', '#000000'], alpha: [1, 0.9], fadeOut: 0.1, forceResponse: 1 },
    // media (half-res WBOIT spherical billboards)
    dust: { style: 'media', drag: 2.4, buoyancy: -0.35, curl: 0.5, curlScale: 0.18, restitution: 0, friction: 0, life: [2.4, 4.2], size: [0.45, 2.0], sizePow: 0.55, color: ['#5f4e3e', '#4e4034'], alpha: [0.1875, 0.0875], density: 2.0, erosion: 0.55, fadeIn: 0.05, fadeOut: 0.6, forceResponse: 0.5, lightResponse: 1.5 },
    // Upheaval's own dust and plume: the same media at half the count and 1.75x the alpha (about the
    // same opacity through the cloud, half as many overlapping billboards: they were 2.2 ms of overdraw at
    // its peak). Its own kinds, so Meteor and Starfall (which borrows earth.dust) keep theirs.
    updust: { style: 'media', drag: 2.4, buoyancy: -0.35, curl: 0.5, curlScale: 0.18, restitution: 0, friction: 0, life: [2.4, 4.2], size: [0.45, 2.0], sizePow: 0.55, color: ['#5f4e3e', '#4e4034'], alpha: [0.33, 0.155], density: 2.0, erosion: 0.55, fadeIn: 0.05, fadeOut: 0.6, forceResponse: 0.5, lightResponse: 1.5 },
    upplume: { style: 'media', drag: 1.8, buoyancy: 0.35, curl: 0.7, curlScale: 0.2, life: [2, 3.4], size: [0.35, 1.7], sizePow: 0.6, color: ['#5f4e3e', '#4e4034'], alpha: [0.27, 0.11], density: 1.8, erosion: 0.6, fadeIn: 0.06, fadeOut: 0.6, forceResponse: 0.6, lightResponse: 1.5 },
    plume: { style: 'media', drag: 1.8, buoyancy: 0.35, curl: 0.7, curlScale: 0.2, life: [2, 3.4], size: [0.35, 1.7], sizePow: 0.6, color: ['#5f4e3e', '#4e4034'], alpha: [0.15, 0.0625], density: 1.8, erosion: 0.6, fadeIn: 0.06, fadeOut: 0.6, forceResponse: 0.6, lightResponse: 1.5 },
    seep: { style: 'media', drag: 1.8, buoyancy: 0.5, curl: 0.8, curlScale: 0.3, life: [0.9, 1.7], size: [0.2, 0.9], color: ['#6e5c49', '#5c4e40'], alpha: [0.1375, 0], density: 2, erosion: 0.55, fadeIn: 0.15, forceResponse: 0.5 },
    trail: { style: 'media', drag: 2.2, buoyancy: 0.2, curl: 0.6, curlScale: 0.25, life: [0.7, 1.4], size: [0.25, 0.9], color: ['#6e5c49', '#5c4e40'], alpha: [0.075, 0], density: 1.4, erosion: 0.6, forceResponse: 0.5 },
    // glow
    ember: { style: 'glow', drag: 0.8, buoyancy: 0.6, gravity: 3, curl: 1.5, curlScale: 0.4, life: [0.5, 1.3], size: [0.035, 0.012], stretch: 0.02, emissive: 3, temp: [1800, 900], restitution: 0.3, friction: 0.4 },
    // the meteor's wake and impact: smoke boiling off the crust, an invisible heat shimmer (media
    // that only writes distortion), molten spatter, and a blast of incandescent dust turning to smoke
    smoke: { style: 'media', drag: 1.5, buoyancy: 0.55, curl: 0.9, curlScale: 0.25, life: [1.8, 3.2], size: [0.35, 2.2], sizePow: 0.5, color: ['#2e2a27', '#3e3934'], alpha: [0.22, 0.06], density: 2.6, erosion: 0.6, fadeIn: 0.08, fadeOut: 0.55, forceResponse: 0.6, lightResponse: 1.3 },
    haze: { style: 'media', drag: 2.4, buoyancy: 0.9, curl: 1.2, curlScale: 0.4, life: [0.35, 0.7], size: [0.45, 1.0], color: ['#7f7f7f', '#7f7f7f'], alpha: [0.006, 0], density: 1, erosion: 0.3, distortion: 90, fadeIn: 0.1, fadeOut: 0.5, forceResponse: 0.3 },
    spatter: { style: 'glow', drag: 0.35, gravity: 9.8, life: [0.4, 0.9], size: [0.028, 0.012], stretch: 0.035, emissive: 5, temp: [1550, 900], restitution: 0.15, friction: 0.7 },
    blast: { style: 'media', drag: 2.3, buoyancy: 0.8, curl: 1.0, curlScale: 0.3, life: [1.0, 2.2], size: [0.5, 2.1], sizePow: 0.5, emissive: 0.4, temp: [1350, 650], toSmokeAt: 0.12, smokeAlbedo: 0.1, alpha: [0.3, 0.05], density: 2.4, erosion: 0.7, fadeIn: 0.03, fadeOut: 0.5, forceResponse: 0.5 },
  },

  create(fx) {
    const S = this, P = fx.particles, gl = fx.renderer.getContext();
    // emitters: reusable handles, fields set right before each burst / rate
    const pebbleLine = P.emitter('earth.pebble', { shape: 'line', radius: 0.12, spread: 0.9 });
    const seepLine = P.emitter('earth.seep', { shape: 'line', radius: 0.1, spread: 0.25 });
    const rockCone = P.emitter('earth.rock', { shape: 'cone', radius: 0.3, spread: 1.2, radial: 6, cone: 0.8 });
    const rockRing = P.emitter('earth.rock', { shape: 'ring', radius: 0.5, spread: 1.7, radial: 2.6 });
    const chunkRing = P.emitter('earth.chunk', { shape: 'ring', radius: 0.5, spread: 0.8, radial: 2.5 });
    const dustRing = P.emitter('earth.dust', { shape: 'ring', radius: 0.6, spread: 0.8, radial: 6.5 });
    const plume = P.emitter('earth.plume', { shape: 'sphere', radius: 0.4, spread: 1.0 });
    const upRing = P.emitter('earth.updust', { shape: 'ring', radius: 0.6, spread: 0.8, radial: 6.5 });
    const upPlume = P.emitter('earth.upplume', { shape: 'sphere', radius: 0.4, spread: 1.0 });
    const upPuff = P.emitter('earth.updust', { shape: 'sphere', radius: 0.4, spread: 0.8, radial: 1.5 });
    const rockLine = P.emitter('earth.rock', { shape: 'line', radius: 0.15, spread: 1.0 });
    const chunkLine = P.emitter('earth.chunk', { shape: 'line', radius: 0.15, spread: 0.7 });
    const magmaLine = P.emitter('earth.magma', { shape: 'line', radius: 0.15, spread: 1.0 });
    const magmaBurst = P.emitter('earth.magma', { shape: 'sphere', radius: 0.4, spread: 2, radial: 5 });
    const puff = P.emitter('earth.dust', { shape: 'sphere', radius: 0.4, spread: 0.8, radial: 1.5 });
    const gather = P.emitter('earth.gather', { shape: 'ring', radius: 2.6, spread: 0.5, radial: -4 });
    const gatherDust = P.emitter('earth.seep', { shape: 'ring', radius: 2.6, spread: 0.4 });
    const trailDust = P.emitter('earth.trail', { shape: 'sphere', radius: 0.4, spread: 0.4 });
    const trailPebble = P.emitter('earth.pebble', { shape: 'sphere', radius: 0.4, spread: 0.6 });
    const ember = P.emitter('earth.ember', { shape: 'sphere', radius: 0.45, spread: 1.2 });
    const tear = P.emitter('earth.pebble', { shape: 'sphere', radius: 0.25, spread: 1.6 });
    const bigChunk = P.emitter('earth.chunk', { shape: 'sphere', radius: 0.4, spread: 1.5, radial: 4 });
    const smoke = P.emitter('earth.smoke', { shape: 'sphere', radius: 0.35, spread: 0.5 });
    const haze = P.emitter('earth.haze', { shape: 'sphere', radius: 0.4, spread: 0.3 });
    const spatter = P.emitter('earth.spatter', { shape: 'shell', radius: 0.45, spread: 1.6, radial: 2.5 });
    const blast = P.emitter('earth.blast', { shape: 'sphere', radius: 0.6, spread: 1.2, radial: 3 });

    // --- per-cast state, preallocated (c.data.e = states[c.index]) ---
    const spikeState = () => ({ h: null, seed: 0, pos: new THREE.Vector3(), dir: new THREE.Vector3(), height: 1, radius: 0.4, delay: 0, life: 3, u: 0, rim: false, erupted: false, crumbled: false, ground: 0, heat: 0, magma: false });
    const states = Array.from({ length: STATES }, () => ({
      alive: false, spikes: Array.from({ length: MAX_SPIKES + MAX_RIM }, spikeState), n: 0,
      start: new THREE.Vector3(), end: new THREE.Vector3(), fwd: new THREE.Vector3(), perp: new THREE.Vector3(),
      cStart: new THREE.Vector3(), cEnd: new THREE.Vector3(), head: new THREE.Vector3(), splatT: 0, impactAge: 0,
      light: null, attract: null, boulder: null, center: new THREE.Vector3(), rot: new THREE.Quaternion(), axis: new THREE.Vector3(),
      heat: 0, magmaCount: 0, size: 1, fl: null, flAge: 0,
    }));

    // --- boulders: the finished rock (one instance, ~20k triangles) and the fragments that fly in
    // to build it (one instanced draw); one material per boulder, so one program for both ---
    // fragments are modelled at 0.3 scale so the shader's object-space noise is the same size on both
    const rockGeo = boulderGeometry(31, 7, 26, 0.012), fragGeo = boulderGeometry(6, 13, 9, 0.02).scale(FRAG, FRAG, FRAG);
    const slotDirs = [];
    for (let j = 0; j < CHUNKS; j++) {   // fibonacci sphere
      const y = 1 - (j + 0.5) / CHUNKS * 2, r = Math.sqrt(1 - y * y), a = j * 2.39996;
      slotDirs.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    const boulders = [];
    for (let b = 0; b < BOULDERS; b++) {
      const own = { uRock: { value: new THREE.Color() }, uBoulder: { value: new THREE.Vector4() }, uBoulderVel: { value: new THREE.Vector3() } };
      const mat = boulderMaterial(own);
      const core = new THREE.InstancedMesh(rockGeo, mat, 1), frags = new THREE.InstancedMesh(fragGeo, mat, CHUNKS);
      for (const m of [core, frags]) {
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;
        m.visible = false;
        fx.scenes.opaque.add(m);
      }
      const rnd = lcg(b * 977 + 3);
      const chunks = Array.from({ length: CHUNKS }, (_, j) => ({
        slot: slotDirs[j].clone(),
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3)),
        scale: new THREE.Vector3(1, 0.7 + rnd() * 0.4, 0.8 + rnd() * 0.35).multiplyScalar((0.17 + rnd() * 0.09) / FRAG),
        from: new THREE.Vector3(), t0: 0, launched: false, arrived: false,
      }));
      boulders.push({ core, frags, own, chunks, busy: false });
    }

    // --- heat probe (local: groundAt only covers dummies and cast targets) ---
    const probeXZ = Array.from({ length: PROBES }, () => new THREE.Vector2());
    const probeOwner = new Array(PROBES).fill(null), probeSeed = new Int32Array(PROBES);
    const probeOut = new Float32Array(PROBES * 4);
    const probeRT = new THREE.WebGLRenderTarget(PROBES, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });
    const probeQuad = new FullscreenQuad(rawPass(PROBE_FRAG, { uGroundA: U.uGroundA, uGroundRect: U.uGroundRect, uProbe: { value: probeXZ } }));
    const pbo = gl.createBuffer();   // storage at the first readPixels (see GroundField's probes)
    let sync = null, probeN = 0, sized = false;
    { const prev = fx.renderer.getRenderTarget(); probeQuad.render(fx.renderer, probeRT); fx.renderer.setRenderTarget(prev); }   // compile now, not mid-cast

    const magmaCol = blackbodyRGB(1300, new THREE.Color());

    // the impact cloud: the shared combustion fluid, its soot channel carrying the dust
    const fluid = FluidVolume.get(fx);
    // shares the fluid's render program, so warming this spell alone (phones: on selection)
    // compiles it; the domains themselves belong to whichever spell created the fluid first
    const fluidStub = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), fluid.domains[0].material);
    fluidStub.visible = false; fluidStub.frustumCulled = false;
    fx.scenes.fx.add(fluidStub);
    const SRC = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), radius: 1, fuel: 0, temp: 0, soot: 0, radial: 0, noise: 0, noiseScale: 1, seed: 0, coupling: 0, burst: false };
    function src(f, x, y, z, radius, fuel, temp, soot, burst, noise, noiseScale, seed, vx, vy, vz, radial, coupling) {
      SRC.pos.set(x, y, z); SRC.radius = radius; SRC.fuel = fuel; SRC.temp = temp; SRC.soot = soot; SRC.burst = burst;
      SRC.noise = noise; SRC.noiseScale = noiseScale; SRC.seed = seed; SRC.vel.set(vx, vy, vz); SRC.radial = radial; SRC.coupling = coupling;
      f.emit(SRC);
    }
    const lightCol = new THREE.Color();
    let dustColor = '', rockColor = '';

    function splat(x, z, radius, pattern, crack, heat, char, seed, x2 = x, z2 = z, width = 0) {
      SPL.x = x; SPL.z = z; SPL.radius = radius; SPL.pattern = pattern; SPL.crack = crack; SPL.heat = heat; SPL.char = char;
      SPL.seed = seed; SPL.x2 = x2; SPL.z2 = z2; SPL.width = width;
      fx.ground.splat(SPL);
    }
    function shock(pos, r1, duration, distortion) {
      SHK.pos.copy(pos).setY(0.04); SHK.radius1 = r1; SHK.duration = duration; SHK.distortion = distortion; SHK.thickness = 0.35 + r1 * 0.08;
      fx.shocks?.spawn(SHK);
    }
    function hitDummies(pos, reach, strength, push) {
      for (const dm of fx.dummies) {
        const dist = Math.hypot(dm.pos.x - pos.x, dm.pos.z - pos.z);
        if (dist < reach) dm.hit(_c.subVectors(dm.pos, pos).setY(0).normalize().addScaledVector(push, 0.6), strength * (1 - dist / reach));
      }
    }
    // colour params feed the kind table only when they change (setKind allocates a little)
    function syncColors(p) {
      if (p.dustColor !== dustColor) {
        dustColor = p.dustColor;
        const a = new THREE.Color(dustColor), b = a.clone().multiplyScalar(0.82);
        for (const k of ['dust', 'plume', 'seep', 'trail', 'updust', 'upplume']) P.setKind(`earth.${k}`, { color: [a, b] });
      }
      if (p.rockColor !== rockColor) {
        rockColor = p.rockColor;
        const a = new THREE.Color(rockColor);
        for (const k of ['rock', 'chunk', 'gather']) P.setKind(`earth.${k}`, { color: [a, '#000000'] });
        P.setKind('earth.pebble', { color: [a.clone().multiplyScalar(1.25), '#000000'] });
      }
    }

    function spawnSpike(c, d, s, delay, life, heat) {
      SPK.pos.copy(s.pos); SPK.dir.copy(s.dir); SPK.height = s.height; SPK.radius = s.radius;
      SPK.delay = delay; SPK.life = life; SPK.heat = heat; SPK.seed = s.seed;
      s.h = fx.spikes.spawn(SPK);
      s.delay = delay; s.life = life; s.erupted = s.crumbled = s.magma = false; s.ground = 0; s.heat = heat;
    }
    const owns = (s) => s.h && s.h.active && s.h.seed === s.seed;

    // --- Upheaval ---------------------------------------------------------------------------
    function layoutLine(c, p, d) {
      const n = Math.round(p.spikes);
      d.n = n;
      d.fwd.set(c.to.x - c.from.x, 0, c.to.z - c.from.z);
      const dist = d.fwd.length();
      d.fwd.multiplyScalar(1 / Math.max(dist, 1e-3));
      if (dist < 1e-3) d.fwd.set(0, 0, -1);
      d.perp.set(-d.fwd.z, 0, d.fwd.x);
      const endD = Math.max(dist - (c.target >= 0 ? 1.0 : 0), 1.2);
      const startD = Math.min(Math.max(dist - 10, 1.8), endD - 0.6);
      d.start.set(c.from.x, 0, c.from.z).addScaledVector(d.fwd, startD);
      d.end.set(c.from.x, 0, c.from.z).addScaledVector(d.fwd, endD);
      d.cStart.copy(d.start).addScaledVector(d.fwd, -0.7);
      d.cEnd.copy(d.end).addScaledVector(d.fwd, 0.5);
      for (let k = 0; k < n; k++) {
        const s = d.spikes[k], u = n > 1 ? k / (n - 1) : 1, side = k % 2 ? 1 : -1;
        s.u = u; s.rim = false;
        s.pos.lerpVectors(d.start, d.end, u).addScaledVector(d.perp, side * (0.15 + 0.22 * fx.rand()) * p.size * (k === n - 1 ? 0.3 : 1));
        s.height = p.height * p.size * (0.42 + 0.58 * Math.pow(u, 0.8)) * (0.85 + 0.3 * fx.rand());
        s.radius = p.size * (0.3 + 0.25 * u) * (0.9 + 0.2 * fx.rand());
        // lean forward (the wave's direction) and away from the line
        s.dir.copy(UP).addScaledVector(d.fwd, k === n - 1 ? 0.16 : 0.2 + 0.18 * fx.rand()).addScaledVector(d.perp, side * (0.1 + 0.12 * fx.rand())).normalize();
        s.seed = ((c.seed * 31 + k * 7919) >>> 0) & 0xffffff || 1;
        s.h = null;
      }
    }

    function erupt(c, p, d, s, last) {
      const b = s.pos, k = 0.6 + 0.8 * s.u, R = s.radius;
      splat(b.x, b.z, R * 2.6, 'radial', 1.7 * p.crack, 0.6 * p.heat, 0.15, s.seed % 89);
      // rock flung up and out from around the base (outside the spike's capsule: inside it they'd
      // ride up the invisible part of the capsule and rest in mid-air), chunks shoved aside
      rockRing.pos.copy(b).setY(0.2); rockRing.radius = R * 1.05; rockRing.radial = 2.6 * Math.sqrt(p.size);
      rockRing.vel.copy(d.fwd).multiplyScalar(0.8).setY((4.5 + 2 * s.u) * Math.sqrt(p.size)); rockRing.size = p.size; rockRing.burst(74 * p.debris * k);
      chunkRing.pos.copy(b).setY(0.2); chunkRing.radius = R * 0.9; chunkRing.vel.set(0, 2.6, 0); chunkRing.size = p.size; chunkRing.burst(8 * p.debris * k);
      if (s.h && s.h.heat > 0.3) { magmaBurst.pos.copy(b).setY(0.3); magmaBurst.radius = R * 0.6; magmaBurst.vel.set(0, 3, 0); magmaBurst.burst(20 * p.debris * k); }
      // dust: a ring that rolls outward along the floor, a plume thrown up with the spike
      upRing.pos.copy(b).setY(0.25); upRing.radius = R * 1.1; upRing.vel.set(0, 0.3, 0); upRing.radial = 6.5 * Math.sqrt(p.size); upRing.size = p.size;
      upRing.burst(70 * p.dust * k);
      upPlume.pos.copy(b).setY(0.6); upPlume.vel.copy(s.dir).multiplyScalar(4.2 * Math.sqrt(p.size)); upPlume.radius = R; upPlume.size = p.size; upPlume.burst(30 * p.dust * k);
      fx.rig.shake(0.09 * p.shake * (0.5 + s.u), 7);
      if (last) {
        shock(b, 7 * p.size, 0.55, 0.06);
        fx.rig.shake(0.35 * p.shake, 6);
        if (!fx.reduced) { fx.rig.punch(2.5, 0.12); fx.rig.hitstop(0.04); }
        if (d.light) { d.light.intensity = 30 * p.glow; d.light.pos.copy(b).setY(0.6); }
      } else if (s.u > 0.3 && Math.round(s.u * 6) % 2 === 0) shock(b, 2.6 * p.size, 0.4, 0.03);
      hitDummies(b, R + 1.1, last ? 1.6 : 1.0, d.fwd);
      s.erupted = true;
    }

    function crumble(p, s) {
      const b = s.pos, top = s.h.top(_a), hot = s.h.heat > 0.3, R = s.radius;
      const line = hot ? magmaLine : rockLine;
      line.pos.copy(b).setY(0.3); line.p.copy(top); line.radius = R * 0.45; line.vel.set(0, 0.3, 0); line.size = p.size;
      line.burst(34 * p.debris * (0.5 + s.u));
      if (hot) { rockLine.pos.copy(b).setY(0.3); rockLine.p.copy(top); rockLine.radius = R * 0.45; rockLine.vel.set(0, 0.3, 0); rockLine.burst(14 * p.debris); }
      chunkLine.pos.copy(b).setY(0.3); chunkLine.p.copy(top); chunkLine.radius = R * 0.4; chunkLine.vel.set(0, 0.2, 0); chunkLine.size = p.size;
      chunkLine.burst(7 * p.debris * (0.5 + s.u));
      upPuff.pos.copy(b).setY(0.4); upPuff.radius = R; upPuff.vel.set(0, 0.2, 0); upPuff.radial = 2; upPuff.size = p.size * 0.8; upPuff.burst(14 * p.dust);
      s.crumbled = true;
    }

    // heat under each spike -> spike.heat (rock holds heat longer than the floor) + magma decals
    function heatSpikes(p, d, dt, heat0) {
      const total = d.n + (d.rimN ?? 0);
      for (let i = 0; i < total; i++) {
        const s = d.spikes[i];
        if (!owns(s)) continue;
        s.heat = Math.max(s.heat * Math.exp(-dt / 6), Math.min(1, s.ground * 1.3), heat0);
        s.h.heat = s.heat;
        if (!s.magma && s.heat > 0.3 && d.magmaCount < 3) {
          fx.impacts.add('magma', _a.copy(s.pos).setY(0.3), s.radius * 2.6, Math.min(1, s.heat), 6, magmaCol);
          s.magma = true; d.magmaCount++;
        }
      }
    }

    // --- Meteor ------------------------------------------------------------------------------
    function setupBoulder(c, p, d) {
      let B = null;
      for (const x of boulders) if (!x.busy) { B = x; break; }
      d.boulder = B;
      d.size = p.meteorSize;
      d.center.copy(c.from).setY(c.from.y + 0.75 * p.meteorSize);
      d.rot.identity();
      if (!B) return;
      B.busy = true;
      B.core.visible = B.frags.visible = true;
      _col.set(p.rockColor); B.own.uRock.value.copy(_col);
      B.own.uBoulder.value.set(0, 0, 0, 0);
      B.own.uBoulderVel.value.set(0, 0, 0);
      const T = c.durations.charge;
      for (let j = 0; j < CHUNKS; j++) {
        const ch = B.chunks[j], a = j * 2.39996 + c.seed * 0.001, r = 2.1 + fx.rand() * 1.1;
        ch.from.set(d.center.x + Math.cos(a) * r, 0.05, d.center.z + Math.sin(a) * r);
        ch.t0 = 0.04 * T + (j / (CHUNKS - 1)) * 0.6 * T + fx.rand() * 0.04;
        ch.launched = ch.arrived = false;
      }
    }

    // charge: the core swells while fragments are torn out of the floor, fly in and are pressed
    // into it; in flight only the finished rock is drawn
    function poseBoulder(c, p, d, charging) {
      const B = d.boulder;
      if (!B) return;
      const S = d.size, T = c.durations.charge, center = c.phase === 'charge' ? d.center : c.pos;
      const grow = charging ? 0.35 + 0.65 * smooth(c.t / (0.88 * T)) : 1, R = CORE_R * S * grow;
      _m.compose(center, d.rot, _s.setScalar(R));
      B.core.setMatrixAt(0, _m);
      B.core.instanceMatrix.needsUpdate = true;
      B.frags.visible = charging;
      if (!charging) return;
      const fl = 0.32;
      for (let j = 0; j < CHUNKS; j++) {
        const ch = B.chunks[j], u = (c.t - ch.t0) / fl;
        _a.copy(ch.slot).multiplyScalar(R * 0.95).applyQuaternion(d.rot).add(center);   // where it lands on the core
        _q.copy(d.rot).multiply(ch.q);
        _s.copy(ch.scale).multiplyScalar(S);
        if (u < 0) _s.setScalar(0);
        else if (u < 1) {
          if (!ch.launched) {   // torn out of the floor
            ch.launched = true;
            tear.pos.copy(ch.from); tear.vel.set(0, 2.5, 0); tear.size = S; tear.burst(10 * p.debris);
            puff.pos.copy(ch.from).setY(0.3); puff.radius = 0.3; puff.vel.set(0, 0.6, 0); puff.radial = 1.2; puff.size = 0.6; puff.burst(5 * p.dust);
            splat(ch.from.x, ch.from.z, 0.5 * S, 'radial', 1.3 * p.crack, 0, 0.1, j * 7);
          }
          const e = u * u;   // pulled in: accelerates into its slot
          _b.copy(ch.from).lerp(_a, e);
          _b.y += 1.1 * 4 * e * (1 - e);
          _a.copy(_b);
          _q2.setFromAxisAngle(UP, (1 - e) * 5); _q.multiply(_q2);
        } else {
          if (!ch.arrived) {
            ch.arrived = true;
            fx.rig.shake(0.035 * p.shake, 10);
            tear.pos.copy(_a); tear.vel.set(0, 0.5, 0); tear.size = 0.6 * S; tear.burst(4 * p.debris);
          }
          const v = Math.min(1, (u - 1) * fl / 0.2);   // pressed in: sinks into the core and merges
          _a.lerp(center, 0.45 * v);
          _s.multiplyScalar(1 - v * v);
        }
        _m.compose(_a, _q, _s);
        B.frags.setMatrixAt(j, _m);
      }
      B.frags.instanceMatrix.needsUpdate = true;
    }

    function freeBoulder(d) {
      if (!d.boulder) return;
      d.boulder.core.visible = d.boulder.frags.visible = false;
      d.boulder.busy = false;
      d.boulder = null;
    }

    // --- the impact cloud ----------------------------------------------------------------------
    // Reference: impact tests and bolide strikes (hypervelocity shots into sand, quarry blasts): a
    // short white-hot vapour flash at contact, an inverted cone of ejecta and dust thrown out at
    // ~50 degrees with a base surge racing out low, then a dirty brown column boiling up, lit orange
    // from the crater underneath and by the sun on top. Never a glowing dome: rock dust is dark.
    function impactCloud(c, p, d, g, S, hot) {
      const f = d.fl = fluid.acquire({ size: [11 * S, 7 * S, 11 * S] });
      if (!f) return false;
      d.flAge = 0;
      f.position.set(g.x, 0.5 * f.size.y - f.h, g.z);
      Object.assign(f, {
        ignition: 0.25, burnRate: 6, heatPerFuel: 0.4, sootYield: 1.2, expansion: 1.3, cooling: 2.4, radiative: 1.6,
        sootDecay: 0.05, fuelDecay: 0.5, buoyancy: 4.5, sootWeight: 0.8, vorticity: 9, damping: 0.4, forceCoupling: 0.5,
        turbulence: 12, turbulenceFreq: 0.5 / S, sootCool: 2, sootErode: 0,
        emission: 5.5, temperature: 1750, sootDensity: 2.8, flameDensity: 2.5, fuelDensity: 0, absorb: 0,
        g: 0.4, sun: 1.25, sky: 1.2, fireLight: 0.9, upres: 1.4, upresScale: 4, edgeFade: 5,
        detailFreq: 0.5 / S, detailErode: 0.3, detailHeat: 0.35, nearFade: 0.4,
      });
      // dust albedo from the dust colour (a little lighter than the settled dust: fine grains scatter)
      f.sootColor.set(p.dustColor).multiplyScalar(1.5);
      f.tint.setRGB(1, 1, 1);
      f.detailCenter.copy(g);
      const sd = (c.seed % 89) * 0.31;
      // the vapour flash: a white-hot core thrown outwards, heat by the meteor's heat
      src(f, g.x, 0.35 * S, g.z, 0.9 * S, 0.25 + 0.6 * hot, 0.3 + 0.7 * hot, 1.6, true, 0.85, 2.4 / S, sd, 0, 2, 0, 6 * S, 400);
      // the ejecta curtain: six lobes thrown up and out
      for (let i = 0; i < 6; i++) {
        const a = sd + i * 1.0472 + 0.3 * Math.sin(i * 2.7 + sd), ca = Math.cos(a), sa = Math.sin(a), up = 7 + 2 * Math.sin(i * 1.9 + sd);
        src(f, g.x + ca * 0.75 * S, 0.5 * S, g.z + sa * 0.75 * S, 0.7 * S, 0.3 * hot, 0.25 + 0.3 * hot, 2.4, true, 0.9, 2.8 / S, sd + i * 1.7,
          ca * 6.5 * S, up * Math.sqrt(S), sa * 6.5 * S, 1.5 * S, 300);
      }
      return true;
    }
    function updateImpactCloud(c, p, d, dt) {
      const f = d.fl;
      if (!f) return;
      const a = (d.flAge += dt), S = d.size, hot = d.heat, g = c.pos, sd = (c.seed % 89) * 0.31;
      if (a <= 1.5 * dt) {
        // the base surge: lobes racing out along the floor
        for (let i = 0; i < 6; i++) {
          const ang = sd + 0.52 + i * 1.0472, ca = Math.cos(ang), sa = Math.sin(ang);
          src(f, g.x + ca * 1.3 * S, 0.3, g.z + sa * 1.3 * S, 0.55 * S, 0, 0.1 + 0.15 * hot, 1.3, true, 0.9, 3 / S, sd + 9 + i, ca * 10 * S, 0.6, sa * 10 * S, 0, 300);
        }
      } else if (a < 0.45) {
        // the crater keeps blowing dust up for a moment, hot underneath
        const k = 1 - a / 0.45;
        src(f, g.x, 0.3, g.z, 0.75 * S, 0.8 * hot * k, 0.6 * hot * k, 5 * k, false, 0.8, 2 / S, sd + 4 + a, 0, 5 * Math.sqrt(S), 0, 2 * S, 8);
      }
      // the column climbs and spreads; the dust thins from its edges late
      f.detailCenter.set(g.x, 0.9 * S * Math.min(a, 3), g.z);
      f.detailFreq = 0.5 / (S * (0.8 + 0.5 * (1 - Math.exp(-a / 0.6))));
      f.sootErode = 1.4 * THREE.MathUtils.smoothstep(a, 1.6, 3.6);
      f.emission = (3.5 + 4 * Math.exp(-a / 0.08)) * Math.max(hot, 0.2);
      if (a > 3.85) { f.release(); d.fl = null; }
    }

    function land(c, p, d) {
      const S = d.size, g = _b.set(c.pos.x, 0, c.pos.z), hot = d.heat;
      freeBoulder(d);
      splat(g.x, g.z, 2.1 * S, 'radial', 2.4 * p.crack, 1.0 * hot, 0.45, c.seed % 97);
      splat(g.x, g.z, 2.5 * S, 'ring', 2.0 * p.crack, 0.4 * hot, 0.2, (c.seed + 31) % 97, g.x, g.z, 0.45 * S);
      rockCone.pos.copy(g).setY(0.2); rockCone.p.set(0, 1, 0); rockCone.cone = 1.1; rockCone.radius = 0.6 * S; rockCone.radial = 7.5 * Math.sqrt(S); rockCone.size = S;
      rockCone.burst(450 * p.debris);
      rockCone.cone = 0.8;
      chunkRing.pos.copy(g).setY(0.25); chunkRing.radius = 0.9 * S; chunkRing.vel.set(0, 3.5, 0); chunkRing.radial = 4; chunkRing.size = S; chunkRing.burst(30 * p.debris);
      chunkRing.radial = 2.5;
      bigChunk.pos.copy(c.pos); bigChunk.vel.copy(c.vel).multiplyScalar(0.12).setY(3); bigChunk.size = 1.4 * S; bigChunk.burst(8);
      if (hot > 0.25) { magmaBurst.pos.copy(g).setY(0.4); magmaBurst.radius = 0.6 * S; magmaBurst.vel.set(0, 4, 0); magmaBurst.size = S; magmaBurst.burst(35 * hot * p.debris); }
      // the cloud (simulated when a fluid slot is free); else the molten core bursts into
      // incandescent dust that chokes to smoke
      const cloud = impactCloud(c, p, d, g, S, hot);
      if (hot > 0.05) {
        if (!cloud) { blast.pos.copy(g).setY(0.5 * S); blast.radius = 0.6 * S; blast.vel.copy(c.vel).multiplyScalar(0.08).setY(2.2); blast.radial = 3 * Math.sqrt(S); blast.size = S; blast.burst(28 * Math.min(1, hot * 1.6) * p.dust); }
        spatter.pos.copy(g).setY(0.3); spatter.radius = 0.5 * S; spatter.vel.set(0, 3.5, 0); spatter.radial = 6; spatter.burst(260 * hot);
        spatter.radial = 2.5;
      }
      dustRing.pos.copy(g).setY(0.3); dustRing.radius = 1.0 * S; dustRing.vel.set(0, 0.4, 0); dustRing.radial = 8.5 * Math.sqrt(S); dustRing.size = 1.2 * S;
      dustRing.burst((cloud ? 110 : 950) * p.dust);
      plume.pos.copy(g).setY(0.7); plume.radius = 0.9 * S; plume.vel.set(0, 3.5 * Math.sqrt(S), 0); plume.size = 1.2 * S; plume.burst((cloud ? 40 : 320) * p.dust);
      shock(g, 9 * S, 0.6, 0.075);
      SHK.ground = false; SHK.pos.copy(g).setY(0.6); SHK.radius1 = 4 * S; SHK.thickness = 0.6; SHK.duration = 0.35; SHK.distortion = 0.04;
      fx.shocks?.spawn(SHK);
      SHK.ground = true;
      // crater rim: slabs upturned around the hole, leaning out
      const rn = Math.min(MAX_RIM, Math.round(p.rim));
      d.rimN = rn; d.n = 0;
      for (let k = 0; k < rn; k++) {
        const s = d.spikes[k], a = (k / rn) * Math.PI * 2 + fx.rand() * 0.5, out = _a.set(Math.cos(a), 0, Math.sin(a));
        s.rim = true; s.u = 0.5;
        s.pos.copy(g).addScaledVector(out, 1.45 * S * (0.9 + 0.2 * fx.rand()));
        s.dir.copy(out).multiplyScalar(1.0 + 0.4 * fx.rand()).add(UP).normalize();
        s.height = (0.55 + 0.45 * fx.rand()) * S; s.radius = (0.32 + 0.12 * fx.rand()) * S;
        s.seed = ((c.seed * 131 + k * 4099) >>> 0) & 0xffffff || 1;
        spawnSpike(c, d, s, fx.rand() * 0.05, 2.4 + fx.rand() * 0.4, 0.45 * hot);
        s.erupted = true;
      }
      fx.rig.shake(1.0 * p.shake, 7);
      fx.rig.shake(0.4 * p.shake, 18);
      if (!fx.reduced) { fx.rig.punch(3.5, 0.14); fx.rig.hitstop(0.06); }
      if (hot > 0.25) {
        fx.impacts.add('magma', g, 2.4 * S, hot, 6, magmaCol);
        fx.flash(0.15 * hot);
      }
      if (d.light) { d.light.intensity = (cloud ? 22 : 30) * hot; d.light.range = 12 * S; d.light.pos.copy(g).setY(cloud ? 0.4 : 0.8); }
      hitDummies(g, 4 * S, 1.6, _push.copy(c.vel).setY(0).normalize());
      for (const dm of fx.dummies) if (hot > 0.25 && Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z) < 2.5 * S) dm.status.burn = Math.max(dm.status.burn, 0.5 * hot);
      const pool = fx.ARENA.pool;
      if (Math.abs(g.x - pool.center.x) < pool.half.x + 3 && Math.abs(g.z - pool.center.y) < pool.half.y + 3) {
        fx.pool?.ripple?.(Math.min(Math.max(g.x, pool.center.x - pool.half.x), pool.center.x + pool.half.x), Math.min(Math.max(g.z, pool.center.y - pool.half.y), pool.center.y + pool.half.y), 0.06, 0.8);
      }
    }

    return {
      // projectile shape for both forms: Upheaval ends travel at once, Meteor flies its own arc
      travel(c, dt) {
        if (c.form !== 'Meteor') { c.pos.copy(c.to); return true; }
        c.vel.y -= GRAVITY * dt;
        c.pos.addScaledVector(c.vel, dt);
        c.travelled += c.vel.length() * dt;
        const d = c.data.e;
        return (c.travelled > 1 && arenaSDF(c.pos) < 0.5 * d.size) || c.t > 5;
      },

      phase(c, name) {
        const p = S.params;
        if (name === 'charge') {
          syncColors(p);
          const d = c.data.e = states[c.index];
          d.alive = true; d.n = 0; d.rimN = 0; d.magmaCount = 0; d.splatT = 0; d.heat = 0; d.boulder = null; d.fl = null;
          for (const s of d.spikes) { s.h = null; s.erupted = s.crumbled = s.magma = false; s.ground = s.heat = 0; }
          d.light = (c.form === 'Meteor' ? p.meteorHeat : p.glow) > 0 ? fx.lights.acquire() : null;
          if (d.light) { d.light.intensity = 0; d.light.range = 5; d.light.shadow = false; blackbodyRGB(1500, d.light.color); }
          if (c.form === 'Meteor') {
            c.durations.charge = 1.0; c.durations.impact = 0.3; c.durations.linger = 3.6;
            setupBoulder(c, p, d);
            d.attract = fx.forces.acquire();
            if (d.attract) { d.attract.type = 2; d.attract.p[0] = 45; d.attract.p[1] = 0.45; d.attract.p[2] = 0.5 * p.meteorSize; d.attract.p[3] = 3.2; d.attract.pos.copy(d.center); }
            splat(d.center.x, d.center.z, 2.6, 'ring', 1.4 * p.crack, 0, 0.1, c.seed % 53, d.center.x, d.center.z, 0.5);
          } else {
            c.durations.charge = S.timing.charge; c.durations.impact = S.timing.impact;
            layoutLine(c, p, d);
            d.head.copy(d.cStart);
          }
        } else if (name === 'travel') {
          const d = c.data.e;
          if (c.form === 'Meteor') {
            d.attract?.release(); d.attract = null;
            c.pos.copy(d.center);
            // ballistic: apex `arc` m above the launch, landing on the target
            const vy = Math.sqrt(2 * GRAVITY * p.arc), dy = c.to.y - c.pos.y;
            const T = (vy + Math.sqrt(Math.max(vy * vy - 2 * GRAVITY * dy, 0))) / GRAVITY;
            c.vel.set((c.to.x - c.pos.x) / T, vy, (c.to.z - c.pos.z) / T);
            d.axis.set(c.vel.z, 0, -c.vel.x).normalize();   // roll forward
            fx.rig.shake(0.18 * p.shake, 10);
            puff.pos.copy(c.pos); puff.radius = 0.5 * d.size; puff.vel.set(0, -0.5, 0); puff.radial = 2.5; puff.size = d.size; puff.burst(30 * p.dust);
          }
        } else if (name === 'impact') {
          const d = c.data.e;
          d.impactAge = c.age;
          if (c.form === 'Meteor') land(c, p, d);
          else {
            // the whole line cracks open; spikes rise in sequence
            splat(d.cStart.x, d.cStart.z, 0.3, 'line', 1.9 * p.crack, 0.8 * p.heat, 0.1, c.seed % 97, d.cEnd.x, d.cEnd.z, 0.6 * p.size);
            let tail = 0;
            for (let k = 0; k < d.n; k++) {
              const s = d.spikes[k];
              spawnSpike(c, d, s, k * p.stagger, p.hold + 0.25 * s.u, p.heat);
              tail = Math.max(tail, s.delay + s.life + 0.9);
            }
            c.durations.linger = Math.max(tail - c.durations.impact + 0.3, 1);
            fx.rig.shake(0.3 * p.shake, 9);
            if (d.light) d.light.pos.copy(d.start).setY(0.5);
          }
        } else if (name === 'done') {
          const d = c.data.e;
          if (!d) return;
          for (const s of d.spikes) { if (owns(s)) s.h.release(); s.h = null; }
          d.light?.release(); d.light = null;
          d.attract?.release(); d.attract = null;
          d.fl?.release(); d.fl = null;
          freeBoulder(d);
          d.alive = false;
        }
      },

      update(c, dt) {
        const p = S.params, d = c.data.e, L = d.light;
        if (c.form === 'Meteor') {
          if (c.phase === 'charge') {
            const k = c.t / c.durations.charge;
            d.rot.multiply(_q.setFromAxisAngle(UP, dt * (0.6 + 2.5 * k)));   // turning as it forms
            poseBoulder(c, p, d, true);
            d.heat = p.meteorHeat * 0.25 * smooth((k - 0.55) / 0.45);   // compressing: the seams start to glow
            if (d.boulder) d.boulder.own.uBoulder.value.x = d.heat;
            gather.pos.copy(d.center).setY(0.12); gather.radius = 2.5; gather.vel.set(0, 4.6 + 0.6 * p.meteorSize, 0); gather.size = p.meteorSize;
            if (k < 0.85) gather.rate(420 * p.debris, dt);
            gatherDust.pos.copy(d.center).setY(0.15); gatherDust.radius = 2.5; gatherDust.vel.set(0, 0.7, 0); gatherDust.rate(110 * p.dust * (1 - k), dt);
            if (d.attract) d.attract.p[2] = 0.45 * p.meteorSize * (0.5 + 0.5 * k);
            fx.rig.shake(dt * 1.9 * p.shake, 8);
            if (L) { L.pos.copy(d.center); L.pos.y -= 0.9 * d.size; L.intensity = 6 * d.heat * (0.85 + 0.15 * Math.sin(c.age * 23)); }   // below, not inside: unshadowed
          } else if (c.phase === 'travel') {
            d.rot.premultiply(_q.setFromAxisAngle(d.axis, dt * 5 / d.size));
            poseBoulder(c, p, d, false);
            d.heat = p.meteorHeat * Math.min(1, 0.5 + c.t * 0.9);   // heats up in flight
            _c.copy(c.vel).normalize();
            if (d.boulder) { d.boulder.own.uBoulder.value.x = d.heat; d.boulder.own.uBoulderVel.value.copy(_c); }
            // the wake: smoke boiling off the hot crust, a heat shimmer, grit and pebbles shed, embers
            // and molten spatter flung off the seams
            const R = CORE_R * d.size, h = Math.max(d.heat, 0.15);
            _a.copy(c.pos).addScaledVector(_c, -0.45 * R);
            smoke.pos.copy(_a); smoke.vel.copy(c.vel).multiplyScalar(0.1); smoke.radius = 0.55 * R; smoke.size = d.size; smoke.rate(200 * p.dust * h, dt);
            haze.pos.copy(_a); haze.vel.copy(c.vel).multiplyScalar(0.04); haze.radius = 0.6 * R; haze.size = d.size; haze.rate(70 * h, dt);
            trailDust.pos.copy(_a); trailDust.vel.copy(c.vel).multiplyScalar(0.1); trailDust.radius = 0.5 * R; trailDust.size = d.size; trailDust.rate(45 * p.dust, dt);
            trailPebble.pos.copy(c.pos); trailPebble.vel.copy(c.vel).multiplyScalar(0.35); trailPebble.radius = 0.7 * R; trailPebble.rate(35 * p.debris, dt);
            if (d.heat > 0.05) {
              ember.pos.copy(c.pos); ember.vel.copy(c.vel).multiplyScalar(0.15); ember.radius = 0.8 * R; ember.rate(260 * d.heat, dt);
              spatter.pos.copy(c.pos); spatter.vel.copy(c.vel).multiplyScalar(0.55); spatter.radius = 0.85 * R; spatter.rate(70 * d.heat, dt);
            }
            if (L) { L.pos.copy(c.vel).setLength(-1.1 * d.size).add(c.pos); L.range = 7; L.intensity = 8 * d.heat * (0.85 + 0.15 * Math.sin(c.age * 29)); }   // trailing, lights the plume
          } else {
            updateImpactCloud(c, p, d, dt);
            if (L) L.intensity = Math.max(L.intensity * Math.exp(-dt / 0.35), 3 * d.heat * Math.max(0, 1 - c.t / 2.5) * (c.phase === 'linger' ? 1 : 0));
            heatSpikes(p, d, dt, 0);
          }
          return;
        }
        // Upheaval
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge, u = smooth(k / 0.85);
          d.head.lerpVectors(d.cStart, d.cEnd, u);
          d.splatT -= dt;
          if (d.splatT <= 0) {   // re-stamped as the head advances; potential channels take the max, so it doesn't stack
            d.splatT = 0.035;
            splat(d.cStart.x, d.cStart.z, 0.3, 'line', 1.6 * p.crack, 0, 0, c.seed % 97, d.head.x, d.head.z, 0.45 * p.size);
          }
          pebbleLine.pos.copy(d.cStart); pebbleLine.p.copy(d.head); pebbleLine.vel.set(0, 2.2, 0); pebbleLine.size = p.size; pebbleLine.rate(650 * p.debris, dt);
          seepLine.pos.copy(d.cStart); seepLine.p.copy(d.head); seepLine.vel.set(0, 0.6, 0); seepLine.size = p.size; seepLine.rate(360 * p.dust, dt);
          fx.rig.shake(dt * 2.2 * p.shake, 8);
          if (L) { L.pos.copy(d.head).setY(0.35); L.range = 4; L.intensity = 8 * p.glow * k; }
          return;
        }
        if (c.phase === 'travel') return;
        const te = c.age - d.impactAge;
        for (let i = 0; i < d.n; i++) {
          const s = d.spikes[i];
          if (!s.erupted && te >= s.delay) erupt(c, p, d, s, i === d.n - 1);
          if (s.erupted && !s.crumbled && owns(s) && te >= s.delay + s.life) crumble(p, s);
        }
        heatSpikes(p, d, dt, p.heat);
        if (L) {
          if (te < 0.25 && d.n) L.pos.lerpVectors(d.start, d.end, Math.min(1, te / Math.max(d.n * p.stagger, 0.01))).setY(0.5);
          L.intensity *= Math.exp(-dt / 0.3);
        }
      },

      // every frame: read back last request, then probe the ground heat under every live spike
      tick() {
        if (sync && gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) {
          gl.deleteSync(sync); sync = null;
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, probeOut, 0, probeN * 4);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          for (let i = 0; i < probeN; i++) { const s = probeOwner[i]; if (s && s.seed === probeSeed[i]) s.ground = probeOut[i * 4]; probeOwner[i] = null; }
        }
        if (sync) return;
        probeN = 0;
        for (const d of states) {
          if (!d.alive) continue;
          const total = d.n + d.rimN;
          for (let i = 0; i < total && probeN < PROBES; i++) {
            const s = d.spikes[i];
            if (!owns(s)) continue;
            probeXZ[probeN].set(s.pos.x, s.pos.z);
            probeOwner[probeN] = s; probeSeed[probeN] = s.seed;
            probeN++;
          }
        }
        if (!probeN) return;
        const r = fx.renderer, prev = r.getRenderTarget();
        probeQuad.render(r, probeRT);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        if (!sized) { gl.bufferData(gl.PIXEL_PACK_BUFFER, PROBES * 16, gl.STREAM_READ); sized = true; }
        gl.readPixels(0, 0, probeN, 1, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        r.setRenderTarget(prev);
      },
    };
  },
};

function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
