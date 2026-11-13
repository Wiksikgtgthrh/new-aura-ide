import * as THREE from 'three';
import { blackbodyRGB } from '../../vfx/noise.js';
import { LINES_BLENDING } from '../../vfx/common.js';
import { Swarm } from '../acid/plague-swarm.glsl.js';
import { EMBER_SIM, EMBER_LOOK, STREAK_VERT, STREAK_FRAG, FLAKE_VERT, FLAKE_FRAG } from './ember-swarm.glsl.js';

// Ember Swarm (SPELLBOOK hybrid, fire + arcane). Thousands of homing embers, flocking on the GPU
// (the agent engine in plague-swarm.glsl.js). Reference: long-exposure forge sparks and fireflies,
// burning-paper embers.
//  Anticipation: embers lift off the floor and out of the orb into a slowly folding murmuration.
//  Release: the sheet unwinds, in order, into one living ribbon: flat, twisting, undulating, its
//    line light sweeping the floor, and the airflow fans each ember hotter.
//  Impact: the ribbon winds round the target into a dense orbiting shell of hot streaks; a share
//    sticks to the dummy and burns; the rest shed one by one, cooling into dark flakes that fall.
//  Aftermath: the shell bursts, everything cools by radiative law and drifts down as ash, leaving
//    scorch and glowing specks.
// Every ember: its own blackbody temperature (T^4 brightness), flicker and curved long-exposure
// streak; the arcane is only magenta in the hottest cores. All their light lands on the floor
// through the swarm's floor light; three orbiting lights carry it to the dummy.

const SIZES = { low: [64, 64], medium: [128, 64], high: [128, 128], ultra: [256, 128] };
const CHARGE = 2.6, IMPACT = 1.6, SWOOP = 1.3, DELAY = 0.9, AFTER = 4.4;
const TAU = Math.PI * 2;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _m4 = new THREE.Matrix4(), _col = new THREE.Color();
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export default {
  id: 'ember-swarm', name: 'Ember Swarm', element: 'fire', order: 20, hue: '#ff7a1e',
  shape: 'area',
  params: {
    count: 1, size: 1, speed: 1, temperature: 1500, glow: 1, exposure: 1, arcane: 0.2, flock: 1, turbulence: 1, radius: 1.05,
    hold: 2.4, shed: 0.3, cling: 0.1, haze: 1, smoke: 1, scorch: 1,
    arcaneColor: '#ff2fb4', ash: '#2a2623',
  },
  ranges: {
    count: [0.1, 1, 0.01], size: [0.5, 2.5, 0.01], speed: [0.5, 2, 0.01], temperature: [1000, 3000, 10], glow: [0, 4, 0.01], exposure: [0.2, 3, 0.01],
    arcane: [0, 1, 0.01], flock: [0, 2, 0.01], turbulence: [0, 3, 0.01], radius: [0.7, 2, 0.01], hold: [1, 6, 0.1], shed: [0, 0.7, 0.01], cling: [0, 0.4, 0.01],
    haze: [0, 3, 0.01], smoke: [0, 3, 0.01], scorch: [0, 2, 0.01],
  },
  presets: {
    'forge sparks': { temperature: 2200, exposure: 1.7, size: 0.8, speed: 1.35, turbulence: 0.7, arcane: 0.15, smoke: 0.5 },
    fireflies: { temperature: 1250, count: 0.45, exposure: 0.7, speed: 0.65, size: 1.2, glow: 1.8, haze: 0.2, smoke: 0.2, scorch: 0.3, arcane: 0 },
    'witch fire': { temperature: 2300, arcane: 1, glow: 1.2, hold: 4, radius: 1.3, shed: 0.45, arcaneColor: '#e01fff' },
  },
  timing: { charge: CHARGE, impact: IMPACT, linger: 2.4 + AFTER },
  kinds: {
    // scorched sacking: thin lit smoke, the shell's own light does the rest
    smoke: { style: 'media', emissive: 0, drag: 1.6, buoyancy: 1.8, curl: 2.4, curlScale: 0.5, life: [1.4, 3.0], size: [0.12, 0.9], sizePow: 0.6, color: ['#2b2622', '#55504a'], alpha: [0.4, 0], density: 1.6, erosion: 1.3, fadeIn: 0.2, fadeOut: 0.5 },
    haze: { style: 'media', drag: 0.4, buoyancy: 1.2, forceResponse: 1.5, life: [0.8, 1.3], size: [0.7, 1.3], alpha: [1, 0], density: 0, distortion: 0.7, fadeIn: 0.25, fadeOut: 0.4 },
    // embers that strike the dummy spit a few fast sparks
    spark: { style: 'glow', drag: 0.6, gravity: 9.8, restitution: 0.4, friction: 0.3, life: [0.2, 0.55], size: [0.012, 0.004], stretch: 0.03, emissive: 6, temp: [2300, 1100], paints: 'heat', paintAmount: 0.03 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const [W, H] = SIZES[fx.Q.tier] ?? SIZES.high;

    // --- the swarm: shared engine, ember behaviour and look ------------------------------------------
    const u = {
      uLeader: { value: new THREE.Vector4() }, uLeaderV: { value: new THREE.Vector4() },
      uTarget: { value: new THREE.Vector4(0, 1, 2, 1) }, uMode: { value: new THREE.Vector4() },
      uFlock: { value: new THREE.Vector4() }, uMove: { value: new THREE.Vector4() },
      uSpawnP: { value: new THREE.Vector4() }, uSpawnF: { value: new THREE.Vector4() },
      uClock: { value: new THREE.Vector4(-1, 0.15, -1, 1) },
      uPathA: { value: new THREE.Vector4() }, uPathM: { value: new THREE.Vector4() }, uPathB: { value: new THREE.Vector4() },
      uStream: { value: new THREE.Vector4(DELAY, 0.7, 0, 0) },
      uDummyP: { value: new THREE.Vector4() }, uDummyR: { value: new THREE.Matrix3() },
      uHeat: { value: new THREE.Vector4(1550, 0.16, 1, 0) },
      uLook: { value: new THREE.Vector4(1, 1, 0.06, 0.5) }, uShape: { value: new THREE.Vector4(1, 0, 0, 0) },
      uArcane: { value: new THREE.Color() }, uAsh: { value: new THREE.Color() },
    };
    const swarm = new Swarm(fx, { W, H, sim: EMBER_SIM, look: EMBER_LOOK, uniforms: u, grid: true, light: { res: 64, box: 16, soft: 0.9 } });
    const nK = Math.sqrt(16384 / swarm.N);   // fewer embers on low tiers: each carries more light
    swarm.floorU.uFloor.value.set(0.05 * nK, 0.05, 0.6, 0);   // a dense swarm lights the ground under it
    fx.systems.push(swarm);

    // streaks: a strip per ember (4 path segments + 2 caps)
    const xs = [-1, 0, 1 / 3, 2 / 3, 1, 2], pos = [], idx = [];
    xs.forEach((x, i) => { pos.push(x, -1, 0, x, 1, 0); if (i) idx.push(2 * i - 2, 2 * i, 2 * i + 1, 2 * i - 2, 2 * i + 1, 2 * i - 1); });
    const strip = new THREE.InstancedBufferGeometry();
    strip.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    strip.setIndex(idx);
    strip.instanceCount = swarm.N;
    const streaks = new THREE.Mesh(strip, swarm.material(STREAK_VERT(W), STREAK_FRAG, {}, LINES_BLENDING));
    streaks.frustumCulled = false;
    streaks.renderOrder = 11;
    streaks.layers.enable(1);
    streaks.visible = false;
    swarm.glow = streaks;   // swarm.show() drives it
    fx.scenes.lines.add(streaks, swarm.floor);
    // flakes: dark solid scraps, so they read against the glow
    const flakes = new THREE.Mesh(swarm.instancedQuad(), swarm.material(FLAKE_VERT(W), FLAKE_FRAG, {}, { alphaToCoverage: true }));
    flakes.frustumCulled = false;
    flakes.visible = false;
    fx.scenes.opaque.add(flakes);

    const E = {
      smoke: P.emitter('ember-swarm.smoke', { shape: 'line', radius: 0.2, spread: 0.3 }),
      burst: P.emitter('ember-swarm.smoke', { shape: 'sphere', radius: 0.8, spread: 0.8, radial: 1.6 }),
      haze: P.emitter('ember-swarm.haze', { shape: 'sphere', radius: 1, spread: 0.3 }),
      spark: P.emitter('ember-swarm.spark', { shape: 'sphere', radius: 0.4, spread: 3, radial: 2 }),
    };
    const SPLAT = { x: 0, z: 0, radius: 1, heat: 0, char: 0, glow: 0, pattern: 'noise', seed: 0 };
    const SHOCK = { pos: new THREE.Vector3(), radius0: 0.5, radius1: 5, duration: 0.45, thickness: 0.7, distortion: 0.03, intensity: 0, ground: false };

    function syncColors() {
      const p = S.params;
      const a = u.uArcane.value.set(p.arcaneColor);
      a.multiplyScalar(1 / Math.max(0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b, 1e-3));
      u.uAsh.value.set(p.ash);
    }
    const lightColor = (T, out) => blackbodyRGB(T, out);

    let owner = null;
    const lead = new THREE.Vector3(), leadPrev = new THREE.Vector3(), centroid = new THREE.Vector3();
    const cloud0 = new THREE.Vector3(), pA = new THREE.Vector3(), mid = new THREE.Vector3(), tc = new THREE.Vector3();

    function releaseAll(c) {
      const d = c.data;
      d.l0?.release(); d.l1?.release(); d.l2?.release(); d.vortex?.release(); d.shock?.release();
      d.l0 = d.l1 = d.l2 = d.vortex = d.shock = null;
    }
    function stop() {
      owner = null;
      swarm.active = false;
      swarm.show(false);
      flakes.visible = false;
      swarm.reset();
    }
    function splat(x, z, radius, heat, char, glow, seed) {
      SPLAT.x = x; SPLAT.z = z; SPLAT.radius = radius; SPLAT.heat = heat; SPLAT.char = char; SPLAT.glow = glow; SPLAT.seed = seed;
      fx.ground.splat(SPLAT);
    }

    // the cloud's centre (CPU): up off the caster, wandering until the ribbon starts
    function cloudAt(c, T, out) {
      const t = Math.min(T, CHARGE), k = ease(t / 1.5);
      out.copy(c.from).lerp(cloud0, k);
      out.x += Math.sin(t * 1.1 + c.data.ph) * 0.5 * k;
      out.y += Math.sin(t * 0.8) * 0.25 * k;
      return out;
    }
    // the ribbon's centreline (mirrors pathAt in the sim)
    function pathAt(s, out) {
      s = Math.min(1, Math.max(0, s));
      const k = s * s * (3 - 2 * s) * 0.6 + s * s * 0.4, i = 1 - k;
      return out.set(i * i * pA.x + 2 * i * k * mid.x + k * k * tc.x, i * i * pA.y + 2 * i * k * mid.y + k * k * tc.y, i * i * pA.z + 2 * i * k * mid.z + k * k * tc.z);
    }

    return {
      onParam(k) { if (k === 'arcaneColor' || k === 'ash') syncColors(); },

      phase(c, name) {
        const p = S.params, d = c.data;
        if (name === 'charge') {
          syncColors();
          if (owner && owner !== c) releaseAll(owner);
          if (!owner || owner.data.dispersed) swarm.reset();
          owner = c;
          swarm.active = true;
          swarm.show(true);
          flakes.visible = true;
          d.ph = (c.seed % 100) * 0.0628;
          d.side = c.seed % 2 ? 1 : -1;
          d.hold = p.hold;
          c.durations.linger = p.hold + AFTER;
          d.nextSplat = 0; d.nextHit = 0; d.arrived = false; d.closed = false; d.dispersed = false; d.tShock = 0;
          d.l0 = fx.lights.acquire();
          if (d.l0) { d.l0.range = 8; d.l0.intensity = 0; d.l0.shadow = true; }
          d.l1 = d.l2 = d.vortex = d.shock = null;
          // the sheet forms over the caster, leaning at the target; the ribbon bends out to one side
          _a.subVectors(c.to, c.from).setY(0);
          if (_a.lengthSq() < 1e-4) _a.set(0, 0, -1);
          _a.normalize();
          cloud0.copy(c.from).addScaledVector(_a, 3.6); cloud0.y += 2.1;
          tc.set(c.to.x, c.target >= 0 ? 1.0 : Math.max(c.to.y, 0.9), c.to.z);
          mid.copy(cloud0).lerp(tc, 0.5);
          mid.x += -_a.z * d.side * 5; mid.z += _a.x * d.side * 5; mid.y += 1.2;
          const r2 = Math.hypot(mid.x, mid.z), lim = fx.ARENA.radius - 2;
          if (r2 > lim) { mid.x *= lim / r2; mid.z *= lim / r2; }
          cloudAt(c, 0, lead); leadPrev.copy(lead); centroid.copy(lead);
          cloudAt(c, CHARGE, pA);
          swarm.simU.uSpawnFrac.value = 0;
          // the floor starts to smoulder where they will lift from
          splat(c.from.x, c.from.z, 3.4, 0.08, 0.1, 0.5, c.seed % 97);
        } else if (name === 'done') {
          releaseAll(c);
          fx.arena.setFocus(fx.arena.focus.color, 2.5);
          if (c === owner) stop();
        }
      },

      update(c, dt) {
        if (c !== owner) { releaseAll(c); return; }
        const p = S.params, d = c.data, T = c.age;
        const swoop = SWOOP / Math.sqrt(p.speed), tEnv = CHARGE + swoop, tDis = CHARGE + IMPACT + d.hold, tEnd = tDis + AFTER;
        const dm = c.target >= 0 ? fx.dummies[c.target] : null;
        const R = p.radius * (0.8 + 0.2 * Math.cbrt(p.count));

        // --- leader, cloud, phase weights ---
        leadPrev.copy(lead);
        cloudAt(c, T, lead);
        const lv = _b.subVectors(lead, leadPrev).multiplyScalar(dt > 0 ? 1 / dt : 0);
        const env = ease((T - (tEnv - 0.2)) / (DELAY + 0.4));      // the share of the swarm at the target
        const dis = ease((T - tDis) / 0.5);
        const shut = ease((T - tDis - 0.1) / 0.3);                 // the shell's curvature lets go
        const cloudR = 0.7 + 2.5 * ease(T / 1.8);
        u.uLeader.value.set(lead.x, lead.y, lead.z, cloudR * Math.cbrt(p.count));
        u.uLeaderV.value.set(lv.x, lv.y, lv.z, 0);
        u.uPathA.value.set(pA.x, pA.y, pA.z, swoop);
        u.uPathM.value.set(mid.x, mid.y, mid.z, T);
        u.uPathB.value.set(tc.x, tc.y, tc.z, CHARGE);
        u.uStream.value.set(DELAY, 0.8 * Math.cbrt(p.count), 0, 0);
        u.uTarget.value.set(tc.x, tc.y, tc.z, R);
        u.uMode.value.set(T > CHARGE ? 1 : 0, dis, dm ? p.cling * ease((T - tEnv) / 1.2) : 0, p.shed);
        u.uFlock.value.set(1.5 * p.flock, 6 * p.flock, 2.2 * p.flock, p.turbulence);
        const cruise = T < CHARGE ? 3.4 : 6.5;
        u.uMove.value.set(cruise * p.speed, 7 * p.speed, 2.8, (T < CHARGE ? 80 : 30) * swarm.N / 16384);
        u.uSpawnP.value.set(c.from.x, c.from.y, c.from.z, 0.22);
        u.uSpawnF.value.set(c.from.x, c.from.z, 3.4, 0.62);
        u.uClock.value.x = T > tDis ? T - tDis : -1;
        u.uClock.value.z = T > tEnv + DELAY ? T - tEnv - DELAY : -1;
        u.uClock.value.w = d.hold + IMPACT - swoop - DELAY;
        // they start dull and are fanned as they gather; the shell runs hottest
        const heat = 0.94 + 0.06 * ease(T / CHARGE) + 0.02 * Math.sin(T * 3.1) + 0.06 * ease((T - tEnv) / 1) * (1 - dis);
        u.uHeat.value.set(p.temperature, 0.16, heat, 0);
        u.uLook.value.set(p.size, 6.5 * p.glow * nK, 0.085 * p.exposure * (0.5 + 0.5 * ease((T - CHARGE + 0.3) / 0.5)), p.arcane);
        u.uShape.value.set(1 - ease((T - tEnd + 0.9) / 0.9), env * (1 - shut), T < CHARGE ? 2.6 : 0.25 + 0.75 * env, 0.35);
        swarm.simU.uSpawnFrac.value = p.count * ease(T / 1.0);
        if (dm) {
          u.uDummyP.value.set(dm.pos.x, 0, dm.pos.z, dis > 0.05 ? 0 : 1);
          u.uDummyR.value.setFromMatrix4(_m4.makeRotationFromQuaternion(dm.group.quaternion));
        } else u.uDummyP.value.w = 0;

        // where the swarm is: the grid and the floor light follow it
        const sMid = (T - DELAY * 0.5 - CHARGE) / swoop;
        if (T < CHARGE) _d.copy(lead); else if (sMid < 1) pathAt(sMid, _d); else _d.copy(tc);
        centroid.lerp(_d, 1 - Math.exp(-dt * 4));
        const gs = T < CHARGE ? Math.min(14, 5 + cloudR * 3) : 16 - 9.5 * env, gb = swarm.gridBox;
        gb.set(centroid.x - gs / 2, Math.max(centroid.y - gs * 0.42, -0.3), centroid.z - gs / 2, gs / 32);
        const lb = swarm.lightBox, snap = lb.z / 64;
        lb.x = Math.round((centroid.x - lb.z / 2) / snap) * snap;
        lb.y = Math.round((centroid.z - lb.z / 2) / snap) * snap;
        swarm.show(true);

        // the orb feeds them, then settles
        if (T < CHARGE + 0.7) fx.arena.setFocus(fx.arena.focus.color, 2.5 + 3 * ease(T / CHARGE) * (1 - ease((T - CHARGE) / 0.7)));

        // --- light: the murmuration's glow, the ribbon as a line light, three lights on the shell ---
        const alive = Math.min(1, swarm.simU.uSpawnFrac.value / Math.max(p.count, 1e-3)) * (1 - ease((T - tDis - 0.15) / 1.3));
        const base = 12 * p.glow * Math.sqrt(p.count) * alive * (0.85 + 0.15 * Math.sin(T * 13.7 + d.ph));
        const K = p.temperature * heat * 0.95, burst = 1 + 1.5 * Math.max(0, 1 - Math.abs(T - tDis - 0.12) / 0.25);
        if (d.l0) {
          const L = d.l0;
          if (T < CHARGE) { L.type = 0; L.pos.copy(centroid); L.range = 7 + cloudR; L.intensity = base * 0.9; }
          else if (env < 0.5) {
            L.type = 1; L.range = 9; L.intensity = base * 1.1;
            pathAt((T - CHARGE) / swoop, L.pos); pathAt((T - CHARGE - DELAY) / swoop, L.end);
          } else {
            const a = T * 2.7 + d.ph;
            L.type = 0; L.range = 8; L.intensity = base * 0.75 * burst;
            L.pos.set(tc.x + Math.cos(a) * R * 0.75, tc.y + 0.5 + 0.3 * Math.sin(T * 1.3), tc.z + Math.sin(a) * R * 0.75);
          }
          lightColor(K, L.color);
        }
        if (env > 0.5 && !d.l1 && !d.dispersed) {
          d.l1 = fx.lights.acquire();
          if (d.l1) { d.l1.range = 8; d.l1.shadow = true; }
          d.l2 = fx.lights.acquire();
          if (d.l2) d.l2.range = 6;
        }
        if (d.l1) {
          const a = T * 2.7 + d.ph + 2.09;
          d.l1.pos.set(tc.x + Math.cos(a) * R * 0.75, tc.y + 0.1, tc.z + Math.sin(a) * R * 0.75);
          d.l1.intensity = base * 0.75 * env * burst;
          lightColor(K, d.l1.color);
        }
        if (d.l2) {
          const a = T * 2.7 + d.ph + 4.19;
          d.l2.pos.set(tc.x + Math.cos(a) * R * 0.75, tc.y - 0.5, tc.z + Math.sin(a) * R * 0.75);
          d.l2.intensity = base * 0.5 * env * burst;
          lightColor(K * 1.1, d.l2.color);
        }

        // --- arrival: the shell closes, the scorching starts ---
        if (!d.arrived && T > tEnv - 0.1) {
          d.arrived = true;
          fx.rig.shake(0.1, 22);
          fx.impacts.add('scorch', tc, 1.5 * R, 0.8 * p.scorch, d.hold + AFTER, lightColor(K, _col));
          d.vortex = fx.forces.acquire();
          if (d.vortex) {
            const v = d.vortex;
            v.type = 1; v.pos.set(tc.x, 0, tc.z); v.dir.set(0, 1, 0); v.w = 3;
            v.p[0] = 0.9 * R; v.p[1] = 5 * p.speed; v.p[2] = 0.7; v.p[3] = 0.2;
          }
        }
        const burning = env > 0.5 && dis < 0.5;
        if (burning) {
          const k = Math.min(1, (T - tEnv) / d.hold);
          d.nextSplat -= dt;
          if (d.nextSplat <= 0) {
            d.nextSplat = 0.3;
            splat(tc.x, tc.z, (0.8 + 0.7 * k) * R, 0.1 * p.scorch, 0.14 * p.scorch, 0.2 * p.scorch, (c.seed + T * 31) % 97);
          }
          if (dm) {
            dm.status.burn = Math.max(dm.status.burn, Math.min(1, 0.35 + 0.65 * k) * p.scorch);
            d.nextHit -= dt;
            if (d.nextHit <= 0) {
              d.nextHit = 0.2 + 0.3 * fx.rand();
              const a = fx.rand() * TAU;
              dm.hit(_a.set(Math.cos(a), 0, Math.sin(a)), 0.02 + 0.03 * fx.rand());
            }
            E.smoke.pos.set(dm.pos.x, 0.7, dm.pos.z); E.smoke.p.set(dm.pos.x, 1.6, dm.pos.z); E.smoke.vel.set(0, 0.5, 0); E.smoke.rate(26 * p.smoke * (0.3 + 0.7 * k), dt);
            E.spark.pos.set(dm.pos.x, 1.1, dm.pos.z); E.spark.vel.set(0, 0.6, 0); E.spark.rate(55 * k, dt);
          }
          E.haze.pos.copy(tc); E.haze.radius = R * 1.2; E.haze.vel.set(0, 1.0, 0); E.haze.size = R; E.haze.rate(30 * p.haze, dt);
        }
        if (dm && T > tDis) dm.status.burn = Math.max(dm.status.burn, 0.85 * p.scorch);   // it stays charred to the end
        if (dm && T > tDis && T < tDis + 3) {   // and keeps smoking
          E.smoke.pos.set(dm.pos.x, 0.8, dm.pos.z); E.smoke.p.set(dm.pos.x, 1.7, dm.pos.z); E.smoke.vel.set(0, 0.4, 0); E.smoke.rate(18 * p.smoke * (1 - (T - tDis) / 3), dt);
        }
        if (d.vortex) d.vortex.p[1] = 5 * p.speed * env * (1 - dis);

        // --- the burst ---
        if (dis > 0.02 && !d.dispersed) {
          d.dispersed = true;
          d.vortex?.release(); d.vortex = null;
          fx.flash(0.035);
          fx.rig.shake(0.22, 14);
          SHOCK.pos.copy(tc); SHOCK.radius1 = 4.5 * R; SHOCK.distortion = 0.015 * p.haze;
          fx.shocks?.spawn(SHOCK);
          d.shock = fx.forces.acquire();
          if (d.shock) { const s = d.shock; s.type = 4; s.pos.copy(tc); s.p[0] = 0.3; s.p[1] = 1.2; s.p[2] = 40; d.tShock = 0; }
          E.burst.pos.copy(tc); E.burst.vel.set(0, 0.7, 0); E.burst.burst(50 * p.smoke);
          // char lasts on the dummy; the floor mark is ragged lobes, not a disc
          fx.impacts.add('scorch', tc, 1.8 * R, p.scorch, AFTER + 4, lightColor(K, _col));
          splat(tc.x, tc.z, 1.5 * R, 0.12 * p.scorch, 0.7 * p.scorch, 0.35 * p.scorch, c.seed % 89);
          for (let i = 0; i < 4; i++) {
            const a = fx.rand() * TAU, r = (0.7 + 0.9 * fx.rand()) * R;
            splat(tc.x + Math.cos(a) * r, tc.z + Math.sin(a) * r, (0.5 + 0.6 * fx.rand()) * R, 0.05 * p.scorch, 0.5 * p.scorch, 0.15 * p.scorch, (c.seed + i * 13) % 89);
          }
          if (dm) { dm.status.burn = Math.max(dm.status.burn, p.scorch); dm.hit(_a.set(c.seed % 3 - 1, 0, 1).normalize(), 0.5); }
        }
        if (d.shock) {
          d.tShock += dt;
          const a = d.tShock;
          if (a > 0.5) { d.shock.release(); d.shock = null; }
          else { d.shock.p[0] = 0.3 + 9 * a; d.shock.p[2] = 40 * (1 - a / 0.5); }
        }
        if (T > tDis && alive <= 0.01) { d.l0?.release(); d.l1?.release(); d.l2?.release(); d.l0 = d.l1 = d.l2 = null; }
      },
    };
  },
};
