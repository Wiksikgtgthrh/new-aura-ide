import * as THREE from 'three';
import { GROUND_GLSL, COMMON_GLSL, NOISE_GLSL, ARENA, arenaSDF, arenaRaycast } from '../vfx/common.js';
import { REFRACT_GLSL } from '../vfx/Refraction.js';
import { ParticleFluid, foamTexture } from '../vfx/ParticleFluid.js';
import { BEAD_PLACE_GLSL, BEAD_FRAG } from '../vfx/ParticleFluid.glsl.js';
import { SHADE } from './water/tsunami.glsl.js';

// Water (PLAN 3). What the footage of a fire hose, a water cannon, Old Faithful and a blowhole shows
// is three different things, so each gets the tool that can actually draw it:
//  - the coherent stream is a ballistic tube mesh in the refract pass (all tiers, one draw, crisp
//    MSAA edges): every ring is the water after tau seconds of free flight, so the arc, the hose
//    whip running down it, the geyser flaring as it slows (continuity) and the tail flying on after
//    letting go are all the same function. Glass rod at the nozzle (a real cylinder lens: inverted
//    background, Beer-Lambert over the chord, Ultra Water's Fresnel sky and GGX sun); downstream the
//    surface roughens, bubbles cloud the core, and it tears into holes along the flow. FLIP cannot do
//    this part: a 32 m/s stream crosses 6 cells a step, so the grid only scatters it.
//  - what water does when it hits something is simulated: the shared GPU FLIP fluid (fx.water) takes
//    over at the target (medium and up): sheets round the dummy, the flood on the floor, the chunks
//    falling back round the geyser. A small domain, so all its resolution is where the water lands.
//  - droplets and ligaments are real little lenses (beads, refract pass): stateless ones torn off
//    the stream and thrown from the hit, plus the fluid's own lone particles. Ballistic with drag.
// Charge: the focus orb's plasma dims and is replaced by a wobbling ball of water (a ball lens),
// droplets arcing into it out of the pool. Low tier (phones): no FLIP, no extra passes: stream,
// beads and rings all draw in the refract pass that already exists, the shared particles do the rest.
// Around it: mist and spray only at the torn edges, Cauchy-Poisson ripple rings on the wet floor,
// pool ripples, dummy wet status and hits, lens droplets, steam off hot puddles.

const G = 9.81;
const MAX_RINGS = 8;
const MAX_STREAMS = 12;     // instances: a live cast draws a ball and a stream (a geyser: a bundle of them)
const BEAD_STREAMS = 4;     // streams shedding beads at once
const POOL = ARENA.pool;
const POOL_SRC = new THREE.Vector3(8.4, POOL.water, 3.0);   // where the charge lifts water out of the pool
const UP = new THREE.Vector3(0, 1, 0);
const DOWNWIND = new THREE.Vector3(1, 0, 0.3).normalize();   // main.js's ambient wind direction

// --- the stream: everything is the water's own free flight -----------------------------------
// tau = seconds since this water left the nozzle; clock = seconds since release; so this water left
// at te = clock - tau, and anything frozen in the water is a function of te alone (it advects).
const STREAM_FUNCS = /* glsl */`
vec4 gA;   // nozzle xyz (ball: centre), seed
vec4 gB;   // launch velocity xyz (m/s), nozzle radius (m) (ball: radius)
vec4 gC;   // tail flow time, head flow time, clock (s), whip
vec4 gD;   // mode (0 stream, 1 ball, -1 geyser column), breakup flow time (s), last flow time: where it lands (s), aeration
vec4 gE;   // dissolve, neck flare, turbulent spreading, turbulence at the nozzle
vec3 gS, gU;
float gSp;
void streamSetup() {
  gSp = max(length(gB.xyz), 1e-3);
  vec3 t0 = gB.xyz / gSp;
  gS = normalize(cross(t0, abs(t0.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  gU = cross(gS, t0);
}
vec3 streamVel(float tau) { return gB.xyz - vec3(0.0, ${G.toFixed(3)} * tau, 0.0); }
// the hose's aim when this water left is carried down the stream: the whip wave runs to the tip
vec3 streamAt(float tau, float clock) {
  float te = max(clock - tau, 0.0);
  float amp = gC.w * (0.004 + 0.03 * exp(-te / 0.25));
  vec3 sway = gS * amp * sin(te * 9.0 + gA.w * 6.28) + gU * 0.5 * amp * cos(te * 6.3 + gA.w * 6.28);
  return gA.xyz + (gB.xyz + sway * gSp) * tau - vec3(0.0, ${(G / 2).toFixed(3)} * tau * tau, 0.0);
}
// continuity: slower water is fatter; turbulent streams entrain air and spread with travel
float streamR(float tau) {
  float k = gSp / max(length(streamVel(tau)), 0.1 * gSp);
  return gB.w * sqrt(k) * (1.0 + gE.z * tau / max(gD.y, 1e-3));
}
`;

const STREAM_VERT = /* glsl */`
${NOISE_GLSL}
in vec4 iA;
in vec4 iB;
in vec4 iC;
in vec4 iD;
in vec4 iE;
${STREAM_FUNCS}
out vec3 vW;
out vec3 vN;
out vec3 vL;      // local: across the section (m), and along the water (m), frozen in it
out vec3 vS;
out vec3 vT;
out vec4 vInfo;   // breakup 0..1, radius (m), seed, aeration
out float vBall;
out float vCol;
vec3 surf(float u, float v, out vec4 info, out vec3 L, out vec3 Sf, out vec3 Tf) {
  float a = u * 6.2831853, ca = cos(a), sa = sin(a), seed = gA.w;
  if (gD.x > 0.5) {
    // a held ball of water: low modes wobbling, as a floating drop does, and it swirls
    float ph = v * 3.14159265, t = gC.z;
    vec3 dir = vec3(sin(ph) * ca, -cos(ph), sin(ph) * sa);
    float w = 1.0 + 0.07 * sin(dot(dir, vec3(2.3, 3.1, 1.7)) * 2.0 + t * 6.3) + 0.04 * sin(dot(dir, vec3(-3.7, 1.3, 2.9)) * 3.0 - t * 9.1)
            + 0.05 * (noise3(dir * 0.05 + vec3(seed, t * 0.04, 0.0)) - 0.5);
    float c = cos(t * 2.2), s = sin(t * 2.2);
    L = vec3(dir.x * c - dir.z * s, dir.y, dir.x * s + dir.z * c) * gB.w * vec3(1.0, 1.0, 6.0);
    Sf = vec3(1.0, 0.0, 0.0); Tf = vec3(0.0, 0.0, 1.0);
    info = vec4(gD.w, gB.w, seed, gD.w);
    return gA.xyz + dir * gB.w * w;
  }
  float tail = gC.x, head = gC.y, clock = gC.z;
  float tau = mix(tail, head, v);
  vec3 c = streamAt(tau, clock), vel = streamVel(tau);
  float sp = max(length(vel), 0.5);
  vec3 T = normalize(vel + vec3(0.0, 1e-3, 0.0)), S = normalize(cross(T, gU)), U = cross(S, T);
  float b = clamp(tau / gD.y, 0.0, 1.0), r = streamR(tau);
  // a round nose until it lands, a round tail once the source stops, a neck at the source
  float cap = 1.0, dh = (head - tau) * sp, dt = (tau - tail) * sp;
  if (head < gD.z - 1e-3) cap *= sqrt(clamp(dh / (2.0 * r), 0.0, 1.0));
  if (tail > 1e-3) cap *= sqrt(clamp(dt / (2.0 * r), 0.0, 1.0));
  else cap *= 1.0 + gE.y * exp(-dt / (1.6 * r));
  // instabilities frozen in the water, growing with travel: lumps, Rayleigh-Plateau, the core wandering
  float z = (clock - tau) * gSp;
  float zc = z * 0.06 + seed * 3.1, zf = z * 0.21 + seed * 1.7;
  vec3 q = vec3(ca, sa, 0.0);
  // a geyser column is not round: lobes round it, and fingers drawn out along the flow (Strokkur,
  // Old Faithful at 240 fps) that stand out further the higher and slower the water gets
  float col = step(gD.x, -0.5);
  float n1 = noise3(q * mix(0.14, 1.1, col) + vec3(seed, 0.0, zc)) - 0.5;
  float n2 = noise3(q * mix(0.36, 2.2, col) + vec3(0.0, seed, zf)) - 0.5;
  float grow = gE.w + b * b;
  float varic = sin(z * 6.2831853 / max(10.0 * gB.w, 0.1) + seed * 9.0);
  float R = r * cap * (1.0 + grow * (1.5 * n1 + 1.2 * n2) + 0.12 * b * varic);
  // a hose jet's last metres fray the same way before they reach what they hit
  float fw = max(col, smoothstep(0.5, 1.0, b));
  if (fw > 0.0) {
    float f = clamp((noise3(vec3(q.xy * 3.4, z * 0.13) + vec3(seed * 2.3, 0.4, 0.0)) - 0.5) * 3.2 + 0.5, 0.0, 1.0);
    R *= 1.0 + fw * (0.12 + 1.5 * b) * (f * f - 0.3);
  }
  float w1 = noise3(vec3(seed * 0.7, 0.21, zc * 0.8)) - 0.5, w2 = noise3(vec3(0.63, seed * 0.7, zc * 0.8)) - 0.5;
  c += (S * w1 + U * w2) * r * 2.4 * b;
  R = max(R, 0.002);
  L = vec3(ca * R, sa * R, z);
  Sf = S; Tf = T;
  info = vec4(max(b, gE.x), max(r * cap, 0.01), seed, gD.w);
  return c + (S * ca + U * sa) * R;
}
void main() {
  gA = iA; gB = iB; gC = iC; gD = iD; gE = iE;
  streamSetup();
  vBall = max(gD.x, 0.0);
  vCol = step(gD.x, -0.5);
  float u = position.x, v = position.y;
  vec4 i1, i2; vec3 l1, s1, t1;
  vec3 p = surf(u, v, vInfo, vL, vS, vT);
  float dv = v < 0.995 ? 0.005 : -0.005;
  vec3 pu = surf(u + 0.01, v, i1, l1, s1, t1) - p;
  vec3 pv = (surf(u, v + dv, i2, l1, s1, t1) - p) * sign(dv);
  vec3 n = cross(pv, pu);
  vN = dot(n, n) > 1e-14 ? normalize(n) : normalize(p - gA.xyz);
  vW = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const STREAM_FRAG = /* glsl */`
${SHADE}
uniform float uAbsK;   // the eye reads a stream by its darkening: thicker than its centimetres
in vec3 vW;
in vec3 vN;
in vec3 vL;
in vec3 vS;
in vec3 vT;
in vec4 vInfo;
in float vBall;
in float vCol;
out vec4 fragColor;
void main() {
  gLightNoShadow = true;
  float colm = vCol;
  float b = vInfo.x, r = vInfo.y, seed = vInfo.z, aer = vInfo.w;
  vec3 vd = normalize(cameraPosition - vW);
  vec3 n0 = normalize(vN);
  float NoV0 = clamp(dot(n0, vd), 1e-3, 1.0);

  // --- tears: holes along the flow, opening with travel, silhouette first ---------------------
  vec3 so = seed * vec3(0.13, 0.29, 0.37);
  float rr = max(r, 0.02);
  // tears in the section's own scale: fingers round it, streaks along it
  vec2 tx = vL.xy / rr * 1.4;
  vec2 tz = colm > 0.5 ? vec2(0.09, 0.3) : vec2(0.045, 0.17);
  float tn = noise3(vec3(tx * 0.7, vL.z * tz.x) + so) * 0.6 + noise3(vec3(tx * 2.6, vL.z * tz.y) + so.zxy) * 0.4;
  float tear = smoothstep(mix(0.45, 0.3, colm), 1.0, b);
  float rim = 1.0 - NoV0;
  float m = (tn - (-0.15 + 0.78 * tear + mix(0.32 * rim * rim * b + 0.5 * rim * smoothstep(0.45, 0.95, b), 0.62 * rim * smoothstep(0.03, 0.3, b), colm))) * 4.0;
  float cov = clamp(m / max(fwidth(m), 1e-4) + 0.5, 0.0, 1.0);
  if (cov < 0.02) discard;

  // --- surface: what high-speed footage of a hose jet shows is striation, not chop: the nozzle's
  // turbulence stretched into fine grooves along the flow, roughening into lumps with travel -------
  float h = noise3(vec3(vL.xy * 5.0, vL.z * 0.035) + so) * mix(0.75, 0.35, b)
          + noise3(vec3(vL.xy * 12.0, vL.z * 0.3) + so.yzx) * mix(0.25, 0.65, b);
  // the column's aeration: clear green-blue where it leaves the vent, white churn a metre up
  // (a hose jet stays a clear core in a frayed white sheath to the end: never a solid white pillow)
  float aerB = colm > 0.5 ? smoothstep(0.015, 0.13, b) : clamp(aer + b * b * 0.75, 0.0, 1.0);
  vec3 n = bump(vW, n0, h * mix(0.006, 0.035, b) * (1.0 - 0.8 * vBall) * (1.0 - 0.5 * aer) * (1.0 + 1.5 * colm * aerB));   // a white column glints less than clear glass

  // --- a real rod lens: in at the surface, out the far side, on to what is behind --------------
  vec3 rd = refract(-vd, n, 1.0 / 1.33);
  float chord = max(-2.0 * r * dot(rd, n0), 0.01);
  vec3 p2 = vW + rd * chord;
  vec3 n2 = normalize(n0 + rd * chord / r);
  vec3 od = refract(rd, -n2, 1.33);
  if (dot(od, od) < 1e-4) od = reflect(rd, -n2);   // total internal reflection
  vec2 px = 1.0 / uResolution, uv0 = gl_FragCoord.xy * px;
  float zs = refrViewZ(vW), z0 = linearDepth(textureLod(uSceneDepth, uv0, 0.0).r);
  vec2 uv = clamp(refrUV(p2 + od * clamp(z0 - zs, 0.1, 4.0)), px, 1.0 - px);
  float keep = smoothstep(zs - 0.3, zs + 0.3, linearDepth(textureLod(uSceneDepth, uv, 0.0).r));
  vec3 refr = textureLod(uSceneColor, mix(uv0, uv, keep), 0.0).rgb;
  vec3 col = waterSurface(vW, n, vd, refr, chord * uAbsK, 2.0 * r, 1.0 - smoothstep(0.1, 0.5, chord), mix(mix(0.02, 0.12, b), mix(0.04, 0.45, aerB), colm));

  // --- the aerated core: white where the ray crosses it, a clear sheath at the silhouette (a geyser
  // column, a hose jet a few metres out). Three taps through it; parallax makes the bubbles sit inside
  float th = mix(0.78, 0.3, aerB), d = 0.0;
  vec3 rl = vec3(dot(rd, vS), dot(rd, cross(vS, vT)), dot(rd, vT));
  for (int i = 0; i < 3; i++) {
    vec3 q = vL + rl * chord * (0.2 + 0.3 * float(i));
    d += smoothstep(th, th + 0.2, noise3(vec3(q.xy / rr * 0.35, q.z * 0.12) + so.yxz));
  }
  float core = smoothstep(0.15, 0.6, NoV0);
  float milk = (1.0 - exp(-d * (0.35 + 2.4 * aerB))) * mix(0.3 + 0.5 * aerB, 1.0, core) * (1.0 - 0.6 * vBall);
  float wrap = clamp(dot(n0, uSunDir) * 0.55 + 0.45, 0.0, 1.0);
  float into = pow(clamp(dot(uSunDir, -vd), 0.0, 1.0), 4.0);
  vec3 wl = uFoamColor * 0.85 * (uSunColor * (0.15 + 0.85 * wrap + 0.6 * into) + skyUp() * 1.3) + spellLightDiffuse(vW, n0) * 0.6;
  col = mix(col, wl, milk * 0.95);

  // --- aeration on the skin: foam lace drawn out along the flow --------------------------------
  float pat, fh, cover;
  foamPattern(vec2((vL.x + 0.6 * vL.y) / rr * 1.1 + seed * 5.0, vL.z * 2.0), vec2(0.0), pat, fh);   // coarse enough not to glitter
  // lace over the milk, not a skin hiding it (the milk carries the backlit glow of the churned core)
  // (a geyser's core is dense froth: billowed and folded, matte, never a glossy tube)
  col = foamSurface(col, vW, n, vd, mix(aerB * aerB * 0.55 + 0.45 * tear, 1.4 * aerB, colm), pat, fh, cover);
  fragColor = vec4(col, cov);
}`;

// --- droplets and ligaments torn off the stream, and thrown from where it lands: stateless -----
const BEAD_N_HIGH = 3600;
const beadVert = (N) => /* glsl */`
${COMMON_GLSL}
uniform vec4 uBA[${BEAD_STREAMS}];
uniform vec4 uBB[${BEAD_STREAMS}];
uniform vec4 uBC[${BEAD_STREAMS}];
uniform vec4 uBD[${BEAD_STREAMS}];
uniform vec4 uBE[${BEAD_STREAMS}];   // keep min, keep max (of the stream's speed), radial max (m/s), size max (m)
uniform vec4 uBF[${BEAD_STREAMS}];   // fan axis xyz, fan fraction
uniform vec2 uBG[${BEAD_STREAMS}];   // fan speed max (m/s), target plane on (1) or off (0)
${STREAM_FUNCS}
${BEAD_PLACE_GLSL}
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAlpha = 0.0;
  int w = gl_InstanceID / ${N};
  float k = float(gl_InstanceID - w * ${N});
  gA = uBA[w]; gB = uBB[w]; gC = uBC[w]; gD = uBD[w]; gE = vec4(0.0);
  if (gB.w <= 0.0) return;
  streamSetup();
  vec4 K = uBE[w], Fan = uBF[w];
  vec4 h = hash41(k * 1.37 + 0.11);
  bool fan = h.w < Fan.w;
  float life = fan ? mix(0.3, 1.1, h.y) : mix(0.25, 0.9, h.y);
  float cyc = gC.z / life + h.x, age = fract(cyc) * life, born = gC.z - age;
  vec4 r = hash41(k * 0.73 + floor(cyc) * 3.17);
  float stopped = gC.z - gC.x;            // the clock when the source stopped
  float tEnd = gD.z, tb = fan ? tEnd : tEnd * mix(0.12, 1.0, pow(r.x, 0.55));
  float te = born - tb;
  if (te < 0.0 || te > stopped || gC.y < tb) return;
  vec3 P, V;
  float KD;
  vec3 rnd = randomOnSphere(r.yz);
  float ligK = 9.0, ligT = 0.07;
  if (fan && uBG[w].y > 0.5) {
    // the splash crown (fire-hose slow motion): the jet spreads into a sheet round the hit, thrown
    // back towards the nozzle as a cone, and the sheet's rim tears into fingers that neck into
    // droplets. Each 1/12 s of jet makes its own crown, so the fingers flicker and never repeat
    P = streamAt(tEnd, born);
    float pulse = floor(born * 12.0);
    vec3 N = normalize(Fan.xyz), e1 = normalize(cross(N, abs(N.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0))), e2 = cross(N, e1);
    float fi = floor(r.y * 13.0);
    vec4 fh = hash41(fi * 7.31 + pulse * 1.93 + gA.w * 17.0);
    bool sheet = r.z < 0.3;   // the unbroken sheet near the hit, between the fingers
    float az = sheet ? r.y * 6.2831853 : (fi + 0.5 + (r.z - 0.65) * 0.18) / 13.0 * 6.2831853 + (fh.x - 0.5) * 0.3 + gA.w * 6.28;
    float el = mix(0.12, 0.85, fh.y) + (r.x - 0.5) * 0.12;   // radians off the sheet, back towards the source
    vec3 dirC = (e1 * cos(az) + e2 * sin(az)) * cos(el) + N * sin(el);
    P += dirC * 0.06;
    // along a finger the beads string out by speed: the tip fastest, the neck still near the sheet
    float reach = sheet ? mix(0.12, 0.35, r.w) : mix(0.3, 1.0, sqrt(r.w)) * mix(0.55, 1.0, fh.z);
    V = (dirC + rnd * 0.06) * reach * uBG[w].x;
    KD = sheet ? 2.5 : 1.0;
    ligK = sheet ? 5.0 : 22.0; ligT = sheet ? 0.05 : 0.14;
  } else if (fan) {
    P = streamAt(tEnd, born);
    V = normalize(Fan.xyz + rnd * 0.95) * mix(0.15, 1.0, r.w * r.w) * uBG[w].x;
    KD = 1.0;
  } else {
    vec3 T = normalize(streamVel(tb) + vec3(0.0, 1e-3, 0.0));
    vec3 side = normalize(rnd - T * dot(rnd, T) + vec3(1e-3, 0.0, 0.0));
    P = streamAt(tb, born) + side * streamR(tb) * 0.9;
    V = streamVel(tb) * mix(K.x, K.y, r.w) + side * K.z * mix(0.15, 1.0, r.x);
    KD = 0.9 + 2.2 * r.w;
  }
  float e = exp(-KD * age), ex = (1.0 - e) / KD;
  vec3 p = P + V * ex;
  p.y -= (${G.toFixed(3)} / KD) * (age - ex);
  if (p.y < 0.0) return;
  if (uBG[w].y > 0.5) {
    // nothing flies on through what the stream is hitting
    vec3 end = streamAt(tEnd, gC.z), Te = normalize(streamVel(tEnd));
    if (dot(p - end, Te) > 0.2) return;
  }
  vec3 vel = V * e - vec3(0.0, ${G.toFixed(3)} * ex, 0.0);
  float size = mix(0.0022, K.w, pow(h.z, 3.0));
  // just torn off it is a ligament; surface tension pulls it round within a tenth of a second
  float lig = size * ligK * exp(-age / ligT);
  placeBead(p, vel, size, smoothstep(0.0, 0.015, age) * (1.0 - smoothstep(0.85, 1.0, age / life)), lig);
}`;

// --- Cauchy-Poisson rings on a puddle: a floor decal that tilts what the floor already shows ----
// Stationary phase of the impulse response with deep-water dispersion: phase = g t^2 / (4 r), so
// the rings run outward accelerating, tight inside and wide at the front (Lamb 1932, art. 238).
const RING_VERT = /* glsl */`
in vec4 iRing;     // x, z, age (s; negative = still to come), amplitude (slope)
out vec3 vW;
out vec4 vRing;
void main() {
  float t = max(iRing.z, 0.0) * 0.62;
  float R = clamp(${G.toFixed(3)} * t * t / 6.2831853 + 0.3, 0.3, 4.5);
  vW = vec3(iRing.x + position.x * R, 0.006, iRing.y + position.y * R);
  vRing = iRing;
  gl_Position = (iRing.z < 0.0 || iRing.z > 3.6) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;

const RING_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
${COMMON_GLSL}
${GROUND_GLSL}
${REFRACT_GLSL}
in vec3 vW;
in vec4 vRing;
out vec4 fragColor;
void main() {
  vec2 pq = abs(vW.xz - vec2(${POOL.center.x.toFixed(3)}, ${POOL.center.y.toFixed(3)}));
  if (pq.x < ${(POOL.half.x + 0.05).toFixed(3)} && pq.y < ${(POOL.half.y + 0.05).toFixed(3)}) discard;   // the pool has its own wave sim
  float mask = smoothstep(0.22, 0.6, groundA(vW.xz).z);
  if (mask <= 0.0) discard;
  vec2 d = vW.xz - vRing.xy;
  float r = max(length(d), 0.03);
  // ponytail: one time scale stands in for mm-deep capillary-gravity dispersion (slower waves)
  float t = vRing.z * 0.62;
  float ph = ${G.toFixed(3)} * t * t / (4.0 * r);
  float k = ph / r;                                 // local wavenumber d(phase)/dr
  float viewZ = -(viewMatrix * vec4(vW, 1.0)).z;
  float px = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float lam = 6.2831853 / max(k, 1e-3);
  // drop the short inner waves (alias and damp first) and everything ahead of the front
  float keep = smoothstep(3.0 * px, 8.0 * px, lam) * smoothstep(0.015, 0.05, lam) * smoothstep(0.4, 2.2, ph);
  float slope = vRing.w * exp(-vRing.z / 1.1) * keep * sin(ph);
  if (abs(slope) * mask < 0.003) discard;
  vec2 rd = d / r;
  vec3 n = normalize(vec3(-rd.x * slope, 1.0, -rd.y * slope));
  vec3 v = normalize(cameraPosition - vW);
  // the tilted film moves what the floor shows (its reflections, the wet sheen), depth-validated
  vec2 uv0 = gl_FragCoord.xy / uResolution, uv = refrUV(vW + vec3(rd.x, 0.0, rd.y) * slope * 0.35);
  float z1 = linearDepth(textureLod(uSceneDepth, uv, 0.0).r);
  uv = mix(uv0, uv, smoothstep(viewZ - 0.3, viewZ + 0.3, z1));
  vec3 col = textureLod(uSceneColor, uv, 0.0).rgb;
  // crests catch the sky and the sun
  float F = fresnel(max(dot(n, v), 0.0), 0.02);
  col += max(envReflect(reflect(-v, n), 0.05) - envReflect(reflect(-v, vec3(0.0, 1.0, 0.0)), 0.05), vec3(0.0)) * F * 2.0;
  float nh = max(dot(n, normalize(uSunDir + v)), 0.0);
  col += uSunColor * pow(nh, 600.0) * 4.0 * step(0.0, uSunDir.y);
  fragColor = vec4(col, mask * clamp(abs(slope) * 40.0, 0.0, 1.0));
}`;

// --- module scratch (no allocation after create) -----------------------------------------------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3(), _v = new THREE.Vector3();
const SPL = { x: 0, z: 0, radius: 1, wet: 0, pattern: 'noise', seed: 0 };   // reused ground splat
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const floorY = (x, z) => (Math.abs(x - POOL.center.x) < POOL.half.x && Math.abs(z - POOL.center.y) < POOL.half.y ? POOL.water : 0);
const nearPool = (x, z, m) => Math.abs(x - POOL.center.x) < POOL.half.x + m && Math.abs(z - POOL.center.y) < POOL.half.y + m;
const absorb = (x) => 0.048 + 0.104 * -Math.log(Math.max(x, 0.03));   // tint -> 1/m, as Tsunami: the default gives a clear blue
// launch velocity that lands in T seconds under gravity and linear drag DRAG (the drop kind's
// 0.1 plus the ambient wind's 0.25 coupling): x(T) = v0 (1 - e^-kT) / k - (g / k) (T - (1 - e^-kT) / k)
const DRAG = 0.35;
function launch(out, from, to, T) {
  const e = (1 - Math.exp(-DRAG * T)) / DRAG;
  out.subVectors(to, from).divideScalar(e);
  out.y += (G / DRAG) * (T - e) / e;
  return out;
}
// the same for the stream (gravity only)
const lob = (out, from, to, T) => out.subVectors(to, from).divideScalar(T).addScaledVector(UP, 0.5 * G * T);

function normalAt(p, out) {
  const e = 0.02;
  out.set(
    arenaSDF(_a.copy(p).setX(p.x + e)) - arenaSDF(_b.copy(p).setX(p.x - e)),
    arenaSDF(_a.copy(p).setY(p.y + e)) - arenaSDF(_b.copy(p).setY(p.y - e)),
    arenaSDF(_a.copy(p).setZ(p.z + e)) - arenaSDF(_b.copy(p).setZ(p.z - e)),
  );
  if (out.lengthSq() < 1e-10) out.set(0, 1, 0);
  return out.normalize();
}
function tubeGeometry(nu, nv) {
  const g = new THREE.InstancedBufferGeometry(), pos = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) pos.push(i / nu, j / nv, 0);
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, c = a + nu + 1;
    idx.push(a, c + 1, a + 1, a, c, c + 1);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.instanceCount = 0;
  return g;
}
function instAttr(g, name, n) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, a);
  return a;
}

export default {
  id: 'water', name: 'Water', key: '3', hue: '#2fa8ff',
  shape: 'beam', forms: ['Tidal Lance', 'Geyser'],
  params: { size: 1, speed: 32, whip: 1, height: 4.5, droplets: 1, mist: 1, splash: 1, wetness: 1, clarity: 1, tint: '#2fa8ff' },
  ranges: { size: [0.5, 2, 0.01], speed: [12, 60, 0.5], whip: [0, 2, 0.01], height: [1.5, 8, 0.1], droplets: [0, 3, 0.01], mist: [0, 3, 0.01], splash: [0.3, 2, 0.01], wetness: [0, 2, 0.01], clarity: [0.2, 3, 0.01] },
  presets: {
    tropical: { tint: '#1fe0c8', clarity: 1.6 },
    abyssal: { tint: '#1a4dff', clarity: 0.45, mist: 1.4 },
    'violet tide': { tint: '#9a6bff', clarity: 0.9 },
  },
  timing: { charge: 0.6, impact: 0.35, linger: 3, sustain: 1.4 },
  // 4 kinds only: the shared kind table is 64 for every element. Beads and motes are drops, steam is
  // mist. Other water spells (Tsunami) emit these too.
  kinds: {
    drop: { style: 'glow', drag: 0.1, gravity: 9.8, restitution: 0.3, friction: 0.5, life: [0.9, 1.6], size: [0.009, 0.006], stretch: 0.005, emissive: 0.45, color: ['#e4f4ff', '#8fc6f0'], alpha: [1, 0.8], fadeIn: 0.02, fadeOut: 0.08, morph: 'water.splash', paints: 'wet', paintAmount: 0.05 },
    splash: { style: 'glow', drag: 0.6, gravity: 9.8, restitution: 0.2, friction: 0.6, killOnCollide: true, life: [0.12, 0.32], size: [0.008, 0.004], stretch: 0.004, emissive: 0.7, color: ['#ffffff', '#bfe6ff'], alpha: [0.9, 0], paints: 'wet', paintAmount: 0.04 },
    mist: { style: 'media', drag: 2.2, buoyancy: 0.2, curl: 0.5, curlScale: 0.25, life: [1.2, 2.4], size: [0.35, 1.5], sizePow: 0.6, color: ['#e2f2ff', '#cfe4f5'], alpha: [0.075, 0], density: 1.4, erosion: 0.5, fadeIn: 0.12, lightResponse: 2 },
    spray: { style: 'media', drag: 1.4, gravity: 5, curl: 0.3, life: [0.45, 0.9], size: [0.14, 0.5], sizePow: 0.7, color: ['#f2faff', '#dcecf8'], alpha: [0.1125, 0], density: 4, erosion: 0.5, fadeIn: 0.05, lightResponse: 2 },
  },

  create(fx) {
    const S = this, P = fx.particles, Q = fx.Q, low = Q.tier === 'low';
    // the shared fluid: whoever needs it first builds it (Tsunami may too); a phone pays ~20 passes
    // for it, so Low draws the stream, beads and particles alone
    let W = null;
    if (!low) {
      fx.water ??= new ParticleFluid(fx);
      W = fx.water;
      if (!fx.systems.includes(W)) fx.systems.push(W);
    }

    const E = (k, o) => P.emitter(`water.${k}`, o);
    const drip = E('drop', { shape: 'line', radius: 0.36, spread: 0.15 });
    const bead = E('drop', { shape: 'disk', radius: 1.0, spread: 0.1 });
    const dropCone = E('drop', { shape: 'cone', radius: 0.12, spread: 0.8 });
    const mist = E('mist', { shape: 'sphere', radius: 0.4, spread: 0.5 });
    const mistLine = E('mist', { shape: 'line', radius: 0.25, spread: 0.4 });
    const spray = E('spray', { shape: 'sphere', radius: 0.2, spread: 1.2 });
    const sprayRing = E('spray', { shape: 'ring', radius: 0.4, spread: 0.5 });
    const sprayCone = E('spray', { shape: 'cone', radius: 0.15, spread: 0.6, cone: 1.1 });
    const sprayLine = E('spray', { shape: 'line', radius: 0.2, spread: 0.8 });
    // steam: hot wet ground (heat + wet > 1.25, i.e. heat on a puddle) breathes mist upward
    P.fieldEmitter('water.mist', { slots: 512, a: [1, 0, 1, 0], threshold: 1.25, rate: 3, up: 1.6, sizeScale: 0.8 });

    const tint = new THREE.Color(), lightCol = new THREE.Color(), absorption = new THREE.Color(), scatter = new THREE.Color();
    const foamCol = new THREE.Color('#f2f6f7'), foamTint = new THREE.Color();
    const WHITE = new THREE.Color(1, 1, 1);
    const lookU = new THREE.Vector4(1, 0.02, 0.0, 1.0);
    function optics() {
      const p = S.params;
      tint.set(p.tint);
      lightCol.copy(tint).lerp(WHITE, 0.55);
      absorption.setRGB(absorb(tint.r), absorb(tint.g), absorb(tint.b)).multiplyScalar(1 / p.clarity);
      scatter.copy(tint).lerp(WHITE, 0.15).multiplyScalar(0.06);
      foamTint.copy(tint).multiplyScalar(0.25).addScalar(0.58);
    }
    optics();
    function look(h) {
      const p = S.params;
      h.tint.set(p.tint); h.clarity = p.clarity; h.tintWater();
      h.foam = p.droplets;
      h.paintA.set(0, 0, 0.03 * p.wetness, 0);
      h.sss = 0.5;   // clear water: backlit sheets glint and refract the sun, they don't glow peach
    }

    // --- stream + ball: one instanced draw in the refract pass ---------------------------------
    const streamGeo = low ? tubeGeometry(12, 72) : tubeGeometry(30, 200);
    const iA = instAttr(streamGeo, 'iA', MAX_STREAMS), iB = instAttr(streamGeo, 'iB', MAX_STREAMS), iC = instAttr(streamGeo, 'iC', MAX_STREAMS);
    const iD = instAttr(streamGeo, 'iD', MAX_STREAMS), iE = instAttr(streamGeo, 'iE', MAX_STREAMS);
    const streamMesh = new THREE.Mesh(streamGeo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: STREAM_VERT, fragmentShader: STREAM_FRAG,
      uniforms: { ...fx.U, uAbsorption: { value: absorption }, uScatter: { value: scatter }, uFoamColor: { value: foamCol }, uFoamTint: { value: foamTint }, uLook: { value: lookU }, uAbsK: { value: 3.5 }, uFoamTex: { value: foamTexture(fx.renderer) } },
      side: THREE.FrontSide, alphaToCoverage: true,
    }));
    streamMesh.frustumCulled = false;
    streamMesh.visible = false;
    fx.scenes.refract.add(streamMesh);

    // --- beads: one instanced draw, per stream a block of instances ----------------------------
    const BEAD_N = low ? 800 : BEAD_N_HIGH;
    const beadGeo = new THREE.InstancedBufferGeometry();
    beadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    beadGeo.setIndex([0, 1, 2, 0, 2, 3]);
    beadGeo.instanceCount = 0;
    const v4s = () => Array.from({ length: BEAD_STREAMS }, () => new THREE.Vector4());
    const bu = { uBA: { value: v4s() }, uBB: { value: v4s() }, uBC: { value: v4s() }, uBD: { value: v4s() }, uBE: { value: v4s() }, uBF: { value: v4s() }, uBG: { value: Array.from({ length: BEAD_STREAMS }, () => new THREE.Vector2()) } };
    const beadMesh = new THREE.Mesh(beadGeo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: beadVert(BEAD_N), fragmentShader: BEAD_FRAG, uniforms: { ...fx.U, ...bu },
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    beadMesh.frustumCulled = false;
    beadMesh.visible = false;
    beadMesh.renderOrder = 3;
    fx.scenes.refract.add(beadMesh);

    // puddle rings: one instanced draw, blended over the floor before the other translucents
    const ringGeo = new THREE.InstancedBufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    ringGeo.setIndex([0, 2, 1, 0, 3, 2]);
    ringGeo.instanceCount = 0;
    const rA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 4), 4);
    rA.setUsage(THREE.DynamicDrawUsage);
    ringGeo.setAttribute('iRing', rA);
    const ringMesh = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms: { ...fx.U },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    ringMesh.frustumCulled = false;
    ringMesh.visible = false;
    ringMesh.renderOrder = -1;
    fx.scenes.refract.add(ringMesh);
    const rings = Array.from({ length: MAX_RINGS }, () => ({ live: false, x: 0, z: 0, age: 0, amp: 0 }));

    let lensWet = 0, dimmed = false;

    // per-cast state, indexed by the cast record (cast.js keeps 16)
    const ST = Array.from({ length: 16 }, () => ({
      live: false, h: null, light: null, attract: null, breeze: null, A: new THREE.Vector3(), dir: new THREE.Vector3(), side: new THREE.Vector3(), up: new THREE.Vector3(),
      hit: new THREE.Vector3(), hitN: new THREE.Vector3(), foot: new THREE.Vector3(), axis: new THREE.Vector3(), Gp: new THREE.Vector3(),
      V0: new THREE.Vector3(), L: 1, R: 0.24, rj: 0.14, rc: 0.3, floorHit: true, phase: 0, seedF: 0,
      t0: 0, tImp: 0, T: 0, contact: false, landed: false, erupt: -1, tTop: 1, H: 0, Hmax: 0, wetDummy: -1, speed: 1,
      splat: 0, rip: 0, poolTick: 0, ball: 0, glow: 1, dome: 0, burst: false,
      on: false, tail: 0, head: 0, clock: 0, tEnd: 1, tb: 1, aer: 0, r: 0, dissolve: 0, neck: 0, spreadK: 0, turb: 0, whip: 0,
      keep0: 0.4, keep1: 0.85, radial: 3, bead: 0.012, fan: 0.3, fanSp: 7, plane: 1,
    }));

    // --- helpers ---------------------------------------------------------------------------
    function spawnRing(x, z, amp, delay) {
      if (nearPool(x, z, 0.1)) return;
      let k = null;
      for (const r of rings) if (!r.live) { k = r; break; }
      if (!k) { k = rings[0]; for (const r of rings) if (r.age > k.age) k = r; }
      k.live = true; k.x = x; k.z = z; k.age = -delay; k.amp = amp;
    }
    function wetSplat(x, z, radius, wet, seed) {
      SPL.x = x; SPL.z = z; SPL.radius = radius; SPL.wet = wet; SPL.seed = seed % 1000;
      fx.ground.splat(SPL);
    }
    function soak(pos, radius, strength, from) {
      let best = -1;
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i], dist = Math.hypot(dm.pos.x - pos.x, dm.pos.z - pos.z);
        if (dist > radius) continue;
        const w = 1 - dist / radius;
        dm.status.wet = Math.max(dm.status.wet, Math.min(1, w + 0.5));
        if (strength > 0) dm.hit(_n.subVectors(dm.pos, from).setY(0), strength * (0.4 + 0.6 * w));
        best = i;
      }
      return best;
    }

    // where the water lands: the first surface on the line from the focus (dummy, pillar, floor)
    function aim(c, d) {
      d.A.copy(c.from);
      d.dir.subVectors(c.to, c.from);
      const len = d.dir.length();
      d.dir.divideScalar(len);
      const t = arenaRaycast(c.from, d.dir, len + 2);
      d.hit.copy(t > 0 && t < len + 1.5 ? _p.copy(c.from).addScaledVector(d.dir, t) : c.to);
      normalAt(d.hit, d.hitN);
      d.floorHit = d.hitN.y > 0.7;
      if (d.floorHit) { d.hitN.set(0, 1, 0); d.hit.y = floorY(d.hit.x, d.hit.z); }
      // the spray leaves along the surface normal, thrown forward by the jet's momentum
      _b.copy(d.dir).setY(0);
      if (_b.lengthSq() > 1e-6) _b.normalize();
      d.axis.copy(d.floorHit ? UP : d.hitN).addScaledVector(d.floorHit ? _b : UP, d.floorHit ? 0.55 : 0.35).normalize();
      d.foot.copy(d.hit).addScaledVector(d.hitN, d.floorHit ? 0 : 0.35);
      d.foot.y = floorY(d.foot.x, d.foot.z);
    }
    function frame(d, B) {
      d.L = Math.max(d.A.distanceTo(B), 0.5);
      d.dir.subVectors(B, d.A).divideScalar(d.L);
      d.side.crossVectors(d.dir, UP);
      if (d.side.lengthSq() < 1e-6) d.side.set(1, 0, 0);
      d.side.normalize();
      d.up.crossVectors(d.side, d.dir).normalize();
    }

    // the cast's fluid domain stands where the water lands
    function acquire(c, d) {
      if (!W) return null;
      const sz = S.params.size;
      const w = (c.form === 'Geyser' ? 6 : 5.4) * Math.sqrt(sz);
      const top = c.form === 'Geyser' ? d.Hmax + 1.4 : Math.max(d.hit.y, 0) + 1.8;
      _b.subVectors(d.hit, c.from).setY(0);
      const h = W.acquire({ size: [w, top, w], position: _p.copy(c.form === 'Geyser' ? d.Gp : d.foot).setY(0), yaw: Math.atan2(_b.z, _b.x), margin: 1.5, life: 4.2 });
      if (!h) return null;
      look(h);
      h.drain = 0.22;
      // the flood is clear water with lace on it, not a white pillow (the white is the crown's spray)
      h.aeration = c.form === 'Geyser' ? 0.8 : 0.4;
      return h;
    }

    // what a hit does round the fluid: mist and spray clouds, wet floor, rings, the dummy soaked
    // and shoved, the camera; s = 1 is the full slug
    function hitFx(c, d, at, s) {
      const p = S.params, sz = p.size;
      spray.pos.copy(at); spray.vel.copy(d.axis).multiplyScalar(2.5); spray.size = sz; spray.burst(14 * s * p.mist);
      mist.pos.copy(at); mist.vel.copy(d.axis).multiplyScalar(0.8); mist.size = sz; mist.burst(10 * s * p.mist);
      dropCone.pos.copy(at); dropCone.p.copy(d.axis); dropCone.cone = 1.1; dropCone.radial = 5 * p.splash; dropCone.vel.set(0, 0.5, 0); dropCone.spread = 1; dropCone.burst(180 * s * p.droplets);
      wetSplat(d.foot.x, d.foot.z, (1.5 + s) * sz, 0.6 * p.wetness, c.seed + c.age * 13);
      fx.impacts.add('wet', at, 1.6 * sz, 1, 8);
      spawnRing(d.foot.x, d.foot.z, 0.22 * (0.5 + 0.5 * s), d.floorHit ? 0.05 : 0.35);
      if (nearPool(d.foot.x, d.foot.z, 0.6)) fx.pool.ripple(d.foot.x, d.foot.z, 0.05 * s * sz, 0.45 * sz);
      const k = soak(at, 1.6 * sz, 0.7 * s, d.A);
      if (k >= 0) d.wetDummy = k;
      if (fx.camera.position.distanceTo(at) < 3 + sz) lensWet = 1;
      fx.rig.shake(0.12 + 0.2 * s, 12);
      if (s > 0.9 && !fx.reduced) fx.rig.punch(1.2, 0.08);
      if (d.light) { d.light.pos.copy(d.foot).setY(d.foot.y + 1.3); d.light.intensity = Math.max(d.light.intensity, 22 * s); d.light.range = 7 * sz; }
    }

    // --- Tidal Lance -------------------------------------------------------------------------
    // the fluid takes the water over just before it lands, with the momentum it has left
    function feed(d, dt) {
      if (!d.h) return;
      const p = S.params, v = _v.copy(d.V0).addScaledVector(UP, -G * d.T), sp = v.length();
      v.divideScalar(sp);
      _p.copy(d.hit).addScaledVector(v, -0.45);
      // a jet on a wall spends its momentum spreading out round the hit, not running on along the floor
      d.h.jet(_p, v, 0.4 * sp, 1.15 * d.rj, dt, 0.05, 0, 1.3 * p.splash, 3.4 * p.splash);
    }
    function updateLance(c, d, dt) {
      const p = S.params, L = d.light, tw = c.age - d.t0;
      d.clock = tw;
      if (c.phase === 'travel') {
        d.on = true; d.tail = 0; d.head = Math.min(tw, d.T);
        d.ball = d.R * Math.cbrt(Math.max(1 - 0.8 * tw / S.timing.sustain, 0.05));
        if (!d.contact && tw >= d.T) { d.contact = true; hitFx(c, d, d.hit, 0.55); }
        if (d.contact) { feed(d, dt); sustain(c, d, dt); }
        // spray only where the stream has started to tear
        _p.copy(d.A).lerp(d.hit, 0.4);
        sprayLine.pos.copy(_p); sprayLine.p.copy(d.hit); sprayLine.vel.copy(d.dir).multiplyScalar(6); sprayLine.radial = 0; sprayLine.size = 0.8 * p.size;
        sprayLine.rate(32 * p.mist * Math.min(tw / d.T, 1), dt);
        if (L) { L.pos.copy(d.foot).setY(d.foot.y + 1.6); L.intensity = d.contact ? Math.max(L.intensity * Math.exp(-dt / 0.3), 6) : 0; L.range = 6 * p.size; L.cookie[2] = c.age * 0.5; }
        return;
      }
      // the source stops: the tail flies the same arc, and lands
      const td = c.age - d.tImp;
      d.tail = td; d.head = Math.min(tw, d.T); d.on = td < d.T;
      d.ball = d.R * Math.cbrt(0.2) * (1 - sstep(0, 0.16, td));
      if (d.on) feed(d, dt);
      if (!d.landed && td >= d.T) { d.landed = true; hitFx(c, d, d.hit, 1); }
      if (c.phase === 'impact') decayLight(c, d, dt); else linger(c, d, dt);
    }

    // the stream pounding the target while held: the fluid does the water; this is the air round it
    function sustain(c, d, dt) {
      const p = S.params, sz = p.size, hit = d.hit;
      sprayCone.pos.copy(hit); sprayCone.p.copy(d.axis); sprayCone.radial = 3; sprayCone.size = sz; sprayCone.rate(14 * p.mist, dt);
      mist.pos.copy(hit); mist.vel.copy(d.axis); mist.size = sz; mist.rate(6 * p.mist, dt);
      dropCone.pos.copy(hit); dropCone.p.copy(d.axis); dropCone.cone = 1.1; dropCone.radial = 6 * p.splash; dropCone.vel.set(0, 0.8, 0); dropCone.spread = 1;
      dropCone.rate((low ? 500 : 160) * p.droplets, dt);
      d.splat -= dt;
      if (d.splat <= 0) {
        d.splat = 0.25;
        wetSplat(d.foot.x, d.foot.z, 1.3 * sz, 0.35 * p.wetness, c.seed + c.age * 101);
        soak(hit, 1.3 * sz, 0.15, d.A);
      }
      d.rip -= dt;
      if (d.rip <= 0) { d.rip = 0.55; spawnRing(d.foot.x, d.foot.z, 0.12, d.floorHit ? 0 : 0.3); }
      d.poolTick -= dt;
      if (d.poolTick <= 0 && nearPool(d.foot.x, d.foot.z, 0.6)) { d.poolTick = 0.08; fx.pool.ripple(d.foot.x + (fx.rand() - 0.5) * 0.3, d.foot.z + (fx.rand() - 0.5) * 0.3, 0.015 * sz, 0.25 * sz); }
    }

    // --- Geyser ------------------------------------------------------------------------------
    // Strokkur: the dive heaves the water up out of the ground as a smooth blue dome for a quarter
    // second, then the column bursts up through it
    const DOME = 0.26;
    function eruptStart(c, d) {
      const p = S.params, sz = p.size, g = d.Gp;
      wetSplat(g.x, g.z, 1.6 * sz, 0.5 * p.wetness, c.seed + 13);
      spawnRing(g.x, g.z, 0.18, 0);
      if (nearPool(g.x, g.z, 0.6)) fx.pool.ripple(g.x, g.z, 0.04 * sz, 0.6 * sz);
      fx.rig.shake(0.15, 5);
      if (d.light) d.light.intensity = 10;
    }
    function burstStart(c, d) {
      const p = S.params, sz = p.size, g = d.Gp;
      // the dome tears open: churned water heaves out round the column's foot
      d.h?.burst(_a.copy(g).setY(g.y + 0.25 * sz), 0.3 * sz, _v.set(0, 5.5 * Math.sqrt(sz), 0), 0.1 * sz ** 3 * p.splash, 1.2, 2.6, 0.5);
      spray.pos.copy(g).setY(g.y + 0.3); spray.vel.set(0, 4, 0); spray.size = 1.2 * sz; spray.burst(22 * p.mist);
      dropCone.pos.copy(g).setY(g.y + 0.1); dropCone.p.set(0, 1, 0); dropCone.cone = 0.9; dropCone.radial = 7 * p.splash; dropCone.vel.set(0, 1, 0); dropCone.spread = 1.5; dropCone.burst(260 * p.droplets);
      wetSplat(g.x, g.z, 2.5 * sz, 0.7 * p.wetness, c.seed + 17);
      fx.impacts.add('wet', _a.copy(g).setY(g.y + 1), 2 * sz, 1, 8);
      if (nearPool(g.x, g.z, 0.6)) fx.pool.ripple(g.x, g.z, 0.08 * sz, 0.6 * sz);
      spawnRing(g.x, g.z, 0.25, 0);
      const k = soak(g, 1.4 * sz, 0.9, _b.set(g.x + 0.3, 0, g.z + 0.2));
      if (k >= 0) d.wetDummy = k;
      if (fx.camera.position.distanceTo(g) < 3 + sz) lensWet = 1;
      fx.rig.shake(0.45, 8);
      if (!fx.reduced) fx.rig.punch(1.5, 0.1);
      if (d.light) d.light.intensity = 24;
      // the breeze over the top carries its mist and spray off downwind
      d.breeze = fx.forces.acquire();
      if (d.breeze) { const f = d.breeze; f.type = 5; f.p[0] = 2.6; f.p[1] = 1.9 * sz; f.p[2] = 8; f.p[3] = 0.9; f.dir.copy(DOWNWIND); f.pos.copy(g).setY(g.y + d.Hmax); }
    }

    // the column itself: straight up with a small wander, the source surging
    function columnState(d, te, stop) {
      const p = S.params, v0 = Math.sqrt(2 * G * d.Hmax);
      const surge = 1 + 0.04 * Math.sin(te * 7.3 + d.phase) + 0.018 * Math.sin(te * 17 + 2 * d.phase);
      d.V0.set(0.022 * v0 * Math.sin(te * 1.9 + d.phase), v0 * surge * (1 - 0.35 * Math.exp(-te * 9)), 0.022 * v0 * Math.cos(te * 1.6 + d.phase));
      d.tTop = 0.9 * v0 / G;
      d.tEnd = d.tTop; d.tb = d.tTop * 1.02;
      d.r = d.rc * (1 + 0.5 * Math.exp(-te * 4)); d.clock = te; d.head = Math.min(te, d.tTop);
      d.tail = stop; d.on = stop < d.tTop;
      d.dissolve = sstep(0, 0.75, stop);
      d.aer = 0.7; d.neck = 0.8; d.spreadK = 0.15; d.turb = 0.22; d.whip = 0;
      d.keep0 = 0.75; d.keep1 = 1.05; d.radial = 3.6 * p.splash * Math.sqrt(p.size); d.bead = 0.026; d.fan = 0.45; d.fanSp = 4.2 * p.splash; d.plane = 0;
      d.axis.set(0, 1, 0);
      d.H = (v0 * d.head - 0.5 * G * d.head * d.head);
    }
    // the head breaks into chunks that arc out and fall back round the column, and what falls and
    // what spills pools at the foot
    function feedColumn(d, dt) {
      if (!d.h) return;
      const p = S.params, sz = p.size, g = d.Gp, fr = 60 * dt;
      if (d.head > 0.25) {
        const tau = d.head * (0.72 + 0.28 * fx.rand()), a = fx.rand() * 6.2832, R = 0.8 * d.rc;
        _p.copy(g).setY(g.y + d.V0.y * tau - 0.5 * G * tau * tau);
        _p.x += R * Math.cos(a) + d.V0.x * tau; _p.z += R * Math.sin(a) + d.V0.z * tau;
        _v.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.9 + 1.5 * fx.rand());
        _v.y = d.V0.y - G * tau;
        d.h.burst(_p, 0.1 * sz * Math.sqrt(1 + 2 * tau), _v, 0.016 * fr * sz ** 2, 0.4, 1.0, 0.25);
      }
      d.h.burst(_p.copy(g).setY(g.y + 0.1), 0.2 * sz, _v.set(0, 1.8, 0), 0.006 * fr * sz ** 2, 0.5, 3.0, 0.3);
    }

    function updateGeyser(c, d, dt) {
      const p = S.params, sz = p.size, L = d.light, g = d.Gp, tw = c.age - d.t0;
      if (d.erupt < 0) {
        // the ball dives into the floor at the target: a short slug on an arc
        d.on = true; d.clock = tw; d.head = Math.min(tw, d.T); d.tail = Math.max(tw - 0.14, 0);
        d.ball = d.R * (1 - sstep(0, 0.14, tw));
        if (L) { L.pos.lerpVectors(d.A, g, Math.min(tw / d.T, 1)).setY(Math.max(L.pos.y, 0.6)); L.intensity = 6; }
        if (tw < d.T) return;
        d.erupt = tw;
        eruptStart(c, d);
      }
      const te = tw - d.erupt - DOME;
      d.dome = te < 0 ? sstep(0, DOME, te + DOME) : 0;
      if (te < 0) {
        d.on = false; d.clock = tw;
        if (L) { L.pos.copy(g).setY(g.y + 0.8); L.intensity = Math.max(L.intensity * Math.exp(-dt / 0.3), 8); }
        return;
      }
      if (!d.burst) { d.burst = true; burstStart(c, d); }
      // the source outlives the 'beam' phase a little: a geyser runs on after the cast is let go
      const stop = c.phase === 'travel' ? 0 : Math.max(c.age - d.tImp - 0.55, 0);
      columnState(d, te, stop);
      if (stop === 0) feedColumn(d, dt);
      if (d.on) {
        sprayCone.pos.copy(g).setY(g.y + d.H); sprayCone.p.set(0, 1, 0); sprayCone.radial = 3; sprayCone.size = 1.3 * sz; sprayCone.rate(45 * p.mist, dt);
      }
      if (stop === 0) {
        sprayRing.pos.copy(g); sprayRing.radius = 0.5 * sz; sprayRing.vel.set(0, 1.2, 0); sprayRing.radial = 2.2; sprayRing.size = 0.9 * sz; sprayRing.rate(16 * p.mist, dt);
        // spray shed off the sides, arcing out and falling back; mist off the top, carried downwind
        sprayLine.pos.copy(g).setY(g.y + 0.3 * d.H); sprayLine.p.copy(g).setY(g.y + 0.95 * d.H); sprayLine.vel.set(0, 1.2, 0); sprayLine.radial = 2.8 * Math.sqrt(sz); sprayLine.size = 0.8 * sz; sprayLine.rate(28 * p.mist, dt);
        mist.pos.copy(g).setY(g.y + 0.92 * d.H); mist.vel.copy(DOWNWIND).multiplyScalar(1.6).setY(0.5); mist.size = 1.4 * sz; mist.rate(13 * p.mist, dt);
        if (low) { dropCone.pos.copy(g).setY(g.y + 0.1); dropCone.p.set(0, 1, 0); dropCone.cone = 0.9; dropCone.radial = 4.5 * p.splash; dropCone.vel.set(0, 1, 0); dropCone.spread = 1.2; dropCone.rate(400 * p.droplets, dt); }
        d.splat -= dt;
        if (d.splat <= 0) { d.splat = 0.3; wetSplat(g.x, g.z, 2.2 * sz, 0.4 * p.wetness, c.seed + c.age * 101); soak(g, 1.4 * sz, 0.25, _b.set(g.x + 0.3, 0, g.z)); }
        d.rip -= dt;
        if (d.rip <= 0) { d.rip = 0.5; spawnRing(g.x, g.z, 0.15, 0); }
        d.poolTick -= dt;
        if (d.poolTick <= 0 && nearPool(g.x, g.z, 0.6)) { d.poolTick = 0.1; fx.pool.ripple(g.x, g.z, 0.03 * sz, 0.5 * sz); }
      }
      if (d.breeze) {
        const f = d.breeze;
        f.pos.copy(g).addScaledVector(DOWNWIND, -0.6).setY(g.y + Math.max(d.H, 1.5) + 0.3);
      }
      if (c.phase === 'travel') {
        if (L) { L.pos.copy(g).setY(g.y + d.H * 0.5); L.intensity = Math.max(L.intensity * Math.exp(-dt / 0.3), 10); L.range = 9 * sz; L.cookie[2] = c.age * 0.5; }
        return;
      }
      // the column's top lands back round its foot
      if (!d.landed && c.age - d.tImp >= d.T + 0.55) {
        d.landed = true;
        spray.pos.copy(g).setY(g.y + 0.4); spray.vel.set(0, 2, 0); spray.size = 1.4 * sz; spray.burst(26 * p.mist);
        wetSplat(g.x, g.z, 3 * sz, 0.6 * p.wetness, c.seed + 23);
        spawnRing(g.x, g.z, 0.25, 0);
        if (nearPool(g.x, g.z, 0.6)) fx.pool.ripple(g.x, g.z, 0.08 * sz, 0.7 * sz);
        fx.rig.shake(0.25, 9);
        if (fx.camera.position.distanceTo(g) < 3 + sz) lensWet = 1;
      }
      if (c.phase === 'impact') decayLight(c, d, dt); else linger(c, d, dt);
    }

    function decayLight(c, d, dt) {
      if (d.light) d.light.intensity *= Math.exp(-dt / 0.4);
    }
    function linger(c, d, dt) {
      const p = S.params, k = 1 - c.t / c.durations.linger, L = d.light;
      if (L) { L.intensity = Math.max(L.intensity * Math.exp(-dt / 0.4), 2.5 * k); L.cookie[2] = c.age * 0.5; }
      // the flood soaks away (each particle at its own pace: the sheet thins, it doesn't pop)
      if (d.h) d.h.drain = 0.22 + 2.6 * sstep(0.35, 0.9, 1 - k);
      d.glow = sstep(0.35, 1, 1 - k);
      // a soaked dummy drips; the last of the mist settles
      if (d.wetDummy >= 0) {
        const dm = fx.dummies[d.wetDummy].pos;
        drip.pos.set(dm.x, 1.55, dm.z); drip.p.set(dm.x, 0.5, dm.z); drip.vel.set(0, -0.3, 0); drip.life = 0.8;
        drip.rate(40 * k * p.droplets, dt);
      }
      mist.pos.copy(d.foot).setY(d.foot.y + 0.3); mist.vel.set(0, 0.2, 0); mist.rate(6 * k * p.mist, dt);
    }

    return {
      onParam(k) {
        if (k !== 'tint' && k !== 'clarity' && k !== 'droplets' && k !== 'wetness') return;
        optics();
        for (const d of ST) if (d.h?.active) look(d.h);
      },

      phase(c, name) {
        const p = S.params, d = ST[c.index], sz = p.size;
        if (name === 'charge') {
          optics();
          d.live = true; d.on = false; d.ball = 0; d.glow = 1;
          d.phase = (c.seed % 628) / 100;
          d.seedF = (c.seed % 997) / 997;
          d.contact = d.landed = d.burst = false; d.erupt = -1; d.dome = 0; d.H = 0; d.wetDummy = -1; d.clock = 0;
          d.splat = d.rip = d.poolTick = 0;
          d.dissolve = 0;
          aim(c, d);
          if (c.form === 'Geyser') {
            d.Gp.set(c.to.x, floorY(c.to.x, c.to.z), c.to.z);
            d.foot.copy(d.Gp); d.hit.copy(d.Gp).setY(d.Gp.y + 0.5); d.hitN.set(0, 1, 0); d.axis.set(0, 1, 0); d.floorHit = true;
            frame(d, d.Gp);
          } else frame(d, d.hit);
          d.Hmax = p.height * Math.sqrt(sz);
          // fast enough that the head always lands within the minimum sustain
          d.speed = Math.max(p.speed, d.L / (S.timing.sustain * 0.7));
          d.R = 0.24 * sz;
          d.rc = 0.34 * sz;
          d.rj = 0.13 * sz;
          d.h = acquire(c, d);
          d.light = fx.lights.acquire();
          if (d.light) {
            const L = d.light;
            L.type = 2; L.cookie[0] = 1; L.cookie[1] = 3.2; L.cookie[2] = 0;
            L.range = 6; L.intensity = 0; L.color.copy(lightCol); L.pos.copy(c.from);
          }
          // the pool's droplets die on arrival in the orb
          d.attract = fx.forces.acquire();
          if (d.attract) { const f = d.attract; f.type = 2; f.p[0] = 60; f.p[1] = 0.5; f.p[2] = 0.45; f.p[3] = 3.2; f.pos.copy(c.from); }
        } else if (name === 'release') {
          d.attract?.release(); d.attract = null;
          d.t0 = c.age;
          d.glow = 0;
          mist.pos.copy(c.from); mist.vel.copy(d.dir).multiplyScalar(2); mist.size = 0.7 * sz; mist.burst(6 * p.mist);
          fx.rig.shake(0.1, 10);
          if (c.form === 'Geyser') {
            // the orb dives into the floor at the target
            d.T = Math.min(Math.max(d.L / 22, 0.25), 0.45);
            lob(d.V0, c.from, _a.copy(d.Gp).setY(d.Gp.y - 0.1), d.T);
            d.tEnd = d.T; d.tb = 1.6 * d.T; d.aer = 0.02; d.r = d.R * 0.72; d.neck = 0; d.spreadK = 0; d.turb = 0.12; d.whip = 0;
            d.keep0 = 0.5; d.keep1 = 0.9; d.radial = 2.5; d.bead = 0.012; d.fan = 0; d.fanSp = 0; d.plane = 0;
          } else {
            d.T = d.A.distanceTo(d.hit) / d.speed;
            lob(d.V0, d.A, d.hit, d.T);
            d.tEnd = d.T; d.tb = 1.04 * d.T; d.aer = 0.1; d.r = d.rj; d.neck = 1.1; d.spreadK = 0.55; d.turb = 0.05; d.whip = p.whip;
            d.keep0 = 0.35; d.keep1 = 0.85; d.radial = 3.6 * p.splash; d.bead = 0.014; d.fan = 0.5; d.fanSp = 7.5 * p.splash; d.plane = 1;
          }
        } else if (name === 'impact') {
          d.tImp = c.age;
          d.landed = false;
          if (c.form === 'Geyser' && d.erupt < 0) { d.erupt = c.age - d.t0 - DOME; d.dome = 0; d.burst = true; eruptStart(c, d); burstStart(c, d); }
        } else if (name === 'done') {
          d.live = false; d.on = false; d.ball = 0; d.glow = 1;
          d.h?.release(); d.h = null;
          d.light?.release(); d.light = null;
          d.attract?.release(); d.attract = null;
          d.breeze?.release(); d.breeze = null;
        }
      },

      update(c, dt) {
        const p = S.params, d = ST[c.index], L = d.light;
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge, sz = p.size;
          // the orb's plasma dies down as water condenses round it
          d.glow = 1 - sstep(0, 0.55, k);
          d.ball = d.R * Math.max(sstep(0, 0.9, k), 0.02);
          d.clock = c.age;
          // droplets lifted out of the pool fly ballistic arcs that all land in the orb at release
          if (k < 0.72) {
            const T = Math.max(c.durations.charge - c.t + 0.04, 0.2);
            launch(bead.vel, POOL_SRC, c.from, T);
            bead.pos.copy(POOL_SRC); bead.life = T / 0.9; bead.rate(240 * p.droplets, dt);   // the attractor kills them on arrival
            fx.pool.swirl(POOL_SRC.x, POOL_SRC.z, 0.8 + k);
            d.poolTick -= dt;
            if (d.poolTick <= 0) { d.poolTick = 0.06; fx.pool.ripple(POOL_SRC.x + (fx.rand() - 0.5) * 1.6, POOL_SRC.z + (fx.rand() - 0.5) * 1.6, 0.008, 0.18); }
          }
          if (L) { L.pos.copy(c.from).setY(c.from.y + 0.5 * sz); L.intensity = 5 * k; L.cookie[2] = c.age * 0.5; }
          if (c.form === 'Geyser' && k > 0.45) {
            // the ground at the target starts to bubble
            const g = d.Gp;
            d.h?.burst(_p.copy(g).setY(g.y + 0.06), 0.14 * sz, _v.set(0, 1.4, 0), 0.0012 * sz ** 3, 0.5, 0.9, 0.5);
            sprayRing.pos.copy(g); sprayRing.radius = 0.45 * sz; sprayRing.vel.set(0, 1.4, 0); sprayRing.radial = 0.6; sprayRing.size = 0.7; sprayRing.rate(14 * p.mist, dt);
            d.splat -= dt;
            if (d.splat <= 0) { d.splat = 0.2; wetSplat(g.x, g.z, 1.2 * sz, 0.3 * p.wetness, c.seed + c.age * 7); if (nearPool(g.x, g.z, 0.6)) fx.pool.ripple(g.x, g.z, 0.01, 0.3); }
          }
          return;
        }
        if (c.form === 'Geyser') updateGeyser(c, d, dt); else updateLance(c, d, dt);
      },

      // once per frame: streams and balls upload their instance data, rings age; lens droplets dry
      tick(dt) {
        let n = 0, nb = 0, glow = 1;
        const A = iA.array, B = iB.array, C = iC.array, D = iD.array, EE = iE.array;
        for (const d of ST) {
          if (!d.live) continue;
          glow = Math.min(glow, d.glow);
          if (d.ball > 0.004 && n < MAX_STREAMS) {
            const o = n++ * 4;
            A[o] = d.A.x; A[o + 1] = d.A.y; A[o + 2] = d.A.z; A[o + 3] = d.seedF;
            B[o] = 0; B[o + 1] = 1; B[o + 2] = 0; B[o + 3] = d.ball;
            C[o] = 0; C[o + 1] = 0; C[o + 2] = d.clock; C[o + 3] = 0;
            D[o] = 1; D[o + 1] = 1; D[o + 2] = 1; D[o + 3] = 0;
            EE[o] = 0; EE[o + 1] = 0; EE[o + 2] = 0; EE[o + 3] = 0;
          }
          if (d.dome > 0.01 && n < MAX_STREAMS) {
            // the dome: a ball of clear water mostly under the floor, its cap swelling up
            const o = n++ * 4, sz = S.params.size, R = 1.1 * sz * Math.cbrt(d.dome);
            A[o] = d.Gp.x; A[o + 1] = d.Gp.y - R * (0.78 - 0.38 * d.dome); A[o + 2] = d.Gp.z; A[o + 3] = d.seedF;
            B[o] = 0; B[o + 1] = 1; B[o + 2] = 0; B[o + 3] = R;
            C[o] = 0; C[o + 1] = 0; C[o + 2] = d.clock; C[o + 3] = 0;
            D[o] = 1; D[o + 1] = 1; D[o + 2] = 1; D[o + 3] = 0.03;
            EE[o] = 0; EE[o + 1] = 0; EE[o + 2] = 0; EE[o + 3] = 0;
          }
          if (d.on && d.head > d.tail && n < MAX_STREAMS) {
            // a geyser is a bundle of jets that separate as they slow, not one tube
            const col = d.erupt >= 0, nt = col ? (low ? 3 : 5) : 1;
            for (let i = 0; i < nt && n < MAX_STREAMS; i++) {
              const o = n++ * 4;
              const a = i * 2.399 + d.phase, off = col && i ? 0.55 * d.rc * (0.7 + 0.3 * Math.sin(i * 1.7)) : 0;
              const sc = col ? (i ? 1 - 0.05 * (i % 3) : 1.02) : 1, tilt = col && i ? 0.055 * d.V0.y : 0;
              A[o] = (col ? d.Gp.x : d.A.x) + off * Math.cos(a); A[o + 1] = col ? d.Gp.y : d.A.y; A[o + 2] = (col ? d.Gp.z : d.A.z) + off * Math.sin(a); A[o + 3] = (d.seedF + i * 0.137) % 1;
              B[o] = d.V0.x * sc + tilt * Math.cos(a); B[o + 1] = d.V0.y * sc; B[o + 2] = d.V0.z * sc + tilt * Math.sin(a); B[o + 3] = col ? d.r * (i ? 0.46 + 0.12 * Math.sin(i * 2.3) : 0.72) : d.r;
              C[o] = d.tail; C[o + 1] = d.head * (col ? 0.92 + 0.08 * Math.sin(i * 3.1 + d.phase) : 1); C[o + 2] = d.clock + i * 0.31; C[o + 3] = d.whip;
              D[o] = col ? -1 : 0; D[o + 1] = d.tb; D[o + 2] = d.tEnd; D[o + 3] = d.aer;
              EE[o] = d.dissolve; EE[o + 1] = d.neck; EE[o + 2] = d.spreadK; EE[o + 3] = d.turb;
              if (i === 0 && nb < BEAD_STREAMS) {
                const j = nb++;
                bu.uBA.value[j].set(A[o], A[o + 1], A[o + 2], A[o + 3]);
                bu.uBB.value[j].set(B[o], B[o + 1], B[o + 2], d.r);
                bu.uBC.value[j].set(C[o], d.head, d.clock, C[o + 3]);
                bu.uBD.value[j].set(D[o], D[o + 1], D[o + 2], D[o + 3]);
                bu.uBE.value[j].set(d.keep0, d.keep1, d.radial, d.bead * Math.sqrt(S.params.size));
                bu.uBF.value[j].set(d.axis.x, d.axis.y, d.axis.z, d.fan);
                bu.uBG.value[j].set(d.fanSp, d.plane);
              }
            }
          }
        }
        streamGeo.instanceCount = n;
        streamMesh.visible = n > 0;
        if (n) iA.needsUpdate = iB.needsUpdate = iC.needsUpdate = iD.needsUpdate = iE.needsUpdate = true;
        const dens = Math.min(S.params.droplets, 1);
        beadGeo.instanceCount = nb ? Math.round(BEAD_N * (nb - 1 + dens)) : 0;
        beadMesh.visible = nb > 0 && dens > 0;
        // the plasma orb gives way to the water
        if (glow < 1 || dimmed) {
          fx.arena.setFocus(fx.arena.focus.color, 2.5 * glow);
          fx.arena.orb.visible = glow > 0.03;
          dimmed = glow < 1;
        }
        let m = 0;
        const R = rA.array;
        for (const r of rings) {
          if (!r.live) continue;
          r.age += dt;
          if (r.age > 3.6) { r.live = false; continue; }
          const o = m * 4;
          R[o] = r.x; R[o + 1] = r.z; R[o + 2] = r.age; R[o + 3] = r.amp;
          m++;
        }
        ringGeo.instanceCount = m;
        ringMesh.visible = m > 0;
        if (m) rA.needsUpdate = true;
        if (lensWet > 0) { lensWet = Math.max(0, lensWet - dt / 5); fx.post.params.droplets = lensWet; }
      },
    };
  },
};
