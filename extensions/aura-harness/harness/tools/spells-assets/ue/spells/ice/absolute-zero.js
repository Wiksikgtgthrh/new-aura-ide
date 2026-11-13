import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { U, COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL } from '../../vfx/common.js';
import { REFRACT_GLSL } from '../../vfx/Refraction.js';

// Absolute Zero (ice hero). Cold motes pour into the caster's orb while a bell of freezing fog
// condenses high over the target, hangs, then drops onto the floor (reference: ice fog rolling in,
// diamond dust in low sun, the cold mist that spills off liquid nitrogen). The bell is a short
// refract-pass march through a noise density, never a surface: thickest and whitest at the base,
// near clear at the crown, its outline eroded and drifting so it breathes and tears, and once down
// a skirt of it rolls out along the floor. Inside, the world drains to a cold monochrome by how much
// frozen air the view ray crosses, time thickens (a damping force: every spell's particles hang),
// diamond dust twinkles, frost crawls in from the rim and out from the centre as fern fingers and
// the dummies ice over. Then the fog churns, flips briefly to a photo-negative and bursts: a blast
// of fog and ice shards, glints, a nova shock, a frost front thrown outward, hitstop. The field
// thaws the frost into puddles afterwards. (The lens param no longer does anything: fog doesn't
// refract.)

const DOME_VERT = /* glsl */`
out vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const DOME_FRAG = COMMON_GLSL + NOISE_GLSL + WORLD_GLSL + LIGHTS_GLSL + REFRACT_GLSL + /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec4 uDome;    // centre xz on the floor, y = base height; w = radius
uniform vec4 uDomeA;   // grade 0..1, roll-out along the floor 0..1, agitation 0..1 (before it bursts), fog amount 0..1
uniform vec4 uDomeB;   // desaturate, negative 0..1, -, seed
uniform vec4 uDomeC;   // haze, glints, -, march steps
uniform vec3 uTint;    // cold grade (linear)
uniform vec3 uGlow;    // the bell's cold light (linear HDR)
in vec3 vWorld;
out vec4 fragColor;

const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
const vec3 BOX = vec3(1.75, 1.2, 1.75);   // the proxy's extent in bell radii: nothing below reaches past it

// Freezing fog in bell space (q = (p - C) / R): thickest and whitest at the base, thinning to almost
// clear at the crown; the outline is a drifting fbm radius eroded by worley octaves, so it breathes
// and tears instead of ending on a sphere; once down, a skirt rolls out along the floor.
float fogD(vec3 q, vec3 drift) {
  vec4 n = textureLod(uNoise3D, q * 0.55 + drift, 0.0);   // explicit LOD: sampled in a varying-length loop
  float wf = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float h = max(q.y, 0.0), r = length(q);
  float edge = 0.84 + (n.r - 0.5) * 0.4;
  float bell = smoothstep(edge + 0.14, edge - 0.3, r) * mix(1.0, 0.07, smoothstep(0.0, 0.9, h));
  float skirt = exp(-h * 7.0) * smoothstep(1.0 + 0.6 * uDomeA.y, 0.8, length(q.xz) + (n.r - 0.5) * 0.6) * uDomeA.y;
  float d = max(bell, skirt);
  return clamp((d - (1.0 - wf) * 0.5 * (1.0 - 0.6 * d)) * 1.6, 0.0, 1.0);
}

void main() {
  vec3 C = uDome.xyz;
  float R = uDome.w;
  vec3 ro = cameraPosition, rd = normalize(vWorld - ro);
  // ray / the proxy's half ellipsoid (unit sphere in BOX-scaled bell space), above the base plane
  vec3 o = (ro - C) / (BOX * R), dv = rd / (BOX * R);
  float a = dot(dv, dv), b = dot(o, dv), h = b * b - a * (dot(o, o) - 1.0);
  if (h <= 0.0) discard;
  h = sqrt(h);
  float t0 = (-b - h) / a, t1 = (-b + h) / a;
  float tp = (C.y - ro.y) / (abs(rd.y) > 1e-6 ? rd.y : 1e-6);
  if (rd.y > 0.0) t0 = max(t0, tp); else t1 = min(t1, tp);
  float cosV = dot(rd, -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float tScene = linearDepth(texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r) / cosV;
  // tighten to where fog can be (fewer, denser samples: less dither): the hull of the bell's
  // sphere (r < 1.2) and the skirt's slab (0 < h < 0.5)
  vec3 oq = (ro - C) / R;
  float bq = dot(oq, rd), hq = bq * bq - dot(oq, oq) + 1.44, sA = 1e9, sB = -1e9;
  if (hq > 0.0) { hq = sqrt(hq); sA = (-bq - hq) * R; sB = (-bq + hq) * R; }
  float ty = (C.y + 0.5 * R - ro.y) / (abs(rd.y) > 1e-6 ? rd.y : 1e-6);
  float tIn = max(max(t0, 0.0), min(sA, min(tp, ty))), tOut = min(min(t1, tScene), max(sB, max(tp, ty)));
  if (tOut <= tIn) discard;

  // march (white-noise jitter: grain, where IGN's lattice showed as a hatch and moiréd when scaled):
  // optical depth for the grade, lit fog for the colour
  int N = int(uDomeC.w);
  float dt = (tOut - tIn) / float(N);
  float t = tIn + dt * hash33(vec3(gl_FragCoord.xy, 17.0)).x;
  vec3 drift = vec3(uDomeB.w, -uTime * 0.07, uTime * 0.03) + vec3(0.0, -uTime * 0.25, 0.0) * uDomeA.z;
  float sigma = 0.75 * uDomeC.x * uDomeA.w, T = 1.0, tau = 0.0, scat = 0.0, hS = 0.0, tM = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= N || T < 0.02) break;
    vec3 q = (ro + rd * t - C) / R;
    float s = fogD(q, drift) * sigma * dt;
    float A = T * (1.0 - exp(-s));
    scat += A; hS += A * clamp(q.y, 0.0, 1.0); tM += A * t;
    tau += s; T -= A;
    t += dt;
  }
  float wS = max(scat, 1e-4);
  vec3 Pm = ro + rd * (scat > 1e-4 ? tM / wS : 0.5 * (tIn + tOut));
  // light on the fog: sky, low sun (forward-scattered a little), the bell's own cold light; it
  // reads cold even at sunset, a touch darker down in the thick base
  gLightNoShadow = true;
  float mu = dot(rd, uSunDir), hg = 0.08 * (1.0 - 0.09) / pow(1.09 - 0.6 * mu, 1.5);
  vec3 irr = uAmbient * 1.15 + uSunColor * (0.18 + hg) + spellLightDiffuse(Pm, normalize(Pm - C + vec3(0.0, 1e-3, 0.0))) * 0.15;
  irr = mix(irr, vec3(dot(irr, LUM)) * vec3(0.86, 0.95, 1.1), 0.7) * (0.8 + 0.3 * hS / wS);
  vec3 fog = (vec3(0.84, 0.91, 0.97) * irr + uGlow * (0.03 + 0.35 * uDomeA.z * uDomeA.z)) * scat;

  // grade: cold monochrome (luminance kept) by how much frozen air the ray crossed, and a log-space
  // negative about the scene's mean level for the burst
  vec3 Spix = texelFetch(uSceneColor, ivec2(gl_FragCoord.xy), 0).rgb;
  float lum = dot(Spix, LUM);
  float Lm = max(dot(uAmbient + uSunColor * 0.25, LUM) * 0.35, 1e-4);
  float lneg = min(Lm * Lm / max(lum, Lm * 0.15), Lm * 6.0);
  vec3 mono = uTint * mix(lum, lneg, uDomeB.y) * 1.1;
  // (the clear-air part by the ray's closest approach to the centre: no edge at the march hull)
  float dmin = length(cross(oq, rd));
  float gd = uDomeA.x * (1.0 - exp(-tau * 1.5 - 0.5 * uDomeA.w * smoothstep(1.15, 0.3, dmin))) * max(uDomeB.x, uDomeB.y);

  // diamond dust: three nested layers of 4 cm cells, one facet in twelve catching the sun or the
  // bell's light and twinkling (view- and time-hashed), faded before a cell shrinks under a pixel
  vec3 dust = vec3(0.0);
  float pixA = length(fwidth(rd));   // pixel footprint per metre of depth (no derivatives inside the loop)
  for (int k = 0; k < 3; k++) {
    float rr = (0.3 + 0.27 * float(k)) * R;
    vec3 oc = ro - C - vec3(0.0, 0.15 * R, 0.0);
    float bb = dot(oc, rd), hh = bb * bb - dot(oc, oc) + rr * rr;
    if (hh <= 0.0) continue;
    float tk = -bb - sqrt(hh);
    if (tk < tIn || tk > tOut) tk = -bb + sqrt(hh);
    if (tk < tIn || tk > tOut) continue;
    vec3 P = ro + rd * tk, gq = (P - C) * 25.0 + float(k) * 7.31 + uDomeB.w;
    vec3 gh = hash33(floor(gq));
    vec3 nf = normalize(gh * 2.0 - 1.0);
    float spec = pow(max(dot(nf, normalize(uSunDir - rd)), 0.0), 300.0);
    float tw = pow(0.5 + 0.5 * sin(uTime * (4.0 + 6.0 * gh.z) + gh.y * 60.0), 8.0);
    float spot = smoothstep(0.3, 0.0, length(fract(gq) - 0.5 - (gh - 0.5) * 0.4));
    float fade = smoothstep(1.2, 0.4, 25.0 * tk * pixA);
    dust += step(0.92, gh.x) * spot * fade * (uSunColor * spec * 40.0 + (irr * 2.0 + uGlow * 0.5) * tw);
  }
  dust *= uDomeC.y * uDomeA.w * smoothstep(0.0, 0.15, uDomeA.x + uDomeA.w * 0.1);

  // out = add + dst * keep (destination: everything the refract pass drew so far gets the grade)
  float keep = T * (1.0 - gd);
  vec3 add = fog + T * mono * gd + dust * mix(1.0, T, 0.5);
  fragColor = vec4(add, keep);
}`;


// closed half-ellipsoid proxy (curved top + base disk) the size of the fog's reach (BOX in the shader);
// drawn back faces only, depth test off: every ray through the bell gets exactly one fragment
function domeGeometry() {
  const top = new THREE.SphereGeometry(1, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const base = new THREE.CircleGeometry(1, 40).rotateX(Math.PI / 2);
  const g = mergeGeometries([top, base]);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g.scale(1.75, 1.2, 1.75);
  return g;
}

const MAX_DOMES = 2;
const RINGS = [0.1, 0.36, 0.62, 0.88, 1.14, 1.4];   // shatter rings: elevation (rad) on the dome
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export default {
  id: 'absolute-zero', name: 'Absolute Zero', element: 'ice', order: 10, hue: '#9ff0ff',
  shape: 'area',
  params: {
    radius: 3.6, drop: 2.6, hold: 2.6, desaturate: 0.85, negative: 1, haze: 1, lens: 1,
    frost: 1, cracks: 1, shards: 1, dust: 1, mist: 1, glints: 1, tint: '#a9d8ff', glow: '#62d4ff',
  },
  ranges: {
    radius: [2, 6, 0.01], drop: [2, 10, 0.1], hold: [1, 5, 0.05], desaturate: [0, 1, 0.01], negative: [0, 1, 0.01],
    haze: [0, 3, 0.01], lens: [0, 3, 0.01], frost: [0, 2, 0.01], cracks: [0, 3, 0.01], shards: [0, 3, 0.01],
    dust: [0, 3, 0.01], mist: [0, 3, 0.01], glints: [0, 3, 0.01],
  },
  presets: {
    glacier: { tint: '#6fb4ff', glow: '#3f86ff', desaturate: 0.7, haze: 1.5 },
    whiteout: { tint: '#e6f4ff', glow: '#bfefff', desaturate: 1, haze: 2.4, mist: 2, dust: 2.2 },
    cryo: { tint: '#8ffff0', glow: '#2fffd8', cracks: 2.2, radius: 4.6, hold: 3.2 },
  },
  timing: { charge: 1.3, impact: 0.25, linger: 6 },
  kinds: {
    // diamond dust: tiny crystals that hang in the frozen air and sparkle
    dust: { style: 'glow', drag: 2.4, gravity: 0.1, curl: 0.35, curlScale: 0.35, forceResponse: 0.8, life: [1.6, 3], size: [0.013, 0.008], emissive: 7, color: ['#ffffff', '#a6e8ff'], alpha: [1, 0.5], fadeIn: 0.3, fadeOut: 0.35 },
    // the bell's fragments: pale lit ice, with a little of the shell's cyan still in them (debris: color[1]
    // is the emission, fading as (1 - t)^2; alpha[1] the roughness)
    pane: { style: 'debris', mesh: 'shard', drag: 0.3, gravity: 9.8, restitution: 0.3, friction: 0.55, life: [1.6, 3.2], size: [0.17, 0.08], sizePow: 1.5, spin: 11, color: ['#e2f6ff', '#2a7fa8'], alpha: [1, 0.05], fadeOut: 0.25 },
    // cold air: lit fog (the bell's cold light tints it), sinks and slides along the floor
    chill: { style: 'media', drag: 1.6, buoyancy: -0.8, curl: 0.5, curlScale: 0.25, restitution: 0, friction: 0.02, forceResponse: 0.5, life: [1.4, 2.6], size: [0.35, 1.2], sizePow: 0.6, color: ['#e4f2ff', '#bcd6ec'], alpha: [0.13, 0], density: 1.1, erosion: 0.6, lightResponse: 1.5, fadeIn: 0.2, fadeOut: 0.45 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const mote = P.emitter('ice.mote', { shape: 'shell', radius: 1.3, spread: 0.1, radial: -2.2 });
    const rimMist = P.emitter('absolute-zero.chill', { shape: 'ring', radius: 3, spread: 0.3 });
    const blastMist = P.emitter('absolute-zero.chill', { shape: 'ring', radius: 3, spread: 0.4, radial: 2.8 });
    const floorMist = P.emitter('absolute-zero.chill', { shape: 'disk', radius: 3, spread: 0.15 });
    const dust = P.emitter('absolute-zero.dust', { shape: 'sphere', radius: 2, spread: 0.12 });
    const glint = P.emitter('ice.glint', { shape: 'ring', radius: 3, spread: 2.5 });
    const pane = P.emitter('absolute-zero.pane', { shape: 'ring', radius: 3, spread: 2.5 });
    const chip = P.emitter('ice.chip', { shape: 'ring', radius: 3, spread: 2 });

    // --- look ---
    const tint = new THREE.Vector3(), glowV = new THREE.Vector3(), lightCol = new THREE.Color(), glowCol = new THREE.Color(), _c = new THREE.Color();
    function applyLook() {
      const p = S.params;
      _c.set(p.tint); tint.set(_c.r, _c.g, _c.b);
      glowCol.set(p.glow); glowV.set(glowCol.r, glowCol.g, glowCol.b).multiplyScalar(2.2);
      lightCol.copy(glowCol).lerp(_c.setRGB(1, 1, 1), 0.4);
    }
    applyLook();

    // --- domes: one program, per-mesh uniforms ---
    const geo = domeGeometry(), domes = [];
    for (let i = 0; i < MAX_DOMES; i++) {
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
        side: THREE.BackSide, depthTest: false, depthWrite: false,
        // out = src.rgb + dst * src.a; destination alpha kept (the reflection's 'drawn' mask)
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        uniforms: {
          ...U, uDome: { value: new THREE.Vector4() }, uDomeA: { value: new THREE.Vector4() }, uDomeB: { value: new THREE.Vector4() },
          uDomeC: { value: new THREE.Vector4() }, uTint: { value: tint }, uGlow: { value: glowV },
        },
      }));
      m.renderOrder = 10;    // after the spikes, ice shells and pool: it grades them too
      m.frustumCulled = false;
      m.visible = false;
      fx.scenes.refract.add(m);
      domes.push(m);
    }
    const takeDome = () => { for (const m of domes) if (!m.visible) { m.visible = true; return m; } return null; };

    const st = Array.from({ length: 16 }, () => ({
      dome: null, light: null, force: null, g: new THREE.Vector3(), a: 0, y: 0, R: 1, seed: 0,
      next: 0, shattered: false, sh: 0, fill: false, forceT: -1,
    }));
    const _a = new THREE.Vector3(), _d = new THREE.Vector3();
    const SPL = { x: 0, z: 0, radius: 1, frost: 0, pattern: 'radial', seed: 0, width: 0 };
    const SHK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 4, duration: 0.5, thickness: 0.5, distortion: 0.04, color: glowCol, intensity: 0, ground: false };
    function splat(x, z, radius, frost, pattern, seed, width = 0) {
      SPL.x = x; SPL.z = z; SPL.radius = radius; SPL.frost = frost; SPL.pattern = pattern; SPL.seed = seed % 100; SPL.width = width;
      fx.ground.splat(SPL);
    }
    function shock(x, y, z, r0, r1, dur, thick, dist, intensity, ground) {
      SHK.pos.set(x, y, z); SHK.radius0 = r0; SHK.radius1 = r1; SHK.duration = dur; SHK.thickness = thick;
      SHK.distortion = dist; SHK.intensity = intensity; SHK.ground = ground;
      fx.shocks.spawn(SHK);
    }
    function setDome(d, y, R, grade, rime, crack, shellA, neg) {
      const m = d.dome;
      if (!m) return;
      const p = S.params, u = m.material.uniforms;
      m.position.set(d.g.x, y, d.g.z); m.scale.setScalar(R);
      u.uDome.value.set(d.g.x, y, d.g.z, R);
      u.uDomeA.value.set(grade, rime, crack, shellA);
      u.uDomeB.value.set(p.desaturate, neg, p.lens, d.seed);
      u.uDomeC.value.set(p.haze, p.glints, 0, fx.Q.tier === 'low' ? 7 : 12);
    }
    // the pool's surface answers a slam or a blast whose ring reaches it
    function poolKick(g, R, amp) {
      const pool = fx.ARENA.pool;
      const cx = Math.min(Math.max(g.x, pool.center.x - pool.half.x), pool.center.x + pool.half.x);
      const cz = Math.min(Math.max(g.z, pool.center.y - pool.half.y), pool.center.y + pool.half.y);
      if (Math.hypot(cx - g.x, cz - g.z) < R + 1) fx.pool?.ripple(cx, cz, amp, 0.6);
    }

    return {
      onParam() { applyLook(); },

      phase(c, name) {
        const p = S.params, d = st[c.index];
        if (name === 'charge') {
          applyLook();
          d.g.set(c.to.x, 0, c.to.z);
          d.R = p.radius; d.a = 0; d.y = p.drop; d.next = 0; d.shattered = false; d.sh = 0; d.fill = false; d.forceT = -1;
          d.seed = (c.seed % 97) * 0.37;
          c.durations.linger = p.hold + 3.4;
          d.dome = takeDome();
          setDome(d, d.y, d.R * 0.75, 0, 0, 0, 0, 0);
          d.light = fx.lights.acquire();
          if (d.light) { d.light.range = 9; d.light.intensity = 0; d.light.color.copy(lightCol); d.light.shadow = true; }
          d.force = fx.forces.acquire();
          if (d.force) { d.force.type = 5; d.force.p[0] = 0; d.force.p[3] = 0; }
        } else if (name === 'release') {
          fx.rig.shake(0.08, 10);
        } else if (name === 'impact') {
          slam(c, p, d);
        } else if (name === 'done') {
          if (d.dome) d.dome.visible = false;
          d.dome = null;
          d.light?.release(); d.light = null;
          d.force?.release(); d.force = null;
        }
      },

      update(c, dt) {
        const p = S.params, d = st[c.index], g = d.g, R = d.R, L = d.light;
        if (c.phase === 'charge') {
          const t = c.t, T = c.durations.charge;
          // the orb drinks the warmth out of the air
          if (t < 0.75) { mote.pos.copy(c.from); mote.vel.set(0, 0, 0); mote.rate(1100 * p.dust * (1 - t / 0.75), dt); }
          // the bell condenses over the target (swelling out of a point), hangs, then falls
          // (ease-in: it slams)
          const form = smooth(0.05, 0.6, t), u = Math.min(1, Math.max(0, (t - 0.7) / (T - 0.7)));
          const sw = 1 - Math.pow(1 - form, 3);
          d.y = p.drop * (1 - Math.pow(u, 2.5));
          setDome(d, d.y, R * (0.25 + 0.75 * sw), 0.25 * form, 0, 0, form, 0);
          // cold air pours off the rim; dust glitters inside
          rimMist.pos.set(g.x, d.y + 0.1, g.z); rimMist.radius = R * 0.95 * sw; rimMist.vel.set(0, -1.5 - 4 * u, 0); rimMist.size = 0.8;
          rimMist.rate(120 * p.mist * form, dt);
          dust.pos.set(g.x, d.y + 0.45 * R, g.z); dust.radius = 0.6 * R * sw; dust.vel.set(0, -3 * u, 0); dust.rate(220 * p.dust * form, dt);
          // the landing zone: a ring of rime draws itself on the floor under the hanging bell
          if (t > 0.2 && t < 0.75 && t >= d.next) { d.next = t + 0.12; splat(g.x, g.z, R, 0.55 * smooth(0.2, 0.7, t) * p.frost, 'ring', c.seed + 3, 0.1 * R); }
          if (L) { L.pos.set(g.x, d.y + 0.3 * R, g.z); L.range = 12; L.intensity = 22 * form; }
          return;
        }
        // impact + linger: a = seconds since the slam
        d.a += dt;
        const a = d.a, hold = p.hold;
        if (!d.shattered) {
          const grade = smooth(0, 0.8 * hold, a) * 0.75 + 0.25, rime = smooth(0.1, hold, a);
          const crack = p.cracks > 0 ? Math.pow(smooth(hold - 0.75, hold, a), 1.5) : 0;
          const neg = p.negative * smooth(hold - 0.12, hold, a);
          setDome(d, 0, R, grade, rime, crack, 1, neg);
          // a second wash of frost once the fronts have met: nothing inside stays bare
          if (!d.fill && a > 0.5 * hold) { d.fill = true; splat(g.x, g.z, R * 0.95, 0.7 * p.frost, 'noise', c.seed + 11); }
          // diamond dust hangs in the bell, cold mist pools on the floor
          dust.pos.set(g.x, 0.45 * R, g.z); dust.radius = 0.55 * R; dust.vel.set(0, 0, 0); dust.rate(320 * p.dust, dt);
          floorMist.pos.set(g.x, 0.1, g.z); floorMist.radius = 0.85 * R; floorMist.vel.set(0, 0.05, 0); floorMist.rate(60 * p.mist, dt);
          // time thickens: a damping column (every responsive particle of every spell slows)
          const F = d.force;
          if (F && d.forceT < 0) {
            F.type = 5; F.pos.set(g.x, -0.3, g.z); F.dir.set(0, 1, 0);
            F.p[0] = 0; F.p[1] = R; F.p[2] = R + 0.6; F.p[3] = 2.5 * smooth(0.2, 0.8, a);
          }
          // the dummies ice over from the feet up while the bell holds
          for (const dm of fx.dummies) if (Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z) < R) dm.status.frozen = Math.max(dm.status.frozen, Math.min(1, 0.2 + a / hold));
          // creaks before it goes
          if (crack > 0.02 && c.t >= d.next) { d.next = c.t + 0.22; fx.rig.shake(0.06 + 0.12 * crack, 22); }
          if (L) { L.pos.set(g.x, 0.6 * R, g.z); L.intensity = Math.max(L.intensity * Math.exp(-dt / 0.2), 26 + 30 * crack); L.range = 15; }
          if (a >= hold) shatter(c, p, d);
        } else {
          d.sh += dt;
          // the cracks flare as the shell lets go, then the colour floods back in (eased)
          // the fog bursts outward and thins as the colour floods back in (eased)
          const back = 1 - smooth(0.02, 0.3, d.sh);
          setDome(d, 0, R * (1 + 0.7 * smooth(0, 0.5, d.sh)), back, 1, 1 - smooth(0, 0.15, d.sh), 1 - smooth(0.05, 0.7, d.sh), p.negative * Math.max(0, 1 - d.sh / 0.15));
          if (d.sh > 0.7 && d.dome) { d.dome.visible = false; d.dome = null; }
          if (L) L.intensity *= Math.exp(-dt / 0.3);
          if (d.sh < 2.5) { floorMist.pos.set(g.x, 0.1, g.z); floorMist.radius = R; floorMist.vel.set(0, 0.05, 0); floorMist.rate(30 * p.mist * (1 - d.sh / 2.5), dt); }
        }
        // the force: shock shells after the slam and the shatter, then let go
        const F = d.force;
        if (F && d.forceT >= 0) {
          d.forceT += dt;
          const k = d.forceT / 0.45;
          if (k >= 1) { d.forceT = -1; if (d.shattered) { F.release(); d.force = null; } }
          else { F.type = 4; F.pos.set(g.x, 0.6, g.z); F.p[0] = R * (d.shattered ? 0.9 + 1.6 * Math.pow(k, 0.4) : 1 + 0.8 * k); F.p[1] = 1.4; F.p[2] = (d.shattered ? 55 : 30) * (1 - k); F.p[3] = 0; }
        }
      },
    };

    function slam(c, p, d) {
      const g = d.g, R = d.R;
      d.a = 0; d.next = 0;
      setDome(d, 0, R, 0.25, 0, 0, 1, 0);
      // the rim bites the floor: frost potential in a ring (fingers crawl in and out), and from
      // the centre, reaching just past the rim
      splat(g.x, g.z, R, 1.35 * p.frost, 'ring', c.seed + 5, 0.3);
      splat(g.x, g.z, 1, (0.25 + 0.4 * (R - 0.6)) * p.frost, 'radial', c.seed + 9);
      fx.impacts.add('frost', _a.set(g.x, 0.8, g.z), R * 1.15, 1, 8, glowCol);
      blastMist.pos.set(g.x, 0.25, g.z); blastMist.radius = R; blastMist.radial = 2.8; blastMist.size = 1.1; blastMist.vel.set(0, 0.2, 0); blastMist.burst(60 * p.mist);
      glint.pos.set(g.x, 0.1, g.z); glint.radius = R; glint.radial = 1.5; glint.vel.set(0, 2.2, 0); glint.burst(320 * p.glints);
      chip.pos.set(g.x, 0.08, g.z); chip.radius = R; chip.radial = 1.2; chip.vel.set(0, 2.5, 0); chip.size = 1; chip.burst(50 * p.shards);
      shock(g.x, 0.03, g.z, R, R + 3.2, 0.55, 0.5, 0.05, 0.9, true);
      poolKick(g, R, 0.04);
      if (d.light) { d.light.intensity = 70; d.light.range = 15; }
      if (d.force) d.forceT = 0;
      fx.flash(0.08);
      fx.rig.shake(0.35, 14);
      if (!fx.reduced) fx.rig.punch(1.2, 0.07);
    }

    function shatter(c, p, d) {
      const g = d.g, R = d.R;
      d.shattered = true; d.sh = 0;
      // the bell breaks into six rings of self-lit panes (the shell's own glow, cooling as they
      // fall), flung out from its centre; chips and glints from every other ring
      for (let i = 0; i < RINGS.length; i++) {
        const ph = RINGS[i], cr = Math.cos(ph), sr = Math.sin(ph), k = 0.3 + 0.7 * cr;
        pane.pos.set(g.x, R * sr, g.z); pane.radius = R * cr; pane.radial = 6.5 * cr + 1; pane.vel.set(0, 6 * sr + 1.5, 0);
        pane.burst(70 * k * p.shards);
        if (i & 1) continue;
        chip.pos.copy(pane.pos); chip.radius = pane.radius; chip.radial = 8 * cr + 1; chip.vel.set(0, 7 * sr + 2, 0); chip.size = 1;
        chip.burst(80 * k * p.shards);
        glint.pos.copy(pane.pos); glint.radius = pane.radius; glint.radial = 9 * cr + 2; glint.vel.set(0, 8 * sr + 2, 0);
        glint.burst(420 * k * p.glints);
      }
      blastMist.pos.set(g.x, 0.3, g.z); blastMist.radius = 0.8 * R; blastMist.radial = 5; blastMist.size = 1.3; blastMist.vel.set(0, 0.6, 0); blastMist.burst(70 * p.mist);
      // frost blasted outward past the old rim
      splat(g.x, g.z, R + 0.4, 1.25 * p.frost, 'ring', c.seed + 17, 0.35);
      shock(g.x, 0.45 * R, g.z, 0.9 * R, 2.3 * R, 0.5, 0.7, 0.07, 1.4, false);
      shock(g.x, 0.03, g.z, 0.8 * R, 2.6 * R, 0.7, 0.6, 0.05, 0.8, true);
      fx.impacts.add('frost', _a.set(g.x, 0.8, g.z), R * 1.6, 1, 7, glowCol);
      poolKick(g, R * 2, 0.05);
      if (d.light) { d.light.intensity = 90; d.light.range = 18; d.light.pos.set(g.x, 0.5 * R, g.z); }
      if (d.force) d.forceT = 0;
      fx.flash(0.15);
      fx.rig.shake(0.55, 12);
      if (!fx.reduced) { fx.rig.punch(2.5, 0.08); fx.rig.hitstop(0.06); }
      for (const dm of fx.dummies) {
        const dist = Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z);
        if (dist < 2 * R) {
          dm.status.frozen = Math.max(dm.status.frozen, dist < R ? 1 : 0.6);
          dm.hit(_d.subVectors(dm.pos, g).setY(0), 0.9 * Math.max(0.2, 1 - dist / (2 * R)));
        }
      }
    }
  },
};
