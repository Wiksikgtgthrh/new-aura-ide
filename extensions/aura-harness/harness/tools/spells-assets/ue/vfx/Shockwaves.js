import * as THREE from 'three';
import { U, COMMON_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING } from './common.js';
import { instanced } from './Ribbons.js';

// Expanding shock shells and ground rings in the fx pass: a radial screen-space distortion
// proportional to how much shell the view ray crosses (so the rim reads as a lens), plus optional
// emission. Fire and forget: spawn() and the pool (16, one instanced draw) ages them out.
//   sphere: camera-facing quad perpendicular to the view axis, sized to the shell's silhouette cone;
//           the profile is the exact chord through the shell, normalised to 1 at its peak (rho = inner radius)
//   ground: a flat quad hugging pos.y; ring profile with a sharp leading edge and a soft wake
// Radius follows a blast-wave curve r0 + (r1 - r0) x^0.4 (Sedov-Taylor r ~ t^0.4); emission decays
// as (1 - x)^3 (a flash), distortion as (1 - x)^1.5 after a 5% attack. distortion is metres of
// apparent displacement at the shell's depth.

const VERT = /* glsl */`
in vec4 aS0;   // centre, ground
in vec4 aS1;   // radius, thickness, progress (< 0: dead), -
in vec4 aS2;   // emission rgb, distortion (m), envelopes applied
out vec3 vWorld;
out float vViewZ;
flat out vec4 vS0;
flat out vec4 vS1;
flat out vec4 vS2;
flat out vec2 vCentre;   // projected centre, fx pixels

void main() {
  vS0 = aS0; vS1 = aS1; vS2 = aS2; vWorld = vec3(0.0); vViewZ = 1.0; vCentre = vec2(0.0);
  vec3 c = aS0.xyz;
  float R = aS1.x + 0.75 * aS1.y;
  vec3 toC = c - cameraPosition;
  float D = length(toC);
  // ponytail: a camera inside a sphere shell just loses it (ground rings still draw)
  if (aS1.z < 0.0 || (aS0.w < 0.5 && D < R * 1.05)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p;
  if (aS0.w > 0.5) p = c + vec3(position.x * R, 0.03, position.y * R);
  else {
    vec3 f = toC / D, r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), u = cross(r, f);
    p = c + (r * position.x + u * position.y) * (R / sqrt(1.0 - (R / D) * (R / D)));
  }
  vWorld = p;
  vec4 cc = projectionMatrix * viewMatrix * vec4(c, 1.0);
  vCentre = (cc.xy / cc.w * 0.5 + 0.5) * uFxResolution;
  vec4 view = viewMatrix * vec4(p, 1.0);
  vViewZ = -view.z;
  gl_Position = projectionMatrix * view;
}`;

const FRAG = /* glsl */`
uniform mat4 projectionMatrix;
in vec3 vWorld;
in float vViewZ;
flat in vec4 vS0;
flat in vec4 vS1;
flat in vec4 vS2;
flat in vec2 vCentre;

void main() {
  vec3 c = vS0.xyz;
  float r = vS1.x, th = vS1.y, prof;
  if (vS0.w > 0.5) {
    // sharp leading edge, soft wake behind it
    float x = (length(vWorld.xz - c.xz) - r) / (0.5 * th);
    prof = exp(-x * x * (x > 0.0 ? 6.0 : 0.8));
  } else {
    vec3 rd = normalize(vWorld - cameraPosition), oc = c - cameraPosition;
    float tc = dot(oc, rd), rho2 = max(dot(oc, oc) - tc * tc, 0.0);
    float ro = r + 0.5 * th, ri = max(r - 0.5 * th, 0.0);
    float chord = sqrt(max(ro * ro - rho2, 0.0)) - sqrt(max(ri * ri - rho2, 0.0));
    prof = chord / sqrt(max(ro * ro - ri * ri, 1e-6));
  }
  if (prof < 1e-3) discard;
  vec2 dir = gl_FragCoord.xy - vCentre;
  dir = dot(dir, dir) > 1e-6 ? normalize(dir) : vec2(0.0);
  float h = 0.5 * projectionMatrix[1][1] / max(vViewZ, 1e-3);
  float s = softFade(vViewZ, 0.3) * prof;
  // sample nearer the centre: the background bulges outward under the rim
  vec2 dist = -dir * vec2(h * uFxResolution.y / uFxResolution.x, h) * vS2.w * s;
  // emission hugs the rim (seen through, the shell's two walls would otherwise glow as a dome)
  float p2 = prof * prof;
  fxOut(vec3(0.0), 0.0, vS2.rgb * p2 * p2 * softFade(vViewZ, 0.3), dist, vViewZ);
}`;

export class Shockwaves {
  constructor({ max = 16 } = {}) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = ['aS0', 'aS1', 'aS2'].map((n) => instanced(geo, n, max));
    geo.instanceCount = 0;
    this.geometry = geo;
    this.uniforms = { ...U };
    this.mesh = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.uniforms, ...FX_BLENDING, side: THREE.DoubleSide,
      vertexShader: FX_VERT_HEAD + COMMON_GLSL + VERT,
      fragmentShader: FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + FRAG,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.slots = Array.from({ length: max }, (_, index) => ({
      index, active: false, age: 0,
      pos: new THREE.Vector3(), radius0: 0.2, radius1: 6, duration: 0.6, thickness: 0.6,
      distortion: 0.12, color: new THREE.Color(1, 1, 1), intensity: 0, ground: false,
    }));
  }

  // pos: Vector3, color: THREE.Color (both copied). Full pool: the most advanced wave is replaced.
  spawn({ pos, radius0 = 0.2, radius1 = 6, duration = 0.6, thickness = 0.6, distortion = 0.12, color, intensity = 0, ground = false }) {
    let s = this.slots[0];
    for (const x of this.slots) {
      if (!x.active) { s = x; break; }
      if (x.age / x.duration > s.age / s.duration) s = x;
    }
    s.pos.copy(pos);
    Object.assign(s, { active: true, age: 0, radius0, radius1, duration, thickness, distortion, intensity, ground });
    if (color) s.color.copy(color); else s.color.setRGB(1, 1, 1);
    return s;
  }

  update(dt) {
    const a0 = this.attrs[0].array, a1 = this.attrs[1].array, a2 = this.attrs[2].array;
    let top = 0;
    for (const s of this.slots) {
      const o = s.index * 4;
      if (s.active) {
        s.age += dt;
        if (s.age >= s.duration) s.active = false;
      }
      if (!s.active) { a1[o + 2] = -1; continue; }
      top = s.index + 1;
      const x = s.age / s.duration, k = 1 - x;
      const e = s.intensity * k * k * k, d = s.distortion * Math.pow(k, 1.5) * Math.min(1, x / 0.05);
      a0[o] = s.pos.x; a0[o + 1] = s.pos.y; a0[o + 2] = s.pos.z; a0[o + 3] = s.ground ? 1 : 0;
      a1[o] = s.radius0 + (s.radius1 - s.radius0) * Math.pow(x, 0.4); a1[o + 1] = s.thickness * (0.5 + 0.5 * x); a1[o + 2] = x;
      a2[o] = s.color.r * e; a2[o + 1] = s.color.g * e; a2[o + 2] = s.color.b * e; a2[o + 3] = d;
    }
    for (const a of this.attrs) a.needsUpdate = true;
    this.geometry.instanceCount = top;
    this.mesh.visible = top > 0;
  }
}
