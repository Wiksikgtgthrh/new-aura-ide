import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { U, FX_BLENDING } from './common.js';
import { Q } from '../engine/quality.js';
import * as BASE from './FluidVolume.glsl.js';

// Shader revisions over the base sources, applied at load. A stale anchor throws, so a change to the
// base can never silently drop one of these.
function patch(src, from, to) {
  if (!src.includes(from)) throw new Error(`FluidVolume: shader anchor not found: ${from.slice(0, 60)}`);
  return src.replace(from, () => to);
}
const edit = (src, ...pairs) => pairs.reduce((out, [from, to]) => patch(out, from, to), src);

// sim: resolved turbulence (a curl-noise force on hot gas), soot that radiates its heat away so sooty
// gas chills into dark lanes, and soot that thins by erosion instead of fading as a whole
const REACT = edit(BASE.REACT,
  ['uniform vec4 uFlow;    // external force coupling, damping 1/s, -, -',
    'uniform vec4 uFlow;    // external force coupling, damping 1/s, -, -\nuniform vec4 uTurb;    // turbulence m/s2, turbulence frequency tiles/m, soot erosion units/s, soot radiative cooling'],
  ['th /= pow(1.0 + 3.0 * uDecay.y * dt * th * th * th, 1.0 / 3.0);',
    'th /= pow(1.0 + 3.0 * uDecay.y * dt * th * th * th * (1.0 + uTurb.w * soot), 1.0 / 3.0);'],
  ['soot *= exp(-uDecay.z * dt);',
    'soot = max(soot * exp(-uDecay.z * dt) - uTurb.z * dt, 0.0);'],
  ['  // the shared force field (wind, vortices, shocks...)',
    '  if (uTurb.x > 0.0) acc += curl3(pw * uTurb.y + vec3(0.0, -uTime * 0.6 * uTurb.y, 0.0)) * (uTurb.x * min(th, 1.0));\n  // the shared force field (wind, vortices, shocks...)'],
);

// render: everything from the sampler down. Three changes from the base:
//  - the march. The base stretched a whole number of steps over each ray, so the step count jumped
//    along contours of ray length (stripes). Now the spacing is one constant per domain on a lattice
//    anchored at the ray's entry, and every decision that could move the lattice is made harmless:
//    an empty-space stride that lands in gas steps back onto the lattice (the occupancy grid is
//    axis-aligned, so stride landings differing per pixel showed as vertical stripes, worst on the
//    coarse Low grid), and an optically thick slab is refined in place through its midpoint, blended
//    in continuously (the old halving shifted the rest of the ray by half a step: rings). Every
//    result is a continuous function of the pixel, so no per-pixel jitter is needed (it showed as a
//    dot grid at half res).
//  - near fade: density ramps in over uMarch2.w^-1 metres from the camera, so a camera inside a cloud
//    sees wisps and depth instead of a flat wall.
//  - the detail. With detail on (uDetail.y > 0), a Worley cell lookup erodes soot and chills the gas
//    along the cell creases: cauliflower silhouettes and mottled burning surfaces at any grid size.
//    The curl displacement is one octave, band-limited to the march step by the JS (a finer octave
//    only aliased into hair).
const RENDER_BODY = /* glsl */`
uniform vec4 uDetail;    // soot erosion (units), cell pattern frequency (tiles/m, 0 = off), heat chill 0..1, largest empty-space stride
uniform vec3 uDetailC;   // pattern centre: it rides the gas
float gSunPh;
float gMs;     // multiple-scattering weight from the albedo
vec3 gFire;   // fire-light colour (blackbody at a typical flame-edge temperature) x gain
vec3 gKc;     // per-channel extinction scale of the light on its way in (coloured gas)
// per metre: extinction, in-scattered radiance (soot only), emitted radiance
// returns false in empty space (nothing within ~3 voxels)
bool sampleAt(vec3 pw, out float sg, out vec3 sc, out vec3 em) {
  sg = 0.0; sc = vec3(0.0); em = vec3(0.0);
  vec3 p = (pw - uOrigin) / uH;
  vec4 l0 = gridSample(uL0, CG(), p * 0.5);
  if (l0.b <= 0.0) return false;
  // sub-grid detail (in the spirit of wavelet turbulence): displace the lookup with band-limited
  // curl noise drifting up with the gas, strongest where the resolved flow is turbulent
  vec3 n = curl3(pw * uMarch.w + vec3(0.0, -uTime * 0.28, 0.0));
  vec4 s = gridSample(uS, G(), p + n * (uMarch.z * clamp(0.2 + max(l0.b - 1.0, 0.0) * 0.06, 0.2, 1.0)));
  // fade out towards the open faces so the box never shows
  vec3 e = min(p, uDim - p);
  float ed = min(min(e.x, e.z), uMarch2.z > 0.5 ? min(e.y, uDim.y - p.y) : uDim.y - p.y);
  // (the fade distance is jittered by the same noise, so a cloud that reaches a face frays
  // into wisps instead of showing a straight cut)
  float fade = smoothstep(0.5, uMarch2.x, ed + 1.6 * (n.x + n.z));
  s.rgb *= fade * fade;
  if (uDetail.y > 0.0) {
    // Worley fbm from one fetch: f2 cells (big billows), f4 (the lobes on them), f8 (the
    // cauliflower on those). Thin gas erodes harder than the core, so billows keep firm tops
    // while their trailing edges tear into ragged wisps
    vec3 wv = texture(uNoise3D, (pw - uDetailC) * uDetail.y + n * 0.05).gba;
    float crease = 1.0 - dot(wv, vec3(0.45, 0.35, 0.2));
    float thin = exp(-s.b / max(uDetail.x, 1e-3));
    s.b = max(s.b - uDetail.x * crease * (1.0 + thin), 0.0);
    s.r *= 1.0 - uDetail.z * crease;
  }
  sg = sigmaOf(s);
  em = emitOf(s);
  float ss = uLook0.y * max(s.b, 0.0);
  if (ss < 1e-4) return true;
  // sun: single scattering through the precomputed optical depth, plus two wider, weaker octaves
  // standing in for multiple scattering (Wrenninge 2015); sky through the optical depth above
  float t = l0.r;
  // multiple-scattering octaves scale with albedo: dark soot barely scatters twice, so it keeps
  // its form shading (lit tops, near-black undersides) instead of glowing flat
  vec3 tc = t * gKc;
  vec3 sun = uSunColor * uLit.y * (exp(-tc) * gSunPh + gMs * (0.4 * exp(-0.5 * tc) + 0.15 * exp(-0.25 * tc)));
  vec3 sky = uAmbient * uLit.z * (0.04 + 0.96 * exp(-0.7 * l0.g * gKc));   // deep cores go near black
  sc = ss * uSootColor * (sun + sky + gFire * l0.a);
  return true;
}

vec3 gRd;
// a sample on the ray, with the near fade applied (all three outputs are linear in density)
bool tap(float t, out float sg, out vec3 sc, out vec3 em) {
  bool o = sampleAt(cameraPosition + gRd * t, sg, sc, em);
  float k = clamp(t * uMarch2.w, 0.0, 1.0);
  k *= k * (3.0 - 2.0 * k);
  sg *= k; sc *= k; em *= k;
  return o;
}
// the integrator state, and one trapezoid slab (energy conserving) from ta over L
float gT, gZs, gWs;
vec3 gScat, gEmit;
void slab(float ta, float L, float sa, vec3 ca, vec3 ea, float sb, vec3 cb, vec3 eb) {
  float s = 0.5 * (sa + sb);
  vec3 S = 0.5 * (ca + cb), E = 0.5 * (ea + eb);
  if (s > 1e-5) {
    float tr = exp(-s * L), a = gT * (1.0 - tr);
    gScat += S * (a / s);
    gEmit += E * (a / s);
    gZs += a * (ta + 0.5 * L); gWs += a;
    gT *= tr;
  } else gEmit += gT * E * L;
}

void main() {
  vec3 rd = normalize(vWorld - cameraPosition);
  gRd = rd;
  vec3 dd = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
  vec3 bmin = uOrigin, bmax = uOrigin + uDim * uH;
  vec3 ta = (bmin - cameraPosition) / dd, tb = (bmax - cameraPosition) / dd;
  vec3 lo = min(ta, tb), hi = max(ta, tb);
  float t0 = max(max(max(lo.x, lo.y), lo.z), 0.0), t1 = min(min(hi.x, hi.y), hi.z);
  float cosV = dot(rd, -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  t1 = min(t1, sceneViewZ() / cosV);
  if (t1 <= t0) discard;
  float dt = uMarch.x;
  float mu = dot(uSunDir, rd);
  // soot: forward lobe + a weak back lobe, normalised so isotropic = 1
  gSunPh = mix(hgPhase(mu, uLit.x), hgPhase(mu, -0.25), 0.25) * 4.0 * PI;
  gFire = blackbody(kelvinOf(0.75)) * uTint * uLit.w;
  gMs = clamp(dot(uSootColor, vec3(1.0)), 0.0, 1.0);
  // chroma > 0: a coloured gas (chlorine) takes its colour from depth, not from its albedo alone.
  // The channels it absorbs (where the albedo is below its brightest) fade faster on the way in,
  // so thin gas scatters near white and deep gas goes yellow-green; 0 = grey extinction
  gKc = 1.0 + uLook1.w * (1.0 - uSootColor / max(max(uSootColor.r, uSootColor.g), max(uSootColor.b, 1e-3)));
  gT = 1.0; gZs = 0.0; gWs = 0.0; gScat = vec3(0.0); gEmit = vec3(0.0);
  // the lattice: t0 + i dt, ending in a partial step at t1 (continuous in t0, t1 and dt)
  float t = t0, sgP; vec3 scP, emP;
  bool occP = tap(t, sgP, scP, emP);
  float empties = occP ? 0.0 : 1.0;
  for (int n = 0; n < 256; n++) {
    if (gT < 0.03 || t >= t1) break;
    // stride over empty space (the occupancy is dilated ~3 voxels, so skipped points are empty)
    float stride = clamp(empties - 1.0, 1.0, uDetail.w);
    float tn = min(t + dt * stride, t1), sg; vec3 sc, em;
    bool occ = tap(tn, sg, sc, em);
    if (occ && stride > 1.0) {   // landed in gas: back onto the next lattice point
      tn = min(t + dt, t1);
      occ = tap(tn, sg, sc, em);
      empties = 0.0;
    }
    float L = tn - t, w = smoothstep(0.8, 1.6, 0.5 * (sg + sgP) * L);
    if (w > 0.0) {
      // optically thick (a surface): also integrate it as two half slabs through the midpoint, and
      // blend the two estimates by thickness, so the surface sits where it is, not on the lattice
      float T0 = gT, z0 = gZs, w0 = gWs; vec3 s0 = gScat, e0 = gEmit;
      float sgM; vec3 scM, emM;
      tap(t + 0.5 * L, sgM, scM, emM);
      slab(t, 0.5 * L, sgP, scP, emP, sgM, scM, emM);
      slab(t + 0.5 * L, 0.5 * L, sgM, scM, emM, sg, sc, em);
      float T2 = gT, z2 = gZs, w2 = gWs; vec3 s2 = gScat, e2 = gEmit;
      gT = T0; gZs = z0; gWs = w0; gScat = s0; gEmit = e0;
      if (w < 1.0) slab(t, L, sgP, scP, emP, sg, sc, em);
      gT = mix(gT, T2, w); gZs = mix(gZs, z2, w); gWs = mix(gWs, w2, w); gScat = mix(gScat, s2, w); gEmit = mix(gEmit, e2, w);
    } else slab(t, L, sgP, scP, emP, sg, sc, em);
    sgP = sg; scP = sc; emP = em; t = tn;
    empties = occ ? 0.0 : empties + 1.0;
  }
  // stopped on opacity: the unmarched rest is more of the same gas, so renormalise to opaque
  // (else the last 3% lets a bright HDR sky print its clouds through thick dark smoke)
  if (gT < 0.03) { float k = 1.0 / (1.0 - gT); gScat *= k; gEmit *= k; gT = 0.0; }
  float alpha = 1.0 - gT;
  if (alpha < 0.002 && dot(gEmit, gEmit) < 1e-6) discard;
  float z = (gWs > 0.0 ? gZs / gWs : t0) * cosV;
  fxOut(gScat / max(alpha, 1e-4), alpha, gEmit, vec2(0.0), z);
}`;
const bodyAt = BASE.RENDER_FRAG.indexOf('float gSunPh;');
if (bodyAt < 0) throw new Error('FluidVolume: render body anchor not found');
const RENDER_FRAG = BASE.RENDER_FRAG.slice(0, bodyAt) + RENDER_BODY;
const GL = { ...BASE, REACT, RENDER_FRAG };

// GPU 3D combustion fluid (shared system; Fire is the first user).
//
// Each domain is an axis-aligned box of cubic voxels simulated on the GPU and raymarched in the
// half-res FX pass. 3D grids live in 2D atlases (slices tiled), so every sim pass is one
// fullscreen draw into a viewport covering the used tiles; trilinear lookups are two hardware
// bilinear taps in neighbouring slices. HalfFloat targets, ping-ponged.
//
// Fields: velocity (m/s), scalars (temperature th, fuel, soot, expansion), vorticity, pressure +
// divergence, and a half-res light volume. One step per frame (dt <= 1/30):
//   1 advect      semi-Lagrangian, RK2 backtrace, compensated for the domain's own motion
//   2 correct     MacCormack, clamped to the departure cell's extrema (no overshoot)
//   3 curl        vorticity
//   4 react       sources -> combustion (fuel + heat -> heat, soot, gas expansion) -> cooling ->
//                 buoyancy (heat up, soot down) -> vorticity confinement -> forceAccel() from
//                 the shared force field (wind, vortex, shock... spells push fire) -> damping
//   5 diverge     b = h^2 (div u - expansion), warm-started pressure
//   6 jacobi      Q-dependent iterations (12 / 14 / 16 / 20; Low profile 6), warm-started
//   7 project     u -= grad p; the floor (world y < 0) is solid, the other faces are open air
//   8 light       half-res: sun optical depth (march to the box exit), sky optical depth (march
//                 up), |vorticity|, occupancy, and the fire's own light (blurred blackbody
//                 emission, the "low mip" that lights the smoke orange from inside)
// Render: march the box from the camera to min(exit, scene depth), trapezoid slabs, skipping
// empty space through the light volume's occupancy. Emission is blackbody(T) x T^4 with an
// optical-thickness shoulder; soot scatters sun (HG + multiple-scattering octaves), sky and
// fire light. Sub-grid detail: the lookup is displaced by band-limited curl noise drifting with the
// gas, scaled by the resolved vorticity (wavelet-turbulence-like upres). The samples sit on a
// lattice from the ray's entry at one spacing per domain, refined in place at surfaces (see RENDER_BODY).
//
// API
//   const fluid = FluidVolume.get(fx)        create once (adds itself to fx.systems; meshes go in
//                                            fx.scenes.fx so the warm-up compiles them)
//   const d = fluid.acquire({ size: [x, y, z], res, position })   null when the pool is full
//     size   metres (rounded to whole voxels); res = voxels along the longest axis (default
//            Q.fluidRes: 32 / 48 / 64 / 96 by tier; elongated boxes may ask for more if they
//            fit the atlas). Fields start empty.
//   d.position          world centre (Vector3); move it to follow a source, advection compensates
//   d.emit(src)         this frame only (call every frame for a continuous source; max 8/frame):
//                         { pos, radius, fuel, temp, soot, vel, radial, noise, noiseScale, seed,
//                           coupling, burst }
//                       burst: values are 'at least' this (one-shot fill); else per second.
//                       temp is th (1 = the flame temperature). coupling: 1/s pull of the
//                       velocity towards vel + radial * outward (large = set).
//   d.heat              CPU estimate of the domain's heat (th m^3), for driving lights
//   d.clear()           empty the fields;  d.release()  back to the pool
//   sim fields          ignition, burnRate, heat release (heatPerFuel), sootYield, expansion,
//                       cooling, radiative, sootDecay, fuelDecay, buoyancy, sootWeight,
//                       vorticity, forceCoupling, damping; opt-in, 0 = off: turbulence (m/s2 on hot
//                       gas), turbulenceFreq (tiles/m), sootCool (soot radiates heat: dark lanes),
//                       sootErode (units/s, soot thins from its edges, keeping its billows)
//   look fields         emission, temperature (K at th = 1), tint (Color), sootColor (albedo),
//                       sootDensity, flameDensity, fuelDensity, absorb (0..1 black flame: hot gas
//                       absorbs instead of glowing), g (HG), sun, sky, fireLight, upres
//                       (voxels), upresScale (feature size, voxels), edgeFade (voxels), visible;
//                       opt-in cell detail: detailFreq (tiles/m, 0 = off; band-limited to the march
//                       step), detailErode (soot units), detailHeat (0..1), detailCenter (Vector3);
//                       nearFade (m: density ramps in over this distance from the camera);
//                       chroma (0 = grey; > 0 the gas's colour deepens with depth, thin gas paler)
//   d.obstacle          Vector4: a solid sphere in the sim (world centre xyz, radius m; w = 0 none):
//                       gas flows round it and none is left inside (a fireball on an Aegis dome)
//   cost fields         emptyBelow (extinction 1/m below which gas is skipped as empty),
//                       stepScale (march spacing x; wide thin layers can afford coarser)
// No allocation after construction; nothing recompiles (tier settings are uniforms or pass counts).

const TIER_RES = { low: 32, medium: 48, high: 64, ultra: 96 };
const TIER_SLOTS = { low: 1, medium: 2, high: 2, ultra: 2 };
const TIER_ITERS = { low: 12, medium: 14, high: 16, ultra: 20 };
const TIER_STEP = { low: 1.3, medium: 1.15, high: 1.0, ultra: 0.8 };   // render step, voxels
const TIER_MAXSTEPS = { low: 56, medium: 80, high: 112, ultra: 160 };

const DEFAULTS = {
  ignition: 0.3, burnRate: 3, heatPerFuel: 0.8, sootYield: 0.5, expansion: 1,
  cooling: 0.5, radiative: 0.25, sootDecay: 0.12, fuelDecay: 0.3,
  buoyancy: 5, sootWeight: 0.4, vorticity: 6, forceCoupling: 1, damping: 0.15,
  emission: 4, temperature: 1900, sootDensity: 3, flameDensity: 0.35, fuelDensity: 0, absorb: 0,
  g: 0.45, sun: 1, sky: 1, fireLight: 0.5, upres: 1.4, upresScale: 4, edgeFade: 5, visible: true,
  turbulence: 0, turbulenceFreq: 0.5, sootCool: 0, sootErode: 0, detailFreq: 0, detailErode: 0, detailHeat: 0, nearFade: 0.4,
  emptyBelow: 0, stepScale: 1, chroma: 0,
};

// the tiles a grid of n voxels takes in a W x H atlas, or null if it does not fit
function tileLayout(nx, ny, nz, W, H) {
  const tx = Math.floor(W / nx), ty = Math.floor(H / ny);
  if (tx < 1 || ty < 1) return null;
  const tilesX = Math.min(tx, nz), tilesY = Math.ceil(nz / tilesX);
  return tilesY <= ty ? [tilesX, tilesY] : null;
}
const atlasSize = (N) => { const t = Math.ceil(Math.sqrt(N)); return [t * N, Math.ceil(N / t) * N]; };

function target(w, h, count, format = THREE.RGBAFormat) {
  return new THREE.WebGLRenderTarget(w, h, {
    count, type: THREE.HalfFloatType, format, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

class FluidDomain {
  constructor(sys, W, H, cW, cH) {
    this.sys = sys;
    this.W = W; this.H = H; this.cW = cW; this.cH = cH;
    this.state = [target(W, H, 2), target(W, H, 2)];   // (velocity, scalars)
    this.tmp = target(W, H, 2);
    this.curl = target(W, H, 1);
    this.press = [target(W, H, 1, THREE.RGFormat), target(W, H, 1, THREE.RGFormat)];
    this.light = target(cW, cH, 1);
    this.all = [...this.state, this.tmp, this.curl, ...this.press];
    this.dim = new THREE.Vector3(8, 8, 8);
    this.tiles = new THREE.Vector2(1, 1);
    this.cdim = new THREE.Vector3(4, 4, 4);
    this.ctiles = new THREE.Vector2(1, 1);
    this.h = 0.1;
    this.size = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.origin = new THREE.Vector3();
    this.lastOrigin = new THREE.Vector3();
    this.tint = new THREE.Color(1, 1, 1);
    this.sootColor = new THREE.Color(0.13, 0.12, 0.11);
    this.detailCenter = new THREE.Vector3();
    this.obstacle = new THREE.Vector4();
    this.srcP = Array.from({ length: GL.MAX_SRC }, () => new THREE.Vector4());
    this.srcA = Array.from({ length: GL.MAX_SRC }, () => new THREE.Vector4());
    this.srcV = Array.from({ length: GL.MAX_SRC }, () => new THREE.Vector4());
    this.srcB = Array.from({ length: GL.MAX_SRC }, () => new THREE.Vector4());
    this.nSrc = 0;
    this.active = false;
    this.cur = 0; this.pc = 0; this.fresh = true;
    this.heat = 0; this.fuelPool = 0;
    Object.assign(this, DEFAULTS);
  }

  setGrid(nx, ny, nz, tiles, cn, ctiles, h) {
    this.dim.set(nx, ny, nz);
    this.tiles.set(tiles[0], tiles[1]);
    this.cdim.set(cn[0], cn[1], cn[2]);
    this.ctiles.set(ctiles[0], ctiles[1]);
    this.h = h;
    this.size.set(nx * h, ny * h, nz * h);
    for (const t of this.all) t.viewport.set(0, 0, tiles[0] * nx, tiles[1] * ny);
    this.light.viewport.set(0, 0, ctiles[0] * cn[0], ctiles[1] * cn[1]);
  }

  emit(s) {
    if (!this.active || this.nSrc >= GL.MAX_SRC) return;
    const i = this.nSrc++, v = s.vel, burst = s.burst ? 1 : 0;
    this.srcP[i].set(s.pos.x, s.pos.y, s.pos.z, s.radius ?? 0.5);
    this.srcA[i].set(s.fuel ?? 0, s.temp ?? 0, s.soot ?? 0, s.noise ?? 0);
    this.srcV[i].set(v ? v.x : 0, v ? v.y : 0, v ? v.z : 0, s.radial ?? 0);
    this.srcB[i].set(burst, s.noiseScale ?? 1, s.seed ?? 0, s.coupling ?? 0);
    // CPU mirror of the heat budget (drives lights): effective volume of the soft sphere
    const r = s.radius ?? 0.5, vol = 1.6 * r * r * r * (1 - 0.5 * (s.noise ?? 0)), k = burst ? 1 : this.sys.dt;
    this.fuelPool += (s.fuel ?? 0) * vol * k;
    this.heat += (s.temp ?? 0) * vol * k * 0.5;
  }

  clear() { this.fresh = true; }

  release() { this.active = false; this.mesh.visible = false; this.nSrc = 0; }
}

const _c = new THREE.Color(), _v = new THREE.Vector3();
const quadCam = new THREE.Camera();

export class FluidVolume {
  static get(fx) {
    if (!fx.fluid) { fx.fluid = new FluidVolume(fx); fx.systems.push(fx.fluid); }
    return fx.fluid;
  }

  constructor(fx) {
    this.fx = fx;
    this.renderer = fx.renderer;
    const tier = Q.tier;
    this.res = Q.fluidRes ?? TIER_RES[tier] ?? 64;
    this.iterations = Q.fluidIterations ?? TIER_ITERS[tier] ?? 20;
    this.stepVox = TIER_STEP[tier] ?? 0.85;
    this.maxSteps = TIER_MAXSTEPS[tier] ?? 112;
    this.dt = 1 / 60;
    const [W, H] = atlasSize(this.res), [cW, cH] = atlasSize(Math.ceil(this.res / 2));

    // sim uniforms shared by reference across every pass; set per domain before its passes
    const su = this.su = {
      uDim: { value: new THREE.Vector3() }, uTiles: { value: new THREE.Vector2() }, uInv: { value: new THREE.Vector2(1 / W, 1 / H) },
      uOrigin: { value: new THREE.Vector3() }, uH: { value: 0.1 }, uSimDt: { value: 1 / 60 }, uShift: { value: new THREE.Vector3() },
      uObst: { value: new THREE.Vector4() },
    };
    const tex = () => ({ value: null });
    const pass = (frag, own) => new FullscreenQuad(rawPass(frag, { ...U, ...su, ...own }));
    const v4s = () => ({ value: Array.from({ length: GL.MAX_SRC }, () => new THREE.Vector4()) });
    this.look = {
      uLook0: { value: new THREE.Vector4() }, uLook1: { value: new THREE.Vector4() }, uTint: { value: new THREE.Vector3(1, 1, 1) },
    };
    this.passes = {
      advect: pass(GL.ADVECT, { uV: tex(), uS: tex() }),
      correct: pass(GL.CORRECT, { uV: tex(), uS: tex(), uVf: tex(), uSf: tex(), uMacCormack: { value: 1 } }),
      curl: pass(GL.CURL, { uV: tex() }),
      react: pass(GL.REACT, {
        uV: tex(), uS: tex(), uC: tex(), uSrcP: v4s(), uSrcA: v4s(), uSrcV: v4s(), uSrcB: v4s(), uSrcN: { value: 0 },
        uBurn: { value: new THREE.Vector4() }, uDecay: { value: new THREE.Vector4() }, uForce: { value: new THREE.Vector4() }, uFlow: { value: new THREE.Vector4() }, uTurb: { value: new THREE.Vector4() },
      }),
      diverge: pass(GL.DIVERGE, { uV: tex(), uS: tex(), uP: tex(), uWarm: { value: 0.9 } }),
      jacobi: pass(GL.JACOBI, { uP: tex() }),
      project: pass(GL.PROJECT, { uV: tex(), uS: tex(), uP: tex() }),
      light: pass(GL.LIGHT, {
        ...this.look, uS: tex(), uC: tex(), uCDim: { value: new THREE.Vector3() }, uCTiles: { value: new THREE.Vector2() },
        uCInv: { value: new THREE.Vector2(1 / cW, 1 / cH) }, uLightP: { value: new THREE.Vector4(2.5, 3, 1, 0) },
      }),
    };
    for (const p of Object.values(this.passes)) this.renderer.compile(p.mesh, quadCam);

    // domains: each owns its targets and a box proxy in the fx scene
    const box = new THREE.BoxGeometry(1, 1, 1);
    const slots = Q.fluidDomains ?? TIER_SLOTS[tier] ?? 2;
    this.domains = [];
    for (let i = 0; i < slots; i++) {
      const d = new FluidDomain(this, W, H, cW, cH);
      d.material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: GL.RENDER_VERT, fragmentShader: GL.RENDER_FRAG,
        ...FX_BLENDING, depthTest: false, side: THREE.BackSide,
        uniforms: {
          ...U, uS: tex(), uL0: { value: d.light.texture },
          uDim: { value: d.dim }, uTiles: { value: d.tiles }, uInv: { value: new THREE.Vector2(1 / W, 1 / H) },
          uCDim: { value: d.cdim }, uCTiles: { value: d.ctiles }, uCInv: { value: new THREE.Vector2(1 / cW, 1 / cH) },
          uOrigin: { value: d.origin }, uH: { value: 0.1 },
          uMarch: { value: new THREE.Vector4() }, uMarch2: { value: new THREE.Vector4() }, uLit: { value: new THREE.Vector4() },
          uSootColor: { value: new THREE.Vector3() }, uDetail: { value: new THREE.Vector4() }, uDetailC: { value: d.detailCenter },
          uLook0: { value: new THREE.Vector4() }, uLook1: { value: new THREE.Vector4() }, uTint: { value: new THREE.Vector3(1, 1, 1) },
        },
      });
      d.mesh = new THREE.Mesh(box, d.material);
      d.mesh.visible = false;
      d.mesh.frustumCulled = false;
      fx.scenes.fx.add(d.mesh);
      this.domains.push(d);
    }

    // run every pass once now (ANGLE finishes some programs at first draw), then forget it
    const d0 = this.domains[0];
    this.layout(d0, [1, 1, 1], 8);
    d0.active = true;
    this.clearDomain(d0);
    this.step(d0, 1 / 60);
    d0.active = false;
    d0.fresh = true;
  }

  // pick voxel counts for a box of `size` metres with `res` voxels on its longest axis
  layout(d, size, res) {
    const big = Math.max(size[0], size[1], size[2]);
    for (let r = Math.max(8, Math.round(res)); r >= 8; r -= 2) {
      const h = big / r;
      const nx = Math.max(4, Math.round(size[0] / h)), ny = Math.max(4, Math.round(size[1] / h)), nz = Math.max(4, Math.round(size[2] / h));
      const cx = Math.ceil(nx / 2), cy = Math.ceil(ny / 2), cz = Math.ceil(nz / 2);
      const t = tileLayout(nx, ny, nz, d.W, d.H), ct = tileLayout(cx, cy, cz, d.cW, d.cH);
      if (!t || !ct) continue;
      d.setGrid(nx, ny, nz, t, [cx, cy, cz], ct, h);
      return true;
    }
    return false;
  }

  acquire({ size = [4, 4, 4], res = this.res, position = null } = {}) {
    const d = this.domains.find((x) => !x.active);
    if (!d || !this.layout(d, size, res)) return null;
    Object.assign(d, DEFAULTS);
    d.tint.setRGB(1, 1, 1);
    d.sootColor.setRGB(0.13, 0.12, 0.11);
    d.detailCenter.set(0, 0, 0);
    d.obstacle.set(0, 0, 0, 0);
    if (position) d.position.copy(position);
    d.active = true;
    d.fresh = true;
    d.nSrc = 0; d.heat = 0; d.fuelPool = 0;
    return d;
  }

  get active() { return this.domains.some((d) => d.active); }

  clearDomain(d) {
    const r = this.renderer, prev = r.getRenderTarget(), alpha = r.getClearAlpha();
    r.getClearColor(_c);
    r.setClearColor(0x000000, 0);
    for (const t of d.all) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setRenderTarget(d.light); r.clear(true, false, false);
    r.setClearColor(_c, alpha);
    r.setRenderTarget(prev);
    d.cur = 0; d.pc = 0; d.fresh = false;
  }

  draw(name, out) {
    const p = this.passes[name];
    p.render(this.renderer, out);
    return p.material.uniforms;
  }

  // one sim step for domain d
  step(d, dt) {
    const su = this.su, P = this.passes;
    d.origin.copy(d.position).addScaledVector(d.size, -0.5);
    su.uDim.value.copy(d.dim); su.uTiles.value.copy(d.tiles);
    su.uOrigin.value.copy(d.origin); su.uH.value = d.h; su.uSimDt.value = dt;
    su.uShift.value.subVectors(d.origin, d.lastOrigin).divideScalar(d.h);
    d.lastOrigin.copy(d.origin);
    const ob = d.obstacle;
    su.uObst.value.set((ob.x - d.origin.x) / d.h - 0.5, (ob.y - d.origin.y) / d.h - 0.5, (ob.z - d.origin.z) / d.h - 0.5, ob.w / d.h);
    const A = d.state[d.cur], B = d.state[1 - d.cur];
    let u;

    u = P.advect.material.uniforms; u.uV.value = A.textures[0]; u.uS.value = A.textures[1];
    this.draw('advect', d.tmp);
    u = P.correct.material.uniforms; u.uV.value = A.textures[0]; u.uS.value = A.textures[1]; u.uVf.value = d.tmp.textures[0]; u.uSf.value = d.tmp.textures[1];
    this.draw('correct', B);
    su.uShift.value.set(0, 0, 0);
    P.curl.material.uniforms.uV.value = B.textures[0];
    this.draw('curl', d.curl);

    u = P.react.material.uniforms;
    u.uV.value = B.textures[0]; u.uS.value = B.textures[1]; u.uC.value = d.curl.texture;
    u.uSrcN.value = d.nSrc;
    for (let i = 0; i < d.nSrc; i++) {
      u.uSrcP.value[i].copy(d.srcP[i]); u.uSrcA.value[i].copy(d.srcA[i]); u.uSrcV.value[i].copy(d.srcV[i]); u.uSrcB.value[i].copy(d.srcB[i]);
    }
    u.uBurn.value.set(d.ignition, d.burnRate, d.heatPerFuel, d.sootYield);
    u.uDecay.value.set(d.cooling, d.radiative, d.sootDecay, d.fuelDecay);
    u.uForce.value.set(d.buoyancy, d.sootWeight, d.vorticity, d.expansion);
    u.uFlow.value.set(d.forceCoupling, d.damping, 0, 0);
    u.uTurb.value.set(d.turbulence, d.turbulenceFreq, d.sootErode, d.sootCool);
    this.draw('react', A);

    u = P.diverge.material.uniforms;
    u.uV.value = A.textures[0]; u.uS.value = A.textures[1]; u.uP.value = d.press[d.pc].texture;
    this.draw('diverge', d.press[1 - d.pc]);
    d.pc = 1 - d.pc;
    const J = P.jacobi.material.uniforms;
    for (let i = 0; i < this.iterations; i++) {
      J.uP.value = d.press[d.pc].texture;
      this.draw('jacobi', d.press[1 - d.pc]);
      d.pc = 1 - d.pc;
    }
    u = P.project.material.uniforms;
    u.uV.value = A.textures[0]; u.uS.value = A.textures[1]; u.uP.value = d.press[d.pc].texture;
    this.draw('project', B);
    d.cur = 1 - d.cur;

    // CPU heat mirror: pending fuel burns at the sim's rate, heat cools at its rate
    const burned = d.fuelPool * (1 - Math.exp(-d.burnRate * dt));
    d.fuelPool -= burned;
    d.heat = (d.heat + burned * d.heatPerFuel) * Math.exp(-(d.cooling + 0.6 * d.radiative) * dt);
  }

  setLook(d, u) {
    u.uLook0.value.set(d.emission, d.sootDensity, d.flameDensity, d.absorb);
    u.uLook1.value.set(d.temperature, 300, d.fuelDensity, d.chroma);
    u.uTint.value.set(d.tint.r, d.tint.g, d.tint.b);
  }

  // main calls this every frame inside the timed 'sim' section
  update(dt, camera) {
    this.dt = Math.min(dt, 1 / 30);
    const r = this.renderer, prev = r.getRenderTarget();
    const fxH = U.uFxResolution.value.y, mPerPx = 1 / (0.5 * fxH * camera.projectionMatrix.elements[5]);
    for (const d of this.domains) {
      d.mesh.visible = d.active && d.visible;
      if (!d.active) continue;
      if (d.fresh) { this.clearDomain(d); d.origin.copy(d.position).addScaledVector(d.size, -0.5); d.lastOrigin.copy(d.origin); }
      if (dt > 0) this.step(d, this.dt);
      d.nSrc = 0;
      d.origin.copy(d.position).addScaledVector(d.size, -0.5);
      // light volume (also while paused: the sun may move)
      const su = this.su, L = this.passes.light.material.uniforms;
      su.uDim.value.copy(d.dim); su.uTiles.value.copy(d.tiles); su.uOrigin.value.copy(d.origin); su.uH.value = d.h;
      L.uS.value = d.state[d.cur].textures[1]; L.uC.value = d.curl.texture;
      L.uCDim.value.copy(d.cdim); L.uCTiles.value.copy(d.ctiles);
      L.uLightP.value.set(2.5, 2, d.fireLight, d.emptyBelow);
      this.setLook(d, this.look);
      this.draw('light', d.light);
      // render uniforms
      const m = d.material.uniforms;
      m.uS.value = d.state[d.cur].textures[1];
      m.uH.value = d.h;
      this.setLook(d, m);
      // sample spacing: a fraction of a voxel, never finer than the pixel footprint at the domain's
      // distance, and coarse enough that the box's diagonal fits the step budget
      const auto = Math.min(1, Q.auto?.steps ?? 1), steps = Math.max(8, Math.floor(this.maxSteps * auto));
      const dist = _v.subVectors(camera.position, d.position).length();
      const dtm = Math.max(this.stepVox * d.stepScale * d.h / auto, dist * mPerPx, d.size.length() / steps);
      // displacement: one curl octave, its finest band (1/16 tile) no finer than the march step
      m.uMarch.value.set(dtm, steps, d.upres, Math.min(1 / (4 * d.upresScale * d.h), 1 / (16 * dtm)));
      m.uMarch2.value.set(d.edgeFade, mPerPx, d.origin.y > -0.5 * d.h ? 1 : 0, 1 / Math.max(d.nearFade, 0.01));
      // the empty-space stride stays inside the occupancy's ~3 voxel dilation; the cell pattern's
      // main octaves (a quarter and an eighth of a tile) stay above the sample spacing
      m.uDetail.value.set(d.detailErode, Math.min(d.detailFreq, 1 / (12 * dtm)), d.detailHeat, Math.max(1, Math.floor(3 * d.h / dtm)));
      m.uLit.value.set(d.g, d.sun, d.sky, 1);
      m.uSootColor.value.set(d.sootColor.r, d.sootColor.g, d.sootColor.b);
      d.mesh.position.copy(d.position);
      d.mesh.scale.copy(d.size);
      d.mesh.updateMatrixWorld();
    }
    r.setRenderTarget(prev);
  }
}
