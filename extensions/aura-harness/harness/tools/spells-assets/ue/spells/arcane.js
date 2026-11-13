import * as THREE from 'three';
import { U, COMMON_GLSL, NOISE_GLSL, LINES_BLENDING, arenaStatic } from '../vfx/common.js';
import { REFRACT_GLSL } from '../vfx/Refraction.js';
import { instanced } from '../vfx/Ribbons.js';

// Arcane (PLAN 3). Reference: Doctor Strange spell work (burning mandalas, grinder sparks) and
// UE5 Niagara plasma/energy-shield showcases: energy reads as incandescent plasma that lights the
// world, never as flat glowing UI.
// Arcane Barrage: a runic launch circle opens in front of the caster's orb, then fires 8 missiles
// from its rim 60 ms apart. Each missile is a CPU head steered by true proportional navigation
// (a = N Vc (Omega x r^), plus a weak pursuit term that grows with age so a missile that launched
// away from the target always comes back), a corkscrew weave and a thrust to cruise speed.
// Look: a white-hot plasma knot with crawling filaments and a dispersed halo, motion-streaked
// along its screen velocity (own instanced lines-scene quad); a ribbon trail with heat shimmer;
// streaking sparks. The swarm is one line light (first to last missile), so the floor lights
// along its path. Each impact: a plasma burst sprite (chromatic shock ring, spark rays), a spark
// burst, a distortion shock, a light flash, a ring in the ground field.
// Aegis: a dome of energy membrane (soap-film optics, plasma emission), one sphere mesh in the
// refract pass, shaded per pixel as two walls (the far wall from an analytic ray-sphere exit):
//   - thin-film interference on the sky reflection (Airy, film thickness swirling and draining
//     down), Fresnel, a limb-brightened sheath (the path through a glowing film grows at grazing)
//   - plasma filaments: ridged fbm warped by curl noise, crawling over the shell
//   - refraction with per-channel dispersion where the membrane bends: the rim lens, ripples, the
//     burning fronts, a heat-haze wobble; an interior haze measured along the chord (so what
//     stands inside cuts a darker silhouette in it)
//   - ripples: wave packets travelling over the sphere (amplitude ~ 1/sqrt(sin theta), so the
//     ring refocuses at the antipode), crests bright as caustics with RGB-split fringes, sparks
//     shed along the ring, a caustic cookie light flashing at the hit, an l = 2 membrane wobble
//   - forming: a ragged incandescent front climbs from the floor ring to the crown shedding sparks;
//     dissolving: holes burn through it (crown first) with white-hot edges and a spark/mote burst
//   - a hot contact line where it cuts the floor or a dummy (scene depth)
// It registers a sphere occluder, so particles and debris bounce off it. inst.hit(worldPos,
// strength) ripples the nearest shield (other spells, combos); other casts' impacts near a shield
// and Barrage missiles that strike one ripple it automatically.

const TAU = Math.PI * 2;
const MAX_MISSILES = 12, LAUNCH_GAP = 0.06, MAX_CASTS = 16;
const MAX_SHIELDS = 3, MAX_HITS = 8, MAX_SPRITES = 128, MAX_POPS = 48;
const FORM_TIME = 0.45, DISSOLVE_TIME = 0.8;

// --- shield GLSL (refract scene, ShaderMaterial) --------------------------------------------------
const SHIELD_VERT = /* glsl */`
uniform vec4 uSphere;     // centre, radius (0 = hidden)
uniform vec4 uWobble;     // x: l = 2 membrane mode amplitude (fraction of r)
out vec3 vPos;
out float vViewZ;
void main() {
  vec3 n = normalize(position);
  vPos = uSphere.xyz + n * uSphere.w * (1.0 + uWobble.x * (1.5 * n.y * n.y - 0.5));
  vec4 view = viewMatrix * vec4(vPos, 1.0);
  vViewZ = -view.z;
  gl_Position = uSphere.w > 0.0 ? projectionMatrix * view : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const SHIELD_FRAG = /* glsl */`
uniform vec4 uSphere;
uniform vec4 uForm;       // rise front (0 floor .. 1.25 past the crown), dissolve 0..1, intensity, seed
uniform vec4 uHits[${MAX_HITS}];   // live ripples first: dir * strength, age s
uniform vec3 uHitC[${MAX_HITS}];   // the attacker's colour (linear) per ripple
uniform int uHitN;
uniform vec4 uLook;       // filaments, distortion, ripple speed rad/s, thin film
uniform vec3 uColor;
uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uInside;    // 1: the camera is inside, the wall is the back faces (no far wall)
in vec3 vPos;
in float vViewZ;
out vec4 fragColor;

float gField;   // fbm at the last wall point: film thickness, ragged fronts

// plasma filaments crawling over the membrane: ridged fbm, domain-warped by curl noise. Main veins
// are a white-hot ^16 core in a soft ^4 sheath; fine veins (second octave) crawl faster and
// flicker; a Worley mask leaves calm patches between the burning ones
float filaments(vec3 n) {
  float t = uTime;
  vec3 w = curl3(n * 0.31 + vec3(uForm.w, t * 0.05, 0.0));
  vec3 p = n * 0.83 + w * 0.12 + vec3(t * 0.025, -t * 0.06, uForm.w);
  vec4 A = noise3v(p);
  float b = noise3(p * 2.17 + w * 0.1 + vec3(0.37, 0.37 - t * 0.22, 0.37));
  gField = A.r;
  float ra = 1.0 - abs(A.r * 2.0 - 1.0), rb = 1.0 - abs(b * 2.0 - 1.0);
  float r4 = ra * ra; r4 *= r4;
  float r16 = r4 * r4; r16 *= r16;
  float f4 = rb * rb; f4 *= f4;
  float f16 = f4 * f4; f16 *= f16;
  float mask = smoothstep(0.3, 0.75, A.g);
  return (r16 * 1.5 + r4 * 0.06 + f16 * 0.45) * (0.15 + 0.85 * mask);
}

// hexagonal lattice: xy = offset from the cell centre (edge at |.| ~ 0.5), zw = cell id
vec4 hexCell(vec2 p) {
  const vec2 k = vec2(1.0, 1.7320508);
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / k.xyxy) + 0.5;
  vec4 h = vec4(p - hc.xy * k, p - (hc.zw + 0.5) * k);
  return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hc.xy) : vec4(h.zw, hc.zw + 0.5);
}

// ripple packets: slope along the great circle (tilt, for refraction), crest light per channel
// (focusing; the RGB phase split is the dispersion fringe) and the hot spot where it struck.
// ink: what the hit throws onto the shell, in the attacker's colour. Its energy splashes out over
// the membrane and tears along the plasma (fil) instead of passing through, and the field's hex
// lattice lights cell by cell as the front sweeps past (film shield-impact language)
void ripples(vec3 n, float fil, out vec3 tilt, out vec3 crest, out float spot, out vec3 ink) {
  tilt = vec3(0.0); crest = vec3(0.0); spot = 0.0; ink = vec3(0.0);
  for (int i = 0; i < ${MAX_HITS}; i++) {
    if (i >= uHitN) break;
    vec4 H = uHits[i];
    float s = length(H.xyz);
    vec3 hd = H.xyz / s;
    float c = clamp(dot(n, hd), -1.0, 1.0), ang = acos(c);
    float fr = H.w * uLook.z, x = (ang - fr) / 0.15;
    float A = s * exp(-1.4 * H.w - x * x) * inversesqrt(max(sin(ang), 0.15));
    vec3 ph = x * 4.2 + vec3(-0.22, 0.0, 0.22);
    vec3 cr = max(cos(ph), 0.0); cr *= cr; cr *= cr;
    crest += A * cr;
    vec3 away = n * c - hd;
    float al = sqrt(dot(away, away));
    tilt += away * (A * sin(ph.y) / max(al, 1e-3));
    spot += s * exp(-ang * ang * 45.0 - H.w * 6.0);
    // splash: spreads like a thrown liquid (radius ~ sqrt t), thinning and tearing as it goes
    float sp = 0.12 + 0.95 * sqrt(H.w);
    float splash = s * exp(-2.2 * H.w) * smoothstep(sp, sp * 0.35, ang) * (0.25 + 2.5 * fil + 0.6 * smoothstep(0.3, 0.0, ang));
    // hex cells in the impact's own azimuthal-equidistant frame (true near the hit, where they show)
    vec3 t1 = normalize(cross(hd, abs(hd.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))), t2 = cross(hd, t1);
    vec2 q = vec2(dot(away, t1), dot(away, t2)) * (ang / max(al, 1e-4)) / 0.11;
    vec4 hx = hexCell(q);
    float he = max(dot(abs(hx.xy), vec2(0.5, 0.8660254)), abs(hx.x));     // 0.5 on the cell border
    float ca = length(q - hx.xy) * 0.11, d = fr - ca;                     // the cell centre's angle, front lead
    float lit = smoothstep(-0.04, 0.02, d) * exp(-max(d, 0.0) * 4.5) * smoothstep(1.7, 0.5, ca);
    float hexE = s * exp(-1.2 * H.w) * lit * (smoothstep(0.38, 0.49, he) + 0.1) * (0.4 + hash12(hx.zw + float(i) * 7.3));
    ink += uHitC[i] * (splash * 2.2 + hexE * 2.5 * uLook.x);
  }
}

// emission of the membrane at p (unit normal n); lb = 1 - |cos| (0 face-on, 1 grazing).
// alive: membrane present (the rise front passed, not burnt away); edge: the incandescent fronts
vec3 wall(vec3 p, vec3 n, float lb, out float alive, out float edge, out vec3 tilt) {
  float fil = filaments(n);
  // u: arc length up the dome, 0 on the floor ring, 1 at the crown (fronts move at even surface speed)
  float phi0 = acos(clamp(-uSphere.y / uSphere.w, -1.0, 1.0));
  float u = clamp(1.0 - acos(clamp(n.y, -1.0, 1.0)) / phi0, 0.0, 1.0);
  float f = uForm.x - u - 0.2 * (gField - 0.5);                         // ragged rise front
  float g = gField * 0.9 + (1.0 - u) * 0.45 + 0.05 - uForm.y * 1.45;    // burn-through holes, crown first
  alive = step(0.0, f) * step(0.0, g);
  // fronts: a thin white-hot line in a narrow coloured sheath
  edge = exp(-f * f * 5000.0) + 0.15 * exp(-f * f * 500.0);
  if (uForm.y > 0.0) edge += exp(-g * g * 6000.0) + 0.15 * exp(-g * g * 600.0);
  vec3 crest, ink; float spot;
  ripples(n, fil, tilt, crest, spot, ink);
  float rim = lb * lb * lb, wave = crest.g;
  // a thin glowing film: near-clear face-on, limb-brightened where the eye grazes through it
  vec3 e = uGlow * (0.012 + 0.55 * rim)                                             // sheath
         + mix(uColor, uCore, 0.3) * fil * uLook.x * (0.3 + 1.4 * rim + 2.5 * wave)    // filaments
         + (uCore * 1.5 + uColor) * crest * 1.1                                       // caustic crests
         + ink + (uCore * 4.0 + ink * 0.5) * spot;
  return e * alive + (uCore * 3.0 + uColor * 2.0) * edge;
}

void main() {
  bool inside = uInside > 0.5;
  if (gl_FrontFacing == inside) discard;
  vec3 C = uSphere.xyz;
  float R = uSphere.w;
  vec3 rd = normalize(vPos - cameraPosition);
  vec3 n = normalize(vPos - C);
  float cv = -dot(n, rd), ac = abs(cv), lb = 1.0 - ac;
  float alive, edge; vec3 tilt;
  vec3 emit = wall(vPos, n, lb, alive, edge, tilt);
  float field = gField;
  float sceneZ = linearDepth(texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r);
  // the hot line where the membrane cuts the floor or a dummy
  float dz = max(sceneZ - vViewZ, 0.0);
  emit += (uCore * exp(-dz / 0.035) * 2.5 + uColor * exp(-dz / 0.18)) * alive;
  if (!inside) {
    // the far wall through this one: the ray's exit from the sphere, unless the floor or what
    // stands inside is in front of it; then the glowing haze along the chord in between
    vec3 oc = cameraPosition - C;
    float b = dot(oc, rd);
    float tOut = -b + sqrt(max(b * b - dot(oc, oc) + R * R, 0.0));
    vec3 pB = cameraPosition + rd * tOut;
    float kz = max(dot(rd, -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])), 1e-3);
    float zB = tOut * kz;
    if (zB < sceneZ && pB.y > 0.0) {
      float aB, eB; vec3 tB;
      emit += wall(pB, (pB - C) / R, lb, aB, eB, tB) * 0.45;
    }
    float dzB = abs(sceneZ - zB);
    emit += (uCore * exp(-dzB / 0.035) * 1.8 + uColor * exp(-dzB / 0.18) * 0.7) * alive * step(-0.2, pB.y);
    float chord = clamp(min(tOut, sceneZ / kz) - vViewZ / kz, 0.0, 2.0 * R);
    emit += uGlow * chord * 0.02 * alive;
  }
  // optics. Thin film (n = 1.33): R = 4 F sin^2(pi OPD / lambda), OPD = 2 n d cos(theta_t); the film
  // swirls with the plasma and drains down (thicker low), thinning to black near the crown
  vec3 nf = cv < 0.0 ? -n : n;
  float F = fresnel(ac, 0.02) * alive;
  float y01 = clamp(vPos.y / max(C.y + R, 1e-3), 0.0, 1.0);
  float dnm = mix(120.0, 680.0, field) + 280.0 * (1.0 - y01);
  float ct = sqrt(1.0 - (1.0 - ac * ac) / 1.769);
  vec3 sp = sin(PI * 2.66 * dnm * ct / vec3(650.0, 532.0, 450.0));
  vec3 film = min(4.0 * F * sp * sp, vec3(1.0)) * uLook.w;
  vec3 refl = envReflect(reflect(rd, nf), 0.06) * film;
  // refraction where the membrane bends (rim lens, ripples, burning fronts) plus a heat-haze wobble
  // there, each channel displaced a little differently (dispersion). Elsewhere a thin film passes
  // the scene straight through: blend weight w, so whatever was drawn before shows unharmed
  vec3 bend = (tilt * 0.05 + nf * (0.03 * lb * lb + 0.05 * edge)) * (alive + edge);
  vec3 haze = curl3(vPos * 0.45 + vec3(0.0, -uTime * 0.3, uForm.w)) * 0.006;
  float hh = 0.5 * projectionMatrix[1][1] / max(vViewZ, 1e-3);
  vec2 sc = vec2(hh * uResolution.y / uResolution.x, hh) * uLook.y;
  vec2 off = -(mat3(viewMatrix) * bend).xy * sc;
  float w = smoothstep(0.3, 1.5, length(off * uResolution));
  off -= (mat3(viewMatrix) * haze).xy * sc * w;
  vec2 uv0 = gl_FragCoord.xy / uResolution;
  float z1 = linearDepth(textureLod(uSceneDepth, uv0 + off, 0.0).r);
  off *= smoothstep(vViewZ - 0.2, vViewZ + 0.2, z1);   // never pull in what is in front of the membrane
  vec3 refr = vec3(textureLod(uSceneColor, uv0 + off * 0.8, 0.0).r, textureLod(uSceneColor, uv0 + off, 0.0).g,
                   textureLod(uSceneColor, uv0 + off * 1.2, 0.0).b);
  vec3 col = refr * (1.0 - F) * w + refl + emit * uForm.z;
  if (uDebug > 0.5 && uDebug < 1.5) { fragColor = vec4(0.04, 0.012, 0.004, 0.0); return; }   // overdraw view
  // premultiplied over: col + dst (1 - a), dst passes as (1 - F) when unbent
  fragColor = vec4(col, 1.0 - (1.0 - F) * (1.0 - w));
}`;

// --- missile core / impact pop sprites (full-res additive) --------------------------------------
const SPRITE_VERT = /* glsl */`
in vec4 aA;   // centre, size m (0 = dead)
in vec4 aB;   // rgb * intensity, type: [0, 1) missile (seed), [1, 2] pop (1 + age 0..1)
in vec4 aV;   // world velocity (missiles: motion streak), seed
out vec2 vQ;     // sprite units: head at the origin, +x along the screen velocity
out float vL;    // streak length (sprite units, trailing to -x)
out vec3 vCol;
out vec2 vT;     // type, seed
void main() {
  vQ = vec2(0.0); vCol = vec3(0.0); vT = vec2(0.0); vL = 0.0;
  if (aA.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 view = viewMatrix * vec4(aA.xyz, 1.0);
  float viewZ = max(-view.z, 0.05);
  float pxW = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float s = max(aA.w, 4.0 * pxW), aa = aA.w / s;   // clamp to 4 px, keep the energy
  vec2 vel = (mat3(viewMatrix) * aV.xyz).xy;
  float sp = length(vel);
  vec2 dir = sp > 1e-3 ? vel / sp : vec2(1.0, 0.0);
  float L = aB.w < 1.0 ? min(sp * 0.016 / s, 2.0) : 0.0;   // one 60 Hz frame of motion blur
  if (aB.w >= 1.0) dir = vec2(cos(aV.w), sin(aV.w));
  float x = position.x < 0.0 ? -1.0 - L : 1.0;
  view.xy += (dir * x + vec2(-dir.y, dir.x) * position.y) * s;
  gl_Position = projectionMatrix * view;
  vQ = vec2(x, position.y);
  vL = L;
  // a streak spreads the same energy over a longer quad (motion-blur conservation)
  vCol = aB.rgb * aa * aa * smoothstep(0.15, 0.6, viewZ) / (1.0 + 0.6 * L);
  vT = vec2(aB.w, aV.w);
}`;

const SPRITE_FRAG = /* glsl */`
in vec2 vQ;
in float vL;
in vec3 vCol;
in vec2 vT;
out vec4 fragColor;
float pnoise(float x, float period) {   // smooth periodic value noise
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash11(mod(i, period) + 0.37), hash11(mod(i + 1.0, period) + 0.37), f);
}
void main() {
  float peak = max(vCol.r, max(vCol.g, vCol.b));
  float ang = atan(vQ.y, vQ.x) / 6.2832 + 0.5;
  vec3 col;
  if (vT.x < 1.0) {
    // plasma knot: capsule from the head back along the streak
    float tf = clamp(-vQ.x / max(vL, 1e-3), 0.0, 1.0);
    vec2 p = vec2(vQ.x - clamp(vQ.x, -vL, 0.0), vQ.y);
    float r2 = dot(p, p), r = sqrt(r2);
    if (r >= 1.0) discard;
    float sd = vT.y * 37.0;
    float tail = mix(1.0, 0.3, tf);
    float flick = 0.8 + 0.4 * pnoise(uTime * 31.0 + sd, 4096.0);
    float core = exp(-r2 * 110.0) * tail * flick;
    float sheath = exp(-r2 * 22.0) * tail;
    // filaments crawling round the knot (two periodic octaves over the angle, counter-rotating)
    float fil = pnoise(ang * 9.0 + uTime * 2.3 + sd, 9.0) * 0.6 + pnoise(ang * 17.0 - uTime * 3.9 + sd * 2.0, 17.0) * 0.4;
    fil *= fil; fil *= fil * fil;
    float tend = fil * exp(-r * 6.0) * smoothstep(0.03, 0.14, r) * mix(1.0, 0.4, tf);
    // halo: inverse-square scatter round the knot, red reaching further than blue (dispersion)
    vec3 halo = (0.012 / (r2 * vec3(0.8, 1.0, 1.3) + 0.012) - 0.012) * 0.45 * mix(1.0, 0.4, tf);
    float edge = 1.0 - r2; edge *= edge;
    col = (vec3(peak) * (core * 2.6 + sheath * 0.25) + vCol * (core * 0.6 + sheath * 0.6 + tend * 2.0 + halo)) * edge;
  } else {
    // plasma burst: white flash, a shock ring split per channel, thin spark rays flying out
    float r2 = dot(vQ, vQ), r = sqrt(r2);
    if (r >= 1.0) discard;
    float x = clamp(vT.x - 1.0, 0.0, 1.0), k = 1.0 - x;
    // the luminous shock front: a soft shell of compressed glowing air, not a drawn ring
    vec3 y = (r - (0.06 + 0.8 * sqrt(x)) * vec3(1.035, 1.0, 0.965)) / (0.14 + 0.22 * x);
    vec3 ring = exp(-y * y) * k * k * smoothstep(0.0, 0.5, r);
    float fl = exp(-r2 * 30.0) * k * k * k;
    float slot = floor(ang * 32.0), h = hash11(slot * 1.31 + vT.y);
    float head = 0.12 + (0.5 + 0.5 * h) * 0.9 * x;
    float u = (fract(ang * 32.0) - 0.5) * 6.2832 * r / 32.0;
    float along = clamp(r - head, -0.22, 0.0);
    float ray = step(0.45, h) * exp(-u * u / 0.0001) * exp(along * 12.0) * step(r, head) * k * k;
    float edge = 1.0 - r2; edge *= edge;
    col = (vec3(peak) * (fl * 2.4 + ray * 1.2) + vCol * (ring * 0.45 + fl * 1.5 + ray * 0.7)) * edge;
  }
  if (uDebug > 0.5 && uDebug < 1.5) col = vec3(0.04, 0.012, 0.004);
  fragColor = vec4(col, 1.0);
}`;

// module scratch (no allocations after create)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _om = new THREE.Vector3(), _t = new THREE.Vector3();
const _pa = new THREE.Vector3(), _ba = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function capsuleDist(p, a, b, r) {
  _pa.subVectors(p, a); _ba.subVectors(b, a);
  const h = Math.min(1, Math.max(0, _pa.dot(_ba) / Math.max(_ba.dot(_ba), 1e-6)));
  return _pa.addScaledVector(_ba, -h).length() - r;
}

export default {
  id: 'arcane', name: 'Arcane', key: '0', hue: '#ff4fd8',
  shape: 'projectile', forms: ['Arcane Barrage', 'Aegis'], speed: 24, radius: 0.2,
  params: {
    missiles: 8, speed: 24, homing: 4, spread: 1, weave: 0.6, sparkles: 1, intensity: 1,
    shield: 1.45, duration: 6, hex: 1, distortion: 1, pulse: 0.6, anchor: 'target',
    color: '#ff4fd8', core: '#ffe3fb', glow: '#b347ff',
  },
  ranges: {
    missiles: [1, MAX_MISSILES, 1], speed: [8, 45, 0.1], homing: [2, 8, 0.1], spread: [0, 2, 0.01], weave: [0, 2, 0.01],
    sparkles: [0, 3, 0.01], intensity: [0.1, 3, 0.01], shield: [0.8, 3, 0.01], duration: [1, 20, 0.1], hex: [0, 3, 0.01],
    distortion: [0, 3, 0.01], pulse: [0, 3, 0.01], anchor: ['target', 'caster'],
  },
  presets: {
    'frost ward': { color: '#4fc8ff', core: '#e6faff', glow: '#2f5bff' },
    'golden aegis': { color: '#ffb54a', core: '#fff4dc', glow: '#ff6a1a', hex: 1.4 },
    'void swarm': { color: '#a35cff', core: '#f1e6ff', glow: '#2a0a6e', missiles: 12, weave: 1.3, homing: 5.5 },
  },
  timing: { charge: 0.55, impact: 0.12, linger: 1.1 },
  kinds: {
    spark: { style: 'glow', drag: 1.1, gravity: 5, restitution: 0.35, friction: 0.4, life: [0.2, 0.6], size: [0.028, 0.006], stretch: 0.04, emissive: 7, color: ['#ffe3fb', '#ff4fd8'], alpha: [1, 0] },
    sparkle: { style: 'glow', drag: 2.2, curl: 1.4, curlScale: 0.5, life: [0.25, 0.7], size: [0.024, 0.004], stretch: 0.02, emissive: 6, color: ['#ffe3fb', '#b347ff'], alpha: [1, 0], fadeIn: 0.01, fadeOut: 0.5 },
    mote: { style: 'glow', drag: 0.3, life: [0.4, 0.6], size: [0.012, 0.026], stretch: 0.05, emissive: 5, color: ['#ffe3fb', '#ff4fd8'], alpha: [0.2, 1], fadeIn: 0.3, fadeOut: 0.15, forceResponse: 0.3 },
    // incandescent grit: blackbody, whatever the spell's colour (grinder sparks)
    deflect: { style: 'glow', drag: 0.7, gravity: 9.8, restitution: 0.35, friction: 0.15, life: [0.25, 0.8], size: [0.022, 0.006], stretch: 0.05, emissive: 4, temp: [2600, 1100], alpha: [1, 0], fadeOut: 0.3 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const spark = P.emitter('arcane.spark', { shape: 'sphere', radius: 0.05, spread: 3.5, radial: 3 });
    const sparkle = P.emitter('arcane.sparkle', { shape: 'sphere', radius: 0.05, spread: 1.4 });
    const mote = P.emitter('arcane.mote', { shape: 'shell', radius: 1.2, spread: 0.1, radial: -2.4 });
    const rise = P.emitter('arcane.mote', { shape: 'ring', radius: 1, spread: 0.15 });
    const shellMote = P.emitter('arcane.mote', { shape: 'shell', radius: 1.45, spread: 0.05, radial: 0.25 });
    const shellSpark = P.emitter('arcane.spark', { shape: 'shell', radius: 1.45, spread: 0.8, radial: 2.2 });
    const ringSpark = P.emitter('arcane.spark', { shape: 'ring', radius: 1, spread: 1, radial: 2.5 });
    const waveSpark = P.emitter('arcane.spark', { shape: 'sphere', radius: 0.03, spread: 0.6 });
    const deflect = P.emitter('arcane.deflect', { shape: 'sphere', radius: 0.12, spread: 4.5 });
    const tintC = new THREE.Color();

    // colours: linear, shared by reference with every shield material
    const col = new THREE.Color(), core = new THREE.Color(), glow = new THREE.Color();
    const uColor = new THREE.Vector3(), uCore = new THREE.Vector3(), uGlow = new THREE.Vector3();
    const look = new THREE.Vector4(1, 1, 2.4, 1);
    let cC = '', cK = '', cG = '';
    function syncColors() {
      const p = S.params;
      if (p.color === cC && p.core === cK && p.glow === cG) return;
      cC = p.color; cK = p.core; cG = p.glow;
      col.set(cC); core.set(cK); glow.set(cG);
      uColor.set(col.r, col.g, col.b); uCore.set(core.r, core.g, core.b); uGlow.set(glow.r, glow.g, glow.b);
      P.setKind('arcane.spark', { color: [cK, cC] });
      P.setKind('arcane.sparkle', { color: [cK, cG] });
      P.setKind('arcane.mote', { color: [cK, cC] });
    }

    // reusable option objects for the pooled systems (they copy what they need)
    const SIG = { pos: new THREE.Vector3(), normal: new THREE.Vector3(), radius: 1, color: new THREE.Color(), intensity: 0, reveal: 0, rotation: 0, style: 'arcane', seed: 0 };
    const SHOCK = { pos: new THREE.Vector3(), radius0: 0.05, radius1: 1, duration: 0.3, thickness: 0.25, distortion: 0.02, color: new THREE.Color(), intensity: 0, ground: false };
    const SPLAT = { x: 0, z: 0, radius: 1, glow: 0, corruption: 0, heat: 0, char: 0, pattern: 'ring', seed: 0 };
    const SCORCH = new THREE.Color(1, 0.4, 0.1);

    // --- sprites: missile cores + impact pops, one instanced draw ---
    const sgeo = new THREE.InstancedBufferGeometry();
    sgeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    sgeo.setIndex([0, 1, 2, 0, 2, 3]);
    const aA = instanced(sgeo, 'aA', MAX_SPRITES), aB = instanced(sgeo, 'aB', MAX_SPRITES), aV = instanced(sgeo, 'aV', MAX_SPRITES);
    sgeo.instanceCount = 0;
    const sprites = new THREE.Mesh(sgeo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms: { ...U }, ...LINES_BLENDING,
      vertexShader: COMMON_GLSL + SPRITE_VERT, fragmentShader: COMMON_GLSL + SPRITE_FRAG,
    }));
    sprites.frustumCulled = false;
    sprites.visible = false;
    fx.scenes.lines.add(sprites);
    const pops = Array.from({ length: MAX_POPS }, () => ({ pos: new THREE.Vector3(), age: 1, life: 0, size: 0, r: 0, g: 0, b: 0, seed: 0 }));
    let popHead = 0;
    function addPop(pos, size, c, k, life) {
      const q = pops[popHead]; popHead = (popHead + 1) % MAX_POPS;
      q.pos.copy(pos); q.size = size; q.life = life; q.age = 0; q.seed = fx.rand() * TAU;
      q.r = c.r * k; q.g = c.g * k; q.b = c.b * k;
    }

    // --- missiles: one group per cast record (cast.js keeps 16), all 8+ live in c.data.g ---
    const groups = Array.from({ length: MAX_CASTS }, () => ({
      n: 0, launched: 0, landed: 0,
      ms: Array.from({ length: MAX_MISSILES }, () => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), off: new THREE.Vector3(), alive: false, age: 0, ph: 0, w: 0, trail: null })),
    }));

    // --- shields: one sphere per shield in the refract pass (premultiplied over, no depth write) ---
    const shellGeo = new THREE.IcosahedronGeometry(1, 18);
    const shields = [];
    for (let i = 0; i < MAX_SHIELDS; i++) {
      const su = {
        uSphere: { value: new THREE.Vector4() }, uForm: { value: new THREE.Vector4() }, uWobble: { value: new THREE.Vector4() },
        uHits: { value: Array.from({ length: MAX_HITS }, () => new THREE.Vector4()) }, uHitC: { value: Array.from({ length: MAX_HITS }, () => new THREE.Vector3()) },
        uHitN: { value: 0 }, uInside: { value: 0 },
        uLook: { value: look }, uColor: { value: uColor }, uCore: { value: uCore }, uGlow: { value: uGlow },
      };
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms: { ...U, ...su }, side: THREE.DoubleSide,
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        vertexShader: COMMON_GLSL + SHIELD_VERT,
        fragmentShader: COMMON_GLSL + NOISE_GLSL + REFRACT_GLSL + SHIELD_FRAG,
      });
      const mesh = new THREE.Mesh(shellGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = -1;   // first of the refract-pass translucents: sparks inside stay unbent but visible
      fx.scenes.refract.add(mesh);
      shields.push({
        active: false, formed: false, mesh, u: su, cast: null, center: new THREE.Vector3(), R: 1, r: 0, t: 0, end: 0,
        flash: 0, phase: 0, burst: false, resplat: 0, caster: false, occ: null, light: null, hitLight: null, hitK: 0,
        sigil: null, head: 0, wob: 0, wobV: 0,
        hits: Array.from({ length: MAX_HITS }, () => ({ dir: new THREE.Vector3(), age: 0, s: 0, col: new THREE.Color() })),
      });
    }
    const seen = Array.from({ length: MAX_CASTS }, () => 'done');

    function aim(c, m, out) {
      if (c.target >= 0) { const dp = fx.dummies[c.target].pos; out.set(dp.x, c.to.y, dp.z); } else out.copy(c.to);
      return out.add(m.off);
    }

    // floor, rim and capsules, minus the pedestal under the launch circle and any shield the caster stands in
    function sceneDist(p, from) {
      let d = arenaStatic(p);
      for (const o of fx.occluders.list) {
        if (o.kind === 4) continue;
        if (o.kind === 3 && from.distanceToSquared(o.a) < o.radius * o.radius) continue;
        d = Math.min(d, capsuleDist(p, o.a, o.b, o.radius));
      }
      return d;
    }

    function shieldNear(pos) {
      let best = null, bd = 1e9;
      for (const sh of shields) {
        if (!sh.active || !sh.formed) continue;
        const dist = pos.distanceTo(sh.center);
        if (dist > sh.r + 0.9) continue;
        const k = Math.abs(dist - sh.r);
        if (k < bd) { bd = k; best = sh; }
      }
      return best;
    }

    // tint: the attacker's colour (null: the shield's own)
    function ripple(sh, pos, s, tint = null) {
      _d.subVectors(pos, sh.center);
      const l = _d.length();
      if (l < 1e-4) _d.set(0, 1, 0); else _d.multiplyScalar(1 / l);
      const h = sh.hits[sh.head];
      sh.head = (sh.head + 1) % MAX_HITS;
      h.dir.copy(_d); h.age = 0; h.s = s;
      h.col.copy(tint ?? col);
      sh.flash = Math.min(1.5, sh.flash + 0.4 * s);
      sh.wobV += 0.12 * s;   // the membrane rings
      // caustic light thrown through the struck patch (just inside it): flashes, then fades
      const L = sh.hitLight;
      if (L) {
        L.pos.copy(sh.center).addScaledVector(_d, Math.max(sh.r - 0.25, 0.1)); sh.hitK = Math.min(2, sh.hitK + s);
        L.color.copy(h.col).lerp(core, 0.45);
      }
    }

    // public hook: ripple the shield nearest pos (within 0.9 m outside its shell, or inside it).
    // tint (THREE.Color, optional): the attacker's colour, splashed over the shell
    function hit(pos, strength = 1, tint = null) {
      const sh = shieldNear(pos);
      if (!sh) return false;
      ripple(sh, pos, strength, tint);
      _e1.subVectors(pos, sh.center).normalize();
      _a.copy(sh.center).addScaledVector(_e1, sh.r);
      spark.pos.copy(_a); spark.vel.copy(_e1).multiplyScalar(2.5); spark.burst(30 * strength * S.params.sparkles);
      spark.vel.set(0, 0, 0);
      // white-hot grit skids off along the shell: its occluder deflects it round the curve
      _a.addScaledVector(_e1, 0.07);
      deflect.pos.copy(_a); deflect.vel.copy(_e1).multiplyScalar(1.2); deflect.burst(70 * strength * S.params.sparkles);
      deflect.vel.set(0, 0, 0);
      addPop(_a, 0.55 + 0.25 * Math.min(strength, 2), tint ?? col, 6 * S.params.intensity, 0.25);
      return true;
    }
    // '#rrggbb' -> linear colour, without allocating
    const hx = (str, i) => { const c = str.charCodeAt(i); return c <= 57 ? c - 48 : (c | 32) - 87; };
    function hueOf(spell, out) {
      const h = spell.hue;
      if (typeof h !== 'string' || h.length !== 7) return out.copy(col);
      return out.setRGB((hx(h, 1) * 16 + hx(h, 2)) / 255, (hx(h, 3) * 16 + hx(h, 4)) / 255, (hx(h, 5) * 16 + hx(h, 6)) / 255, THREE.SRGBColorSpace);
    }

    // --- barrage ---
    function launchCentre(c, out) { return out.copy(c.from).addScaledVector(c.dir, 0.45); }

    function launch(c, g, i, p) {
      const m = g.ms[i];
      _e1.crossVectors(c.dir, UP);
      if (_e1.lengthSq() < 1e-6) _e1.set(1, 0, 0);
      _e1.normalize();
      _e2.crossVectors(_e1, c.dir);
      const a = (i / g.n) * TAU + (c.seed % 628) * 0.01 + (fx.rand() - 0.5) * 0.5;
      _c.copy(_e1).multiplyScalar(Math.cos(a)).addScaledVector(_e2, Math.sin(a));   // out of the rim
      launchCentre(c, m.pos).addScaledVector(_c, 0.55);
      m.vel.copy(_c).multiplyScalar((4 + 3 * fx.rand()) * p.spread).addScaledVector(c.dir, 4)
        .addScaledVector(UP, (0.5 + 1.5 * fx.rand()) * p.spread)
        .add(_t.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).multiplyScalar(1.5));
      // where on the target this one lands
      m.off.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).multiplyScalar(c.target >= 0 ? 0.45 : 0.9);
      if (c.target < 0) m.off.y = 0;
      m.age = 0; m.alive = true;
      m.ph = fx.rand() * TAU;
      m.w = (7 + 5 * fx.rand()) * (fx.rand() < 0.5 ? -1 : 1);
      m.trail = fx.trails.acquire();
      const tr = m.trail;
      if (tr) {
        tr.width = 0.016; tr.intensity = 2.6 * p.intensity; tr.glow = 9; tr.glowIntensity = 0.12; tr.fadeTime = 0.13; tr.spacing = 0.08;
        tr.distortion = 0.04 * p.distortion; tr.color.copy(col).lerp(core, 0.35);   // heat shimmer in the wake
      }
      addPop(m.pos, 0.45, col, 6 * p.intensity, 0.2);
      spark.pos.copy(m.pos); spark.vel.copy(m.vel).multiplyScalar(0.3); spark.burst(14 * p.sparkles);
      spark.vel.set(0, 0, 0);
      c.data.flash = Math.max(c.data.flash, 0.5);
    }

    function steer(c, m, p, dt) {
      const tgt = aim(c, m, _b);
      const r = _a.subVectors(tgt, m.pos), dist = r.length();
      const speed = m.vel.length();
      if (dist < 0.22 + speed * dt * 0.6) return true;
      const rh = r.multiplyScalar(1 / dist);
      // PN: Omega = (v x r^) / |r| (LOS rate, static target), a = N V (Omega x r^): the heading
      // turns N times as fast as the line of sight (closing speed floored at the missile's own)
      _om.crossVectors(m.vel, rh).multiplyScalar(1 / dist);
      _d.crossVectors(_om, rh).multiplyScalar(p.homing * Math.max(speed, 4));
      // pursuit: weak at first (PN does the curving), grows so nothing orbits forever
      _d.addScaledVector(_t.copy(rh).multiplyScalar(p.speed).sub(m.vel), 1.5 + 4 * Math.max(0, m.age - 0.5));
      // corkscrew weave, fading out on the final approach
      const vh = _t.copy(m.vel).multiplyScalar(1 / Math.max(speed, 1e-3));
      _e1.crossVectors(vh, UP);
      if (_e1.lengthSq() < 1e-6) _e1.set(1, 0, 0);
      _e1.normalize();
      _e2.crossVectors(_e1, vh);
      const ph = m.ph + m.age * m.w, wa = p.weave * 28 * Math.min(1, dist / 4);
      _d.addScaledVector(_e1, Math.cos(ph) * wa).addScaledVector(_e2, Math.sin(ph) * wa);
      // lateral g limit, then thrust towards cruise speed
      const along = _d.dot(vh);
      _d.addScaledVector(vh, -along);
      const lat = _d.length(), amax = 220;
      if (lat > amax) _d.multiplyScalar(amax / lat);
      // thrust once it points at the target, brake while it points away (tighter turn)
      const aimK = vh.dot(rh);
      _d.addScaledVector(vh, aimK > 0 ? (p.speed - speed) * 5 * aimK : -speed * 1.5 * -aimK);
      m.vel.addScaledVector(_d, dt);
      m.pos.addScaledVector(m.vel, dt);
      m.age += dt;
      return m.age > 0.05 && sceneDist(m.pos, c.from) < 0.06;
    }

    function land(c, g, m, p) {
      m.alive = false;
      g.landed++;
      m.trail?.release(); m.trail = null;
      const sh = shieldNear(m.pos);
      if (sh) ripple(sh, m.pos, 0.9);
      _e1.copy(m.vel).normalize();
      spark.pos.copy(m.pos); spark.vel.copy(_e1).multiplyScalar(-2.2); spark.burst(30 * p.sparkles);
      spark.vel.set(0, 0, 0);
      // white-hot spatter off the struck surface, falling and skipping over the floor
      deflect.pos.copy(m.pos); deflect.vel.copy(_e1).multiplyScalar(-2.6); deflect.burst(34 * p.sparkles);
      deflect.vel.set(0, 0, 0);
      addPop(m.pos, 0.7, col, 2.2 * p.intensity, 0.28);
      if (!sh) fx.impacts.add('scorch', m.pos, 0.32, 0.35, 7, SCORCH);
      SHOCK.pos.copy(m.pos); SHOCK.radius0 = 0.05; SHOCK.radius1 = 1.1; SHOCK.duration = 0.28; SHOCK.thickness = 0.22;
      SHOCK.distortion = 0.03 * p.distortion; SHOCK.color.copy(col); SHOCK.intensity = 1.5 * p.intensity; SHOCK.ground = false;
      fx.shocks?.spawn(SHOCK);
      if (m.pos.y < 2.2) {
        SPLAT.x = m.pos.x; SPLAT.z = m.pos.z; SPLAT.radius = 0.55; SPLAT.glow = 0.12; SPLAT.corruption = 0.12; SPLAT.heat = 0.35; SPLAT.char = 0.3;
        SPLAT.pattern = 'noise'; SPLAT.seed = (c.seed + g.landed * 17) % 100;
        fx.ground.splat(SPLAT);
        SPLAT.heat = SPLAT.char = 0;
      }
      if (g.landed === 1 || g.landed === g.n) fx.impacts.add('holy', m.pos, 0.8, 0.6, 1.5, col);
      if (!sh && c.target >= 0) fx.dummies[c.target].hit(_e1, 0.18);
      fx.rig.shake(0.05, 22);
      c.pos.copy(m.pos);
      // the swarm light snaps to the impact and flashes, then slides back along the swarm
      const L = c.data.light;
      if (L) { L.pos.copy(m.pos); L.end.copy(m.pos); c.data.flash = 1; }
    }

    // --- aegis ---
    function aegisCharge(c, p, d) {
      c.durations.charge = 0.4; c.durations.impact = 0.35; c.durations.linger = p.duration + 2;
      let sh = null;
      for (const s of shields) if (!s.active) { sh = s; break; }
      d.sh = sh;
      if (!sh) { c.durations.linger = 0; return; }   // all shields up: this cast fizzles
      const caster = p.anchor === 'caster';
      const R = caster ? Math.max(p.shield, 1.4) : p.shield;
      if (caster) _a.set(c.from.x, 0, c.from.z);
      else if (c.target >= 0) _a.copy(fx.dummies[c.target].pos).setY(0);
      else _a.set(c.to.x, 0, c.to.z);
      sh.center.copy(_a).setY(0.55 * R);
      // renew: a live shield in the same spot dissolves while this one forms
      for (const s of shields) if (s !== sh && s.active && s.formed && s.center.distanceToSquared(sh.center) < 0.25) s.end = Math.min(s.end, s.t + 0.6);
      sh.active = true; sh.formed = false; sh.cast = c; sh.R = R; sh.r = R; sh.t = 0; sh.end = FORM_TIME + p.duration;
      sh.flash = 0; sh.burst = false; sh.resplat = 0; sh.head = 0; sh.caster = caster; sh.hitK = 0; sh.wob = 0; sh.wobV = 0;
      sh.phase = fx.rand();
      for (const h of sh.hits) h.s = 0;
      c.pos.copy(sh.center);
      SIG.pos.set(sh.center.x, 0.02, sh.center.z); SIG.normal.set(0, 1, 0); SIG.radius = 0.835 * R * 1.15;
      SIG.color.copy(col); SIG.intensity = 0; SIG.reveal = 0; SIG.rotation = 0; SIG.seed = c.seed % 1000;
      sh.sigil = fx.sigils.acquire(SIG);
      sh.light = fx.lights.acquire();
      if (sh.light) { sh.light.range = 3.2 * R; sh.light.intensity = 0; sh.light.color.copy(col); sh.light.pos.copy(sh.center).addScaledVector(UP, 0.35 * R); }
    }

    function aegisForm(c, p, sh) {
      c.pos.copy(sh.center);
      sh.formed = true;
      sh.t = 0;
      sh.flash = 1.2;
      sh.wob = -0.05; sh.wobV = 0.4;   // it snaps up taut and rings
      // a shield on the caster would stop the caster's own spells: it collides only on others
      sh.occ = sh.caster ? null : fx.occluders.add(sh.center, sh.center, sh.r, 3);
      sh.hitLight = fx.lights.acquire();
      const H = sh.hitLight;
      if (H) { H.type = 2; H.cookie[0] = 1; H.cookie[1] = 2.4; H.range = 2.6 * sh.R; H.shadow = true; H.intensity = 0; H.color.copy(col).lerp(core, 0.5); H.pos.copy(sh.center); }
      const rf = 0.835 * sh.R;   // floor ring radius (centre at 0.55 R)
      SHOCK.pos.set(sh.center.x, 0.05, sh.center.z); SHOCK.radius0 = rf * 0.5; SHOCK.radius1 = rf * 3; SHOCK.duration = 0.45;
      SHOCK.thickness = 0.5; SHOCK.distortion = 0.04 * p.distortion; SHOCK.color.copy(col); SHOCK.intensity = 2 * p.intensity; SHOCK.ground = true;
      fx.shocks?.spawn(SHOCK);
      ringSpark.pos.set(sh.center.x, 0.08, sh.center.z); ringSpark.radius = rf; ringSpark.vel.set(0, 2.5, 0);
      ringSpark.burst(160 * p.sparkles);
      SPLAT.x = sh.center.x; SPLAT.z = sh.center.z; SPLAT.radius = rf; SPLAT.glow = 0.7; SPLAT.corruption = 0.3;
      SPLAT.pattern = 'ring'; SPLAT.seed = c.seed % 100;
      fx.ground.splat(SPLAT);
      fx.rig.shake(0.15, 14);
      fx.flash(0.08 * p.intensity);
    }

    function release(c) {
      const d = c.data, g = d.g;
      if (g) {
        for (const m of g.ms) { m.alive = false; m.trail?.release(); m.trail = null; }
        g.n = g.launched = g.landed = 0;
      }
      const sh = d.sh;
      if (sh && sh.cast === c) {
        sh.occ?.release(); sh.light?.release(); sh.hitLight?.release(); sh.sigil?.release();
        sh.occ = sh.light = sh.hitLight = sh.sigil = null;
        sh.active = sh.formed = false; sh.cast = null;
      }
      d.light?.release(); d.sig?.release();
      d.g = d.sh = d.light = d.sig = null;
    }

    syncColors();

    return {
      hit,
      // a formed shield whose dome covers (x, z): writes its centre to out, returns its radius (0: none)
      shieldOver(x, z, out) {
        for (const sh of shields) {
          if (!sh.active || !sh.formed || (x - sh.center.x) ** 2 + (z - sh.center.z) ** 2 > sh.r * sh.r) continue;
          out.copy(sh.center);
          return sh.r;
        }
        return 0;
      },
      onParam(k) { if (k === 'color' || k === 'core' || k === 'glow') syncColors(); },

      phase(c, name) {
        const p = S.params, d = c.data;
        syncColors();
        if (name === 'charge') {
          d.g = d.sh = d.light = d.sig = null;
          d.flash = 0;
          d.shielded = false;
          if (c.form === 'Aegis') { aegisCharge(c, p, d); return; }
          const g = d.g = groups[c.index];
          g.n = Math.round(p.missiles); g.launched = 0; g.landed = 0;
          for (const m of g.ms) { m.alive = false; m.trail = null; }
          d.light = fx.lights.acquire();
          if (d.light) { d.light.type = 1; d.light.range = 9; d.light.intensity = 0; d.light.color.copy(col); launchCentre(c, d.light.pos); d.light.end.copy(d.light.pos); }
          // the launch circle in front of the orb, facing the target (missiles leave from its rim)
          launchCentre(c, SIG.pos); SIG.normal.copy(c.dir); SIG.radius = 0.8; SIG.color.copy(col);
          SIG.intensity = 0; SIG.reveal = 0; SIG.rotation = 0; SIG.seed = c.seed % 1000;
          d.sig = fx.sigils.acquire(SIG);
        } else if (name === 'release') {
          if (c.form !== 'Aegis') fx.rig.shake(0.08, 12);
        } else if (name === 'impact') {
          if (c.form === 'Aegis' && d.sh) aegisForm(c, p, d.sh);
        } else if (name === 'done') release(c);
      },

      // projectile travel: Barrage flies its missiles here, Aegis has no flight
      travel(c, dt) {
        if (c.form === 'Aegis') return true;
        const p = S.params, g = c.data.g;
        if (!g) return true;
        while (g.launched < g.n && c.t >= g.launched * LAUNCH_GAP) launch(c, g, g.launched++, p);
        for (let i = 0; i < g.launched; i++) {
          const m = g.ms[i];
          if (m.alive && (steer(c, m, p, dt) || c.t > 6)) land(c, g, m, p);
        }
        return g.landed >= g.n;
      },

      update(c, dt) {
        const p = S.params, d = c.data;
        if (c.form === 'Aegis') { updateAegis(c, p, d, dt); return; }
        const L = d.light, k = c.phase === 'charge' ? c.t / c.durations.charge : 1;
        const fade = c.phase === 'linger' ? Math.max(0, 1 - c.t / c.durations.linger) : 1;
        d.flash = Math.max(0, d.flash - dt * 6);
        if (d.sig) {
          // closes 0.35 s after the last launch (intensity 0 drops it from the sigil draw)
          const close = c.phase === 'charge' ? 1 : c.phase === 'travel' ? Math.min(1, Math.max(0, 1 - (c.t - d.g.n * LAUNCH_GAP) / 0.35)) : 0;
          launchCentre(c, d.sig.pos);
          d.sig.reveal = Math.min(1, k * 1.25);
          d.sig.intensity = (2.6 + 2 * k + 4 * d.flash) * p.intensity * close;
          d.sig.rotation = c.age * 0.9;
        }
        if (c.phase === 'charge') {
          launchCentre(c, mote.pos); mote.rate(500 * k * p.sparkles, dt);
          if (L) { launchCentre(c, L.pos); L.end.copy(L.pos); L.intensity = 6 * k * p.intensity; }
          return;
        }
        const g = d.g;
        let n = 0, first = null, last = null;
        if (g && c.phase === 'travel') for (let i = 0; i < g.launched; i++) {
          const m = g.ms[i];
          if (!m.alive) continue;
          m.trail?.push(m.pos);
          // sparks shed sideways off the knot: velocity streaks
          sparkle.pos.copy(m.pos); sparkle.vel.copy(m.vel).multiplyScalar(-0.15); sparkle.rate(90 * p.sparkles, dt);
          if (!first) first = m;
          last = m;
          n++;
        }
        if (L) {
          // the swarm is a line light from the first live missile to the last (lights the floor along it)
          if (n > 0 && d.flash < 0.3) {
            const kk = Math.min(1, dt * 12);
            L.pos.lerp(first.pos, kk); L.end.lerp(last.pos, kk);
          }
          L.intensity = (n > 0 ? 8 + 2.4 * n : 2 * fade) * p.intensity + 20 * d.flash * p.intensity;
        }
      },

      tick(dt) {
        syncColors();
        const p = S.params;
        look.set(p.hex, p.distortion, 2.4, 2);   // w: thin-film strength (a soap film shows its swirls face-on against a bright sky)
        // other spells landing on a shield ripple it
        const list = fx.casts?.list;
        if (list) for (const c of list) {
          const was = seen[c.index];
          seen[c.index] = c.alive ? c.phase : 'done';
          if (!c.alive || c.phase !== 'impact' || was === 'impact' || c.spell === S || c.data.shielded) continue;
          const sh = shieldNear(c.pos);
          if (!sh) continue;
          _a.subVectors(c.pos, sh.center);
          if (_a.length() < sh.r * 0.8) {   // landed inside (a strike): show it where it came through
            if (c.spell.shape === 'strike') _a.copy(UP); else _a.subVectors(c.from, sh.center);
            _a.normalize().multiplyScalar(sh.r).add(sh.center);
          } else _a.copy(c.pos);
          hit(_a, 1.6, hueOf(c.spell, tintC));
        }
        // shields -> uniforms
        const cam = fx.camera.position;
        for (const sh of shields) {
          const on = sh.active && sh.formed;
          sh.mesh.visible = on;
          if (!on) continue;
          const u = sh.u;
          const rise = 1.25 * (1 - (1 - Math.min(1, sh.t / FORM_TIME)) ** 2);
          const dis = Math.min(1, Math.max(0, 1 - (sh.end - sh.t) / DISSOLVE_TIME));
          // slow uneven breathing of the plasma, a surge as it lets go
          const breathe = 0.93 + 0.07 * Math.sin(sh.t * 5.1 + sh.phase * 9) * Math.sin(sh.t * 2.3);
          u.uSphere.value.set(sh.center.x, sh.center.y, sh.center.z, sh.r);
          u.uForm.value.set(rise, dis, p.intensity * (1 + 0.35 * sh.flash) * breathe * (1 + 0.5 * dis), sh.phase * 7.3);
          u.uWobble.value.x = sh.wob;
          u.uInside.value = cam.distanceToSquared(sh.center) < sh.r * sh.r ? 1 : 0;
          let nh = 0;   // live ripples packed first: the shader loops over uHitN only
          for (const h of sh.hits) {
            if (h.s > 0) { h.age += dt; if (h.age > 3) h.s = 0; }
            if (h.s <= 0) continue;
            u.uHitC.value[nh].set(h.col.r, h.col.g, h.col.b);
            u.uHits.value[nh++].set(h.dir.x * h.s, h.dir.y * h.s, h.dir.z * h.s, h.age);
          }
          u.uHitN.value = nh;
        }
        // sprites: missile cores, then pops
        const A = aA.array, B = aB.array, V = aV.array;
        let n = 0;
        const I = 5 * p.intensity;
        for (const g of groups) {
          if (g.n === 0) continue;
          for (let i = 0; i < g.launched && n < MAX_SPRITES; i++) {
            const m = g.ms[i];
            if (!m.alive) continue;
            const o = n * 4;
            A[o] = m.pos.x; A[o + 1] = m.pos.y; A[o + 2] = m.pos.z; A[o + 3] = 0.42 * (1 + 0.15 * Math.sin(m.age * 40 + m.ph));
            B[o] = col.r * I; B[o + 1] = col.g * I; B[o + 2] = col.b * I; B[o + 3] = m.ph / TAU * 0.999;
            V[o] = m.vel.x; V[o + 1] = m.vel.y; V[o + 2] = m.vel.z; V[o + 3] = m.ph;
            n++;
          }
        }
        for (const q of pops) {
          if (q.age >= q.life) continue;
          q.age += dt;
          if (q.age >= q.life || n >= MAX_SPRITES) continue;
          const o = n * 4;
          A[o] = q.pos.x; A[o + 1] = q.pos.y; A[o + 2] = q.pos.z; A[o + 3] = q.size;
          B[o] = q.r; B[o + 1] = q.g; B[o + 2] = q.b; B[o + 3] = 1 + q.age / q.life;
          V[o] = 0; V[o + 1] = 0; V[o + 2] = 0; V[o + 3] = q.seed;
          n++;
        }
        sgeo.instanceCount = n;
        sprites.visible = n > 0;
        if (n > 0) aA.needsUpdate = aB.needsUpdate = aV.needsUpdate = true;
      },
    };

    function updateAegis(c, p, d, dt) {
      const sh = d.sh;
      if (!sh || sh.cast !== c) return;
      const rf = 0.835 * sh.R;
      if (c.phase === 'charge') {
        const k = c.t / c.durations.charge;
        if (sh.sigil) { sh.sigil.reveal = k; sh.sigil.intensity = 4 * p.intensity; sh.sigil.rotation = c.age * 0.6; }
        rise.pos.set(sh.center.x, 0.05, sh.center.z); rise.radius = rf; rise.vel.set(0, 1.6 + 2 * k, 0);
        rise.rate(500 * k * p.sparkles, dt);
        if (sh.light) sh.light.intensity = 6 * k * p.intensity;
        return;
      }
      sh.t += dt;
      sh.flash = Math.max(0, sh.flash - dt * 2.5);
      const t = sh.t;
      // membrane l = 2 mode: a damped spring (2.4 Hz), kicked by forming and by every hit
      const om = TAU * 2.4;
      sh.wobV += (-om * om * sh.wob - 2 * 0.16 * om * sh.wobV) * dt;
      sh.wob = Math.max(-0.08, Math.min(0.08, sh.wob + sh.wobV * dt));
      const dis = Math.min(1, Math.max(0, 1 - (sh.end - t) / DISSOLVE_TIME));
      if (dis > 0 && !sh.burst) {
        sh.burst = true;
        shellMote.pos.copy(sh.center); shellMote.radius = sh.r; shellMote.radial = 1.2; shellMote.burst(400 * p.sparkles);
        shellMote.radial = 0.25;
      }
      if (t >= sh.end) { c.durations.linger = 0; sh.formed = false; return; }
      // forming: the rising front sheds sparks round its ring (front at arc fraction u of the dome)
      const riseK = Math.min(1, t / FORM_TIME), uF = Math.min(1, 1.25 * (1 - (1 - riseK) ** 2));
      if (uF < 1) {
        const pol = (1 - uF) * Math.acos(-sh.center.y / sh.r), yF = sh.center.y + sh.r * Math.cos(pol);
        ringSpark.pos.set(sh.center.x, yF, sh.center.z); ringSpark.radius = sh.r * Math.sin(pol);
        ringSpark.vel.set(0, 1.2, 0); ringSpark.rate(420 * p.sparkles, dt);
      }
      // dissolving: sparks spit from the burning holes
      if (dis > 0) { shellSpark.pos.copy(sh.center); shellSpark.radius = sh.r; shellSpark.rate(500 * p.sparkles * (1 - dis), dt); }
      // the newest ripple sheds sparks along its travelling ring (one small burst a frame)
      let hb = null;
      for (const h of sh.hits) if (h.s > 0 && h.age < 0.9 && (!hb || h.age < hb.age)) hb = h;
      if (hb && dis === 0) {
        const th = hb.age * look.z;
        if (th < 2.8) {
          _e1.crossVectors(hb.dir, Math.abs(hb.dir.y) < 0.9 ? UP : _t.set(1, 0, 0)).normalize();
          _e2.crossVectors(hb.dir, _e1);
          const az = fx.rand() * TAU, ca = Math.cos(az), sa = Math.sin(az);
          _c.copy(_e1).multiplyScalar(ca).addScaledVector(_e2, sa);           // azimuth direction
          _d.copy(hb.dir).multiplyScalar(Math.cos(th)).addScaledVector(_c, Math.sin(th));   // ring point (unit)
          _a.copy(sh.center).addScaledVector(_d, sh.r);
          if (_a.y > 0.05) {
            _b.copy(hb.dir).multiplyScalar(-Math.sin(th)).addScaledVector(_c, Math.cos(th));   // along the propagation
            waveSpark.pos.copy(_a); waveSpark.vel.copy(_b).multiplyScalar(3.5).addScaledVector(_d, 1.5);
            waveSpark.burst(4 * hb.s * p.sparkles * Math.exp(-2 * hb.age));
          }
        }
      }
      // alive: idle ripples, motes on the shell, the floor ring kept glowing
      if (dis === 0 && fx.rand() < p.pulse * dt) {
        _a.set(fx.rand() - 0.5, 0.1 + 0.8 * fx.rand(), fx.rand() - 0.5).normalize().multiplyScalar(sh.r).add(sh.center);
        ripple(sh, _a, 0.45);
      }
      shellMote.pos.copy(sh.center); shellMote.radius = sh.r * 1.01; shellMote.rate(40 * p.sparkles * (1 - dis), dt);
      sh.resplat -= dt;
      if (sh.resplat <= 0 && dis === 0) {
        sh.resplat = 1.5;
        SPLAT.x = sh.center.x; SPLAT.z = sh.center.z; SPLAT.radius = rf; SPLAT.glow = 0.25; SPLAT.corruption = 0;
        SPLAT.pattern = 'ring'; SPLAT.seed = (c.seed + Math.floor(t)) % 100;
        fx.ground.splat(SPLAT);
      }
      // the floor circle hands over to the shell's own floor-contact line
      if (sh.sigil) { sh.sigil.intensity = 4 * p.intensity * Math.max(0, 1 - t / 0.8); sh.sigil.rotation = c.age * 0.6; }
      if (sh.light) sh.light.intensity = ((9 + 22 * sh.flash) * riseK * (1 - dis) + 20 * dis * (1 - dis)) * p.intensity;
      sh.hitK *= Math.exp(-dt / 0.14);
      if (sh.hitLight) { sh.hitLight.intensity = 28 * sh.hitK * p.intensity; sh.hitLight.cookie[2] = t * 0.7; }
    }
  },
};
