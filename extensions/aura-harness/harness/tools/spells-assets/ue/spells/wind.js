import * as THREE from 'three';
import { COMMON_GLSL, NOISE_GLSL, ARENA_GLSL, LIGHTS_GLSL, FX_VERT_HEAD, FX_FRAG_HEAD, FX_OUT_GLSL, FX_BLENDING } from '../vfx/common.js';

// Wind (PLAN 3). Air is invisible: it is shown by what it carries and by how it bends the light.
// Reference: tornado / dust-devil footage (a coherent column whose walls are sheets of dust
// spiralling up, thick and dark at the foot, thinning aloft; a debris cloud skirting the ground).
// Cyclone: the caster's focus gathers air while dust starts to whirl on the floor where the funnel
// will touch down; then a raymarched dust funnel (its own marcher: helical dust sheets advected round
// and up the wall, a churning cauliflower debris cloud at the foot, sun-lit with a self-shadowed
// side) spins up from the ground and walks to the target. A Rankine vortex joins the shared force
// field (every loose particle of every spell is dragged in), gravel, rocks and leaves are lifted
// and flung out of it with weight, lit dust rolls out along the floor and is sucked back in, the
// floor is scoured in cycloidal streaks, refraction sheets (pure distortion helix ribbons) and
// shimmer sprites ride the wall, dummies are buffeted and the pool swirls. It ropes out at the
// end: narrows, sways, thins and drops its load.
// Wind Slash: a pressure blade thrown low. Mostly invisible: a refraction edge with a faint vapour
// sheet, a shear line of floor dust lifted and dragged behind it, a rooster tail of dust and chips
// where its lower tip scores a cut into the ground field, shimmer left in its wake.

const NH = 10;   // refraction helix ribbons per cyclone (fx: distortion only)
const NS = 3;    // charge swirl arms
const NB = 3;    // blade layers (main + 2 echoes)
const NV = 2;    // funnel marchers (cyclones alive at once with a funnel)
const TAU = Math.PI * 2;
// LOD-0 lookups only inside the march (Volumes.js: gradients in a data-dependent loop make ANGLE's FXC unroll it)
const NO_GRADIENTS = '#define texture(s, p) textureLod(s, p, 0.0)\n';

// One path for every wind ribbon (one draw per pass). p0.w picks the shape:
//  0 helix up the funnel: p0 foot, p1 (height, radius foot, radius top, turns), p2 (angle, lean x, lean z, width), p3 (seed, reveal, distortion m, body)
//  1 crescent: p0 middle (leading point), p1 (forward, radius), p2 (transverse, width), p3 (seed, half arc, distortion m, body)
//  2 swirl into the focus: p0 centre, p1 (outer r, inner r, turns, rise), p2 (angle, -, -, width), p3 (seed, reveal, distortion m, body)
const PATH_GLSL = /* glsl */`
vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width) {
  int mode = int(p0.w + 0.5);
  if (mode == 1) {
    // the middle leads and the tips trail; width tapers to points
    float A = p3.y, th = (t * 2.0 - 1.0) * A;
    width = p2.w * pow(max(cos(th / A * 1.5707963), 0.0), 0.7);
    return p0.xyz + p1.xyz * (p1.w * (cos(th) - 1.0)) + p2.xyz * (p1.w * sin(th));
  }
  if (mode == 2) {
    float th = p2.x - t * p1.z * 6.2831853;
    float r = mix(p1.x, p1.y, t);
    width = p2.w * (1.0 - 0.6 * t);
    return p0.xyz + vec3(cos(th) * r, (t - 0.5) * p1.w, sin(th) * r);
  }
  float r = mix(p1.y, p1.z, pow(t, 1.6)) * (1.0 + 0.07 * sin(t * 6.0 + p3.x * 6.2831853 + uTime * 2.3));
  float th = p2.x + t * p1.w * 6.2831853;
  width = p2.w * mix(0.6, 1.6, t);
  return p0.xyz + vec3(p2.y, 0.0, p2.z) * (t * t) + vec3(cos(th) * r, t * p1.x, sin(th) * r);
}`;

const SHADE_GLSL = /* glsl */`
uniform vec3 uSunColor;
uniform vec3 uAmbient;
vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion) {
  int mode = int(r.p0.w + 0.5);
  float u = r.uv.x, v = r.uv.y;
  float core = max(exp(-4.0 * v * v) - 0.0183, 0.0);
  float along = 1.0, body = 1.0;
  if (mode == 1) {
    // turbulent shear along the blade
    along = 0.7 + 0.3 * sin(u * 37.0 - uTime * 23.0 + r.p3.x * 6.2831853) * sin(u * 11.0 + uTime * 9.0);
  } else {
    // gusts of moving air running along the ribbon: up the funnel, into the focus
    // a bright head and a fading tail, ~40% duty, so it reads as gusts rather than stripes
    float s = fract(u * (mode == 0 ? 3.0 : 2.0) - uTime * (mode == 0 ? 0.5 : 1.4) + r.p3.x);
    float ends = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.8, 1.0, u)) * (1.0 - smoothstep(r.p3.y - 0.15, r.p3.y, u));
    along = smoothstep(0.5, 0.95, s) * (1.0 - smoothstep(0.95, 1.0, s)) * ends;
    body = (0.35 + 0.65 * along / max(ends, 1e-3)) * ends;
  }
  // derivative-of-gaussian profile: the centreline acts as a cylindrical lens
  distortion = r.p3.z * v * exp(-3.0 * v * v) * 2.33 * body;
  media = uSunColor * 0.12 + uAmbient * 1.6;
  alpha = r.p3.w * core * along;
  return r.color * core * along;
}`;

// The funnel: its own raymarcher in the fx pass (a box proxy, back faces, depth test off, like
// Volumes.js), because a generic box march spends most of its samples in the empty air round a
// column. Samples are spread with a Cauchy warp about the ray's closest approach to the axis, so
// ~half of them land within one funnel radius of it (~0.15 m apart through the wall, coarser in
// the empty air). Integration is trapezoid slabs over the warped samples; lighting (sun with one
// shadow tap + a multiple-scattering lobe, sky dimmed by the same tap and by the floor, spell
// lights with one tap towards the brightest) is refreshed on every 2nd occupied sample.
// The medium is in cylindrical coordinates about the swaying axis. The dust pattern is advected
// with the flow (round with the wall, up with the updraft): noise sampled in (angle + spin,
// height - rise, radius) with an integer number of tiles per turn (the noise texture tiles) and a
// slope that follows the streamlines, which stretches it into helical sheets.
const FUNNEL_GLSL = /* glsl */`
uniform vec4 uTw0;   // foot x, z, height H (m), spin (turns)
uniform vec4 uTw1;   // lean x, z at the top (m), size, rise (m)
uniform vec4 uTw2;   // seed, density 1/m, sway (m), time (s)
uniform vec4 uTw3;   // debris cloud 0..1, column reveal (fraction of H), detail, rope-out 0..1
uniform vec3 uDust;  // albedo
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec4 uMarch; // samples, sun tap (m), HG g, axis scale (m)
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
in vec3 vWorld;
float gDt = 0.1;     // this sample's spacing: detail finer than it is faded out
float sq(float x) { return x * x; }
// coarse: the shadow taps, which only need the big shapes (no sheets, no billows)
float funnel(vec3 pw, bool coarse, out vec3 albedo) {
  albedo = vec3(0.0);
  float H = uTw0.z, sz = uTw1.z, y = pw.y, hn = y / H;
  if (y < 0.0 || hn > 1.15) return 0.0;
  float t = uTw2.w, seed = uTw2.x, rope = uTw3.w, hc = min(hn, 1.0);
  // the axis lags its motion (lean) and sways like a rope, more as it ropes out
  vec2 sway = vec2(sin(hn * 4.7 - t * 1.9 + seed * 6.0), cos(hn * 3.9 - t * 1.6 + seed * 4.0));
  vec2 q = pw.xz - uTw0.xy - uTw1.xy * (hn * hn) - sway * (uTw2.z * hn * (1.0 + 2.5 * rope));
  float r = length(q);
  float R = sz * (0.4 + 1.5 * pow(hc, 1.8)) * (1.0 - 0.6 * rope);      // wall radius
  float cloudR = sz * 2.0 * uTw3.x;                                      // debris cloud reach
  float reach = max(R * 1.5 + 0.2 * sz, cloudR * 1.4 * (1.0 - smoothstep(1.0 * sz, 2.2 * sz, y)));
  if (r > reach) return 0.0;
  float a = atan(q.y, q.x) * 0.15915494;
  float spin = uTw0.w * (1.0 - 0.4 * hc);
  // big lumps riding round with the wall and rising; they also roughen every edge
  float n2 = noise3(vec3((a + spin) * 2.0, (y - 0.5 * uTw1.w) * 0.08, r * 0.1 + seed));
  // helical sheets: across the streamlines, stretched along them
  float n1 = coarse ? 0.5 : noise3(vec3((a + spin) * 4.0 + hn * 6.5, (y - uTw1.w) * 0.07, r * 0.12 + seed * 0.7));
  float lump = n2 - 0.5;
  // column: a wall of dust round a thinner core, broken into sheets, thick at the foot
  float rr = r + lump * R * 0.7;
  float W = R * (0.2 + 0.1 * hc) + 0.1 * sz;
  float wall = exp(-sq((rr - 0.72 * R) / W)) + 0.25 * (1.0 - smoothstep(0.1 * R, 0.8 * R, rr));
  float sheets = smoothstep(0.32, 0.7, n1 + lump * 0.35);
  float reveal = 1.0 - smoothstep(uTw3.y * H - 0.8, uTw3.y * H + 0.3, y + lump * 2.0);
  float top = 1.0 - smoothstep(0.7, 1.08, hn + lump * 0.3);
  float column = wall * mix(0.1, 1.4, sheets) * mix(1.6, 0.45, hc) * top * reveal;
  // debris cloud: a squat, churning sheath round the foot, cauliflower edged
  float hb = y / (1.6 * sz);
  float cr = cloudR * (0.7 + 0.45 * hb) + lump * 1.5 * sz;
  float cloud = smoothstep(cr, cr * 0.35, r) * (1.0 - smoothstep(0.3, 1.0, hb + lump * 0.8));
  float d = column + 2.2 * cloud;
  if (d < 0.01) return 0.0;
  // fine billows, faded where the march can't resolve them
  float detail = uTw3.z * (1.0 - smoothstep(0.1, 0.3, gDt));
  if (detail > 0.01 && !coarse) {
    float n3 = noise3(vec3((a + spin * 1.15) * 6.0, (y - 0.4 * uTw1.w) * 0.2, r * 0.3 + seed * 1.3));
    d *= mix(1.0, 0.35 + 1.2 * n3, detail);
  }
  // dirtier and darker low down, paler where the wall thins aloft
  albedo = uDust * (0.8 + 0.4 * n1) * mix(0.45, 1.05, smoothstep(0.0, 0.6, hn));
  return uTw2.y * d * (1.0 - 0.6 * rope);
}
void main() {
  gLightNoShadow = true;
  vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
  vec3 inv = 1.0 / mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
  vec3 ta = (uBoxMin - ro) * inv, tb = (uBoxMax - ro) * inv, tn = min(ta, tb), tf = max(ta, tb);
  float cosV = dot(rd, -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float t0 = max(max(max(tn.x, tn.y), tn.z), 0.0), t1 = min(min(tf.x, tf.y), tf.z);
  float tEnd = min(t1, sceneViewZ() / cosV);
  if (tEnd <= t0) discard;
  // Cauchy warp about the closest approach to the axis (in plan), over the whole box chord so the
  // samples don't slide with the floor depth (that turns into contour bands); cut at the scene
  float l2 = dot(rd.xz, rd.xz);
  float tc = l2 > 1e-6 ? dot(uTw0.xy + 0.5 * uTw1.xy - ro.xz, rd.xz) / l2 : 0.5 * (t0 + t1);
  float s = min(uMarch.w / sqrt(max(l2, 1e-6)), t1 - t0);
  float a0 = atan((t0 - tc) / s), a1 = atan((t1 - tc) / s);
  int N = int(uMarch.x);
  float da = (a1 - a0) / float(N);
  float tap = uMarch.y, g = uMarch.z;
  vec3 sun = uSunColor * hgPhase(dot(uSunDir, rd), g) * 4.0 * PI;
  bool hasLight = uWorldCounts.x > 0.5;
  vec3 scat = vec3(0.0), Lin = vec3(0.0), sP = vec3(0.0), alb, a2;
  float T = 1.0, zSum = 0.0, wSum = 0.0, sigP = 0.0, tP = t0, odSun = 0.0, odL = 0.0;
  int lit = 0;
  for (int i = 0; i <= 48; i++) {
    if (i > N || T < 0.01 || tP >= tEnd) break;
    float t = min(tc + s * tan(a0 + da * float(i)), tEnd);
    gDt = s * da * (1.0 + sq((t - tc) / s));   // dt/di of the warp
    vec3 pw = ro + rd * t;
    float sigma = funnel(pw, false, alb);
    if (sigma > 1e-4) {
      // sun shadow every occupied sample (the lit side vs the shadowed side is the look);
      // the spell-light tap every 2nd
      odSun = (sigma + funnel(pw + uSunDir * tap, true, a2)) * tap;
      {
        if (hasLight && (lit & 1) == 0) {
          SpellLight L0 = spellLight(0);
          vec3 lp = L0.type == 1 ? closestOnSegment(L0.pos, L0.end, pw) : L0.pos, ld = lp - pw;
          float ll = length(ld), dl = min(tap, ll * 0.5);
          odL = (sigma + funnel(pw + ld * (dl / max(ll, 1e-4)), true, a2)) * dl;
        }
        // the sky is half hidden near the floor
        float sky = mix(0.35, 1.0, exp(-0.5 * odSun)) * mix(0.55, 1.0, smoothstep(0.0, 2.5, pw.y));
        Lin = sun * (exp(-odSun) + 0.25 * exp(-0.25 * odSun)) + uAmbient * sky
            + spellLightScatter(pw, -rd, g) * (exp(-odL) + 0.25 * exp(-0.25 * odL));
      }
      lit++;
    }
    vec3 S = alb * Lin;
    float sg = 0.5 * (sigma + sigP), len = t - tP;
    if (i > 0 && sg > 1e-4) {
      float Tr = exp(-sg * len), w = T * (1.0 - Tr);
      scat += w * 0.5 * (S + sP);
      zSum += w * (t - 0.5 * len); wSum += w;
      T *= Tr;
    }
    sigP = sigma; sP = S; tP = t;
  }
  float alpha = 1.0 - T;
  if (alpha < 0.002) discard;
  fxOut(scat / max(alpha, 1e-4), alpha, vec3(0.0), vec2(0.0), (wSum > 0.0 ? zSum / wSum : t0) * cosV);
}`;

const FUNNEL_VERT = /* glsl */`
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

export default {
  id: 'wind', name: 'Wind', key: '6', hue: '#c8f5e4',
  shape: 'projectile', forms: ['Cyclone', 'Wind Slash'], radius: 0.3,
  params: {
    strength: 1, size: 1, drift: 3.5, duration: 3.5, dust: 1, debris: 1, streaks: 1, refraction: 1,
    slashSpeed: 24, slashSize: 1, tilt: 50, scratch: 1, air: '#dff4ff', dustColor: '#7d6a55',
  },
  ranges: {
    strength: [0.2, 2.5, 0.01], size: [0.4, 2, 0.01], drift: [0, 10, 0.1], duration: [1, 8, 0.1],
    dust: [0, 3, 0.01], debris: [0, 3, 0.01], streaks: [0, 3, 0.01], refraction: [0, 3, 0.01],
    slashSpeed: [6, 50, 0.1], slashSize: [0.4, 2.5, 0.01], tilt: [0, 90, 1], scratch: [0, 2, 0.01],
  },
  presets: {
    'dust devil': { size: 0.7, strength: 1.3, dust: 1.8, debris: 0.6, dustColor: '#b4875a', air: '#ffe9cf' },
    gale: { size: 1.4, strength: 1.8, streaks: 2, refraction: 1.6, debris: 2.2, slashSize: 1.5, scratch: 1.6 },
    'spirit wind': { air: '#8dffd6', dustColor: '#5f8f84', streaks: 2.4, dust: 0.5, refraction: 1.4 },
  },
  timing: { charge: 0.9, impact: 0.3, linger: 3.5, sustain: 8 },
  kinds: {
    streak: { style: 'glow', drag: 0.4, curl: 1.2, curlScale: 0.3, forceResponse: 2, life: [0.35, 0.7], size: [0.016, 0.006], stretch: 0.08, emissive: 1.8, color: ['#dff4ff', '#a7c6d4'], alpha: [0.9, 0], fadeIn: 0.2, fadeOut: 0.4 },
    mote: { style: 'glow', drag: 1.0, buoyancy: 0.9, curl: 0.9, curlScale: 0.5, forceResponse: 1.2, life: [1.4, 2.4], size: [0.014, 0.007], stretch: 0.012, emissive: 1.1, color: ['#fff0d6', '#d6c6a6'], alpha: [1, 0], fadeIn: 0.25, fadeOut: 0.35 },
    dust: { style: 'media', drag: 0.25, buoyancy: 0.2, curl: 0.5, curlScale: 0.25, forceResponse: 2.5, life: [1.1, 1.9], size: [0.35, 1.2], sizePow: 0.6, color: ['#7d6a55', '#8c7760'], alpha: [0.2, 0], density: 2.6, erosion: 0.55, fadeIn: 0.2, fadeOut: 0.4 },
    skirt: { style: 'media', drag: 1.2, buoyancy: 0.3, curl: 0.6, curlScale: 0.2, forceResponse: 1.3, life: [1.0, 1.8], size: [0.4, 1.2], color: ['#7d6a55', '#8c7760'], alpha: [0.1625, 0], density: 1.7, erosion: 0.6, fadeIn: 0.15 },
    kick: { style: 'media', drag: 2.4, buoyancy: 0.35, curl: 0.6, curlScale: 0.3, life: [0.6, 1.3], size: [0.2, 0.95], color: ['#7d6a55', '#8c7760'], alpha: [0.1125, 0], density: 1.6, erosion: 0.6, fadeIn: 0.05 },
    haze: { style: 'media', drag: 0.3, forceResponse: 2.5, life: [0.9, 1.5], size: [0.9, 1.8], alpha: [1, 0], density: 0, distortion: 4.5, fadeIn: 0.25, fadeOut: 0.4 },
    leaf: { style: 'debris', mesh: 'leaf', drag: 1.2, gravity: 1.4, curl: 2.5, curlScale: 0.4, forceResponse: 2.4, restitution: 0.1, friction: 0.8, life: [2.5, 4], size: [0.09, 0.09], spin: 7, color: ['#5e5a2c', '#000000'], alpha: [1, 0.75], fadeOut: 0.15 },
    pebble: { style: 'debris', mesh: 'rock', drag: 0.15, gravity: 9.8, forceResponse: 2.2, restitution: 0.3, friction: 0.5, life: [1.8, 3], size: [0.07, 0.07], spin: 9, color: ['#7a736b', '#000000'], alpha: [1, 0.9], fadeOut: 0.1 },
    // heavy rubble: lifted slowly, swung wide and thrown out of the funnel, lands and tumbles
    chunk: { style: 'debris', mesh: 'rock', drag: 0.06, gravity: 9.8, forceResponse: 0.75, restitution: 0.22, friction: 0.65, life: [2.6, 3.6], size: [0.15, 0.15], spin: 5, color: ['#6e655b', '#000000'], alpha: [1, 0.92], fadeOut: 0.08 },
    // dust dragged off the floor by a passing blade: hangs, spreads and settles
    sheet: { style: 'media', drag: 3.2, buoyancy: 0.25, curl: 0.9, curlScale: 0.35, forceResponse: 1, life: [0.9, 1.7], size: [0.25, 1.1], sizePow: 0.5, color: ['#7d6a55', '#8c7760'], alpha: [0.16, 0], density: 2.2, erosion: 0.55, fadeIn: 0.04, fadeOut: 0.5 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const E = {
      gather: P.emitter('wind.streak', { shape: 'shell', radius: 1.8, spread: 0.4, radial: -3.5 }),
      motes: P.emitter('wind.mote', { shape: 'disk', radius: 2.2, spread: 0.5 }),
      focusHaze: P.emitter('wind.haze', { shape: 'sphere', radius: 0.4, spread: 0.5 }),
      stir: P.emitter('wind.skirt', { shape: 'ring', radius: 1.6, spread: 0.3, radial: -0.8 }),
      dust: P.emitter('wind.dust', { shape: 'ring', radius: 1, spread: 0.5, radial: 0.4 }),
      inflow: P.emitter('wind.dust', { shape: 'ring', radius: 3.5, spread: 0.4, radial: -2.2 }),
      haze: P.emitter('wind.haze', { shape: 'ring', radius: 1, spread: 0.4 }),
      skirt: P.emitter('wind.skirt', { shape: 'ring', radius: 1.8, spread: 0.5, radial: 1.2 }),
      leaf: P.emitter('wind.leaf', { shape: 'ring', radius: 1.5, spread: 1.2, radial: -0.5 }),
      pebble: P.emitter('wind.pebble', { shape: 'ring', radius: 1.5, spread: 1.0 }),
      grit: P.emitter('wind.pebble', { shape: 'ring', radius: 1.2, spread: 1.2, radial: 0.5 }),
      chunk: P.emitter('wind.chunk', { shape: 'ring', radius: 1.1, spread: 1.4, radial: 2.5 }),
      burst: P.emitter('wind.streak', { shape: 'sphere', radius: 0.3, spread: 2, radial: 6 }),
      sheet: P.emitter('wind.sheet', { shape: 'line', radius: 0.12, spread: 0.5 }),
      wake: P.emitter('wind.haze', { shape: 'line', radius: 0.1, spread: 0.3 }),
      kick: P.emitter('wind.kick', { shape: 'sphere', radius: 0.15, spread: 1.2 }),
      tail: P.emitter('wind.sheet', { shape: 'sphere', radius: 0.12, spread: 0.6 }),
      chip: P.emitter('wind.pebble', { shape: 'sphere', radius: 0.1, spread: 1.5 }),
    };

    // one ribbon material per pass: refraction sheets / vapour at half res, the blade's crisp edge at full res
    const ribs = new fx.AnalyticRibbons({ max: 48, segments: 64, pathGLSL: PATH_GLSL, shadeGLSL: SHADE_GLSL, target: 'fx' });
    const cores = new fx.AnalyticRibbons({ max: 24, segments: 64, pathGLSL: PATH_GLSL, shadeGLSL: SHADE_GLSL, target: 'lines' });
    fx.scenes.fx.add(ribs.mesh);
    fx.scenes.lines.add(cores.mesh);

    // funnel marchers, owned by a cast while it lives
    const dustLin = new THREE.Color(), boxGeo = new THREE.BoxGeometry(2, 2, 2);
    const vols = Array.from({ length: NV }, () => {
      const u = {
        ...fx.U,
        uTw0: { value: new THREE.Vector4() }, uTw1: { value: new THREE.Vector4() }, uTw2: { value: new THREE.Vector4() },
        uTw3: { value: new THREE.Vector4() }, uDust: { value: dustLin }, uBoxMin: { value: new THREE.Vector3() },
        uBoxMax: { value: new THREE.Vector3() }, uMarch: { value: new THREE.Vector4() },
      };
      const m = new THREE.Mesh(boxGeo, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, uniforms: u, ...FX_BLENDING, depthTest: false, side: THREE.BackSide,
        vertexShader: FX_VERT_HEAD + FUNNEL_VERT,
        fragmentShader: FX_FRAG_HEAD + NO_GRADIENTS + COMMON_GLSL + NOISE_GLSL + ARENA_GLSL + LIGHTS_GLSL + FX_OUT_GLSL + FUNNEL_GLSL,
      }));
      m.visible = false;
      m.userData.owner = null;
      fx.scenes.fx.add(m);
      return m;
    });

    // per-cast state, indexed by the cast record (16), so casting allocates nothing
    const state = Array.from({ length: 16 }, () => ({
      helix: new Array(NH).fill(null), swirl: new Array(NS).fill(null),
      blades: new Array(NB).fill(null), blade: null, vortex: null, gather: null, light: null, vol: null,
      hp: new Float32Array(NH * 5), sx: new Float32Array(2), sz: new Float32Array(2),
      start: new THREE.Vector3(), end: new THREE.Vector3(), base: new THREE.Vector3(), prev: new THREE.Vector3(),
      vel: new THREE.Vector3(), lean: new THREE.Vector3(), F: new THREE.Vector3(), Sd: new THREE.Vector3(), T: new THREE.Vector3(),
      tip: new THREE.Vector3(), top: new THREE.Vector3(), lastTip: new THREE.Vector3(),
      s: 0, dist: 0, env: 0, age: 0, hitT: 0, mask: 0, range: 0, travelled: 0, cy: 0, sign: 1, scratching: false, seedF: 0, tImpact: 0,
      spin: 0, rise: 0, scourT: 0, scourOn: false, stainT: 0, flingT: 0,
    }));

    const air = new THREE.Color(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    const col = { air: '', dust: '' }, tmp = new THREE.Color();
    function applyColors(p) {
      air.set(p.air);
      if (col.air !== p.air) {
        col.air = p.air;
        P.setKind('wind.streak', { color: [p.air, `#${tmp.set(p.air).multiplyScalar(0.72).getHexString()}`] });
      }
      if (col.dust !== p.dustColor) {
        col.dust = p.dustColor;
        const dark = `#${tmp.set(p.dustColor).multiplyScalar(1.12).getHexString()}`;
        for (const k of ['wind.dust', 'wind.skirt', 'wind.kick', 'wind.sheet']) P.setKind(k, { color: [p.dustColor, dark] });
        // the volume's albedo: the dust colour, a little greyer (sunset light already tints it)
        dustLin.set(p.dustColor); dustLin.lerp(tmp.setScalar((dustLin.r + dustLin.g + dustLin.b) / 3), 0.3).multiplyScalar(1.6);
      }
    }
    // funnel radius (before size) at normalised height: narrow foot, flared top (FUNNEL_GLSL's wall)
    const rAt = (hn) => 0.4 + 1.5 * Math.pow(hn, 1.8);
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

    function releaseAll(st) {
      for (let i = 0; i < NH; i++) { st.helix[i]?.release(); st.helix[i] = null; }
      for (let i = 0; i < NS; i++) { st.swirl[i]?.release(); st.swirl[i] = null; }
      for (let i = 0; i < NB; i++) { st.blades[i]?.release(); st.blades[i] = null; }
      st.blade?.release(); st.blade = null;
      st.vortex?.release(); st.vortex = null;
      st.gather?.release(); st.gather = null;
      st.light?.release(); st.light = null;
      if (st.vol) { st.vol.visible = false; st.vol.userData.owner = null; st.vol = null; }
    }
    function acquireVol(st) {
      for (const v of vols) if (!v.userData.owner) { v.userData.owner = st; return v; }
      return null;
    }

    // --- funnel: frame and look from the cast state ---
    // cloud 0..1 (debris cloud), reveal (column height fraction), rope 0..1 (dying), dens (density scale)
    function placeVolume(st, p, cloud, reveal, rope, dens) {
      const v = st.vol;
      if (!v) return;
      const sz = p.size, H = 7 * sz, b = st.base, L = st.lean, u = v.material.uniforms;
      const sway = 0.35 * sz;
      u.uTw0.value.set(b.x, b.z, H, st.spin / TAU);
      u.uTw1.value.set(L.x, L.z, sz, st.rise);
      u.uTw2.value.set(st.seedF * 7, 3.6 * dens * p.dust, sway, st.age);
      u.uTw3.value.set(cloud, reveal, 1, rope);
      // box round the leaning column, its crown and its foot
      const half = Math.max(rAt(1) * 1.5 + 0.2, 2.0 * 1.4) * sz + sway * 2;
      const hx = half + Math.abs(L.x) * 0.5, hz = half + Math.abs(L.z) * 0.5, cx = b.x + L.x * 0.5, cz = b.z + L.z * 0.5, top = H * 1.15;
      u.uBoxMin.value.set(cx - hx, 0, cz - hz); u.uBoxMax.value.set(cx + hx, top, cz + hz);
      v.position.set(cx, top * 0.5, cz); v.scale.set(hx, top * 0.5, hz);
      // samples from its size on screen (fx pixels), tier-scaled; ~half fall within one wall radius
      const dist = Math.max(_a.set(cx, top * 0.4, cz).distanceTo(fx.camera.position), 1);
      const px = 1.2 * sz * 0.5 * fx.U.uFxResolution.value.y * fx.camera.projectionMatrix.elements[5] / dist;
      const cap = Math.max(8, Math.min(48, Math.round(32 * fx.Q.volumeSteps / 24 * fx.Q.auto.steps)));
      u.uMarch.value.set(Math.min(cap, Math.max(12, Math.ceil(px / 3))), 0.8 * sz, 0.35, 1.3 * sz);
      v.visible = dens > 1e-3;
    }

    // --- charge: air gathers into the focus; dust starts to whirl where the funnel will touch down ---
    function charge(c, st, p, dt) {
      const k = Math.min(1, c.t / c.durations.charge), f = c.from, slash = c.form !== 'Cyclone';
      E.gather.pos.copy(f); E.gather.radius = slash ? 1.4 : 1.9;
      E.gather.rate((slash ? 700 : 260) * p.streaks * (0.3 + 0.7 * k), dt);
      if (!slash) { E.motes.pos.set(f.x, 0.1, f.z); E.motes.vel.set(0, 1.7, 0); E.motes.rate(250 / c.durations.charge, dt); }
      E.focusHaze.pos.copy(f); E.focusHaze.size = 0.55; E.focusHaze.rate(12 * p.refraction * k, dt);
      const G = st.gather;
      if (G) {
        if (slash) { G.pos.set(f.x, 0, f.z); G.p[0] = 0.6; G.p[1] = 4 + 8 * k; G.p[2] = 2.5; G.p[3] = 1; G.w = 3.5; }
        else { G.pos.copy(st.start); G.p[0] = 0.8 * p.size; G.p[1] = (6 + 16 * k) * p.size; G.p[2] = 1.5 * k; G.p[3] = 1.2 * k; G.w = 2; }
      }
      for (let i = 0; i < NS; i++) {
        const r = st.swirl[i];
        if (!r) continue;
        r.p0.set(f.x, f.y, f.z, 2);
        r.p1.set(1.1 - 0.3 * k, 0.12, 1.25, 0.35);
        r.p2.set(i * TAU / NS - st.age * 5, 0, 0, 0.14);
        r.p3.set(i * 0.37 + st.seedF, 0.25 + 1.0 * k, 0.05 * k * p.refraction, 0.06);
        r.color.copy(air); r.intensity = 0.5 * k * p.streaks;
      }
      if (st.light) { st.light.pos.copy(f); st.light.intensity = 3 * k; }
      if (slash) { blades(c, st, p, f, 0.25 + 0.75 * k, k); return; }
      // the touchdown point: a ground whirl spinning up (dust drawn in and round, a low swirl of the volume)
      E.stir.pos.set(st.start.x, 0.12, st.start.z); E.stir.radius = 1.8 * p.size; E.stir.size = 0.8 * p.size;
      E.stir.rate(70 * p.dust * k, dt);
      st.spin += dt * 3.4 * p.strength * k; st.rise += dt * 1.5 * k;
      st.base.copy(st.start); st.lean.set(0, 0, 0);
      placeVolume(st, p, 0.35 * k * k, 0.06 * k, 0.5 * (1 - k), 0.6 * k);
    }

    // --- cyclone ---
    function placeCyclone(c, st, p, dt) {
      const b = st.base;
      st.prev.copy(b);
      b.lerpVectors(st.start, st.end, st.s);
      const w = Math.sin(Math.PI * st.s) * 0.7 * p.size * Math.sin(st.age * 1.6 + st.seedF * 6);
      b.addScaledVector(st.Sd, w);
      if (c.phase !== 'travel') {   // parked over the target: a slow wobble
        const m = smooth(0, 1, c.phase === 'linger' ? c.t + c.durations.impact : c.t);
        b.x += Math.sin(st.age * 0.8 + st.seedF * 5) * 0.4 * p.size * m;
        b.z += Math.cos(st.age * 0.65 + st.seedF * 3) * 0.4 * p.size * m;
      }
      b.y = 0;
      if (dt > 0) st.vel.lerp(_a.subVectors(b, st.prev).divideScalar(dt), 1 - Math.exp(-dt * 4));
      c.pos.copy(b);
    }

    const scour = { x: 0, z: 0, x2: 0, z2: 0, radius: 0.1, width: 0.05, char: 0.2, pattern: 'line', seed: 0 };
    const stain = { x: 0, z: 0, radius: 1.5, char: 0.05, pattern: 'noise', seed: 0 };
    function cyclone(c, st, p, dt) {
      const sz = p.size, e = st.env, b = st.base, H = 7 * sz;
      const V = st.vortex;
      if (V) {
        V.pos.copy(b); V.dir.copy(_up);
        V.p[0] = 1.1 * sz; V.p[1] = 32 * p.strength * sz * e; V.p[2] = 6.5 * p.strength * e; V.p[3] = 0.9 * p.strength * e;
        V.w = H * 1.1;
      }
      // the wall turns and the dust climbs; spun up at touchdown, wound down as it dies
      st.spin += dt * 3.4 * p.strength * (0.3 + 0.7 * e);
      st.rise += dt * 3.6 * p.strength * (0.3 + 0.7 * e);
      // the top lags its motion and sways
      st.lean.set(-st.vel.x * 0.35 + Math.sin(st.age * 0.9 + st.seedF * 4) * 0.5 * sz, 0, -st.vel.z * 0.35 + Math.cos(st.age * 0.7 + st.seedF * 2) * 0.5 * sz);
      const grow = smooth(0, 0.7, st.age), dying = c.phase === 'linger' ? smooth(c.durations.linger - 2.2, c.durations.linger, c.t) : 0;
      placeVolume(st, p, (0.35 + 0.65 * smooth(0, 0.45, st.age)) * (1 - dying * dying), 0.06 + 1.1 * grow, dying, Math.max(0.6, grow) * (1 - dying * 0.85));
      // refraction sheets: the helix ribbons, distortion only
      const reveal = 1.15 * smooth(0, 0.9, st.age), unwind = 1 + (1 - e) * 0.9, omega = 3 * p.strength;
      for (let i = 0; i < NH; i++) {
        const o = i * 5, hp = st.hp, h = st.helix[i];
        if (!h) continue;
        h.p0.set(b.x, 0.02, b.z, 0);
        h.p1.set(hp[o + 3] * sz * (0.7 + 0.3 * e), hp[o + 1] * sz, hp[o + 2] * sz * unwind, -hp[o]);
        h.p2.set(hp[o + 4] - st.age * omega * (0.8 + 0.25 * hp[o]), st.lean.x, st.lean.z, 0.45 * sz);
        h.p3.set(hp[o + 4] / TAU, reveal, 0.14 * p.refraction * e, 0);
        h.color.copy(air); h.intensity = 1e-4;
      }
      // what the wind carries
      const lean = st.lean, k = e * grow;
      for (let j = 0; j < 2; j++) {
        const hn = j === 0 ? fx.rand() * 0.25 : fx.rand() * 0.8;
        E.dust.pos.set(b.x + lean.x * hn * hn, hn * H, b.z + lean.z * hn * hn);
        E.dust.radius = rAt(hn) * sz * (0.8 + 0.4 * fx.rand());
        E.dust.vel.set(0, 1.2, 0); E.dust.size = sz * (0.8 + 0.6 * hn);
        E.dust.rate(150 * p.dust * k, dt);
      }
      // floor dust drawn in along the ground from all round
      E.inflow.pos.set(b.x, 0.1, b.z); E.inflow.radius = 3.6 * sz; E.inflow.size = 0.9 * sz;
      E.inflow.rate(90 * p.dust * k, dt);
      let hn = 0.1 + 0.8 * fx.rand();
      E.haze.pos.set(b.x + lean.x * hn * hn, hn * H, b.z + lean.z * hn * hn);
      E.haze.radius = rAt(hn) * sz * 1.05; E.haze.size = sz; E.haze.vel.set(0, 1, 0);
      E.haze.rate(45 * p.refraction * e, dt);
      E.skirt.pos.set(b.x, 0.15, b.z); E.skirt.radius = 2 * sz; E.skirt.size = sz;
      E.skirt.rate(150 * p.dust * k, dt);   // fill-bound: count x area is most of the particles' fx cost
      // the load: leaves, gravel and rubble lifted round the foot, flung out higher up
      E.leaf.pos.set(b.x, 0.3, b.z); E.leaf.radius = 1.6 * sz; E.leaf.vel.set(0, 3.5, 0);
      E.leaf.rate(40 * p.debris * k, dt);
      E.pebble.pos.set(b.x, 0.2, b.z); E.pebble.radius = 0.9 * sz; E.pebble.vel.set(0, 5, 0); E.pebble.size = 0.7 + 0.8 * fx.rand();
      E.pebble.rate(40 * p.debris * k, dt);
      E.grit.pos.set(b.x, 0.1, b.z); E.grit.radius = 1.3 * sz; E.grit.vel.set(0, 3, 0); E.grit.size = 0.3;
      E.grit.rate(110 * p.debris * k, dt);
      st.flingT -= dt;
      if (st.flingT <= 0 && k > 0.2) {
        // rubble ripped off the floor in clumps: varied sizes, thrown out of the debris cloud
        st.flingT = 0.12 + 0.2 * fx.rand();
        E.chunk.pos.set(b.x, 0.25, b.z); E.chunk.radius = 1.2 * sz;
        E.chunk.vel.set(0, 4 + 3 * fx.rand(), 0);
        E.chunk.size = 0.6 + 1.8 * fx.rand() * fx.rand();
        E.chunk.burst(Math.round((2 + 3 * fx.rand()) * p.debris * k));
      }
      // the floor is scoured: two points on the debris ring trace cycloids as the funnel walks
      st.scourT -= dt;
      if (st.scourT <= 0) {
        st.scourT = 0.05;
        const on = k > 0.3 && p.dust > 0;
        for (let i = 0; i < 2 && on; i++) {
          const ang = -st.spin + i * Math.PI + st.seedF * TAU, rr = (1.0 + 0.25 * i) * sz;
          const x = b.x + Math.cos(ang) * rr, z = b.z + Math.sin(ang) * rr;
          if (st.scourOn) {
            scour.x = st.sx[i]; scour.z = st.sz[i]; scour.x2 = x; scour.z2 = z;
            scour.width = (0.05 + 0.04 * i) * sz; scour.char = 0.16 * Math.min(p.dust, 1.5) * k; scour.seed = (c.seed + st.age * 37) % 100;
            fx.ground.splat(scour);
          }
          st.sx[i] = x; st.sz[i] = z;
        }
        st.scourOn = on;
      }
      st.stainT -= dt;
      if (st.stainT <= 0 && k > 0.3) {
        st.stainT = 0.35;
        stain.x = b.x; stain.z = b.z; stain.radius = 1.7 * sz; stain.char = 0.035 * Math.min(p.dust, 1.5); stain.seed = (c.seed + st.age * 11) % 100;
        fx.ground.splat(stain);
      }
      // dummies in reach get buffeted round the funnel
      st.hitT -= dt;
      if (st.hitT <= 0) {
        st.hitT = 0.25;
        for (const dm of fx.dummies) {
          const dx = dm.pos.x - b.x, dz = dm.pos.z - b.z, d = Math.hypot(dx, dz);
          if (d < 2.5 * sz) dm.hit(_b.set(dz, 0, -dx), 0.35 * e * p.strength * (1 - d / (2.5 * sz)));
        }
      }
      // the pool's ripple sim swirls when the funnel is over or near it
      const pool = fx.ARENA.pool;
      const qx = Math.max(Math.abs(b.x - pool.center.x) - pool.half.x, 0), qz = Math.max(Math.abs(b.z - pool.center.y) - pool.half.y, 0);
      const pd = Math.hypot(qx, qz), reach = 3 * sz;
      if (pd < reach && fx.pool) {
        const cx = Math.min(Math.max(b.x, pool.center.x - pool.half.x), pool.center.x + pool.half.x);
        const cz = Math.min(Math.max(b.z, pool.center.y - pool.half.y), pool.center.y + pool.half.y);
        fx.pool.swirl(cx, cz, 3 * e * p.strength * (1 - pd / reach));
      }
    }

    // --- wind slash ---
    // crescent frame at centre m with scale k (0..1 while forming); tip = lower tip, top = upper tip
    function frame(st, p, m, k) {
      const R = 1.2 * p.slashSize * k, A = 1.2;
      st.tip.copy(m).addScaledVector(st.F, R * (Math.cos(A) - 1));
      st.top.copy(st.tip).addScaledVector(st.T, R * Math.sin(A));
      st.tip.addScaledVector(st.T, -R * Math.sin(A));
      return R;
    }
    // the blade itself is air: a lens edge with a faint vapour sheet, and a thin glint at full res
    function blades(c, st, p, m, k, glow) {
      const R = frame(st, p, m, k), sp = p.slashSpeed / 24;
      for (let i = 0; i < NB; i++) {
        const r = st.blades[i];
        if (!r) continue;
        const back = c.phase === 'travel' ? i * 0.3 * sp : i * 0.12;
        r.p0.set(m.x - st.F.x * back, m.y - st.F.y * back, m.z - st.F.z * back, 1);
        r.p1.set(st.F.x, st.F.y, st.F.z, R * (1 + 0.08 * i));
        r.p2.set(st.T.x, st.T.y, st.T.z, 0.5 * p.slashSize * (1 + 0.6 * i) * k);
        r.p3.set(st.seedF + i * 0.3, 1.2, 0.3 * p.refraction * (1 - 0.25 * i) * glow, 0.07 * Math.pow(0.5, i) * glow);
        r.color.copy(air); r.intensity = 0.1 * glow * Math.pow(0.45, i) * p.streaks;
      }
      const q = st.blade;
      if (q) {
        q.p0.set(m.x, m.y, m.z, 1);
        q.p1.set(st.F.x, st.F.y, st.F.z, R);
        q.p2.set(st.T.x, st.T.y, st.T.z, 0.03 * p.slashSize * k);
        q.p3.set(st.seedF, 1.2, 0, 0);
        q.color.copy(air); q.intensity = 0.7 * glow * p.streaks;
      }
    }
    const scratch = { x: 0, z: 0, x2: 0, z2: 0, radius: 0.1, width: 0.1, crack: 1, char: 0, pattern: 'line', seed: 0 };
    const scuff = { x: 0, z: 0, x2: 0, z2: 0, radius: 0.1, width: 0.4, char: 0.12, pattern: 'line', seed: 0 };
    function scratchTo(st, p, c) {
      scratch.x = scuff.x = st.lastTip.x; scratch.z = scuff.z = st.lastTip.z; scratch.x2 = scuff.x2 = st.tip.x; scratch.z2 = scuff.z2 = st.tip.z;
      scratch.width = 0.07 * p.slashSize; scratch.crack = 1.6 * p.scratch; scratch.char = 0.65 * p.scratch;
      scratch.seed = scuff.seed = (c.seed + st.travelled * 13) % 100;
      fx.ground.splat(scratch);
      // the dust it ploughed aside, either side of the cut
      scuff.width = 0.4 * p.slashSize; scuff.char = 0.1 * p.scratch;
      fx.ground.splat(scuff);
      st.lastTip.copy(st.tip);
    }
    function slashFly(c, st, p, dt) {
      const sp = p.slashSpeed;
      frame(st, p, c.pos, 1);
      // the shear line: floor dust dragged up the blade's lower half and left hanging in its wake
      E.sheet.vel.copy(st.F).multiplyScalar(sp * 0.35).setY(0.6);
      E.sheet.pos.copy(st.tip); E.sheet.p.lerpVectors(st.tip, c.pos, 0.8); E.sheet.size = p.slashSize;
      E.sheet.rate(260 * p.dust, dt);
      E.sheet.pos.copy(c.pos); E.sheet.p.copy(st.top); E.sheet.size = 0.6 * p.slashSize;
      E.sheet.rate(50 * p.dust, dt);
      // shimmer left along the whole edge
      E.wake.vel.copy(st.F).multiplyScalar(sp * 0.15);
      E.wake.pos.copy(st.tip); E.wake.p.copy(st.top); E.wake.size = 0.45 * p.slashSize;
      E.wake.rate(70 * p.refraction, dt);
      if (st.tip.y < 0.2) {
        // the lower tip scores the floor: a rooster tail of dust and chips, a cut in the crack channel
        E.tail.pos.copy(st.tip).setY(0.06);
        E.tail.vel.copy(st.F).multiplyScalar(sp * 0.12).addScaledVector(st.Sd, -1.6 * st.sign).setY(2.2);
        E.tail.size = 0.9 * p.slashSize; E.tail.rate(220 * p.dust, dt);
        E.kick.pos.copy(st.tip).setY(0.08);
        E.kick.vel.copy(st.F).multiplyScalar(sp * 0.05).addScaledVector(st.Sd, 1.4 * st.sign).setY(0.8);
        E.kick.size = p.slashSize; E.kick.rate(140 * p.dust, dt);
        E.chip.pos.copy(E.tail.pos); E.chip.vel.copy(st.F).multiplyScalar(sp * 0.2).setY(3.6);
        E.chip.size = 0.5 + fx.rand(); E.chip.rate(70 * p.debris, dt);
        if (!st.scratching) { st.scratching = true; st.lastTip.copy(st.tip); }
        else if (st.lastTip.distanceToSquared(st.tip) > 0.49) scratchTo(st, p, c);
      }
      // shear through dummies
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i];
        if (st.mask & (1 << i)) continue;
        if (Math.hypot(dm.pos.x - c.pos.x, dm.pos.z - c.pos.z) < 0.7) {
          st.mask |= 1 << i;
          dm.hit(st.F, 1.2 * p.slashSize);
          E.tail.pos.copy(dm.pos).setY(0.7); E.tail.vel.copy(st.F).multiplyScalar(4); E.tail.size = p.slashSize; E.tail.burst(50 * p.dust);
          E.chip.pos.copy(dm.pos).setY(0.8); E.chip.vel.copy(st.F).multiplyScalar(6).setY(2); E.chip.size = 0.8; E.chip.burst(18 * p.debris);
          E.burst.pos.copy(dm.pos).setY(c.pos.y); E.burst.vel.copy(st.F).multiplyScalar(5); E.burst.burst(30 * p.streaks);
          fx.shocks?.spawn({ pos: _a.copy(dm.pos).setY(0.9), radius0: 0.1, radius1: 1.6 * p.slashSize, duration: 0.3, thickness: 0.4, distortion: 0.06 * p.refraction, intensity: 0 });
          fx.rig.shake(0.2, 14);
          if (!fx.reduced) fx.rig.hitstop(0.03);
        }
      }
    }

    return {
      onParam(k) { if (k === 'air' || k === 'dustColor') applyColors(S.params); },
      tick() { ribs.update(); cores.update(); },

      phase(c, name) {
        const p = S.params, st = state[c.index];
        applyColors(p);
        if (name === 'charge') {
          releaseAll(st);
          const slash = c.form !== 'Cyclone';
          c.durations.charge = slash ? 0.35 : 0.9;
          c.durations.impact = slash ? 0.15 : 0.3;
          c.durations.linger = slash ? 1.0 : p.duration;
          c.durations.travel = 8;
          st.age = 0; st.env = 0; st.s = 0; st.mask = 0; st.hitT = 0; st.travelled = 0; st.scratching = false;
          st.spin = 0; st.rise = 0; st.scourT = 0; st.scourOn = false; st.stainT = 0; st.flingT = 0;
          st.seedF = (c.seed % 997) / 997; st.sign = c.seed & 1 ? 1 : -1;
          st.F.set(c.to.x - c.from.x, 0, c.to.z - c.from.z);
          st.dist = st.F.length();
          if (st.dist < 1e-3) st.F.set(0, 0, -1); else st.F.divideScalar(st.dist);
          st.Sd.crossVectors(st.F, _up).normalize();
          const tl = THREE.MathUtils.degToRad(p.tilt);
          st.T.copy(_up).multiplyScalar(Math.cos(tl)).addScaledVector(st.Sd, Math.sin(tl) * st.sign);
          st.gather = fx.forces.acquire();
          if (st.gather) { st.gather.type = 1; st.gather.dir.copy(_up); }
          for (let i = 0; i < NS; i++) st.swirl[i] = ribs.acquire();
          if (slash) { for (let i = 0; i < NB; i++) st.blades[i] = ribs.acquire(); st.blade = cores.acquire(); }
          else {
            // where the funnel will touch down: a little in front of the caster
            const lead = Math.min(2, st.dist * 0.3);
            st.start.set(c.from.x + st.F.x * lead, 0, c.from.z + st.F.z * lead);
            st.end.set(c.to.x, 0, c.to.z);
            st.base.copy(st.start);
            st.vol = acquireVol(st);
          }
          st.light = fx.lights.acquire();
          if (st.light) { st.light.range = slash ? 6 : 5; st.light.intensity = 0; st.light.color.copy(air); }
        } else if (name === 'release') {
          st.gather?.release(); st.gather = null;
          for (let i = 0; i < NS; i++) { st.swirl[i]?.release(); st.swirl[i] = null; }
          st.age = 0;
          fx.rig.shake(0.12, 9);
          if (c.form === 'Cyclone') {
            st.light?.release(); st.light = null;
            st.dist = st.start.distanceTo(st.end);
            st.base.copy(st.start); st.prev.copy(st.start); st.vel.set(0, 0, 0);
            c.pos.copy(st.start);
            st.vortex = fx.forces.acquire();
            if (st.vortex) st.vortex.type = 1;
            for (let i = 0; i < NH; i++) {
              const o = i * 5;
              st.hp[o] = 2.6 + 1.0 * fx.rand();                 // turns
              st.hp[o + 1] = 0.35 + 0.25 * fx.rand();           // foot radius
              st.hp[o + 2] = 1.9 + 0.9 * fx.rand();             // top radius
              st.hp[o + 3] = 5.5 + 2.0 * fx.rand();             // height
              st.hp[o + 4] = (i + 0.3 * fx.rand()) * TAU / NH;  // angle
              st.helix[i] = ribs.acquire();
            }
            // touchdown: the debris cloud erupts off the floor
            E.skirt.pos.set(st.start.x, 0.15, st.start.z); E.skirt.radius = 1.4 * p.size; E.skirt.size = p.size; E.skirt.burst(140 * p.dust);
            E.chunk.pos.set(st.start.x, 0.2, st.start.z); E.chunk.radius = 0.8 * p.size; E.chunk.vel.set(0, 5, 0); E.chunk.size = 1; E.chunk.burst(10 * p.debris);
            E.grit.pos.set(st.start.x, 0.1, st.start.z); E.grit.vel.set(0, 4, 0); E.grit.size = 0.35; E.grit.burst(60 * p.debris);
            fx.shocks?.spawn({ pos: _a.set(st.start.x, 0.05, st.start.z), radius0: 0.3, radius1: 4.5 * p.size, duration: 0.6, thickness: 0.6, distortion: 0.05 * p.refraction, ground: true, intensity: 0 });
          } else {
            c.pos.copy(c.from);
            st.cy = 1.2 * p.slashSize * Math.sin(1.2) * Math.cos(THREE.MathUtils.degToRad(p.tilt)) - 0.06;
            st.range = st.dist + 6;
            // the throw: a pressure pulse off the caster, floor dust blown ahead
            E.kick.pos.set(c.from.x, 0.1, c.from.z); E.kick.vel.copy(st.F).multiplyScalar(6).setY(0.6); E.kick.size = 1.2; E.kick.burst(50 * p.dust);
            E.burst.pos.copy(c.from); E.burst.vel.copy(st.F).multiplyScalar(9); E.burst.burst(30 * p.streaks);
            fx.shocks?.spawn({ pos: c.from, radius0: 0.2, radius1: 2.2, duration: 0.3, thickness: 0.5, distortion: 0.05 * p.refraction, intensity: 0 });
            if (!fx.reduced) fx.rig.punch(1.5, 0.08);
          }
        } else if (name === 'impact') {
          st.tImpact = 0;
          if (c.form === 'Cyclone') {
            const b = st.base;
            E.skirt.pos.set(b.x, 0.15, b.z); E.skirt.radius = 1.8 * p.size; E.skirt.size = p.size; E.skirt.burst(160 * p.dust);
            E.pebble.pos.set(b.x, 0.05, b.z); E.pebble.size = 1; E.pebble.burst(24 * p.debris);
            fx.shocks?.spawn({ pos: _a.set(b.x, 0.05, b.z), radius0: 0.5, radius1: 5.5 * p.size, duration: 0.7, thickness: 0.7, distortion: 0.05 * p.refraction, ground: true, intensity: 0 });
            fx.rig.shake(0.25, 7);
          } else {
            frame(st, p, c.pos, 1);
            if (st.scratching) scratchTo(st, p, c);
            // the blade bursts: the air it carried slams on, dust blooms
            E.tail.pos.copy(c.pos); E.tail.vel.copy(st.F).multiplyScalar(5); E.tail.size = 1.3 * p.slashSize; E.tail.burst(90 * p.dust);
            E.kick.pos.copy(st.tip).setY(0.2); E.kick.vel.set(0, 1, 0); E.kick.burst(50 * p.dust);
            E.burst.pos.copy(c.pos); E.burst.vel.copy(st.F).multiplyScalar(4); E.burst.burst(50 * p.streaks);
            fx.shocks?.spawn({ pos: c.pos, radius0: 0.2, radius1: 2.6 * p.slashSize, duration: 0.35, thickness: 0.5, distortion: 0.08 * p.refraction, intensity: 0 });
            fx.rig.shake(0.18, 12);
          }
        } else if (name === 'done') releaseAll(st);
      },

      // own integration for both forms: the funnel walks, the crescent skims the floor
      travel(c, dt) {
        const p = S.params, st = state[c.index];
        st.age += dt;
        if (c.form === 'Cyclone') {
          st.s = Math.min(1, st.s + p.drift * dt / Math.max(st.dist, 0.1));
          placeCyclone(c, st, p, dt);
          return st.s >= 1 || c.t > c.durations.travel;
        }
        const step = p.slashSpeed * dt;
        c.vel.copy(st.F).multiplyScalar(p.slashSpeed);
        c.pos.addScaledVector(st.F, step);
        c.pos.y += (st.cy - c.pos.y) * (1 - Math.exp(-dt * 14));
        st.travelled += step;
        const R = Math.hypot(c.pos.x, c.pos.z);
        let hit = R > fx.ARENA.radius - 0.8;
        for (const pl of fx.ARENA.pillars) if (Math.hypot(pl.x - c.pos.x, pl.z - c.pos.z) < fx.ARENA.pillarRadius + 0.5) hit = true;
        return hit || st.travelled >= st.range || c.t > c.durations.travel;
      },

      update(c, dt) {
        const p = S.params, st = state[c.index];
        if (c.phase === 'charge') { st.age += dt; charge(c, st, p, dt); return; }
        if (c.form === 'Cyclone') {
          if (c.phase !== 'travel') { st.age += dt; placeCyclone(c, st, p, dt); }
          st.env = c.phase === 'linger' ? 1 - smooth(c.durations.linger - 1.3, c.durations.linger, c.t) : smooth(0, 0.8, st.age);
          cyclone(c, st, p, dt);
          return;
        }
        if (c.phase === 'travel') {
          blades(c, st, p, c.pos, 1, 1);
          slashFly(c, st, p, dt);
          if (st.light) { st.light.pos.copy(c.pos); st.light.intensity = 0.8; }
        } else {
          // the blade overshoots, spreads and thins out
          st.tImpact += dt;
          const t = st.tImpact;
          c.pos.addScaledVector(st.F, p.slashSpeed * Math.exp(-t * 7) * dt);
          blades(c, st, p, c.pos, 1 + 1.4 * t, Math.exp(-t * 5));
          if (st.light) { st.light.pos.copy(c.pos); st.light.intensity = 0.8 * Math.exp(-t * 6); }
        }
      },
    };
  },
};
