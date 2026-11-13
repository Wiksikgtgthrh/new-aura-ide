import * as THREE from 'three';
import { U, COMMON_GLSL, NOISE_GLSL, ARENA_GLSL, LIGHTS_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING } from './common.js';
import { Q } from '../engine/quality.js';

// Raymarched hero volumes (PLAN 2.5 "Volumes"). Each volume is a proxy mesh in the fx scene whose
// BACK faces are drawn (so the camera can be inside) with the depth test off (a back face behind the
// floor must not hide the part of the volume in front of it); the shader intersects the true shape
// analytically and marches from entry to min(exit, scene depth).
//
// Spells supply the medium:
//   void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission)
//     pw world position, pl local position (-1..1 over the shape's half extents)
//     sigma    extinction (1/m)
//     albedo   single-scattering albedo
//     emission emitted radiance per metre (HDR); integrated as T * E * (1 - exp(-sigma dt)) / sigma
// with COMMON, NOISE (noise3/fbm3/blackbody), ARENA and LIGHTS GLSL available, plus the uniforms
// below (uVolScale etc.).
//
// Integration is per-slab energy conserving (Hillaire 2015). Lighting per occupied sample:
//   sun     HG phase (g), shadowed by ONE extra density tap towards the sun (optical depth =
//           trapezoid over the tap), plus a 0.25-strength wide lobe standing in for multiple
//           scattering (after Wrenninge's octaves)
//   ambient uAmbient, dimmed by the sun tap's optical depth
//   spells  spellLightScatter (no capsule shadows: gLightNoShadow), all attenuated by one tap
//           towards the brightest spell light (light 0; packWorld sorts brightest first), so smoke
//           over a fireball is lit from below and dark on top
// Lighting is evaluated on every 2nd occupied sample and held in between (it varies much more
// slowly than density); the two shadow taps alternate, so each refreshes every 4th sample. That
// keeps the march at ~1.5 density evaluations per step. Samples with zero albedo (pure fire, soot)
// skip lighting entirely.
// Step count = clamp(radiusPx / 5, 8, min(maxSteps, Q.volumeSteps * Q.auto.steps)), radiusPx in
// FX-target pixels, set per frame by update(). Samples are combined as trapezoid slabs (sigma,
// albedo and emission averaged over each slab's two ends), which removes the step banding; there is
// NO per-pixel jitter: at half res without TAA any jitter turns into a fixed dither pattern ("grid of
// dots") on high-frequency media. gVolDt (this ray's step) lets volumeSample fade noise octaves the
// march can't resolve.

// Every lookup in a march is LOD 0 (the noise, curl and blackbody textures have no mips anyway):
// implicit-gradient samples inside the data-dependent loop make ANGLE's HLSL compiler (FXC) unroll
// or restructure it, which costs seconds of compile and a slower shader. Volume GLSL may only call
// texture(sampler, coord) with two arguments.
const NO_GRADIENTS = '#define texture(s, p) textureLod(s, p, 0.0)\n';

const VOLUME_VERT = /* glsl */`
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const VOLUME_HEAD = /* glsl */`
uniform vec3 uVolCenter;
uniform mat3 uVolRot;       // world -> shape axes
uniform vec3 uVolScale;     // half extents (m)
uniform float uVolSteps;
uniform vec4 uVolLight;     // HG g, sun tap distance (m), ambient gain, sun gain
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec3 vWorld;
// this ray's step length (m), readable from volumeSample: fade noise octaves finer than ~2 steps
// (they can't be resolved and only turn into per-pixel grain)
float gVolDt = 0.1;
`;

// entry/exit distances along a unit ray in shape space (rotated, unscaled, so t is metres)
const SHAPES_GLSL = /* glsl */`
#if VOLUME_SHAPE == 0
vec2 volumeHit(vec3 o, vec3 d) {     // ellipsoid
  vec3 oc = o / uVolScale, rd = d / uVolScale;
  float a = dot(rd, rd), b = dot(oc, rd), c = dot(oc, oc) - 1.0;
  float h = b * b - a * c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h) / a;
}
#elif VOLUME_SHAPE == 1
vec2 volumeHit(vec3 o, vec3 d) {     // box
  vec3 dd = mix(d, vec3(1e-6), lessThan(abs(d), vec3(1e-6)));
  vec3 m = 1.0 / dd, n = m * o, k = abs(m) * uVolScale;
  vec3 t1 = -n - k, t2 = -n + k;
  return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}
#else
// capsule along y: radius uVolScale.x, half length uVolScale.y including the caps.
// Near hit after Inigo Quilez (MIT); the far hit is the near hit of the reversed ray.
float capsuleNear(vec3 ro, vec3 rd, float hy, float ra) {
  vec3 ba = vec3(0.0, 2.0 * hy, 0.0), oa = ro - vec3(0.0, -hy, 0.0);
  float baba = dot(ba, ba), bard = dot(ba, rd), baoa = dot(ba, oa), rdoa = dot(rd, oa), oaoa = dot(oa, oa);
  float a = baba - bard * bard, b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - ra * ra * baba;
  float h = b * b - a * c;
  if (h >= 0.0) {
    float t = (-b - sqrt(h)) / a;
    float y = baoa + t * bard;
    if (y > 0.0 && y < baba) return t;
    vec3 oc = y <= 0.0 ? oa : ro - vec3(0.0, hy, 0.0);
    b = dot(rd, oc); c = dot(oc, oc) - ra * ra; h = b * b - c;
    if (h > 0.0) return -b - sqrt(h);
  }
  return -1.0;
}
vec2 volumeHit(vec3 o, vec3 d) {
  float ra = uVolScale.x, hy = max(uVolScale.y - ra, 1e-4);
  float far = length(o) + 2.0 * (uVolScale.y + ra);
  float tb = capsuleNear(o + d * far, -d, hy, ra);
  if (tb < 0.0) return vec2(1.0, -1.0);
  vec3 q = o; q.y -= clamp(q.y, -hy, hy);
  return vec2(dot(q, q) < ra * ra ? 0.0 : capsuleNear(o, d, hy, ra), far - tb);
}
#endif
`;

const VOLUME_MAIN = /* glsl */`
void main() {
  gLightNoShadow = true;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 o = uVolRot * (cameraPosition - uVolCenter), d = uVolRot * rd;
  vec2 hit = volumeHit(o, d);
  float cosV = dot(rd, -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float t0 = max(hit.x, 0.0), t1 = min(hit.y, sceneViewZ() / cosV);
  if (t1 <= t0) discard;
  int steps = int(uVolSteps);
  float dt = (t1 - t0) / float(steps);
  gVolDt = dt;
  // samples sit at t0 + (i + j) dt; slabs run between them (trapezoid), plus a j dt slab in
  // front of the first sample and a (1 - j) dt one behind the last, so [t0, t1] is covered exactly
  const float j = 0.5;
  float t = t0 + dt * j, len = dt * j;
  float tap = uVolLight.y;
  vec3 tapS = uVolRot * uSunDir * tap;
  float sunPhase = hgPhase(dot(uSunDir, rd), uVolLight.x) * 4.0 * PI;
  vec3 sun = uSunColor * uVolLight.w * sunPhase, amb = uAmbient * uVolLight.z;
  vec3 scat = vec3(0.0), emit = vec3(0.0), Lin = vec3(0.0);
  float T = 1.0, zSum = 0.0, wSum = 0.0, odSun = 0.0, odL = 0.0, s2;
  vec3 a2, e2;
  float sP = 0.0; vec3 aP = vec3(0.0), eP = vec3(0.0);   // previous sample
  bool hasLight = uWorldCounts.x > 0.5;
  int lit = 0;
  for (int i = 0; i <= 64; i++) {
    if (i > steps || T < 0.01) break;
    float sigma = sP; vec3 albedo = aP, e = eP;
    if (i < steps) {
      vec3 ps = o + d * t, pw = cameraPosition + rd * t;
      volumeSample(pw, ps / uVolScale, sigma, albedo, e);
      if (sigma > 1e-4) {
        // lighting on every 2nd occupied sample, held in between; the shadow taps alternate between
        // the sun and the brightest spell light (packWorld sorts it first), both on the first sample
        int k = lit & 3;
        if ((k & 1) == 0 && max(albedo.r, max(albedo.g, albedo.b)) > 1e-3) {
          if (k == 0) {
            volumeSample(pw + uSunDir * tap, (ps + tapS) / uVolScale, s2, a2, e2);
            odSun = (sigma + s2) * tap;
          }
          if (hasLight && (k == 2 || lit == 0)) {
            SpellLight L0 = spellLight(0);
            vec3 lp = L0.type == 1 ? closestOnSegment(L0.pos, L0.end, pw) : L0.pos, ld = lp - pw;
            float ll = length(ld), dl = min(tap, ll * 0.5);   // never tap past the light itself
            ld *= dl / max(ll, 1e-4);
            volumeSample(pw + ld, (ps + uVolRot * ld) / uVolScale, s2, a2, e2);
            odL = (sigma + s2) * dl;
          }
          Lin = sun * (exp(-odSun) + 0.25 * exp(-0.25 * odSun)) + amb * mix(0.35, 1.0, exp(-0.5 * odSun))
              + spellLightScatter(pw, -rd, uVolLight.x) * (exp(-odL) + 0.25 * exp(-0.25 * odL));
        }
        lit++;
      }
    } else len = dt * (1.0 - j);
    // trapezoid slab: the mean of its two end samples, so a density edge between two samples
    // contributes in proportion to where it falls (rectangle slabs turn it into contour bands)
    float sg = i == 0 ? sigma : 0.5 * (sigma + sP);
    vec3 eg = i == 0 ? e : 0.5 * (e + eP), ag = i == 0 ? albedo : 0.5 * (albedo + aP);
    sP = sigma; aP = albedo; eP = e;
    if (sg > 1e-4) {
      float Tr = exp(-sg * len), a = T * (1.0 - Tr);
      scat += a * ag * Lin;
      emit += a * eg / sg;
      zSum += a * (t - 0.5 * len); wSum += a;
      T *= Tr;
    } else emit += T * eg * len;
    t += dt; len = dt;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.002 && dot(emit, emit) < 1e-6) discard;
  float z = (wSum > 0.0 ? zSum / wSum : t0) * cosV;
  fxOut(scat / max(alpha, 1e-4), alpha, emit, vec2(0.0), z);
}`;

const SHAPES = { sphere: 0, box: 1, capsule: 2 };

// icosphere scaled so its faces (not just its vertices) enclose the unit sphere
function sphereProxy() {
  const g = new THREE.IcosahedronGeometry(1, 2), p = g.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let inner = 1;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    inner = Math.min(inner, Math.abs(n.dot(a)));
  }
  return g.scale(1.01 / inner, 1.01 / inner, 1.01 / inner);
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();

export class Volumes {
  constructor() {
    this.group = new THREE.Group();     // add once to the fx scene
    this.list = [];
    this.proxies = { sphere: sphereProxy(), box: new THREE.BoxGeometry(2, 2, 2) };
    this.proxies.capsule = this.proxies.box;
  }

  // At load only (one program per call). Returns a plain handle; set its fields each frame.
  add({ shape = 'sphere', glsl, uniforms = {}, maxSteps = 32 }) {
    const own = {
      uVolCenter: { value: new THREE.Vector3() }, uVolRot: { value: new THREE.Matrix3() },
      uVolScale: { value: new THREE.Vector3(1, 1, 1) }, uVolSteps: { value: 8 },
      uVolLight: { value: new THREE.Vector4(0.3, 0.3, 1, 1) },
    };
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, defines: { VOLUME_SHAPE: SHAPES[shape] },
      uniforms: { ...U, ...own, ...uniforms }, ...FX_BLENDING, depthTest: false, side: THREE.BackSide,
      vertexShader: FX_VERT_HEAD + VOLUME_VERT,
      fragmentShader: FX_FRAG_HEAD + NO_GRADIENTS + COMMON_GLSL + NOISE_GLSL + ARENA_GLSL + LIGHTS_GLSL + FX_OUT_GLSL
        + VOLUME_HEAD + SHAPES_GLSL + glsl + VOLUME_MAIN,
    });
    const mesh = new THREE.Mesh(this.proxies[shape], material);
    mesh.visible = false;
    this.group.add(mesh);
    const h = {
      mesh, position: mesh.position, scale: mesh.scale, quaternion: mesh.quaternion, uniforms: material.uniforms,
      visible: false, maxSteps,
      g: 0.3,            // HG asymmetry (sun and spell lights)
      shadowTap: 0.3,    // sun-shadow tap distance, fraction of the smallest half extent
      ambient: 1, sun: 1,
    };
    this.list.push(h);
    return h;
  }

  update(camera) {
    const cap = Math.max(4, Math.floor(Math.min(Q.volumeSteps * Q.auto.steps, 64)));
    const pxPerM = 0.5 * U.uFxResolution.value.y * camera.projectionMatrix.elements[5];
    for (const h of this.list) {
      const m = h.mesh, u = h.uniforms;
      m.visible = h.visible;
      if (!h.visible) continue;
      m.updateMatrixWorld();
      m.matrixWorld.decompose(_p, _q, _s);
      u.uVolCenter.value.copy(_p);
      u.uVolScale.value.copy(_s);
      u.uVolRot.value.setFromMatrix4(_m.makeRotationFromQuaternion(_q.invert()));
      u.uVolLight.value.set(h.g, h.shadowTap * Math.min(_s.x, _s.y, _s.z), h.ambient, h.sun);
      const r = Math.max(_s.x, _s.y, _s.z), dist = _p.distanceTo(camera.position);
      const px = dist > r ? r * pxPerM / dist : Infinity;
      u.uVolSteps.value = Math.min(h.maxSteps, cap, Math.max(8, Math.ceil(px / 5)));
    }
  }
}
