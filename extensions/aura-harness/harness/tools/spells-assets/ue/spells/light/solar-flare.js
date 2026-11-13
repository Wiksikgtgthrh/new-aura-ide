import * as THREE from 'three';
import { ARENA, arenaSDF } from '../../vfx/common.js';
import { createStars, LOOP_PATH, LOOP_SHADE, BURST_GLSL, loopPoint } from './solar-flare.glsl.js';

// Solar Flare (SPELLBOOK, Light hero). References: SDO/AIA 171 and 304 movies of active-region
// flares and prominence eruptions, Hinode SOT granulation. A miniature sun ignites in front of a holy
// sigil at the focus: motes pour in, it swells, breathes in, and launches. In flight it is a
// ray-traced photosphere (boiling granulation, plage, filaments, spots, limb darkening) inside a
// spicule rim and a faint corona with heat haze; bundles of fine plasma strands arch off its limb,
// brighten and drain. It sheds a plasma wake and lights the floor and pillars as it passes.
// On impact the sun bursts and the flare erupts, as in the standard (CSHKP) flare picture:
//   - the prominence lifts off: a twisted flux rope of red-orange strands, anchored at both ends
//     of the polarity line, rises, swells and accelerates away as it fades
//   - beneath it an arcade of post-flare loops forms along the line, one after another, each a
//     bundle of fine strands: hot and white-gold along their length, then cooling, the light
//     draining into their legs, coronal rain dripping off their tops and painting the floor
//   - two flare ribbons burn on the floor under the footpoints and spread apart (glow, two line
//     lights), footpoints spit sparks, a shock runs out, then an updraft lifts motes through it.

const MAX_SUNS = 3;
const SURF = 4, SS = 5;              // surface loops on the star, strands per loop
const ARC = 9, AS = 10, RS = 20;     // arcade loops, strands per arcade loop (1 haze + 9 threads), flux-rope strands
const ROPE = ARC;                    // loop index of the flux rope
const NL = ARC + 1, MAXSTR = ARC * AS + RS;
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _m = new THREE.Vector3(), _e = new THREE.Vector3(), _v = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);
const clamp = THREE.MathUtils.clamp, sstep = THREE.MathUtils.smoothstep;
const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
// reused option objects (the systems copy what they need)
const SPLAT = { x: 0, z: 0, x2: 0, z2: 0, radius: 1, heat: 0, char: 0, glow: 0, pattern: 'radial', seed: 0, width: 0 };
const SHOCK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 6, duration: 0.6, thickness: 0.6, distortion: 0.05, color: null, intensity: 0, ground: true };
const SIGIL = { pos: new THREE.Vector3(), normal: new THREE.Vector3(), radius: 0.9, color: null, intensity: 0, reveal: 0, rotation: 0, style: 'holy', seed: 0 };

export default {
  id: 'solar-flare', name: 'Solar Flare', element: 'light', order: 10, hue: '#ffc04a',
  shape: 'projectile', speed: 8, radius: 0.4,
  params: { size: 1, speed: 8, intensity: 1, pulse: 1, loops: 1, flare: 1, granules: 8, corona: 1, sparks: 1, glow: 1, haze: 1, core: '#ffd27a', color: '#ff560c' },
  ranges: {
    size: [0.5, 2, 0.01], speed: [3, 20, 0.1], intensity: [0, 3, 0.01], pulse: [0, 2, 0.01], loops: [0, 3, 0.01], flare: [0.4, 2, 0.01],
    granules: [2, 14, 0.1], corona: [0, 3, 0.01], sparks: [0, 3, 0.01], glow: [0, 3, 0.01], haze: [0, 3, 0.01],
  },
  presets: {
    'red dwarf': { core: '#ffd2a0', color: '#ff3a12', size: 0.8, speed: 6, pulse: 1.6, granules: 5 },
    'blue giant': { core: '#f0f5ff', color: '#4a86ff', size: 1.35, speed: 7, flare: 1.25, granules: 11, corona: 1.4 },
    'white dwarf': { core: '#ffffff', color: '#ffd090', size: 0.65, speed: 12, intensity: 1.6, pulse: 2, flare: 0.8 },
  },
  timing: { charge: 0.9, impact: 0.5, linger: 2.8 },
  kinds: {
    plasma: { style: 'glow', drag: 1.6, buoyancy: 0.6, curl: 1.8, curlScale: 0.7, forceResponse: 0.6, life: [0.3, 0.75], size: [0.014, 0.004], stretch: 0.03, emissive: 3, color: ['#ffd890', '#ff4a0c'], alpha: [1, 0], fadeIn: 0.08, fadeOut: 0.4 },
    ember: { style: 'glow', drag: 0.9, buoyancy: 1.1, curl: 2.4, curlScale: 0.5, forceResponse: 0.8, life: [1.2, 2.8], size: [0.024, 0.006], stretch: 0.015, emissive: 4, color: ['#ffd890', '#ff5a12'], alpha: [1, 0], fadeIn: 0.1, fadeOut: 0.5, restitution: 0.3, friction: 0.5 },
    // coronal rain: drips off the loop tops, falls, and paints glow where it lands
    rain: { style: 'glow', drag: 0.3, gravity: 7, life: [0.5, 1.0], size: [0.03, 0.012], stretch: 0.045, emissive: 8, color: ['#fff4d0', '#ff8a20'], alpha: [1, 0.2], fadeIn: 0.05, restitution: 0.15, friction: 0.7, paints: 'glow', paintAmount: 0.06 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const gather = P.emitter('light.mote', { shape: 'shell', radius: 1.6, spread: 0.2, radial: -2.8, life: 0.32 });
    const motes = P.emitter('light.mote', { shape: 'disk', radius: 1.5, spread: 0.6 });
    const spark = P.emitter('light.spark', { shape: 'sphere', radius: 0.25, spread: 3, radial: 5 });
    const footSpark = P.emitter('light.spark', { shape: 'sphere', radius: 0.08, spread: 2.2, radial: 2.5 });
    const plasma = P.emitter('solar-flare.plasma', { shape: 'shell', radius: 0.4, spread: 0.5, radial: 0.3 });
    const ember = P.emitter('solar-flare.ember', { shape: 'disk', radius: 1.2, spread: 0.6 });
    const rain = P.emitter('solar-flare.rain', { shape: 'sphere', radius: 0.05, spread: 0.3 });

    // colours: parsed only when the param strings change (Color.set allocates)
    const coreCol = new THREE.Color(), glowCol = new THREE.Color(), loopCol = new THREE.Color(), lightCol = new THREE.Color(), hotCol = new THREE.Color(), promCol = new THREE.Color(), hue = new THREE.Color(this.hue);
    let coreHex = '', glowHex = '';
    function colours(p) {
      if (p.core === coreHex && p.color === glowHex) return;
      coreHex = p.core; glowHex = p.color;
      coreCol.set(p.core); glowCol.set(p.color);
      loopCol.copy(glowCol).lerp(coreCol, 0.45);
      lightCol.copy(glowCol).lerp(coreCol, 0.5);
      hotCol.copy(coreCol);
      promCol.copy(glowCol).lerp(coreCol, 0.2);
    }
    SHOCK.color = glowCol;
    SIGIL.color = loopCol;

    const stars = createStars(fx, MAX_SUNS);
    const bursts = [];
    for (let i = 0; i < MAX_SUNS; i++) {
      const v = fx.volumes.add({
        shape: 'sphere', glsl: BURST_GLSL, maxSteps: 16,
        uniforms: { uBurst: { value: new THREE.Vector4(1, 0, 0, 0) }, uBurstPos: { value: new THREE.Vector3() }, uBurstCore: { value: coreCol }, uBurstCol: { value: glowCol } },
      });
      v.busy = false;
      bursts.push(v);
    }
    const loops = new fx.AnalyticRibbons({ max: 224, segments: 40, pathGLSL: LOOP_PATH, shadeGLSL: LOOP_SHADE, target: 'lines' });
    fx.scenes.lines.add(loops.mesh);

    // per cast record (cast.js keeps 16): no allocation per cast
    const v3s = (n) => Array.from({ length: n }, () => new THREE.Vector3());
    const ST = Array.from({ length: 16 }, () => ({
      star: null, burst: null, light: null, sigil: null, force: null, rib: [null, null],
      str: new Array(MAXSTR).fill(null), sl: new Uint8Array(MAXSTR), ss: new Float32Array(MAXSTR), nStr: 0,
      la: v3s(SURF), lb: v3s(SURF), lt0: new Float64Array(SURF), llife: new Float32Array(SURF), lh: new Float32Array(SURF),
      fa: v3s(NL), fb: v3s(NL), fu: v3s(NL), fh: new Float32Array(NL), fw: new Float32Array(NL), fdelay: new Float32Array(NL), nLoop: 0,
      G: new THREE.Vector3(), prev: new THREE.Vector3(), P: new THREE.Vector3(), Q: new THREE.Vector3(),
      R0: 0, dist: 0, total: 0, ph: 0, pulseN: -1, pulse: 0, splatT: 0, frame: 0, age: 0, shockR: 0, rot: 0, inPool: false, ribT: 0,
    }));

    function splat(x, z, radius, heat, char, glow, pattern, seed, width = 0, x2 = x, z2 = z) {
      SPLAT.x = x; SPLAT.z = z; SPLAT.x2 = x2; SPLAT.z2 = z2; SPLAT.radius = radius; SPLAT.heat = heat; SPLAT.char = char; SPLAT.glow = glow;
      SPLAT.pattern = pattern; SPLAT.seed = seed % 100; SPLAT.width = width;
      fx.ground.splat(SPLAT);
    }
    const focus = (k) => fx.arena.setFocus(hue, k);

    function placeStar(st, pos, R, I, p, d) {
      const u = st.u;
      st.core.visible = st.corona.visible = R > 1e-3;
      u.uStarA.value.set(pos.x, pos.y, pos.z, R);
      u.uStarB.value.set(p.granules, 0.3, d.pulse * p.pulse * 0.35, I);
      u.uStarC.value.set(0.9 * p.corona, 2.6, 0.3, 0.06 * p.haze);
      u.uStarD.value.w = 0;
      u.uStarCore.value.copy(coreCol);
      u.uStarLimb.value.copy(glowCol);
    }

    // the star's slow flicker: brightenings every half second or so, never a strobe
    function pulseClock(c, d) {
      const T = 0.55, n = Math.floor(c.age / T), tp = c.age - n * T;
      if (n !== d.pulseN) d.pulseN = n;
      d.pulse = tp < 0.08 ? tp / 0.08 : Math.exp(-(tp - 0.08) / 0.2);
    }

    // a surface loop in the star's turning frame, biased to the limb so it reads in silhouette
    function spawnLoop(c, d, i) {
      const z = 2 * fx.rand() - 1, az = fx.rand() * 6.2832, s = Math.sqrt(1 - z * z);
      _m.set(s * Math.cos(az), z, s * Math.sin(az));
      _v.subVectors(c.pos, fx.camera.position).normalize();
      _m.addScaledVector(_v, -_v.dot(_m) * 0.7).normalize();
      const a = 0.3 * fx.U.uTime.value, ca = Math.cos(a), sa = Math.sin(a);   // world -> star frame
      _m.set(ca * _m.x - sa * _m.z, _m.y, sa * _m.x + ca * _m.z);
      _e.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).cross(_m);
      if (_e.lengthSq() < 1e-6) _e.set(1, 0, 0).cross(_m);
      _e.normalize();
      const ang = 0.14 + 0.22 * fx.rand();
      d.la[i].copy(_m).multiplyScalar(Math.cos(ang)).addScaledVector(_e, -Math.sin(ang));
      d.lb[i].copy(_m).multiplyScalar(Math.cos(ang)).addScaledVector(_e, Math.sin(ang));
      d.lt0[i] = c.age;
      d.llife[i] = 0.8 + 0.7 * fx.rand();
      d.lh[i] = 0.3 + 0.5 * fx.rand();
    }

    function surfaceLoops(c, d, p, R, gate) {
      const a = 0.3 * fx.U.uTime.value, ca = Math.cos(a), sa = Math.sin(a), C = c.pos;
      for (let i = 0; i < SURF; i++) {
        let x = (c.age - d.lt0[i]) / d.llife[i];
        if (x >= 1 || x < 0) { spawnLoop(c, d, i); x = 0; }
        // rises, holds while it brightens and drains, sags a little as it fades
        const h = d.lh[i] * (1 - (1 - Math.min(x / 0.3, 1)) ** 3) * (1 - 0.2 * sstep(x, 0.6, 1));
        const vis = sstep(x, 0, 0.18) * (1 - sstep(x, 0.65, 1)), heat = 1 - sstep(x, 0.2, 0.9);
        // star frame -> world (the inverse of the shader's spin)
        const A = d.la[i], B = d.lb[i];
        _a.set(ca * A.x + sa * A.z, A.y, -sa * A.x + ca * A.z);
        _b.set(ca * B.x + sa * B.z, B.y, -sa * B.x + ca * B.z);
        _c.addVectors(_a, _b);
        const sag = R * (1 - 0.5 * _c.length());
        _c.normalize();
        for (let s = 0; s < SS; s++) {
          const hd = d.str[i * SS + s];
          if (!hd) continue;
          hd.p0.set(C.x + _a.x * R, C.y + _a.y * R, C.z + _a.z * R, 0.014 * R);
          hd.p1.set(C.x + _b.x * R, C.y + _b.y * R, C.z + _b.z * R, sag + h * R);
          hd.p2.set(_c.x, _c.y, _c.z, 0.07 * R);
          hd.p3.set(d.ss[i * SS + s], 0.6, 0.35, heat);
          hd.color.copy(glowCol).lerp(hotCol, heat);
          hd.intensity = 5 * p.loops * p.intensity * vis * gate * (0.75 + 0.25 * Math.sin(c.age * (5 + s) + s * 2.1));
        }
      }
    }

    function dropStrands(d) {
      for (let k = 0; k < d.nStr; k++) { d.str[k]?.release(); d.str[k] = null; }
      d.nStr = 0;
    }
    function takeStrands(d, n) {
      dropStrands(d);
      for (let k = 0; k < n; k++) {
        const h = loops.acquire();
        if (!h) break;
        h.intensity = 0; d.str[k] = h; d.ss[k] = fx.rand(); d.nStr = k + 1;
      }
    }

    return {
      onParam(k) { if (k === 'core' || k === 'color') colours(S.params); },
      tick() { loops.update(); },

      travel(c, dt) {
        const p = S.params, d = ST[c.index];
        d.dist += p.speed * dt;
        d.prev.copy(c.pos);
        c.pos.copy(c.from).addScaledVector(c.dir, Math.min(d.dist, d.total)).addScaledVector(UP, Math.sin(c.t * 5.3 + d.ph) * 0.06 * Math.min(1, d.dist));
        if (dt > 0) c.vel.subVectors(c.pos, d.prev).divideScalar(dt);
        c.travelled = d.dist;
        return d.dist >= d.total || (d.dist > 1 && arenaSDF(c.pos) < 0.8 * d.R0) || c.t > 10;
      },

      phase(c, name) {
        const p = S.params, d = ST[c.index];
        colours(p);
        if (name === 'charge') {
          d.R0 = 0.5 * p.size; d.dist = 0; d.total = c.from.distanceTo(c.to); d.ph = fx.rand() * 6.28;
          d.pulseN = -1; d.pulse = 0; d.splatT = 0; d.frame = 0; d.age = 0; d.shockR = 0; d.nLoop = 0; d.ribT = 0;
          d.rot = (c.seed % 628) / 100;
          d.star = null;
          for (const st of stars) if (!st.busy) { d.star = st; break; }
          if (d.star) { d.star.busy = true; d.star.u.uStarD.value.set((c.seed % 97) * 0.173, 0.66, 0.5, 0); placeStar(d.star, c.from, 0, 0, p, d); }
          d.light = fx.lights.acquire();
          if (d.light) { d.light.type = 0; d.light.range = 7; d.light.intensity = 0; d.light.shadow = true; d.light.color.copy(lightCol); d.light.pos.copy(c.from); }
          SIGIL.pos.copy(c.from).addScaledVector(c.dir, 0.05); SIGIL.normal.copy(c.dir); SIGIL.radius = 0.95 * p.size; SIGIL.seed = c.seed % 1000; SIGIL.rotation = d.rot;
          d.sigil = fx.sigils.acquire(SIGIL);
          if (d.sigil) { d.sigil.reveal = 0; d.sigil.intensity = 0; }
          d.force = null; d.rib[0] = d.rib[1] = null;
          for (let i = 0; i < SURF; i++) { d.lt0[i] = -99; d.llife[i] = 1; }
          takeStrands(d, SURF * SS);
        } else if (name === 'release') {
          fx.flash(0.08 * p.intensity);
          fx.rig.shake(0.15, 10);
          spark.pos.copy(c.from); spark.radius = d.R0; spark.vel.copy(c.dir).multiplyScalar(4); spark.burst(120 * p.sparks);
        } else if (name === 'impact') {
          slam(c, p, d);
        } else if (name === 'done') {
          if (d.star) { d.star.busy = false; d.star.core.visible = d.star.corona.visible = false; d.star.u.uStarA.value.w = 0; }
          if (d.burst) { d.burst.visible = false; d.burst.busy = false; }
          dropStrands(d);
          d.light?.release(); d.sigil?.release(); d.force?.release(); d.rib[0]?.release(); d.rib[1]?.release();
          d.star = d.burst = d.light = d.sigil = d.force = d.rib[0] = d.rib[1] = null;
          focus(2.5);
        }
      },

      update(c, dt) {
        const p = S.params, d = ST[c.index], L = d.light, I = p.intensity;
        colours(p);
        d.frame++;
        d.rot += dt * (c.phase === 'charge' ? 1.4 : 3);
        if (d.sigil) d.sigil.rotation = d.rot;
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge;
          // ignite, swell with an overshoot, then breathe in before the launch
          const R = d.R0 * easeOutBack(sstep(k, 0.12, 0.72)) * (1 - 0.12 * sstep(k, 0.82, 1)) * (1 + 0.03 * Math.sin(c.age * 31) * k);
          pulseClock(c, d);
          d.pulse *= sstep(k, 0.4, 0.8);
          if (d.star) placeStar(d.star, c.from, R, (2 + 3 * k) * I, p, d);
          surfaceLoops(c, d, p, R, sstep(k, 0.4, 0.85));
          gather.pos.copy(c.from); gather.rate(700 * (1 - k) * p.sparks, dt);
          if (L) { L.pos.copy(c.from); L.intensity = 16 * k * k * I; }
          if (d.sigil) { d.sigil.reveal = sstep(k, 0, 0.8); d.sigil.intensity = (1 + 2.5 * k) * I; }
          focus(2.5 * (1 - k) * (1 - k) + 0.15);   // the orb's light is drawn into the sun
          return;
        }
        if (c.phase === 'travel') {
          pulseClock(c, d);
          const R = d.R0 * (0.88 + 0.12 * easeOutBack(Math.min(c.t / 0.18, 1))) * (1 + 0.03 * d.pulse * p.pulse);
          if (d.star) placeStar(d.star, c.pos, R, 4 * I, p, d);
          surfaceLoops(c, d, p, R, 1);
          // a wake of plasma shed behind it, not a halo round it
          plasma.pos.copy(c.pos); plasma.radius = R * 0.9; plasma.vel.copy(c.vel).multiplyScalar(0.45); plasma.rate(70 * p.sparks, dt);
          spark.pos.copy(c.pos); spark.radius = R * 0.8; spark.vel.copy(c.vel).multiplyScalar(0.3); spark.rate(18 * p.sparks * (1 + 2 * d.pulse), dt);
          if (L) { L.pos.copy(c.pos); L.range = 9; L.intensity = (18 + 8 * d.pulse * p.pulse) * I; }
          focus(Math.min(2.5, 0.15 + c.t * 3));
          if (d.sigil) {   // the sigil unwinds behind the launch
            const x = c.t / 0.5;
            d.sigil.reveal = 1 - sstep(x, 0, 1); d.sigil.intensity = 3 * I * (1 - x);
            if (x >= 1) { d.sigil.release(); d.sigil = null; }
          }
          // the floor glows under the sun as it passes
          d.splatT -= dt;
          if (d.splatT <= 0 && c.pos.y < 3.2) { d.splatT = 0.1; splat(c.pos.x, c.pos.z, 0.75 * p.size, 0.08, 0, 0.35 * p.glow * (1 - c.pos.y / 3.2), 'radial', c.seed + d.frame); }
          for (const dm of fx.dummies) {
            const dist = Math.hypot(dm.pos.x - c.pos.x, dm.pos.z - c.pos.z);
            if (dist < 1.6 * p.size) dm.status.burn = Math.max(dm.status.burn, 0.35 * (1 - dist / (1.6 * p.size)));
          }
          return;
        }
        // impact + linger: the burst, the eruption, the arcade
        d.age += dt;
        const tt = d.age, lx = c.phase === 'linger' ? c.t / c.durations.linger : 0;
        if (d.star) {
          const R = d.R0 * (1 + 0.5 * sstep(tt, 0, 0.04)) * (1 - sstep(tt, 0.03, 0.14));
          placeStar(d.star, c.pos, R, 6 * I * (1 + 3 * sstep(tt, 0, 0.05)), p, d);
          if (R <= 1e-3) { d.star.busy = false; d.star.core.visible = d.star.corona.visible = false; d.star.u.uStarA.value.w = 0; d.star = null; }
        }
        const v = d.burst;
        if (v) {
          if (tt > 0.6) { v.visible = false; v.busy = false; d.burst = null; }
          else {
            const fl = p.flare * p.size, R = 0.3 + 0.65 * fl * (1 - Math.exp(-tt * 9));
            v.position.copy(c.pos); v.scale.setScalar(R * 1.02);
            v.uniforms.uBurst.value.set(R, tt, 1.5 * I * (1 - sstep(tt, 0.08, 0.45)), (c.seed % 89) * 0.37);
            v.uniforms.uBurstPos.value.copy(c.pos);
          }
        }
        flare(c, d, p, tt, lx, dt);
        // the shock shell runs out and lets go, then the handle becomes an updraft over the arcade
        const F = d.force;
        if (F && F.type === 4) {
          d.shockR += dt * 14;
          F.p[0] = d.shockR; F.p[2] = 60 * p.flare * Math.max(0, 1 - d.shockR / 8);
          if (d.shockR > 8) { F.type = 1; F.pos.copy(d.G); F.dir.set(0, 1, 0); F.p[0] = 1.1 * p.flare * p.size; F.p[1] = 3; F.p[2] = 2.4; F.p[3] = 0.6; F.w = 4 * p.flare * p.size; }
        }
        if (F && F.type === 1) F.p[2] = 2.4 * (1 - lx);
        const G = d.G, fl = p.flare * p.size;
        if (L) {
          L.pos.copy(G).setY(G.y + 1.4 * fl + 1.5 * sstep(tt, 0, 1.2));
          const flick = 0.85 + 0.15 * Math.sin(c.age * 29 + c.seed) * Math.sin(c.age * 11.3);
          L.intensity = (100 * Math.exp(-tt / 0.14) + 34 * (1 - lx) ** 1.5 * flick) * I;
        }
        if (lx < 0.8) {
          motes.pos.copy(G).setY(G.y + 0.05); motes.radius = 1.4 * fl; motes.vel.set(0, 1.4, 0); motes.rate(60 * p.sparks * (1 - lx), dt);
          ember.pos.copy(G).setY(G.y + 0.1); ember.radius = 1.2 * fl; ember.vel.set(0, 1.2, 0); ember.rate(60 * p.sparks * (1 - lx), dt);
        }
        for (const dm of fx.dummies) if (Math.hypot(dm.pos.x - G.x, dm.pos.z - G.z) < 2 * fl) dm.status.burn = Math.max(dm.status.burn, 0.6 * (1 - lx));
        focus(2.5);
      },
    };

    // the sun lands: the burst, the eruption and the arcade, the shock, the world's response
    function slam(c, p, d) {
      const I = p.intensity, fl = p.flare * p.size, pos = c.pos;
      const pool = ARENA.pool;
      d.inPool = Math.abs(pos.x - pool.center.x) < pool.half.x && Math.abs(pos.z - pool.center.y) < pool.half.y;
      d.G.set(pos.x, d.inPool ? pool.water : 0, pos.z);
      d.age = 0; d.ribT = 0;
      const G = d.G;
      fx.flash(0.35 * I);
      fx.rig.shake(0.5, 12);
      if (!fx.reduced) { fx.rig.punch(2.5, 0.08); fx.rig.hitstop(0.06); }
      // the polarity line runs along the flight; the arcade's loops span across it
      d.P.set(c.dir.x, 0, c.dir.z);
      if (d.P.lengthSq() < 1e-6) d.P.set(0, 0, -1);
      d.P.normalize(); d.Q.set(-d.P.z, 0, d.P.x);
      layout(d, fl, 0);
      takeStrands(d, MAXSTR);
      for (let k = 0; k < d.nStr; k++) d.sl[k] = k < ARC * AS ? Math.floor(k / AS) : ROPE;
      // each arcade thread's place across its flux tube, stratified core -> rim (strand 0 is the haze)
      for (let k = 0; k < Math.min(d.nStr, ARC * AS); k++) if (k % AS) d.ss[k] = (k % AS - 1 + fx.rand()) / (AS - 1);
      d.nLoop = NL;
      // the sun bursts
      d.burst = null;
      for (const v of bursts) if (!v.busy) { d.burst = v; break; }
      if (d.burst) { d.burst.busy = true; d.burst.visible = true; d.burst.position.copy(pos); d.burst.scale.setScalar(0.4); d.burst.uniforms.uBurst.value.set(0.35, 0, 0, 0); d.burst.uniforms.uBurstPos.value.copy(pos); }
      spark.pos.copy(pos); spark.radius = 0.3; spark.vel.set(0, 2, 0); spark.burst(30 * p.sparks);
      plasma.pos.copy(pos); plasma.radius = 0.5; plasma.vel.set(0, 1.5, 0); plasma.radial = 2.5; plasma.burst(160 * p.sparks); plasma.radial = 0.3;
      motes.pos.copy(G).setY(G.y + 0.05); motes.radius = 1.6 * fl; motes.vel.set(0, 3, 0); motes.spread = 1.4; motes.burst(90 * p.sparks); motes.spread = 0.6;
      SHOCK.pos.copy(G).setY(G.y + 0.02); SHOCK.radius0 = 0.5; SHOCK.radius1 = 7 * fl; SHOCK.duration = 0.7; SHOCK.thickness = 0.7; SHOCK.distortion = 0.04 * p.haze; SHOCK.intensity = 0.25 * I; SHOCK.ground = true;
      fx.shocks?.spawn(SHOCK);
      SHOCK.pos.copy(pos); SHOCK.radius0 = 0.3; SHOCK.radius1 = 4.5 * fl; SHOCK.duration = 0.45; SHOCK.thickness = 0.9; SHOCK.distortion = 0.09 * p.haze; SHOCK.intensity = 0; SHOCK.ground = false;
      fx.shocks?.spawn(SHOCK);
      // the floor: a scorched, glowing kernel where it landed
      splat(G.x, G.z, 1.2 * fl, 0.9, 0.35, 0, 'noise', c.seed);
      splat(G.x, G.z, 0.9 * fl, 0, 0, 1.6 * p.glow, 'radial', c.seed + 2);
      fx.impacts.add('holy', _a.copy(G).setY(G.y + 0.8), 3.2 * fl, 1.3 * p.glow, 4, lightCol);
      fx.impacts.add('scorch', G, 1.6 * fl, 0.6, 6, glowCol);
      d.force = fx.forces.acquire();
      if (d.force) { const F = d.force; F.type = 4; F.pos.copy(pos); F.p[0] = 0.3; F.p[1] = 1.2; F.p[2] = 60 * p.flare; F.p[3] = 0; d.shockR = 0.3; }
      if (d.light) { d.light.range = 12 * Math.sqrt(fl); d.light.pos.copy(G).setY(G.y + 1.4); }
      // the two flare ribbons light the arena from the floor (point lights: a line light's glint on
      // the polished floor reads as a hard neon bar)
      for (let r = 0; r < 2; r++) {
        const h = fx.lights.acquire();
        d.rib[r] = h;
        if (h) { h.type = 0; h.range = 6 * Math.sqrt(fl); h.intensity = 0; h.shadow = false; h.color.copy(lightCol); }
      }
      for (const dm of fx.dummies) {
        const dist = Math.hypot(dm.pos.x - pos.x, dm.pos.z - pos.z), reach = 3.2 * fl;
        if (dist > reach) continue;
        dm.status.burn = Math.max(dm.status.burn, 1 - dist / reach + 0.3);
        dm.hit(dist > 0.05 ? _a.subVectors(dm.pos, pos).setY(0) : c.dir, 0.9 * (1 - dist / reach) + 0.2);
      }
      // the pool lights up from inside and ripples
      const px = clamp(pos.x, pool.center.x - pool.half.x, pool.center.x + pool.half.x), pz = clamp(pos.z, pool.center.y - pool.half.y, pool.center.y + pool.half.y);
      if (Math.hypot(px - pos.x, pz - pos.z) < 3.5) { fx.pool.ripple(px, pz, 0.05, 1.2); fx.pool.flash(lightCol, 0.8 * I); }
    }

    // ribbon half-separation at age tt: the ribbons spread apart as reconnection climbs
    function ribW(fl, tt) { return fl * (0.45 + 0.55 * sstep(tt, 0.1, 2.6)); }

    // feet, apex direction, height, tube radius and onset of every loop (arcade by order of formation)
    function layout(d, fl, tt) {
      const G = d.G, Pv = d.P, Qv = d.Q;
      // a packed row of loops (TRACE / AIA post-flare arcades): the whole arcade leans one way out of
      // its loops' planes, each loop with its own height, span and a little in-plane asymmetry; they
      // form one after another along the row
      const lean = 0.2 + 0.25 * fx.rand();
      for (let j = 0; j < ARC; j++) {
        const u = j / (ARC - 1);
        const along = (u - 0.5) * 2.8 * fl + 0.06 * fl * (fx.rand() - 0.5);
        const w = fl * (0.4 + 0.14 * fx.rand() + 0.1 * u), sh = 0.18 * fl * (1 - u);
        d.fa[j].copy(G).addScaledVector(Pv, along + sh).addScaledVector(Qv, -w);
        d.fb[j].copy(G).addScaledVector(Pv, along - sh).addScaledVector(Qv, w);
        d.fu[j].copy(UP).addScaledVector(Pv, lean + 0.1 * (fx.rand() - 0.5)).addScaledVector(Qv, 0.16 * (fx.rand() - 0.5)).normalize();
        d.fh[j] = fl * (0.9 + 0.3 * u + 0.45 * fx.rand());
        d.fw[j] = 0.06 * fl;
        d.fdelay[j] = 0.1 + 0.11 * j;
      }
      // the flux rope: anchored at both ends of the line, lying along it above the arcade
      d.fa[ROPE].copy(G).addScaledVector(Pv, -2.1 * fl).addScaledVector(Qv, 0.15 * fl);
      d.fb[ROPE].copy(G).addScaledVector(Pv, 2.1 * fl).addScaledVector(Qv, -0.15 * fl);
      d.fu[ROPE].copy(UP).addScaledVector(Qv, 0.12).normalize();
      d.fdelay[ROPE] = 0;
    }

    function flare(c, d, p, tt, lx, dt) {
      const fl = p.flare * p.size, fade = 1 - sstep(lx, 0.55, 1), I = p.intensity;
      const xr = tt / 1.5;   // the eruption's clock
      for (let k = 0; k < d.nStr; k++) {
        const h = d.str[k], j = d.sl[k], sd = d.ss[k];
        const A = d.fa[j], B = d.fb[j], Uv = d.fu[j];
        if (j === ROPE) {
          // lifts off, swells, accelerates away and fades: a twisted prominence of fine threads
          const hgt = fl * (0.6 + 7.5 * Math.pow(Math.min(xr, 1.3), 1.8));
          h.p0.set(A.x, A.y, A.z, 0.06 * fl * (1 + xr) * (1.4 - 0.8 * sd));   // thick, merging threads: a body of plasma, not wires
          h.p1.set(B.x, B.y, B.z, hgt);
          h.p2.set(Uv.x, Uv.y, Uv.z, fl * (0.18 + 0.5 * xr));
          h.p3.set(sd, 1.6, 0.55, 0.55);
          h.color.copy(promCol).lerp(coreCol, 0.6 * (1 - sd * sd));   // golden heart, red outer threads
          h.intensity = 1.3 * (1 - 0.5 * sd * sd) * p.loops * I * sstep(tt, 0, 0.08) * (1 - sstep(xr, 0.4, 0.9)) * (0.7 + 0.3 * Math.sin(tt * 9 + sd * 20));
          continue;
        }
        // an arcade loop: a bundle of fine threads braided round its flux tube (sd: the thread's place,
        // core 0 .. rim 1) and a faint haze strand; it forms, rises to its height, burns golden-white,
        // then cools and drains. Hot golden-white cores; the faint outer threads run cooler and redder
        const x = tt - d.fdelay[j], g = easeOutBack(clamp(x / 0.45, 0, 1)), on = sstep(x, 0, 0.1);
        const heat = 1 - sstep(x, 0.8, 2.6), haze = k % AS === 0;
        // threads thick enough to merge into a glowing tube with fine structure (AIA 171 loops), not wires
        h.p0.set(A.x, A.y, A.z, (haze ? 0.42 : 0.009 + 0.016 * (1 - sd)) * fl);
        h.p1.set(B.x, B.y, B.z, d.fh[j] * g * (1 + 0.06 * lx));
        h.p2.set(Uv.x, Uv.y, Uv.z, haze ? 0 : d.fw[j] * (1 + 0.5 * lx));
        h.p3.set(sd, (k % 7 === 3 ? -1 : 1) * (0.7 + 0.9 * ((k * 0.618) % 1)), 0.25, heat);
        h.color.copy(glowCol).lerp(hotCol, heat * (1 - 0.8 * sd * sd));
        h.intensity = (haze ? 3 : 0.75 * (1 - 0.75 * sd * sd)) * p.loops * I * on * fade * (1 + 1.5 * Math.exp(-Math.max(x, 0) / 0.2)) * (0.75 + 0.25 * Math.sin(tt * (3 + 4 * sd) + k * 1.7));
      }
      // the ribbons: burning lines on the floor under the footpoints, spreading apart
      const G = d.G, Pv = d.P, Qv = d.Q, w = ribW(fl, tt), Lr = 1.6 * fl;
      for (let r = 0; r < 2; r++) {
        const lt = d.rib[r], sgn = r ? 1 : -1;
        if (!lt) continue;
        lt.pos.copy(G).addScaledVector(Qv, sgn * w).setY(G.y + 0.5);
        lt.intensity = 18 * I * p.glow * sstep(tt, 0.05, 0.3) * (1 - sstep(lx, 0.35, 0.95)) * (0.85 + 0.15 * Math.sin(tt * 13 + r * 2));
      }
      d.ribT -= dt;
      if (d.ribT <= 0 && lx < 0.6) {
        d.ribT = 0.12;
        // each ribbon burns in ragged, wandering kernels (a few short dashes along it), not one line
        for (let r = 0; r < 2; r++) {
          const sgn = r ? 1 : -1, u0 = (fx.rand() - 0.65) * 2 * Lr, len = (0.25 + 0.5 * fx.rand()) * Lr;
          const q0 = sgn * w + 0.12 * fl * (fx.rand() - 0.5), q1 = sgn * w + 0.12 * fl * (fx.rand() - 0.5);
          _a.copy(G).addScaledVector(Pv, u0).addScaledVector(Qv, q0);
          _b.copy(G).addScaledVector(Pv, u0 + len).addScaledVector(Qv, q1);
          splat(_a.x, _a.z, 0.3, 0.12, 0.04, (0.5 + 0.9 * fx.rand()) * p.glow * (1 - lx), 'line', c.seed + 40 + r + (d.frame & 31), (0.05 + 0.07 * fx.rand()) * fl, _b.x, _b.z);
        }
      }
      if (lx < 0.6) {
        // footpoint kernels spit sparks, two feet a frame
        for (let s = 0; s < 2; s++) {
          const f = (d.frame * 2 + s) % (ARC * 2), j = f >> 1;
          if (tt < d.fdelay[j]) continue;
          footSpark.pos.copy(f & 1 ? d.fb[j] : d.fa[j]).setY(d.G.y + 0.05);
          footSpark.vel.set(0, 2.2, 0);
          footSpark.rate(160 * p.sparks * (1 - lx / 0.6), dt);
        }
      }
      if (tt > 0.6 && lx < 0.85 && d.nStr) {
        // coronal rain: drips from near the top of a cooling arcade loop
        const k = Math.floor(fx.rand() * Math.min(d.nStr, ARC * AS)), h = d.str[k];
        if (h && tt > d.fdelay[d.sl[k]] + 0.5) {
          loopPoint(h, 0.3 + 0.4 * fx.rand(), rain.pos);
          rain.vel.set(0, -0.5, 0);
          rain.rate(110 * p.loops * (1 - lx), dt);
        }
      }
    }
  },
};
