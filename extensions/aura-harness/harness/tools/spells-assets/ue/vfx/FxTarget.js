import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { U, COMMON_GLSL, GROUND_GLSL } from './common.js';

// The half-res FX pass (PLAN 2.5 "FX target"): one MRT with one blend state for every soft
// translucent thing (media, volumes, glows, distortion), never sorted (weighted-blended OIT).
//  1. depth prepass: the FX depth buffer gets the FARTHEST full-res depth of each footprint, so
//     nothing in front of the background is rejected at silhouettes
//  2. the fx scene draws into (media, weight + distortion, emission)
//  3. composite at full res: nearest-depth upsample (a full-res pixel nearer than every FX tap
//     rejects FX, which kills halos at pillar edges), distortion with distortion-driven chromatic
//     aberration, the WBOIT resolve, emission, the void's negative shell, and debug views.
export const DEBUG_VIEWS = { off: 0, overdraw: 1, emission: 2, media: 3, distortion: 4, 'ground A': 5, 'ground B': 6, particles: 7 };

const PREPASS = /* glsl */`
precision highp float;
uniform highp sampler2D uSceneDepth;
uniform vec2 uRatio;   // full / fx resolution
uniform vec2 uResolution;
void main() {
  ivec2 b = ivec2(floor(floor(gl_FragCoord.xy) * uRatio));   // block origin, same as sceneViewZ
  ivec2 m = ivec2(uResolution) - 1;
  float d = texelFetch(uSceneDepth, min(b, m), 0).r;
  d = max(d, texelFetch(uSceneDepth, min(b + ivec2(1, 0), m), 0).r);
  d = max(d, texelFetch(uSceneDepth, min(b + ivec2(0, 1), m), 0).r);
  d = max(d, texelFetch(uSceneDepth, min(b + ivec2(1, 1), m), 0).r);
  gl_FragDepth = d;
}`;

const COMPOSITE = /* glsl */`
precision highp float;
precision highp sampler2D;
${COMMON_GLSL}
${GROUND_GLSL}
uniform sampler2D uScene;
uniform sampler2D uMedia;
uniform sampler2D uWeight;
uniform sampler2D uEmit;
uniform highp sampler2D uFxDepth;
uniform highp sampler2D uSceneDepth;
uniform highp sampler2D uPartState;
uniform vec4 uParams;    // smoke occludes glow, distortion scale, CA, -
uniform vec4 uInvert;    // centre uv, radius (uv, aspect-corrected), amount
in vec2 vUv;
out vec4 outColor;

void main() {
  float zf = linearDepth(texture(uSceneDepth, vUv).r);
  vec2 hp = vUv * uFxResolution - 0.5;
  ivec2 b = ivec2(floor(hp));
  ivec2 m = ivec2(uFxResolution) - 1;
  ivec2 t0 = clamp(b, ivec2(0), m), t1 = clamp(b + ivec2(1, 0), ivec2(0), m);
  ivec2 t2 = clamp(b + ivec2(0, 1), ivec2(0), m), t3 = clamp(b + ivec2(1, 1), ivec2(0), m);
  float z0 = linearDepth(texelFetch(uFxDepth, t0, 0).r), z1 = linearDepth(texelFetch(uFxDepth, t1, 0).r);
  float z2 = linearDepth(texelFetch(uFxDepth, t2, 0).r), z3 = linearDepth(texelFetch(uFxDepth, t3, 0).r);
  float tol = 0.04 * zf + 0.05;
  vec4 d4 = abs(vec4(z0, z1, z2, z3) - zf);
  vec4 med, wt, em;
  bool fx = true;
  if (max(max(d4.x, d4.y), max(d4.z, d4.w)) < tol) {
    med = texture(uMedia, vUv); wt = texture(uWeight, vUv); em = texture(uEmit, vUv);
  } else {
    // nearest-depth tap; if this pixel is in front of all of them, the FX there was drawn
    // against something farther (a silhouette), so drop it
    ivec2 t = t0; float best = d4.x;
    if (d4.y < best) { best = d4.y; t = t1; }
    if (d4.z < best) { best = d4.z; t = t2; }
    if (d4.w < best) { best = d4.w; t = t3; }
    if (zf < min(min(z0, z1), min(z2, z3)) - tol) fx = false;
    med = texelFetch(uMedia, t, 0); wt = texelFetch(uWeight, t, 0); em = texelFetch(uEmit, t, 0);
  }
  if (!fx) { med = vec4(0.0, 0.0, 0.0, 1.0); wt = vec4(0.0); em = vec4(0.0); }

  float rev = clamp(med.a, 0.0, 1.0);
  vec3 accum = med.rgb / max(wt.r, 1e-4);
  vec2 dist = wt.gb * uParams.y;
  vec2 suv = vUv + dist;
  vec3 scene;
  if (uParams.z > 0.0 && dot(dist, dist) > 1e-8) {
    vec2 ca = dist * uParams.z * 0.6;
    scene = vec3(texture(uScene, suv + ca).r, texture(uScene, suv).g, texture(uScene, suv - ca).b);
  } else scene = texture(uScene, suv).rgb;
  vec3 col = scene * rev + accum * (1.0 - rev) + em.rgb * mix(1.0, rev, uParams.x);

  // void collapse: a brief photographic-negative shell
  if (uInvert.w > 0.0) {
    vec2 q = (vUv - uInvert.xy) * vec2(uResolution.x / uResolution.y, 1.0);
    float r = length(q);
    float shell = smoothstep(uInvert.z, uInvert.z * 0.8, r) * uInvert.w;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(0.6, 0.5, 1.0) * max(1.2 - l, 0.0) * 0.6, shell);
  }

  if (uDebug > 0.5) {
    int v = int(uDebug + 0.5);
    if (v == 1) col = scene * 0.15 + vec3(1.0, 0.25, 0.05) * em.r * 25.0;     // overdraw: fxOut wrote a constant
    else if (v == 2) col = em.rgb;
    else if (v == 3) col = accum * (1.0 - rev);
    else if (v == 4) col = vec3(0.5 + dist * 40.0, 0.5);
    else if (v == 5) col = groundA(mix(uGroundRect.xy, uGroundRect.xy + uGroundRect.z, vUv)).rgb * vec3(1.0, 0.6, 1.0) + vec3(0.0, 0.0, groundA(mix(uGroundRect.xy, uGroundRect.xy + uGroundRect.z, vUv)).a);
    else if (v == 6) col = groundB(mix(uGroundRect.xy, uGroundRect.xy + uGroundRect.z, vUv)).rgb + groundB(mix(uGroundRect.xy, uGroundRect.xy + uGroundRect.z, vUv)).a * 0.5;
    else if (v == 7) { vec4 s = texture(uPartState, vUv); col = s.w < 1e8 ? fract(abs(s.xyz) * 0.1) : vec3(0.02); }
  }
  outColor = vec4(col, 1.0);
}`;

export class FxTarget {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      count: 3, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.comp = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false });
    this.ratio = new THREE.Vector2(2, 2);
    this.prepass = new FullscreenQuad(rawPass(PREPASS, { uSceneDepth: U.uSceneDepth, uRatio: { value: this.ratio }, uResolution: U.uResolution }, {
      depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth, colorWrite: false,
    }));
    this.params = { smokeOccludesGlow: 0.5, distortion: 1, ca: 0.35 };
    this.invert = new THREE.Vector4();
    this.composite = new FullscreenQuad(rawPass(COMPOSITE, {
      ...U, uScene: { value: null }, uMedia: { value: this.rt.textures[0] }, uWeight: { value: this.rt.textures[1] }, uEmit: { value: this.rt.textures[2] },
      uFxDepth: { value: this.rt.depthTexture }, uPartState: { value: null },
      uParams: { value: new THREE.Vector4() }, uInvert: { value: this.invert },
    }));
  }

  setSize(w, h, scale) {
    const fw = Math.max(1, Math.ceil(w * scale)), fh = Math.max(1, Math.ceil(h * scale));
    this.rt.setSize(fw, fh);
    this.comp.setSize(w, h);
    this.ratio.set(w / fw, h / fh);
    U.uFxResolution.value.set(fw, fh);
  }

  // sceneTex: resolved HDR (opaque + refract + lines); returns the composited HDR texture
  render(fxScene, camera, sceneTex, timer, partState = null) {
    const r = this.renderer;
    timer?.begin('fx');
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    this.prepass.render(r, this.rt);
    r.render(fxScene, camera);
    timer?.begin('fxComp');
    const u = this.composite.material.uniforms;
    u.uScene.value = sceneTex;
    u.uPartState.value = partState;
    u.uParams.value.set(this.params.smokeOccludesGlow, this.params.distortion, this.params.ca, 0);
    this.composite.render(r, this.comp);
    return this.comp.texture;
  }
}
