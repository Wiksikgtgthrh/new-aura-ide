import { ARENA, COMMON_GLSL, NOISE_GLSL, GROUND_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL } from '../../vfx/common.js';
import { STRIP_GLSL } from '../../vfx/Ribbons.js';
import { REFRACT_GLSL } from '../../vfx/Refraction.js';

// Thunderstorm's custom draws. All of them read one set of uniforms (the sky, in the module):
//   storm   one back-faced cylinder in the fx pass: a short march through the rain below the deck
//           (sheets + distance fog + floor mist) and through the cloud deck itself, lit by the sky
//           from above and by the flash slots from inside. Nothing here emits.
//   rain    instanced streaks in the fx pass, three camera-centred cascades plus splash crowns;
//           radiance is the light they catch, so they vanish in the dark and go white in a flash.
//           Written as emission, not media: it must stay in front of the deck, over any sky pixel
//           (the lines pass is covered by the fx composite there), and it never hides what's behind.
//   film    a floor disc in the refract pass: the sky-cube reflection comes out, the deck goes in,
//           and rain rings shake everything the wet floor shows.

export const NF = 4;     // flash slots (slot 0 is the brightest: the one that casts cloud relief)

const f = (x) => x.toFixed(4);
const POOL = ARENA.pool;
// Same as Volumes.js: LOD 0 only, implicit gradients in a data-dependent loop make FXC unroll it.
const NO_GRADIENTS = '#define texture(s, p) textureLod(s, p, 0.0)\n';

const SKY_PARS = /* glsl */`
uniform vec4 uCell;           // centre x, z, core radius m, spin (turns at the core)
uniform vec4 uDeck;           // base y, top y, cover radius m, erosion 0..1
uniform vec4 uRain;           // amount 0..1, wind drift over one fall x, z (m), fall speed m/s
uniform vec4 uFlash[${NF}];   // position, radiance
uniform vec3 uFlashCol;
uniform vec3 uAmb0;           // sky light before the storm dimmed it
uniform vec3 uSun0;
uniform vec3 uCloudCol;
vec3 flashAt(vec3 p) {
  float s = 0.0;
  for (int i = 0; i < ${NF}; i++) {
    vec3 d = uFlash[i].xyz - p;
    float x = 1.0 + dot(d, d) * 0.035;
    s += uFlash[i].w / (x * sqrt(x));   // ~5 m soft core, a tail for the multiple scattering
  }
  return uFlashCol * s;
}
// rain sheets: long spiral arcs round the cell that lean with the wind, with denser bands falling
// through them (tile-seamless: turn wraps by 1, so the tile coordinates jump by whole numbers)
float curtain(vec3 p) {
  float k = 1.0 - clamp(p.y / uDeck.x, 0.0, 1.0);
  vec2 q = p.xz - uCell.xy - uRain.yz * k;
  float r = length(q) + 1e-3, rn = r / uCell.z;
  float turn = atan(q.y, q.x) / 6.2831853 + uCell.w / (1.0 + rn * rn) + 0.3 * k;
  return texture(uNoise3D, vec3(turn * 3.0, r * 0.075 - turn, p.y * 0.028 + uTime * 0.28)).r;
}
`;

// --- the storm: rain and cloud deck ---------------------------------------------------------------
export const STORM_VERT = FX_VERT_HEAD + /* glsl */`
out vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const STORM_FRAG = FX_FRAG_HEAD + NO_GRADIENTS + COMMON_GLSL + NOISE_GLSL + FX_OUT_GLSL + SKY_PARS + /* glsl */`
uniform vec3 uSunDir;
uniform vec4 uShape;   // wall cloud drop m, outer rise m, underside relief m, plate relief m
uniform vec4 uLook;    // sigma 1/m, base ambient, seed, proxy radius m
uniform vec4 uFog;     // sheets 1/m, background 1/m, far fog 1/m, floor mist 1/m
uniform vec4 uMarch;   // cloud steps, rain taps, fog start m, camera-above fade
in vec3 vW;

vec3 gScat = vec3(0.0);
float gT = 1.0, gZ = 0.0, gW = 0.0, gH = 0.0, gN = 0.5, gPlate = 0.0;

float deckSigma(vec3 p) {
  vec2 q = p.xz - uCell.xy;
  float r = length(q) + 1e-3, rn = r / uCell.z;
  float sp = uCell.w / (1.0 + rn * rn), a = sp * 6.2831853, ca = cos(a), sa = sin(a);
  vec2 qr = vec2(ca * q.x - sa * q.y, sa * q.x + ca * q.y);
  vec4 n = noise3v(vec3(qr.x, (p.y - uDeck.x) * 1.4, qr.y) * 0.047 + uLook.z);
  gN = n.b;
  float base = uDeck.x - uShape.x * exp(-rn * rn * 1.3) + uShape.y * smoothstep(1.2, 3.4, rn) + (n.r - 0.5) * uShape.z;
  base += gPlate;
  float top = uDeck.y + (n.g - 0.5) * 5.0;
  float d = smoothstep(base - 0.3, base + 2.2, p.y) * (1.0 - smoothstep(top - 3.0, top, p.y));
  if (d <= 0.0) return 0.0;
  // it spreads from the cell outwards in billows, and dies eroding billow by billow
  d *= smoothstep(-6.0, 6.0, uDeck.z - r + (n.r - 0.5) * 18.0);
  d *= smoothstep(uDeck.w - 0.1, uDeck.w + 0.3, 0.25 + n.r * 0.75 + (1.0 - uDeck.w) * 0.35) * (1.0 - uDeck.w * uDeck.w);
  gH = (p.y - base) / max(top - base, 1.0);
  return d * uLook.x * (0.75 + 0.5 * n.b) * uMarch.w;
}

vec3 cloudLight(vec3 p, float s) {
  float h = clamp(gH, 0.0, 1.0);
  // sky light from above; the underside only gets what leaks round its billows
  vec3 L = uAmb0 * mix(uLook.y * (0.3 + 1.8 * gN * gN), 1.05, h * h);
  // the low sun only reaches the upper skin; the base sits in the deck's own shadow
  if (uSunDir.y > 0.0) L += uSun0 * exp(-(1.0 - h) * 1.8 / max(uSunDir.y, 0.15)) * 0.7;
  vec3 fl = flashAt(p);
  if (dot(fl, fl) > 1e-4) {
    // one tap towards the brightest flash: relief on the billows, soft through the multiple-scatter lobe
    vec3 d = uFlash[0].xyz - p;
    float dl = length(d) + 1e-3, st = min(2.6, dl * 0.5);
    float s2 = deckSigma(p + d / dl * st), od = (s + s2) * st * 0.5;
    fl *= exp(-od) + 0.4 * exp(-0.2 * od);
  }
  return uCloudCol * (L + fl);
}

void marchCloud(vec3 o, vec3 rd, float a, float b) {
  if (b <= a) return;
  // stacked plates: laminar bands wound round the cell, the supercell "mothership" look. One tap per
  // ray where it meets the base: at this relief the parallax of a per-step tap doesn't show.
  float dyr = abs(rd.y) < 1e-3 ? 1e-3 : rd.y;
  vec2 q = o.xz + rd.xz * clamp((uDeck.x - o.y) / dyr, a, b) - uCell.xy;
  float r = length(q) + 1e-3, rn = r / uCell.z;
  float turn = atan(q.y, q.x) / 6.2831853 + uCell.w * 0.75 / (1.0 + rn * rn);
  gPlate = (noise3(vec3(turn * 2.0, r * 0.11 - turn, 0.37)) - 0.5) * uShape.w * smoothstep(1.0, 5.0, r);
  // start where this ray can first meet the base, not where the lowest cloud anywhere could hang:
  // the steps go where the cloud is
  float yStart = uDeck.x - uShape.x * exp(-rn * rn * 1.3) + uShape.y * smoothstep(1.2, 3.4, rn) + gPlate - 0.6 * uShape.z - 0.5;
  if (o.y < yStart && dyr > 0.0) a = max(a, (yStart - o.y) / dyr);
  float L = min(b - a, 22.0);
  if (L <= 0.0) return;
  int N = int(uMarch.x);
  float dt = L / float(N), t = a + dt * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))), len = 0.5 * dt, sP = 0.0;
  vec3 Lin = uCloudCol * (uAmb0 * uLook.y + flashAt(o + rd * (a + L)));   // what a ray that finds nothing in range sees
  int lit = 0;
  for (int i = 0; i <= 16; i++) {
    if (i > N || gT < 0.015) break;
    float s = sP;
    if (i < N) {
      vec3 p = o + rd * t;
      s = deckSigma(p);
      if (s > 1e-3) { if ((lit & 1) == 0) Lin = cloudLight(p, s); lit++; }
    } else len = 0.5 * dt;
    float sg = i == 0 ? s : 0.5 * (s + sP);
    sP = s;
    if (sg > 1e-4) {
      float A = gT * (1.0 - exp(-sg * len));
      gScat += A * Lin; gZ += A * (t - 0.5 * len); gW += A;
      gT -= A;
    }
    t += dt; len = dt;
  }
  // past the march the deck just carries on to the horizon
  if (b - a > L) { float A = gT * (1.0 - exp(-(b - a - L) * 0.25 * uLook.x * smoothstep(0.0, 8.0, uDeck.z - length(o.xz + rd.xz * b - uCell.xy)))); gScat += A * Lin; gZ += A * b; gW += A; gT -= A; }
}

void addSlab(vec3 p, float t, float od, float lightK) {
  if (od < 1e-4) return;
  float A = gT * (1.0 - exp(-od));
  gScat += A * uCloudCol * (mix(uAmb0, vec3(dot(uAmb0, vec3(0.3, 0.6, 0.1))), 0.6) * lightK + flashAt(p) * 0.5);
  gZ += A * t; gW += A;
  gT -= A;
}

void marchRain(vec3 o, vec3 rd, float a, float b) {
  float L = b - a;
  if (L <= 0.0) return;
  float n = uMarch.y, rain = uRain.x;
  for (float i = 0.0; i < n; i += 1.0) {
    float s0 = i / n, s1 = (i + 1.0) / n;
    float ta = a + L * s0 * s0, tb = a + L * s1 * s1, tm = 0.5 * (ta + tb);
    vec3 p = o + rd * tm;
    float r = length(p.xz - uCell.xy);
    float under = smoothstep(uDeck.z, uDeck.z - 8.0, r);
    // a long slab crosses many sheets: it sees their average, not one sheet's edge (but the shafts
    // keep their edges out to ~30 m slabs: heavy rain hangs in distinct curtains)
    float sheet = mix(0.3, smoothstep(0.47, 0.7, curtain(p)), exp(-(tb - ta) * 0.035));
    addSlab(p, tm, (uFog.y + uFog.x * sheet) * rain * under * (tb - ta), 0.2);
  }
  // far fog: the storm swallows the horizon; analytic along the ray beyond the start distance
  float farL = max(b - max(a, uMarch.z), 0.0);
  addSlab(o + rd * b, b, farL * uFog.z, 0.1);
  // floor mist: exact height integral along the ray, one noise tap for the rolling structure
  float ya = max(o.y + rd.y * a, 0.0), yb = max(o.y + rd.y * b, 0.0), Hs = 0.55;
  float od = abs(ya - yb) > 1e-3 ? Hs * abs(exp(-ya / Hs) - exp(-yb / Hs)) * L / abs(ya - yb) : exp(-ya / Hs) * L;
  vec3 pe = o + rd * mix(a, b, 0.85);
  float nm = noise3(vec3(pe.xz * 0.11 - uRain.yz * uTime * 0.09, uTime * 0.06).xzy);
  addSlab(pe, mix(a, b, 0.85), od * uFog.w * rain * smoothstep(0.3, 0.75, nm), 0.28);
}

void main() {
  vec3 o = cameraPosition, rd = normalize(vW - o);
  float cosV = dot(rd, -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float t0 = 0.0, t1 = sceneViewZ() / cosV;
  vec2 oc = o.xz - uCell.xy;
  float qa = dot(rd.xz, rd.xz), qb = dot(oc, rd.xz), qc = dot(oc, oc) - uLook.w * uLook.w;
  if (qa > 1e-6) {
    float disc = qb * qb - qa * qc;
    if (disc <= 0.0) discard;
    float sq = sqrt(disc);
    t0 = max((-qb - sq) / qa, 0.0); t1 = min(t1, (-qb + sq) / qa);
  } else if (qc > 0.0) discard;
  if (rd.y < -1e-4) t1 = min(t1, -o.y / rd.y);
  if (t1 <= t0) discard;
  float dy = abs(rd.y) < 1e-4 ? 1e-4 : rd.y;
  float yBase = uDeck.x, yLow = yBase - uShape.x - 0.5 * uShape.z - 0.5 * uShape.w - 0.3, yTop = uDeck.y + 3.0;
  float ty0 = (yLow - o.y) / dy, ty1 = (yTop - o.y) / dy, tb = (yBase - o.y) / dy;
  float c0 = max(t0, min(ty0, ty1)), c1 = min(t1, max(ty0, ty1));
  if (o.y < yBase) {
    // under the deck: rain, then cloud (the wall cloud hangs into the rain, behind its nearest sheets)
    marchRain(o, rd, t0, dy > 0.0 ? min(t1, tb) : t1);
    if (dy > 0.0) marchCloud(o, rd, c0, c1);
  } else {
    // in or above it: cloud, then the rain below
    marchCloud(o, rd, c0, c1);
    if (dy < 0.0) marchRain(o, rd, max(t0, tb), t1);
  }
  float alpha = 1.0 - gT;
  if (alpha < 0.002) discard;
  fxOut(gScat / max(alpha, 1e-4), alpha, vec3(0.0), vec2(0.0), (gW > 0.0 ? gZ / gW : t0) * cosV);
}`;

// --- rain: three camera-centred cascades of streaks, plus splash crowns ---------------------------
export const RAIN_VERT = FX_VERT_HEAD + COMMON_GLSL + NOISE_GLSL + STRIP_GLSL + SKY_PARS + /* glsl */`
in vec4 aSeed;
uniform vec4 uRainShape;   // shutter s, width m, streak coverage, splash coverage
uniform vec4 uBurst;       // carried round the cell rad, downburst spread, sheet floor, -
out vec2 vUv;
out vec3 vCol;
flat out float vKind;

// a drop on its way down: k = 1 at the deck, 0 at the floor
vec3 dropAt(vec2 xz, float k) {
  float fall = 1.0 - k;
  vec2 q = xz - uCell.xy;
  float rn = length(q) / uCell.z;
  float a = -uBurst.x * fall / (1.0 + rn * rn), ca = cos(a), sa = sin(a);
  q = vec2(ca * q.x - sa * q.y, sa * q.x + ca * q.y) * (1.0 + uBurst.y * fall * fall * fall);
  vec2 w = q + uCell.xy + uRain.yz * fall;
  return vec3(w.x, k * uDeck.x, w.y);
}

void main() {
  vUv = position.xy; vCol = vec3(0.0); vKind = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  int ki = gl_InstanceID % 16;
  float cas = ki < 5 ? 0.0 : ki < 10 ? 1.0 : ki < 14 ? 2.0 : 3.0;
  vec3 fw = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vec2 fh = normalize(fw.xz + vec2(1e-4, 0.0));
  if (cas > 2.5) {
    // splash crown: a short life on the floor where the camera is looking
    float ph = aSeed.y + uTime * (1.0 + 0.5 * aSeed.w), cyc = floor(ph), k = (ph - cyc) / 0.16;
    if (k > 1.0) return;
    float D = 26.0;
    vec2 ctr = cameraPosition.xz + fh * min(cameraPosition.y / max(-fw.y, 0.06), 20.0);
    vec2 h = hash33(vec3(aSeed.xz * 57.0, cyc)).xy;
    vec2 c = ctr - 0.5 * D + mod(h * D - (ctr - 0.5 * D), D);
    float cr = length(c - uCell.xy);
    float fade = smoothstep(uDeck.z, uDeck.z - 8.0, cr) * smoothstep(1.0, 0.8, length(c - ctr) / (0.5 * D)) * uRain.x * (1.0 - k * k);
    if (fade < 0.01 || length(c) > ${f(ARENA.radius)}) return;
    vec3 p = vec3(c.x, 0.0, c.y);
    float viewZ = -(viewMatrix * vec4(p, 1.0)).z;
    float s = (0.025 + 0.075 * k) * (0.7 + 0.6 * aSeed.w);
    vec3 side = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    vKind = 1.0;
    vCol = (uAmb0 * 0.8 + flashAt(p + vec3(0.0, 0.5, 0.0))) * fade * uRainShape.w;
    gl_Position = projectionMatrix * viewMatrix * vec4(p + side * position.x * s + vec3(0.0, position.y * s * 0.9 + 0.01, 0.0), 1.0);
    return;
  }
  float D = 12.0 * pow(2.0, cas);
  vec2 ctr = cameraPosition.xz + fh * D * 0.4;
  float v = uRain.w * (0.85 + 0.3 * aSeed.w), H = uDeck.x;
  float ph = aSeed.y - uTime * v / H, cyc = floor(ph), k = ph - cyc;
  vec2 h = hash33(vec3(aSeed.xz * 91.0, cyc)).xy;
  vec2 c = ctr - 0.5 * D + mod(h * D - (ctr - 0.5 * D), D);
  vec3 p0 = dropAt(c, k), p1 = dropAt(c, k + uRainShape.x * v / H);
  vec2 de = abs(c - ctr) / (0.5 * D);
  float fade = smoothstep(1.0, 0.8, max(de.x, de.y)) * smoothstep(uDeck.z, uDeck.z - 8.0, length(p0.xz - uCell.xy)) * uRain.x;
  fade *= mix(uBurst.z, 1.0, smoothstep(0.42, 0.66, curtain(p0)));
  // per instance, never per vertex: collapsing one end of a quad stretches it across the screen
  fade *= smoothstep(0.8, 5.0, -(viewMatrix * vec4(0.5 * (p0 + p1), 1.0)).z);
  if (fade < 0.012) return;
  vec3 p = position.y > 0.5 ? p1 : p0;
  float viewZ = max(-(viewMatrix * vec4(p, 1.0)).z, 0.05);
  float aa;
  float hw = wireHalfWidth(uRainShape.y * (1.0 + 1.1 * cas), viewZ, pxPerMetre(uFxResolution.y), aa);
  vCol = (uAmb0 * 0.24 + flashAt(p0) * 0.3) * fade * aa * uRainShape.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(p + stripSide(p, p1 - p0) * position.x * hw, 1.0);
}`;

export const RAIN_FRAG = FX_FRAG_HEAD + COMMON_GLSL + FX_OUT_GLSL + /* glsl */`
in vec2 vUv;
in vec3 vCol;
flat in float vKind;
void main() {
  float a;
  if (vKind < 0.5) {
    // a motion-blurred drop: soft across, brightest mid-streak, no hard ends
    float x = 1.0 - vUv.x * vUv.x, y = sin(vUv.y * 3.14159265);
    a = x * x * y;
  } else {
    // a crown from the side: a flat rim on the floor and one jet flung up off it
    float rim = 1.0 - smoothstep(0.0, 0.22, abs(length(vec2(vUv.x, (vUv.y - 0.1) * 4.0)) - 0.7));
    float jet = (1.0 - smoothstep(0.0, 0.2, abs(vUv.x))) * (1.0 - vUv.y);
    a = rim * 0.7 + jet;
  }
  fxOut(vec3(0.0), 0.0, vCol * a, vec2(0.0), 1.0);
}`;

// --- wet film: what the rained-on floor shows --------------------------------------------------
const PILLARS = ARENA.pillars.map((p) => `vec2(${f(p.x)}, ${f(p.z)})`).join(', ');
export const FILM_VERT = /* glsl */`
out vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export const FILM_FRAG = COMMON_GLSL + NOISE_GLSL + GROUND_GLSL + REFRACT_GLSL + SKY_PARS + /* glsl */`
uniform vec4 uFilm;   // amount, ripple strength, reflection gain, -
uniform vec3 uAmbient;
uniform vec3 uRuneColor;
in vec3 vW;
const vec2 PIL[8] = vec2[8](${PILLARS});
out vec4 fragColor;

// one drop per cell at a time, each on its own clock: a ring and two crests behind it
vec2 rippleLayer(vec2 p, float cell, float seed) {
  vec2 g = p / cell, id = floor(g), q = g - id - 0.5;
  vec3 h = hash33(vec3(id, seed));
  float ph = fract(uTime * (0.8 + 0.8 * h.z) + h.x * 7.0), size = 0.45 + 0.55 * h.y * h.y;   // mostly small drops, the odd big one
  vec2 d = q - (h.xy - 0.5) * 0.36;
  float r = length(d), e = (r - ph * 0.44 * size) * 30.0 / size;
  return d / max(r, 1e-3) * sin(e) * exp(-e * e * 0.13) * (1.0 - ph) * (1.0 - ph) * step(0.3, h.z) * size;
}

// what the mirror ray meets first: a column (stone, its rune bands, the flash on it), the rim wall,
// else the deck (analytic: 8 vertical cylinders and the wall's inner face, no reflection pass)
vec3 deckMirror(vec3 p, vec3 R);
vec3 mirrorScene(vec3 p, vec3 R) {
  vec2 d = R.xz;
  float a = max(dot(d, d), 1e-6), tw = 1e9, ty = 1e9;
  int hit = -1;
  for (int i = 0; i < 8; i++) {
    vec2 oc = p.xz - PIL[i];
    float b = dot(oc, d), c = dot(oc, oc) - ${f(ARENA.pillarRadius * ARENA.pillarRadius)}, disc = b * b - a * c;
    if (disc > 0.0) { float t = (-b - sqrt(disc)) / a; if (t > 0.0 && t < tw) { tw = t; hit = i; } }
  }
  float b = dot(p.xz, d), c = dot(p.xz, p.xz) - ${f(ARENA.radius * ARENA.radius)};
  float tr = (-b + sqrt(max(b * b - a * c, 0.0))) / a;
  vec3 stone = vec3(0.30, 0.27, 0.235);
  if (hit >= 0 && p.y + R.y * tw < ${f(ARENA.pillarHeight)}) {
    vec3 h = p + R * tw;
    vec2 q = h.xz - PIL[hit];
    float gu = (atan(q.y, q.x) / 6.2831853 + 0.5) * 14.0;
    float band = step(1.62, h.y) * step(h.y, 1.86) + step(4.34, h.y) * step(h.y, 4.52);
    float glyph = band * smoothstep(0.42, 0.3, abs(fract(gu) - 0.5)) * (0.25 + 0.2 * sin(gu * 7.1 + float(hit) * 3.0));
    return stone * mix(0.5, 1.0, smoothstep(0.0, 1.6, h.y)) * (uAmbient + flashAt(h) * 0.6) + uRuneColor * glyph;
  }
  if (p.y + R.y * tr < ${f(ARENA.wallHeight)}) return stone * 0.9 * (uAmbient + flashAt(p + R * tr) * 0.6);
  return deckMirror(p, R);
}

// the deck overhead, as a mirror sees it: dark, with the flash glowing through its billows
vec3 deckMirror(vec3 p, vec3 R) {
  vec3 h = p + R * ((uDeck.x - p.y) / max(R.y, 0.05));
  float n = noise3(vec3(h.x - uCell.x, 0.3, h.z - uCell.y) * 0.03);
  float all_ = uFlash[0].w + uFlash[1].w + uFlash[2].w + uFlash[3].w;
  return uCloudCol * (uAmb0 * mix(0.03, 0.16, n) + (flashAt(h) + uFlashCol * all_ * 0.05) * (0.3 + 1.4 * n));
}

void main() {
  vec2 p = vW.xz;
  vec2 pq = abs(p - vec2(${f(POOL.center.x)}, ${f(POOL.center.y)}));
  if (pq.x < ${f(POOL.half.x - 0.05)} && pq.y < ${f(POOL.half.y - 0.05)}) discard;   // overlaps the rim: stopping on it leaves bright MSAA samples
  float wet = groundA(p).z, soak = smoothstep(0.02, 0.25, wet);
  float mask = uFilm.x;
  if (mask < 0.004) discard;
  float viewZ = refrViewZ(vW);
  float px = 2.0 * viewZ / (projectionMatrix[1][1] * uResolution.y);
  float nl = noise3(vec3(p.x, 0.17, p.y) * 0.05);
  float puddle = smoothstep(0.34, 0.62, wet * 0.55 + nl * 0.75 - 0.05);
  // ripples, each layer gone before its rings shrink under the pixel grid
  vec2 sl = rippleLayer(p, 0.46, 3.0) * (1.0 - smoothstep(0.01, 0.024, px));
  sl += rippleLayer(p + 0.31, 0.29, 11.0) * (1.0 - smoothstep(0.006, 0.014, px));
  sl *= uFilm.y * uRain.x * mix(0.35, 1.0, puddle) * soak;
  vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));
  vec3 v = normalize(cameraPosition - vW);
  // the floor shown through the shaking film, depth-validated at object edges
  vec2 uv0 = gl_FragCoord.xy / uResolution, uv = uv0 + sl * 0.012;
  float z1 = linearDepth(textureLod(uSceneDepth, uv, 0.0).r);
  uv = mix(uv0, uv, smoothstep(viewZ - 0.3, viewZ + 0.3, z1));
  vec3 col = textureLod(uSceneColor, uv, 0.0).rgb;
  // take the bright sky reflection out (the deck is in the way) and put the deck in
  float rough = mix(0.22, mix(0.2, 0.05, puddle), soak), nv0 = max(v.y, 1e-3);
  float F0 = fresnelRough(nv0, 0.04, rough);
  vec3 R0 = reflect(-v, vec3(0.0, 1.0, 0.0));
  vec3 sky = envReflect(R0, 0.12) * F0;
  col = max(col - sky * 1.5, col * 0.05);
  col = mix(col, vec3(dot(col, vec3(0.3, 0.6, 0.1))) * vec3(0.92, 0.98, 1.1), 0.75);   // the sky over it is grey now
  vec3 R = reflect(-v, n);
  float F = fresnelRough(max(dot(n, v), 0.0), 0.03, rough) * mix(0.25, mix(0.55, 1.0, puddle), soak);
  if (F * uFilm.z > 0.004) col += mirrorScene(vW, R) * F * uFilm.z;
  fragColor = vec4(col, mask);
}`;

// --- the sky behind everything: the deck closes over the horizon, so no sun or bright sky gets past ---
export const DOME_VERT = /* glsl */`
out vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * viewMatrix * (modelMatrix * vec4(position, 1.0));
}`;

export const DOME_FRAG = /* glsl */`
precision highp float;
uniform vec4 uDome;   // flash glow, alpha, -, -
uniform vec3 uFlashCol;
uniform vec3 uAmb0;
uniform vec3 uCloudCol;
in vec3 vDir;
out vec4 fragColor;
void main() {
  float up = normalize(vDir).y;
  vec3 horizon = uAmb0 * mix(0.05, 0.02, smoothstep(-0.05, 0.4, abs(up)));
  fragColor = vec4(uCloudCol * (horizon + uFlashCol * uDome.x), uDome.y);
}`;

// the pool can't be un-skied from the scene colour (it isn't in it yet): darken what's already drawn
export const SHADE_FRAG = /* glsl */`
precision highp float;
uniform vec3 uShade;
out vec4 fragColor;
void main() { fragColor = vec4(uShade, 1.0); }`;
