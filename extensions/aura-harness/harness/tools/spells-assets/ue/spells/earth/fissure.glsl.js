import { COMMON_GLSL, NOISE_GLSL } from '../../vfx/common.js';

// The rift: a flat quad on the floor that shows a trench below it (interior mapping). Each pixel
// inside the opening marches its view ray down a V-shaped cut whose two walls are jagged along the
// line (a baked 1D profile: meander + left / right jag) and stepped with depth (ledges); it lands on
// a wall (dark basalt lit from below by the magma, red-hot near the bottom, glowing veins) or on
// the magma itself (crust plates drifting over bright seams). Hot air in the cut scatters the glow,
// so a grazing view, which only sees the top of the far wall, still reads as a seam of fire.
// Pixels outside the opening are discarded after one profile tap. Edges use alpha-to-coverage.
//
// Local frame: u along the line from uA (metres), v across it, z depth below the floor (down).

// magma radiance at T: blackbody chromaticity, brightness ~ (T / 1300 K)^4, no glow below ~650 K
export const MAGMA_L = /* glsl */`
vec3 magmaL(float T) { float k = T / 1300.0; k *= k; return blackbody(T) * (k * k * smoothstep(620.0, 950.0, T)); }
`;

export const CRACK_VERT = /* glsl */`
uniform vec3 uA;
uniform vec2 uT;
uniform vec4 uQuad;   // u0, u1, half width, y
out vec3 vW;
void main() {
  vec2 n = vec2(-uT.y, uT.x);
  float u = mix(uQuad.x, uQuad.y, position.x * 0.5 + 0.5);
  float v = position.y * uQuad.z;
  vW = vec3(uA.x + uT.x * u + n.x * v, uQuad.w, uA.z + uT.y * u + n.y * v);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;

export const CRACK_FRAG = COMMON_GLSL + NOISE_GLSL + MAGMA_L + /* glsl */`
uniform sampler2D uProfile;
uniform vec3 uA;
uniform vec2 uT;
uniform vec4 uCrackA;   // length L, max half width W, depth D, hairline front 0..1
uniform vec4 uCrackB;   // s since the split (< 0 before), unzip time s, close 1 -> 0, heat 0..1
uniform vec4 uCrackC;   // profile offset, meander m, hairline half width m, seed
uniform vec4 uCrackD;   // intensity, magma temperature K, glow haze, -
uniform vec3 uTint;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec3 vW;
out vec4 fragColor;

vec4 prof(float u) { return texture(uProfile, vec2(u * (1.0 / 12.0) + uCrackC.x, 0.5)); }

// opening at x = u / L: unzips from the start, ease-out-back
float openAt(float x) {
  float k = clamp((uCrackB.x - x * uCrackB.y) / 0.24, 0.0, 1.0) - 1.0;
  return uCrackB.x - x * uCrackB.y > 0.0 ? 1.0 + 2.70158 * k * k * k + 1.70158 * k * k : 0.0;
}

// centre line and the two surface half widths at u
void edges(float u, out float c, out float hl, out float hr, out float ledge) {
  vec4 p = prof(u);
  float x = clamp(u / uCrackA.x, 0.0, 1.0);
  float env = pow(max(sin(3.14159265 * x), 0.0), 0.55);
  float front = smoothstep(uCrackA.w + 0.03, uCrackA.w - 0.03, x);
  float w = max(uCrackC.z * front, uCrackA.y * openAt(x)) * env * uCrackB.z;
  c = (p.r - 0.5) * 2.0 * uCrackC.y * env;
  hl = w * (0.5 + p.g);
  hr = w * (0.5 + p.b);
  ledge = p.a;
}

// wall half width at depth z: a V narrowing to the bottom, stepped into ledges
float hwAt(float hw0, float z, float side, float ledge) {
  float s = clamp(z / uCrackA.z, 0.0, 1.0);
  float l = (0.11 * sin(z * 23.0 + ledge * 31.0 + side * 1.7) + 0.06 * sin(z * 57.0 + ledge * 13.0 - side)) * smoothstep(0.0, 0.07, z);
  return hw0 * pow(1.0 - s, 0.8) * (1.0 + l);
}

// > 0 inside the cut
float inside(vec3 q) {
  float c, hl, hr, lg;
  edges(q.x, c, hl, hr, lg);
  float d = q.y - c;
  return min(hwAt(hr, q.z, 1.0, lg) - d, hwAt(hl, q.z, -1.0, lg) + d);
}

// signed distance into the rock of one wall (side +-1)
float wallG(vec3 q, float side) {
  float c, hl, hr, lg;
  edges(q.x, c, hl, hr, lg);
  return side * (q.y - c) - hwAt(side > 0.0 ? hr : hl, q.z, side, lg);
}

void main() {
  vec2 n2 = vec2(-uT.y, uT.x);
  vec2 rel = vW.xz - uA.xz;
  float u0 = dot(rel, uT), v0 = dot(rel, n2);
  float c0, hl0, hr0, lg0;
  edges(u0, c0, hl0, hr0, lg0);
  float d0 = v0 - c0;
  float edge = min(hr0 - d0, hl0 + d0);
  float fw = max(fwidth(v0), 1e-4);
  float cov = clamp(edge / fw + 0.5, 0.0, 1.0);
  if (cov <= 0.0) discard;

  vec3 rd = normalize(vW - cameraPosition);
  vec3 dq = vec3(dot(rd.xz, uT), dot(rd.xz, n2), max(-rd.y, 0.02));   // local ray: along, across, down
  vec3 q0 = vec3(u0, v0, 0.0);
  float D = uCrackA.z, Dm = 0.72 * D;
  float tEnd = Dm / dq.z, tPrev = 0.0, tHit = tEnd;
  bool wall = false;
  for (int i = 1; i <= 14; i++) {
    float t = tEnd * pow(float(i) / 14.0, 1.6);
    if (inside(q0 + dq * t) < 0.0) {
      float a = tPrev, b = t;
      for (int j = 0; j < 5; j++) { float m = 0.5 * (a + b); if (inside(q0 + dq * m) < 0.0) b = m; else a = m; }
      tHit = b; wall = true;
      break;
    }
    tPrev = t;
  }
  vec3 q = q0 + dq * tHit;
  float heat = uCrackB.w, I = uCrackD.x;
  float Tm = mix(560.0, uCrackD.y, heat);
  vec3 T3 = vec3(uT.x, 0.0, uT.y), N3 = vec3(n2.x, 0.0, n2.y);
  vec3 col;
  float s = clamp(q.z / Dm, 0.0, 1.0);
  if (wall) {
    float c, hl, hr, lg;
    edges(q.x, c, hl, hr, lg);
    float side = q.y - c > 0.0 ? 1.0 : -1.0;
    // normal from the wall's gradient (into the cut)
    const float e = 0.03;
    float gu = (wallG(q + vec3(e, 0.0, 0.0), side) - wallG(q - vec3(e, 0.0, 0.0), side)) / (2.0 * e);
    float gz = (wallG(q + vec3(0.0, 0.0, e), side) - wallG(q - vec3(0.0, 0.0, e), side)) / (2.0 * e);
    vec3 gN = -normalize(vec3(gu, side, gz));
    vec3 nW = normalize(T3 * gN.x + N3 * gN.y - vec3(0.0, gN.z, 0.0));
    vec4 nz = noise3v(vec3(q.x * 0.31, q.z * 0.9, side * 0.37 + uCrackC.w));
    vec4 nf = noise3v(vec3(q.x * 1.3, q.z * 2.6, side * 0.61 + uCrackC.w + 0.5));
    float strata = 0.55 + 0.9 * nz.r * (0.75 + 0.5 * sin(q.z * 40.0 + nz.g * 9.0));
    vec3 albedo = vec3(0.05, 0.043, 0.038) * strata;
    // glow from the magma below lights the wall; overhangs (facing down) catch the most
    vec3 Lm = magmaL(Tm) * uTint * I * (0.22 + 0.78 * pow(s, 1.3)) * (0.65 + 0.35 * max(-nW.y, 0.0) + 0.3 * max(dot(nW, -N3 * side), 0.0));
    col = albedo * Lm * 5.0;
    // the rock itself is red-hot near the bottom; veins glow further up
    float vein = smoothstep(0.035, 0.0, abs(nf.r - 0.5)) * smoothstep(0.15, 0.6, nz.g);
    // (in patches: the walls chill to a dull red skin where the melt has drained off them, so the cut
    // never reads as one smooth orange gradient)
    float Tr = mix(450.0, Tm * 0.95, pow(s, 1.4) * (0.62 + 0.55 * nf.g) * (1.0 - 0.3 * smoothstep(0.45, 0.7, nz.b))) + vein * 380.0 * heat * (0.3 + 0.7 * s);
    col += magmaL(Tr) * uTint * I * 0.6;
    // sky and sun on the upper wall
    col += albedo * (uAmbient * (1.0 - s) * 1.4 + uSunColor * max(dot(nW, uSunDir), 0.0) * smoothstep(0.3, 0.0, s));
  } else {
    // magma (Holuhraun / Fagradalsfjall channels and overflows): a dark skin, not open melt. Crust
    // plates (grey-black basalt, sky-lit, a glassy sheen) drift along the cut, torn apart by thin
    // glowing cracks; the skin closes first along the banks and as the heat sags; only mid-channel,
    // where the flow still feeds, does it split open into bright pahoehoe toes, in pulses
    vec3 mq = vec3(q.x * 0.42 - uCrackD.w * 0.025, q.y * 0.9, uCrackD.w * 0.018 + uCrackC.w);
    vec4 n1 = noise3v(mq), n2v = noise3v(mq * 2.3 + 0.41);
    float c, hl, hr, lg;
    edges(q.x, c, hl, hr, lg);
    float dc = q.y - c, bank = smoothstep(0.35, 0.95, abs(dc) / max(hwAt(dc > 0.0 ? hr : hl, q.z, sign(dc), lg), 1e-3));
    float seam = 1.0 - smoothstep(0.02, 0.1 + 0.08 * heat, n1.g * 0.75 + n2v.g * 0.25);
    float feed = (0.55 + 0.45 * sin(uCrackD.w * 0.9 + q.x * 1.3 + n1.b * 4.0)) * heat * (1.0 - bank);
    float open = smoothstep(0.66, 0.8, n2v.r + 0.35 * feed - 0.2 * bank);
    float skin = 1.0 - max(open, seam * (1.0 - 0.5 * bank));
    // the skin's own glow: dull red where thin and fresh, black once it has crusted
    float Tc = Tm * mix(0.66, 0.4, clamp(bank + (1.0 - heat) + 0.6 * (n1.r - 0.4), 0.0, 1.0));
    float T = mix(Tm * (0.88 + 0.12 * open), Tc, skin);
    col = magmaL(T) * uTint * I * (1.0 + 0.25 * sin(uCrackD.w * 3.0 + n1.b * 12.0) * (1.0 - skin));
    vec3 crustA = vec3(0.045, 0.04, 0.037) * (0.7 + 0.6 * n2v.b);
    col += skin * (crustA * (uAmbient * 1.2 + uSunColor * max(uSunDir.y, 0.0)) + 0.05 * uAmbient * (1.0 - n1.r));   // (+ the sheen of fresh glassy crust)
  }
  // hot air in the cut scatters the glow (more the deeper and longer the ray runs inside)
  float path = 1.0 - exp(-tHit * 1.4);
  col += magmaL(Tm) * uTint * I * uCrackD.z * 0.7 * path * (0.5 + 0.5 * s);
  fragColor = vec4(col, cov);
}`;
