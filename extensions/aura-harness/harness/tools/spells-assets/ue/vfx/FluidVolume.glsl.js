import { COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, FORCES_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL } from './common.js';

// Shaders for FluidVolume.js (see its header for the design). Every sim pass is one fullscreen
// draw over a 2D atlas holding a 3D grid; all lookups are explicit LOD 0 (implicit-gradient
// samples inside data-dependent loops make ANGLE's FXC unroll them).

export const MAX_SRC = 8;

const HEAD = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
#define texture(s, p) textureLod(s, p, 0.0)
`;

// 3D grid in a 2D atlas: slice k is tile (k % tiles.x, k / tiles.x), each tile dim.xy texels.
// Voxel centres sit at i + 0.5 in voxel units.
const GRID_GLSL = /* glsl */`
struct Grid { vec3 dim; vec2 tiles; vec2 inv; };
ivec2 gridTexel(Grid g, ivec3 v) {
  v = clamp(v, ivec3(0), ivec3(g.dim) - 1);
  int tx = int(g.tiles.x);
  return ivec2((v.z % tx) * int(g.dim.x) + v.x, (v.z / tx) * int(g.dim.y) + v.y);
}
vec4 gridFetch(sampler2D t, Grid g, ivec3 v) { return texelFetch(t, gridTexel(g, v), 0); }
vec2 sliceOrigin(Grid g, float k) { float row = floor((k + 0.5) / g.tiles.x); return vec2(k - row * g.tiles.x, row) * g.dim.xy; }
// trilinear: hardware bilinear inside two slices, lerp between them (clamped so tiles never bleed)
vec4 gridSample(sampler2D t, Grid g, vec3 p) {
  vec3 q = clamp(p, vec3(0.5), g.dim - 0.5);
  float z = q.z - 0.5, k0 = floor(z), f = z - k0, k1 = min(k0 + 1.0, g.dim.z - 1.0);
  vec4 a = textureLod(t, (sliceOrigin(g, k0) + q.xy) * g.inv, 0.0);
  vec4 b = textureLod(t, (sliceOrigin(g, k1) + q.xy) * g.inv, 0.0);
  return mix(a, b, f);
}
bool gridVoxel(Grid g, out ivec3 v) {
  ivec2 p = ivec2(gl_FragCoord.xy), d = ivec2(g.dim.xy), tile = p / d;
  v = ivec3(p - tile * d, tile.y * int(g.tiles.x) + tile.x);
  return v.z < int(g.dim.z);
}
`;

// transfer function shared by the light pass and the raymarch
//   temperature th: 0 ambient, 1 = uLook1.x kelvin (the spell's flame temperature)
const LOOK_GLSL = /* glsl */`
uniform vec4 uLook0;   // emission gain, soot extinction (1/m per unit), flame extinction (1/m), absorb (black flame)
uniform vec4 uLook1;   // kelvin at th = 1, ambient kelvin, fuel extinction (1/m per unit), chroma (render only)
uniform vec3 uTint;
float kelvinOf(float th) { return uLook1.y + (uLook1.x - uLook1.y) * th; }
float flameOf(float th) { return smoothstep(0.12, 0.5, th); }
// Kirchhoff: hot soot and flame gas emit as much as they absorb, emission = sigma_abs * B(T). An
// opaque hot region therefore shows its own surface temperature (a blackbody), cooled soot is
// black smoke, and a thin flame sheet is a faint, see-through glow. B(T) in the visible band
// follows Planck's ~exp(-hc / (lambda k T)) at lambda ~ 600 nm (softened 2x for the display range):
// far steeper than T^4, so 1000 K soot is a dull red ember and 2400 K is ~4x the reference.
float glowOf(float th) {
  float T = kelvinOf(th), k = exp(12000.0 / uLook1.x - 12000.0 / max(T, 400.0));
  return k / (1.0 + 0.08 * k) * smoothstep(0.08, 0.25, th);
}
float sigmaHot(vec4 s) { return uLook0.y * max(s.b, 0.0) + uLook0.z * flameOf(s.r); }
float sigmaOf(vec4 s) { return sigmaHot(s) * (1.0 + 6.0 * uLook0.w * flameOf(s.r)) + uLook1.z * max(s.g, 0.0); }
vec3 emitOf(vec4 s) {
  float th = max(s.r, 0.0), g = glowOf(th) * sigmaHot(s) * uLook0.x * (1.0 - uLook0.w);
  return g > 1e-4 ? blackbody(kelvinOf(th)) * g * uTint : vec3(0.0);
}
`;

const SIM_HEAD = HEAD + COMMON_GLSL + GRID_GLSL + /* glsl */`
uniform vec3 uDim;
uniform vec2 uTiles;
uniform vec2 uInv;
uniform vec3 uOrigin;   // world position of the grid's min corner
uniform float uH;       // voxel size (m)
uniform float uSimDt;
uniform vec3 uShift;    // how far the domain moved this step (voxels): new origin - old origin
uniform vec4 uObst;     // a solid sphere (an Aegis dome): centre in voxels minus half a voxel, radius in voxels (0: none)
Grid G() { return Grid(uDim, uTiles, uInv); }
// cells below the arena floor, and inside the sphere, are solid
bool solid(ivec3 v) {
  if (float(v.y) + 0.5 < -uOrigin.y / uH) return true;
  if (uObst.w <= 0.0) return false;   // (uniform: no sphere, no cost)
  vec3 o = vec3(v) - uObst.xyz;
  return dot(o, o) < uObst.w * uObst.w;
}
bool outside(ivec3 v) { return any(lessThan(v, ivec3(0))) || any(greaterThanEqual(v, ivec3(uDim))); }
// open boundary: still air outside the box (one-voxel fade)
vec4 sampleOpen(sampler2D t, vec3 p) {
  vec3 o = max(max(-p, p - uDim), 0.0);
  float w = clamp(1.0 - max(o.x, max(o.y, o.z)), 0.0, 1.0);
  return w > 0.0 ? gridSample(t, G(), p) * w : vec4(0.0);
}
`;

// 1. semi-Lagrangian advection of velocity and scalars (RK2 backtrace), in the moving frame
export const ADVECT = SIM_HEAD + /* glsl */`
uniform sampler2D uV;
uniform sampler2D uS;
layout(location = 0) out vec4 oV;
layout(location = 1) out vec4 oS;
void main() {
  ivec3 v;
  if (!gridVoxel(G(), v)) { oV = vec4(0.0); oS = vec4(0.0); return; }
  vec3 p = vec3(v) + 0.5 + uShift;   // this cell's world point, in the previous grid
  float k = uSimDt / uH;
  vec3 u1 = sampleOpen(uV, p).xyz;
  vec3 u2 = sampleOpen(uV, p - 0.5 * k * u1).xyz;
  vec3 q = p - k * u2;
  oV = sampleOpen(uV, q);
  oS = sampleOpen(uS, q);
}`;

// 2. MacCormack correction (Selle et al. 2008), clamped to the old field's extrema around the
// departure point, so it never overshoots
export const CORRECT = SIM_HEAD + /* glsl */`
uniform sampler2D uV;
uniform sampler2D uS;
uniform sampler2D uVf;
uniform sampler2D uSf;
uniform float uMacCormack;
layout(location = 0) out vec4 oV;
layout(location = 1) out vec4 oS;
void main() {
  ivec3 v;
  if (!gridVoxel(G(), v)) { oV = vec4(0.0); oS = vec4(0.0); return; }
  vec4 vf = gridFetch(uVf, G(), v), sf = gridFetch(uSf, G(), v);
  if (uMacCormack < 0.5) { oV = vf; oS = sf; return; }
  float k = uSimDt / uH;
  vec3 c = vec3(v) + 0.5;
  vec3 r = c + k * vf.xyz;
  vec4 vb = gridSample(uVf, G(), r), sb = gridSample(uSf, G(), r);
  vec4 v0 = sampleOpen(uV, c + uShift), s0 = sampleOpen(uS, c + uShift);
  vec4 vn = vf + 0.5 * (v0 - vb), sn = sf + 0.5 * (s0 - sb);
  ivec3 i0 = ivec3(floor(c + uShift - k * vf.xyz - 0.5));
  vec4 vlo = vec4(1e4), vhi = vec4(-1e4), slo = vec4(1e4), shi = vec4(-1e4);
  for (int n = 0; n < 8; n++) {
    ivec3 o = i0 + ivec3(n & 1, (n >> 1) & 1, n >> 2);
    vec4 a = vec4(0.0), b = vec4(0.0);
    if (!outside(o)) { a = gridFetch(uV, G(), o); b = gridFetch(uS, G(), o); }
    vlo = min(vlo, a); vhi = max(vhi, a); slo = min(slo, b); shi = max(shi, b);
  }
  oV = clamp(vn, vlo, vhi);
  oS = clamp(sn, slo, shi);
}`;

// 3. vorticity w = curl u (rgb) and |w| (a)
export const CURL = SIM_HEAD + /* glsl */`
uniform sampler2D uV;
out vec4 oC;
vec3 at(ivec3 v) { return gridFetch(uV, G(), v).xyz; }
void main() {
  ivec3 v;
  if (!gridVoxel(G(), v)) { oC = vec4(0.0); return; }
  vec3 L = at(v - ivec3(1, 0, 0)), R = at(v + ivec3(1, 0, 0)), D = at(v - ivec3(0, 1, 0));
  vec3 U = at(v + ivec3(0, 1, 0)), B = at(v - ivec3(0, 0, 1)), F = at(v + ivec3(0, 0, 1));
  vec3 w = vec3((U.z - D.z) - (F.y - B.y), (F.x - B.x) - (R.z - L.z), (R.y - L.y) - (U.x - D.x)) * (0.5 / uH);
  oC = vec4(w, length(w));
}`;

// 4. sources, combustion, cooling, buoyancy, vorticity confinement, external forces
export const REACT = SIM_HEAD + NOISE_GLSL + WORLD_GLSL + FORCES_GLSL + /* glsl */`
uniform sampler2D uV;
uniform sampler2D uS;
uniform sampler2D uC;
uniform vec4 uSrcP[${MAX_SRC}];   // world centre, radius m
uniform vec4 uSrcA[${MAX_SRC}];   // fuel, temperature, soot, noise amount 0..1
uniform vec4 uSrcV[${MAX_SRC}];   // velocity m/s, radial speed m/s
uniform vec4 uSrcB[${MAX_SRC}];   // mode (0 per second, 1 at least), noise frequency 1/m, seed, velocity coupling 1/s
uniform int uSrcN;
uniform vec4 uBurn;    // ignition temperature, burn rate 1/s, heat per fuel, soot per fuel
uniform vec4 uDecay;   // cooling 1/s, radiative cooling, soot decay 1/s, fuel decay 1/s
uniform vec4 uForce;   // buoyancy m/s2 per th, soot weight m/s2 per unit, vorticity confinement, expansion per fuel
uniform vec4 uFlow;    // external force coupling, damping 1/s, -, -
layout(location = 0) out vec4 oV;
layout(location = 1) out vec4 oS;
float magAt(ivec3 v) { return gridFetch(uC, G(), v).a; }
void main() {
  ivec3 v;
  if (!gridVoxel(G(), v) || solid(v)) { oV = vec4(0.0); oS = vec4(0.0); return; }
  vec3 vel = gridFetch(uV, G(), v).xyz;
  vec4 s = gridFetch(uS, G(), v);
  vec3 pw = uOrigin + (vec3(v) + 0.5) * uH;
  float dt = uSimDt;
  for (int i = 0; i < ${MAX_SRC}; i++) {
    if (i >= uSrcN) break;
    vec4 P = uSrcP[i];
    vec3 d = pw - P.xyz;
    float r = length(d);
    if (r >= P.w) continue;
    vec4 A = uSrcA[i], B = uSrcB[i], W = uSrcV[i];
    float w = 1.0 - smoothstep(0.3 * P.w, P.w, r);
    if (A.w > 0.0) {   // lumpy, flickering source: the noise scrolls up through it
      vec3 np = pw * B.y + vec3(B.z, B.z * 0.37 - uTime * 0.8 * B.y, B.z * 0.71);
      w *= mix(1.0, smoothstep(0.3, 0.7, noise3(np * 0.25)), A.w);
    }
    if (w <= 0.0) continue;
    vec3 target = W.xyz + (r > 1e-4 ? d / r : vec3(0.0)) * W.w;
    vel = mix(vel, target, w * (1.0 - exp(-B.w * dt)));
    if (B.x < 0.5) s.rgb += vec3(A.y, A.x, A.z) * (w * dt);
    else s.rgb = max(s.rgb, vec3(A.y, A.x, A.z) * w);
  }
  // combustion: hot fuel burns into heat and soot, and the gas expands (a divergence source)
  float th = max(s.r, 0.0), fuel = max(s.g, 0.0), soot = max(s.b, 0.0);
  float burn = fuel * (1.0 - exp(-uBurn.y * dt)) * smoothstep(0.5 * uBurn.x, uBurn.x, th);
  fuel -= burn;
  th += burn * uBurn.z;
  soot += burn * uBurn.w;
  float expand = burn / max(dt, 1e-4) * uForce.w;
  // Newton cooling, plus radiative loss (exact step of dth/dt = -c th^4)
  th *= exp(-uDecay.x * dt);
  th /= pow(1.0 + 3.0 * uDecay.y * dt * th * th * th, 1.0 / 3.0);
  soot *= exp(-uDecay.z * dt);
  fuel *= exp(-uDecay.w * dt);
  // hot gas rises, soot is heavy
  vec3 acc = vec3(0.0, uForce.x * th - uForce.y * soot, 0.0);
  // vorticity confinement (Fedkiw et al. 2001): spin the small eddies back up
  vec4 c = gridFetch(uC, G(), v);
  vec3 eta = vec3(magAt(v + ivec3(1, 0, 0)) - magAt(v - ivec3(1, 0, 0)), magAt(v + ivec3(0, 1, 0)) - magAt(v - ivec3(0, 1, 0)),
                  magAt(v + ivec3(0, 0, 1)) - magAt(v - ivec3(0, 0, 1)));
  float el = length(eta);
  if (el > 1e-4) acc += uForce.z * uH * cross(eta / el, c.xyz);
  // the shared force field (wind, vortices, shocks...) pushes the gas like it pushes particles
  float kill = 0.0;
  acc += forceAccel(pw, vel, kill) * uFlow.x;
  vel = (vel + acc * dt) * exp(-uFlow.y * dt);
  oV = vec4(clamp(vel, -60.0, 60.0), 0.0);
  oS = vec4(min(th, 4.0), min(fuel, 4.0), min(soot, 8.0), expand);
}`;

// 5. divergence minus the combustion expansion (b = h^2 (div u - e)), plus a warm-start pressure
export const DIVERGE = SIM_HEAD + /* glsl */`
uniform sampler2D uV;
uniform sampler2D uS;
uniform sampler2D uP;
uniform float uWarm;
out vec4 oP;
vec3 at(ivec3 v) { return solid(v) ? vec3(0.0) : gridFetch(uV, G(), v).xyz; }
void main() {
  ivec3 v;
  if (!gridVoxel(G(), v) || solid(v)) { oP = vec4(0.0); return; }
  float div = (at(v + ivec3(1, 0, 0)).x - at(v - ivec3(1, 0, 0)).x + at(v + ivec3(0, 1, 0)).y - at(v - ivec3(0, 1, 0)).y
             + at(v + ivec3(0, 0, 1)).z - at(v - ivec3(0, 0, 1)).z) * (0.5 / uH);
  float e = gridFetch(uS, G(), v).a;
  float p0 = sampleOpen(uP, vec3(v) + 0.5 + uShift).r * uWarm;
  oP = vec4(p0, uH * uH * (div - e), 0.0, 0.0);
}`;

// pressure neighbours: open air (p = 0) outside the box, Neumann at the floor
const PRESSURE_N = /* glsl */`
float pN(ivec3 n, float pc) {
  if (solid(n)) return pc;
  return outside(n) ? 0.0 : gridFetch(uP, G(), n).r;
}
`;

// 6. Jacobi iteration
export const JACOBI = SIM_HEAD + /* glsl */`
uniform sampler2D uP;
out vec4 oP;
${PRESSURE_N}
void main() {
  ivec3 v;
  if (!gridVoxel(G(), v)) { oP = vec4(0.0); return; }
  vec4 c = gridFetch(uP, G(), v);
  if (solid(v)) { oP = vec4(0.0, c.g, 0.0, 0.0); return; }
  float s = pN(v + ivec3(1, 0, 0), c.r) + pN(v - ivec3(1, 0, 0), c.r) + pN(v + ivec3(0, 1, 0), c.r)
          + pN(v - ivec3(0, 1, 0), c.r) + pN(v + ivec3(0, 0, 1), c.r) + pN(v - ivec3(0, 0, 1), c.r);
  oP = vec4((s - c.g) / 6.0, c.g, 0.0, 0.0);
}`;

// 7. projection: subtract the pressure gradient; no flow into the floor
export const PROJECT = SIM_HEAD + /* glsl */`
uniform sampler2D uV;
uniform sampler2D uS;
uniform sampler2D uP;
layout(location = 0) out vec4 oV;
layout(location = 1) out vec4 oS;
${PRESSURE_N}
void main() {
  ivec3 v;
  if (!gridVoxel(G(), v) || solid(v)) { oV = vec4(0.0); oS = vec4(0.0); return; }
  float pc = gridFetch(uP, G(), v).r;
  vec3 g = vec3(pN(v + ivec3(1, 0, 0), pc) - pN(v - ivec3(1, 0, 0), pc), pN(v + ivec3(0, 1, 0), pc) - pN(v - ivec3(0, 1, 0), pc),
                pN(v + ivec3(0, 0, 1), pc) - pN(v - ivec3(0, 0, 1), pc)) * (0.5 / uH);
  vec3 vel = gridFetch(uV, G(), v).xyz - g;
  if (solid(v - ivec3(0, 1, 0))) vel.y = max(vel.y, 0.0);
  oV = vec4(vel, 0.0);
  oS = vec4(gridFetch(uS, G(), v).rgb, 0.0);
}`;

// 8. lighting volume at half resolution, one RGBA texel per 2x2x2 block:
//   r  sun optical depth (march to the box exit)    g  sky optical depth (march straight up)
//   b  occupancy: 0 if nothing within ~3 voxels, else 1 + |vorticity| (drives the sub-grid detail)
//   a  fire light: blurred Kirchhoff emission around the cell (the self-illumination source)
export const LIGHT = SIM_HEAD + NOISE_GLSL + LOOK_GLSL + /* glsl */`
uniform sampler2D uS;
uniform sampler2D uC;
uniform vec3 uCDim;
uniform vec2 uCTiles;
uniform vec2 uCInv;
uniform vec3 uSunDir;
uniform vec4 uLightP;   // sun step (voxels), fire-light tap spacing (voxels), fire-light gain, empty below (1/m)
out vec4 o0;
bool inBox(vec3 q) { return all(greaterThanEqual(q, vec3(0.0))) && all(lessThanEqual(q, uDim)); }
void main() {
  ivec3 c;
  if (!gridVoxel(Grid(uCDim, uCTiles, uCInv), c)) { o0 = vec4(0.0); return; }
  vec3 p = (vec3(c) + 0.5) * 2.0;   // fine voxel units: the centre of this cell's 2x2x2 block
  // 27 taps around the cell: occupancy (dilated) and the fire light
  float pw = 0.0, occ = 0.0;
  for (int k = 0; k < 27; k++) {
    vec3 o = vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
    vec4 st = gridSample(uS, G(), p + o * uLightP.y);
    float th = max(st.r, 0.0);
    occ = max(occ, sigmaOf(st) + th + max(st.g, 0.0));
    pw += glowOf(th) * min(sigmaHot(st), 4.0) / (1.0 + dot(o, o));
  }
  float tau = 0.0, tauU = 0.0;
  occ = occ > max(uLightP.w, 1e-3) ? occ : 0.0;
  if (occ > 0.0) {
    float st = uLightP.x;
    vec3 q = p + uSunDir * (0.5 * st);
    for (int i = 0; i < 48; i++) {
      if (!inBox(q)) break;
      tau += sigmaOf(gridSample(uS, G(), q));
      q += uSunDir * st;
    }
    tau *= st * uH;
    q = p + vec3(0.0, 2.0, 0.0);
    for (int i = 0; i < 10; i++) {
      if (q.y > uDim.y) break;
      tauU += sigmaOf(gridSample(uS, G(), q)) * 4.0 * uH;
      q.y += 4.0;
    }
  }
  float vort = gridSample(uC, G(), p).a;
  o0 = vec4(tau, tauU, occ > 0.0 ? 1.0 + vort : 0.0, pw * (uLook0.x * (1.0 - uLook0.w) * uLightP.z / 27.0));
}`;

// --- render: raymarch the domain box in the half-res FX pass ---------------------------------
export const RENDER_VERT = FX_VERT_HEAD + /* glsl */`
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const RENDER_FRAG = FX_FRAG_HEAD + '#define texture(s, p) textureLod(s, p, 0.0)\n' + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + GRID_GLSL + LOOK_GLSL + /* glsl */`
uniform sampler2D uS;
uniform sampler2D uL0;
uniform vec3 uDim;
uniform vec2 uTiles;
uniform vec2 uInv;
uniform vec3 uCDim;
uniform vec2 uCTiles;
uniform vec2 uCInv;
uniform vec3 uOrigin;
uniform float uH;
uniform vec4 uMarch;    // step (m), max steps, sub-grid amplitude (voxels), sub-grid frequency (tiles / m)
uniform vec4 uMarch2;   // edge fade (voxels), m per FX pixel at 1 m, bottom face open (0/1), -
uniform vec4 uLit;      // HG g, sun gain, sky gain, fire-light gain
uniform vec3 uSootColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec3 vWorld;

Grid G() { return Grid(uDim, uTiles, uInv); }
Grid CG() { return Grid(uCDim, uCTiles, uCInv); }

float gSunPh;
float gMs;     // multiple-scattering weight from the albedo
vec3 gFire;   // fire-light colour (blackbody at a typical flame-edge temperature) x gain
// per metre: extinction, in-scattered radiance (soot only), emitted radiance
// returns false in empty space (nothing within ~3 voxels)
bool sampleAt(vec3 pw, out float sg, out vec3 sc, out vec3 em) {
  sg = 0.0; sc = vec3(0.0); em = vec3(0.0);
  vec3 p = (pw - uOrigin) / uH;
  vec4 l0 = gridSample(uL0, CG(), p * 0.5);
  if (l0.b <= 0.0) return false;
  // sub-grid detail (in the spirit of wavelet turbulence): displace the lookup with band-limited
  // curl noise drifting up with the gas, strongest where the resolved flow is turbulent
  vec3 n = curl3(pw * uMarch.w + vec3(0.0, -uTime * 0.28, 0.0)) + 0.5 * curl3(pw * (uMarch.w * 2.03) + vec3(0.31, -uTime * 0.61, 0.17));
  vec4 s = gridSample(uS, G(), p + n * (uMarch.z * clamp(0.2 + max(l0.b - 1.0, 0.0) * 0.06, 0.2, 1.0)));
  // fade out towards the open faces so the box never shows
  vec3 e = min(p, uDim - p);
  float ed = min(min(e.x, e.z), uMarch2.z > 0.5 ? min(e.y, uDim.y - p.y) : uDim.y - p.y);
  // (the fade distance is jittered by the same noise, so a cloud that reaches a face frays
  // into wisps instead of showing a straight cut)
  float fade = smoothstep(0.5, uMarch2.x, ed + 1.6 * (n.x + n.z));
  s.rgb *= fade * fade;
  sg = sigmaOf(s);
  em = emitOf(s);
  float ss = uLook0.y * max(s.b, 0.0);
  if (ss < 1e-4) return true;
  // sun: single scattering through the precomputed optical depth, plus two wider, weaker octaves
  // standing in for multiple scattering (Wrenninge 2015); sky through the optical depth above
  float t = l0.r;
  // multiple-scattering octaves scale with albedo: dark soot barely scatters twice, so it keeps
  // its form shading (lit tops, near-black undersides) instead of glowing flat
  vec3 sun = uSunColor * uLit.y * (exp(-t) * gSunPh + gMs * (0.4 * exp(-0.5 * t) + 0.15 * exp(-0.25 * t)));
  vec3 sky = uAmbient * uLit.z * (0.1 + 0.9 * exp(-0.6 * l0.g));
  sc = ss * uSootColor * (sun + sky + gFire * l0.a);
  return true;
}

void main() {
  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 dd = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
  vec3 bmin = uOrigin, bmax = uOrigin + uDim * uH;
  vec3 ta = (bmin - cameraPosition) / dd, tb = (bmax - cameraPosition) / dd;
  vec3 lo = min(ta, tb), hi = max(ta, tb);
  float t0 = max(max(max(lo.x, lo.y), lo.z), 0.0), t1 = min(min(hi.x, hi.y), hi.z);
  float cosV = dot(rd, -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  t1 = min(t1, sceneViewZ() / cosV);
  if (t1 <= t0) discard;
  // step: a fraction of a voxel, never finer than the pixel footprint
  float target = max(uMarch.x, 0.5 * (t0 + t1) * uMarch2.y);
  int steps = int(clamp(ceil((t1 - t0) / target), 4.0, uMarch.y));
  float dt = (t1 - t0) / float(steps);
  float mu = dot(uSunDir, rd);
  // soot: forward lobe + a weak back lobe, normalised so isotropic = 1
  gSunPh = mix(hgPhase(mu, uLit.x), hgPhase(mu, -0.25), 0.25) * 4.0 * PI;
  gFire = blackbody(kelvinOf(0.75)) * uTint * uLit.w;
  gMs = clamp(dot(uSootColor, vec3(1.0)), 0.0, 1.0);
  float T = 1.0, zs = 0.0, ws = 0.0, sgP = 0.0, tP = t0;
  vec3 scat = vec3(0.0), emit = vec3(0.0), scP = vec3(0.0), emP = vec3(0.0);
  bool emptyP = true;
  int i = 0;
  for (int n = 0; n <= 256; n++) {
    if (T < 0.01) break;
    float t = t0 + float(i) * dt;
    float sg; vec3 sc, em;
    bool occ = sampleAt(cameraPosition + rd * t, sg, sc, em);
    if (i > 0) {
      // trapezoid slab between this sample and the previous one, energy conserving
      float L = t - tP, s = 0.5 * (sg + sgP);
      vec3 S = 0.5 * (sc + scP), E = 0.5 * (em + emP);
      if (s > 1e-5) {
        float tr = exp(-s * L), a = T * (1.0 - tr);
        scat += S * (a / s);
        emit += E * (a / s);
        zs += a * (t - 0.5 * L); ws += a;
        T *= tr;
      } else emit += T * E * L;
    }
    sgP = sg; scP = sc; emP = em; tP = t;
    if (i >= steps) break;
    i = min(i + (!occ && emptyP ? 2 : 1), steps);   // stride over empty space
    emptyP = !occ;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.002 && dot(emit, emit) < 1e-6) discard;
  float z = (ws > 0.0 ? zs / ws : t0) * cosV;
  fxOut(scat / max(alpha, 1e-4), alpha, emit, vec2(0.0), z);
}`;
