import { COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL } from '../../vfx/common.js';
import { REFRACT_GLSL } from '../../vfx/Refraction.js';

// Frozen lightning lattice: one crystal (a hexagonal bipyramid) per bolt segment, built on the CPU
// once per cast into world space. The vertex shader grows each crystal when the freeze front
// reaches it (ease-out-back about its centre) and later throws it off the lattice (ballistic,
// tumbling, shrinking, resting on the floor). The fragment shader is the ice family's look kept
// cheap: flat facets, analytic-ish thickness, refraction of the opaque scene, Beer-Lambert tint,
// Fresnel sky, rime, glints, plus the lightning trapped inside (a core line, pulses running along
// the lattice, the freshly frozen front, and stress cracks before the shatter).

export const CRYSTAL_VERT = COMMON_GLSL + /* glsl */`
in vec4 aChunk;    // crystal centre xyz, freeze-front time (s)
in vec4 aAxis;     // crystal axis xyz, radius m
in vec4 aInfo;     // seed 0..1, half length m, kind (0 channel, 1 branch, 2 spur), -
in vec3 aVel;      // shatter velocity m/s
uniform vec4 uFreeze;    // front time now, grow time, shatter age (< 0: whole), shatter delay per front second
uniform vec4 uShatter;   // spin rad/s, gravity, -, -
out vec3 vWorld;
out vec3 vRest;    // undeformed, relative to the crystal centre (noise lives here)
out float vFront;  // seconds since the front passed this crystal
out float vRadius;
out float vSeed;
flat out vec3 vCentre;   // crystal centre and axis after the shatter motion (the trapped filament)
flat out vec3 vAxis;
flat out float vKind;
vec3 rotateAxis(vec3 p, vec3 k, float a) { float c = cos(a), s = sin(a); return p * c + cross(k, p) * s + k * dot(k, p) * (1.0 - c); }
void main() {
  vec3 c = aChunk.xyz, p = position - c;
  vRest = p; vRadius = aAxis.w; vSeed = aInfo.x; vKind = aInfo.z;
  vec3 ax = aAxis.xyz;
  vFront = uFreeze.x - aChunk.w;
  float g = clamp(vFront / uFreeze.y, 0.0, 1.0), u = g - 1.0;
  p *= max(1.0 + 2.70158 * u * u * u + 1.70158 * u * u, 0.0);   // ease-out-back
  float s = uFreeze.z - aChunk.w * uFreeze.w;
  if (uFreeze.z >= 0.0 && s > 0.0) {
    vec3 h = hash31(aInfo.x * 917.0 + 3.1);
    vec3 k = normalize(h - 0.5 + vec3(1e-3));
    float ang = uShatter.x * s * (0.4 + h.x);
    p = rotateAxis(p, k, ang);
    ax = rotateAxis(ax, k, ang);
    p *= 1.0 - smoothstep(0.45, 1.25, s + 0.35 * h.y);
    c += aVel * s;
    c.y -= 0.5 * uShatter.y * s * s;
    c.y = max(c.y, aAxis.w * 0.5);
  }
  vWorld = c + p;
  vCentre = c; vAxis = ax;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;

export const CRYSTAL_FRAG = COMMON_GLSL + NOISE_GLSL + WORLD_GLSL + LIGHTS_GLSL + REFRACT_GLSL + /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec4 uLook;     // ior, frost, glints, lens
uniform vec4 uTrap;     // core glow, pulse position (front s), crack glow, front glow
uniform vec3 uAbsorb;   // Beer-Lambert sigma per metre
uniform vec3 uInscat;
uniform vec3 uGlow;     // trapped light (linear HDR)
uniform vec3 uCoreCol;  // the filament's white-hot core
in vec3 vWorld;
in vec3 vRest;
in float vFront;
in float vRadius;
in float vSeed;
flat in vec3 vCentre;
flat in vec3 vAxis;
flat in float vKind;
out vec4 fragColor;

void main() {
  vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));   // flat facets
  vec3 V = normalize(cameraPosition - vWorld);
  if (dot(N, V) < 0.0) N = -N;
  float NoV = max(dot(N, V), 1e-3);
  // thickness of a thin prism: about a diameter seen face on, less at grazing
  float thick = 2.0 * vRadius * (0.35 + 0.65 * NoV);
  float behind;
  vec3 bg = sceneRefract(vWorld, N, V, uLook.x, thick * uLook.w, behind);
  vec3 Tr = beerLambert(uAbsorb, thick);

  vec3 sd, ss;
  gLightNoShadow = true;
  spellLightPBR(vWorld, N, V, 0.04, vec3(0.02), vec3(1.0), sd, ss);
  float NoL = max(dot(N, uSunDir), 0.0);
  vec3 H = normalize(uSunDir + V);
  float sunSpec = spellD_GGX(max(dot(N, H), 0.0), 0.0016) * spellV_Smith(NoV, NoL, 0.0016) * NoL * PI;
  vec3 irr = uAmbient + uSunColor * NoL + sd;
  vec3 irrOmni = uAmbient + uSunColor * 0.5 + sd;

  // the lightning trapped inside: a filament along each crystal's axis (the crystals join end to
  // end, so the filaments trace the frozen bolt), pulses running along the lattice, the white-hot
  // freshly frozen front, and stress cracks before it shatters. Widths keep a one-pixel floor
  // (energy kept) so the thin core never shimmers.
  vec3 rd = -V, w = vCentre - cameraPosition, cx = cross(rd, vAxis);
  float lc = length(cx);
  float dist = lc > 1e-4 ? abs(dot(w, cx)) / lc : length(cross(w, rd));
  float pix = length(fwidth(vWorld));
  float isFil = step(vKind, 1.5);
  float fw0 = vRadius * (vKind > 0.5 ? 0.24 : 0.32), fw = max(fw0, pix);
  float hw0 = fw0 * 0.3, hw = max(hw0, pix * 0.7);
  float fil = exp(-dist * dist / (fw * fw)) * (fw0 / fw) * isFil;
  float hot = exp(-dist * dist / (hw * hw)) * (hw0 / hw) * isFil;
  float pulse = exp(-pow((vFront - uTrap.y) * 6.0, 2.0));
  float fresh = exp(-max(vFront, 0.0) * 7.0) * uTrap.w;
  float trap = uTrap.x + 4.0 * pulse;

  // rime: fine patches, heavier at grazing angles; it scatters the trapped light, so it glows
  vec4 n = noise3v(vRest * 8.0 + vSeed * 7.0);
  float frost = smoothstep(0.55, 0.85, n.r + 0.25 * pow(1.0 - NoV, 2.0)) * uLook.y;
  frost = clamp(frost + pow(1.0 - NoV, 4.0) * 0.4 * uLook.y, 0.0, 1.0);

  float F = fresnel(NoV, 0.02);
  vec3 refl = envReflect(reflect(-V, N), 0.04);
  vec3 body = bg * Tr + uInscat * irrOmni * 0.5 * (1.0 - dot(Tr, vec3(0.3333)));
  vec3 col = body * (1.0 - F) + (refl * F + ss + uSunColor * F * sunSpec) * (1.0 - frost * 0.7);
  vec3 rime = vec3(0.86, 0.94, 1.0) * irr * 0.8 + uGlow * (0.35 * trap + fresh);
  col = mix(col, rime, frost * 0.7);

  // glints: view-dependent micro-facets, faded when sub-pixel
  vec3 gq = vRest * 60.0;
  vec3 gh = hash33(floor(gq) + floor(V * 5.0) * 17.0 + vSeed * 31.0);
  float tw = pow(0.5 + 0.5 * sin(uTime * 7.0 + gh.y * 60.0), 6.0);
  float spot = smoothstep(0.35, 0.0, length(fract(gq) - 0.5 - (gh - 0.5) * 0.4));
  col += step(0.9, gh.x) * spot * tw * smoothstep(1.2, 0.4, length(fwidth(gq))) * (irr * 6.0 + ss * 0.5) * uLook.z;

  float crack = smoothstep(0.035, 0.0, abs(n.g - 0.5)) * smoothstep(0.3, 0.6, n.r) * uTrap.z;
  float inner = pow(NoV, 3.0) * 0.3;
  col += uGlow * ((fil + inner) * trap + fresh * (1.5 + 4.0 * fil) + crack * 9.0)
       + uCoreCol * hot * (uTrap.x * 2.0 + 6.0 * pulse + 3.0 * fresh);
  fragColor = vec4(col, 1.0);
}`;
