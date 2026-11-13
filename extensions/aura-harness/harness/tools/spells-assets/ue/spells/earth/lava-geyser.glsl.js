import { COMMON_GLSL, NOISE_GLSL } from '../../vfx/common.js';
import { MAGMA_L } from '../earth/fissure.glsl.js';

// The vent: a flat disc on the floor that shows the throat below it (interior mapping, the same
// trick as the fissure's rift). Each pixel inside the jagged mouth marches its view ray down a
// funnel (radius jagged by angle, stepped into ledges with depth) and lands on a wall (dark basalt
// lit from below, red-hot near the magma, glowing veins) or on the magma itself: crust plates
// carried outward from the upwelling at the centre over bright seams. The magma level rises
// during the charge and drains as the eruption dies; then the surface crusts over and cools.
// Pixels outside the mouth are discarded after a few sines. Edges use alpha-to-coverage.

export const VENT_VERT = /* glsl */`
uniform vec4 uVent;   // centre x, z, quad half size, y
out vec3 vW;
void main() {
  vW = vec3(uVent.x + position.x * uVent.z, uVent.w, uVent.y - position.y * uVent.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;

export const VENT_FRAG = COMMON_GLSL + NOISE_GLSL + MAGMA_L + /* glsl */`
uniform vec4 uVent;
uniform vec4 uVentA;   // mouth radius, throat depth, magma depth below the floor, jag
uniform vec4 uVentB;   // heat 0..1, magma temperature K, intensity, time
uniform vec4 uVentC;   // upwelling 0..1, seed, crust 0..1, glow haze
uniform vec3 uTint;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec3 vW;
out vec4 fragColor;

float jagA(float a) {
  float s = uVentC.y;
  return 0.5 * sin(3.0 * a + s * 6.1) + 0.3 * sin(7.0 * a + s * 11.3) + 0.2 * sin(13.0 * a + s * 3.7);
}
// funnel radius at angle a, depth z (down): jagged mouth, narrowing throat, ledges
float radAt(float a, float z) {
  float R = uVentA.x * (1.0 + uVentA.w * jagA(a));
  float s = clamp(z / uVentA.y, 0.0, 1.0);
  float l = (0.09 * sin(z * 19.0 + a * 3.0 + uVentC.y * 5.0) + 0.05 * sin(z * 47.0 - a * 5.0)) * smoothstep(0.0, 0.06, z);
  return R * (1.0 - 0.6 * pow(s, 0.8)) * (1.0 + l);
}
float inside(vec3 q) { return radAt(atan(q.z, q.x), q.y) - length(q.xz); }

void main() {
  vec3 q0 = vec3(vW.x - uVent.x, 0.0, vW.z - uVent.y);
  float r0 = length(q0.xz);
  float edge = radAt(atan(q0.z, q0.x), 0.0) - r0;
  float cov = clamp(edge / max(fwidth(r0), 1e-4) + 0.5, 0.0, 1.0);
  if (cov <= 0.0) discard;

  vec3 rd = normalize(vW - cameraPosition);
  vec3 dq = vec3(rd.x, max(-rd.y, 0.02), rd.z);   // local ray, y = depth (down)
  float Dm = uVentA.z;
  float tEnd = Dm / dq.y, tPrev = 0.0, tHit = tEnd;
  bool wall = false;
  for (int i = 1; i <= 12; i++) {
    float t = tEnd * pow(float(i) / 12.0, 1.5);
    if (inside(q0 + dq * t) < 0.0) {
      float a = tPrev, b = t;
      for (int j = 0; j < 5; j++) { float m = 0.5 * (a + b); if (inside(q0 + dq * m) < 0.0) b = m; else a = m; }
      tHit = b; wall = true;
      break;
    }
    tPrev = t;
  }
  vec3 q = q0 + dq * tHit;
  float heat = uVentB.x, I = uVentB.z, time = uVentB.w;
  float Tm = mix(560.0, uVentB.y, heat);
  float s = clamp(q.y / Dm, 0.0, 1.0);
  vec3 col;
  if (wall) {
    float a = atan(q.z, q.x), r = length(q.xz);
    // normal from the funnel's gradient (pointing into the throat)
    const float e = 0.02;
    float ga = (radAt(a + e, q.y) - radAt(a - e, q.y)) / (2.0 * e * max(r, 0.05));
    float gz = (radAt(a, q.y + e) - radAt(a, q.y - e)) / (2.0 * e);
    vec2 rad = q.xz / max(r, 1e-4), tan2 = vec2(-rad.y, rad.x);
    vec3 nW = normalize(vec3(-rad.x + tan2.x * ga, -gz, -rad.y + tan2.y * ga));   // world: into the throat; up where it narrows
    vec4 nz = noise3v(vec3(a * 1.3, q.y * 1.4, uVentC.y));
    vec4 nf = noise3v(vec3(a * 4.1, q.y * 4.0, uVentC.y + 0.5));
    float strata = 0.55 + 0.9 * nz.r * (0.75 + 0.5 * sin(q.y * 45.0 + nz.g * 9.0));
    vec3 albedo = vec3(0.05, 0.043, 0.038) * strata;
    vec3 Lm = magmaL(Tm) * uTint * I * (0.25 + 0.75 * pow(s, 1.3)) * (0.7 + 0.3 * max(-nW.y, 0.0));
    col = albedo * Lm * 5.0;
    float vein = smoothstep(0.035, 0.0, abs(nf.r - 0.5)) * smoothstep(0.15, 0.6, nz.g);
    float Tr = mix(450.0, Tm * 0.95, pow(s, 1.3) * (0.85 + 0.3 * nf.g)) + vein * 380.0 * heat * (0.3 + 0.7 * s);
    col += magmaL(Tr) * uTint * I * 0.6;
    col += albedo * (uAmbient * (1.0 - s) * 1.4 + uSunColor * max(dot(nW, uSunDir), 0.0) * smoothstep(0.3, 0.0, s));
  } else {
    // magma: plates carried outward from the upwelling, bright seams between them, churning
    float r = length(q.xz), a = atan(q.z, q.x);
    vec3 mq = vec3(q.xz * 2.4 - (q.xz / max(r, 1e-3)) * time * 0.22, time * 0.05 + uVentC.y);
    vec4 n1 = noise3v(mq), n2 = noise3v(mq * 2.3 + 0.41);
    float seam = 1.0 - smoothstep(0.08, 0.3, n1.g * 0.75 + n2.g * 0.25);
    float crust = smoothstep(0.45, 0.62, n1.r + 0.2 * (n2.r - 0.5)) * (0.6 + 0.4 * uVentC.z);
    float up = uVentC.x * exp(-r * r / max(uVentA.x * uVentA.x * 0.18, 1e-4));
    float T = Tm * mix(1.0, 0.7, crust * (1.0 - seam) * (1.0 - up)) * (1.0 + 0.12 * seam + 0.1 * up);
    T *= mix(1.0, 0.78, uVentC.z * (1.0 - seam));   // the crust thickens and darkens as it cools
    col = magmaL(T) * uTint * I * (1.1 + 0.4 * sin(time * 3.0 + n1.b * 12.0) * seam);
  }
  // hot gas in the throat scatters the glow
  float path = 1.0 - exp(-tHit * 1.6);
  col += magmaL(Tm) * uTint * I * uVentC.w * 0.7 * path * (0.5 + 0.5 * s);
  fragColor = vec4(col, cov);
}`;
