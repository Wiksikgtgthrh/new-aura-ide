import * as THREE from 'three';
import { U, ARENA, COMMON_GLSL, NOISE_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING } from '../../vfx/common.js';

// Portal (void hero). Two linked portals: A opens between the caster and the target, facing the
// caster; B opens behind the target, on the camera's side, facing it. Each opens as a vertical slit
// of light that tears wide (the Rift's tear, grown up), then its membrane clears into a real view
// out of the other portal: right before a surface draws (onBeforeRender, as three's Reflector), the
// opaque and lines scenes are rendered from the camera carried through the portal pair, with an
// oblique near plane on the partner's face, scissored to the portal's screen box, into one shared
// half-res target. So through A you see the dummy from B's side, sparks and stream included. The
// surface writes depth, so whatever crosses its plane disappears into it.
// Release: a stream of motes pours from the orb into A and out of B into the target's back. The
// entry is a parallel sheet with life = time to the plane, so every streak dies exactly at A's
// surface; B re-emits the same flow from just behind its plane, delayed by the flight time, so the
// heads emerge from its surface (B hides the tails). Out of B the motes are real pool particles:
// they hit the dummy capsule, morph into splash sparks and paint corruption on the floor.
// World: an orbit force round each rim (sparks spin with it, loose particles spiral in and die at
// A's heart), an attractor into A, a push out of B, violet lights, floor void sigils, corruption.
// Collapse: the rims go unstable, each portal squeezes shut into a slit and pops.

const MAX = 2;   // concurrent casts, two portals each
const UP = new THREE.Vector3(0, 1, 0);

const RAW_FRAG_HEAD = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
`;

// shared by the surface and the glow ring: the rim wobbles (radius units)
const EDGE_GLSL = /* glsl */`
float portalEdge(float a, float seed, float instab) {
  float e = 1.0 + 0.022 * sin(a * 5.0 + uTime * 3.7 + seed) + 0.016 * sin(a * 11.0 - uTime * 6.1 + seed * 2.0)
          + 0.05 * (noise3(vec3(cos(a) * 0.3, sin(a) * 0.3, uTime * 0.22 + seed * 0.013)) - 0.5);
  return e + instab * (0.07 * sin(a * 3.0 + uTime * 23.0) + 0.05 * sin(a * 7.0 - uTime * 31.0));
}
// approximate signed distance (radius units) to the rim of the slit-to-disc ellipse; a = angle
float portalDist(vec2 q, float ox, float seed, float instab, out float a, out float re) {
  vec2 qe = vec2(q.x / ox, q.y);
  re = length(qe);
  a = atan(qe.y, qe.x);
  float g = length(vec2(q.x / (ox * ox), q.y)) / max(re, 1e-4);
  return (re - portalEdge(a, seed, instab)) / max(g, 1e-4);
}`;

const SURF_VERT = FX_VERT_HEAD + COMMON_GLSL + /* glsl */`
uniform vec4 uC;   // centre, radius (0 = hidden)
uniform vec4 uN;   // normal, opening (x scale: slit -> disc)
uniform vec4 uU;   // in-plane right axis
out vec3 vW;
out vec2 vQ;
void main() {
  vec3 n = uN.xyz, u = uU.xyz, v = cross(n, u);
  vQ = position.xy * vec2(max(uN.w, 0.03) * 1.15, 1.15);
  vW = uC.xyz + (u * vQ.x + v * vQ.y) * uC.w;
  gl_Position = uC.w > 0.0 ? projectionMatrix * viewMatrix * vec4(vW, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

// raw (like the rest of the project): a ShaderMaterial's program key also holds the renderer's light
// and clipping state, which the nested view render can leave different from the warm-up's
const SURF_FRAG = RAW_FRAG_HEAD + COMMON_GLSL + NOISE_GLSL + EDGE_GLSL + /* glsl */`
uniform vec4 uC; uniform vec4 uN; uniform vec4 uU;
uniform vec4 uLook;    // clarity, ripple, rim gain, seed
uniform vec4 uLook2;   // swirl (distortion), view twist, -, instability
uniform vec3 uRim;
uniform sampler2D uView;   // the scene seen out of the partner, rendered just before this draw
in vec3 vW;
in vec2 vQ;
out vec4 fragColor;

void main() {
  float ox = max(uN.w, 0.03), a, re;
  float d = portalDist(vQ, ox, uLook.w, uLook2.w, a, re);
  if (d > 0.0) discard;
  float e = -d, E = re - d;

  // the membrane: a dark spiral nebula with a few stars, there while the portal opens and closes
  float rn = clamp(re / max(E, 1e-3), 0.0, 1.0);
  float sw = a + 2.2 / (rn + 0.3) - uTime * 1.1;
  float neb = fbm3(vec3(cos(sw) * rn * 0.45, sin(sw) * rn * 0.45, uTime * 0.06 + uLook.w * 0.01));
  vec3 col = uRim * (0.05 * pow(neb, 2.2) + 0.12 * pow(neb, 6.0)) + vec3(0.002, 0.0, 0.004);
  col += vec3(0.8, 0.85, 1.0) * step(0.993, hash12(floor(vQ * 70.0) + uLook.w)) * (0.4 + 0.4 * sin(uTime * 4.0 + vQ.x * 30.0));

  // the view: clears from the centre outwards with clarity. Space twists towards the rim and rings
  // ripple out from the stream's entry point: sample where the displaced surface point projects
  float reveal = smoothstep(0.0, 0.35, uLook.x * 1.35 - rn);
  if (reveal > 0.0) {
    vec3 n = uN.xyz, u = uU.xyz, v = cross(n, u);
    float tw = uLook2.y * rn * rn * rn, c = cos(tw), s = sin(tw);
    vec2 q = mat2(c, s, -s, c) * vQ;
    float rl = length(q);
    q += q / max(rl, 1e-3) * (uLook.y * 0.022 * sin(rl * 24.0 - uTime * 13.0) * exp(-rl * 2.2));
    vec4 cl = projectionMatrix * viewMatrix * vec4(uC.xyz + (u * q.x + v * q.y) * uC.w, 1.0);
    vec3 view = texture(uView, cl.xy / cl.w * 0.5 + 0.5).rgb;
    col = mix(col, view, reveal);
  }
  // rim: darkens to violet-black, then the white-hot inner edge
  float em = e * uC.w;   // metres inside the rim
  col = mix(uRim * 0.01, col, smoothstep(0.02, 0.16, em));
  float crackle = 0.55 + 0.9 * noise3(vec3(a * 0.5, uTime * 1.4, uLook.w * 0.02));
  col += (uRim * (exp(-em / 0.12) * 1.2) + mix(uRim, vec3(1.0), 0.6) * exp(-em / 0.022) * 5.0) * crackle * uLook.z;
  fragColor = vec4(col, 1.0);
}`;

// outer glow, plasma filaments and the swirl distortion, half-res FX pass
const RING_VERT = FX_VERT_HEAD + /* glsl */`
uniform vec4 uC; uniform vec4 uN; uniform vec4 uU;
out vec2 vQ;
out float vViewZ;
out vec2 vJu;
out vec2 vJv;
void main() {
  vec3 n = uN.xyz, u = uU.xyz, v = cross(n, u);
  float R = uC.w;
  vQ = position.xy * vec2(max(uN.w, 0.03) * 1.1 + 0.6, 1.75);
  vec3 w = uC.xyz + (u * vQ.x + v * vQ.y) * R;
  w += normalize(cameraPosition - uC.xyz) * 0.05;   // in front of the opaque surface
  vec4 cv = viewMatrix * vec4(w, 1.0);
  vViewZ = -cv.z;
  gl_Position = R > 0.0 ? projectionMatrix * cv : vec4(2.0, 2.0, 2.0, 1.0);
  mat4 vp = projectionMatrix * viewMatrix;
  vec4 c0 = vp * vec4(uC.xyz, 1.0), cu = vp * vec4(uC.xyz + u * 0.1, 1.0), cw = vp * vec4(uC.xyz + v * 0.1, 1.0);
  vJu = (cu.xy / cu.w - c0.xy / c0.w) * 5.0;   // screen uv per metre along u, v
  vJv = (cw.xy / cw.w - c0.xy / c0.w) * 5.0;
}`;

const RING_FRAG = FX_FRAG_HEAD + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + EDGE_GLSL + /* glsl */`
uniform vec4 uC; uniform vec4 uN;
uniform vec4 uLook; uniform vec4 uLook2;
uniform vec3 uRim;
in vec2 vQ;
in float vViewZ;
in vec2 vJu;
in vec2 vJv;
void main() {
  float ox = max(uN.w, 0.03), a, re;
  float dm = portalDist(vQ, ox, uLook.w, uLook2.w, a, re) * uC.w;   // metres, > 0 outside
  float ad = abs(dm), out_ = step(0.0, dm);
  float fil = noise3(vec3(cos(a) * 0.4 + uTime * 0.03, sin(a) * 0.4, dm * 0.5 - uTime * 0.5 + uLook.w * 0.01));
  fil = pow(clamp(fil * 1.7 - 0.45, 0.0, 1.0), 3.0);
  vec3 e = uRim * uLook.z * (exp(-ad / 0.035) * 2.2 + out_ * (exp(-dm / 0.16) * 0.7 + fil * exp(-dm / 0.25) * 4.0));
  // space dragged round the rim
  vec2 qe = vec2(vQ.x / ox, vQ.y), tg = vec2(-qe.y, qe.x) / max(re, 1e-3);
  float amt = uLook2.x * exp(-ad / 0.35) * smoothstep(-0.25, 0.0, dm) * uC.w;
  vec2 dist = (vJu * tg.x + vJv * tg.y) * amt;
  float s = softFade(vViewZ, 0.15);
  fxOut(vec3(0.0), 0.0, e * s, dist * s, vViewZ);
}`;

// module scratch (nothing allocated per frame)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _h = new THREE.Vector3(), _sd = new THREE.Vector3(), _t = new THREE.Vector3();
const _col = new THREE.Color(), _s2 = new THREE.Vector2(), _M = new THREE.Matrix4(), _F = new THREE.Matrix4();
const _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _q4 = new THREE.Vector4();
const FLIP = new THREE.Matrix4().makeScale(-1, 1, -1);   // half a turn about the portal's up axis
const SPLAT = { x: 0, z: 0, radius: 1, corruption: 0, glow: 0, pattern: 'noise', seed: 0, width: 0 };
const SHOCK = { pos: new THREE.Vector3(), radius0: 0.2, radius1: 3, duration: 0.5, thickness: 0.6, distortion: 0.08, intensity: 0, ground: false, color: null };
const SIGIL = { pos: new THREE.Vector3(), radius: 1, style: 'void', intensity: 0, reveal: 0, seed: 0, color: null };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const win = (x, Ti) => smooth(0, 0.12, x) * (1 - smooth(Ti - 0.5, Ti - 0.3, x));   // the stream window
const backOut = (x) => { x = clamp01(x) - 1; return 1 + 2.4 * x * x * x + 1.4 * x * x; };

export default {
  id: 'portal', name: 'Portal', element: 'void', order: 10, hue: '#8a3dff',
  shape: 'area', radius: 0.35,
  params: { size: 1, reach: 1, speed: 16, stream: 1, sparks: 1, clarity: 1, swirl: 1, ripple: 1, knockback: 1, corruption: 1, rim: '#9a4dff', core: '#efe4ff' },
  ranges: { size: [0.5, 1.6, 0.01], reach: [0.6, 1.8, 0.01], speed: [6, 30, 0.1], stream: [0, 3, 0.01], sparks: [0, 3, 0.01], clarity: [0, 1, 0.01], swirl: [0, 3, 0.01], ripple: [0, 3, 0.01], knockback: [0, 3, 0.01], corruption: [0, 3, 0.01] },
  presets: {
    'event horizon': { rim: '#5a8cff', core: '#e4f0ff', ripple: 2.2, swirl: 0.6, sparks: 0.4 },
    'ember ring': { rim: '#ff7a1a', core: '#fff0d8', sparks: 2.2, swirl: 1.4, corruption: 0.3 },
    abyss: { rim: '#ff2a60', core: '#ffd6e0', clarity: 0.55, swirl: 2, corruption: 2, stream: 1.6 },
  },
  timing: { charge: 1.2, impact: 2.4, linger: 2.0 },
  kinds: {
    // the entering sheet: no forces, no collisions, life = flight time to A's plane
    stream: { style: 'glow', drag: 0, gravity: 0, forceResponse: 0, life: [1, 1], size: [0.026, 0.022], stretch: 0.03, emissive: 3.2, color: ['#f1e9ff', '#a670ff'], alpha: [1, 1], fadeIn: 0.03, fadeOut: 0.001 },
    // out of B: real particles, they splash on what they hit
    jet: { style: 'glow', drag: 0.4, gravity: 2, forceResponse: 0, restitution: 0.25, friction: 0.5, life: [0.45, 0.8], size: [0.026, 0.01], stretch: 0.03, emissive: 5, color: ['#f1e9ff', '#7b2dff'], alpha: [1, 0], fadeIn: 0.001, fadeOut: 0.35, morph: 'portal.splash' },
    splash: { style: 'glow', drag: 1.3, gravity: 7, forceResponse: 0.5, restitution: 0.3, friction: 0.4, life: [0.25, 0.6], size: [0.03, 0.006], stretch: 0.03, emissive: 11, color: ['#ffffff', '#8a3dff'], alpha: [1, 0], paints: 'corruption', paintAmount: 0.05 },
    // rim sparks ride the portal's orbit force round the edge, then fall
    spark: { style: 'glow', drag: 0.35, gravity: 2.4, forceResponse: 1, restitution: 0.3, friction: 0.3, life: [0.45, 1.0], size: [0.022, 0.006], stretch: 0.045, emissive: 8, color: ['#f4ecff', '#8a3dff'], alpha: [1, 0], fadeIn: 0.02 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const streamEm = P.emitter('portal.stream', { shape: 'line', radius: 0.05 });
    const jetEm = P.emitter('portal.jet', { shape: 'line', radius: 0.05, spread: 0.7 });
    const sparkEm = P.emitter('portal.spark', { shape: 'line', radius: 0.03, spread: 0.5 });
    const splashEm = P.emitter('portal.splash', { shape: 'sphere', radius: 0.15, spread: 3, radial: 3 });
    const moteIn = P.emitter('void.mote', { shape: 'shell', radius: 2.2, spread: 0.3, radial: -1.6 });
    const moteOut = P.emitter('void.mote', { shape: 'cone', radius: 0.15, spread: 0.4, radial: 2.6, cone: 0.9 });
    const popEm = P.emitter('void.spark', { shape: 'shell', radius: 0.25, spread: 2, radial: 7 });
    const smokeEm = P.emitter('void.smoke', { shape: 'sphere', radius: 0.4, spread: 0.6, radial: 1.5 });

    const rim = new THREE.Color(), core = new THREE.Color();
    const quad = new THREE.PlaneGeometry(2, 2);
    const R = fx.renderer, VIEW_SCALE = fx.Q?.mobile ? 0.35 : 0.5;
    R.getDrawingBufferSize(_s2);
    // one target for every portal: each surface draws right after its own view is rendered
    const viewRT = new THREE.WebGLRenderTarget(Math.ceil(_s2.x * VIEW_SCALE), Math.ceil(_s2.y * VIEW_SCALE), { type: THREE.HalfFloatType, generateMipmaps: false });
    const uView = { value: viewRT.texture };
    const vcam = new THREE.PerspectiveCamera();
    vcam.matrixAutoUpdate = false; vcam.matrixWorldAutoUpdate = false;

    // four portals (two per cast); surface and ring share the portal's uniform objects
    const portals = Array.from({ length: MAX * 2 }, (_, i) => ({
      i, c: new THREE.Vector3(), n: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0),
      R: 0, ox: 0.03, clarity: 0, ripple: 0, gain: 0, instab: 0, seed: 0, light: null, sigil: null, orbit: null, partner: null, surf: null, ring: null, vis: false,
      su: { uC: { value: new THREE.Vector4() }, uN: { value: new THREE.Vector4() }, uU: { value: new THREE.Vector4() }, uLook: { value: new THREE.Vector4() }, uLook2: { value: new THREE.Vector4() }, uRim: { value: rim } },
    }));
    for (const p of portals) {
      p.partner = portals[p.i ^ 1];
      p.surf = new THREE.Mesh(quad, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: SURF_VERT, fragmentShader: SURF_FRAG, side: THREE.DoubleSide,
        uniforms: { ...U, ...p.su, uView },
      }));
      p.surf.onBeforeRender = (r, scene, camera) => renderView(p, camera);
      p.ring = new THREE.Mesh(quad, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: RING_VERT, fragmentShader: RING_FRAG, ...FX_BLENDING, side: THREE.DoubleSide,
        uniforms: { ...U, ...p.su },
      }));
      for (const m of [p.surf, p.ring]) { m.frustumCulled = false; m.visible = false; }
      fx.scenes.opaque.add(p.surf);
      fx.scenes.fx.add(p.ring);
    }

    // world matrix of a portal's frame (u, v, n, centre)
    function frame(q, out) {
      _b.crossVectors(q.n, q.u);
      return out.set(q.u.x, _b.x, q.n.x, q.c.x, q.u.y, _b.y, q.n.y, q.c.y, q.u.z, _b.z, q.n.z, q.c.z, 0, 0, 0, 1);
    }
    let inView = false;
    // the scene out of X's partner Y, as seen through X: the camera carried by Y * flip * X^-1, an
    // oblique near plane on Y's face (Lengyel), scissored to X's box on screen
    function renderView(X, camera) {
      if (inView || camera !== fx.camera || X.R <= 0.002 || X.clarity <= 0.001) return;
      const Y = X.partner;
      R.getDrawingBufferSize(_s2);
      const w = Math.ceil(_s2.x * VIEW_SCALE), h = Math.ceil(_s2.y * VIEW_SCALE);
      if (viewRT.width !== w || viewRT.height !== h) viewRT.setSize(w, h);
      _M.copy(frame(Y, _F)).multiply(FLIP).multiply(frame(X, _F).invert());
      vcam.matrixWorld.multiplyMatrices(_M, camera.matrixWorld);
      vcam.matrixWorldInverse.copy(vcam.matrixWorld).invert();
      vcam.projectionMatrix.copy(camera.projectionMatrix);
      _a.setFromMatrixPosition(vcam.matrixWorld).sub(Y.c);
      _plane.setFromNormalAndCoplanarPoint(_b.copy(Y.n).multiplyScalar(_a.dot(Y.n) < 0 ? 1 : -1), Y.c).applyMatrix4(vcam.matrixWorldInverse);
      const pe = vcam.projectionMatrix.elements;
      _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
      _q4.set((Math.sign(_clip.x) + pe[8]) / pe[0], (Math.sign(_clip.y) + pe[9]) / pe[5], -1, (1 + pe[10]) / pe[14]);
      _clip.multiplyScalar(2 / _clip.dot(_q4));
      pe[2] = _clip.x; pe[6] = _clip.y; pe[10] = _clip.z + 1; pe[14] = _clip.w;
      vcam.projectionMatrixInverse.copy(vcam.projectionMatrix).invert();
      // X's screen box (with room for the twist and ripple)
      let x0 = 1, y0 = 1, x1 = -1, y1 = -1;
      _b.crossVectors(X.n, X.u);
      for (let k = 0; k < 4; k++) {
        _a.copy(X.c).addScaledVector(X.u, (k & 1 ? 1.25 : -1.25) * X.R).addScaledVector(_b, (k & 2 ? 1.25 : -1.25) * X.R).project(camera);
        if (_a.z > 1) { x0 = y0 = -1; x1 = y1 = 1; break; }
        x0 = Math.min(x0, _a.x); x1 = Math.max(x1, _a.x); y0 = Math.min(y0, _a.y); y1 = Math.max(y1, _a.y);
      }
      const px0 = Math.max(0, Math.floor((x0 * 0.5 + 0.5) * w)), py0 = Math.max(0, Math.floor((y0 * 0.5 + 0.5) * h));
      const px1 = Math.min(w, Math.ceil((x1 * 0.5 + 0.5) * w)), py1 = Math.min(h, Math.ceil((y1 * 0.5 + 0.5) * h));
      if (px1 <= px0 || py1 <= py0) return;
      viewRT.scissor.set(px0, py0, px1 - px0, py1 - py0);
      viewRT.scissorTest = true;
      inView = true;
      for (const q of portals) { q.vis = q.surf.visible; q.surf.visible = false; }
      const prev = R.getRenderTarget(), auto = R.autoClear, ca = R.getClearAlpha();
      R.getClearColor(_col);
      R.autoClear = false;
      R.setRenderTarget(viewRT);
      R.setClearColor(0x000000, 1);
      R.clear(true, true, false);
      R.render(fx.scenes.opaque, vcam);
      R.render(fx.scenes.lines, vcam);
      R.setRenderTarget(prev);
      R.setClearColor(_col, ca);
      R.autoClear = auto;
      for (const q of portals) q.surf.visible = q.vis;
      inView = false;
    }
    const slots = Array.from({ length: MAX }, (_, k) => ({ busy: false, A: portals[k * 2], B: portals[k * 2 + 1], AB: [portals[k * 2], portals[k * 2 + 1]] }));
    const takeSlot = () => { for (const s of slots) if (!s.busy) { s.busy = true; return s; } return null; };

    // kind colours follow the rim / core params (texels, no recompile)
    const KC = { stream: { color: [new THREE.Color(), new THREE.Color()] }, jet: { color: [new THREE.Color(), new THREE.Color()] }, splash: { color: [new THREE.Color(), new THREE.Color()] }, spark: { color: [new THREE.Color(), new THREE.Color()] } };
    let lastRim = '', lastCore = '';
    function retint() {
      const p = S.params;
      if (p.rim === lastRim && p.core === lastCore) return;
      lastRim = p.rim; lastCore = p.core;
      rim.set(p.rim); core.set(p.core);
      KC.stream.color[0].copy(core); KC.stream.color[1].copy(core).lerp(rim, 0.8);
      KC.jet.color[0].copy(core); KC.jet.color[1].copy(rim);
      KC.splash.color[0].copy(core).lerp(_col.setRGB(1, 1, 1), 0.5); KC.splash.color[1].copy(rim);
      KC.spark.color[0].copy(core); KC.spark.color[1].copy(rim);
      for (const k in KC) P.setKind(`portal.${k}`, KC[k]);
    }
    retint();

    function splat(x, z, radius, amount, pattern, seed, width = 0) {
      SPLAT.x = x; SPLAT.z = z; SPLAT.radius = radius; SPLAT.corruption = amount; SPLAT.glow = 0; SPLAT.pattern = pattern; SPLAT.seed = seed % 100; SPLAT.width = width;
      fx.ground.splat(SPLAT);
    }
    function shock(pos, r1, dist) {
      SHOCK.pos.copy(pos); SHOCK.radius0 = 0.15; SHOCK.radius1 = r1; SHOCK.duration = 0.45; SHOCK.thickness = 0.5; SHOCK.distortion = dist; SHOCK.ground = false;
      fx.shocks?.spawn(SHOCK);
    }

    // A between the caster and the target facing the caster; B behind the target on the camera's
    // side, facing the target's torso
    function place(s, c, p) {
      const A = s.A, B = s.B, R0 = p.size;
      _h.subVectors(c.to, c.from).setY(0);
      if (_h.lengthSq() < 1e-4) _h.set(0, 0, -1);
      _h.normalize();
      _sd.crossVectors(_h, UP);
      const dist = Math.hypot(c.to.x - c.from.x, c.to.z - c.from.z);
      A.c.copy(c.from).addScaledVector(_h, Math.min(2.8, dist * 0.35)).setY(Math.max(c.from.y, R0 + 0.45));
      A.n.copy(_h).negate();
      const sg = Math.sign(_t.subVectors(fx.camera.position, c.to).dot(_sd)) || 1;
      B.c.copy(c.to).addScaledVector(_h, 2.8 * p.reach).addScaledVector(_sd, sg * 1.5 * p.reach).setY(R0 + 0.55);
      const rr = Math.hypot(B.c.x, B.c.z), lim = ARENA.radius - 1.5 - R0;
      if (rr > lim) { B.c.x *= lim / rr; B.c.z *= lim / rr; }
      _t.copy(c.to).setY(THREE.MathUtils.clamp(c.to.y, 0.9, 1.4));
      B.n.subVectors(_t, B.c).normalize();
      for (const q of s.AB) {
        q.u.crossVectors(UP, q.n).normalize();
        q.seed = (c.seed % 997) * 0.37 + q.i * 13.1;
      }
    }

    // per-portal look over the cast's global clock T (lag: B trails A a little)
    function animate(q, c, p, lag) {
      const T = c.age - lag, Tc = c.durations.charge, Te = Tc + c.durations.impact;
      const slit = smooth(0.15, 0.38, T), open = backOut((T - 0.4) / 0.55);
      const R0 = p.size;
      q.R = R0 * slit;
      q.ox = 0.03 + 0.97 * Math.max(0, open);
      q.clarity = p.clarity * smooth(0.75, 1.25, T);
      q.gain = slit * (1.9 - 0.9 * smooth(0.4, 0.9, T)) * (0.9 + 0.1 * Math.sin(c.age * 37 + q.i));
      q.ripple = 0; q.instab = 0;
      const rel = c.age - Tc - lag;   // the stream window
      if (rel > 0 && T < Te + 0.1) q.ripple = p.ripple * smooth(0, 0.2, rel) * (1 - smooth(c.durations.impact - 0.45, c.durations.impact, rel));
      const tl = T - Te;   // collapse
      if (tl > 0) {
        q.instab = smooth(0, 0.5, tl);
        q.clarity *= 1 - smooth(0.2, 0.55, tl);
        const close = smooth(0.5, 0.88, tl);
        q.ox = Math.max(0.03, q.ox * (1 - close));
        q.R *= 1 - 0.25 * close;
        q.gain *= 1 + 1.6 * q.instab + 2 * close;
        if (tl >= 0.9) q.R = 0;
      }
      return tl;
    }

    // a line of emission across portal q's face through centre o at angle f
    function comb(q, o, f, half, em) {
      _b.crossVectors(q.n, q.u);
      _a.copy(q.u).multiplyScalar(Math.cos(f) * half).addScaledVector(_b, Math.sin(f) * half);
      em.pos.copy(o).add(_a); em.p.copy(o).sub(_a);
    }

    function pop(q, c, p) {
      popEm.pos.copy(q.c); popEm.radial = 7 * p.size; popEm.burst(500 * p.sparks + 150);
      smokeEm.pos.copy(q.c); smokeEm.size = 0.6 * p.size; smokeEm.burst(14);
      shock(q.c, 3.2 * p.size, 0.07);
      splat(q.c.x, q.c.z, 1.4 * p.size, 1.6 * p.corruption, 'radial', c.seed + q.i);
      if (q.light) { q.light.intensity = 40; q.light.range = 9; }
    }

    return {
      onParam(k) { if (k === 'rim' || k === 'core') retint(); },

      phase(c, name) {
        const p = S.params, d = c.data;
        retint();
        if (name === 'charge') {
          d.s = takeSlot(); d.hit = fx.lights.acquire(); d.attr = fx.forces.acquire(); d.push = fx.forces.acquire();
          d.hitT = 0; d.splatT = 0; d.popped = 0; d.released = false;
          if (d.hit) { d.hit.range = 6; d.hit.intensity = 0; d.hit.color.copy(rim); }
          if (d.attr) { d.attr.type = 2; d.attr.p[0] = 0; d.attr.p[1] = 0.4; d.attr.p[2] = 0.2; d.attr.p[3] = 5; }
          if (d.push) { d.push.type = 5; d.push.p[0] = 0; d.push.p[1] = 1; d.push.p[2] = 4; d.push.p[3] = 0; }
          const s = d.s;
          if (!s) return;
          place(s, c, p);
          for (const q of s.AB) {
            q.R = 0;
            q.light = fx.lights.acquire();
            if (q.light) { q.light.range = 7.5; q.light.intensity = 0; q.light.shadow = true; q.light.color.copy(rim); }
            SIGIL.pos.set(q.c.x, 0.03, q.c.z); SIGIL.radius = 1.3 * p.size; SIGIL.seed = q.seed | 0; SIGIL.color = rim; SIGIL.intensity = 0; SIGIL.reveal = 0;
            q.sigil = fx.sigils.acquire(SIGIL);
            q.orbit = fx.forces.acquire();
            if (q.orbit) { q.orbit.type = 3; q.orbit.dir.copy(q.n).multiplyScalar(q === s.A ? 1 : -1); q.orbit.p[0] = 0; q.orbit.p[1] = 0.25; q.orbit.p[2] = 1.9 * p.size; q.orbit.p[3] = 0; }
          }
        } else if (name === 'release') {
          fx.arena.setFocus(rim, 0.3);
          fx.rig.shake(0.18, 9);
          fx.flash(0.08);
          const s = d.s;
          if (!s) return;
          for (const q of s.AB) {
            shock(q.c, 3 * p.size, 0.06);
            splat(q.c.x, q.c.z, 1.5 * p.size, 1.2 * p.corruption, 'ring', c.seed + q.i, 0.35);
            fx.impacts.add('corruption', _a.copy(q.c).setY(0.3), 1.8 * p.size, 0.7, 6, rim);
            popEm.pos.copy(q.c); popEm.radial = 4; popEm.burst(120 * p.sparks);
          }
        } else if (name === 'done') {
          d.hit?.release(); d.attr?.release(); d.push?.release();
          d.hit = d.attr = d.push = null;
          const s = d.s;
          if (s) {
            for (const q of s.AB) {
              q.light?.release(); q.sigil?.release(); q.orbit?.release();
              q.light = q.sigil = q.orbit = null; q.R = 0;
            }
            s.busy = false;
          }
          d.s = null;
          fx.arena.setFocus(_col.set(S.hue), 2.5);
        }
      },

      update(c, dt) {
        const p = S.params, d = c.data, s = d.s;
        if (!s) return;
        const A = s.A, B = s.B, Tc = c.durations.charge, Ti = c.durations.impact;
        const tlA = animate(A, c, p, 0), tlB = animate(B, c, p, 0.1);
        const v = p.speed, start = 2.8 * Math.min(1, A.c.distanceTo(c.from) / 2.8);   // entry plane distance from A
        const tau = start / v, rel = c.age - Tc;

        // orb: flares, then dims while the stream drains it
        if (c.phase === 'charge') fx.arena.setFocus(rim, 0.5 + 2.5 * smooth(0, 0.6, c.t));

        for (const q of s.AB) {
          const open = q.R > 0 ? smooth(0.3, 1, q.ox) * q.R / p.size : 0;
          if (q.light) { q.light.pos.copy(q.c).addScaledVector(q.n, 0.45); q.light.color.copy(rim); q.light.intensity = Math.max(q.light.intensity * Math.exp(-dt * 6), 10 * q.gain * (q.R > 0 ? 1 : 0)); }
          if (q.sigil) {
            q.sigil.reveal = smooth(0, 0.95, c.age);
            q.sigil.intensity = 2.4 * (1 - smooth(0.6, 1.8, c.age - Tc - Ti));
            q.sigil.rotation += dt * (q === A ? 0.4 : -0.4);
            if (q.sigil.intensity <= 0) { q.sigil.release(); q.sigil = null; }
          }
          if (q.orbit) { q.orbit.pos.copy(q.c); q.orbit.p[0] = 22 * q.R * open; q.orbit.p[3] = 1.4 * open; }
          // rim sparks: a chord of the rim per frame, flung along the spin
          if (open > 0.2 && p.sparks > 0) {
            const ang = fx.rand() * 6.2832, a2 = ang + 0.4, sp = (q === A ? 1 : -1);
            const rr = q.R * 1.02;
            sparkEm.pos.copy(q.c).addScaledVector(q.u, Math.cos(ang) * rr * q.ox).addScaledVector(_b.crossVectors(q.n, q.u), Math.sin(ang) * rr);
            sparkEm.p.copy(q.c).addScaledVector(q.u, Math.cos(a2) * rr * q.ox).addScaledVector(_b, Math.sin(a2) * rr);
            _t.subVectors(sparkEm.p, sparkEm.pos).normalize();
            sparkEm.vel.copy(_t).multiplyScalar(4.5 * sp).addScaledVector(_a.subVectors(sparkEm.pos, q.c).normalize(), 0.8);
            sparkEm.rate(700 * p.sparks * (0.4 + q.gain * 0.5 + q.instab * 1.5), dt);
          }
        }
        if (c.phase === 'charge') {
          // A inhales, B exhales: motes stream into A's heart, out of B's face
          const k = smooth(0.35, 1, c.t / Tc);
          moteIn.pos.copy(A.c); moteIn.radius = 2.2 * p.size; moteIn.rate(900 * k, dt);
          moteOut.pos.copy(B.c).addScaledVector(B.n, -0.1); moteOut.p.copy(B.n); moteOut.vel.copy(B.n).multiplyScalar(1.2); moteOut.rate(500 * k, dt);
        }

        // the stream: in through A (dies on its plane), out of B one flight time later
        const inRate = 4800 * p.stream * win(rel, Ti), outRate = 4800 * p.stream * win(rel - tau, Ti);
        // a twisting cross of two combs: B re-emits the comb that reached A, its angle mirrored
        // (x flips through the portal), so the helix runs on unbroken out of B
        if (inRate > 0 && A.R > 0) {
          _t.copy(A.c).addScaledVector(A.n, start);
          for (let j = 0; j < 2; j++) {
            comb(A, _t, 18 * rel + j * 1.5708, 0.24 * p.size, streamEm);
            streamEm.vel.copy(A.n).multiplyScalar(-v);
            streamEm.life = (start + 0.1) / v;
            streamEm.rate(inRate * 0.5, dt);
          }
        }
        if (outRate > 0 && B.R > 0) {
          _t.copy(B.c).addScaledVector(B.n, -0.08);
          for (let j = 0; j < 2; j++) {
            comb(B, _t, Math.PI - 18 * (rel - tau) - j * 1.5708, 0.24 * p.size, jetEm);
            jetEm.vel.copy(B.n).multiplyScalar(v);
            jetEm.rate(outRate * 0.5, dt);
          }
          // the hit: knock the target from behind, light it, corrupt it and the floor under it
          const k = outRate / (4800 * Math.max(p.stream, 1e-3));
          if (d.hit) { d.hit.pos.copy(c.to).addScaledVector(B.n, -0.5); d.hit.color.copy(rim); d.hit.intensity = 22 * k * (0.8 + 0.2 * Math.sin(c.age * 47)); }
          d.hitT -= dt;
          if (d.hitT <= 0) {
            d.hitT = 0.2;
            if (c.target >= 0) {
              const dm = fx.dummies[c.target];
              if (dm.pos.distanceTo(_a.copy(B.c).setY(0)) < 5) {
                dm.hit(_a.copy(B.n).setY(0).normalize(), 0.16 * p.knockback * k);
                dm.status.corrupt = Math.max(dm.status.corrupt, 0.9);
              }
            }
            splat(c.to.x, c.to.z, 0.9 * p.size, 0.9 * p.corruption * k, 'noise', c.seed + c.age * 31);
            splashEm.pos.copy(c.to).addScaledVector(B.n, -0.3); splashEm.vel.copy(B.n).multiplyScalar(-2); splashEm.burst(40 * p.stream * k);
          }
        } else if (d.hit) d.hit.intensity *= Math.exp(-dt * 8);
        if (!d.released && rel > Ti - 0.3 + tau && c.target >= 0) {
          // the last of the stream lands: one heavy shove
          d.released = true;
          const dm = fx.dummies[c.target];
          if (dm.pos.distanceTo(_a.copy(B.c).setY(0)) < 5) dm.hit(_a.copy(B.n).setY(0).normalize(), 0.7 * p.knockback);
          fx.impacts.add('corruption', _a.copy(c.to), 1.6 * p.size, 1, 8, rim);
          fx.rig.shake(0.22, 12);
        }

        // forces on loose particles: pulled into A, blown out of B, while open
        const oA = A.R > 0 ? smooth(0.3, 1, A.ox) : 0, oB = B.R > 0 ? smooth(0.3, 1, B.ox) : 0;
        if (d.attr) { d.attr.pos.copy(A.c); d.attr.p[0] = 9 * oA; }
        if (d.push) { d.push.pos.copy(B.c); d.push.dir.copy(B.n); d.push.p[0] = 7 * oB; d.push.p[1] = B.R; d.push.p[3] = 2 * oB; }

        // collapse pops
        if (tlA >= 0.9 && !(d.popped & 1)) { d.popped |= 1; pop(A, c, p); fx.flash(0.1); fx.rig.shake(0.3, 14); }
        if (tlB >= 0.9 && !(d.popped & 2)) { d.popped |= 2; pop(B, c, p); fx.rig.shake(0.25, 14); if (!fx.reduced) fx.rig.punch(1.5, 0.08); }
        if (c.phase === 'linger') fx.arena.setFocus(rim, 0.3 + 2.2 * smooth(0.8, 1.8, c.t));
      },

      tick() {
        const p = S.params;
        for (const q of portals) {
          const on = q.R > 0.002;
          q.surf.visible = q.ring.visible = on;
          if (!on) { q.su.uC.value.w = 0; continue; }
          q.su.uC.value.set(q.c.x, q.c.y, q.c.z, q.R);
          q.su.uN.value.set(q.n.x, q.n.y, q.n.z, q.ox);
          q.su.uU.value.set(q.u.x, q.u.y, q.u.z, 0);
          q.su.uLook.value.set(q.clarity, q.ripple, q.gain, q.seed);
          q.su.uLook2.value.set(0.05 * p.swirl * (0.6 + q.instab), 0.35 * p.swirl, 0, q.instab);
        }
      },
    };
  },
};
