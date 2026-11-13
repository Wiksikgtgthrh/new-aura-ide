import * as THREE from 'three';
import { U, COMMON_GLSL, NOISE_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING } from '../../vfx/common.js';

// Shaders for Supernova (the star itself is Solar Flare's impostor, imported from there).
//
// Explosion mass (isolated so it can move onto the shared FluidVolume later): a raymarched
//   pyroclastic fireball (Volumes.js). Reference: high-speed nuclear-test film (Upshot-Knothole,
//   Trinity) and large fuel-air fireballs: a white-hot ball whose surface boils into lobes,
//   optically thick so you see the surface temperature (bright lobes, cooler lanes between them),
//   cooling outside-in white -> yellow -> orange -> dull red, swallowed by soot that the sun
//   lights from above while it climbs. Emission = sigma * L(T) with L ~ blackbody(T) (T/Tref)^4,
//   so nothing is a flat colour and the hot core keeps its structure.
// Shell (fx pass, half res): one camera-facing quad per explosion, ray-traced analytically.
//   - the condensation dome (Wilson cloud, as in the Beirut 2020 footage): a thin lit misty shell
//     riding the shock front for a fraction of a second, patchy, both walls sampled once at the
//     middle of their chord (so it is limb-brightened like a real shell of fog).
//   - the flash glare and a few soft shafts at the instant of the bang.
//   - the pulsar's wind nebula: a wispy blue-white glow around the remnant.
//   The quad sits just in front of the sphere so the depth test never cuts the front wall; with
//   the camera inside it becomes a full-screen quad at the near plane.
// Arcs (AnalyticRibbons, fx pass): mode 1 the condensation ring (a tilted circle of lit mist,
//   clumped around its length, refracting, with a shock-heated glow only in its first instant),
//   mode 0 a pulsar beam: a soft searchlight shaft through the smoke.

// --- explosion mass ---------------------------------------------------------------------------
const FIRE_L = /* glsl */`
vec3 fireL(float T, float Tref) { float k = T / Tref; k *= k; return blackbody(T) * (k * k * smoothstep(700.0, 1000.0, T)); }
`;
export const FIREBALL_GLSL = FIRE_L + /* glsl */`
uniform vec4 uFb;       // radius m, age s, intensity, seed
uniform vec4 uFb2;      // core temperature K, soot, fade, vortex ring 0..1
uniform vec3 uFbPos;
uniform vec3 uFbGlow;   // late glow of the ionised filaments
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  sigma = 0.0; albedo = vec3(0.0); emission = vec3(0.0);
  float R = uFb.x, age = uFb.y, sd = uFb.w, m = uFb2.w;
  vec3 q = pw - uFbPos;
  // as it climbs the ball turns into a vortex ring (the mushroom cap): distance is measured from
  // the ring's core circle in the poloidal plane, and the noise is rolled around that core (up the
  // middle, out over the top, down the outside)
  float rh = length(q.xz), a = 0.55 * R * m, b = R * (1.0 - 0.4 * m);
  vec2 w = vec2(rh - a, q.y * (1.0 + 0.35 * m));
  float r = length(w) / b;
  if (r > 1.45) return;
  float ang = -age * 1.7 * m, ca = cos(ang), sa = sin(ang);
  vec2 wr = vec2(ca * w.x - sa * w.y, sa * w.x + ca * w.y);
  vec3 hd = rh > 1e-4 ? vec3(q.x, 0.0, q.z) / rh : vec3(1.0, 0.0, 0.0);
  vec3 qr = hd * (wr.x + a) + vec3(0.0, wr.y, 0.0);
  // the noise rides the expanding body (q / R); it boils by drifting through a slow curl field
  vec3 np = qr / R * 0.4 + vec3(sd, -0.1 * age, sd * 0.61);
  np += curl3(np * 0.5 + vec3(0.0, 0.05 * age, sd)) * 0.16;
  float n1 = noise3(np);
  float detail = 1.0 - smoothstep(0.25, 0.7, gVolDt / R);
  float n2 = noise3(np * 2.1 + vec3(0.37, 0.11, 0.73));
  float d = (1.0 - r) + 0.8 * (n1 - 0.5) + 0.22 * (n2 - 0.5) * detail;
  d *= smoothstep(-0.2, 0.6, pw.y);                  // squashes onto the floor rather than cutting through it
  if (d <= 0.0) return;
  float body = smoothstep(0.0, 0.25, d);
  // temperature: deep = hot; the surface cools first; lobes stay hotter than the lanes between them
  float heat = clamp(d * 2.5 + 0.6 * (n2 - 0.5) + 0.4 * (n1 - 0.5), 0.0, 1.0);
  float Ts = 1000.0 + 2000.0 * exp(-age / 0.5);
  float Tc = 1500.0 + (uFb2.x - 1500.0) * exp(-age / 0.7);
  float T = mix(Ts, Tc, heat * heat);
  float sf = body * 3.5 / R;
  // soot: where it has cooled, thickening with age
  float cold = 1.0 - smoothstep(1100.0, 1700.0, T);
  float soot = body * cold * smoothstep(0.7, 2.0, age) * uFb2.y;
  float ss = soot * 7.0 / R;
  sigma = (sf * (1.0 - 0.75 * cold) + ss) * uFb2.z;
  emission = sf * uFb2.z * fireL(T, 2500.0) * uFb.z;
  // ionised filaments that glow on, thin and sparse, in the cooling cloud
  float ridge = 1.0 - abs(2.0 * n2 - 1.0);
  ridge *= ridge; ridge *= ridge; ridge *= ridge;
  emission += uFbGlow * (ridge * body * smoothstep(0.6, 1.6, age) * uFb2.z * uFb.z * 0.35 / R);
  albedo = vec3(0.028, 0.025, 0.023) * (ss / max(sigma, 1e-4));
}`;

// a pool of n fireball volumes { v, busy } (Volumes.add only works in create())
export function createFireballs(fx, n) {
  return Array.from({ length: n }, () => {
    const v = fx.volumes.add({
      shape: 'sphere', glsl: FIREBALL_GLSL, maxSteps: 28,
      uniforms: { uFb: { value: new THREE.Vector4(1, 0, 0, 0) }, uFb2: { value: new THREE.Vector4(9000, 1, 1, 0) }, uFbPos: { value: new THREE.Vector3() }, uFbGlow: { value: new THREE.Color(1, 0.3, 0.2) } },
    });
    v.visible = false; v.g = 0.3;
    return { v, busy: false };
  });
}
// pos (centre), radius m, age s, intensity, core temperature K, soot 0..1, fade 0..1, seed,
// filament glow colour, ring (0 a ball .. 1 a rolling vortex ring)
export function placeFireball(f, pos, R, age, I, Tcore, soot, fade, seed, glow, ring) {
  const v = f.v, u = v.uniforms;
  v.visible = R > 1e-3 && fade > 1e-3;
  v.position.copy(pos);
  v.scale.setScalar(R * 1.45);
  u.uFb.value.set(R, age, I, seed);
  u.uFb2.value.set(Tcore, soot, fade, ring);
  u.uFbPos.value.copy(pos);
  u.uFbGlow.value.copy(glow);
}

// --- shell, glare, wind nebula ----------------------------------------------------------------
const NEB_U = /* glsl */`
uniform vec4 uNebA;   // centre xyz, condensation shell radius m (0 = none)
uniform vec4 uNebB;   // age since the bang s, emission intensity, shell thickness (fraction), seed
uniform vec4 uNebC;   // glare, shafts, glow extent m, wind nebula
uniform vec4 uNebD;   // condensation opacity, blast light on the shell, -, -
uniform vec3 uNebHot;
uniform vec3 uNebShock;
uniform vec3 uNebCore;
`;

const NEB_VERT = FX_VERT_HEAD + COMMON_GLSL + NEB_U + /* glsl */`
out vec3 vW;
void main() {
  vW = vec3(0.0);
  float R = max(uNebA.w, uNebC.z);
  vec3 c = uNebA.xyz, toC = c - cameraPosition;
  float D = length(toC);
  if (R <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (D < R * 1.02) {
    // inside: full screen at the near plane, world rays through the corners
    vec4 w = inverse(projectionMatrix * viewMatrix) * vec4(position.xy, 0.5, 1.0);
    vW = w.xyz / w.w;
    gl_Position = vec4(position.xy, -0.999, 1.0);
    return;
  }
  vec3 f = toC / D, r = normalize(cross(f, abs(f.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), u = cross(r, f);
  float Dn = D - R * 0.98;
  vec3 p = cameraPosition + f * Dn + (r * position.x + u * position.y) * (Dn * R / sqrt(D * D - R * R) * 1.02);
  vW = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const NEB_FRAG = FX_FRAG_HEAD + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + NEB_U + /* glsl */`
uniform mat4 projectionMatrix;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec3 vW;
float viewDepth(vec3 p) { return -(viewMatrix * vec4(p, 1.0)).z; }
void main() {
  vec3 c = uNebA.xyz;
  float R = uNebA.w, age = uNebB.x, L = uNebC.z, sd = uNebB.w;
  vec3 rd = normalize(vW - cameraPosition);
  float tc = dot(c - cameraPosition, rd);
  vec3 dv = cameraPosition + rd * tc - c;     // closest approach, from the centre
  float rho = length(dv);
  if (rho > max(R, L)) discard;
  float zs = sceneViewZ();
  float zc = viewDepth(c + dv);
  float visC = clamp((zs - zc) / 0.6, 0.0, 1.0) * step(0.0, tc);
  vec3 em = vec3(0.0), media = vec3(0.0);
  float alpha = 0.0, zm = max(zc, 0.05);

  // the condensation dome: front and back walls of a thin patchy shell of lit fog
  float th = uNebB.z, Ri = R * (1.0 - th);
  if (R > 0.0 && rho < R && uNebD.x > 0.0) {
    float ho = sqrt(R * R - rho * rho), hi = rho < Ri ? sqrt(Ri * Ri - rho * rho) : 0.0;
    float tm = 0.5 * (ho + hi), seg = min((ho - hi) / (R * th), 5.0);
    float keep = 1.0;
    for (int k = 0; k < 2; k++) {
      float s = k == 0 ? -1.0 : 1.0;
      if (tc + s * tm < 0.05) continue;     // that wall is behind the camera
      vec3 pw = c + dv + rd * (s * tm), n = (pw - c) / R;
      float z = viewDepth(pw);
      float vis = clamp((zs - z) / 0.4, 0.0, 1.0);
      if (vis <= 0.0) continue;
      vec3 np = n * 1.1 + vec3(sd, age * 0.25, sd * 0.7);
      float f1 = noise3(np), f2 = noise3(np * 2.7 + 0.31);
      float fog = smoothstep(0.45, 0.85, f1 * 0.7 + f2 * 0.45);
      // denser low down, where the dome meets the ground's moist air
      fog *= 0.55 + 0.45 * smoothstep(0.6, -0.4, n.y);
      float a = clamp(seg * 0.1 * fog * uNebD.x, 0.0, 0.6) * vis;
      vec3 lit = uSunColor * (0.18 + 0.4 * max(dot(n, uSunDir), 0.0)) + uAmbient * 2.2 + uNebShock * uNebD.y;
      media += lit * a * keep;
      alpha = alpha + a * (1.0 - alpha);
      if (k == 0) { keep = 1.0 - a; zm = max(z, 0.05); }
    }
    media /= max(alpha, 1e-4);
  }
  // the flash: glare and a few soft shafts from the centre
  if (uNebC.x > 0.0 || uNebC.y > 0.0) {
    vec3 dir = dv / max(rho, 1e-4);
    float a1 = noise3(dir * 2.2 + sd), a2 = noise3(dir * 5.1 + sd * 1.3);
    float x = rho / L;
    float shafts = (1.5 * a1 * a1 * a1 + 2.0 * pow(a2, 5.0)) * (exp(-x / 0.1) + 0.25 * exp(-x / 0.3)) * smoothstep(1.0, 0.5, x);
    float glare = 2.0 * exp(-x / 0.015) + 0.5 * exp(-x / 0.06) + 0.12 * exp(-x / 0.25);
    em += uNebHot * ((glare * uNebC.x + shafts * uNebC.y) * visC);
  }
  // the pulsar's wind nebula
  if (uNebC.w > 0.0) {
    float q = rho / (0.3 * L);
    float wisp = noise3(dv / L * 2.4 + vec3(sd, -age * 0.15, age * 0.06));
    em += uNebCore * (exp(-q * q) * (0.25 + 1.8 * wisp * wisp) * uNebC.w * visC);
  }
  fxOut(media, alpha, em * uNebB.y, vec2(0.0), zm);
}`;

// n shell impostors, each { mesh, u, busy }
export function createShells(fx, n) {
  const geo = new THREE.PlaneGeometry(2, 2);
  return Array.from({ length: n }, () => {
    const u = {
      uNebA: { value: new THREE.Vector4() }, uNebB: { value: new THREE.Vector4(0, 1, 0.2, 0) },
      uNebC: { value: new THREE.Vector4() }, uNebD: { value: new THREE.Vector4() },
      uNebHot: { value: new THREE.Color(1, 1, 1) }, uNebShock: { value: new THREE.Color(0.5, 0.9, 1) }, uNebCore: { value: new THREE.Color(0.4, 0.6, 1) },
    };
    const mesh = new THREE.Mesh(geo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: NEB_VERT, fragmentShader: NEB_FRAG,
      uniforms: { ...U, ...u }, ...FX_BLENDING, side: THREE.DoubleSide,
    }));
    mesh.frustumCulled = false;
    mesh.visible = false;
    fx.scenes.fx.add(mesh);
    return { mesh, u, busy: false };
  });
}

// ring:  p0 = centre, radius   p1 = in-plane axis e1, width   p2 = in-plane axis e2, wobble   p3 = seed, 1, opacity, hot glow
// beam:  p0 = start, width     p1 = end, width                p2 = -                         p3 = seed, 0, -, -
export const ARC_PATH = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  if (p3.y > 0.5) {
    float a = t * 6.2831853;
    float wob = 1.0 + p2.w * (0.6 * sin(a * 3.0 + p3.x * 6.2831) + 0.4 * sin(a * 7.0 + p3.x * 11.0));
    width = p1.w;
    return p0.xyz + (p1.xyz * cos(a) + p2.xyz * sin(a)) * (p0.w * wob);
  }
  width = mix(p0.w, p1.w, t);
  return mix(p0.xyz, p1.xyz, t);
}`;
export const ARC_SHADE = NOISE_GLSL + /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  media = vec3(0.0); alpha = 0.0; distortion = 0.0;
  float y = r.uv.y;
  if (r.p3.y > 0.5) {
    // condensation ring: patchy lit mist, thicker on its inner side, refracting at its edge
    float a = r.uv.x * 6.2831853;
    vec3 d = vec3(cos(a), sin(a), r.p3.x);
    float n = noise3(d * 1.1 + vec3(0.0, y * 0.12, uTime * 0.05)), n2 = noise3(d * 3.1 + vec3(0.5, y * 0.3, 0.2));
    float clump = smoothstep(0.25, 0.75, 0.75 * n + 0.45 * n2);
    float prof = exp(-y * y * 2.2) * (0.75 + 0.25 * sin(y * 3.0 + n2 * 6.0));
    alpha = clamp(prof * clump * r.p3.z, 0.0, 0.9);
    media = uSunColor * 0.42 + uAmbient * 2.2 + r.color * (0.6 * r.p3.w);
    distortion = y * exp(-3.0 * y * y) * 0.08 * r.p3.z;
    return r.color * (r.p3.w * exp(-y * y * 5.0) * (0.3 + clump));
  }
  // a searchlight through smoke: soft, brightest near the star, grainy with the smoke it lights
  float t = r.uv.x;
  float along = smoothstep(0.0, 0.03, t) * pow(1.0 - t, 1.6);
  float smoke = 0.45 + 0.9 * noise3(vec3(t * 2.4 - uTime * 0.2, y * 0.15, r.p3.x));
  vec3 c = r.color;
  return (mix(c, vec3(max(c.r, max(c.g, c.b))), 0.5) * exp(-y * y * 9.0) * (0.3 + 0.7 * exp(-t * 6.0)) + c * exp(-y * y * 1.8) * 0.35 * smoke) * along;
}`;
