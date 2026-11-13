import { COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL } from '../../vfx/common.js';
import { SWARM_STATE_GLSL, SWARM_DUMMY_GLSL, SWARM_BOIDS_GLSL } from '../acid/plague-swarm.glsl.js';

// Ember Swarm shaders, on the GPU agent engine in plague-swarm.glsl.js (same state, flocking grid
// and floor light). Agent states: 1 flying hot, 2 stuck burning on the dummy, 3 cooling flake,
// 4 lying on the floor (v.x = its temperature on landing), 5 spent.

// --- temperature: shared by the sim (hot ash rises) and the look ---------------------------------
// each ember has its own: most are dull, a few burn far hotter (steep power law). Flying, airflow
// fans it. Falling, radiative cooling (dT/dt ~ -T^4) gives T = T0 / cbrt(1 + t / tc).
const KELVIN_GLSL = /* glsl */`
uniform vec4 uHeat;   // base temperature (K), airflow fan share, global heat, -
vec4 emberHash(int idx) { return hash41(float(idx) * 0.5772157 + 2.9); }
float emberKelvin(int idx, vec3 v, float st, float age) {
  vec4 e = emberHash(idx);
  float T0 = uHeat.x * mix(0.74, 1.3, e.x * e.x);   // median as before (flake lifetimes, so cost, unchanged), fewer white-hot outliers
  float tc = mix(0.14, 0.55, e.y);
  if (st > 3.5) return v.x * pow(1.0 + age / (tc * 10.0), -0.3333);
  if (st > 2.5) return T0 * 1.12 * pow(1.0 + age / tc, -0.3333);
  if (st > 1.5) return T0 * 1.12 * pow(1.0 + age / (tc * 3.0), -0.3333);
  return T0 * uHeat.z * (1.0 + uHeat.y * smoothstep(1.5, 9.0, length(v)));
}
float emberRestLife(vec4 h) { return mix(2.0, 4.2, h.w); }
`;

// --- behaviour ------------------------------------------------------------------------------------
export const EMBER_SIM = /* glsl */`
uniform vec4 uLeader;    // cloud centre xyz, radius (m)
uniform vec4 uLeaderV;   // leader velocity xyz, -
uniform vec4 uTarget;    // shell centre xyz, radius
uniform vec4 uMode;      // shell on 0..1, disperse 0..1, landing share, attrition share
uniform vec4 uFlock;     // alignment, separation, cohesion, turbulence
uniform vec4 uMove;      // cruise m/s, orbit m/s, steering gain, rest density (agents / cell)
uniform vec4 uSpawnP;    // orb centre xyz, radius
uniform vec4 uSpawnF;    // floor spawn centre x, z, radius, share of the swarm
uniform vec4 uClock;     // s since dispersal (-1 before), force response, s since shell closed (-1 before), hold (s)
uniform vec4 uPathA;     // ribbon path: start xyz, duration (s)
uniform vec4 uPathM;     // its Bezier control point xyz, cast clock (s)
uniform vec4 uPathB;     // its end xyz, start time (s)
uniform vec4 uStream;    // delay spread along the ribbon (s), half-width (m), -, -
uniform vec4 uDummyP;    // target dummy base xyz, 1 = landing allowed
uniform mat3 uDummyR;
${KELVIN_GLSL}
${SWARM_BOIDS_GLSL}
${SWARM_DUMMY_GLSL}
vec3 pathAt(float s) {
  s = clamp(s, 0.0, 1.0);
  float k = s * s * (3.0 - 2.0 * s) * 0.6 + s * s * 0.4, i = 1.0 - k;
  return i * i * uPathA.xyz + 2.0 * i * k * uPathM.xyz + k * k * uPathB.xyz;
}

void swarmSpawn(int idx, vec4 h, inout vec3 p, inout vec3 v) {
  vec3 r = hash31(float(idx) * 1.37 + uTime * 13.1);
  if (h.z < uSpawnF.w) {   // lifting off the floor around the caster
    float a = r.x * 6.2832, R = uSpawnF.z * sqrt(mix(0.04, 1.0, r.y));
    p = vec3(uSpawnF.x + cos(a) * R, 0.03, uSpawnF.y + sin(a) * R);
    v = vec3(0.0, 1.4 + 2.2 * r.z, 0.0) + normalize(uLeader.xyz - p) * (0.5 + r.y) + vec3(-sin(a), 0.0, cos(a)) * 1.1;
  } else {                 // boiling out of the orb
    vec3 d = randomOnSphere(r.xy);
    p = uSpawnP.xyz + d * uSpawnP.w * (0.4 + 0.6 * r.z);
    v = (normalize(cross(vec3(0.0, 1.0, 0.0), d) + 1e-4) * 2.4 + vec3(0.0, 1.8, 0.0) + d * 1.2 + normalize(uLeader.xyz - p)) * mix(0.7, 1.3, h.y);
  }
}

void swarmStep(int idx, vec4 h, inout vec3 p, inout vec3 v, inout float st, inout float age, float dt) {
  vec4 h2 = swarmHash2(idx), h3 = swarmHash3(idx);
  float t = uTime;
  if (st > 3.5) {   // on the floor: smoulders out, then it's gone (v.x = landing temperature)
    if (age > emberRestLife(h)) st = 5.0;
    return;
  }
  if (st > 2.5) {   // a cooling flake: hot ash rides its own draught, cold ash flutters down
    float hot = smoothstep(800.0, 1500.0, emberKelvin(idx, v, st, age));
    vec3 wind = curl3(p * 0.22 + vec3(0.0, t * 0.03, 0.4)) * 1.1 + curl3(p * 1.3 + h.xyz * 5.0 + t * 0.25) * 0.7;
    vec3 drift = vec3(0.0, 1.3 * hot - mix(0.55, 1.25, h.y), 0.0) + wind;
    v += (drift - v) * (1.0 - exp(-mix(1.6, 3.4, h.z) * dt));
    float kill = 0.0;
    v += forceAccel(p, v, kill) * uClock.y * dt;
    p += v * dt;
    float d = arenaSDF(p);
    if (d < 0.006) {
      vec3 n = arenaNormal(p);
      p += n * (0.006 - d);
      if (n.y > 0.5) { v = vec3(emberKelvin(idx, v, st, age), 0.0, 0.0); st = 4.0; age = 0.0; }
      else v -= n * min(dot(v, n), 0.0);
    } else if (age > 14.0) st = 5.0;
    return;
  }
  if (st > 1.5) {   // stuck to the dummy, burning into it
    vec3 n = dummyNormal(p);
    p -= n * (dummySDF(p) - 0.006);
    v = vec3(0.0);
    if (uDummyP.w < 0.5 || age > mix(1.2, 3.4, h3.y)) { st = 3.0; age = 0.0; v = n * 0.7; }
    return;
  }

  // --- flying ---
  vec3 rr = p - uTarget.xyz;
  if (uClock.x >= 0.0 && uClock.x > h2.z * 0.25) {   // the burst: the flock flies apart and cools
    st = 3.0; age = 0.0;
    vec3 dir = normalize(rr * vec3(1.0, 0.75, 1.0) + (h.xyz - 0.5) * 0.6 + vec3(0.0, 0.3, 0.0) + 1e-3);
    v = dir * mix(3.5, 12.0, h3.y * h3.y) + v * 0.35;
    p += v * dt;
    return;
  }
  // each ember leaves on its own delay: the sheet below unwinds in delay order, into the ribbon
  float sPath = (uPathM.w - h2.z * uStream.x - uPathB.w) / uPathA.w;
  float env = smoothstep(0.82, 1.1, sPath) * uMode.x, inStream = (1.0 - env) * step(0.0, sPath);
  float cruise = uMove.x * mix(0.75, 1.25, h.y);
  vec3 acc = boidAccel(p, v) * (1.0 - 0.75 * inStream);

  // goal 1: a slot on a slowly folding, precessing sheet (the murmuration)
  float tS = t * 0.62, r0 = sqrt(h3.x), th = h2.z * 6.2832;
  vec3 o = vec3(r0 * cos(th), (h3.z - 0.5) * 0.16, r0 * sin(th));
  o.y += 0.6 * sin(2.1 * o.x + 1.3 * tS) + 0.42 * sin(1.7 * o.z - 0.9 * tS + 1.7) + 0.3 * o.x * o.z * sin(0.7 * tS);
  float ys = 0.5 * tS, tilt = 0.55 * sin(0.42 * tS) + 0.45;
  o.xz = mat2(cos(ys), -sin(ys), sin(ys), cos(ys)) * (o.xz * vec2(1.0 + 0.4 * sin(0.6 * tS), 1.0 - 0.3 * sin(0.6 * tS)));
  o.xy = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * o.xy;
  o += 0.2 * curl3(o * 0.3 + vec3(0.13, tS * 0.04, 0.71));
  vec3 goal = uLeader.xyz + o * uLeader.w, lv = uLeaderV.xyz;
  if (sPath > 0.0) {   // in the ribbon: a flat, twisting cross-section that undulates down its length
    vec3 P = pathAt(sPath);
    lv = (P - pathAt(sPath - 0.02 / uPathA.w)) / 0.02;
    vec3 T = normalize(lv + vec3(1e-4, 0.0, 0.0)), S = normalize(cross(T, vec3(0.0, 1.0, 0.0)) + 1e-4), N = cross(S, T);
    float bell = sin(3.14159 * clamp(sPath, 0.0, 1.0)), tw = sPath * 5.5 + t * 1.3;
    float W = uStream.y * (0.12 + sqrt(max(4.0 * h2.z * (1.0 - h2.z), 0.0)));
    P += (S * sin(sPath * 7.0 - t * 3.1) * 0.5 + N * sin(sPath * 4.3 - t * 2.2) * 0.4) * bell;
    goal = P + (S * cos(tw) + N * sin(tw)) * (h3.x * 2.0 - 1.0) * W + (N * cos(tw) - S * sin(tw)) * (h3.z - 0.5) * W * 0.22;
  }
  vec3 dc = (goal - p) * mix(3.0, 5.0, inStream);
  float dl = length(dc), cap = cruise * mix(1.7, 3.0, inStream);
  if (dl > cap) dc *= cap / dl;
  vec3 dCloud = dc + lv;

  // goal 2: the shell. Three wound bands on precessing axes and a diffuse share: the ribbon keeps
  // its windings, like thread on a ball, and a loose halo of long strays outside it
  float R = uTarget.w;
  vec3 rs = rr / vec3(1.0, 1.25, 1.0);
  float dist = max(length(rs), 1e-3);
  float axA = floor(h3.w * 3.0) * 2.0944 + t * 0.23;
  vec3 ax = normalize(normalize(vec3(cos(axA) * 0.62, 1.0, sin(axA) * 0.62)) + (vec3(h2.x, h.w, h3.y) - 0.5) * 0.5);
  if (h3.z < 0.08) ax = -ax;   // a few fly against the stream
  float lump = noise3(rs / dist * 0.35 + vec3(t * 0.06, 0.0, 0.31)) - 0.5;
  bool stray = h2.x > 0.88;
  float shellR = R * (1.0 + 0.05 * sin(t * 1.9 + h.x * 0.8)) * (1.0 + 0.8 * lump) * (stray ? mix(1.3, 2.3, h3.x) : mix(0.9, 1.1, h3.x));
  float la = dot(rr, ax), latGoal = (h3.x - 0.5) * R * (fract(h3.w * 3.0) < 0.7 ? 0.7 : 1.9);
  vec3 tang = normalize(cross(ax, rr) + 1e-4);
  float vt = uMove.y * mix(0.7, 1.25, h.w) * (stray ? 0.75 : 1.0);
  vec3 dEnv = tang * vt + (rs / dist) * (shellR - dist) * 5.0 + ax * (latGoal - la) * 2.2;
  // centripetal feed-forward: hold the circle about the ember's own axis
  vec3 q = rr - ax * la;
  float qr = max(length(q), 0.25);
  acc -= q / qr * (vt * vt / qr) * env;
  // landers make for the dummy and stick there, burning
  bool lander = h2.w < uMode.z && uDummyP.w > 0.5;
  float dd = 1e3;
  if (lander) {
    dd = dummySDF(p);
    dEnv = mix(dEnv, -dummyNormal(p) * clamp(dd * 4.0, 0.5, cruise) + tang * 0.6, smoothstep(1.4, 0.35, dd));
    if (dd < 0.025 && env > 0.9) { st = 2.0; age = 0.0; v = vec3(0.0); return; }
  }
  acc += uMove.z * mix(1.0 + 2.2 * inStream, 2.6, env) * (mix(dCloud, dEnv, env) - v);

  // turbulence: swarm-scale eddies, each ember's own wander, sudden darts in the shell
  acc += curl3(p * 0.06 + vec3(0.0, t * 0.025, 0.0)) * uFlock.w * 2.4;
  acc += curl3(p * 0.85 + h.xyz * 7.0 + vec3(t * 0.37)) * uFlock.w * mix(1.0, 3.2, env);
  acc += curl3(p * 2.2 + h.zxy * 13.0 + vec3(t * 1.3)) * uFlock.w * 4.0 * env;
  float sp = length(v);
  acc += (v / max(sp, 1e-3)) * (cruise - sp) * 1.3 * (1.0 - inStream);
  // the world: floor, rim, pillars, dummies (not the lander's own target), other spells' forces
  float kill = 0.0;
  bool nearTarget = lander && dd < 1.0;
  float dw = nearTarget ? p.y : arenaSDF(p);
  if (dw < 0.6) acc += (nearTarget ? vec3(0.0, 1.0, 0.0) : arenaNormal(p)) * (0.6 - dw) * 26.0;
  acc += forceAccel(p, v, kill) * uClock.y;
  v += acc * dt;
  sp = length(v);
  float vMax = cruise * mix(2.3, 3.6, inStream);
  if (sp > vMax) v *= vMax / sp;
  p += v * dt;
  float d2 = (nearTarget ? p.y : arenaSDF(p)) - 0.02;
  if (d2 < 0.0) {
    vec3 nn = nearTarget ? vec3(0.0, 1.0, 0.0) : arenaNormal(p);
    p -= nn * d2;
    v -= nn * min(dot(v, nn), 0.0) * 1.3;
  }
  // the shell sheds: its own moment for each, it stops flying, cools and falls
  if (uClock.z >= 0.0 && h2.y < uMode.w && uClock.z > fract(h2.y * 7.31) * uClock.w) { st = 3.0; age = 0.0; v *= 0.45; }
}`;

// --- look -----------------------------------------------------------------------------------------
export const EMBER_LOOK = /* glsl */`
uniform vec4 uLook;   // size, glow, shutter (s), arcane share
uniform vec4 uShape;  // master fade, shell curvature 0..1, overlap dimming, share leaving a flake
uniform vec4 uTarget;
uniform vec3 uArcane; // luminance-1 magenta
${KELVIN_GLSL}
// Stefan-Boltzmann, with the Draper point: nothing visible below ~800 K
float emberI(float T) { float r = T / 1500.0; r *= r; return r * r * smoothstep(760.0, 980.0, T); }
float emberFade(float st, float age) { return uShape.x * (st < 1.5 ? smoothstep(0.0, 0.5, age) : 1.0); }
// slow breathing of the burn (the fast tumbling is per pixel along the streak)
float emberBreath(vec4 e) { return 0.78 + 0.22 * sin(uTime * mix(2.0, 7.0, e.z) + e.w * 40.0); }
vec3 swarmLight(int idx, vec4 h, vec3 p, vec3 v, float st, float age) {
  float T = emberKelvin(idx, v, st, age);
  return blackbody(T) * emberI(T) * emberFade(st, age) * uLook.y;
}
`;

// a long-exposure streak: the ember's real path over the shutter (bent by its orbit), with its
// temperature on the head and its tumbling drawn along the length as dashes. x: -1 head cap,
// 0..1 along the path, 2 tail cap; y: -1..1 across.
export const STREAK_VERT = (W) => /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
${COMMON_GLSL}
${NOISE_GLSL}
${SWARM_STATE_GLSL(W)}
${EMBER_LOOK}
out vec3 vUvC;     // s along, y across, cap -1..1
out vec3 vCol;
out vec3 vCore;
out vec3 vTumble;  // phase at the head, radians over the streak, depth
void main() {
  int idx = gl_InstanceID;
  ivec2 px = swarmTexel(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUvC = vec3(0.0); vCol = vCore = vTumble = vec3(0.0);
  float st = s1.w;
  if (st < 0.5 || st > 4.5) return;
  float T = emberKelvin(idx, s1.xyz, st, s0.w);
  float I = emberI(T) * emberFade(st, s0.w);
  if (I < 1e-3) return;
  vec4 e = emberHash(idx);
  vec3 p = s0.xyz, v = (st > 1.5 && st < 2.5) || st > 3.5 ? vec3(0.0) : s1.xyz;
  float tau = uLook.z * mix(0.6, 1.4, e.y);
  // the path backwards over the shutter: x(-t) = p - v t + a t^2 / 2, a = the orbit's centripetal
  vec3 a = vec3(0.0);
  float sp2 = dot(v, v);
  if (st < 1.5 && sp2 > 0.01) {
    vec3 rr = p - uTarget.xyz;
    vec3 q = rr - v * (dot(rr, v) / sp2);
    float q2 = dot(q, q);
    a = -q * (min(sp2 / max(q2, 0.09), 60.0)) * uShape.y * (1.0 - smoothstep(4.0, 9.0, dot(rr, rr)));
  }
  // overlap: thousands of lines in one place must keep their structure, so the dense parts run dimmer
  float dens = st < 1.5 ? uShape.z * mix(1.0, 0.14, uShape.y * (1.0 - smoothstep(1.15, 1.7, length(p - uTarget.xyz) / uTarget.w))) : mix(0.35, 1.0, smoothstep(0.0, 0.5, s0.w));
  float s = clamp(position.x, 0.0, 1.0), cap = position.x < 0.0 ? -1.0 : position.x > 1.0 ? 1.0 : 0.0;
  float ts = tau * s;
  vec3 P = p - v * ts + a * (0.5 * ts * ts), dP = (a * ts - v) * tau;
  vec4 Pv = viewMatrix * vec4(P, 1.0);
  Pv.z += 0.02;
  vec2 tv = (mat3(viewMatrix) * dP).xy;
  float len = length(tv);
  vec2 dir = len > 1e-5 ? tv / len : vec2(1.0, 0.0), perp = vec2(-dir.y, dir.x);
  float viewZ = max(-Pv.z, 0.05);
  float pxWorld = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float breath = emberBreath(e);
  // sizes run a power law, as in wildfire ember showers: mostly grains, a few fat burning flakes
  float big = e.z * e.z * e.z;
  float size = uLook.x * 0.0052 * mix(0.55, 2.2, big) * (0.7 + 0.3 * breath);   // mean and mean-square width at or under a uniform spread: no extra fill
  float w = max(size, 1.05 * pxWorld), aa = size / w;
  // it never flies a ruled line: a small wander grows down the tail
  Pv.xy += perp * (0.035 * len * s * sin(s * (3.0 + 9.0 * e.x) + e.y * 40.0 + uTime * 3.0));
  Pv.xy += dir * cap * w + perp * position.y * w;
  gl_Position = projectionMatrix * Pv;
  // the same energy spread down the streak, a little held back so long streaks still read
  // (a sub-pixel ember keeps more than its area: seen from across the arena it is a point of light
  // that blooms, not a dim smear)
  float k = pow(2.0 * w / (len + 2.0 * w), 0.55) * pow(aa, 0.4) * smoothstep(0.25, 0.8, viewZ) * breath * uLook.y * I * dens;
  // the hottest cores whiten; for the arcane touch one ember in eight (once it burns properly) runs
  // magenta, so the swarm is shot through with it instead of tinted pink (the hot ones carry most
  // of the light: they stay blackbody)
  // the glow is the ember's own blackbody colour; the core reads a step hotter (yellow, as a camera
  // sees a glowing ember), never white
  float hot = smoothstep(uHeat.x * 1.1, uHeat.x * 1.4, T);
  float arc = uLook.w * 1.5 * step(0.875, e.w) * smoothstep(1050.0, 1350.0, T);
  vCol = mix(blackbody(T), uArcane, min(arc, 0.9)) * k;
  vCore = mix(blackbody(T * 1.3), uArcane, min(arc, 0.7)) * k * (0.4 + 0.7 * hot);
  float om = mix(60.0, 220.0, e.z);
  vUvC = vec3(s, position.y, cap);
  vTumble = vec3(om * uTime + e.w * 80.0, -om * tau, e.w > 0.55 ? 0.72 : 0.18);
}`;

export const STREAK_FRAG = /* glsl */`
precision highp float;
in vec3 vUvC;
in vec3 vCol;
in vec3 vCore;
in vec3 vTumble;
out vec4 fragColor;
void main() {
  float s = vUvC.x, d2 = vUvC.y * vUvC.y + vUvC.z * vUvC.z;
  float dash = 1.0 - vTumble.z * (0.5 + 0.5 * cos(vTumble.x + vTumble.y * s));
  fragColor = vec4((vCol * exp(-d2 * 3.0) + vCore * exp(-d2 * 20.0)) * dash * mix(1.0, 0.3, s), 0.0);
}`;

// flakes: what is left of an ember. Ragged tumbling scraps in the opaque pass (alpha to coverage),
// charred and lit by the sky and the spell's lights, their burning edge still glowing while hot
export const FLAKE_VERT = (W) => /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
${COMMON_GLSL}
${NOISE_GLSL}
${WORLD_GLSL}
${LIGHTS_GLSL}
${SWARM_STATE_GLSL(W)}
${EMBER_LOOK}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uAsh;
out vec2 vUv;
out vec3 vLit;
out vec3 vEmit;
out vec2 vK;       // shape seed, alpha
void main() {
  int idx = gl_InstanceID;
  ivec2 px = swarmTexel(idx);
  vec4 s0 = texelFetch(uS0, px, 0), s1 = texelFetch(uS1, px, 0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vUv = vK = vec2(0.0); vLit = vEmit = vec3(0.0);
  float st = s1.w;
  if (st < 1.5 || st > 4.5) return;
  vec4 h = swarmHash(idx), e = emberHash(idx);
  float age = s0.w;
  float fade = uShape.x * (st > 3.5 ? 1.0 - smoothstep(emberRestLife(h) - 1.2, emberRestLife(h), age) : 1.0);
  if (fade <= 0.0) return;
  vec3 p = s0.xyz, ax1, ax2;
  if (st > 3.5) {   // lying flat
    float a = h.y * 6.2832;
    ax1 = vec3(cos(a), 0.0, sin(a)); ax2 = vec3(-sin(a), 0.0, cos(a));
    p.y += 0.004;
  } else {          // tumbling (still, once stuck to the dummy)
    float w = st > 2.5 ? mix(2.0, 9.0, e.w) : 0.0, a1 = uTime * w + h.x * 50.0, a2 = uTime * w * 0.63 + h.y * 50.0;
    ax1 = vec3(cos(a1), sin(a1) * cos(a2), sin(a1) * sin(a2));
    ax2 = normalize(cross(ax1, normalize(h.xyz - 0.5 + 1e-3)));
  }
  // most sparks burn out to nothing as they cool; what stays is fine powder and a few real scraps
  float keep = step(e.w, uShape.w) + (1.0 - step(e.w, uShape.w)) * smoothstep(850.0, 1050.0, emberKelvin(idx, s1.xyz, st, age));
  if (keep <= 0.0) return;
  float L = 0.012 * uLook.x * mix(0.45, 2.0, pow(e.z, 4.0)) * keep;
  vec4 cv = viewMatrix * vec4(p, 1.0);
  float viewZ = max(-cv.z, 0.05);
  if (viewZ < 0.15) return;
  float pxW = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float grow = max(1.0, 0.9 * pxW / L);   // never thinner than a pixel: spread as coverage instead
  vec3 Pw = p + (ax1 * position.x + ax2 * position.y * 0.75) * L * grow;
  gl_Position = projectionMatrix * viewMatrix * vec4(Pw, 1.0);
  vUv = position.xy;
  vK = vec2(h.z * 40.0, fade / (grow * grow));
  float T = emberKelvin(idx, s1.xyz, st, age);
  gLightNoShadow = true;
  vec3 n = normalize(cross(ax1, ax2));
  vLit = uAsh * mix(0.5, 1.6, e.x) * (uAmbient * 1.6 + uSunColor * abs(dot(n, uSunDir)) * 0.5 + spellLightDiffuse(p, vec3(0.0)) * 0.6);
  vEmit = blackbody(T) * emberI(T) * uLook.y * 0.3;
}`;

export const FLAKE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
in vec3 vLit;
in vec3 vEmit;
in vec2 vK;
out vec4 fragColor;
void main() {
  float r = length(vUv), th = atan(vUv.y, vUv.x);
  float edge = 0.7 + 0.14 * sin(th * 2.0 + vK.x) + 0.12 * sin(th * 5.0 + vK.x * 2.3) + 0.06 * sin(th * 11.0 + vK.x * 3.7);
  float a = (1.0 - smoothstep(edge - 0.12, edge, r)) * vK.y;
  if (a < 0.04) discard;
  fragColor = vec4(vLit + vEmit * (0.04 + 1.4 * smoothstep(edge - 0.35, edge - 0.02, r)), a);
}`;
