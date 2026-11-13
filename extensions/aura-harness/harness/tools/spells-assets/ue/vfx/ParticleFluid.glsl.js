import { COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, ARENA_GLSL, LIGHTS_GLSL, FORCES_GLSL, GROUND_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, ARENA } from './common.js';
import { REFRACT_GLSL } from './Refraction.js';
import { PAINT_FRAG_HEAD } from './GroundField.js';

// Shaders for ParticleFluid.js (see its header for the design). Grid conventions:
//  - each domain is a yaw-rotated box of nx x ny x nz cubic cells (size h), cell (0,0,0) at
//    uDomO.xyz; row y = 0 sits under the floor, so the floor is a solid boundary like any other
//  - MAC velocities: texel (i,j,k) holds u at the face x = i (centre (i, j+.5, k+.5)), v at y = j,
//    w at z = k, and the cell (i,j,k) itself (type, density, divergence, pressure). Texel indices
//    run 0..n on every axis (the last one only carries the far faces)
//  - the 3D grid lives in a 2D atlas: z-slices are tiles of (nx+1) x (ny+1) texels, uDomN.w per
//    row, one region of uRegionH rows per domain
//  - local velocities are m/s in the domain frame; pressure p is in m/s (v_face -= p_c - p_nbr)

export const MAXD = 2;          // live domains at once
export const MAX_REC = 48;      // emission records per frame
export const PW = 256;          // particle texture width (fluid and whitewater)
const f = (x) => x.toFixed(4);
const P = ARENA.pool;

const HEAD = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export const GRID_GLSL = /* glsl */`
#define MAXD ${MAXD}
uniform vec4 uDomO[MAXD];   // cell (0,0,0) corner (world), cell size h (m)
uniform vec4 uDomN[MAXD];   // nx, ny, nz, slice tiles per atlas row
uniform vec4 uDomR[MAXD];   // cos yaw, sin yaw, live generation + 1 (0 = free), life-box margin (m)
uniform vec4 uDomS[MAXD];   // particle spacing s (m), render radius (m), thickness scale, density drift gain (m/s)
uniform vec4 uDomF[MAXD];   // FLIP ratio, wind response, floor drain (1/s), whitewater amount
uniform vec2 uAtlas;
uniform float uRegionH;
// a particle's tag is domain + MAXD * generation: particles of a released domain die with it
int tagDomain(float tag) { return int(tag + 0.5) % MAXD; }
bool tagLive(float tag) { int t = int(tag + 0.5); return uDomR[t % MAXD].z == float(t / MAXD + 1); }
vec3 dirToLocal(int d, vec3 v) { vec2 r = uDomR[d].xy; return vec3(v.x * r.x + v.z * r.y, v.y, v.z * r.x - v.x * r.y); }
vec3 dirToWorld(int d, vec3 v) { vec2 r = uDomR[d].xy; return vec3(v.x * r.x - v.z * r.y, v.y, v.x * r.y + v.z * r.x); }
vec3 toLocal(int d, vec3 p) { return dirToLocal(d, p - uDomO[d].xyz) / uDomO[d].w; }
vec3 toWorld(int d, vec3 g) { return uDomO[d].xyz + dirToWorld(d, g * uDomO[d].w); }
ivec2 tileOrigin(int d, int k) {
  ivec4 n = ivec4(uDomN[d]);
  return ivec2((k % n.w) * (n.x + 1), d * int(uRegionH) + (k / n.w) * (n.y + 1));
}
ivec2 cellTexel(int d, ivec3 c) { return tileOrigin(d, c.z) + c.xy; }
bool texelCell(ivec2 px, out int d, out ivec3 c) {
  d = min(px.y / int(uRegionH), MAXD - 1);
  ivec4 n = ivec4(uDomN[d]);
  int y = px.y - d * int(uRegionH);
  int tx = px.x / (n.x + 1), ty = y / (n.y + 1);
  c = ivec3(px.x - tx * (n.x + 1), y - ty * (n.y + 1), ty * n.w + tx);
  return uDomR[d].z > 0.5 && tx < n.w && c.z <= n.z;
}
bool inCells(ivec3 c, ivec3 n) { return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, n)); }
`;

const STATE_GLSL = /* glsl */`
uniform highp sampler2D uS0;   // pos, age
uniform highp sampler2D uS1;   // vel, air (aeration 0..1)
uniform highp sampler2D uS2;   // life, tag, density (/ rest), floor contact
ivec2 texelOf(int i) { return ivec2(i % ${PW}, i / ${PW}); }
`;

// hardware-bilinear within a slice, lerp across slices; t in texel units (centres at integers)
const SAMPLE_GLSL = /* glsl */`
uniform highp sampler2D uVn;   // projected face velocities
uniform highp sampler2D uDV;   // their change this step (FLIP)
uniform highp sampler2D uD;    // divergence, density, solid mask, type
vec4 gridSample(highp sampler2D tex, int d, vec3 t) {
  vec3 n = uDomN[d].xyz;
  t = clamp(t, vec3(0.0), n);
  float k0 = min(floor(t.z), n.z - 1.0);
  vec2 a = vec2(tileOrigin(d, int(k0))) + t.xy + 0.5, b = vec2(tileOrigin(d, int(k0) + 1)) + t.xy + 0.5;
  return mix(textureLod(tex, a / uAtlas, 0.0), textureLod(tex, b / uAtlas, 0.0), t.z - k0);
}
vec3 gridVel(highp sampler2D tex, int d, vec3 g) {
  return vec3(gridSample(tex, d, g - vec3(0.0, 0.5, 0.5)).x,
              gridSample(tex, d, g - vec3(0.5, 0.0, 0.5)).y,
              gridSample(tex, d, g - vec3(0.5, 0.5, 0.0)).z);
}
float gridDensity(int d, vec3 g) { return gridSample(uD, d, g - 0.5).y; }
`;

export const FULL_VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// --- P2G: every particle splats momentum + weights into the 3x3x3 texels round its cell.
// One point (3x3 texels of a slice) per instance; instances 0..2 are the slices k-1..k+1.
export const P2G_VERT = HEAD + GRID_GLSL + STATE_GLSL + /* glsl */`
flat out vec3 vVel;
flat out vec3 vG;
flat out ivec2 vTile;
flat out ivec3 vN;
flat out int vK;
void main() {
  gl_PointSize = 3.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  ivec2 t = texelOf(gl_VertexID);
  vec4 s0 = texelFetch(uS0, t, 0), s2 = texelFetch(uS2, t, 0);
  if (s0.w >= s2.x || !tagLive(s2.y)) return;
  int d = tagDomain(s2.y);
  vec3 g = toLocal(d, s0.xyz);
  ivec3 n = ivec3(uDomN[d].xyz);
  ivec3 c = ivec3(floor(g));
  if (!inCells(c, n)) return;
  int k = c.z + gl_InstanceID - 1;
  if (k < 0 || k > n.z) return;
  vTile = tileOrigin(d, k);
  gl_Position = vec4((vec2(vTile + c.xy) + 0.5) / uAtlas * 2.0 - 1.0, 0.0, 1.0);
  vVel = dirToLocal(d, texelFetch(uS1, t, 0).xyz);
  vG = g; vN = n; vK = k;
}`;

export const P2G_FRAG = HEAD + /* glsl */`
flat in vec3 vVel;
flat in vec3 vG;
flat in ivec2 vTile;
flat in ivec3 vN;
flat in int vK;
layout(location = 0) out vec4 oA;   // sum v w (per face component), sum w (cell centre)
layout(location = 1) out vec4 oB;   // sum w (per face component)
float tri(float x) { return max(1.0 - abs(x), 0.0); }
void main() {
  ivec2 l = ivec2(gl_FragCoord.xy) - vTile;
  if (l.x < 0 || l.y < 0 || l.x > vN.x || l.y > vN.y) discard;
  vec3 q = vG - vec3(vec2(l), float(vK));
  float wu = tri(q.x) * tri(q.y - 0.5) * tri(q.z - 0.5);
  float wv = tri(q.x - 0.5) * tri(q.y) * tri(q.z - 0.5);
  float ww = tri(q.x - 0.5) * tri(q.y - 0.5) * tri(q.z);
  float wc = tri(q.x - 0.5) * tri(q.y - 0.5) * tri(q.z - 0.5);
  oA = vec4(vVel * vec3(wu, wv, ww), wc);
  oB = vec4(wu, wv, ww, 0.0);
}`;

// --- normalise + classify: air 0, fluid 1, solid 2 (arena SDF at the cell centre) ---------
export const MARK_FRAG = HEAD + COMMON_GLSL + ARENA_GLSL + GRID_GLSL + /* glsl */`
uniform highp sampler2D uAccA;
uniform highp sampler2D uAccB;
uniform float uFluidThresh;
out vec4 o;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int d; ivec3 c;
  if (!texelCell(px, d, c)) { o = vec4(0.0); return; }
  vec4 A = texelFetch(uAccA, px, 0), B = texelFetch(uAccB, px, 0);
  vec3 v = vec3(B.x > 1e-4 ? A.x / B.x : 0.0, B.y > 1e-4 ? A.y / B.y : 0.0, B.z > 1e-4 ? A.z / B.z : 0.0);
  float type = 0.0;
  if (inCells(c, ivec3(uDomN[d].xyz))) {
    if (arenaSDF(toWorld(d, vec3(c) + 0.5)) < 0.0) type = 2.0;
    else if (A.w > uFluidThresh) type = 1.0;
  }
  o = vec4(v, type);
}`;

// --- divergence (with gravity on the v faces), solid-face mask, density drift correction ----
export const DIV_FRAG = HEAD + GRID_GLSL + /* glsl */`
uniform highp sampler2D uV;
uniform highp sampler2D uAccA;
uniform float uGdt;
uniform float uPPC;
out vec4 o;
bool solidAt(int d, ivec3 c, ivec3 n) { return inCells(c, n) && texelFetch(uV, cellTexel(d, c), 0).w > 1.5; }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int d; ivec3 c;
  if (!texelCell(px, d, c)) { o = vec4(0.0); return; }
  vec4 V = texelFetch(uV, px, 0);
  float dens = texelFetch(uAccA, px, 0).w / uPPC;
  ivec3 n = ivec3(uDomN[d].xyz);
  if (!inCells(c, n) || V.w < 0.5 || V.w > 1.5) { o = vec4(0.0, dens, 0.0, V.w); return; }
  // the + neighbours' texels always exist (indices run to n); their .w is their type
  vec4 Vx = texelFetch(uV, cellTexel(d, c + ivec3(1, 0, 0)), 0);
  vec4 Vy = texelFetch(uV, cellTexel(d, c + ivec3(0, 1, 0)), 0);
  vec4 Vz = texelFetch(uV, cellTexel(d, c + ivec3(0, 0, 1)), 0);
  bool sxm = solidAt(d, c - ivec3(1, 0, 0), n), sym = solidAt(d, c - ivec3(0, 1, 0), n), szm = solidAt(d, c - ivec3(0, 0, 1), n);
  bool sxp = Vx.w > 1.5, syp = Vy.w > 1.5, szp = Vz.w > 1.5;
  float div = (sxp ? 0.0 : Vx.x) - (sxm ? 0.0 : V.x)
            + (syp ? 0.0 : Vy.y - uGdt) - (sym ? 0.0 : V.y - uGdt)
            + (szp ? 0.0 : Vz.z) - (szm ? 0.0 : V.z);
  // over-dense cells push apart (particle drift correction): target an outflow
  div -= uDomS[d].w * clamp(dens - 1.0, 0.0, 2.0);
  int mask = (sxm ? 1 : 0) | (sxp ? 2 : 0) | (sym ? 4 : 0) | (syp ? 8 : 0) | (szm ? 16 : 0) | (szp ? 32 : 0);
  int ns = 6 - int(sxm) - int(sxp) - int(sym) - int(syp) - int(szm) - int(szp);
  o = vec4(div, dens, float(mask + 64 * ns), 1.0);
}`;

// --- Jacobi on the pressure Poisson equation, free surface (air p = 0), Neumann at solids ----
export const JACOBI_FRAG = HEAD + GRID_GLSL + /* glsl */`
uniform highp sampler2D uP;
uniform highp sampler2D uDc;
uniform int uFirst;     // warm start from last step's pressure: ignore cells that stopped being fluid
out vec4 o;
float pAt(int d, ivec3 c, ivec3 n) {
  if (!inCells(c, n)) return 0.0;
  ivec2 t = cellTexel(d, c);
  float p = texelFetch(uP, t, 0).x;
  if (uFirst == 1) { float ty = texelFetch(uDc, t, 0).w; p *= float(ty > 0.5 && ty < 1.5); }
  return p;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int d; ivec3 c;
  if (!texelCell(px, d, c)) { o = vec4(0.0); return; }
  vec4 D = texelFetch(uDc, px, 0);
  if (D.w < 0.5 || D.w > 1.5) { o = vec4(0.0); return; }
  ivec3 n = ivec3(uDomN[d].xyz);
  int code = int(D.z + 0.5), mask = code & 63;
  float s = 0.0;
  if ((mask & 1) == 0) s += pAt(d, c - ivec3(1, 0, 0), n);
  if ((mask & 2) == 0) s += pAt(d, c + ivec3(1, 0, 0), n);
  if ((mask & 4) == 0) s += pAt(d, c - ivec3(0, 1, 0), n);
  if ((mask & 8) == 0) s += pAt(d, c + ivec3(0, 1, 0), n);
  if ((mask & 16) == 0) s += pAt(d, c - ivec3(0, 0, 1), n);
  if ((mask & 32) == 0) s += pAt(d, c + ivec3(0, 0, 1), n);
  o = vec4((s - D.x) / max(float(code >> 6), 1.0), 0.0, 0.0, 0.0);
}`;

// --- subtract the pressure gradient (+ gravity), zero solid faces; MRT new velocity + delta ---
export const PROJECT_FRAG = HEAD + GRID_GLSL + /* glsl */`
uniform highp sampler2D uV;
uniform highp sampler2D uP;
uniform float uGdt;
layout(location = 0) out vec4 oV;
layout(location = 1) out vec4 oD;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int d; ivec3 c;
  if (!texelCell(px, d, c)) { oV = oD = vec4(0.0); return; }
  ivec3 n = ivec3(uDomN[d].xyz);
  vec4 V = texelFetch(uV, px, 0);
  float pc = texelFetch(uP, px, 0).x;
  bool sc = V.w > 1.5;
  vec3 vn = V.xyz;
  vec4 Nx = vec4(0.0), Ny = vec4(0.0), Nz = vec4(0.0);
  float px_ = 0.0, py_ = 0.0, pz_ = 0.0;
  if (c.x > 0) { ivec2 t = cellTexel(d, c - ivec3(1, 0, 0)); Nx = texelFetch(uV, t, 0); px_ = texelFetch(uP, t, 0).x; }
  if (c.y > 0) { ivec2 t = cellTexel(d, c - ivec3(0, 1, 0)); Ny = texelFetch(uV, t, 0); py_ = texelFetch(uP, t, 0).x; }
  if (c.z > 0) { ivec2 t = cellTexel(d, c - ivec3(0, 0, 1)); Nz = texelFetch(uV, t, 0); pz_ = texelFetch(uP, t, 0).x; }
  vn.x = (sc || Nx.w > 1.5) ? 0.0 : V.x - (pc - px_);
  vn.y = (sc || Ny.w > 1.5) ? 0.0 : V.y - uGdt - (pc - py_);
  vn.z = (sc || Nz.w > 1.5) ? 0.0 : V.z - (pc - pz_);
  oV = vec4(vn, 0.0);
  oD = vec4(vn - V.xyz, 0.0);
}`;

// --- G2P (FLIP/PIC blend), RK2 advection through the grid, forces, collision, emission -------
export const ADVECT_FRAG = HEAD + COMMON_GLSL + ARENA_GLSL + FORCES_GLSL + GRID_GLSL + STATE_GLSL + SAMPLE_GLSL + /* glsl */`
#define MAX_REC ${MAX_REC}
uniform highp sampler2D uEmit;
uniform int uEmitCount;
uniform vec2 uSpan[4];
uniform int uSpanCount;
uniform float uSimDt;
uniform vec4 uHold[MAXD];     // centre, pull (1/s; 0 = off)
uniform vec4 uHoldB[MAXD];    // radius (m), swirl (rad/s), -, -
uniform vec4 uLaunch[MAXD];   // velocity (m/s), 1 = throw what's held this step
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
bool inPool(vec2 xz) { return all(lessThan(abs(xz - vec2(${f(P.center.x)}, ${f(P.center.y)})), vec2(${f(P.half.x)}, ${f(P.half.y)}))); }

// records (5 texels): (start, count, tag, type) (pos, radius) (dir, speed) (length|-, spread, radial, seed) (life, air, swirl, -)
bool tryEmit(int idx) {
  bool inSpan = false;
  for (int s = 0; s < 4; s++) {
    if (s >= uSpanCount) break;
    if (float(idx) >= uSpan[s].x && float(idx) < uSpan[s].y) { inSpan = true; break; }
  }
  if (!inSpan) return false;
  for (int r = 0; r < MAX_REC; r++) {
    if (r >= uEmitCount) break;
    vec4 e0 = texelFetch(uEmit, ivec2(0, r), 0);
    int j = idx - int(e0.x);
    if (j < 0 || j >= int(e0.y)) continue;
    vec4 e1 = texelFetch(uEmit, ivec2(1, r), 0), e2 = texelFetch(uEmit, ivec2(2, r), 0);
    vec4 e3 = texelFetch(uEmit, ivec2(3, r), 0), e4 = texelFetch(uEmit, ivec2(4, r), 0);
    float fj = float(j);
    vec3 h = hash31(e3.w * 7.31 + fj * 1.618);
    vec3 dir = normalize(e2.xyz + vec3(0.0, 1e-6, 0.0));
    vec3 pos, vel;
    if (e0.w < 0.5) {
      // jet: stratified over the nozzle disc (R2 sequence), spread over this step's stream length
      mat3 B = basisFrom(dir);
      float u1 = fract(fj * 0.7548777 + e3.w), u2 = fract(fj * 0.5698403 + e3.w * 1.37);
      float rr = sqrt(u1), a = u2 * 6.2831853;
      vec3 radial = B * vec3(cos(a), sin(a), 0.0);
      float along = (fj + h.x) / e0.y * e3.x;
      pos = e1.xyz + radial * rr * e1.w - dir * along;
      vel = dir * e2.w + radial * rr * e3.z + cross(dir, radial) * rr * e1.w * e4.z
          + (hash31(e3.w + fj * 0.37) - 0.5) * 2.0 * e3.y;
      vel.y -= 9.81 * along / max(e2.w, 1.0);
    } else {
      // ball: uniform in a sphere, base velocity + outward + random
      vec3 q = randomInSphere(h);
      pos = e1.xyz + q * e1.w;
      vel = dir * e2.w + q * e3.z + randomInSphere(hash31(e3.w * 3.1 + fj * 0.71)) * e3.y;
    }
    o0 = vec4(pos, 0.0);
    o1 = vec4(vel, e4.y);
    o2 = vec4(e4.x * mix(0.8, 1.2, h.z), e0.z, 1.0, 0.0);
    return true;
  }
  return false;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int idx = px.y * ${PW} + px.x;
  if (tryEmit(idx)) return;
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0), s2 = texelFetch(uS2, px, 0);
  if (s0.w >= s2.x || !tagLive(s2.y)) { o0 = vec4(0.0, -100.0, 0.0, 1.0); o1 = vec4(0.0); o2 = vec4(0.0); return; }
  int d = tagDomain(s2.y);
  float dt = uSimDt, h = uDomO[d].w;
  vec3 x = s0.xyz, v = s1.xyz;
  float air = s1.w, age = s0.w + dt, life = s2.x;
  vec3 g = toLocal(d, x), n = uDomN[d].xyz;
  vec3 disp;
  float dens = s2.z, turb = 0.0;   // outside the grid a particle keeps its last density
  if (all(greaterThanEqual(g, vec3(1.0))) && all(lessThanEqual(g, n - 1.0))) {
    vec3 vl = dirToLocal(d, v);
    vec3 vpic = gridVel(uVn, d, g);
    vec3 vflip = vl + gridVel(uDV, d, g);
    vec3 vnew = mix(vpic, vflip, uDomF[d].x);
    // RK2 through the grid where the midpoint has water; fast thin streams (CFL > 1 ahead of
    // a jet's head) and the grid edge move with the particle's own velocity
    vec3 gm = g + 0.5 * dt * vpic / h;
    float km = all(greaterThanEqual(gm, vec3(1.0))) && all(lessThanEqual(gm, n - 1.0)) ? smoothstep(0.05, 0.25, gridDensity(d, gm)) : 0.0;
    vec3 vmid = gridVel(uVn, d, gm);
    v = dirToWorld(d, vnew);
    disp = dirToWorld(d, mix(vnew, vmid, km)) * dt;
    dens = gridDensity(d, g);
    turb = length(vflip - vpic);
  } else {
    // outside the grid: ballistic
    disp = (v + vec3(0.0, -4.905 * dt, 0.0)) * dt;
    v.y -= 9.81 * dt;
  }
  // torn-off droplets (aerated, alone) feel the air: quadratic drag, terminal speed ~6 m/s
  float iso = 1.0 - smoothstep(0.08, 0.3, dens);
  v /= 1.0 + 0.27 * air * iso * length(v) * dt;
  // airborne water feels the wind and vortices; the bulk barely
  float kill = 0.0;
  float resp = uDomF[d].y * (1.0 - 0.85 * smoothstep(0.15, 0.7, dens));
  if (resp > 0.0) v += forceAccel(x, v, kill) * resp * dt;
  // hold (the gathering orb): pulled to the centre, swirling, weightless
  vec4 H = uHold[d];
  if (H.w > 0.0) {
    vec3 dc = H.xyz - x;
    float R = uHoldB[d].x, dl = length(dc);
    // fast water (a jet leaving the orb) is not held
    float w = (1.0 - smoothstep(R * 1.5, R * 4.0, dl)) * (1.0 - smoothstep(5.0, 9.0, length(v)));
    if (w > 0.0) {
      // pulled onto a ball of about R (not a point: outside a grid nothing holds it apart) that
      // wobbles as a held blob of water does, swirling
      vec3 dn = dc / max(dl, 1e-3);
      float wob = 1.0 + 0.22 * sin(dot(dn, vec3(2.3, 3.1, 1.7)) * 2.0 + uTime * 5.3) + 0.12 * sin(dot(dn, vec3(-3.7, 1.3, 2.9)) * 3.0 - uTime * 7.9);
      vec3 tgt = dc * H.w * max(1.0 - 0.6 * R * wob / max(dl, 1e-3), 0.0) + cross(vec3(0.0, 1.0, 0.0), dc) * uHoldB[d].y;
      v.y += 9.81 * dt * w;
      v = mix(v, tgt, w * (1.0 - exp(-dt * 7.0)));
      disp = mix(disp, v * dt, w);
    }
    if (uLaunch[d].w > 0.5 && w > 0.0) { v = uLaunch[d].xyz + (x - H.xyz) * 3.0; disp = v * dt; }
  }

  // collision with the arena (floor, rim, pillars, dummies, spikes): free slip + wet friction
  vec3 xn = x + disp;
  float r = uDomS[d].x * 0.5, impact = 0.0, contact = 0.0;
  if (dot(disp, disp) > r * r) { vec3 xm = x + disp * 0.5; if (arenaSDF(xm) < 0.0) xn = xm; }
  float sd = arenaSDF(xn);
  if (sd < r) {
    vec3 nrm = abs(sd - xn.y) < 1e-4 ? vec3(0.0, 1.0, 0.0) : arenaNormal(xn);
    xn += nrm * (r - sd);
    float vn = dot(v, nrm);
    if (vn < 0.0) { v -= nrm * vn; impact = -vn; }
    v -= (v - nrm * dot(v, nrm)) * min(1.5 * dt, 1.0);
    contact = 1.0;
  }
  // aeration: churn (FLIP vs PIC disagreement), impacts and raw speed trap air; it rises out
  air *= exp(-dt * 2.4);
  air = max(air, clamp(turb * 0.1 - 0.25, 0.0, 0.8));
  air = max(air, clamp((impact - 4.0) * 0.06, 0.0, 0.7));
  // a fast free stream roughens as it goes (turbulent breakup): glassy at the nozzle, not at 10 m
  air = max(air, clamp((length(v) - 9.0) * 0.012 * age, 0.0, 0.35) * (1.0 - smoothstep(0.3, 0.9, dens)));
  // puddles drain away (each particle at its own pace, so the sheet thins rather than pops)
  if (contact > 0.0 && xn.y < 0.5) age += dt * uDomF[d].z * life * (0.4 + 1.2 * hash12(vec2(px) + 0.5));
  // life box, the pool (it joins the pool), forces that kill
  vec3 gn = toLocal(d, xn);
  float m = uDomR[d].w / h;
  if (any(lessThan(gn, vec3(-m))) || any(greaterThan(gn, n + m)) || xn.y < -1.0) age = life;
  if (inPool(xn.xz) && xn.y < 0.02) age = life;
  if (kill > 0.5) age = life;
  o0 = vec4(xn, age);
  o1 = vec4(v, air);
  o2 = vec4(life, s2.y, dens, contact);
}`;

// --- whitewater (Ihmsen et al. 2012): spawned from aerated fluid particles, classified each
// step by the fluid density round them: spray (ballistic), foam (rides the flow, dissipates),
// bubbles (buoyant, dragged along) ----------------------------------------------------------
export const WHITE_FRAG = HEAD + COMMON_GLSL + ARENA_GLSL + FORCES_GLSL + GRID_GLSL + STATE_GLSL + SAMPLE_GLSL + /* glsl */`
uniform highp sampler2D uW0;   // pos, age
uniform highp sampler2D uW1;   // vel, life
uniform highp sampler2D uW2;   // tag, density, seed, -
uniform float uSimDt;
uniform float uFluidN;
uniform float uWhiteRate;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 w0 = texelFetch(uW0, px, 0), w1 = texelFetch(uW1, px, 0), w2 = texelFetch(uW2, px, 0);
  float dt = uSimDt;
  if (w0.w >= w1.w || !tagLive(w2.x)) {
    // a dead slot looks at one random fluid particle; trapped air makes it spawn here
    vec3 hh = hash33(vec3(vec2(px), mod(uFrame, 1009.0)));
    ivec2 t = texelOf(int(hh.x * uFluidN));
    vec4 s0 = texelFetch(uS0, t, 0), s1 = texelFetch(uS1, t, 0), s2 = texelFetch(uS2, t, 0);
    o0 = vec4(0.0, -100.0, 0.0, 1.0); o1 = vec4(0.0); o2 = vec4(0.0);
    if (s0.w < s2.x && tagLive(s2.y)) {
      int d = tagDomain(s2.y);
      float pot = s1.w * s1.w * uDomF[d].w;
      if (hh.y < pot * uWhiteRate * dt) {
        vec3 q = randomInSphere(hash33(hh * 91.7 + 3.1));
        float sp = length(s1.xyz);
        o0 = vec4(s0.xyz + q * uDomS[d].x, 0.0);
        o1 = vec4(s1.xyz * mix(0.9, 1.15, hh.z) + q * (0.4 + 0.08 * sp), mix(0.7, 2.4, fract(hh.z * 7.3)));
        o2 = vec4(s2.y, s2.z, hh.z, 0.0);
      }
    }
    return;
  }
  int d = tagDomain(w2.x);
  vec3 x = w0.xyz, v = w1.xyz;
  float age = w0.w + dt, life = w1.w;
  vec3 g = toLocal(d, x), n = uDomN[d].xyz;
  float dens = 0.0;
  vec3 vf = v;
  if (all(greaterThanEqual(g, vec3(1.0))) && all(lessThanEqual(g, n - 1.0))) {
    dens = gridDensity(d, g);
    vf = dirToWorld(d, gridVel(uVn, d, g));
  }
  float kill = 0.0;
  if (dens < 0.2 || length(v) > 6.0) {   // spray: ballistic, quadratic drag (mm droplets)
    v.y -= 9.81 * dt;
    v /= 1.0 + 0.3 * length(v) * dt;
    v += forceAccel(x, v, kill) * dt;
  } else if (dens < 0.7) {     // foam: advected by the fluid, decays
    v = mix(v, vf, 1.0 - exp(-dt * 14.0));
    age += dt * 0.35;
  } else {                     // bubble: buoyancy + drag towards the flow
    v += (vec3(0.0, 9.81 * 0.8, 0.0) + (vf - v) * 9.0) * dt;
    age -= dt * 0.5;
  }
  vec3 xn = x + v * dt;
  float sd = arenaSDF(xn);
  if (sd < 0.012) {
    vec3 nrm = abs(sd - xn.y) < 1e-4 ? vec3(0.0, 1.0, 0.0) : arenaNormal(xn);
    xn += nrm * (0.012 - sd);
    float vn = dot(v, nrm);
    if (vn < 0.0) v -= nrm * vn;
    v *= exp(-dt * 3.0);
  }
  vec3 gn = toLocal(d, xn);
  float m = uDomR[d].w / uDomO[d].w;
  if (any(lessThan(gn, vec3(-m))) || any(greaterThan(gn, n + m)) || kill > 0.5) age = life;
  o0 = vec4(xn, age);
  o1 = vec4(v, life);
  o2 = vec4(w2.x, mix(w2.y, dens, 0.5), w2.z, 0.0);
}`;

// --- screen-space fluid: velocity-stretched sphere sprites (capsules) -------------------------
const SPRITE_VERT = HEAD + GRID_GLSL + STATE_GLSL + /* glsl */`
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform float uShutter;   // s of motion stretch
in vec3 position;
out vec2 vQ;
flat out float vHalfL;
flat out float vR;
flat out float vCz;
flat out float vZHalf;
flat out float vDom;
flat out float vAir;
flat out float vThick;
flat out float vFlat;
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  ivec2 t = texelOf(gl_InstanceID);
  vec4 s0 = texelFetch(uS0, t, 0), s2 = texelFetch(uS2, t, 0);
  if (s0.w >= s2.x || !tagLive(s2.y)) return;
  int d = tagDomain(s2.y);
  vec4 s1 = texelFetch(uS1, t, 0);
  vec4 S = uDomS[d];
  // lone airborne particles are droplets (drawn as spray, DROP_VERT), thin water shrinks
  float iso = s2.w > 0.5 ? 1.0 : smoothstep(0.05, 0.12, s2.z);
  if (iso <= 0.0) return;
  // water spread thin on the floor is a film, not beads: its particles grow into flat discs that
  // overlap (same volume: thinner), so a draining puddle stays one sheet instead of scattered drops
  float film = s2.w * (1.0 - smoothstep(0.25, 0.7, s2.z));
  float k = 1.0 + 1.1 * film;
  float r = S.y * k * mix(0.5, 1.0, max(smoothstep(0.12, 0.5, s2.z), film)) * iso * smoothstep(0.0, 0.05, s0.w + 0.01) * min(1.0, (s2.x - s0.w) * 3.0 + 0.2);
  vec4 vc = viewMatrix * vec4(s0.xyz, 1.0);
  if (-vc.z < 0.2 + r) return;
  vec3 vv = mat3(viewMatrix) * s1.xyz * uShutter;
  float L = length(vv.xy);
  vec2 ax = L > 1e-6 ? vv.xy / L : vec2(1.0, 0.0);
  float Lc = min(L, 4.0 * r);
  vHalfL = 0.5 * Lc;
  vZHalf = L > 1e-6 ? 0.5 * vv.z * Lc / L : 0.0;
  vec2 q = vec2(position.x * (vHalfL + r), position.y * r);
  vec3 pv = vec3(vc.xy + ax * q.x + vec2(-ax.y, ax.x) * q.y, vc.z + abs(vZHalf) + r);
  gl_Position = projectionMatrix * vec4(pv, 1.0);
  vQ = q; vR = r; vCz = vc.z; vDom = float(d); vAir = s1.w; vThick = S.z / (k * k * k); vFlat = 1.0 - 0.7 * film;
}`;

const SPRITE_FRAG_HEAD = HEAD + /* glsl */`
in vec2 vQ;
flat in float vHalfL;
flat in float vR;
flat in float vCz;
flat in float vZHalf;
flat in float vDom;
flat in float vAir;
flat in float vThick;
flat in float vFlat;
float spriteD2() { float ux = max(abs(vQ.x) - vHalfL, 0.0); return (ux * ux + vQ.y * vQ.y) / (vR * vR); }
`;

export const DEPTH_VERT = SPRITE_VERT;
export const DEPTH_FRAG = SPRITE_FRAG_HEAD + /* glsl */`
uniform mat4 projectionMatrix;
out vec4 o;
void main() {
  float d2 = spriteD2();
  if (d2 > 1.0) discard;
  float along = vHalfL > 0.0 ? clamp(vQ.x / vHalfL, -1.0, 1.0) : 0.0;
  float z = vCz + along * vZHalf + vR * vFlat * sqrt(1.0 - d2);
  o = vec4(-z, vDom, 0.0, 0.0);
  vec4 c = projectionMatrix * vec4(0.0, 0.0, z, 1.0);
  gl_FragDepth = c.z / c.w * 0.5 + 0.5;
}`;

export const THICK_FRAG = SPRITE_FRAG_HEAD + /* glsl */`
out vec4 o;
void main() {
  float d2 = spriteD2();
  if (d2 > 1.0) discard;
  float th = 2.0 * vR * sqrt(1.0 - d2) * vThick;
  o = vec4(th, th * vAir, 0.0, 0.0);
}`;

// Narrow-range filter (Truong & Yuksel 2018), separable: taps behind the range are clamped to
// its back (which also rounds the silhouettes), taps in front of it are ignored.
export const SMOOTH_FRAG = HEAD + /* glsl */`
uniform highp sampler2D uZ;
uniform vec2 uDir;
uniform float uPxScale;    // half-res pixels per metre at 1 m
uniform float uWorldR;     // filter radius (m)
uniform float uRange;      // depth range (m)
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uZ, p, 0).r;
  if (z <= 0.0) { o = vec4(0.0); return; }
  float rpx = clamp(uWorldR * uPxScale / z, 1.0, 24.0);
  float stepPx = max(1.0, rpx / 8.0);
  float inv2s2 = 1.0 / (0.5 * rpx * rpx);
  float lim = z + uRange, lo = z - uRange;
  ivec2 m = textureSize(uZ, 0) - 1;
  float sum = z, ws = 1.0;
  for (int i = 1; i <= 8; i++) {
    float o_ = float(i) * stepPx;
    if (o_ > rpx) break;
    float w = exp(-o_ * o_ * inv2s2);
    ivec2 dp = ivec2(uDir * o_);
    float a = texelFetch(uZ, clamp(p + dp, ivec2(0), m), 0).r;
    float b = texelFetch(uZ, clamp(p - dp, ivec2(0), m), 0).r;
    a = a <= 0.0 ? lim : min(a, lim);
    b = b <= 0.0 ? lim : min(b, lim);
    if (a >= lo) { sum += a * w; ws += w; }
    if (b >= lo) { sum += b * w; ws += w; }
  }
  o = vec4(sum / ws, 0.0, 0.0, 0.0);
}`;

// view-space normal from the smoothed depth (the one-sided difference with the smaller jump)
export const NORMAL_FRAG = HEAD + /* glsl */`
uniform highp sampler2D uZ;
uniform vec2 uProj;        // projection [0][0], [1][1]
out vec4 o;
vec3 viewPos(ivec2 p, float z, vec2 size) {
  vec2 ndc = (vec2(p) + 0.5) / size * 2.0 - 1.0;
  return vec3(ndc.x * z / uProj.x, ndc.y * z / uProj.y, -z);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uZ, p, 0).r;
  if (z <= 0.0) { o = vec4(0.0); return; }
  vec2 size = vec2(textureSize(uZ, 0));
  ivec2 m = ivec2(size) - 1;
  vec3 P = viewPos(p, z, size);
  float zr = texelFetch(uZ, min(p + ivec2(1, 0), m), 0).r, zl = texelFetch(uZ, max(p - ivec2(1, 0), ivec2(0)), 0).r;
  float zu = texelFetch(uZ, min(p + ivec2(0, 1), m), 0).r, zd = texelFetch(uZ, max(p - ivec2(0, 1), ivec2(0)), 0).r;
  bool useR = zr > 0.0 && (zl <= 0.0 || abs(zr - z) < abs(zl - z));
  bool useU = zu > 0.0 && (zd <= 0.0 || abs(zu - z) < abs(zd - z));
  vec3 dx = useR ? viewPos(p + ivec2(1, 0), zr, size) - P : (zl > 0.0 ? P - viewPos(p - ivec2(1, 0), zl, size) : vec3(1.0, 0.0, 0.0));
  vec3 dy = useU ? viewPos(p + ivec2(0, 1), zu, size) - P : (zd > 0.0 ? P - viewPos(p - ivec2(0, 1), zd, size) : vec3(0.0, 1.0, 0.0));
  vec3 nrm = normalize(cross(dx, dy));
  if (nrm.z < 0.0) nrm = -nrm;
  o = vec4(nrm, z);
}`;

// --- composite (refract pass, full res): Ultra Water's surface shading on the SSF surface ----
// (github.com/Humpalumps/Ultra-Water, MIT): depth-validated refraction, Beer-Lambert absorption,
// in-scatter + Atlas-style SSS on thin sheets, roughness-aware Fresnel (Lagarde), GGX sun with
// the alpha floor, foam lit as in OceanSurface (here: aeration of the churned body).
export const COMPOSITE_VERT = /* glsl */`
uniform vec4 uRect;   // NDC min xy, max xy
void main() { gl_Position = vec4(mix(uRect.xy, uRect.zw, position.xy * 0.5 + 0.5), 0.0, 1.0); }`;

export const COMPOSITE_FRAG = /* glsl */`
#define MAXD ${MAXD}
uniform highp sampler2D uNZ;      // half res: view normal, linear depth (0 = empty)
uniform highp sampler2D uThick;   // half res: thickness (m), thickness x air
uniform highp sampler2D uDomTex;  // half res raw depth: depth, domain
uniform vec2 uSsf;                // half-res size
uniform mat4 uCamWorld;
uniform vec2 uProj;
uniform vec4 uLook0[MAXD];        // absorption (1/m), roughness
uniform vec4 uLook1[MAXD];        // scatter albedo, refraction strength
uniform vec4 uLook2[MAXD];        // emission (HDR), aeration amount
uniform vec4 uLook3[MAXD];        // foam tint, SSS strength
uniform sampler2D uFoamTex;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
${COMMON_GLSL}
${NOISE_GLSL}
${WORLD_GLSL}
${LIGHTS_GLSL}
${REFRACT_GLSL}
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 hp = uv * uSsf - 0.5;
  ivec2 b = ivec2(floor(hp));
  vec2 fr = hp - vec2(b);
  ivec2 m = ivec2(uSsf) - 1;
  vec4 t0 = texelFetch(uNZ, clamp(b, ivec2(0), m), 0), t1 = texelFetch(uNZ, clamp(b + ivec2(1, 0), ivec2(0), m), 0);
  vec4 t2 = texelFetch(uNZ, clamp(b + ivec2(0, 1), ivec2(0), m), 0), t3 = texelFetch(uNZ, clamp(b + ivec2(1, 1), ivec2(0), m), 0);
  vec4 w = vec4((1.0 - fr.x) * (1.0 - fr.y), fr.x * (1.0 - fr.y), (1.0 - fr.x) * fr.y, fr.x * fr.y);
  vec4 valid = vec4(step(1e-6, t0.w), step(1e-6, t1.w), step(1e-6, t2.w), step(1e-6, t3.w));
  float cov = dot(w, valid);
  if (cov < 0.3) discard;
  // nearest surface wins across depth edges (a droplet in front of the column)
  float zmin = min(min(t0.w > 0.0 ? t0.w : 1e9, t1.w > 0.0 ? t1.w : 1e9), min(t2.w > 0.0 ? t2.w : 1e9, t3.w > 0.0 ? t3.w : 1e9));
  vec4 near = valid * step(vec4(t0.w, t1.w, t2.w, t3.w), vec4(zmin + 0.12 + 0.02 * zmin));
  vec4 ww = w * near;
  ww /= max(dot(ww, vec4(1.0)), 1e-5);
  vec4 nz = t0 * ww.x + t1 * ww.y + t2 * ww.z + t3 * ww.w;
  float z = nz.w;
  // the opaque scene in front hides it (the hardware depth test does the per-sample edge)
  float sceneZ = linearDepth(texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r);
  if (z > sceneZ + 0.05) discard;
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 Pv = vec3(ndc.x * z / uProj.x, ndc.y * z / uProj.y, -z);
  vec3 Pw = (uCamWorld * vec4(Pv, 1.0)).xyz;
  vec3 N = normalize((uCamWorld * vec4(normalize(nz.xyz), 0.0)).xyz);
  ivec2 nb = clamp(ivec2(floor(uv * uSsf)), ivec2(0), m);
  int d = int(texelFetch(uDomTex, nb, 0).g + 0.5);
  vec4 L0 = uLook0[d], L1 = uLook1[d], L2 = uLook2[d], L3 = uLook3[d];
  vec2 th = texture(uThick, uv).rg;
  float air = clamp(th.y / max(th.x, 1e-4), 0.0, 1.0);
  vec3 V = normalize(cameraPosition - Pw);
  // a film spread on the floor is flat (gravity and surface tension level it within a second), not
  // the union of its particles' discs: level its normal, and no light comes up through the floor
  float film = (1.0 - smoothstep(0.05, 0.2, Pw.y)) * (1.0 - smoothstep(0.06, 0.25, th.x));
  N = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.9 * film));
  // capillary ripples riding the flow: the surface never reads as polished glass
  vec3 rip = curl3(Pw * 0.55 + vec3(0.0, uTime * 0.35, 0.0)) + 0.5 * curl3(Pw * 1.7 - vec3(uTime * 0.5, 0.0, 0.0));
  N = normalize(N + (rip - N * dot(rip, N)) * (0.07 + 0.12 * air) * (1.0 - 0.6 * film));
  float NoV = max(dot(N, V), 1e-3);
  float rough = L0.w + 0.12 * air;

  // --- refraction + absorption (depth validated, as Refraction.js / the pool) ----------------
  float behind;
  vec3 refr = sceneRefract(Pw, N, V, 1.33, th.x * L1.w + 0.03, behind);
  float path = min(th.x, behind * 1.15 + 0.01);
  vec3 T = exp(-L0.rgb * path);
  // caustics: light focused by the water on whatever it lies on
  float cz = linearDepth(texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r);
  vec3 floorP = cameraPosition - V * (cz / max(dot(-V, (uCamWorld * vec4(0.0, 0.0, -1.0, 0.0)).xyz), 0.05));
  vec2 cq = floorP.xz * 4.0 + N.xz * 3.0;
  vec2 cw = cq + vec2(sin(cq.y * 1.3 + uTime * 1.7), cos(cq.x * 1.1 - uTime * 1.4));
  float caus = pow(1.0 - abs(sin(cw.x) * sin(cw.y)), 6.0);
  refr *= 1.0 + caus * 1.6 * smoothstep(0.02, 0.15, path) * exp(-path * 2.0) * max(uSunDir.y, 0.0) * step(floorP.y, 0.08);

  vec3 sun = uSunColor;
  vec3 amb = uAmbient * 1.5;
  float NoL = dot(N, uSunDir);
  vec3 inscatter = L1.rgb * (amb + sun * max(uSunDir.y, 0.0) * 0.5);
  // Atlas-style SSS (UW): sun through thin sheets and crests, strongest looking into it
  float thin = 1.0 - smoothstep(0.02, 0.45, path);
  float into = pow(clamp(dot(uSunDir, -V), 0.0, 1.0), 4.0);
  float k1 = L3.w * thin * into * pow(0.5 - 0.5 * NoL, 3.0) * 6.0 * (1.0 - film);
  float k2 = 0.06 * NoV * NoV;
  vec3 sss = ((k1 + k2) * sun + 0.05 * max(NoL, 0.0) * sun) * L1.rgb * 8.0;
  vec3 body = refr * T + (inscatter + sss) * (1.0 - T) + sss * thin * 0.5 * (1.0 - film);

  // aeration: churned water is a white scattering medium (UW's foam lighting, billows from its
  // foam texture so it reads as froth, not paint)
  vec4 ft = texture(uFoamTex, Pw.xz * 0.35 + Pw.y * 0.21 + vec2(0.0, uTime * 0.05));
  float milk = (1.0 - exp(-air * path * 6.0)) * L2.w;
  milk *= mix(0.55, 1.15, ft.r);
  milk = clamp(milk, 0.0, 1.0);
  vec3 sd, ss;
  gLightNoShadow = true;
  spellLightPBR(Pw, N, V, max(rough, 0.05), vec3(0.02), vec3(0.9) * milk, sd, ss);
  float ao = mix(0.55, 1.0, smoothstep(0.15, 0.75, ft.g));
  vec3 foamLit = mix(L3.rgb, vec3(0.95), milk) * (sun * (0.15 + 0.85 * clamp(NoL * 0.8 + 0.2, 0.0, 1.0)) * mix(ao, 1.0, 0.4) + amb * 1.4 * ao);
  foamLit += sun * into * 0.4 * (1.0 - milk);
  body = mix(body, foamLit, milk) + sd;

  // Fresnel with roughness-aware F90 (Lagarde), sky reflection, GGX sun with an alpha floor
  float F = fresnelRough(NoV, 0.02, rough);
  vec3 R = reflect(-V, N);
  vec3 refl = envReflect(R, rough);
  float aS = max(rough * rough, 0.012);
  vec3 H = normalize(uSunDir + V);
  float nl = max(NoL, 0.0);
  vec3 spec = sun * (PI * spellD_GGX(max(dot(N, H), 0.0), aS) * spellV_Smith(NoV, nl, aS) * nl * fresnel(max(dot(V, H), 0.0), 0.02)) + ss;
  vec3 col = mix(body, refl, F * (1.0 - 0.6 * milk)) + spec * (1.0 - 0.5 * milk) + L2.rgb * (1.0 - T.g);
  // soft edge: the bilinear half-res coverage, rounded by the (smooth) summed thickness
  fragColor = vec4(col, smoothstep(0.32, 0.62, cov) * smoothstep(0.002, 0.012, th.x));
  vec4 cp = projectionMatrix * vec4(Pv, 1.0);
  gl_FragDepth = cp.z / cp.w * 0.5 + 0.5;
}`;

// --- whitewater sprites (fx pass, WBOIT); the same for the fluid's own torn-off droplets -----
const whiteVert = () => FX_VERT_HEAD + COMMON_GLSL + NOISE_GLSL + ARENA_GLSL + LIGHTS_GLSL + GRID_GLSL + /* glsl */`
uniform highp sampler2D uW0;
uniform highp sampler2D uW1;
uniform highp sampler2D uW2;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec4 uWhiteLook;   // size scale, opacity, -, -
out vec2 vUv;
out vec3 vLit;
out float vAlpha;
out float vViewZ;
out float vKind;
out float vSeed;
out float vStretch;
out vec2 vFoamUv;
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAlpha = 0.0;
  ivec2 t = ivec2(gl_InstanceID % ${PW}, gl_InstanceID / ${PW});
  vec4 w0 = texelFetch(uW0, t, 0), w1 = texelFetch(uW1, t, 0), w2 = texelFetch(uW2, t, 0);
  if (w0.w >= w1.w || !tagLive(w2.x)) return;
  vec3 P = w0.xyz, Vel = w1.xyz;
  float age = w0.w / w1.w, dens = w2.y, seed = w2.z, amt = 1.0;
  // foam only lies on a surface near the floor; in the air the same churn is just more spray
  float kind = (dens < 0.2 || length(Vel) > 6.0 || (dens < 0.7 && P.y > 0.35)) ? 0.0 : dens < 0.7 ? 1.0 : 2.0;
  float size = kind < 0.5 ? 0.0018 + 0.0028 * seed : kind < 1.5 ? (0.05 + 0.08 * seed) * (0.7 + 0.6 * age) : 0.006 + 0.006 * seed;
  size *= uWhiteLook.x;
  vec3 cv = (viewMatrix * vec4(P, 1.0)).xyz;
  float viewZ = -cv.z;
  if (viewZ < 0.3) return;
  // at least ~1.2 half-res pixels wide; keep the energy (Humus' phone-wire AA)
  float px = 2.0 * viewZ / (projectionMatrix[1][1] * uFxResolution.y);
  float wdt = max(size, 1.2 * px), aa = size / wdt;
  // a 1/60 s exposure: spray streaks, foam barely
  vec3 vv = mat3(viewMatrix) * Vel * (kind < 0.5 ? 0.004 : 0.003);
  float L = min(length(vv.xy), 40.0 * wdt);
  vec2 ax = length(vv.xy) > 1e-6 ? normalize(vv.xy) : vec2(1.0, 0.0);
  vec2 q = ax * position.x * (wdt + 0.5 * L) + vec2(-ax.y, ax.x) * position.y * wdt;
  vFoamUv = P.xz;
  if (kind > 0.5 && kind < 1.5) {
    // foam lies on the water: a flat patch on it (edge-on from a low camera, as real lace is), its
    // lace from one world-space texture so overlapping patches join into one sheet of foam
    vec3 corner = P + vec3(position.x, 0.0, -position.y) * size * 1.6;   // counter-clockwise from above
    vFoamUv = corner.xz;
    cv = (viewMatrix * vec4(corner, 1.0)).xyz;
    q = vec2(0.0);
  }
  // foam and bubbles sit at the surface: pull them in front of it (the composite wrote its depth)
  cv.z += kind > 0.5 ? 0.06 + size : 0.0;
  gl_Position = projectionMatrix * vec4(cv + vec3(q, 0.0), 1.0);
  vUv = position.xy;
  vStretch = (kind > 0.5 && kind < 1.5) ? 0.0 : L / (L + 2.0 * wdt);
  vViewZ = viewZ;
  vKind = kind;
  vSeed = seed;
  vec3 v = normalize(cameraPosition - P);
  gLightNoShadow = true;
  // droplets scatter forward (UW's spray billboard); foam is a white diffuse surface
  float ph = hgPhase(dot(uSunDir, -v), 0.6);
  vec3 lit = kind < 0.5 ? 0.9 * (uSunColor * (0.25 + 1.6 * ph) + uAmbient * 1.4)
                        : 0.92 * (uSunColor * (0.3 + 0.7 * max(uSunDir.y, 0.0)) + uAmbient * 2.2);
  vLit = lit + spellLightScatter(P, v, 0.3) * 0.6;
  float fade = smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.55, 1.0, age));
  // a streak spreads its light over its length
  float smear = (2.0 * wdt) / (L + 2.0 * wdt);
  vAlpha = (kind < 0.5 ? 0.55 * mix(1.0, smear, 0.6) : kind < 1.5 ? 0.85 : 0.35) * amt * fade * aa * uWhiteLook.y * smoothstep(0.3, 0.9, viewZ);
}`;
export const WHITE_VERT = whiteVert();

// --- beads: a droplet is a small lens. Instanced quads in the refract pass, full res, shaded as a
// sphere of water: sky mirrored on the skin, the world seen upside down through it, a pin-sharp sun
// glint. Ligaments are the same thing stretched along their velocity. Used by the fluid's lone
// particles (BEAD_VERT) and by water.js's stateless stream droplets (place with BEAD_PLACE_GLSL).
export const BEAD_PLACE_GLSL = /* glsl */`
out vec2 vUv;
out vec3 vP;
flat out vec2 vAx;
flat out float vStretch;
flat out float vAlpha;
flat out float vRad;
// amt: 0..1 fade, lig: extra length (m) while it is still a ligament
void placeBead(vec3 P, vec3 Vel, float size, float amt, float lig) {
  vec3 cv = (viewMatrix * vec4(P, 1.0)).xyz;
  float viewZ = -cv.z;
  if (viewZ < 0.3) return;
  float px = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float w = max(size, 0.8 * px), aa = size / w;
  // a fast shutter (1/400 s): beads, not matchsticks
  vec3 vv = mat3(viewMatrix) * Vel * 0.0025;
  float lv = length(vv.xy), L = min(lv + lig, 16.0 * w);
  vec2 ax = lv > 1e-6 ? vv.xy / lv : vec2(1.0, 0.0);
  vec2 q = ax * position.x * (w + 0.5 * L) + vec2(-ax.y, ax.x) * position.y * w;
  gl_Position = projectionMatrix * vec4(cv + vec3(q, 0.0), 1.0);
  vUv = position.xy;
  vP = P;
  vAx = ax;
  vStretch = L / (L + 2.0 * w);
  vRad = w / px;   // radius (full-res pixels)
  vAlpha = amt * mix(0.3, 1.0, aa) * smoothstep(0.3, 0.8, viewZ);
}
`;

export const BEAD_VERT = COMMON_GLSL + GRID_GLSL + STATE_GLSL + BEAD_PLACE_GLSL + /* glsl */`
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAlpha = 0.0;
  ivec2 t = texelOf(gl_InstanceID);
  // a lone airborne fluid particle is a droplet, not surface
  vec4 s0 = texelFetch(uS0, t, 0), s2 = texelFetch(uS2, t, 0);
  if (s0.w >= s2.x || !tagLive(s2.y) || s2.w > 0.5) return;
  float amt = 1.0 - smoothstep(0.05, 0.12, s2.z);
  if (amt <= 0.0) return;
  float seed = hash12(vec2(t) + 0.5);
  float size = uDomS[tagDomain(s2.y)].x * mix(0.12, 0.42, seed * seed);
  placeBead(s0.xyz, texelFetch(uS1, t, 0).xyz, size, amt * smoothstep(0.0, 0.03, s0.w) * min(1.0, (s2.x - s0.w) * 4.0), 0.0);
}`;

export const BEAD_FRAG = COMMON_GLSL + REFRACT_GLSL + /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec2 vUv;
in vec3 vP;
flat in vec2 vAx;
flat in float vStretch;
flat in float vAlpha;
flat in float vRad;
out vec4 fragColor;
void main() {
  if (vAlpha <= 0.002) discard;
  // the capsule's cross section: x beyond the stretched body are the round ends
  float qx = sign(vUv.x) * max(abs(vUv.x) - vStretch, 0.0) / max(1.0 - vStretch, 1e-3);
  float r2 = qx * qx + vUv.y * vUv.y;
  if (r2 >= 1.0) discard;
  vec3 nv = vec3(vAx * qx + vec2(-vAx.y, vAx.x) * vUv.y, sqrt(1.0 - r2));
  vec3 N = transpose(mat3(viewMatrix)) * nv;
  vec3 V = normalize(cameraPosition - vP);
  float F = fresnel(nv.z, 0.02);
  vec3 refl = envReflect(reflect(-V, N), 0.08);
  // through the sphere: in, out the far side (exit normal n + rd * chord), so the world is inverted
  vec3 rd = refract(-V, N, 1.0 / 1.33);
  vec3 n2 = normalize(N - 2.0 * rd * dot(rd, N));
  vec3 od = refract(rd, -n2, 1.33);
  if (dot(od, od) < 1e-4) od = reflect(rd, -n2);
  // what is behind it, upside down, plus a little of the wider world it gathers from
  vec2 uv = (gl_FragCoord.xy - nv.xy * vRad * 5.0) / uResolution;
  vec3 through = mix(textureLod(uSceneColor, clamp(uv, vec2(0.001), vec2(0.999)), 0.0).rgb, envReflect(od, 0.14), 0.2);
  vec3 H = normalize(uSunDir + V);
  float glint = pow(max(dot(N, H), 0.0), 700.0) * 26.0 * step(0.0, uSunDir.y);
  // a drop is full of internal reflections: it scatters the sun strongly forward and the sky all
  // round, so in footage spray reads as bright points, never as holes. (The scene behind is the
  // opaque one: a bead over the fluid surface must not show the floor under the water.)
  float ph = hgPhase(dot(uSunDir, -V), 0.75);
  vec3 lit = uSunColor * (0.1 + 1.4 * ph) + uAmbient * 0.35;
  fragColor = vec4(mix(through, refl, F) * 0.8 + lit + uSunColor * glint, vAlpha * (1.0 - smoothstep(0.75, 1.0, r2)));
}`;

export const WHITE_SPRITE_FRAG = FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + /* glsl */`
uniform sampler2D uFoamTex;
in vec2 vUv;
in vec3 vLit;
in float vAlpha;
in float vViewZ;
in float vKind;
in float vSeed;
in float vStretch;
in vec2 vFoamUv;
void main() {
  if (vAlpha <= 0.002) discard;
  float x = abs(vUv.x), ends = 1.0 - vStretch;
  float dx = max(x - vStretch, 0.0) / max(ends, 1e-3);
  float r2 = dx * dx + vUv.y * vUv.y;
  if (r2 >= 1.0) discard;
  float a = vAlpha;
  if (vKind > 0.5 && vKind < 1.5) {
    // foam: UW's lace/billow texture in world space, so neighbouring patches make one sheet
    // (lace cells a few cm across, so a patch shows lace, not a white coin)
    vec4 ft = texture(uFoamTex, vFoamUv * 1.6);
    a *= smoothstep(1.0, 0.3, r2) * smoothstep(0.45, 0.8, ft.r * 0.75 + ft.g * 0.45);
  } else a *= exp(-2.5 * r2);
  fxOut(vLit, a, vec3(0.0), vec2(0.0), vViewZ);
}`;

// --- ground paint: fluid touching the floor wets it (GroundField particle paint) --------------
export const PAINT_VERT = HEAD + GRID_GLSL + STATE_GLSL + GROUND_GLSL + /* glsl */`
uniform vec4 uPaintA[MAXD];   // per-step increments: heat, char, wet, frost
uniform vec4 uPaintB[MAXD];   // crack, acid, corruption, glow
uniform float uTexelsPerM;
out vec4 vA;
out vec4 vB;
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 1.0;
  vA = vB = vec4(0.0);
  ivec2 t = texelOf(gl_VertexID);
  vec4 s0 = texelFetch(uS0, t, 0), s2 = texelFetch(uS2, t, 0);
  if (s0.w >= s2.x || !tagLive(s2.y) || s2.w < 0.5 || s0.y > 0.25) return;
  int d = tagDomain(s2.y);
  vec2 uv = groundUV(s0.xz);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = clamp(2.0 * uDomS[d].y * uTexelsPerM, 1.0, 8.0);
  vec4 g = groundA(s0.xz), gb = groundB(s0.xz);
  vA = uPaintA[d] * max(1.0 - g, 0.0);
  vB = uPaintB[d] * max(1.0 - gb, 0.0);
}`;

export const PAINT_FRAG = HEAD + PAINT_FRAG_HEAD + /* glsl */`
in vec4 vA;
in vec4 vB;
void main() {
  float f = 1.0 - length(gl_PointCoord * 2.0 - 1.0);
  if (f <= 0.0) discard;
  gA = vA * f; gB = vB * f;
}`;

// Ultra Water's foam texture (bakeTextures.js, MIT): R lace, G billow height, BA its gradient
export const FOAM_BAKE_FRAG = HEAD + /* glsl */`
uniform vec2 uSize;
out vec4 outColor;
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec2 voronoi(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 o = hash22(mod(i + g, period));
    float d = length(g + o - f);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return vec2(f1, f2);
}
float billow(vec2 uv) {
  vec2 a = voronoi(uv * 7.0 + 0.3, 7.0), b = voronoi(uv * 17.0 + 0.7, 17.0), c = voronoi(uv * 41.0 + 0.1, 41.0);
  return 0.5 * sqrt(clamp((a.y - a.x) * 2.2, 0.0, 1.0)) + 0.32 * sqrt(clamp((b.y - b.x) * 2.2, 0.0, 1.0))
       + 0.18 * sqrt(clamp((c.y - c.x) * 2.2, 0.0, 1.0));
}
void main() {
  vec2 vUv = gl_FragCoord.xy / uSize;
  vec2 a = voronoi(vUv * 9.0, 9.0);
  vec2 b = voronoi(vUv * 23.0 + 0.5, 23.0);
  vec2 c = voronoi(vUv * 61.0, 61.0);
  float lace = 1.0 - smoothstep(0.0, 0.22, a.y - a.x);
  float fine = 1.0 - smoothstep(0.0, 0.16, b.y - b.x);
  float bubbles = smoothstep(0.55, 0.15, c.x);
  float v = lace * 0.55 + fine * 0.3 + bubbles * 0.25 + (1.0 - a.x) * 0.25;
  float e = 1.0 / uSize.x;
  vec2 g = vec2(billow(vUv + vec2(e, 0.0)) - billow(vUv - vec2(e, 0.0)), billow(vUv + vec2(0.0, e)) - billow(vUv - vec2(0.0, e))) / (2.0 * e);
  outColor = vec4(clamp(v * 0.85, 0.0, 1.0), billow(vUv), clamp(0.5 + g / 64.0, 0.0, 1.0));
}`;
