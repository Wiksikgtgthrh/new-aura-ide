import { NOISE_GLSL } from '../../vfx/common.js';

// Phoenix shaders (phoenix.js). Two AnalyticRibbons path/shade pairs:
//   BIRD   every ribbon of a bird (body, wing edges, wing feathers, tail streamers, crest) is posed in
//          the bird's local frame (x right, y up, z forward; metres = local units x scale) from the
//          per-bird uniform slots, so the CPU writes 5 vec4s per bird per frame and nothing per ribbon.
//          A flat wing is folded (spread), swept back (dive) and flapped (a rotation about the body
//          axis that grows and lags towards the tip and the trailing edge), then mirrored for the
//          left wing. phoenix.js mirrors armFlat/foldW/flapW to place emitters on the wing.
//   FEATHER stateless burning feathers: ballistic with drag, settling at a terminal speed with a
//          flutter, tumbling about a random axis, and burning from the tip down.
// Both layers share the GLSL: RIBBON_FX (half-res glow + heat haze) vs the full-res core lines.

const BIRD_HEAD = /* glsl */`
uniform vec4 uBirdA[4];   // pos xyz, scale (m per local unit)
uniform vec4 uBirdF[4];   // forward xyz, flap phase (rad)
uniform vec4 uBirdU[4];   // up xyz, flap amplitude (rad)
uniform vec4 uBirdW[4];   // spread 0..1, sweep 0..1, dihedral (rad), -
uniform vec4 uBirdT[4];   // tail bend x, y (local, per unit length), -, -
const float SX = 0.12;    // shoulder offset from the spine
vec3 armFlat(float s, float k) {
  return vec3(SX + 1.4 * s * mix(0.3, 1.0, k), 0.02 * s, 0.1 + 0.2 * sin(3.14159265 * min(s * 1.15, 1.0)) - 0.45 * s * s * s);
}
// fold back in the wing plane about the shoulder (beta > 0 moves the tip backwards)
vec3 foldW(vec3 p, float beta) {
  float dx = p.x - SX, dz = p.z - 0.1, c = cos(beta), s = sin(beta);
  return vec3(SX + dx * c + dz * s, p.y, 0.1 - dx * s + dz * c);
}
// flap about the body axis through the shoulder; amplitude grows to the tip, phase lags along the
// span and behind the leading edge (lag = metres behind it), so the wing whips instead of hinging
vec3 flapW(vec3 p, float lag, float ph, float amp, float dih) {
  float dx = p.x - SX, se = clamp(dx / 1.7, 0.0, 1.0);
  float x = ph - 1.1 * se - 1.6 * lag;
  float th = dih * (0.6 + 0.4 * se) + amp * (sin(x) + 0.22 * sin(2.0 * x)) * (0.45 + 0.75 * se);
  float c = cos(th), s = sin(th);
  return vec3(SX + dx * c - p.y * s, dx * s + p.y * c, p.z);
}
`;

// p0 = (mode, slot, side, -). mode 0 body, 1 wing leading edge, 2 wing feather, 3 tail, 4 crest.
// p1 = (span s | lateral, length, width, splay angle | phase), p2 = (seed, heat, -, -)
export const BIRD_PATH = BIRD_HEAD + /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  int mode = int(p0.x + 0.5), b = int(p0.y + 0.5);
  vec4 A = uBirdA[b], F = uBirdF[b], Uu = uBirdU[b], W = uBirdW[b], T = uBirdT[b];
  float k = W.x, beta = (1.0 - k) * 1.3 + W.y * 0.6;
  float bob = 0.035 * sin(F.w + 1.7);   // the body rises on the downstroke
  vec3 q;
  if (mode == 0) {
    q = vec3(0.0, 0.2 * smoothstep(0.5, 0.82, t) - 0.06 * smoothstep(0.84, 1.0, t) - 0.04 * exp(-pow((t - 0.35) / 0.2, 2.0)) + bob * smoothstep(0.4, 1.0, t), -0.5 + 1.34 * t);
    width = (0.09 * (1.0 - t) + 0.26 * exp(-pow((t - 0.36) / 0.17, 2.0)) + 0.19 * exp(-pow((t - 0.8) / 0.075, 2.0))) * (1.0 - smoothstep(0.86, 1.0, t));
  } else if (mode <= 2) {
    vec3 f;
    float lag = 0.0;
    if (mode == 1) {
      f = armFlat(t, k);
      width = p1.z * (1.0 - 0.6 * t);
    } else {
      float L = p1.y * mix(0.55, 1.0, k);
      float an = p1.w * mix(0.15, 1.0, k) + 0.18 * t;
      f = armFlat(p1.x, k) + vec3(0.0, -0.01, -0.02) + vec3(sin(an), -0.05 * t, -cos(an)) * (L * t);
      lag = L * t;
      width = p1.z * smoothstep(0.0, 0.2, t) * (1.0 - 0.75 * t * t);
    }
    q = flapW(foldW(f, beta), lag, F.w, Uu.w, W.z);
    q.y += bob * 0.3;
    q.x *= p0.z;
  } else if (mode == 3) {
    float L = p1.y, ph = p1.w + uTime * 5.0;
    q = vec3(p1.x * t * 1.3, -0.05 * t, -0.45 - L * t);
    q.x += sin(4.5 * t - ph) * 0.16 * t * t * (1.0 + abs(p1.x) * 4.0);
    q.y += cos(3.5 * t - ph * 0.8) * 0.12 * t * t;
    q.xy += T.xy * (t * t * L);
    width = p1.z * (0.45 * (1.0 - t) + 1.25 * exp(-pow((t - 0.8) / 0.12, 2.0))) * (1.0 - smoothstep(0.92, 1.0, t));
  } else {
    float ph = p1.w + uTime * 9.0;
    q = vec3(0.0, 0.21 + bob, 0.56) + vec3(p1.x * t, 0.07 * t + 0.14 * t * t + 0.035 * sin(t * 6.0 - ph) * t, -p1.y * t);
    width = p1.z * pow(1.0 - t, 0.8) * smoothstep(0.0, 0.12, t);
  }
#ifdef RIBBON_FX
  width *= 1.6 * A.w;
#else
  width *= 0.12 * A.w;
#endif
  vec3 Fw = F.xyz, Uw = Uu.xyz, Rw = cross(Uw, Fw);
  return A.xyz + (Rw * q.x + Uw * q.y + Fw * q.z) * A.w;
}`;

const RAMP = NOISE_GLSL + /* glsl */`
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uCool;
uniform float uHaze;
vec3 fireRamp(float h) { return h < 0.5 ? mix(uCool, uMid, h * 2.0) : mix(uMid, uHot, h * 2.0 - 1.0); }
`;

export const BIRD_SHADE = RAMP + /* glsl */`
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  int mode = int(r.p0.x + 0.5);
  float u = r.uv.x, v = r.uv.y, av = abs(v), seed = r.p2.x;
  float h;
  if (mode == 0) h = 0.97 - 0.3 * smoothstep(0.85, 1.0, u);
  else if (mode == 1) h = 0.95 - 0.3 * u;
  else if (mode == 2) h = mix(0.78, 0.12, pow(u, 0.8)) * r.p2.y;
  else if (mode == 3) h = mix(0.75, 0.1, u) + 0.35 * exp(-pow((u - 0.8) / 0.08, 2.0));
  else h = 0.8 - 0.65 * u;
  // flame streaming from root to tip
  float n = noise3(vec3(u * 0.45 - uTime * 0.42 + seed, av * 0.06 + seed * 0.37, uTime * 0.03));
  float n2 = noise3(vec3(u * 1.1 - uTime * 0.9 + seed * 1.7, v * 0.09, 0.5 + seed));
  float fl = n * 0.6 + n2 * 0.4;
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
#ifdef RIBBON_FX
  float edge = smoothstep(0.0, 0.45, (1.0 - av) - (fl - 0.45) * 1.2);
  float g = edge * (0.45 + 1.1 * fl) * exp(-1.4 * v * v);
  h = clamp(h + (fl - 0.5) * 0.45 - av * 0.45, 0.0, 1.0);
  distortion = uHaze * v * exp(-3.0 * v * v) * 2.33;
  // flame is far brighter than the sky behind it: let it cover the background instead of only
  // adding to it (pure additive orange over blue sky reads pink), with sooty cool fringes
  media = vec3(0.05, 0.032, 0.02);
  alpha = min(g * 0.42, 0.7);
  return fireRamp(h) * r.color * g;
#else
  float core = exp(-5.0 * v * v) * (0.55 + 0.7 * fl);
  return fireRamp(clamp(h + 0.1, 0.0, 1.0)) * r.color * core;
#endif
}`;

// p0 = (origin xyz, birth time), p1 = (initial velocity xyz, life), p2 = (terminal fall m/s,
// tumble rad, -, drag 1/s), p3 = (length m, width m, seed, heat 0..1)
export const FEATHER_PATH = /* glsl */`
vec3 rotAxis(vec3 v, vec3 k, float a) { float c = cos(a), s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  float age = mod(uTime - p0.w + 3600.0, 3600.0), kd = p2.w;
  float e = (1.0 - exp(-kd * age)) / kd;
  float s = p3.z;
  vec3 c = p0.xyz + p1.xyz * e;
  c.y -= p2.x * (age - e);
  float fl = 1.0 - exp(-age * 1.5);
  c.x += sin(age * 3.1 + s * 7.0) * 0.25 * fl;
  c.z += cos(age * 2.7 + s * 5.0) * 0.25 * fl;
  c.y = max(c.y, 0.06);
  vec3 sp = normalize(hash31(s * 17.0 + 3.1) - 0.5 + 1e-3);
  vec3 ax = rotAxis(normalize(p1.xyz + vec3(0.0, 1e-3, 0.0)), sp, p2.y * e + 0.7 * sin(age * 2.3 + s * 3.0) * fl);
  vec3 bend = normalize(cross(ax, sp) + 1e-4);
  float L = p3.x;
  width = p3.y * smoothstep(0.0, 0.25, t) * (1.0 - t * t * t);
#ifdef RIBBON_FX
  width *= 1.25;
#else
  width *= 0.12;
#endif
  return c + ax * ((t - 0.55) * L) + bend * ((t - 0.5) * (t - 0.5) * L * 0.35);
}`;

export const FEATHER_SHADE = RAMP + /* glsl */`
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  float age = mod(uTime - r.p0.w + 3600.0, 3600.0), life = r.p1.w, b = clamp(age / life, 0.0, 1.0);
  float u = r.uv.x, v = r.uv.y, av = abs(v);
  float n = noise3(vec3(u * 0.35 + r.p3.z, v * 0.05, age * 0.08));
  // burns from the tip down to the quill, with a glowing ember front
  float front = 1.08 - 1.3 * b + (n - 0.5) * 0.35;
  float vis = smoothstep(front + 0.03, front - 0.08, u) * smoothstep(0.0, 0.06, age);
  float ember = exp(-pow((u - front) / 0.05, 2.0)) * smoothstep(0.0, 0.15, b) * (1.0 - smoothstep(0.85, 1.0, b));
  float heat = clamp(r.p3.w * (0.62 - 0.4 * b) + (n - 0.5) * 0.3, 0.0, 1.0);
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
#ifdef RIBBON_FX
  // vane with diagonal barbs either side of the rachis
  float barbs = 0.62 + 0.38 * sin((u * 9.0 - av * 1.6) * 6.2831853 + r.p3.z * 3.0);
  float vane = exp(-1.6 * v * v) * mix(1.0, barbs, smoothstep(0.08, 0.3, av));
  // burnt-out barbs behind the front: a brief curl of black char that crumbles away
  float charB = smoothstep(front - 0.02, front + 0.04, u) * (1.0 - smoothstep(front + 0.06, front + 0.3 + 0.2 * n, u));
  float flake = step(0.38, noise3(vec3(u * 3.0 + r.p3.z, v * 0.25, 0.0)));
  media = vec3(0.035, 0.028, 0.024);
  alpha = (vane * vis * 0.4 + vane * charB * flake * 0.75) * smoothstep(0.0, 0.06, age);
  distortion = uHaze * 0.5 * v * exp(-3.0 * v * v) * 2.33 * vis;
  return (fireRamp(heat) * vane * vis * 0.8 + uHot * ember * 0.9) * r.color;
#else
  return (fireRamp(clamp(heat + 0.2, 0.0, 1.0)) * vis + uHot * ember * 2.0) * r.color * exp(-4.0 * v * v);
#endif
}`;
