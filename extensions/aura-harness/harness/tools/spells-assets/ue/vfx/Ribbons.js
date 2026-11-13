import * as THREE from 'three';
import { U, COMMON_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING, LINES_BLENDING } from './common.js';

// Instanced camera-facing strips (PLAN 2.5 "Ribbons and bolts"). One draw per material for every
// ribbon it owns; nothing is allocated after construction. Strips wind either way depending on
// the path direction, so every strip material is DoubleSide.
//   TrailRibbons     history ribbons: a points x max float texture of head positions, a ring per row
//   AnalyticRibbons  stateless: the centreline is user GLSL evaluated per vertex
// Bolts.js builds on STRIP_GLSL too.
//
// Distortion amounts everywhere are metres of apparent displacement at the strip's depth, so a far
// effect bends the background less than a near one.

// Needs projectionMatrix, viewMatrix and cameraPosition (three's prefix, or FX_VERT_HEAD).
export const STRIP_GLSL = /* glsl */`
// Humus "phone-wire" AA: a strip is never drawn thinner than 1.5 px; the width it lacks comes back
// as intensity (aa = trueWidth / clampedWidth), so thin wires fade out instead of breaking into dashes.
// Returns the world half width to expand by.
float wireHalfWidth(float width, float viewZ, float pxPerM, out float aa) {
  float px = width * pxPerM / max(viewZ, 1e-3);
  float clamped = max(px, 1.5);
  aa = px / clamped;
  return 0.5 * width * clamped / max(px, 1e-6);
}
// pixels per metre at view depth 1, for a target resY pixels tall
float pxPerMetre(float resY) { return 0.5 * resY * projectionMatrix[1][1]; }
// unit side vector of a strip through p with tangent t, facing the camera
vec3 stripSide(vec3 p, vec3 t) {
  vec3 s = cross(t, p - cameraPosition);
  float l = length(s);
  return l > 1e-7 ? s / l : vec3(1.0, 0.0, 0.0);
}
// screen-UV offset of 1 m of apparent displacement along world dir at p (dir ~ perpendicular to the view ray)
vec2 distortPerMetre(vec3 p, vec3 dir, float viewZ, vec2 res) {
  mat4 vp = projectionMatrix * viewMatrix;
  vec4 a = vp * vec4(p, 1.0), b = vp * vec4(p + dir * 0.01 * viewZ, 1.0);
  vec2 px = (b.xy / b.w - a.xy / a.w) * res;
  vec2 d = dot(px, px) > 1e-12 ? normalize(px) : vec2(1.0, 0.0);
  float h = 0.5 * projectionMatrix[1][1] / max(viewZ, 1e-3);   // metres -> fraction of screen height
  return d * vec2(h * res.y / res.x, h);
}
`;

// dead instances / strands: every vertex at one point outside the clip volume
const COLLAPSE = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';

// (count + 1) x 2 vertex strip; position = (x, side, z) with x from xOf(i)
function stripIndex(index, base, segments) {
  for (let i = 0; i < segments; i++) {
    const a = base + i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

// write 4 floats, report whether anything changed (dirty tracking without allocations)
export function put4(arr, o, x, y, z, w) {
  if (arr[o] === x && arr[o + 1] === y && arr[o + 2] === z && arr[o + 3] === w) return false;
  arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = w;
  return true;
}
const put4v = (arr, o, v) => put4(arr, o, v.x, v.y, v.z, v.w);

export function instanced(geo, name, count, size = 4) {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute(name, attr);
  return attr;
}

// --- history ribbons ---------------------------------------------------------------------

const TRAIL_VERT = /* glsl */`
uniform highp sampler2D uTrailTex;   // x = point slot (ring), y = trail row; xyz pos, w push time
uniform float uTrailTime;
in vec4 aTrail;    // row, head slot, point count, fade time
in vec4 aLook;     // width, glow (fx width multiplier), taper, distortion (m)
in vec4 aColor;    // rgb * intensity, glow intensity (fraction of the core's)
out vec2 vUv;      // along (0 head .. 1 tail), across (-1..1)
out vec3 vColor;
out float vViewZ;
out vec2 vDist;

vec4 trailPoint(int row, int head, int i, int P) { return texelFetch(uTrailTex, ivec2((head - i + P) % P, row), 0); }

void main() {
  int n = int(aTrail.z);
  vColor = vec3(0.0); vUv = vec2(0.0); vViewZ = 1.0; vDist = vec2(0.0);
  if (n < 2) { ${COLLAPSE} return; }
  int P = textureSize(uTrailTex, 0).x, row = int(aTrail.x), head = int(aTrail.y);
  int i = min(int(position.x), n - 1);
  vec4 c = trailPoint(row, head, i, P);
  vec3 tangent = trailPoint(row, head, max(i - 1, 0), P).xyz - trailPoint(row, head, min(i + 1, n - 1), P).xyz;
  float u = float(i) / float(n - 1);
  // past the last point the strip folds onto it with zero width (zero-area triangles)
  float alive = position.x > float(n - 1) ? 0.0 : 1.0;
  float fade = clamp(1.0 - (uTrailTime - c.w) / max(aTrail.w, 1e-3), 0.0, 1.0);
  fade *= fade;
  vec4 view = viewMatrix * vec4(c.xyz, 1.0);
  vViewZ = -view.z;
  vec3 side = stripSide(c.xyz, tangent);
  float width = aLook.x * mix(1.0, 1.0 - u, aLook.z) * alive, aa;
#ifdef TRAIL_FX
  // the wide glow would end in a square cap at the head: fade it in over the first two points
  float cap = smoothstep(0.0, 2.0, float(i));
  float hw = wireHalfWidth(width * aLook.y * mix(0.4, 1.0, cap), vViewZ, pxPerMetre(uFxResolution.y), aa);
  vColor = aColor.rgb * aColor.a * fade * aa * cap;
  vDist = distortPerMetre(c.xyz, side, vViewZ, uFxResolution) * aLook.w * fade;
#else
  float hw = wireHalfWidth(width, vViewZ, pxPerMetre(uResolution.y), aa);
  vColor = aColor.rgb * fade * aa;
#endif
  vUv = vec2(u, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(c.xyz + side * position.y * hw, 1.0);
}`;

const TRAIL_LINES_FRAG = /* glsl */`
in vec2 vUv;
in vec3 vColor;
out vec4 fragColor;
void main() {
  float v = 1.0 - vUv.y * vUv.y;
  fragColor = vec4(vColor * v * v, 1.0);
}`;

const TRAIL_FX_FRAG = /* glsl */`
in vec2 vUv;
in vec3 vColor;
in float vViewZ;
in vec2 vDist;
void main() {
  float v = vUv.y;
  float g = max(exp(-4.0 * v * v) - 0.0183, 0.0);   // gaussian, zero at the strip edge
  // derivative-of-gaussian profile: the centreline acts as a cylindrical lens (pushes outward)
  vec2 dist = vDist * (v * exp(-3.0 * v * v) * 2.33);
  fxOut(vec3(0.0), 0.0, vColor * g * softFade(vViewZ, 0.4), dist, vViewZ);
}`;

// per-trail look, reset on acquire. spacing: metres between committed points (points * spacing
// caps the trail's length; fadeTime its duration)
const TRAIL_DEFAULTS = { width: 0.06, intensity: 4, glow: 6, glowIntensity: 0.3, distortion: 0, taper: 1, fadeTime: 0.4, spacing: 0.08 };

export class TrailRibbons {
  constructor({ max = 64, points = 48 } = {}) {
    this.max = max;
    this.points = points;
    this.time = 0;
    this.data = new Float32Array(points * max * 4);
    const tex = this.texture = new THREE.DataTexture(this.data, points, max, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    // one texel per push; preallocated so pushing into texture.updateRanges allocates nothing
    this._ranges = Array.from({ length: max * 4 }, () => ({ start: 0, count: 0 }));
    this._nRanges = 0;
    this._full = false;

    const geo = new THREE.InstancedBufferGeometry();
    const pos = [], index = [];
    for (let i = 0; i < points; i++) pos.push(i, -1, 0, i, 1, 0);
    stripIndex(index, 0, points - 1);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    this.aTrail = instanced(geo, 'aTrail', max);
    this.aLook = instanced(geo, 'aLook', max);
    this.aColor = instanced(geo, 'aColor', max);
    geo.instanceCount = 0;
    this.geometry = geo;

    this.uniforms = { ...U, uTrailTex: { value: tex }, uTrailTime: { value: 0 } };
    this.lines = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.uniforms, ...LINES_BLENDING, side: THREE.DoubleSide,
      vertexShader: COMMON_GLSL + STRIP_GLSL + TRAIL_VERT, fragmentShader: TRAIL_LINES_FRAG,
    }));
    this.fx = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: this.uniforms, ...FX_BLENDING, side: THREE.DoubleSide, defines: { TRAIL_FX: 1 },
      vertexShader: FX_VERT_HEAD + COMMON_GLSL + STRIP_GLSL + TRAIL_VERT,
      fragmentShader: FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + TRAIL_FX_FRAG,
    }));
    this.lines.frustumCulled = this.fx.frustumCulled = false;
    this.lines.visible = this.fx.visible = false;

    this.trails = Array.from({ length: max }, (_, row) => {
      const owner = this;
      return {
        row, active: false, released: false, head: 0, count: 0, lastPush: 0,
        last: new THREE.Vector3(), color: new THREE.Color(1, 1, 1), ...TRAIL_DEFAULTS,
        // the newest point follows pos; a new point is committed once it is `spacing` from the last
        push(p) {
          if (this.count > 0 && this.last.distanceToSquared(p) >= this.spacing * this.spacing) {
            this.head = (this.head + 1) % owner.points;
            this.count = Math.min(this.count + 1, owner.points);
            this.last.copy(p);
          } else if (this.count === 0) {
            this.count = 1;
            this.last.copy(p);
          }
          owner._write(this.row, this.head, p);
          this.lastPush = owner.time;
        },
        release() { this.released = true; },
      };
    });
  }

  // released trails keep drawing until their newest point has faded (fadeTime), then free
  acquire() {
    for (const t of this.trails) {
      if (t.active) continue;
      Object.assign(t, TRAIL_DEFAULTS);
      t.active = true; t.released = false; t.head = 0; t.count = 0;
      t.color.setRGB(1, 1, 1);
      return t;
    }
    return null;
  }

  _write(row, slot, p) {
    const i = row * this.points + slot, o = i * 4, d = this.data;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; d[o + 3] = this.time;
    if (this._nRanges < this._ranges.length) {
      const r = this._ranges[this._nRanges++];
      r.start = o; r.count = 4;
    } else this._full = true;
  }

  update(dt) {
    this.time += dt;
    this.uniforms.uTrailTime.value = this.time;
    const A = this.aTrail.array, B = this.aLook.array, C = this.aColor.array;
    let n = 0;
    for (const t of this.trails) {
      if (!t.active) continue;
      if (t.released && this.time - t.lastPush > t.fadeTime) { t.active = false; continue; }
      const o = n * 4, I = t.intensity;
      A[o] = t.row; A[o + 1] = t.head; A[o + 2] = t.count; A[o + 3] = t.fadeTime;
      B[o] = t.width; B[o + 1] = t.glow; B[o + 2] = t.taper; B[o + 3] = t.distortion;
      C[o] = t.color.r * I; C[o + 1] = t.color.g * I; C[o + 2] = t.color.b * I; C[o + 3] = t.glowIntensity;
      n++;
    }
    this.geometry.instanceCount = n;
    this.lines.visible = this.fx.visible = n > 0;
    if (n) this.aTrail.needsUpdate = this.aLook.needsUpdate = this.aColor.needsUpdate = true;

    // texel uploads: only what was pushed. Ranges still queued from a frame that never drew mean
    // the GPU copy is behind, so send the whole texture once (48 KB at 64 x 48).
    const tex = this.texture;
    if (tex.updateRanges.length) this._full = true;
    if (this._full) {
      tex.updateRanges.length = 0;
      tex.needsUpdate = true;
    } else if (this._nRanges) {
      for (let i = 0; i < this._nRanges; i++) tex.updateRanges.push(this._ranges[i]);
      tex.needsUpdate = true;
    }
    this._full = false;
    this._nRanges = 0;
  }
}

// --- analytic ribbons ------------------------------------------------------------------

// The default shade: a soft additive core in the ribbon's colour.
const DEFAULT_SHADE = /* glsl */`
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
  float v = 1.0 - r.uv.y * r.uv.y;
  return r.color * v * v;
}`;

const ANALYTIC_HEAD = /* glsl */`
uniform float uSegments;
struct RibbonFrag {
  vec2 uv;           // x along 0..1, y across -1..1
  vec4 p0, p1, p2, p3;
  vec3 color;        // colour * intensity
  float viewZ;
};
`;

const ANALYTIC_VERT = /* glsl */`
in vec4 aP0;
in vec4 aP1;
in vec4 aP2;
in vec4 aP3;
in vec4 aColor;    // rgb * intensity, on
out vec2 vUv;
out float vViewZ;
out float vAA;
out vec2 vDist;
flat out vec4 vP0;
flat out vec4 vP1;
flat out vec4 vP2;
flat out vec4 vP3;
flat out vec3 vColor;

void main() {
  vUv = vec2(0.0); vViewZ = 1.0; vAA = 0.0; vDist = vec2(0.0);
  vP0 = aP0; vP1 = aP1; vP2 = aP2; vP3 = aP3; vColor = aColor.rgb;
  if (aColor.a <= 0.0) { ${COLLAPSE} return; }
  float t = position.x, w, w2;
  vec3 p = ribbonPath(t, aP0, aP1, aP2, aP3, w);
  float h = 0.5 / uSegments;
  vec3 tangent = ribbonPath(min(t + h, 1.0), aP0, aP1, aP2, aP3, w2) - ribbonPath(max(t - h, 0.0), aP0, aP1, aP2, aP3, w2);
  vec3 side = stripSide(p, tangent);
  vViewZ = -(viewMatrix * vec4(p, 1.0)).z;
#ifdef RIBBON_FX
  float hw = wireHalfWidth(w, vViewZ, pxPerMetre(uFxResolution.y), vAA);
  vDist = distortPerMetre(p, side, vViewZ, uFxResolution);
#else
  float hw = wireHalfWidth(w, vViewZ, pxPerMetre(uResolution.y), vAA);
#endif
  vUv = vec2(t, position.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(p + side * position.y * hw, 1.0);
}`;

const ANALYTIC_LINES_FRAG = /* glsl */`
in vec2 vUv;
in float vViewZ;
in float vAA;
flat in vec4 vP0;
flat in vec4 vP1;
flat in vec4 vP2;
flat in vec4 vP3;
flat in vec3 vColor;
out vec4 fragColor;
void main() {
  vec3 media = vec3(0.0); float alpha = 0.0, distortion = 0.0;
  vec3 e = ribbonShade(RibbonFrag(vUv, vP0, vP1, vP2, vP3, vColor, vViewZ), media, alpha, distortion);
  fragColor = vec4(e * vAA, 1.0);
}`;

const ANALYTIC_FX_FRAG = /* glsl */`
in vec2 vUv;
in float vViewZ;
in float vAA;
in vec2 vDist;
flat in vec4 vP0;
flat in vec4 vP1;
flat in vec4 vP2;
flat in vec4 vP3;
flat in vec3 vColor;
void main() {
  vec3 media = vec3(0.0); float alpha = 0.0, distortion = 0.0;
  vec3 e = ribbonShade(RibbonFrag(vUv, vP0, vP1, vP2, vP3, vColor, vViewZ), media, alpha, distortion);
  float s = softFade(vViewZ, 0.3) * vAA;
  fxOut(media, alpha * s, e * s, vDist * distortion * s, vViewZ);
}`;

// pathGLSL: vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width)   t 0..1
// shadeGLSL: vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion)
//   returns emission; media/alpha (WBOIT coverage) and distortion only count for target 'fx'.
//   distortion: signed metres along the +uv.y side; make it odd in uv.y (e.g. uv.y * exp(-3 uv.y^2))
//   to push the background away from the centreline.
// Either may declare its own uniforms (pass them in `uniforms`).
export class AnalyticRibbons {
  constructor({ max = 16, segments = 64, pathGLSL, shadeGLSL = DEFAULT_SHADE, target = 'lines', uniforms = {} }) {
    this.max = max;
    const geo = new THREE.InstancedBufferGeometry();
    const pos = [], index = [];
    for (let i = 0; i <= segments; i++) pos.push(i / segments, -1, 0, i / segments, 1, 0);
    stripIndex(index, 0, segments);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    this.attrs = ['aP0', 'aP1', 'aP2', 'aP3', 'aColor'].map((n) => instanced(geo, n, max));
    geo.instanceCount = 0;
    this.geometry = geo;
    this.uniforms = { ...U, ...uniforms, uSegments: { value: segments } };
    const head = COMMON_GLSL + STRIP_GLSL + ANALYTIC_HEAD + pathGLSL;
    const material = target === 'fx'
      ? new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms: this.uniforms, ...FX_BLENDING, side: THREE.DoubleSide, defines: { RIBBON_FX: 1 },
        vertexShader: FX_VERT_HEAD + head + ANALYTIC_VERT,
        fragmentShader: FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + ANALYTIC_HEAD + shadeGLSL + ANALYTIC_FX_FRAG,
      })
      : new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms: this.uniforms, ...LINES_BLENDING, side: THREE.DoubleSide,
        vertexShader: head + ANALYTIC_VERT, fragmentShader: COMMON_GLSL + ANALYTIC_HEAD + shadeGLSL + ANALYTIC_LINES_FRAG,
      });
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.ribbons = Array.from({ length: max }, (_, index) => ({
      index, active: false,
      p0: new THREE.Vector4(), p1: new THREE.Vector4(), p2: new THREE.Vector4(), p3: new THREE.Vector4(),
      color: new THREE.Color(1, 1, 1), intensity: 1,
      release() { this.active = false; },
    }));
  }

  acquire() {
    for (const r of this.ribbons) {
      if (r.active) continue;
      r.active = true; r.intensity = 1; r.color.setRGB(1, 1, 1);
      r.p0.set(0, 0, 0, 0); r.p1.set(0, 0, 0, 0); r.p2.set(0, 0, 0, 0); r.p3.set(0, 0, 0, 0);
      return r;
    }
    return null;
  }

  // copy handle fields into the instance attributes; upload only if something changed
  update() {
    let top = 0, dirty = false;
    const X = this.attrs, a0 = X[0], a1 = X[1], a2 = X[2], a3 = X[3], ac = X[4];
    for (const r of this.ribbons) {
      const o = r.index * 4, on = r.active && r.intensity > 0;
      if (on) top = r.index + 1;
      dirty = put4(ac.array, o, r.color.r * r.intensity, r.color.g * r.intensity, r.color.b * r.intensity, on ? 1 : 0) || dirty;
      if (!on) continue;
      dirty = put4v(a0.array, o, r.p0) || dirty;
      dirty = put4v(a1.array, o, r.p1) || dirty;
      dirty = put4v(a2.array, o, r.p2) || dirty;
      dirty = put4v(a3.array, o, r.p3) || dirty;
    }
    if (dirty) for (const a of this.attrs) a.needsUpdate = true;
    this.geometry.instanceCount = top;
    this.mesh.visible = top > 0;
  }
}
