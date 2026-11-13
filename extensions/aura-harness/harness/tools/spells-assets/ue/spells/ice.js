import * as THREE from 'three';
import { COMMON_GLSL, NOISE_GLSL, WORLD_GLSL, LIGHTS_GLSL, U, arenaSDF } from '../vfx/common.js';
import { REFRACT_GLSL } from '../vfx/Refraction.js';

// Ice (PLAN 3). Glacial Spike: a faceted crystal grows at the focus (vertices clamped behind a
// growth front whose cap glows), cold mist sinks off it and ~1k motes stream in. It flies as a
// ~190-triangle hexagonal shard in the refract pass (IOR 1.31, analytic ellipsoid thickness,
// Beer-Lambert cyan, flat facets, a fake interior of bubbles / veils / cracks from 3 noise taps
// along the refracted ray, rime on the crystal edges and a frosty rim), shedding mist and chips.
// Impact = Frost Nova: shard debris, a ring of 8 ice spikes, a frost splat of potential 1.8 whose
// front crawls out as fern fingers (wet ground freezes to a sheet), a nova shock + hoarfrost
// ring, cold mist, frozen dummies. The field then melts the frost into wet; mist lingers on it.
// Ice Wall: a frost line races along the floor and a curved, staggered row of large ice spikes
// erupts across the caster -> target line (the spikes are occluders, so particles stop at it).

const SHARD_VERT = /* glsl */`
in vec4 aGrowA;   // crystal base (local), crystal length
in vec4 aGrowB;   // crystal axis (local), growth start 0..1
in vec3 aEdge;    // distance to the triangle's 3 edges (local units), +8 on edges that aren't crystal edges
uniform vec4 uShard;   // growth 0..1, front glow, seed, inner glow
out vec3 vWorld;
out vec3 vLocal;  // deformed (grown) local position
out vec3 vRest;   // undeformed: interior noise and frost live here, so they don't swim while growing
out vec3 vEdge;
out float vFront; // local units below this crystal's growth front (0 on the forming cap)
void main() {
  vec3 p = position;
  float g = clamp((uShard.x - aGrowB.w) / max(1.0 - aGrowB.w, 1e-3), 0.0, 1.0);
  // vertices past the front are clamped onto it: the tip triangles fold into a flat cap
  float h = dot(p - aGrowA.xyz, aGrowB.xyz), hmax = g * aGrowA.w;
  p -= aGrowB.xyz * max(h - hmax, 0.0);
  vec3 rad = p - aGrowA.xyz - aGrowB.xyz * min(h, hmax);
  p -= rad * (1.0 - mix(0.3, 1.0, sqrt(g)));   // thin while young
  vFront = hmax - min(h, hmax);
  vLocal = p; vRest = position; vEdge = aEdge;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SHARD_FRAG = COMMON_GLSL + NOISE_GLSL + WORLD_GLSL + LIGHTS_GLSL + REFRACT_GLSL + /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec4 uShard;   // growth 0..1, front glow, seed, inner glow
uniform vec4 uLook;    // ior, frost, interior, glints
uniform vec4 uLook2;   // lens, metres per local unit, rim frost, -
uniform vec3 uAbsorb;  // Beer-Lambert sigma per metre
uniform vec3 uInscat;  // in-scatter colour of the body
uniform vec3 uGlow;    // growth-front / core emission (linear HDR)
uniform mat3 uToLocal; // world -> shard rotation
in vec3 vWorld;
in vec3 vLocal;
in vec3 vRest;
in vec3 vEdge;
in float vFront;
out vec4 fragColor;

// exit distance from o (on or inside) along d through an axis-aligned ellipsoid (centre c, semi-axes ax)
float ellipsoidExit(vec3 o, vec3 d, vec3 c, vec3 ax) {
  vec3 oo = (o - c) / ax, dd = d / ax;
  float a = dot(dd, dd), b = dot(oo, dd), cc = dot(oo, oo) - 1.0;
  return max((-b + sqrt(max(b * b - a * cc, 0.0))) / a, 0.0);
}

void main() {
  vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));   // flat facets
  vec3 V = normalize(cameraPosition - vWorld);
  if (dot(N, V) < 0.0) N = -N;
  float NoV = max(dot(N, V), 1e-3);
  float ior = uLook.x, S = uLook2.y, g = clamp(uShard.x, 0.05, 1.0), seed = uShard.z;

  // --- through the body: analytic convex thickness of the main crystal's ellipsoid (grown with it)
  vec3 R = refract(-V, N, 1.0 / ior);
  vec3 ld = uToLocal * R;
  float sg = mix(0.3, 1.0, sqrt(g));
  float tL = max(ellipsoidExit(vLocal, ld, vec3(0.0, 0.0, -1.0 + 0.5 * g), vec3(0.1 * sg, 0.1 * sg, 0.5 * g)), 0.03);
  float thick = tL * S;
  float behind;
  vec3 bg = sceneRefract(vWorld, N, V, ior, thick * uLook2.x, behind);
  vec3 Tr = beerLambert(uAbsorb, thick);

  // --- light: spell lights (GGX on the flat facet), sun, sky
  vec3 sd, ss;
  gLightNoShadow = true;
  spellLightPBR(vWorld, N, V, 0.03, vec3(0.018), vec3(1.0), sd, ss);
  float NoL = max(dot(N, uSunDir), 0.0);
  vec3 H = normalize(uSunDir + V);
  float sunSpec = spellD_GGX(max(dot(N, H), 0.0), 0.0009) * spellV_Smith(NoV, NoL, 0.0009) * NoL * PI;
  vec3 irr = uAmbient + uSunColor * NoL + sd;
  vec3 irrOmni = uAmbient + uSunColor * 0.5 + sd;

  // --- fake interior: 3 taps along the refracted ray read as bubbles, veils and cracks
  float scat = 0.0;
  for (int i = 1; i <= 3; i++) {
    float f = float(i) * 0.25;
    vec3 q = (vRest + ld * tL * f) * S + seed;
    vec4 n = noise3v(q * 1.1);               // veils (fbm) and cracks (worley iso-sheets)
    float b = noise3v(q * 4.5 + 0.37).a;     // bubbles: small worley cells
    float veil = smoothstep(0.62, 0.9, n.r) * 0.25;
    float bubble = smoothstep(0.9, 0.97, b) * 2.2;
    float crack = smoothstep(0.025, 0.0, abs(n.g - 0.55)) * smoothstep(0.35, 0.6, n.r) * 1.6;
    scat += (veil + bubble + crack) * exp(-uAbsorb.g * thick * f);
  }
  scat *= uLook.z / 3.0;

  // --- frost coat: rime on the crystal edges, a rough white rim at grazing angles, a frosted tail
  vec3 fp = vRest * S;
  vec4 fe = noise3v(fp * 2.6 + seed * 1.7);
  float ed = min(min(vEdge.x, vEdge.y), vEdge.z) * S;
  float ew = 0.014 * (0.25 + 1.75 * fe.r * fe.r);
  float frost = smoothstep(ew, ew * 0.1, ed - (fe.g - 0.5) * 0.008);
  frost = max(frost, pow(1.0 - NoV, 2.5) * smoothstep(0.35, 0.75, fe.b + 0.15) * uLook2.z);
  frost = max(frost, smoothstep(-0.6, -0.95, vRest.z + (fe.a - 0.5) * 0.25) * 0.9);
  frost = clamp(frost * uLook.y, 0.0, 1.0);

  // --- compose: transmitted scene + cyan in-scatter + interior, Fresnel sky + highlights, frost
  float F = fresnel(NoV, 0.018);
  vec3 refl = envReflect(reflect(-V, N), 0.03);
  // in-scatter keeps its own (cyan) colour: weighting it per channel by 1 - Tr would leave only green
  vec3 body = bg * Tr + uInscat * irrOmni * 0.5 * (1.0 - dot(Tr, vec3(0.3333))) + vec3(0.8, 0.92, 1.0) * irrOmni * scat * 0.25;
  vec3 col = body * (1.0 - F) + (refl * F + ss + uSunColor * F * sunSpec) * (1.0 - frost * 0.8);
  col = mix(col, vec3(0.85, 0.93, 1.0) * irr, frost * 0.85);

  // glints: random micro-facets whose hash changes with the view, twinkling; faded when sub-pixel
  vec3 gq = fp * 42.0;
  vec3 gh = hash33(floor(gq) + floor(V * 5.0) * 17.0 + seed);
  float tw = pow(0.5 + 0.5 * sin(uTime * 7.0 + gh.y * 60.0), 6.0);
  float spot = smoothstep(0.35, 0.0, length(fract(gq) - 0.5 - (gh - 0.5) * 0.4));
  float glint = step(0.9, gh.x) * spot * tw * smoothstep(1.2, 0.4, length(fwidth(gq))) * (0.35 + frost);
  col += glint * (irr * 6.0 + ss * 0.5) * uLook.w;

  // growth front: the forming cap and a band under it glow; a faint cold core in flight
  float band = exp(-vFront * 45.0) * uShard.y;
  col += uGlow * (band * 5.0 + uShard.w * (0.35 * scat + 0.6 * pow(1.0 - NoV, 3.0) + 0.04));
  fragColor = vec4(col, 1.0);
}`;

function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Glacial spike: a main hexagonal crystal along +z (back point z = -1, tip exactly at the origin,
// so the mesh position is the tip) and 7 small crystals sprouting off its back half. Non-indexed;
// per vertex the crystal's growth axis and the distance to each crystal edge (quad diagonals
// don't count). ~190 triangles.
function shardGeometry(seed) {
  const rand = lcg(seed);
  const pos = [], ga = [], gb = [], edge = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), ab = new THREE.Vector3();
  function tri(A, B, C, cr, f0, f1, f2) {   // fk: the edge opposite vertex k is a crystal edge
    pos.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
    const area2 = e1.subVectors(B, A).cross(e2.subVectors(C, A)).length();
    const h = [area2 / Math.max(ab.subVectors(B, C).length(), 1e-6), area2 / Math.max(ab.subVectors(A, C).length(), 1e-6), area2 / Math.max(ab.subVectors(A, B).length(), 1e-6)];
    const off = [f0 ? 0 : 8, f1 ? 0 : 8, f2 ? 0 : 8];
    for (let v = 0; v < 3; v++) {
      edge.push((v === 0 ? h[0] : 0) + off[0], (v === 1 ? h[1] : 0) + off[1], (v === 2 ? h[2] : 0) + off[2]);
      ga.push(cr.base.x, cr.base.y, cr.base.z, cr.len);
      gb.push(cr.axis.x, cr.axis.y, cr.axis.z, cr.start);
    }
  }
  // rings: [height along the axis, radius]; back: close the base with a point (main crystal)
  function crystal(base, axis, rings, tip, start, back) {
    const s = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).cross(axis).normalize();
    const u = new THREE.Vector3().crossVectors(axis, s);
    const tw = rand() * Math.PI * 2;
    const R = rings.map(([hh, r]) => Array.from({ length: 6 }, (_, k) => {
      const t = tw + k * Math.PI / 3 + (rand() - 0.5) * 0.1, rr = r * (0.92 + rand() * 0.16);
      return base.clone().addScaledVector(axis, hh).addScaledVector(s, Math.cos(t) * rr).addScaledVector(u, Math.sin(t) * rr);
    }));
    const cr = { base, axis, len: tip, start };
    const last = R.length - 1;
    for (let i = 0; i < last; i++) {
      const a = R[i], b = R[i + 1], ringA = i === 0, ringB = i + 1 === last;
      for (let k = 0; k < 6; k++) {
        const j = (k + 1) % 6;
        tri(a[k], a[j], b[j], cr, true, false, ringA);
        tri(a[k], b[j], b[k], cr, ringB, true, false);
      }
    }
    const apex = base.clone().addScaledVector(axis, tip);
    for (let k = 0; k < 6; k++) tri(R[last][k], R[last][(k + 1) % 6], apex, cr, true, true, true);
    if (back) for (let k = 0; k < 6; k++) tri(base, R[0][(k + 1) % 6], R[0][k], cr, true, true, true);
  }
  const Z = new THREE.Vector3(0, 0, 1);
  crystal(new THREE.Vector3(0, 0, -1), Z, [[0.1, 0.06], [0.28, 0.095], [0.48, 0.1], [0.66, 0.085], [0.8, 0.06]], 1, 0, true);
  for (let i = 0; i < 7; i++) {
    const phi = (i / 7) * Math.PI * 2 + rand() * 0.6, radial = new THREE.Vector3(Math.cos(phi), Math.sin(phi), 0);
    const fwd = i % 3 === 2;   // a few lie along the body, the rest flare backwards
    const axis = radial.clone().multiplyScalar(fwd ? 0.4 : 0.8).add(new THREE.Vector3(0, 0, fwd ? 0.9 : -0.35 - rand() * 0.4)).normalize();
    const base = radial.clone().multiplyScalar(0.04).setZ(-0.92 + rand() * 0.38);
    const w = 0.022 + rand() * 0.024, L = (fwd ? 0.22 : 0.1) + rand() * 0.12;
    crystal(base, axis, [[0, w * 1.1], [L, w]], L + w * (1.3 + rand() * 0.9), 0.3 + rand() * 0.4, false);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aGrowA', new THREE.Float32BufferAttribute(ga, 4));
  g.setAttribute('aGrowB', new THREE.Float32BufferAttribute(gb, 4));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 3));
  g.computeBoundingSphere();
  return g;
}

const MAX_SHARDS = 3;
const ZAXIS = new THREE.Vector3(0, 0, 1);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export default {
  id: 'ice', name: 'Ice', key: '4', hue: '#9ff0ff',
  shape: 'projectile', forms: ['Glacial Spike', 'Ice Wall'], radius: 0.12,
  params: {
    size: 1, speed: 24, ior: 1.31, clarity: 1, frost: 1, interior: 1, glints: 1, mist: 1, motes: 1, shards: 1,
    nova: 1, spikes: 8, wallSpikes: 11, wallHeight: 3, wallWidth: 7.5, wallCurve: 1, tint: '#a8dcff', glow: '#5fd0ff',
  },
  ranges: {
    size: [0.4, 2.5, 0.01], speed: [6, 50, 0.1], ior: [1, 2.4, 0.01], clarity: [0.2, 4, 0.01], frost: [0, 2, 0.01],
    interior: [0, 3, 0.01], glints: [0, 3, 0.01], mist: [0, 3, 0.01], motes: [0, 3, 0.01], shards: [0, 3, 0.01],
    nova: [0.4, 2, 0.01], spikes: [0, 8, 1], wallSpikes: [3, 15, 1], wallHeight: [1, 4.5, 0.01], wallWidth: [3, 12, 0.1], wallCurve: [-1, 2, 0.01],
  },
  presets: {
    glacier: { tint: '#3fa6ff', clarity: 1.8, glow: '#3f86ff', frost: 0.7 },
    rime: { tint: '#d2f2ff', clarity: 0.6, frost: 1.8, interior: 1.8, mist: 1.7, glow: '#bfefff' },
    'black ice': { tint: '#2f7d8f', clarity: 3, glints: 2.2, frost: 0.4, mist: 0.6, glow: '#6ff6ff' },
  },
  timing: { charge: 0.8, impact: 0.3, linger: 6.5 },
  kinds: {
    // sinking cold mist: negative buoyancy, slides along the floor (restitution 0, no friction)
    mist: { style: 'media', drag: 1.8, buoyancy: -0.9, curl: 0.5, curlScale: 0.22, restitution: 0, friction: 0.02, life: [1.6, 2.8], size: [0.3, 1.2], sizePow: 0.6, color: ['#e2f5ff', '#bcd9ec'], alpha: [0.05, 0], density: 1.1, erosion: 0.6, fadeIn: 0.2, fadeOut: 0.45, forceResponse: 0.5, lightResponse: 1.6 },
    groundmist: { style: 'media', drag: 2.2, buoyancy: -0.12, curl: 0.45, curlScale: 0.2, life: [2, 3.6], size: [0.6, 1.9], color: ['#e8f7ff', '#c4dfef'], alpha: [0.025, 0], density: 0.9, erosion: 0.55, fadeIn: 0.35, fadeOut: 0.45, forceResponse: 0.8, lightResponse: 1.4 },
    mote: { style: 'glow', drag: 0.25, curl: 0.8, curlScale: 0.5, life: [0.5, 0.75], size: [0.012, 0.006], stretch: 0.008, emissive: 9, color: ['#ffffff', '#8fe6ff'], alpha: [0.25, 1], fadeIn: 0.35, fadeOut: 0.12, forceResponse: 0 },
    glint: { style: 'glow', drag: 0.6, gravity: 6.5, restitution: 0.3, friction: 0.45, life: [0.6, 1.6], size: [0.02, 0.006], stretch: 0.02, emissive: 7, color: ['#ffffff', '#86ddff'], alpha: [1, 0] },
    shard: { style: 'debris', mesh: 'shard', drag: 0.25, gravity: 9.8, restitution: 0.3, friction: 0.55, life: [3.2, 5.5], size: [0.3, 0.1], sizePow: 1.6, spin: 9, color: ['#e6f8ff', '#1d5f86'], alpha: [1, 0.04], fadeOut: 0.25 },
    chip: { style: 'debris', mesh: 'shard', drag: 0.4, gravity: 9.8, restitution: 0.25, friction: 0.5, life: [0.8, 1.6], size: [0.09, 0.03], spin: 14, color: ['#e6f8ff', '#1d5f86'], alpha: [1, 0.04], fadeOut: 0.3 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const mist = P.emitter('ice.mist', { shape: 'sphere', radius: 0.25, spread: 0.25 });
    const trailMist = P.emitter('ice.mist', { shape: 'sphere', radius: 0.1, spread: 0.35 });
    const novaMist = P.emitter('ice.mist', { shape: 'ring', radius: 0.7, spread: 0.35, radial: 2.4 });
    const lineMist = P.emitter('ice.mist', { shape: 'line', radius: 0.35, spread: 0.6 });
    const mote = P.emitter('ice.mote', { shape: 'shell', radius: 1.3, spread: 0.1, radial: -2.2 });
    const glint = P.emitter('ice.glint', { shape: 'sphere', radius: 0.25, spread: 4.5, radial: 3 });
    const lineGlint = P.emitter('ice.glint', { shape: 'line', radius: 0.3, spread: 2.5 });
    const shard = P.emitter('ice.shard', { shape: 'sphere', radius: 0.25, spread: 2, radial: 4 });
    const chip = P.emitter('ice.chip', { shape: 'sphere', radius: 0.05, spread: 1.4 });
    // GPU-driven: frost on the floor breathes mist until it melts (also frost left by combos)
    P.fieldEmitter('ice.groundmist', { slots: 768, a: [0, 0, 0, 1], threshold: 0.3, rate: 6, up: 0.15 });

    // --- look, shared by every shard (and pushed to the ice spikes) ---
    const tint = new THREE.Color(), glowCol = new THREE.Color(), lightCol = new THREE.Color(), white = new THREE.Color(1, 1, 1);
    const absorb = new THREE.Vector3(), inscat = new THREE.Vector3(), glowV = new THREE.Vector3(), look = new THREE.Vector4();
    const SP = fx.spikes.uniforms;
    function applyLook() {
      const p = S.params;
      tint.set(p.tint); glowCol.set(p.glow);
      const k = 6 * p.clarity;   // tint = transmittance through ~17 cm of shard
      absorb.set(-Math.log(Math.max(tint.r, 0.01)), -Math.log(Math.max(tint.g, 0.01)), -Math.log(Math.max(tint.b, 0.01))).multiplyScalar(k);
      inscat.set(tint.r * tint.r, tint.g * tint.g, tint.b * tint.b).multiplyScalar(0.6);
      glowV.set(glowCol.r, glowCol.g, glowCol.b).multiplyScalar(3);
      look.set(p.ior, p.frost, p.interior, p.glints);
      SP.uIceAbsorb.value.copy(absorb).multiplyScalar(0.35);   // spikes: a much thicker body
      SP.uIceLook.value.set(p.ior, p.frost, p.interior, p.glints);
      SP.uIceGlow.value.copy(glowV).multiplyScalar(0.87);
      lightCol.copy(glowCol).lerp(white, 0.35);
    }
    applyLook();

    // --- shard meshes: one program (identical source), per-mesh uniforms ---
    const geo = shardGeometry(4242);
    const shards = [];
    for (let i = 0; i < MAX_SHARDS; i++) {
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: SHARD_VERT, fragmentShader: SHARD_FRAG,
        uniforms: {
          ...U, uShard: { value: new THREE.Vector4() }, uLook: { value: look }, uLook2: { value: new THREE.Vector4(3, 1, 1, 0) },
          uAbsorb: { value: absorb }, uInscat: { value: inscat }, uGlow: { value: glowV }, uToLocal: { value: new THREE.Matrix3() },
        },
      }));
      m.visible = false;
      m.userData.free = true;
      fx.scenes.refract.add(m);
      shards.push(m);
    }
    const takeShard = () => { for (const m of shards) if (m.userData.free) { m.userData.free = false; return m; } return null; };
    const dropShard = (m) => { if (m) { m.visible = false; m.userData.free = true; } };

    // per-cast state by cast index (the cast pool is 16): nothing allocated per cast
    const st = Array.from({ length: 16 }, () => ({
      shard: null, light: null, trail: null, spin: 0, boom: 0, ring: false,
      ground: new THREE.Vector3(), last: new THREE.Vector3(), wallC: new THREE.Vector3(),
      wallA: new THREE.Vector3(), wallB: new THREE.Vector3(), dirH: new THREE.Vector3(),
    }));
    const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _perp = new THREE.Vector3();
    const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
    // reused option objects (every field set on every call)
    const SPK = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), height: 2, radius: 0.4, material: 'ice', delay: 0, rise: 0.18, life: 4.5, crumble: 0.9, seed: 1 };
    const SPL = { x: 0, z: 0, radius: 1, frost: 0, wet: 0, pattern: 'radial', seed: 0, x2: 0, z2: 0, width: 0, lobe: 0 };
    const SHK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 4, duration: 0.5, thickness: 0.5, distortion: 0.04, color: glowCol, intensity: 0, ground: false };
    function splat(x, z, radius, frost, pattern, seed, x2 = x, z2 = z, width = 0, lobe = 0) {
      SPL.x = x; SPL.z = z; SPL.radius = radius; SPL.frost = frost; SPL.pattern = pattern; SPL.seed = seed;
      SPL.x2 = x2; SPL.z2 = z2; SPL.width = width; SPL.lobe = lobe;
      fx.ground.splat(SPL);
    }
    function shock(pos, r0, r1, dur, thick, dist, intensity, ground) {
      SHK.pos.copy(pos);
      SHK.radius0 = r0; SHK.radius1 = r1; SHK.duration = dur; SHK.thickness = thick; SHK.distortion = dist;
      SHK.intensity = intensity; SHK.ground = ground;
      fx.shocks.spawn(SHK);
    }
    function spike(pos, dir, height, radius, delay, rise, life, crumble, seed) {
      SPK.pos.copy(pos); SPK.dir.copy(dir);
      SPK.height = height; SPK.radius = radius; SPK.delay = delay; SPK.rise = rise; SPK.life = life;
      SPK.crumble = crumble; SPK.seed = seed & 0xffffff;
      return fx.spikes.spawn(SPK);
    }
    // a point of the wall: parabolic arc through C (bowing toward the target for curve > 0)
    function wallPoint(C, perp, dirH, s, curve, D, out) {
      return out.copy(C).addScaledVector(perp, s).addScaledVector(dirH, -curve * s * s / (2 * Math.max(D, 1)));
    }
    // orient the shard (tip at pos) along dir, spun about its axis
    function poseShard(m, pos, dir, spin, size) {
      m.position.copy(pos);
      _q.setFromUnitVectors(ZAXIS, dir);
      _q2.setFromAxisAngle(ZAXIS, spin);
      m.quaternion.multiplyQuaternions(_q, _q2);
      m.scale.setScalar(size);
      m.material.uniforms.uToLocal.value.setFromMatrix4(_m4.makeRotationFromQuaternion(m.quaternion)).transpose();
      m.material.uniforms.uLook2.value.y = size;
    }

    return {
      onParam() { applyLook(); },

      phase(c, name) {
        const p = S.params, d = st[c.index];
        if (name === 'charge') {
          applyLook();
          d.shard = takeShard();
          if (d.shard) { d.shard.visible = true; d.shard.material.uniforms.uShard.value.set(0, 1, (c.seed % 97) * 0.37, 0); }
          d.light = fx.lights.acquire();
          if (d.light) { d.light.range = 7; d.light.intensity = 0; d.light.color.copy(lightCol); d.light.shadow = true; }
          d.trail = null; d.boom = 0; d.ring = false; d.spin = (c.seed % 628) / 100;
        } else if (name === 'release') {
          fx.rig.shake(0.1, 12);
          if (c.form === 'Ice Wall') {
            // the crystal dives into the floor: a puff of glints and mist where it was
            _a.copy(c.from).addScaledVector(c.dir, 0.6 * p.size);
            glint.pos.copy(_a); glint.vel.set(0, -1, 0); glint.burst(120 * p.glints);
            mist.pos.copy(_a); mist.vel.set(0, -1.5, 0); mist.size = p.size; mist.burst(30 * p.mist);
            dropShard(d.shard); d.shard = null;
          } else {
            d.trail = fx.trails.acquire();
            const t = d.trail;
            if (t) { t.width = 0.05 * p.size; t.intensity = 1.2; t.glow = 5; t.glowIntensity = 0.2; t.distortion = 0; t.fadeTime = 0.35; t.color.copy(lightCol); }
            mist.pos.copy(c.from); mist.vel.copy(c.dir).multiplyScalar(2); mist.size = p.size; mist.burst(25 * p.mist);
          }
        } else if (name === 'travel') {
          if (c.form === 'Ice Wall') {
            // frost line from under the focus to the wall's centre
            d.dirH.set(c.to.x - c.from.x, 0, c.to.z - c.from.z);
            const D = d.dirH.length();
            d.dirH.multiplyScalar(1 / Math.max(D, 1e-3));
            const wd = Math.min(Math.max(D - 2.5, 3), D * 0.85);
            d.wallC.set(c.from.x, 0, c.from.z).addScaledVector(d.dirH, wd);
            c.pos.set(c.from.x, 0.05, c.from.z).addScaledVector(d.dirH, 0.8);
            d.last.copy(c.pos);
          } else c.pos.addScaledVector(c.dir, 1.15 * p.size);   // the grown crystal's tip
        } else if (name === 'impact') {
          d.trail?.release(); d.trail = null;
          dropShard(d.shard); d.shard = null;
          if (c.form === 'Ice Wall') wall(c, p, d); else nova(c, p, d);
        } else if (name === 'done') {
          d.light?.release(); d.light = null;
          d.trail?.release(); d.trail = null;
          dropShard(d.shard); d.shard = null;
        }
      },

      // own integration: the spike flies straight (same tests as cast.js); the wall's frost line
      // runs along the floor to the wall centre
      travel(c, dt) {
        const d = st[c.index];
        if (c.form === 'Ice Wall') {
          d.last.copy(c.pos);
          const step = 30 * dt, rem = _d.subVectors(d.wallC, c.pos).setY(0).length();
          if (rem <= step) { c.pos.set(d.wallC.x, 0.05, d.wallC.z); return true; }
          c.pos.addScaledVector(d.dirH, step);
          return false;
        }
        c.pos.addScaledVector(c.vel, dt);
        c.travelled += c.vel.length() * dt;
        const past = _d.subVectors(c.to, c.pos).dot(c.dir) <= 0;
        if ((c.travelled > 1 && arenaSDF(c.pos) < S.radius) || past || c.t > c.durations.travel) {
          if (past && c.t <= c.durations.travel) c.pos.copy(c.to);
          return true;
        }
        return false;
      },

      update(c, dt) {
        const p = S.params, d = st[c.index], L = d.light, m = d.shard;
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge, grow = smooth(0.04, 0.92, k);
          d.spin += dt * 0.8;
          _a.copy(c.from).addScaledVector(c.dir, 1.15 * p.size);   // tip; the crystal grows back to front
          if (m) { poseShard(m, _a, c.dir, d.spin, p.size); m.material.uniforms.uShard.value.x = grow; m.material.uniforms.uShard.value.w = 1.6 * k; }
          _b.copy(c.from).addScaledVector(c.dir, 0.6 * p.size);    // the crystal's middle
          mist.pos.copy(_b); mist.vel.set(0, -0.5, 0); mist.size = 0.7 * p.size; mist.rate(150 * p.mist, dt);
          mote.pos.copy(_b); mote.vel.set(0, 0, 0); mote.rate(1300 * p.motes, dt);
          if (L) { L.pos.copy(_b); L.intensity = 9 * k * (0.85 + 0.15 * Math.sin(c.age * 23)); }
          return;
        }
        if (c.phase === 'travel') {
          if (c.form === 'Ice Wall') {
            // the frost line: a jagged line splat per frame behind the runner, mist and glints off it
            splat(d.last.x, d.last.z, 0.3, 0.5 * p.frost, 'line', c.seed % 100, c.pos.x, c.pos.z, 0.2);
            lineMist.pos.copy(d.last).setY(0.2); lineMist.p.copy(c.pos).setY(0.2); lineMist.vel.set(0, 0.3, 0); lineMist.size = 0.8; lineMist.rate(260 * p.mist, dt);
            glint.pos.copy(c.pos); glint.vel.set(0, 2.5, 0); glint.rate(500 * p.glints, dt);
            if (L) { L.pos.copy(c.pos).setY(0.5); L.intensity = 10; }
          } else {
            d.spin += dt * 9;
            _d.copy(c.vel).normalize();
            if (m) { poseShard(m, c.pos, _d, d.spin, p.size); m.material.uniforms.uShard.value.set(1, Math.max(0, m.material.uniforms.uShard.value.y - dt * 6), m.material.uniforms.uShard.value.z, 0.6); }
            _a.copy(c.pos).addScaledVector(_d, -0.75 * p.size);   // the frosted tail
            d.trail?.push(_a);
            trailMist.pos.copy(_a); trailMist.vel.copy(c.vel).multiplyScalar(0.06); trailMist.size = 0.55 * p.size; trailMist.rate(130 * p.mist, dt);
            chip.pos.copy(_a); chip.vel.copy(c.vel).multiplyScalar(0.5); chip.rate(30 * p.shards, dt);
            glint.pos.copy(_a); glint.vel.copy(c.vel).multiplyScalar(0.25); glint.rate(160 * p.glints, dt);
            if (L) { L.pos.copy(c.pos); L.intensity = 8; }
          }
          return;
        }
        // impact + linger
        d.boom += dt;
        const g = d.ground;
        if (L) {
          L.intensity *= Math.exp(-dt / 0.25);
          if (c.phase === 'linger') L.intensity = Math.max(L.intensity, 1.5 * Math.max(0, 1 - c.t / 2));
        }
        if (c.form === 'Ice Wall') {
          // cold air pours off the wall for a while
          if (d.boom < 3) { lineMist.pos.copy(d.wallA).setY(1.2); lineMist.p.copy(d.wallB).setY(1.2); lineMist.vel.set(0, -0.4, 0); lineMist.size = 1; lineMist.rate(70 * p.mist * (1 - d.boom / 3), dt); }
        } else {
          // the hoarfrost ring lands where the nova's shell passes
          // (lobed and broken: hoarfrost grows unevenly, further where the stone is colder)
          if (!d.ring && d.boom > 0.12) { d.ring = true; splat(g.x, g.z, 3.4 * p.nova, 0.45 * p.frost, 'ring', (c.seed + 7) % 100, g.x, g.z, 0.32 * p.nova, 0.22); }
          if (d.boom < 2.5) { mist.pos.copy(g).setY(0.35); mist.vel.set(0, 0, 0); mist.size = 1.2; mist.rate(45 * p.mist * (1 - d.boom / 2.5), dt); }
        }
      },
    };

    function nova(c, p, d) {
      const g = d.ground.set(c.pos.x, 0, c.pos.z), s = p.nova, rnd = fx.rand;
      // 8 spikes in a ring, leaning out, erupting almost together
      const n = Math.round(p.spikes), a0 = rnd() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const ang = a0 + (i / Math.max(n, 1)) * Math.PI * 2 + (rnd() - 0.5) * 0.3, r = (1.45 + rnd() * 0.4) * s;
        _a.set(g.x + Math.cos(ang) * r, 0, g.z + Math.sin(ang) * r);
        _b.set(Math.cos(ang) * (0.35 + rnd() * 0.25), 1, Math.sin(ang) * (0.35 + rnd() * 0.25));
        spike(_a, _b, (1.4 + rnd() * 0.9) * s, (0.34 + rnd() * 0.14) * s, 0.02 + rnd() * 0.07, 0.16, 4.4 + rnd() * 0.8, 0.9, c.seed * 31 + i * 7919);
      }
      shard.pos.copy(c.pos); shard.vel.set(0, 2, 0); shard.size = p.size; shard.burst(48 * p.shards);
      glint.pos.copy(c.pos); glint.vel.set(0, 2.5, 0); glint.burst(280 * p.glints);
      novaMist.pos.copy(g).setY(0.3); novaMist.radius = 0.7 * s; novaMist.size = 1.2 * s; novaMist.burst(42 * p.mist);
      mist.pos.copy(c.pos); mist.vel.set(0, -1, 0); mist.size = s; mist.burst(18 * p.mist);
      // frost potential 1.8: the front crawls out over ~1 s as fern fingers, puddles freeze to a sheet
      splat(g.x, g.z, 1.2 * s, 1.8 * p.frost, 'radial', c.seed % 100);
      shock(_a.copy(g).setY(0.03), 0.4, 4.4 * s, 0.55, 0.5, 0.05, 1.2, true);
      shock(c.pos, 0.2, 2.4 * s, 0.3, 0.4, 0.035, 0, false);
      fx.impacts.add('frost', g, 3.6 * s, 1, 7, glowCol);
      if (d.light) { d.light.intensity = 28; d.light.range = 11 * s; d.light.pos.copy(c.pos).setY(Math.max(c.pos.y, 0.8)); }
      fx.flash(0.16);
      fx.rig.shake(0.35, 16);
      if (!fx.reduced) { fx.rig.punch(1.5, 0.06); fx.rig.hitstop(0.04); }
      const R = 2.6 * s;
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i], dist = Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z);
        if (i === c.target || dist < R) {
          dm.status.frozen = Math.max(dm.status.frozen, i === c.target ? 1 : 1 - 0.5 * dist / R);
          dm.hit(_d.subVectors(dm.pos, g).setY(0).normalize(), 0.5 * Math.max(0, 1 - dist / R));
        }
      }
    }

    function wall(c, p, d) {
      const C = d.wallC, dirH = d.dirH, rnd = fx.rand;
      const n = Math.round(p.wallSpikes), half = p.wallWidth / 2;
      const D = Math.hypot(C.x - c.from.x, C.z - c.from.z);
      _perp.set(-dirH.z, 0, dirH.x);
      // a curved, staggered row: alternate spikes stand back and lower
      wallPoint(C, _perp, dirH, -half, p.wallCurve, D, d.wallA); wallPoint(C, _perp, dirH, half, p.wallCurve, D, d.wallB);
      for (let i = 0; i < n; i++) {
        const u = n > 1 ? i / (n - 1) : 0.5, s = (u - 0.5) * 2 * half, e = Math.abs(u - 0.5) * 2, back = i % 2 === 1;
        wallPoint(C, _perp, dirH, s, p.wallCurve, D, _a).addScaledVector(dirH, back ? -0.45 : 0.1);
        const h = p.wallHeight * (1 - 0.35 * e * e) * (back ? 0.78 : 1) * (0.9 + 0.2 * rnd());
        // lean toward the target and outward along the wall
        _b.copy(dirH).multiplyScalar(0.18 + 0.1 * rnd()).addScaledVector(_perp, (u - 0.5) * 0.5 + (rnd() - 0.5) * 0.15).setY(1);
        spike(_a, _b, h, (0.42 + 0.12 * rnd()) * h / 2.8 + 0.12, 0.04 + e * 0.22 + rnd() * 0.03, 0.22, 5 + rnd() * 0.4, 1, c.seed * 17 + i * 104729);
        if (i < 14) splat(_a.x, _a.z, 0.8, 0.85 * p.frost, 'radial', (c.seed + i * 13) % 100);
      }
      lineMist.pos.copy(d.wallA).setY(0.4); lineMist.p.copy(d.wallB).setY(0.4); lineMist.vel.copy(dirH).multiplyScalar(-0.8); lineMist.size = 1.3; lineMist.burst(180 * p.mist);
      lineGlint.pos.copy(d.wallA).setY(0.6); lineGlint.p.copy(d.wallB).setY(0.6); lineGlint.vel.set(0, 3, 0); lineGlint.burst(500 * p.glints);
      shard.pos.copy(C).setY(0.3); shard.vel.set(0, 3, 0); shard.size = 0.6 * p.size; shard.burst(20 * p.shards);
      shock(_a.copy(C).setY(0.03), 0.3, 3.2, 0.45, 0.45, 0.035, 0.8, true);
      fx.impacts.add('frost', C, half + 1, 1, 7, glowCol);
      if (d.light) { d.light.intensity = 14; d.light.range = 9; d.light.pos.copy(C).setY(1.8); }
      fx.rig.shake(0.4, 9);
      if (!fx.reduced) fx.rig.punch(1, 0.08);
      // anything standing in the wall's footprint is caught in it
      for (const dm of fx.dummies) {
        _d.subVectors(dm.pos, C).setY(0);
        const along = _d.dot(_perp), across = _d.dot(dirH);
        if (Math.abs(along) < half + 0.5 && Math.abs(across + p.wallCurve * along * along / (2 * Math.max(D, 1))) < 1.2) dm.status.frozen = Math.max(dm.status.frozen, 0.7);
      }
    }
  },
};
