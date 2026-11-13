import * as THREE from 'three';
import { FullscreenQuad, FULLSCREEN_VERT, rawPass } from '../../engine/fullscreen.js';
import {
  U, COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, ARENA_GLSL, FORCES_GLSL, LIGHTS_GLSL,
  FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING, LINES_BLENDING,
} from '../../vfx/common.js';

// A small GPU agent engine for swarms (Plague Swarm, Ember Swarm). Not a spell: no default export.
//  - State: two RGBA32F MRT targets, ping-ponged by one fullscreen draw:
//      S0 = (pos.xyz, age)   S1 = (vel.xyz, state)
//    state 0 unborn, 1 flying, 2 landed / clinging, 3 falling, 4 resting, 5 spent (never respawns
//    until reset). A texel is born when its hash < uSpawnFrac, so a spell grows its swarm by
//    ramping one uniform: no emission records, no CPU per agent.
//  - Flocking grid (optional): every flying agent splats (vel, 1) into one 32^3 cell of a 2D atlas
//    (8 x 4 tiles of 32 x 32, RGBA16F, additive points). The sim reads it back trilinearly
//    (hardware bilinear in a tile, manual lerp across slices): mean velocity = alignment, density
//    gradients at two scales = separation (pressure) and cohesion. O(N), no sort, no neighbour
//    lists: particle-in-cell boids.
//  - Floor light (optional): agents splat their emission x 1/(h^2 + k) into a 64^2 floor texture
//    that follows the swarm, blurred twice; a floor decal in the lines pass relights the floor
//    from it (the resolved opaque colour carries the floor's own texture), so thousands of glowing
//    agents light the floor beneath them without a light each.
// The spell supplies the behaviour (swarmSpawn / swarmStep) and the look (a GLSL chunk shared by
// the glow, light and body shaders) as strings, compiled once in create().

export const GN = 32;

export const SWARM_STATE_GLSL = (W) => /* glsl */`
uniform highp sampler2D uS0;
uniform highp sampler2D uS1;
const int SW = ${W};
ivec2 swarmTexel(int i) { return ivec2(i % SW, i / SW); }
vec4 swarmHash(int i) { return hash41(float(i) * 0.6180339 + 0.37); }
vec4 swarmHash2(int i) { return hash41(float(i) * 0.4142136 + 11.3); }
vec4 swarmHash3(int i) { return hash41(float(i) * 0.2718281 + 5.1); }
`;

export const GRID_GLSL = /* glsl */`
uniform highp sampler2D uGrid;
uniform vec4 uGridBox;   // min corner xyz, cell size (m)
vec4 gridAt(vec3 p) {
  vec3 c = (p - uGridBox.xyz) / uGridBox.w - 0.5;
  if (any(lessThan(c, vec3(-0.5))) || any(greaterThan(c, vec3(${GN}.0 - 0.5)))) return vec4(0.0);
  c = clamp(c, 0.0, ${GN}.0 - 1.0);
  float z0 = floor(c.z), fz = c.z - z0, z1 = min(z0 + 1.0, ${GN}.0 - 1.0);
  vec2 t0 = vec2(mod(z0, 8.0), floor(z0 / 8.0)) * ${GN}.0, t1 = vec2(mod(z1, 8.0), floor(z1 / 8.0)) * ${GN}.0;
  const vec2 inv = 1.0 / vec2(${GN * 8}.0, ${GN * 4}.0);
  return mix(texture(uGrid, (t0 + c.xy + 0.5) * inv), texture(uGrid, (t1 + c.xy + 0.5) * inv), fz) * 64.0;
}
float gridN(vec3 p) { return gridAt(p).w; }
`;

const SIM_FRAG = (W, body, grid) => /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
${COMMON_GLSL}
${NOISE_GLSL}
${ARENA_GLSL}
${FORCES_GLSL}
${SWARM_STATE_GLSL(W)}
${grid ? GRID_GLSL : ''}
uniform float uSimDt;
uniform float uSpawnFrac;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
${body}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int idx = px.y * SW + px.x;
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  vec3 p = s0.xyz, v = s1.xyz;
  float age = s0.w, st = s1.w;
  vec4 h = swarmHash(idx);
  if (st < 0.5) {
    if (h.x >= uSpawnFrac) { o0 = vec4(0.0); o1 = vec4(0.0); return; }
    st = 1.0; age = 0.0;
    swarmSpawn(idx, h, p, v);
  } else if (st > 4.5) { o0 = s0; o1 = s1; return; }
  else { age += uSimDt; swarmStep(idx, h, p, v, st, age, uSimDt); }
  if (!(dot(p, p) < 1e12) || !(dot(v, v) < 1e12)) { p = vec3(0.0, -100.0, 0.0); v = vec3(0.0); st = 5.0; }
  o0 = vec4(p, age);
  o1 = vec4(v, st);
}`;

// splat flying agents into the flocking atlas
const GRID_VERT = (W) => /* glsl */`
precision highp float;
precision highp int;
${COMMON_GLSL}
${SWARM_STATE_GLSL(W)}
uniform vec4 uGridBox;
out vec4 vVal;
void main() {
  ivec2 px = swarmTexel(gl_VertexID);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  gl_PointSize = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vVal = vec4(0.0);
  if (s1.w < 0.5 || s1.w > 1.5) return;
  vec3 c = floor((s0.xyz - uGridBox.xyz) / uGridBox.w);
  if (any(lessThan(c, vec3(0.0))) || any(greaterThanEqual(c, vec3(${GN}.0)))) return;
  vec2 t = vec2(mod(c.z, 8.0), floor(c.z / 8.0)) * ${GN}.0 + c.xy + 0.5;
  gl_Position = vec4(t / vec2(${GN * 8}.0, ${GN * 4}.0) * 2.0 - 1.0, 0.0, 1.0);
  vVal = vec4(s1.xyz, 1.0) * (1.0 / 64.0);   // half floats: a whole swarm in one cell must not overflow
}`;
const VAL_FRAG = /* glsl */`
precision highp float;
in vec4 vVal;
out vec4 fragColor;
void main() { fragColor = vVal; }`;

// splat agent emission into the floor light texture
const LIGHT_VERT = (W, look) => /* glsl */`
precision highp float;
precision highp int;
${COMMON_GLSL}
${NOISE_GLSL}
${SWARM_STATE_GLSL(W)}
uniform vec4 uLightBox;   // min x, min z, size (m), height softening (m^2)
${look}
out vec4 vVal;
void main() {
  int idx = gl_VertexID;
  ivec2 px = swarmTexel(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  gl_PointSize = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vVal = vec4(0.0);
  if (s1.w < 0.5 || s1.w > 4.5) return;
  vec3 col = swarmLight(idx, swarmHash(idx), s0.xyz, s1.xyz, s1.w, s0.w);
  vec2 uv = (s0.xz - uLightBox.xy) / uLightBox.z;
  if (dot(col, col) <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return;
  float hgt = max(s0.y, 0.0);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  // irradiance straight below a point source, I cos / d^2 with d = h (softened)
  vVal = vec4(min(col / (hgt * hgt + uLightBox.w), vec3(64.0)) * (1.0 / 256.0), 0.0);   // scaled: no half overflow
}`;

const BLUR_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uTex;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 s = vec4(0.0);
  for (int k = -4; k <= 4; k++) s += texture(uTex, vUv + uStep * float(k)) * exp(-float(k * k) / 8.0);
  fragColor = s / 5.0133;
}`;

// --- glow: velocity-stretched additive capsules (lines pass), as Particles' glow -----------------
const GLOW_VERT = (W, look, copies) => /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
in vec3 position;
${COMMON_GLSL}
${NOISE_GLSL}
${SWARM_STATE_GLSL(W)}
${look}
out vec2 vUv;
out vec3 vColor;
out float vSoft;
void main() {
  int idx = gl_InstanceID / ${copies}, copy = gl_InstanceID - idx * ${copies};
  ivec2 px = swarmTexel(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vColor = vec3(0.0); vUv = vec2(0.0); vSoft = 0.0;
  if (s1.w < 0.5 || s1.w > 4.5) return;
  vec3 head, tail, col; float size;
  if (!swarmGlow(idx, copy, swarmHash(idx), s0.xyz, s1.xyz, s1.w, s0.w, head, tail, size, col)) return;
  vec3 headV = (viewMatrix * vec4(head, 1.0)).xyz, tailV = (viewMatrix * vec4(tail, 1.0)).xyz;
  headV.z += 0.03; tailV.z += 0.03;   // in front of the agent's own opaque body
  float viewZ = max(-headV.z, 0.05);
  float pxWorld = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float w = max(size, 1.5 * pxWorld), aa = size / w;
  vec2 axis = tailV.xy - headV.xy;
  float len = length(axis);
  vec2 dir = len > 1e-5 ? axis / len : vec2(1.0, 0.0), perp = vec2(-dir.y, dir.x);
  vec2 off = dir * (position.x < 0.0 ? -w : len + w) + perp * position.y * w;
  gl_Position = projectionMatrix * vec4(headV + vec3(off, 0.0), 1.0);
  vUv = vec2(position.x < 0.0 ? -1.0 : 1.0, position.y);
  vSoft = len / (len + 2.0 * w);
  vColor = col * aa * smoothstep(0.25, 0.8, viewZ) * (2.0 * w / (len + 2.0 * w));
}`;
const GLOW_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
in vec3 vColor;
in float vSoft;
out vec4 fragColor;
void main() {
  float x = vUv.x * 0.5 + 0.5, ends = 1.0 - vSoft;
  float dx = x < ends * 0.5 ? (ends * 0.5 - x) / max(ends * 0.5, 1e-3) : x > 1.0 - ends * 0.5 ? (x - 1.0 + ends * 0.5) / max(ends * 0.5, 1e-3) : 0.0;
  float d2 = dx * dx + vUv.y * vUv.y;
  fragColor = vec4(vColor * exp(-d2 * 4.0) * mix(1.0, 0.4, x), 0.0);
}`;

// --- floor decal: relights the floor from the light texture (lines pass, reads the opaque colour)
const FLOOR_VERT = /* glsl */`
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FLOOR_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D uLightTex;
uniform sampler2D uSceneColor;
uniform vec2 uResolution;
uniform vec4 uLightBox;
uniform vec4 uFloor;      // gain, base albedo, relight (scene colour share), -
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uAmbient;
in vec3 vW;
out vec4 fragColor;
void main() {
  vec2 uv = (vW.xz - uLightBox.xy) / uLightBox.z;
  vec2 e = smoothstep(0.0, 0.12, uv) * smoothstep(1.0, 0.88, uv);
  vec3 E = texture(uLightTex, uv).rgb * (256.0 * e.x * e.y * uFloor.x);
  if (dot(E, E) < 1e-10) discard;
  // albedo from what the floor already shows: scene / the irradiance the arena put there
  vec3 sc = texture(uSceneColor, gl_FragCoord.xy / uResolution).rgb;
  vec3 Eamb = uAmbient * 3.14159 + uSunColor * max(uSunDir.y, 0.0) * 0.5 + 1e-3;
  vec3 alb = mix(vec3(uFloor.y), clamp(sc / Eamb, 0.0, 0.25), uFloor.z);
  fragColor = vec4(E * alb, 0.0);
}`;

const quadGeometry = () => {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
};
const pointCloud = (n, material) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n), 1));
  g.boundingSphere = new THREE.Sphere();
  const m = new THREE.Points(g, material);
  m.frustumCulled = false;
  return m;
};
const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true, depthTest: false, depthWrite: false };

export class Swarm {
  // sim: GLSL defining swarmSpawn / swarmStep. look: GLSL defining swarmGlow / swarmLight.
  constructor(fx, { W, H, sim, look, uniforms, grid = false, light = null }) {
    const r = fx.renderer;
    this.fx = fx; this.W = W; this.H = H; this.N = W * H;
    this.active = false;
    const rtOpts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false, count: 2 };
    this.rt = [new THREE.WebGLRenderTarget(W, H, rtOpts), new THREE.WebGLRenderTarget(W, H, rtOpts)];
    this.cur = 0;
    this.stateU = { uS0: { value: null }, uS1: { value: null } };
    this.u = uniforms;   // the spell's, shared by reference with every material here
    this.simU = { ...U, ...this.stateU, ...uniforms, uSimDt: { value: 1 / 60 }, uSpawnFrac: { value: 0 } };
    this.passes = [];

    if (grid) {
      this.gridRT = new THREE.WebGLRenderTarget(GN * 8, GN * 4, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
      this.gridBox = new THREE.Vector4(0, 0, 0, 0.25);
      this.simU.uGrid = { value: this.gridRT.texture };
      this.simU.uGridBox = { value: this.gridBox };
      this.gridPts = pointCloud(this.N, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: GRID_VERT(W), fragmentShader: VAL_FRAG,
        uniforms: { ...U, ...this.stateU, uGridBox: this.simU.uGridBox }, ...ADD,
      }));
    }
    this.sim = new FullscreenQuad(new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FULLSCREEN_VERT, fragmentShader: SIM_FRAG(W, sim, grid),
      uniforms: this.simU, depthTest: false, depthWrite: false,
    }));
    this.lookU = { ...U, ...this.stateU, ...uniforms };

    if (light) {
      const res = light.res ?? 64;
      const lo = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping };
      this.lightRT = [new THREE.WebGLRenderTarget(res, res, lo), new THREE.WebGLRenderTarget(res, res, lo)];
      this.lightBox = new THREE.Vector4(-8, -8, light.box ?? 16, light.soft ?? 0.35);
      this.lightU = { uLightBox: { value: this.lightBox } };
      this.lightPts = pointCloud(this.N, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: LIGHT_VERT(W, look), fragmentShader: VAL_FRAG,
        uniforms: { ...this.lookU, ...this.lightU }, ...ADD,
      }));
      this.blur = new FullscreenQuad(rawPass(BLUR_FRAG, { uTex: { value: null }, uStep: { value: new THREE.Vector2() } }));
      this.floorU = { uFloor: { value: new THREE.Vector4(1, 0.045, 0.6, 0) } };
      const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      this.floor = new THREE.Mesh(plane, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG,
        uniforms: { ...U, uLightTex: { value: this.lightRT[0].texture }, uLightBox: this.lightU.uLightBox, ...this.floorU }, ...LINES_BLENDING,
      }));
      this.floor.frustumCulled = false;
      this.floor.visible = false;
      this.floor.renderOrder = -1;
    }
    this.glow = null;
    this.look = look;
    this.reset();
    // compile the off-scene passes now (programs never grow at cast time)
    this.simU.uSpawnFrac.value = 0;
    this.run(1 / 60);
    this.reset();
  }

  // full-res additive glow mesh for the lines scene; copies = quads per agent (swarmGlow's copy)
  glowMesh(copies = 1) {
    const m = new THREE.Mesh(quadGeometry(), new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GLOW_VERT(this.W, this.look, copies), fragmentShader: GLOW_FRAG,
      uniforms: this.lookU, ...LINES_BLENDING,
    }));
    m.geometry.instanceCount = this.N * copies;
    m.frustumCulled = false;
    m.renderOrder = 11;
    m.layers.enable(1);
    m.visible = false;
    return (this.glow = m);
  }

  // a material over the state for the spell's own meshes
  material(vertexShader, fragmentShader, extraUniforms, blending) {
    return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader, fragmentShader, uniforms: { ...this.lookU, ...extraUniforms }, ...blending });
  }
  instancedQuad() { const g = quadGeometry(); g.instanceCount = this.N; return g; }

  bind() {
    const t = this.rt[this.cur].textures;
    this.stateU.uS0.value = t[0]; this.stateU.uS1.value = t[1];
  }
  reset() {
    const r = this.fx.renderer;
    for (const rt of this.rt) { r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(true, false, false); }
    if (this.lightRT) for (const rt of this.lightRT) { r.setRenderTarget(rt); r.clear(true, false, false); }
    r.setRenderTarget(null);
    this.cur = 0;
    this.bind();
  }

  run(dt) {
    const r = this.fx.renderer, cam = this.fx.camera;
    this.simU.uSimDt.value = dt;
    if (this.gridRT) {
      r.setRenderTarget(this.gridRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.render(this.gridPts, cam);
    }
    this.bind();
    this.cur ^= 1;
    this.sim.render(r, this.rt[this.cur]);
    this.bind();
    if (this.lightRT) {
      const [a, b] = this.lightRT, u = this.blur.material.uniforms, res = a.width;
      r.setRenderTarget(a);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.render(this.lightPts, cam);
      u.uTex.value = a.texture; u.uStep.value.set(1 / res, 0); this.blur.render(r, b);
      u.uTex.value = b.texture; u.uStep.value.set(0, 1 / res); this.blur.render(r, a);
    }
  }

  // per frame from fx.systems while active
  update(dt) {
    if (!this.active || dt <= 0) return;
    this.run(Math.min(dt, 1 / 30));
  }

  show(on) {
    if (this.glow) this.glow.visible = on;
    if (this.floor) {
      this.floor.visible = on;
      const B = this.lightBox;
      this.floor.position.set(B.x + B.z / 2, 0.012, B.y + B.z / 2);
      this.floor.scale.set(B.z, 1, B.z);
    }
  }
}

// ================================================================================================
// Plague Swarm
// ================================================================================================

// the training dummy's body as an SDF, in its leaning frame (needs uDummyP, uDummyR, ARENA_GLSL)
export const SWARM_DUMMY_GLSL = /* glsl */`
float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-5); }
// sack, head, arm beam, post
float dummySDF(vec3 w) {
  vec3 p = transpose(uDummyR) * (w - uDummyP.xyz);
  float d = sdEllipsoid(p - vec3(0.0, 1.02, 0.0), vec3(0.3, 0.43, 0.25));
  d = min(d, sdEllipsoid(p - vec3(0.0, 1.62, 0.0), vec3(0.16, 0.176, 0.152)));
  d = min(d, sdCapsule(p, vec3(-0.58, 1.27, 0.0), vec3(0.58, 1.27, 0.0), 0.045));
  d = min(d, sdCapsule(p, vec3(0.0, 0.1, 0.0), vec3(0.0, 0.62, 0.0), 0.06));
  return d;
}
vec3 dummyNormal(vec3 p) {
  const vec2 e = vec2(0.01, 0.0);
  return normalize(vec3(dummySDF(p + e.xyy) - dummySDF(p - e.xyy), dummySDF(p + e.yxy) - dummySDF(p - e.yxy), dummySDF(p + e.yyx) - dummySDF(p - e.yyx)));
}
`;

// boids on the grid: alignment with the local mean velocity, pressure-like separation, cohesion up
// the wide-scale density gradient where it is sparse (needs uFlock, uMove and the flocking grid)
export const SWARM_BOIDS_GLSL = /* glsl */`
vec3 boidAccel(vec3 p, vec3 v) {
  vec4 g = gridAt(p);
  float n = g.w, rho0 = uMove.w, c = uGridBox.w;
  vec3 acc = uFlock.x * (g.xyz / max(n, 1e-3) - v) * smoothstep(0.5, 3.0, n);
  vec3 ex = vec3(c, 0.0, 0.0), ey = vec3(0.0, c, 0.0), ez = vec3(0.0, 0.0, c);
  vec3 g1 = vec3(gridN(p + ex) - gridN(p - ex), gridN(p + ey) - gridN(p - ey), gridN(p + ez) - gridN(p - ez)) * 0.5 / rho0;
  acc -= uFlock.y * g1 * smoothstep(0.25 * rho0, 1.2 * rho0, n);
  vec3 g2 = vec3(gridN(p + 2.5 * ex) - gridN(p - 2.5 * ex), gridN(p + 2.5 * ey) - gridN(p - 2.5 * ey), gridN(p + 2.5 * ez) - gridN(p - 2.5 * ez)) * 0.5 / rho0;
  acc += uFlock.z * g2 * (1.0 - smoothstep(0.4 * rho0, 1.5 * rho0, n));
  return acc;
}
`;

// behaviour: boids on the grid + a goal field (the leader's cloud, an orbit shell around the target,
// a landing on the dummy, dispersal), curl turbulence, world avoidance, other spells' forces
export const PLAGUE_SIM = /* glsl */`
uniform vec4 uLeader;    // cloud centre xyz, radius (m)
uniform vec4 uLeaderV;   // leader velocity xyz, cloud height / width
uniform vec4 uTarget;    // envelope centre xyz, radius
uniform vec4 uMode;      // envelope 0..1, disperse 0..1, landing fraction, death fraction
uniform vec4 uFlock;     // alignment, separation, cohesion, turbulence
uniform vec4 uMove;      // cruise m/s, orbit m/s, steering gain, rest density (agents / cell)
uniform vec4 uSpawnP;    // spawn centre xyz, radius
uniform vec4 uDummyP;    // target dummy base xyz, 1 = landing allowed
uniform mat3 uDummyR;    // its lean (local -> world)
uniform vec4 uClock;     // seconds since dispersal began (-1 before), force response, -, -
uniform vec4 uPathA;     // the river: swoop start xyz, swoop duration (s)
uniform vec4 uPathM;     // its Bezier control point xyz, cast clock (s)
uniform vec4 uPathB;     // its end (the target) xyz, swoop start time (s)
uniform vec4 uStream;    // delay spread along the river (s), river radius (m), -, -
${SWARM_BOIDS_GLSL}
// the swoop: slow off the cloud, diving at the end
vec3 pathAt(float s) {
  s = clamp(s, 0.0, 1.0);
  float k = s * s * (3.0 - 2.0 * s) * 0.6 + s * s * 0.4, i = 1.0 - k;
  return i * i * uPathA.xyz + 2.0 * i * k * uPathM.xyz + k * k * uPathB.xyz;
}

${SWARM_DUMMY_GLSL}

void swarmSpawn(int idx, vec4 h, inout vec3 p, inout vec3 v) {
  vec3 r = hash31(float(idx) * 1.37 + uTime * 13.1);
  vec3 d = randomOnSphere(r.xy);
  p = uSpawnP.xyz + d * uSpawnP.w * (0.4 + 0.6 * r.z);
  // a rising, turning boil out of the orb
  vec3 tang = normalize(cross(vec3(0.0, 1.0, 0.0), d) + 1e-4);
  v = (tang * 3.2 + vec3(0.0, 2.2, 0.0) + d * 1.4 + normalize(uLeader.xyz - p) * 1.5) * mix(0.7, 1.3, h.y);
}

void swarmStep(int idx, vec4 h, inout vec3 p, inout vec3 v, inout float st, inout float age, float dt) {
  vec4 h2 = swarmHash2(idx), h3 = swarmHash3(idx);
  if (st > 3.5) {   // dead on the floor: lies still, then it's gone
    v = vec3(0.0);
    if (age > 2.6) st = 5.0;
    return;
  }
  if (st > 2.5) {   // dying: wings stop, it tumbles down
    v += (vec3(0.0, -9.81, 0.0) + curl3(p * 0.9 + h.xyz) * 3.0) * dt;
    v *= exp(-1.4 * dt);
    p += v * dt;
    float d = arenaSDF(p);
    if (d < 0.006) { p += arenaNormal(p) * (0.006 - d); v = vec3(0.0); st = 4.0; age = 0.0; }
    return;
  }
  float lift = uMode.y > 0.05 || uDummyP.w < 0.5 ? 1.0 : 0.0;
  if (st > 1.5) {   // landed on the dummy: crawls, sometimes takes off again
    vec3 n = dummyNormal(p);
    vec3 w = curl3(p * 1.7 + h.yzw * 9.0 + uTime * 0.12);
    v = (w - n * dot(w, n)) * 0.09;
    p += v * dt;
    p -= n * (dummySDF(p) - 0.008);
    float hop = hash12(vec2(float(idx), floor(uTime * 3.0)));
    if (lift > 0.5 || hop < 0.004 || dummySDF(p) > 0.1) { st = 1.0; v = n * (2.0 + 2.0 * h.z) + w * 0.5; }
    return;
  }
  // --- flying ---
  // each insect runs late along the river by its own delay, so the cloud pours out as a stream
  float Ti = uPathM.w - h2.z * uStream.x;
  float sPath = (Ti - uPathB.w) / uPathA.w;
  float env = smoothstep(0.78, 1.12, sPath) * uMode.x, dis = uMode.y;
  float cruise = uMove.x * mix(0.75, 1.25, h.y);
  vec3 acc = vec3(0.0);
  acc += boidAccel(p, v);

  // goal 1: a slot on a folding, precessing membrane. A murmuration is a sheet of birds: the sheet
  // turning edge-on (dark, dense) and face-on (thin) is what makes it read
  float t = uTime, r0 = sqrt(h3.x), th = h3.y * 6.2832;
  vec3 o = vec3(r0 * cos(th), (h3.z - 0.5) * 0.2, r0 * sin(th));
  o.y += 0.42 * sin(2.1 * o.x + 1.3 * t) + 0.3 * sin(1.7 * o.z - 0.9 * t + 1.7) + 0.3 * o.x * o.z * sin(0.7 * t);
  float ys = 0.5 * t, tilt = 0.55 * sin(0.42 * t) + 0.3;
  o.xz = mat2(cos(ys), -sin(ys), sin(ys), cos(ys)) * (o.xz * vec2(1.0 + 0.4 * sin(0.6 * t), 1.0 - 0.3 * sin(0.6 * t)));
  o.xy = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * o.xy;
  o += 0.22 * curl3(o * 0.3 + vec3(0.13, t * 0.04, 0.71));
  vec3 goal = uLeader.xyz + o * uLeader.w, lv = uLeaderV.xyz;
  if (sPath > 0.0) {   // in the river: a slot around the path point, carried at the path's speed
    float e = 0.02 / uPathA.w;
    vec3 P = pathAt(sPath);
    lv = (P - pathAt(sPath - e)) / 0.02;
    goal = P + randomInSphere(h3.xzw) * uStream.y * (0.6 + 0.4 * sin(sPath * 9.0 + h.z * 6.0));
  }
  vec3 dc = (goal - p) * 2.0;
  float dl = length(dc);
  if (dl > cruise * 1.7) dc *= cruise * 1.7 / dl;
  vec3 dCloud = dc + lv;
  // goal 2: a lumpy, breathing ball around the target, each insect on its own tilted orbit, a loose
  // halo of strays outside it
  vec3 rr = p - uTarget.xyz;
  vec3 rs = rr / vec3(1.0, 1.3, 1.0);
  float dist = max(length(rs), 1e-3);
  vec3 ax = normalize(vec3(h2.x - 0.5, 0.45 + h.w, h3.w - 0.5) * vec3(2.4, 1.0, 2.4));
  ax *= h3.z < 0.12 ? -1.0 : 1.0;   // a few fly against the stream
  float lump = noise3(rs / dist * 0.35 + vec3(t * 0.05, 0.0, 0.31)) - 0.5;
  bool stray = h2.x > 0.84;
  float shellR = uTarget.w * (1.0 + 0.1 * sin(t * 1.6 + h.x * 0.8)) * (1.0 + 1.6 * lump)
               * (stray ? mix(1.5, 2.6, h3.x) : mix(0.42, 1.15, pow(h3.x, 0.7)));
  vec3 tang = normalize(cross(ax, rr) + 1e-4);
  float vt = uMove.y * mix(0.6, 1.2, h.w) * (stray ? 0.7 : 1.0);
  vec3 dEnv = tang * vt + (rs / dist) * (shellR - dist) * 4.0;
  // centripetal feed-forward: hold the circle about the insect's own axis
  vec3 q = rr - ax * dot(rr, ax);
  float qr = max(length(q), 0.25);
  acc -= q / qr * (vt * vt / qr) * env * (1.0 - dis);
  // darting: sudden small turns, strongest in the ball
  acc += curl3(p * 2.2 + h.zxy * 13.0 + vec3(t * 1.3)) * uFlock.w * 7.0 * env;
  // landers make for the dummy's surface
  bool lander = h2.w < uMode.z && uDummyP.w > 0.5 && dis < 0.05;
  float dd = 1e3;
  if (lander) {
    dd = dummySDF(p);
    vec3 nn = dummyNormal(p);
    dEnv = mix(dEnv, -nn * clamp(dd * 4.0, 0.5, cruise) + tang * 0.6, smoothstep(1.4, 0.35, dd));
    if (dd < 0.025 && env > 0.9) { st = 2.0; v *= 0.05; return; }
  }
  // goal 3: dispersal, up and away from the target
  vec3 dOut = normalize(rr * vec3(1.0, 0.3, 1.0) + vec3(0.0, 0.7 + h.x, 0.0) + 1e-3) * cruise * 1.5;
  vec3 desired = mix(mix(dCloud, dEnv, env), dOut, dis);
  acc += uMove.z * mix(1.0, 2.3, env) * (desired - v);

  // turbulence: swarm-scale eddies and each insect's own erratic flight
  acc += curl3(p * 0.06 + vec3(0.0, uTime * 0.025, 0.0)) * uFlock.w * 3.0;
  acc += curl3(p * 0.85 + h.xyz * 7.0 + vec3(uTime * 0.37)) * uFlock.w * 4.5;
  // hold the cruise speed
  float sp = length(v);
  acc += (v / max(sp, 1e-3)) * (cruise - sp) * 1.5;
  // the world: floor, rim, pillars, dummies (not the landing target), other spells' forces
  float kill = 0.0;
  bool nearTarget = lander && dd < 1.0;
  float dw = nearTarget ? p.y : arenaSDF(p);
  if (dw < 0.7) acc += (nearTarget ? vec3(0.0, 1.0, 0.0) : arenaNormal(p)) * (0.7 - dw) * 28.0;
  acc += forceAccel(p, v, kill) * uClock.y;
  v += acc * dt;
  sp = length(v);
  if (sp > cruise * 2.3) v *= cruise * 2.3 / sp;
  p += v * dt;
  float d2 = nearTarget ? p.y - 0.02 : arenaSDF(p) - 0.02;
  if (d2 < 0.0) {
    vec3 nn = nearTarget ? vec3(0.0, 1.0, 0.0) : arenaNormal(p);
    p -= nn * d2;
    v -= nn * min(dot(v, nn), 0.0) * 1.3;
  }
  // some die as the swarm breaks up
  if (dis > 0.0 && h2.y < uMode.w && uClock.x > h2.z * 1.5) { st = 3.0; age = 0.0; v *= 0.5; }
}`;

// look: the lantern (bioluminescence), shared by the glow, the floor light and the bodies
export const PLAGUE_LOOK = /* glsl */`
uniform vec4 uLook;      // size, glow, fade (flyers), sync 0..1
uniform vec4 uTarget;
uniform vec3 uGlowA;     // lantern colour (linear) x intensity
uniform vec3 uGlowB;     // second hue
// 0..1: a firefly flash (40 ms rise, ~150 ms decay) over a dim glow, phase-locked by uLook.w
// into waves travelling through the swarm
float lantern(int idx, vec3 p, float st, float age) {
  vec4 h3 = hash41(float(idx) * 0.2718281 + 5.1);
  float ph = fract(h3.y + uTime * mix(0.55, 1.15, h3.x));
  float wave = fract(dot(p - uTarget.xyz, vec3(0.31, 0.62, 0.17)) * 0.55 - uTime * 0.8 + h3.w * 0.08);
  ph = mix(ph, wave, uLook.w * step(0.25, h3.z));
  float flash = smoothstep(0.0, 0.035, ph) * exp(-max(ph - 0.035, 0.0) * 13.0);
  float l = 0.018 + flash;
  if (st > 3.5) l *= 0.5 * exp(-age * 1.6);           // dead on the floor: the light goes out
  else if (st > 2.5) l *= exp(-age * 2.2);             // dying
  else l *= uLook.z;
  return l;
}
vec3 lanternColor(vec4 h) { return mix(uGlowA, uGlowB, h.w * h.w); }
bool swarmGlow(int idx, int copy, vec4 h, vec3 p, vec3 v, float st, float age, out vec3 head, out vec3 tail, out float size, out vec3 col) {
  float l = lantern(idx, p, st, age);
  float sp = length(v);
  vec3 fwd = sp > 0.02 ? v / sp : vec3(0.0, 1.0, 0.0);
  float L = 0.04 * uLook.x * mix(0.75, 1.25, h.z);
  head = p - fwd * L * 0.3;
  tail = head - v * (1.0 / 120.0) - fwd * L * 0.12;
  size = L * (0.2 + 0.12 * l);
  col = lanternColor(h) * l * uLook.y;
  return l > 1e-3;
}
vec3 swarmLight(int idx, vec4 h, vec3 p, vec3 v, float st, float age) {
  return lanternColor(h) * lantern(idx, p, st, age) * uLook.y;
}
`;

// bodies: full-res opaque pass with alpha-to-coverage (MSAA): crisp dark chitin silhouettes that
// depth-sort with everything, motion-blurred into streaks (coverage = blur), with blurred wing
// lobes that transmit the low sun (backlit swarms glow amber at their rims) and glint now and then
export const PLAGUE_BODY_VERT = (W) => /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 cameraPosition;
in vec3 position;
${COMMON_GLSL}
${NOISE_GLSL}
${WORLD_GLSL}
${LIGHTS_GLSL}
${SWARM_STATE_GLSL(W)}
${PLAGUE_LOOK}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uChitin;
uniform vec4 uBody;      // body alpha, wing alpha, glint, wing transmission
out vec2 vUv;
out vec3 vBody;
out vec3 vWing;
out vec4 vK;             // body alpha, wing alpha, stretched share, -
void main() {
  int idx = gl_InstanceID;
  ivec2 px = swarmTexel(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vK = vec4(0.0); vUv = vec2(0.0); vBody = vWing = vec3(0.0);
  float st = s1.w;
  if (st < 0.5 || st > 4.5) return;
  vec4 h = swarmHash(idx);
  vec3 p = s0.xyz, v = s1.xyz;
  float sp = length(v);
  vec3 fwd = sp > 0.02 ? v / sp : normalize(vec3(cos(h.y * 6.283), 0.0, sin(h.y * 6.283)));
  float L = 0.04 * uLook.x * mix(0.75, 1.25, h.z);
  float fade = st > 3.5 ? 1.0 - smoothstep(1.4, 2.5, s0.w) : st > 2.5 ? 1.0 : uLook.z;
  if (fade <= 0.0) return;
  vec3 blur = v * (1.0 / 120.0);   // 180-degree shutter at 60 Hz
  vec3 head = p + fwd * L * 0.5, tail = p - fwd * L * 0.5 - blur;
  vec3 headV = (viewMatrix * vec4(head, 1.0)).xyz, tailV = (viewMatrix * vec4(tail, 1.0)).xyz;
  float viewZ = max(-headV.z, 0.05);
  if (viewZ < 0.15) return;
  float pxW = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  bool wings = st < 1.5;
  float span = L * (wings ? 0.6 : 0.22);   // half-width: the wing blur, or a folded body
  float w = max(span, 0.8 * pxW), aa = span / w;
  vec2 axis = tailV.xy - headV.xy;
  float len = length(axis);
  vec2 dir = len > 1e-5 ? axis / len : vec2(1.0, 0.0), perp = vec2(-dir.y, dir.x);
  vec2 off = dir * (position.x < 0.0 ? -w : len + w) + perp * position.y * w;
  gl_Position = projectionMatrix * vec4(headV + vec3(off, 0.0), 1.0);
  vUv = vec2(position.x < 0.0 ? 0.0 : 1.0, position.y);
  // motion blur spreads the same coverage along the streak
  float streak = min(1.0, (L + 2.0 * w) / (len + 2.0 * w) * 1.2);
  vK.x = uBody.x * fade * aa * streak;
  vK.y = wings ? uBody.y * fade * aa * streak : 0.0;
  vK.z = len / (len + 2.0 * w);
  // lighting, isotropic (they're tiny): sky, a little sun, every spell light (the swarm's own glow)
  gLightNoShadow = true;
  vec3 V = normalize(cameraPosition - p);
  vec3 spell = spellLightDiffuse(p, vec3(0.0));
  vBody = uChitin * mix(0.7, 1.3, h.w) * (uAmbient * 1.6 + uSunColor * 0.3 + spell * 0.5);
  // wings: thin membranes, mostly transmission of the low sun (forward-peaked), sky and spell light
  float flap = sin(fract(h.x * 17.0 + uTime * mix(14.0, 19.0, h.y)) * 6.283) * 1.1;
  vec3 side = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
  vec3 wn = vec3(0.0, cos(flap), 0.0) + side * sin(flap);
  float glint = wings ? pow(abs(dot(wn, normalize(uSunDir + V))), 90.0) * uBody.z : 0.0;
  vWing = vec3(0.4, 0.34, 0.22) * (uSunColor * hgPhase(dot(uSunDir, -V), 0.75) * 12.566 * uBody.w + uAmbient * 0.2 + spell * 0.15)
        + uSunColor * glint;
}`;

export const PLAGUE_BODY_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
in vec3 vBody;
in vec3 vWing;
in vec4 vK;
out vec4 fragColor;
void main() {
  // x: 0 head cap .. 1 tail cap; y: across, in wing half-widths
  float x = vUv.x, ends = 1.0 - vK.z;
  float dx = x < ends * 0.5 ? (ends * 0.5 - x) / max(ends * 0.5, 1e-3) : x > 1.0 - ends * 0.5 ? (x - 1.0 + ends * 0.5) / max(ends * 0.5, 1e-3) : 0.0;
  float y = abs(vUv.y);
  // a slim body down the middle, blurred wing lobes either side of the thorax
  float body = exp(-(dx * dx * 2.0 + y * y * 22.0)) * vK.x;
  float wing = exp(-(dx * dx * 2.5 + pow(max(y - 0.4, 0.0), 2.0) * 10.0)) * smoothstep(0.1, 0.35, y) * (1.0 - x * 0.5) * vK.y;
  float a = clamp(body + wing, 0.0, 1.0);
  if (a < 0.04) discard;
  fragColor = vec4((vBody * body + vWing * wing) / a, a);
}`;
