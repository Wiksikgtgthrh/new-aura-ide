import { COMMON_GLSL, NOISE_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL } from '../../vfx/common.js';

// Ball lightning shaders. The body is an emissive shell drawn in the lines pass (full res,
// additive, depth tested on its own wobbling surface); the corona is a camera-facing quad in the
// half-res fx pass (emission + a heat shimmer, soft-faded against the scene).

// three's ShaderMaterial supplies projectionMatrix, viewMatrix, cameraPosition and position
export const BODY_VERT = /* glsl */`
uniform vec4 uBall;    // centre xyz, radius m
uniform vec4 uBall2;   // time, wobble, seed, instability
out vec3 vWorld;
void main() {
  vec3 n = normalize(position);
  float t = uBall2.x, s = uBall2.z;
  // three travelling sine lobes: a plasma blob that never holds still
  float w = sin(dot(n, vec3(2.1, 1.3, -1.7)) * 2.0 + t * 5.3 + s)
          + 0.6 * sin(dot(n, vec3(-1.1, 2.4, 0.9)) * 3.1 - t * 7.9 + s * 2.0)
          + 0.35 * sin(dot(n, vec3(1.9, -2.2, 2.6)) * 4.7 + t * 12.3);
  vec3 p = uBall.xyz + n * uBall.w * (1.0 + uBall2.y * w * 0.5);
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

export const BODY_FRAG = COMMON_GLSL + NOISE_GLSL + /* glsl */`
uniform vec4 uBall;
uniform vec4 uBall2;   // time, wobble, seed, instability
uniform vec4 uLook;    // intensity, core size, veins, white flash
uniform vec3 uCore;
uniform vec3 uGlow;
uniform vec3 uVein;
in vec3 vWorld;
out vec4 fragColor;

// arcs crawling round the shell: 4 tumbling great circles, each pushed off its plane by fbm so
// it reads as a jagged discharge; the line width follows the screen derivative (no aliasing)
float shellArcs(vec3 q, float t, float s) {
  float acc = 0.0;
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    vec3 h = hash31(fk * 7.13 + s * 3.1);
    float a1 = t * (0.6 + 1.1 * h.x) + h.y * 6.2832, a2 = t * (0.4 + 0.7 * h.z) + fk * 1.7;
    vec3 N = vec3(cos(a1) * sin(a2), cos(a2), sin(a1) * sin(a2));
    float jit = noise3(q * 0.42 + vec3(fk * 0.31, t * 0.35, s)) - 0.5;
    float d = dot(q, N) + jit * 0.5;
    float w = max(0.022, 1.2 * fwidth(d));
    // each arc strobes on and off on its own clock
    float on = smoothstep(-0.2, 0.6, sin(t * (9.0 + 5.0 * h.y) + fk * 2.3));
    acc += exp(-d * d / (w * w)) * on * (0.022 / w);
  }
  return acc;
}

void main() {
  vec3 C = uBall.xyz;
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 n = normalize(vWorld - C);
  float NoV = clamp(dot(n, V), 0.0, 1.0);
  float t = uBall2.x, s = uBall2.z, inst = uBall2.w;
  // the view ray enters the shell at n and leaves it at nb; chord = 2R NoV, closest approach^2 = 1 - NoV^2
  vec3 nb = n - 2.0 * NoV * V;
  float dc2 = 1.0 - NoV * NoV;
  // the skin turns and churns, faster as it destabilises
  float sp = 1.0 + 1.5 * inst, ca = cos(t * 0.6 * sp), sa = sin(t * 0.6 * sp);
  mat2 rot = mat2(ca, -sa, sa, ca);
  vec3 qf = n, qb = nb;
  qf.xz = rot * qf.xz; qb.xz = rot * qb.xz;
  float vf = shellArcs(qf, t * sp, s), vb = shellArcs(qb, t * sp, s);
  // churning interior: one tap at the chord's midpoint modulates the glow along the chord
  float churn = noise3((qf + qb) * 0.3 + vec3(0.0, -t * 0.25 * sp, s));
  float body = pow(NoV, 1.5) * (0.3 + 1.5 * churn);
  float core = exp(-dc2 / (uLook.y * uLook.y));
  float edge = smoothstep(0.0, 0.12, NoV);
  float sheath = smoothstep(0.0, 0.12, NoV) * (1.0 - smoothstep(0.12, 0.5, NoV));   // a bright skin just inside the limb
  vec3 col = uGlow * (0.4 + 4.5 * body + 2.6 * sheath * (0.6 + 0.8 * churn))
           + uCore * core * (22.0 + 16.0 * inst)
           + mix(uVein, uCore, 0.35) * (vf * 14.0 + vb * 5.0) * uLook.z;
  col = (col * uLook.x + uCore * uLook.w * 30.0) * edge;
  fragColor = vec4(col, 1.0);
}`;

export const HALO_VERT = FX_VERT_HEAD + /* glsl */`
uniform vec4 uBall;   // centre, radius
uniform vec4 uHalo;   // extent (ball radii), intensity, shimmer (m), time
out vec2 vUv;
out float vViewZ;
out vec2 vPerM;       // fx-target uv per metre at this depth
void main() {
  vec3 C = uBall.xyz;
  vec3 f = normalize(cameraPosition - C);
  vec3 r = normalize(cross(abs(f.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), f));
  vec3 u = cross(f, r);
  vec3 w = C + (r * position.x + u * position.y) * (uBall.w * uHalo.x);
  vec4 v = viewMatrix * vec4(w, 1.0);
  vUv = position.xy; vViewZ = -v.z;
  vPerM = 0.5 * vec2(projectionMatrix[0][0], projectionMatrix[1][1]) / max(-v.z, 0.1);
  gl_Position = projectionMatrix * v;
}`;

export const HALO_FRAG = FX_FRAG_HEAD + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + /* glsl */`
uniform vec4 uHalo;
uniform vec3 uGlow;
uniform vec3 uCore;
in vec2 vUv;
in float vViewZ;
in vec2 vPerM;
void main() {
  float r = length(vUv), rr = r * uHalo.x;   // rr in ball radii
  float rim = 1.0 - smoothstep(0.55, 1.0, r);
  float halo = exp(-max(rr - 0.8, 0.0) * 2.0) * rim;
  float inner = exp(-rr * rr * 2.0);
  vec3 e = (uGlow * halo + uCore * inner * 0.25) * (uHalo.y * 2.2);
  // ionised air shimmers just outside the shell
  float ring = smoothstep(0.8, 1.4, rr) * rim;
  vec3 np = vec3(vUv * 2.2, uHalo.w * 0.6);
  vec2 dn = vec2(noise3(np), noise3(np.yxz + 0.37)) - 0.5;
  fxOut(vec3(0.0), 0.0, e * softFade(vViewZ, 0.35), dn * (uHalo.z * ring) * vPerM, vViewZ);
}`;
