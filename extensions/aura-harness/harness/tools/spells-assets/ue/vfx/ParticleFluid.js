import * as THREE from 'three';
import { U, FX_BLENDING } from './common.js';
import { PAINT_BLENDING } from './GroundField.js';
import { Q } from '../engine/quality.js';
import {
  MAXD, MAX_REC, PW, FULL_VERT, P2G_VERT, P2G_FRAG, MARK_FRAG, DIV_FRAG, JACOBI_FRAG, PROJECT_FRAG, ADVECT_FRAG, WHITE_FRAG,
  DEPTH_VERT, DEPTH_FRAG, THICK_FRAG, SMOOTH_FRAG, NORMAL_FRAG, COMPOSITE_VERT, COMPOSITE_FRAG, WHITE_VERT, BEAD_VERT, BEAD_FRAG, WHITE_SPRITE_FRAG,
  PAINT_VERT, PAINT_FRAG, FOAM_BAKE_FRAG,
} from './ParticleFluid.glsl.js';

// Shared GPU particle fluid (water, acid; Tsunami / rain later): FLIP in local box domains,
// drawn as a screen-space fluid surface with Ihmsen-style whitewater.
//
// Simulation (one step per frame, all on the GPU, nothing read back):
//  - particles: RGBA32F textures, 256 wide, Q.fluidParticles of them (low 8k, medium 16k,
//    high 32k, ultra 64k), one ring buffer for every domain: an emission overwrites the oldest
//    slots, so a full pool recycles old puddle water first. S0 pos/age, S1 vel/air, S2 life,
//    tag (domain + generation), grid density, floor contact
//  - grid: per domain a yaw-rotated box of cubic MAC cells, packed into a 2D atlas (z-slices
//    as tiles). Cell size from the box volume and the tier's cell budget (high ~130k cells,
//    ~0.13 m for a 300 m^3 box); particle spacing h / 2 (8 per cell)
//  - step: P2G (points, additive, trilinear over 3x3x3 texels via 3 instanced slices) ->
//    normalise + mark (arena SDF: floor, rim, capsule occluders = solid) -> divergence with
//    gravity and a density drift term -> Jacobi (warm-started) -> subtract gradient -> G2P
//    FLIP/PIC blend + RK2 advection, wind/vortex forces (FORCES_GLSL), SDF collision with a
//    midpoint check against tunnelling, emission and death in the same pass. Outside the grid
//    (but inside the life box) particles fly ballistic
//  - whitewater (Ihmsen et al. 2012): dead slots of a second pool sample random fluid
//    particles and spawn where they carry trapped air (aeration from FLIP/PIC disagreement,
//    impacts, speed); classified by the fluid density round them as spray, foam or bubbles
// Rendering (van der Laan, Green & Sainz 2009; Truong & Yuksel 2018):
//  - half res: velocity-stretched sphere sprites -> nearest linear depth (+ domain id) and
//    additive thickness (+ thickness x air), two separable narrow-range filter iterations,
//    view normals
//  - full res composite in fx.scenes.refract over the domains' screen rect: depth-tested
//    against the scene (writes gl_FragDepth), refraction + Beer-Lambert, Ultra Water's shading
//    (github.com/Humpalumps/Ultra-Water, MIT): in-scatter, Atlas-style SSS through thin sheets,
//    Lagarde Fresnel, sky reflection, GGX sun, aeration lit like UW's foam with its baked
//    foam texture, caustics on what the water lies on, spell lights
//  - whitewater sprites in the half-res FX pass (WBOIT); floor contact paints the ground field
//    through GroundField's particle paint (no splat budget used)
//
// API (main does not construct it: a spell does, once: fx.water ??= new ParticleFluid(fx),
// then fx.systems.push(fx.water); main calls update(dt, camera) every frame):
//   const h = fx.water.acquire({ size: [x, y, z] (m; x along yaw), position (floor centre of the
//     box), yaw (rad, local x = (cos, 0, sin)), preset: 'water' | 'acid', margin, life })
//     -> handle, or null when all MAXD domains are taken
//   h.position / h.yaw          move or turn it any frame (the grid is rebuilt every step)
//   h.jet(pos, dir, speed, radius, dt, air = 0, swirl = 0, spread = 0.03, radial = 0)
//                               this frame's slice of a continuous jet (call every frame); spread
//                               = random velocity (m/s), radial = divergence (m/s at the rim)
//   h.burst(pos, radius, vel, volume, spread = 0.3, radial = 0, air = 0)   a ball of water
//   h.hold(pos, radius, pull, swirl) / h.hold(null)   keep water gathered at pos (weightless)
//   h.launch(vel)               throw what is held (next step), then the hold lets go
//   look: h.tint + h.clarity (water preset derives absorption / scatter from them; call
//     h.tintWater() after changing), h.absorption, h.scatter (Vector3), h.roughness,
//     h.refraction, h.emission (Vector3, HDR), h.aeration (white churn 0..1+), h.foamTint, h.sss
//   behaviour: h.flip (FLIP ratio), h.wind (force response), h.drain (1/s, puddles soak away),
//     h.foam (whitewater amount), h.life (s), h.margin (m), h.paintA / h.paintB (ground field
//     increments per step: heat, char, wet, frost / crack, acid, corruption, glow)
//   h.spacing, h.h               particle spacing and cell size (m), read only
//   h.release()                 frees the domain; its particles and whitewater die at once
// Profiling: set fx.water.timer = app.timer to split the 'sim' timer into 'fluid sim' and 'ssf'
// (fx.water.fine = true: per pass).

const TIERS = {
  low: { n: 8192, cells: 45000, region: [256, 224], iters: 8 },
  medium: { n: 16384, cells: 80000, region: [384, 256], iters: 10 },
  high: { n: 32768, cells: 130000, region: [512, 320], iters: 12 },
  ultra: { n: 65536, cells: 200000, region: [512, 480], iters: 18 },
};
const PPC = 8;            // particles per cell at rest
const REC_W = 5;          // texels per emission record
const RADIUS_K = 1.3;     // render radius / spacing
const SHUTTER = 1 / 110;  // motion stretch (s)
const absorb = (x) => -Math.log(Math.max(x, 0.03)) * 0.4 + 0.02;   // as water.js: tint -> 1/m

const _v = new THREE.Vector3(), _c = new THREE.Color();
const QUAD = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];

// Ultra Water's baked foam texture (bakeTextures.js, MIT: R lace, G billow height, BA its gradient),
// baked once per page and shared by every water surface (fluid, streams, Tsunami), all tiers
let foamRT = null;
export function foamTexture(renderer) {
  if (foamRT) return foamRT.texture;
  // 1024: a breaking wave fills a close camera, and at 256 its lace lines magnify into texel blocks
  foamRT = new THREE.WebGLRenderTarget(1024, 1024, {
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    generateMipmaps: true, depthBuffer: false,
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const m = new THREE.Mesh(g, new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: FULL_VERT, fragmentShader: FOAM_BAKE_FRAG, uniforms: { uSize: { value: new THREE.Vector2(1024, 1024) } }, depthTest: false, depthWrite: false,
  }));
  m.frustumCulled = false;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(foamRT);
  renderer.render(m, new THREE.Camera());
  renderer.setRenderTarget(prev);
  g.dispose(); m.material.dispose();
  return foamRT.texture;
}

class FluidHandle {
  constructor(sys, index) {
    this.sys = sys; this.index = index; this.active = false; this.gen = 0;
    this.position = new THREE.Vector3(); this.yaw = 0; this.size = new THREE.Vector3(4, 4, 4);
    this.h = 0.1; this.spacing = 0.05; this.n = [8, 8, 8]; this.tpr = 1;
    this.tint = new THREE.Color(); this.clarity = 1;
    this.absorption = new THREE.Vector3(); this.scatter = new THREE.Vector3(); this.emission = new THREE.Vector3();
    this.foamTint = new THREE.Color(); this.paintA = new THREE.Vector4(); this.paintB = new THREE.Vector4();
    this.holdPos = new THREE.Vector3(); this.holdOn = false; this.holdR = 0.3; this.pull = 6; this.swirl = 4;
    this.launchVel = new THREE.Vector3(); this.launching = false; this.thrown = 9;
    this.acc = 0;
    this.reset('water');
  }

  reset(preset) {
    this.flip = 0.96; this.wind = 1; this.drain = 0; this.foam = 1; this.life = 9; this.margin = 1.5;
    this.roughness = 0.035; this.refraction = 0.6; this.aeration = 1; this.sss = 1;
    this.emission.set(0, 0, 0); this.paintA.set(0, 0, 0.035, 0); this.paintB.set(0, 0, 0, 0);
    this.holdOn = false; this.launching = false; this.acc = 0;
    if (preset === 'acid') {
      this.tint.set('#7dff3a'); this.clarity = 1;
      this.absorption.set(11, 2.5, 27); this.scatter.set(0.05, 0.1, 0.004);
      this.emission.set(0.06, 0.45, 0.02); this.foamTint.setRGB(0.7, 0.95, 0.4);
      this.paintA.set(0, 0, 0.01, 0); this.paintB.set(0, 0.03, 0, 0); this.roughness = 0.07;
    } else {
      this.tint.set('#2fa8ff'); this.clarity = 1; this.foamTint.setRGB(0.62, 0.78, 0.82);
      this.tintWater();
    }
  }

  // absorption / scatter from tint + clarity (the founding water's mapping)
  tintWater() {
    const t = this.tint;
    this.absorption.set(absorb(t.r), absorb(t.g), absorb(t.b)).multiplyScalar(1 / Math.max(this.clarity, 0.05));
    _c.copy(t).lerp(_c.setRGB(1, 1, 1), 0.5);
    this.scatter.set(_c.r, _c.g, _c.b).multiplyScalar(0.03 + 0.04 / Math.max(this.clarity, 0.2));
    return this;
  }

  jet(pos, dir, speed, radius, dt, air = 0, swirl = 0, spread = 0.03, radial = 0) {
    if (!this.active || dt <= 0) return;
    const s = this.spacing;
    this.acc += Math.PI * radius * radius * speed * dt / (s * s * s);
    const n = Math.floor(this.acc);
    if (n <= 0) return;
    this.acc -= n;
    this.sys.record(this, 0, n, pos, radius, dir, speed, speed * dt, spread, radial, air, swirl);
  }

  burst(pos, radius, vel, volume, spread = 0.3, radial = 0, air = 0) {
    if (!this.active) return;
    const s = this.spacing, n = Math.round(volume / (s * s * s));
    if (n <= 0) return;
    const sp = vel.length();
    _v.copy(vel);
    if (sp < 1e-6) _v.set(0, 1, 0);
    this.sys.record(this, 1, n, pos, radius, _v, sp, 0, spread, radial, air, 0);
  }

  hold(pos, radius = 0.3, pull = 6, swirl = 4) {
    this.holdOn = !!pos;
    if (pos) { this.holdPos.copy(pos); this.holdR = radius; this.pull = pull; this.swirl = swirl; }
  }

  // throws what is held with vel (+ its spread about the centre) next step, then lets go
  launch(vel) { this.launchVel.copy(vel); this.launching = true; }

  release() {
    if (!this.active) return;
    this.active = false; this.holdOn = false; this.launching = false;
    this.sys.released = true;
  }
}

export class ParticleFluid {
  constructor(fx) {
    this.fx = fx;
    const r = this.renderer = fx.renderer;
    const T = TIERS[Q.tier] ?? TIERS.high;
    this.N = Q.fluidParticles ?? T.n;
    this.PH = Math.ceil(this.N / PW);
    this.ND = Math.max(PW, this.N >> 1);
    this.WH = Math.ceil(this.ND / PW);
    this.cells = T.cells; this.region = T.region; this.iters = T.iters;
    this.AW = T.region[0]; this.AH = T.region[1] * MAXD;
    this.timer = null;
    this.released = false;
    this.cursor = 0;
    this.recCount = 0;
    this.emitted = 0;

    // --- shared uniforms ---
    const v4s = () => Array.from({ length: MAXD }, () => new THREE.Vector4());
    const su = this.su = {
      uDomO: { value: v4s() }, uDomN: { value: v4s().map((v) => v.set(1, 1, 1, 1)) }, uDomR: { value: v4s() },
      uDomS: { value: v4s() }, uDomF: { value: v4s() },
      uAtlas: { value: new THREE.Vector2(this.AW, this.AH) }, uRegionH: { value: T.region[1] },
      uS0: { value: null }, uS1: { value: null }, uS2: { value: null },
      uW0: { value: null }, uW1: { value: null }, uW2: { value: null },
      uVn: { value: null }, uDV: { value: null }, uD: { value: null },
      uSimDt: { value: 1 / 60 }, uGdt: { value: 9.81 / 60 },
    };

    // --- targets ---
    const mrt = (w, h, count, type, filter = THREE.NearestFilter, format = THREE.RGBAFormat) => new THREE.WebGLRenderTarget(w, h, {
      type, format, count, minFilter: filter, magFilter: filter, depthBuffer: false, generateMipmaps: false,
    });
    this.state = [mrt(PW, this.PH, 3, THREE.FloatType), mrt(PW, this.PH, 3, THREE.FloatType)];
    this.white = [mrt(PW, this.WH, 3, THREE.FloatType), mrt(PW, this.WH, 3, THREE.FloatType)];
    this.cur = 0; this.wcur = 0;
    const H16 = THREE.HalfFloatType, F32 = THREE.FloatType;
    this.acc = mrt(this.AW, this.AH, 2, H16);
    this.V = mrt(this.AW, this.AH, 1, H16);
    this.D = mrt(this.AW, this.AH, 1, H16, THREE.LinearFilter);
    this.P = [mrt(this.AW, this.AH, 1, F32, THREE.NearestFilter, THREE.RedFormat), mrt(this.AW, this.AH, 1, F32, THREE.NearestFilter, THREE.RedFormat)];
    this.pCur = 0;
    this.proj = mrt(this.AW, this.AH, 2, H16, THREE.LinearFilter);
    su.uVn.value = this.proj.textures[0]; su.uDV.value = this.proj.textures[1]; su.uD.value = this.D.texture;
    // screen-space fluid, half res (sized on first update)
    this.ssf = new THREE.Vector2(1, 1);
    this.depthRT = new THREE.WebGLRenderTarget(1, 1, { type: F32, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, generateMipmaps: false });
    this.thickRT = mrt(1, 1, 1, H16, THREE.LinearFilter, THREE.RGFormat);
    this.smooth = [mrt(1, 1, 1, F32, THREE.NearestFilter, THREE.RedFormat), mrt(1, 1, 1, F32, THREE.NearestFilter, THREE.RedFormat)];
    this.nrmRT = mrt(1, 1, 1, F32);
    this.ssfTargets = [this.depthRT, this.thickRT, ...this.smooth, this.nrmRT];
    this._rect = new Float64Array(5);

    // emission records
    this.emitData = new Float32Array(REC_W * MAX_REC * 4);
    this.emitTex = new THREE.DataTexture(this.emitData, REC_W, MAX_REC, THREE.RGBAFormat, THREE.FloatType);
    this.emitTex.magFilter = this.emitTex.minFilter = THREE.NearestFilter;
    this.spans = Array.from({ length: 4 }, () => new THREE.Vector2());
    this.firstStart = -1;

    // --- passes ---
    this.cam = new THREE.Camera();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.boundingSphere = new THREE.Sphere();
    const raw = (frag, uniforms, extra = {}) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FULL_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra,
    });
    const quad = (mat) => { const m = new THREE.Mesh(tri, mat); m.frustumCulled = false; return m; };
    this.markQ = quad(raw(MARK_FRAG, { ...U, ...su, uAccA: { value: this.acc.textures[0] }, uAccB: { value: this.acc.textures[1] }, uFluidThresh: { value: 0.3 } }));
    this.divQ = quad(raw(DIV_FRAG, { ...su, uV: { value: this.V.texture }, uAccA: { value: this.acc.textures[0] }, uPPC: { value: PPC } }));
    this.jacU = { uP: { value: null }, uDc: { value: this.D.texture }, uFirst: { value: 0 } };
    this.jacQ = quad(raw(JACOBI_FRAG, { ...su, ...this.jacU }));
    this.projU = { uV: { value: this.V.texture }, uP: { value: null } };
    this.projQ = quad(raw(PROJECT_FRAG, { ...su, ...this.projU }));
    this.holdU = { uHold: { value: v4s() }, uHoldB: { value: v4s() }, uLaunch: { value: v4s() } };
    this.advU = { uEmit: { value: this.emitTex }, uEmitCount: { value: 0 }, uSpan: { value: this.spans }, uSpanCount: { value: 0 } };
    this.advQ = quad(raw(ADVECT_FRAG, { ...U, ...su, ...this.holdU, ...this.advU }));
    this.whiteU = { uFluidN: { value: this.N }, uWhiteRate: { value: 7 } };
    this.whiteQ = quad(raw(WHITE_FRAG, { ...U, ...su, ...this.whiteU }));

    // P2G: N points x 3 slice instances
    const pg = new THREE.InstancedBufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.N), 1));
    pg.instanceCount = 3;
    pg.boundingSphere = new THREE.Sphere();
    this.p2g = new THREE.Points(pg, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: P2G_VERT, fragmentShader: P2G_FRAG, uniforms: su,
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    }));
    this.p2g.frustumCulled = false;

    // SSF sprites
    const sprites = (n) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(QUAD, 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.instanceCount = n;
      g.boundingSphere = new THREE.Sphere();
      return g;
    };
    const spriteU = { ...su, uShutter: { value: SHUTTER } };
    this.depthMesh = new THREE.Mesh(sprites(this.N), new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: DEPTH_VERT, fragmentShader: DEPTH_FRAG, uniforms: spriteU, depthTest: true, depthWrite: true,
    }));
    this.thickMesh = new THREE.Mesh(sprites(this.N), new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: DEPTH_VERT, fragmentShader: THICK_FRAG, uniforms: spriteU, depthTest: false, depthWrite: false,
      transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    }));
    for (const m of [this.depthMesh, this.thickMesh]) m.frustumCulled = false;
    this.smU = { uZ: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uPxScale: { value: 100 }, uWorldR: { value: 0.12 }, uRange: { value: 0.1 } };
    this.smQ = quad(raw(SMOOTH_FRAG, this.smU));
    this.nrmU = { uZ: { value: null }, uProj: { value: new THREE.Vector2(1, 1) } };
    this.nrmQ = quad(raw(NORMAL_FRAG, this.nrmU));

    // UW's foam texture
    const foamTex = foamTexture(r);

    // composite (refract pass, full res)
    const lk = () => ({ value: v4s() });
    this.look = { uLook0: lk(), uLook1: lk(), uLook2: lk(), uLook3: lk() };
    this.compU = {
      ...U, ...this.look,
      uRect: { value: new THREE.Vector4(-1, -1, 1, 1) }, uNZ: { value: this.nrmRT.texture }, uThick: { value: this.thickRT.texture },
      uDomTex: { value: this.depthRT.texture }, uSsf: { value: this.ssf }, uCamWorld: { value: new THREE.Matrix4() },
      uProj: { value: this.nrmU.uProj.value }, uFoamTex: { value: foamTex },
    };
    const cg = new THREE.PlaneGeometry(2, 2);
    this.composite = new THREE.Mesh(cg, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: COMPOSITE_VERT, fragmentShader: COMPOSITE_FRAG, uniforms: this.compU,
      transparent: true, depthTest: true, depthWrite: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    this.composite.frustumCulled = false;
    this.composite.visible = false;
    fx.scenes.refract.add(this.composite);

    // whitewater sprites (fx pass)
    this.whiteLook = new THREE.Vector4(1, 1, 0, 0);
    this.whiteMesh = new THREE.Mesh(sprites(this.ND), new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: WHITE_VERT, fragmentShader: WHITE_SPRITE_FRAG,
      uniforms: { ...U, ...su, uWhiteLook: { value: this.whiteLook }, uFoamTex: { value: foamTex } }, ...FX_BLENDING,
    }));
    this.whiteMesh.frustumCulled = false;
    this.whiteMesh.visible = false;
    fx.scenes.fx.add(this.whiteMesh);
    // the fluid's own lone droplets: lens beads (refract pass, full res, after the surface)
    this.dropMesh = new THREE.Mesh(sprites(this.N), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: BEAD_VERT, fragmentShader: BEAD_FRAG, uniforms: { ...U, ...su },
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    this.dropMesh.frustumCulled = false;
    this.dropMesh.visible = false;
    this.dropMesh.renderOrder = 3;
    fx.scenes.refract.add(this.dropMesh);

    // ground paint (GroundField particle paint)
    this.paintU = { uPaintA: { value: v4s() }, uPaintB: { value: v4s() } };
    const ground = fx.ground;
    if (ground?.paintScene) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.N), 1));
      g.boundingSphere = new THREE.Sphere();
      this.paint = new THREE.Points(g, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: PAINT_VERT, fragmentShader: PAINT_FRAG,
        uniforms: { ...su, ...this.paintU, uGroundA: U.uGroundA, uGroundB: U.uGroundB, uGroundRect: U.uGroundRect, uTexelsPerM: { value: ground.size / U.uGroundRect.value.z } },
        ...PAINT_BLENDING,
      }));
      this.paint.frustumCulled = false;
      this.paint.visible = false;
      ground.paintScene.add(this.paint);
    }

    this.handles = Array.from({ length: MAXD }, (_, i) => new FluidHandle(this, i));
    this.clear();
    this.warm();
  }

  // --- handles ---------------------------------------------------------------------------
  acquire({ size = [4, 4, 4], position = null, yaw = 0, preset = 'water', margin = 1.5, life = 9 } = {}) {
    let h = null;
    for (const x of this.handles) if (!x.active) { h = x; break; }
    if (!h) return null;
    h.reset(preset);
    h.active = true;
    h.gen = (h.gen + 1) % 1000;
    h.size.fromArray(size);
    if (position) h.position.copy(position);
    h.yaw = yaw; h.margin = margin; h.life = life;
    this.fit(h);
    // stale pressure from the region's last tenant would warm-start the solve wrong
    const r = this.renderer, prev = r.getRenderTarget();
    for (const p of this.P) { r.setRenderTarget(p); r.setClearColor(0x000000, 0); r.clear(true, false, false); }
    r.setRenderTarget(prev);
    return h;
  }

  // cell size so the box fits the tier's cell budget and the atlas region
  fit(h) {
    const [RW, RH] = this.region, s = h.size;
    let c = Math.cbrt(s.x * s.y * s.z / this.cells);
    for (let i = 0; i < 400; i++) {
      const nx = Math.max(4, Math.ceil(s.x / c)), ny = Math.max(4, Math.ceil(s.y / c) + 1), nz = Math.max(4, Math.ceil(s.z / c));
      const tpr = Math.floor(RW / (nx + 1));
      if (tpr >= 1 && Math.ceil((nz + 1) / tpr) * (ny + 1) <= RH) {
        h.h = c; h.n[0] = nx; h.n[1] = ny; h.n[2] = nz; h.tpr = tpr;
        h.spacing = c / Math.cbrt(PPC);
        return;
      }
      c *= 1.015;
    }
  }

  // an emission record (wraps the ring into two when needed); returns false over budget
  record(h, type, n, pos, radius, dir, speed, len, spread, radial, air, swirl) {
    const budget = Math.max(256, this.N >> 3);
    n = Math.min(n, budget - this.emitted, this.N);
    if (n <= 0) return false;
    this.emitted += n;
    const seed = this.fx.rand();   // deterministic with the cast seed
    let start = this.cursor;
    while (n > 0 && this.recCount < MAX_REC) {
      const take = Math.min(n, this.N - start), o = this.recCount * REC_W * 4, D = this.emitData;
      if (this.firstStart < 0) this.firstStart = start;
      D[o] = start; D[o + 1] = take; D[o + 2] = h.index + MAXD * h.gen; D[o + 3] = type;
      D[o + 4] = pos.x; D[o + 5] = pos.y; D[o + 6] = pos.z; D[o + 7] = radius;
      D[o + 8] = dir.x; D[o + 9] = dir.y; D[o + 10] = dir.z; D[o + 11] = speed;
      D[o + 12] = len; D[o + 13] = spread; D[o + 14] = radial; D[o + 15] = seed;
      D[o + 16] = h.life; D[o + 17] = air; D[o + 18] = swirl; D[o + 19] = 0;
      this.recCount++;
      start = (start + take) % this.N;
      n -= take;
    }
    this.cursor = start;
    return true;
  }

  // --- frame ------------------------------------------------------------------------------
  update(dt, camera) {
    let live = 0;
    for (const h of this.handles) if (h.active) live++;
    if (!live && !this.released) {
      this.composite.visible = this.whiteMesh.visible = this.dropMesh.visible = false;
      if (this.paint) this.paint.visible = false;
      this.recCount = 0; this.emitted = 0; this.firstStart = -1;
      return;
    }
    this.pack(dt);
    const r = this.renderer, prevRT = r.getRenderTarget();
    r.getClearColor(_c);
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    if (dt > 0 || this.released) { this.timer?.begin('fluid sim'); this.step(Math.min(Math.max(dt, 1e-4), 1 / 30)); }
    this.released = false;
    for (const h of this.handles) {
      h.thrown += dt;
      if (h.launching) { h.launching = false; h.holdOn = false; h.thrown = 0; }
    }
    this.recCount = 0; this.emitted = 0; this.firstStart = -1;
    if (live) { this.timer?.begin('ssf'); this.render(camera); }
    r.setRenderTarget(prevRT);
    r.setClearColor(_c, prevAlpha);
    this.composite.visible = this.whiteMesh.visible = this.dropMesh.visible = live > 0;
    if (this.paint) this.paint.visible = live > 0;
  }

  pack(dt) {
    const su = this.su, d = Math.max(dt, 1 / 240);
    let any = false;
    for (const h of this.handles) {
      const i = h.index;
      const O = su.uDomO.value[i], N = su.uDomN.value[i], R = su.uDomR.value[i], S = su.uDomS.value[i], F = su.uDomF.value[i];
      if (!h.active) { R.z = 0; continue; }
      any = true;
      const c = Math.cos(h.yaw), s = Math.sin(h.yaw), hh = h.h, [nx, ny, nz] = h.n;
      // cell (0,0,0) corner: the box centred on position, one cell row under the floor
      const lx = nx * hh / 2, ly = hh, lz = nz * hh / 2;
      O.set(h.position.x - (lx * c - lz * s), h.position.y - ly, h.position.z - (lx * s + lz * c), hh);
      N.set(nx, ny, nz, h.tpr);
      R.set(c, s, h.gen + 1, h.margin);
      const rr = h.spacing * RADIUS_K;
      S.set(h.spacing, rr, h.spacing ** 3 / (4.19 * rr ** 3), 0.2 * hh / d);
      F.set(h.flip, h.wind, h.drain, h.foam);
      const H = this.holdU;
      H.uHold.value[i].set(h.holdPos.x, h.holdPos.y, h.holdPos.z, h.holdOn ? h.pull : 0);
      H.uHoldB.value[i].set(h.holdR, h.swirl, 0, 0);
      H.uLaunch.value[i].set(h.launchVel.x, h.launchVel.y, h.launchVel.z, h.launching ? 1 : 0);
      const L = this.look;
      L.uLook0.value[i].set(h.absorption.x, h.absorption.y, h.absorption.z, h.roughness);
      L.uLook1.value[i].set(h.scatter.x, h.scatter.y, h.scatter.z, h.refraction);
      L.uLook2.value[i].set(h.emission.x, h.emission.y, h.emission.z, h.aeration);
      L.uLook3.value[i].set(h.foamTint.r, h.foamTint.g, h.foamTint.b, h.sss);
      this.paintU.uPaintA.value[i].copy(h.paintA);
      this.paintU.uPaintB.value[i].copy(h.paintB);
      // the ground field only accepts paint where it is stepped
      this.fx.ground?.touch?.(h.position.x, h.position.z, 0.5 * Math.hypot(h.size.x, h.size.z) + h.margin, 0.5);
    }
    return any;
  }

  // grid passes only over the live domains' atlas regions
  gridPass(mesh, target) {
    let d0 = MAXD, d1 = -1;
    for (const h of this.handles) if (h.active) { d0 = Math.min(d0, h.index); d1 = Math.max(d1, h.index); }
    if (d1 < 0) { d0 = 0; d1 = MAXD - 1; }
    const RH = this.region[1];
    target.viewport.set(0, d0 * RH, this.AW, (d1 - d0 + 1) * RH);
    this.renderer.setRenderTarget(target);
    this.renderer.render(mesh, this.cam);
    target.viewport.set(0, 0, this.AW, this.AH);
  }

  step(dt) {
    const r = this.renderer, su = this.su, cam = this.cam;
    su.uSimDt.value = dt;
    su.uGdt.value = 9.81 * dt;
    // emission spans: from the first record to the cursor (ring)
    const a = this.advU;
    let sc = 0;
    if (this.recCount) {
      const A = this.firstStart, B = this.cursor;
      if (B > A) this.spans[sc++].set(A, B);
      else { this.spans[sc++].set(A, this.N); if (B > 0) this.spans[sc++].set(0, B); }
      this.emitTex.needsUpdate = true;
    }
    a.uSpanCount.value = sc;
    a.uEmitCount.value = this.recCount;
    this.bind();
    const T = this.fine ? this.timer : null;
    // P2G
    T?.begin('fl p2g');
    r.setRenderTarget(this.acc);
    r.clear(true, false, false);
    r.render(this.p2g, cam);
    // grid
    T?.begin('fl mark');
    this.gridPass(this.markQ, this.V);
    this.gridPass(this.divQ, this.D);
    T?.begin('fl jacobi');
    for (let i = 0; i < this.iters; i++) {
      this.jacU.uP.value = this.P[this.pCur].texture;
      this.jacU.uFirst.value = i === 0 ? 1 : 0;
      this.pCur ^= 1;
      this.gridPass(this.jacQ, this.P[this.pCur]);
    }
    this.projU.uP.value = this.P[this.pCur].texture;
    T?.begin('fl proj');
    this.gridPass(this.projQ, this.proj);
    T?.begin('fl advect');
    // particles: G2P + advect + emit, then whitewater
    this.cur ^= 1;
    r.setRenderTarget(this.state[this.cur]);
    r.render(this.advQ, cam);
    this.bind();
    T?.begin('fl white');
    this.wcur ^= 1;
    r.setRenderTarget(this.white[this.wcur]);
    r.render(this.whiteQ, cam);
    this.bind();
  }

  bind() {
    const su = this.su, s = this.state[this.cur].textures, w = this.white[this.wcur].textures;
    su.uS0.value = s[0]; su.uS1.value = s[1]; su.uS2.value = s[2];
    su.uW0.value = w[0]; su.uW1.value = w[1]; su.uW2.value = w[2];
  }

  resize() {
    const res = U.uResolution.value;
    const w = Math.max(1, Math.round(res.x * 0.5)), h = Math.max(1, Math.round(res.y * 0.5));
    if (w === this.ssf.x && h === this.ssf.y) return;
    this.ssf.set(w, h);
    for (const t of [this.depthRT, this.thickRT, this.nrmRT, ...this.smooth]) t.setSize(w, h);
  }

  render(camera) {
    const r = this.renderer;
    this.resize();
    camera.updateMatrixWorld();
    const P = camera.projectionMatrix.elements;
    this.nrmU.uProj.value.set(P[0], P[5]);
    // every half-res pass only over the live domains' screen rect (+ the filter's reach)
    const R = this.compU.uRect.value, w = this.ssf.x, hh = this.ssf.y;
    this.screenRect(camera, R);
    const x0 = Math.max(Math.floor((R.x * 0.5 + 0.5) * w) - 2, 0), y0 = Math.max(Math.floor((R.y * 0.5 + 0.5) * hh) - 2, 0);
    const x1 = Math.min(Math.ceil((R.z * 0.5 + 0.5) * w) + 2, w), y1 = Math.min(Math.ceil((R.w * 0.5 + 0.5) * hh) + 2, hh);
    const T = this.fine ? this.timer : null;
    for (const t of this.ssfTargets) {
      t.scissorTest = false;
      r.setRenderTarget(t);
      r.clear(true, t === this.depthRT, false);
      t.scissor.set(x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1));
      t.scissorTest = true;
    }
    // sprites: nearest depth (+ domain), then additive thickness
    T?.begin('ssf depth');
    r.setRenderTarget(this.depthRT);
    r.render(this.depthMesh, camera);
    T?.begin('ssf thick');
    r.setRenderTarget(this.thickRT);
    r.render(this.thickMesh, camera);
    // narrow-range filter, two separable iterations
    let rad = 0;
    for (const h of this.handles) if (h.active) rad = Math.max(rad, h.spacing * RADIUS_K);
    const s = this.smU;
    s.uPxScale.value = 0.5 * this.ssf.y * P[5];
    s.uWorldR.value = rad * 2.2;
    s.uRange.value = rad * 2.0;
    T?.begin('ssf smooth');
    let src = this.depthRT.texture;
    for (let i = 0; i < 4; i++) {
      s.uZ.value = src;
      s.uDir.value.set(i & 1 ? 0 : 1, i & 1 ? 1 : 0);
      r.setRenderTarget(this.smooth[i & 1]);
      r.render(this.smQ, this.cam);
      src = this.smooth[i & 1].texture;
    }
    T?.begin('ssf normal');
    this.nrmU.uZ.value = src;
    r.setRenderTarget(this.nrmRT);
    r.render(this.nrmQ, this.cam);
    for (const t of this.ssfTargets) t.scissorTest = false;
    this.compU.uCamWorld.value.copy(camera.matrixWorld);
  }

  // NDC rect of the live domains: the grid box (+ up to 1 m of what flew out of it) and a held or
  // just thrown ball
  screenRect(camera, out) {
    const B = this._rect;
    B[0] = B[1] = 1; B[2] = B[3] = -1; B[4] = 0;
    for (const h of this.handles) {
      if (!h.active) continue;
      const c = Math.cos(h.yaw), s = Math.sin(h.yaw), m = Math.min(h.margin, 1) + 0.3;
      const ex = h.n[0] * h.h / 2 + m, ez = h.n[2] * h.h / 2 + m, ey = h.n[1] * h.h + m;
      for (let k = 0; k < 8; k++) {
        const lx = k & 1 ? ex : -ex, lz = k & 2 ? ez : -ez, ly = k & 4 ? ey : -m;
        this.corner(camera, h.position.x + lx * c - lz * s, h.position.y + ly, h.position.z + lx * s + lz * c);
      }
      if (h.holdOn || h.thrown < 1.2) {
        const e = h.holdR * 4, p = h.holdPos;
        for (let k = 0; k < 8; k++) this.corner(camera, p.x + (k & 1 ? e : -e), p.y + (k & 4 ? e : -e), p.z + (k & 2 ? e : -e));
      }
    }
    if (B[4]) out.set(-1, -1, 1, 1);
    else out.set(Math.max(B[0] - 0.01, -1), Math.max(B[1] - 0.01, -1), Math.min(B[2] + 0.01, 1), Math.min(B[3] + 0.01, 1));
  }

  corner(camera, x, y, z) {
    const B = this._rect;
    _v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    if (_v.z > -camera.near * 1.5) { B[4] = 1; return; }
    _v.applyMatrix4(camera.projectionMatrix);
    B[0] = Math.min(B[0], _v.x); B[1] = Math.min(B[1], _v.y); B[2] = Math.max(B[2], _v.x); B[3] = Math.max(B[3], _v.y);
  }

  clear() {
    const r = this.renderer, prev = r.getRenderTarget();
    r.setClearColor(0x000000, 0);
    for (const t of [...this.state, ...this.white, ...this.P]) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setRenderTarget(prev);
    this.cursor = 0;
    this.bind();
  }

  // compile and first-draw every internal program at load (none may compile at cast time)
  warm() {
    const at = new THREE.Vector3(0, 0, -30), c = new THREE.Vector3(0, 0.5, -30);
    const h = this.acquire({ size: [2, 2, 2], position: at });
    h.burst(c, 0.3, at.set(0, 0, 0), 0.05);
    h.jet(c, at.set(0, 1, 0), 4, 0.1, 1 / 60);
    h.hold(c, 0.3);
    this.update(1 / 60, this.fx.camera);
    h.release();
    this.update(1 / 60, this.fx.camera);
    const r = this.renderer, g = this.fx.ground;
    if (this.paint && g?.paintTarget) {
      this.paint.visible = true;
      r.setRenderTarget(g.paintTarget);
      r.render(this.paint, g.paintCamera);
      r.setRenderTarget(null);
      this.paint.visible = false;
    }
    this.clear();
  }
}
