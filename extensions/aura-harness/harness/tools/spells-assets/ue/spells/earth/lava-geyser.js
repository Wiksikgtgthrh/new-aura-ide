import * as THREE from 'three';
import { U } from '../../vfx/common.js';
import { blackbodyRGB } from '../../vfx/noise.js';
import { VENT_VERT, VENT_FRAG } from './lava-geyser.glsl.js';

// Lava Geyser (earth + fire). Reference: Hawaiian lava fountains (Kilauea 2018 fissure 8,
// Halema'uma'u 2021-24 episodes) and Fagradalsfjall 2021: a column of incandescent clots, yellow
// at the vent and redder as it rises, decelerating to a ragged top and falling back as a fan;
// bombs arcing out on their own, darkening as they fly and landing as black rock that still glows
// in its cracks; a blue-grey gas plume lit orange from below.
// Anticipation: the ground bulges and cracks radially, a spatter rampart heaves up around a
// mouth that opens over rising magma (an interior-mapped throat, lava-geyser.glsl.js), steam and
// embers seep, the floor rumbles, a throat-clearing spurt. Release: the fountain bursts out with
// a pressure shock, rock and bombs, knockback, fire. Linger: the fountain surges and sags, bombs
// keep arcing out, the plume builds and the column lights the arena like a vertical lamp.
// Aftermath: the fountain dies back to spatter, the magma drains and crusts over, the rampart
// crumbles, the landed bombs cool to black.

const STATES = 16, MAX_VENTS = 3, MAX_RIM = 10, BOMBS = 6;
const SUBSIDE = 1.6;   // s at the end of `duration` while the fountain dies back
const COOL = 2.4;      // s after that: drains, crusts, crumbles
const UP = new THREE.Vector3(0, 1, 0);
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// reused option objects: the shared systems read fields, a literal per call would allocate
const SPL = { x: 0, z: 0, radius: 1, heat: 0, char: 0, wet: 0, frost: 0, crack: 0, acid: 0, corruption: 0, glow: 0, pattern: 'radial', seed: 0, angle: 0, x2: 0, z2: 0, width: 0 };
const SPK = { pos: new THREE.Vector3(), dir: new THREE.Vector3(), height: 1, radius: 0.4, material: 'rock', delay: 0, rise: 0.6, life: 3, crumble: 1.0, heat: 0.3, seed: 1 };
const SHK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 4, duration: 0.5, thickness: 0.5, distortion: 0.05, color: null, intensity: 0, ground: true };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _col = new THREE.Color();

// The plume (gas column, ash bursts, heat haze over the fountain) sits behind this small interface
// so it can move onto the shared fluid volume (src/vfx/FluidVolume.js) when that lands:
//   burst(pos, top, amount)                    an eruption pulse of dark ash
//   update(pos, top, dt, strength, p)          the sustained gas column over a fountain `top` m tall
function makePlume(P) {
  const gas = P.emitter('lava-geyser.gas', { shape: 'disk', radius: 0.35, spread: 0.7 });
  const ash = P.emitter('lava-geyser.ash', { shape: 'sphere', radius: 0.35, spread: 1.4, radial: 1.8 });
  const haze = P.emitter('lava-geyser.haze', { shape: 'disk', radius: 0.35, spread: 0.3 });
  return {
    burst(pos, top, amount) { ash.pos.copy(pos).setY(Math.max(top * 0.55, 0.8)); ash.vel.set(0, 3.2, 0); ash.burst(amount); },
    update(pos, top, dt, strength, p) {
      if (strength <= 0.01) return;
      gas.pos.copy(pos).setY(top * 0.45 + 0.4); gas.vel.set(0, 2.4, 0); gas.size = 0.8 + 0.25 * top / 6;
      gas.rate(40 * p.plume * strength, dt);
      if (p.haze > 0) { haze.pos.copy(pos).setY(0.5); haze.vel.set(0, 1.4, 0); haze.rate(36 * p.haze * strength, dt); }
    },
  };
}

export default {
  id: 'lava-geyser', name: 'Lava Geyser', element: 'earth', order: 20, hue: '#ff5a14',
  shape: 'area',
  params: {
    height: 6, width: 0.4, duration: 4, temperature: 1400, intensity: 1, surge: 1, bombs: 1, spatter: 1,
    plume: 1, haze: 1, rim: 7, rimHeight: 0.55, shake: 1, tint: '#ffffff',
  },
  ranges: {
    height: [2, 12, 0.1], width: [0.12, 0.8, 0.01], duration: [1.5, 9, 0.1], temperature: [1000, 2600, 10], intensity: [0, 3, 0.01],
    surge: [0, 3, 0.01], bombs: [0, 3, 0.01], spatter: [0, 3, 0.01], plume: [0, 3, 0.01], haze: [0, 3, 0.01],
    rim: [0, MAX_RIM, 1], rimHeight: [0.2, 1.6, 0.01], shake: [0, 2, 0.01],
  },
  presets: {
    'hawaiian fountain': { height: 9.5, width: 0.26, surge: 0.5, bombs: 0.6, plume: 0.8, duration: 5.5, rimHeight: 0.45 },
    strombolian: { height: 5, width: 0.36, surge: 2.4, bombs: 2.2, plume: 1.7, spatter: 0.7, rimHeight: 0.85, rim: 9 },
    'sulfur blue': { tint: '#7fa6ff', temperature: 1750, height: 4.2, plume: 1.8, bombs: 0.4, intensity: 0.9 },
  },
  timing: { charge: 1.1, impact: 0.3, linger: 8 },
  kinds: {
    // the fountain: incandescent clots, yellow at the vent, red as they rise, slow and fall back
    jet: { style: 'glow', drag: 0.18, gravity: 9.8, killOnCollide: true, life: [2.2, 3.2], size: [0.075, 0.035], stretch: 0.045, emissive: 2.4, temp: [1480, 1060], paints: 'heat', paintAmount: 0.03, fadeIn: 0.02, fadeOut: 0.15 },
    // the dense, hottest base of the column
    core: { style: 'glow', drag: 0.8, gravity: 5, killOnCollide: true, life: [0.3, 0.6], size: [0.11, 0.07], stretch: 0.035, emissive: 2.2, temp: [1550, 1300], fadeIn: 0.02, fadeOut: 0.35 },
    // the molten mass of the column's lower half: semi-opaque, self-lit, torn by noise
    mass: { style: 'media', drag: 0.25, gravity: 9.8, curl: 0.6, curlScale: 0.4, life: [0.55, 0.95], size: [0.2, 0.42], sizePow: 0.7, emissive: 4, temp: [1500, 1150], alpha: [0.85, 0], density: 7, erosion: 1.3, fadeIn: 0.05, fadeOut: 0.35, forceResponse: 0.2 },
    // fine spatter thrown sideways at the mouth
    spray: { style: 'glow', drag: 0.3, gravity: 9.8, killOnCollide: true, life: [0.6, 1.3], size: [0.022, 0.01], stretch: 0.04, emissive: 2.6, temp: [1450, 850], paints: 'heat', paintAmount: 0.02 },
    // sparks of glowing tephra the plume carries up
    ember: { style: 'glow', drag: 0.7, buoyancy: 1.4, gravity: 1.5, curl: 2.2, curlScale: 0.45, life: [1.0, 2.4], size: [0.022, 0.008], stretch: 0.025, emissive: 3, temp: [1700, 850], forceResponse: 1.5 },
    // lava bombs: rock lumps glowing as they fly, crusting black where they land
    clot: { style: 'debris', mesh: 'rock', gravity: 9.8, drag: 0.05, restitution: 0.1, friction: 0.85, life: [3.4, 4.4], size: [0.09, 0.09], spin: 4, color: ['#15100c', new THREE.Color(5, 0.55, 0.02)], alpha: [1, 1], fadeOut: 0.05, forceResponse: 0, paints: 'heat', paintAmount: 0.08, morph: 'lava-geyser.cinder' },
    // ...and what it becomes on landing: a crusted lump, dull red in its cracks, cooling to black
    cinder: { style: 'debris', mesh: 'rock', gravity: 9.8, drag: 0.05, restitution: 0.06, friction: 0.95, life: [5.5, 7.5], size: [0.09, 0.09], spin: 2, color: ['#120d0a', new THREE.Color(1.5, 0.14, 0)], alpha: [1, 0.9], fadeOut: 0.12, forceResponse: 0, paints: 'heat', paintAmount: 0.03 },
    // volcanic gas: blue-grey, lit orange from below by the fountain
    gas: { style: 'media', emissive: 0, drag: 0.9, buoyancy: 3.4, curl: 1.0, curlScale: 0.22, life: [3.0, 4.6], size: [0.8, 3.6], sizePow: 0.5, color: ['#959aa0', '#71757b'], alpha: [0.16, 0], density: 1.4, erosion: 0.6, fadeIn: 0.12, fadeOut: 0.5, forceResponse: 0.9, lightResponse: 1.7 },
    // ash: the dark pulse of each explosive burst
    ash: { style: 'media', emissive: 0, drag: 1.2, buoyancy: 2.4, curl: 1.3, curlScale: 0.3, life: [2.4, 4], size: [0.4, 2.2], sizePow: 0.55, color: ['#3a3532', '#55504b'], alpha: [0.18, 0], density: 2.2, erosion: 0.7, fadeIn: 0.06, fadeOut: 0.5, forceResponse: 0.8, lightResponse: 1.3 },
    steam: { style: 'media', emissive: 0, drag: 1.5, buoyancy: 2.4, curl: 1.3, curlScale: 0.35, life: [1.3, 2.4], size: [0.2, 1.2], sizePow: 0.5, color: ['#cfc9c4', '#8f8984'], alpha: [0.12, 0], density: 1.4, erosion: 0.7, fadeIn: 0.08, fadeOut: 0.5, forceResponse: 0.8, lightResponse: 0.8 },
    dust: { style: 'media', emissive: 0, drag: 2.2, buoyancy: -0.2, curl: 0.6, curlScale: 0.2, life: [2.2, 3.8], size: [0.4, 1.8], sizePow: 0.55, color: ['#4a3f36', '#3a322c'], alpha: [0.2, 0.08], density: 2.2, erosion: 0.55, fadeIn: 0.05, fadeOut: 0.6, forceResponse: 0.5, lightResponse: 0.35 },
    haze: { style: 'media', emissive: 0, drag: 2.5, buoyancy: 2.2, curl: 0.8, curlScale: 0.5, life: [0.8, 1.5], size: [0.5, 1.2], color: ['#ffffff', '#ffffff'], alpha: [0.018, 0], density: 0.6, erosion: 0.3, distortion: 40, fadeIn: 0.25, fadeOut: 0.4, forceResponse: 0.6 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const cone = (kind, radius, spread, radial, c) => P.emitter(kind, { shape: 'cone', radius, spread, radial, cone: c });
    const jet = cone('lava-geyser.jet', 0.2, 0.5, 10, 0.13), fan = cone('lava-geyser.jet', 0.2, 0.7, 9, 0.24), core = cone('lava-geyser.core', 0.16, 0.4, 3, 0.15);
    const mass = cone('lava-geyser.mass', 0.14, 0.4, 6, 0.08);
    const spray = cone('lava-geyser.spray', 0.15, 1.2, 4, 0.75), clot = cone('lava-geyser.clot', 0.15, 0.8, 8, 0.38);
    const rockC = cone('earth.rock', 0.3, 1.4, 6, 0.6), chunkC = cone('earth.chunk', 0.3, 1, 5, 0.5);
    const ember = P.emitter('lava-geyser.ember', { shape: 'disk', radius: 0.5, spread: 1.2 });
    const pebble = P.emitter('earth.pebble', { shape: 'disk', radius: 1.4, spread: 0.8 });
    const seep = P.emitter('lava-geyser.steam', { shape: 'ring', radius: 1, spread: 0.3 });
    const dust = P.emitter('lava-geyser.dust', { shape: 'ring', radius: 0.7, spread: 0.6, radial: 4.5 });
    const bombE = P.emitter('lava-geyser.clot', { shape: 'sphere', radius: 0, spread: 0 });
    const smokeE = P.emitter('lava-geyser.ash', { shape: 'sphere', radius: 0.05, spread: 0.25 });
    const puff = P.emitter('lava-geyser.dust', { shape: 'sphere', radius: 0.1, spread: 0.8, radial: 1 });
    const plume = makePlume(P);

    // --- the vents: one program, per-mesh uniforms ---
    const tint = new THREE.Vector3(1, 1, 1), tintCol = new THREE.Color(1, 1, 1);
    const quad = new THREE.PlaneGeometry(2, 2, 1, 1);
    const vents = [];
    for (let i = 0; i < MAX_VENTS; i++) {
      const m = new THREE.Mesh(quad, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: VENT_VERT, fragmentShader: VENT_FRAG, alphaToCoverage: true, side: THREE.DoubleSide,
        uniforms: {
          ...U, uVent: { value: new THREE.Vector4() }, uVentA: { value: new THREE.Vector4() }, uVentB: { value: new THREE.Vector4() },
          uVentC: { value: new THREE.Vector4() }, uTint: { value: tint },
        },
      }));
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = -0.5;
      fx.scenes.opaque.add(m);
      vents.push(m);
    }

    // --- per-cast state ---
    const rimState = () => ({ h: null, seed: 0, pos: new THREE.Vector3(), dir: new THREE.Vector3(), height: 1, radius: 0.3, delay: 0 });
    const bombState = () => ({ trail: null, alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), t: 0 });
    const states = Array.from({ length: STATES }, () => ({
      vent: null, pos: new THREE.Vector3(), R: 0.4, seedF: 0, erupted: false, te: 0, spurt: false,
      heat: 0, level: 1, up: 0, crust: 0, h: 0, env: 0, surgeV: 0, surgeT: 0, bombT: 0, splatT: 0,
      rim: Array.from({ length: MAX_RIM }, rimState), nRim: 0, bombs: Array.from({ length: BOMBS }, bombState),
      light: null, shock: null, draft: null, shockT: 0,
    }));

    function splat(x, z, radius, crack, heat, char, pattern, seed) {
      SPL.x = SPL.x2 = x; SPL.z = SPL.z2 = z; SPL.radius = radius; SPL.crack = crack; SPL.heat = heat; SPL.char = char;
      SPL.pattern = pattern; SPL.seed = seed; SPL.width = 0;
      fx.ground.splat(SPL);
    }
    function shock(pos, r1, duration, distortion) {
      SHK.pos.copy(pos).setY(0.04); SHK.radius1 = r1; SHK.duration = duration; SHK.distortion = distortion; SHK.thickness = 0.35 + r1 * 0.08;
      fx.shocks?.spawn(SHK);
    }
    // jet speed for a fountain h m tall (with a little extra for drag)
    const v0For = (h) => Math.sqrt(2 * 9.8 * Math.max(h, 0.1)) * (1 + 0.02 * h);
    function fire(e, pos, y, speed, n) { e.pos.copy(pos).setY(y); e.p.copy(UP); e.radial = speed; e.burst(n); }
    function stream(e, pos, y, speed, n, dt) { e.pos.copy(pos).setY(y); e.p.copy(UP); e.radial = speed; e.rate(n, dt); }

    // tinted blackbody for the glow kinds (the kind table has no tint), written as texels
    let lastT = -1, lastTint = '';
    const HOT = {
      jet: { w: { temp: [0, 0] }, t: { temp: null, color: [new THREE.Color(), new THREE.Color()] }, a: 1.06, b: 0.76 },
      core: { w: { temp: [0, 0] }, t: { temp: null, color: [new THREE.Color(), new THREE.Color()] }, a: 1.1, b: 0.93 },
      spray: { w: { temp: [0, 0] }, t: { temp: null, color: [new THREE.Color(), new THREE.Color()] }, a: 1.04, b: 0.6 },
      ember: { w: { temp: [0, 0] }, t: { temp: null, color: [new THREE.Color(), new THREE.Color()] }, a: 1.2, b: 0.6 },
      mass: { w: { temp: [0, 0] }, t: { temp: null, color: [new THREE.Color(), new THREE.Color()] }, a: 1.07, b: 0.82 },
    };
    const CLOT = { color: [new THREE.Color('#15100c'), new THREE.Color()] };
    const white = () => tintCol.r > 0.97 && tintCol.g > 0.97 && tintCol.b > 0.97;
    function hot(name, h, T) {
      if (white()) { h.w.temp[0] = T * h.a; h.w.temp[1] = T * h.b; P.setKind(name, h.w); return; }
      blackbodyRGB(T * h.a, h.t.color[0]).multiply(tintCol);
      blackbodyRGB(T * h.b, h.t.color[1]).multiply(tintCol).multiplyScalar((h.b / h.a) ** 3);
      P.setKind(name, h.t);
    }
    function retint() {
      const p = S.params;
      if (p.temperature === lastT && p.tint === lastTint) return;
      lastT = p.temperature; lastTint = p.tint;
      tintCol.set(p.tint); tint.set(tintCol.r, tintCol.g, tintCol.b);
      hot('lava-geyser.jet', HOT.jet, p.temperature); hot('lava-geyser.core', HOT.core, p.temperature);
      hot('lava-geyser.spray', HOT.spray, p.temperature); hot('lava-geyser.ember', HOT.ember, p.temperature);
      hot('lava-geyser.mass', HOT.mass, p.temperature);
      // blackbodyRGB is ~3.5 bright at 1400 K: the clots glow like earth.magma, ~ (5, 0.55, 0)
      blackbodyRGB(p.temperature, CLOT.color[1]).multiply(tintCol).multiplyScalar(1.4 * Math.pow(p.temperature / 1400, 4));
      P.setKind('lava-geyser.clot', CLOT);
    }
    retint();
    // the light's colour: blackbody chromaticity at unit brightness
    function lightColor(T, out) { blackbodyRGB(T, out).multiply(tintCol); const m = Math.max(out.r, out.g, out.b, 1e-4); return out.multiplyScalar(1 / m); }

    function setVent(st, p) {
      const m = st.vent;
      if (!m) return;
      const u = m.material.uniforms, D = 0.9 + 1.6 * p.width;
      u.uVent.value.set(st.pos.x, st.pos.z, st.R * 1.35 + 0.05, 0.004);
      u.uVentA.value.set(st.R, D, D * st.level, 0.16);
      u.uVentB.value.set(st.heat, p.temperature, p.intensity, U.uTime.value);
      u.uVentC.value.set(st.up, st.seedF, st.crust, p.haze);
    }

    function layout(c, p, st) {
      // the vent opens just short of the target, so the column stands beside it and the fan rains on it
      _a.set(c.to.x - c.from.x, 0, c.to.z - c.from.z);
      const dist = _a.length();
      st.pos.set(c.to.x, 0, c.to.z);
      if (dist > 2.5) st.pos.addScaledVector(_a, -Math.min(1.1, dist * 0.2) / dist);
      const rim = fx.ARENA.radius - 1.5;
      if (st.pos.length() > rim) st.pos.setLength(rim);
      st.seedF = (c.seed % 997) / 997;
      // the spatter rampart: broken slabs heaved up around the mouth, leaning out
      const n = Math.min(MAX_RIM, Math.round(p.rim)), R = p.width * 1.6 + 0.12;
      st.nRim = n;
      for (let k = 0; k < n; k++) {
        const s = st.rim[k], a = (k + 0.3 * fx.rand()) / Math.max(n, 1) * Math.PI * 2;
        s.radius = R * (0.55 + 0.35 * fx.rand()) + 0.1;
        s.height = p.rimHeight * (0.6 + 0.6 * fx.rand());
        s.pos.set(st.pos.x + Math.cos(a) * (R + s.radius * 0.5), 0, st.pos.z + Math.sin(a) * (R + s.radius * 0.5));
        s.dir.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.9 + 0.6 * fx.rand()).add(UP).normalize();
        s.delay = 0.08 + 0.25 * fx.rand();
        s.seed = ((c.seed * 37 + k * 7919) >>> 0) & 0xffffff || 1;
        s.h = null;
      }
    }

    function spawnRim(p, st) {
      for (let k = 0; k < st.nRim; k++) {
        const s = st.rim[k];
        SPK.pos.copy(s.pos); SPK.dir.copy(s.dir); SPK.height = s.height; SPK.radius = s.radius;
        SPK.delay = s.delay; SPK.rise = 0.7; SPK.life = S.timing.charge + 0.3 + p.duration + SUBSIDE * 0.5 + COOL * 0.6 - s.delay;
        SPK.heat = 0.12; SPK.seed = s.seed; SPK.crumble = 1.2;
        s.h = fx.spikes.spawn(SPK);
      }
    }
    const owns = (s) => s.h && s.h.active && s.h.seed === s.seed;

    function launchBomb(p, st, speed) {
      for (let i = 0; i < BOMBS; i++) {
        const b = st.bombs[i];
        if (b.alive) continue;
        b.trail = fx.trails.acquire();
        if (!b.trail) return;
        const a = fx.rand() * Math.PI * 2, tilt = 0.25 + 0.4 * fx.rand();
        b.pos.copy(st.pos).setY(0.4);
        b.vel.set(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).multiplyScalar(speed * (0.75 + 0.3 * fx.rand()));
        b.alive = true; b.t = 0;
        const t = b.trail;
        t.width = 0.09; t.intensity = 1.4 * p.intensity; t.glow = 2; t.glowIntensity = 0.15; t.fadeTime = 0.09; t.spacing = 0.08; t.distortion = 0;
        lightColor(p.temperature * 0.95, t.color);
        t.push(b.pos);
        // the bomb itself flies on the GPU along the same arc (a clot that crusts where it lands)
        bombE.pos.copy(b.pos); bombE.vel.copy(b.vel); bombE.size = 2.2; bombE.burst(1);
        return;
      }
    }
    function updateBombs(p, st, dt) {
      for (let i = 0; i < BOMBS; i++) {
        const b = st.bombs[i];
        if (!b.alive) continue;
        b.t += dt;
        b.vel.y -= 9.8 * dt;
        b.vel.multiplyScalar(1 - 0.04 * dt);
        b.pos.addScaledVector(b.vel, dt);
        // it darkens as it flies
        if (b.trail) { b.trail.push(b.pos); b.trail.intensity = 1.4 * p.intensity * Math.max(0.25, 1 - b.t * 0.3); }
        if (b.t < 1.6) { smokeE.pos.copy(b.pos); smokeE.vel.set(0, 0.4, 0); smokeE.size = 0.22; smokeE.rate(26 * p.plume, dt); }
        const r = Math.hypot(b.pos.x, b.pos.z);
        if (b.pos.y <= 0.08 || r > fx.ARENA.radius - 0.4 || b.t > 5) {
          if (b.pos.y <= 0.08 && r < fx.ARENA.radius - 0.4) {
            // landing: a scorch and a puff of dust (the GPU clot crusts into a cinder there)
            puff.pos.copy(b.pos).setY(0.1); puff.vel.set(0, 0.6, 0); puff.burst(5 * p.bombs);
            splat(b.pos.x, b.pos.z, 0.45, 0.9, 0.35, 0.35, 'radial', (i * 13 + 7) % 97);
          }
          b.trail?.release(); b.trail = null; b.alive = false;
        }
      }
    }

    function erupt(c, p, st) {
      st.erupted = true; st.te = 0; st.surgeV = 0.35 * p.surge; st.surgeT = 0.8;
      const H = p.height, v0 = v0For(H * 1.15);
      // the burst: the first column overshoots, rock and bombs fly, a pulse of ash
      fire(jet, st.pos, 0.1, v0, 520 * p.spatter);
      fire(core, st.pos, 0.1, v0 * 0.4, 140 * p.spatter);
      fire(mass, st.pos, 0.1, v0 * 0.6, 40 * p.spatter);
      fire(spray, st.pos, 0.15, 5, 220 * p.spatter);
      fire(clot, st.pos, 0.3, v0 * 0.7, 30 * p.bombs);
      fire(rockC, st.pos, 0.3, 6.5, 40 * p.bombs);
      fire(chunkC, st.pos, 0.3, 5.5, 8 * p.bombs);
      dust.pos.copy(st.pos).setY(0.15); dust.vel.set(0, 0.3, 0); dust.burst(60);
      plume.burst(st.pos, H, 40 * p.plume);
      for (let i = 0; i < 3; i++) launchBomb(p, st, v0 * 0.8);
      // the floor: a radial crack network, heat and char, a magma pool glow at the vent
      splat(st.pos.x, st.pos.z, 2.6, 2.0, 0.5, 0.45, 'radial', (c.seed + 3) % 97);
      splat(st.pos.x, st.pos.z, 1.2, 0.6, 0.6, 0.6, 'noise', (c.seed + 11) % 97);
      fx.impacts.add('magma', _a.copy(st.pos).setY(0.15), 1.5, 0.6, p.duration + SUBSIDE + COOL, lightColor(p.temperature, _col));
      shock(st.pos, 5.5, 0.55, 0.06);
      // a pressure shell on everything loose, then the draft the column pulls
      st.shock = fx.forces.acquire();
      if (st.shock) { st.shock.type = 4; st.shock.p[0] = 0.4; st.shock.p[1] = 1.4; st.shock.p[2] = 30; st.shock.p[3] = 0; st.shock.pos.copy(st.pos).setY(0.5); }
      st.shockT = 0;
      st.draft = fx.forces.acquire();
      if (st.draft) { const f = st.draft; f.type = 5; f.dir.set(0, 1, 0); f.p[0] = 3.5; f.p[1] = 1.3; f.p[2] = H + 3; f.p[3] = 0.9; f.pos.copy(st.pos).setY(-0.2); }
      // dummies: thrown off the vent, the close ones catch fire
      for (const dm of fx.dummies) {
        const d = Math.hypot(dm.pos.x - st.pos.x, dm.pos.z - st.pos.z), reach = 2.4 + p.width * 2;
        if (d < reach) {
          _b.set(dm.pos.x - st.pos.x, 0, dm.pos.z - st.pos.z);
          if (_b.lengthSq() < 1e-4) _b.set(1, 0, 0);
          _b.normalize().addScaledVector(UP, 0.8);
          dm.hit(_b, 2.2 * (1 - d / reach) + 0.4);
          if (d < reach * 0.7) dm.status.burn = Math.max(dm.status.burn, 0.9);
        }
      }
      // the pool hisses if the vent is near it
      const pool = fx.ARENA.pool;
      const px = Math.min(Math.max(st.pos.x, pool.center.x - pool.half.x), pool.center.x + pool.half.x), pz = Math.min(Math.max(st.pos.z, pool.center.y - pool.half.y), pool.center.y + pool.half.y);
      if (Math.hypot(px - st.pos.x, pz - st.pos.z) < 3) {
        fx.pool?.ripple?.(px, pz, 0.1, 1.6);
        seep.pos.set(px, 0.1, pz); seep.radius = 0.4; seep.vel.set(0, 1.5, 0); seep.size = 1.5; seep.burst(120 * p.plume);
      }
      fx.rig.shake(0.6 * p.shake, 7);
      fx.rig.shake(0.25 * p.shake, 16);
      if (!fx.reduced) { fx.rig.punch(2.6, 0.12); fx.rig.hitstop(0.05); }
      fx.flash(0.14 * p.intensity);
      const L = st.light;
      if (L) { L.type = 1; L.range = 9 + H * 0.6; L.shadow = true; L.intensity = 20 * p.intensity; L.pos.copy(st.pos).setY(0.3); L.end.copy(st.pos).setY(0.3 + H * 0.5); }
    }

    return {
      onParam(k) { if (k === 'tint' || k === 'temperature') retint(); },

      phase(c, name) {
        const p = S.params;
        if (name === 'charge') {
          retint();
          const st = c.data.g = states[c.index];
          st.erupted = false; st.spurt = false; st.te = 0; st.heat = 0.2; st.level = 1; st.up = 0; st.crust = 0.6; st.h = 0; st.env = 0;
          st.surgeV = 0; st.surgeT = 0; st.bombT = 0.4; st.splatT = 0; st.shockT = 0; st.R = 0.02;
          for (const b of st.bombs) { b.alive = false; b.trail = null; }
          layout(c, p, st);
          c.durations.linger = p.duration + SUBSIDE + COOL;
          st.vent = null;
          for (const m of vents) if (!m.visible) { st.vent = m; m.visible = true; break; }
          setVent(st, p);
          spawnRim(p, st);
          st.light = fx.lights.acquire();
          if (st.light) { st.light.type = 0; st.light.range = 5; st.light.intensity = 0; st.light.shadow = false; lightColor(p.temperature, st.light.color); st.light.pos.copy(st.pos).setY(0.35); }
        } else if (name === 'impact') {
          erupt(c, p, c.data.g);
        } else if (name === 'done') {
          const st = c.data.g;
          if (!st) return;
          for (let k = 0; k < st.nRim; k++) { const s = st.rim[k]; if (owns(s)) s.h.release(); s.h = null; }
          for (const b of st.bombs) { b.trail?.release(); b.trail = null; b.alive = false; }
          if (st.vent) st.vent.visible = false;
          st.vent = null;
          st.light?.release(); st.shock?.release(); st.draft?.release();
          st.light = st.shock = st.draft = null;
        }
      },

      update(c, dt) {
        const p = S.params, st = c.data.g, L = st.light;
        const flick = 0.84 + 0.1 * Math.sin(c.age * 23 + st.seedF * 9) * Math.sin(c.age * 9.7) + 0.06 * Math.sin(c.age * 61);
        if (!st.erupted) {
          // the ground bulges and cracks; the mouth opens over rising magma
          const k = Math.min(c.t / c.durations.charge, 1);
          st.R = (p.width * 1.25) * (0.15 + 0.85 * smooth(k / 0.7));
          st.level = 1 - 0.6 * smooth(k);
          st.heat = 0.35 + 0.6 * k; st.up = 0.5 * k; st.crust = 0.6 * (1 - k);
          setVent(st, p);
          for (let i = 0; i < st.nRim; i++) { const s = st.rim[i]; if (owns(s)) s.h.heat = 0.12 + 0.2 * k; }
          st.splatT -= dt;
          if (st.splatT <= 0) { st.splatT = 0.12; splat(st.pos.x, st.pos.z, 0.6 + 1.8 * k, 1.1 + 0.6 * k, 0.12 + 0.25 * k, 0.1, 'radial', c.seed % 97); }
          pebble.pos.copy(st.pos).setY(0.05); pebble.vel.set(0, 1.6 + 1.6 * k, 0); pebble.rate(160 * k * p.bombs, dt);
          seep.pos.copy(st.pos).setY(0.05); seep.radius = 0.6 + 1.2 * k; seep.vel.set(0, 1.2, 0); seep.size = 1; seep.rate(30 * p.plume, dt);
          ember.pos.copy(st.pos).setY(0.1); ember.vel.set(0, 2, 0); ember.rate(70 * k, dt);
          fx.rig.shake(dt * 2.4 * p.shake * (0.3 + k), 8);
          // a throat-clearing spurt just before the eruption
          if (!st.spurt && k > 0.68) {
            st.spurt = true;
            fire(core, st.pos, 0.1, 4.5, 50 * p.spatter); fire(spray, st.pos, 0.1, 3.5, 70 * p.spatter); fire(jet, st.pos, 0.1, v0For(1.2), 60 * p.spatter);
            fx.rig.shake(0.12 * p.shake, 10);
          }
          if (L) L.intensity = 6 * p.intensity * k * k * flick;
          return;
        }

        st.te += dt;
        const te = st.te, dur = p.duration;
        // the fountain: full, then dies back over SUBSIDE; surges ride on top
        st.env = 1 - smooth((te - dur) / SUBSIDE);
        const cool = smooth((te - dur - SUBSIDE * 0.5) / COOL);
        st.surgeT -= dt;
        if (st.surgeT <= 0 && st.env > 0.3) { st.surgeT = (0.9 + 0.9 * fx.rand()) / Math.max(0.35, Math.sqrt(p.surge)); st.surgeV = Math.max(st.surgeV, (0.15 + 0.3 * fx.rand()) * p.surge); if (p.surge > 1.4) plume.burst(st.pos, st.h, 12 * p.plume * p.surge); }
        st.surgeV *= Math.exp(-dt / 0.45);
        const wob = 0.86 + 0.08 * Math.sin(c.age * 3.1 + st.seedF * 7) + 0.06 * Math.sin(c.age * 7.3);
        st.h = p.height * st.env * wob * (1 + st.surgeV);
        const env = st.env, v0 = v0For(st.h);
        if (env > 0.01) {
          jet.radius = fan.radius = p.width * 0.75; mass.radius = p.width * 0.5; core.radius = p.width * 0.55;
          stream(jet, st.pos, 0.1, v0, 1300 * p.spatter * env * (0.7 + 0.6 * st.surgeV), dt);
          stream(jet, st.pos, 0.1, v0 * 0.72, 300 * p.spatter * env, dt);
          stream(fan, st.pos, 0.1, v0 * 0.88, 420 * p.spatter * env, dt);   // the falling curtain spreads wide
          stream(mass, st.pos, 0.1, v0 * (0.55 + 0.15 * fx.rand()), 70 * p.spatter * env, dt);
          stream(core, st.pos, 0.1, v0 * 0.3 + 1, 500 * p.spatter * env, dt);
          stream(spray, st.pos, 0.15, 3 + 2 * env, 120 * p.spatter * env, dt);
          stream(clot, st.pos, 0.3, v0 * 0.7, 16 * p.bombs * env * (1 + 2 * st.surgeV), dt);
          ember.pos.copy(st.pos).setY(0.4 + st.h * 0.3); ember.vel.set(0, 3, 0); ember.rate(90 * env, dt);
          st.bombT -= dt;
          if (st.bombT <= 0 && env > 0.4 && p.bombs > 0) { st.bombT = (0.35 + 0.6 * fx.rand()) / p.bombs; launchBomb(p, st, v0 * 0.8); }
        } else if (cool < 0.8) {
          // last gasps: the vent spits now and then
          st.bombT -= dt;
          if (st.bombT <= 0) { st.bombT = 0.3 + 0.5 * fx.rand(); fire(spray, st.pos, 0.1, 2.5, 18 * p.spatter * (1 - cool)); }
        }
        plume.update(st.pos, Math.max(st.h, 1.2), dt, Math.max(env, 0.25 * (1 - cool)), p);
        updateBombs(p, st, dt);

        // the vent drains as the fountain dies, then crusts and cools
        st.level = 0.4 + 0.45 * (1 - env);
        st.up = env * (0.6 + 0.4 * st.surgeV);
        st.heat = (0.85 + 0.15 * env) * (1 - 0.75 * cool) * (0.95 + 0.05 * flick);
        st.crust = 0.35 * (1 - env) + 0.65 * cool;
        st.R = p.width * 1.25 * (1 - 0.25 * cool);
        setVent(st, p);
        for (let i = 0; i < st.nRim; i++) { const s = st.rim[i]; if (owns(s)) s.h.heat = 0.38 * st.heat * (1 - cool); }
        st.splatT -= dt;
        if (st.splatT <= 0 && st.heat > 0.1) { st.splatT = 0.3; splat(st.pos.x, st.pos.z, 1.3, 0, 0.35 * st.heat * (1 - cool), 0.04, 'radial', c.seed % 97); }

        // forces: the pressure shell expands and goes; the draft follows the column
        if (st.shock) {
          st.shockT += dt;
          st.shock.p[0] = 0.4 + 8 * Math.pow(Math.min(st.shockT / 0.6, 1), 0.6);
          st.shock.p[2] = 30 * (1 - st.shockT / 0.6);
          if (st.shockT > 0.6) { st.shock.release(); st.shock = null; }
        }
        if (st.draft) { st.draft.p[2] = st.h + 3; st.draft.p[3] = 0.9 * env; }
        // fallout: whatever stands under the fan burns
        if (env > 0.3) {
          const fan = 0.8 + st.h * 0.18;
          for (const dm of fx.dummies) if (Math.hypot(dm.pos.x - st.pos.x, dm.pos.z - st.pos.z) < fan) dm.status.burn = Math.max(dm.status.burn, 0.6 * env);
        }
        fx.rig.shake(dt * 1.2 * p.shake * env * (0.5 + st.surgeV), 9);
        // the column is a vertical lamp: brighter and taller with each surge
        if (L) {
          L.end.copy(st.pos).setY(0.3 + Math.max(st.h, 0.3) * 0.5);
          L.intensity = Math.max(L.intensity * Math.exp(-dt / 0.25), (16 * env * (1 + 0.6 * st.surgeV) + 2.5 * st.heat * (1 - cool)) * p.intensity * flick);
        }
      },
    };
  },
};
