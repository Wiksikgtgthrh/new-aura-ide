import * as THREE from 'three';
import { Swarm, PLAGUE_SIM, PLAGUE_LOOK, PLAGUE_BODY_VERT, PLAGUE_BODY_FRAG } from './plague-swarm.glsl.js';

// Plague Swarm (Acid hero). Thousands of bioluminescent insects, flocking for real on the GPU
// (plague-swarm.glsl.js: particle-in-cell boids, alignment / separation / cohesion from a 32^3
// velocity-density grid, plus a goal field and curl turbulence). Reference: desert-locust swarm
// and starling-murmuration footage, Photinus fireflies (whose flashes lock into travelling waves).
//  Anticipation: the swarm boils out of the caster's orb and churns into a murmuration overhead.
//  Release: it pours off the cloud in a river that swoops over the arena onto the target.
//  Impact: it wraps the dummy in a spinning ball, a third of it lands and crawls on the dummy, the
//    lanterns sync into flash waves, and the dummy corrodes: dissolve, acid paint pooling under it,
//    sizzle, drips and fumes, two orbiting green lights throwing its shadow round the floor.
//  Aftermath: the swarm lifts off and scatters over the rim; a share die and drop, their lights
//    going out on the floor; an eaten dummy over a corroded stain.
// Every insect is a motion-blurred chitin streak with blurred wings that glint in the sun (fx pass)
// and a lantern (lines pass); their light also lands on the floor through the swarm's floor light.

const SIZES = { low: [64, 64], medium: [128, 64], high: [128, 128], ultra: [256, 128] };
const CHARGE = 2.0, IMPACT = 1.8, SWOOP = 1.2, DELAY = 0.85;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export default {
  id: 'plague-swarm', name: 'Plague Swarm', element: 'acid', order: 10, hue: '#8aff3c',
  shape: 'area',
  params: {
    count: 1, size: 1, speed: 1, glow: 1, sync: 0.6, flock: 1, turbulence: 1, radius: 1.15,
    landing: 0.32, hold: 3, corrosion: 1,
    color: '#a8ff2a', color2: '#f0ff58', chitin: '#262619',
  },
  ranges: {
    count: [0.1, 1, 0.01], size: [0.5, 2.5, 0.01], speed: [0.4, 2, 0.01], glow: [0, 4, 0.01], sync: [0, 1, 0.01],
    flock: [0, 2, 0.01], turbulence: [0, 3, 0.01], radius: [0.7, 2.2, 0.01], landing: [0, 0.8, 0.01],
    hold: [1, 6, 0.1], corrosion: [0, 1.5, 0.01],
  },
  presets: {
    locusts: { glow: 0.3, size: 1.35, speed: 1.25, sync: 0, landing: 0.5, chitin: '#3d3420', color: '#c8ff3a', turbulence: 1.2 },
    fireflies: { glow: 2.4, size: 0.7, count: 0.5, sync: 0.9, speed: 0.6, turbulence: 0.6, landing: 0.15, color: '#d6ff4a', color2: '#ffd34a', chitin: '#121210' },
    blight: { color: '#6dff3a', color2: '#3affb4', glow: 1.5, corrosion: 1.45, hold: 4.5, radius: 1.35 },
  },
  timing: { charge: CHARGE, impact: IMPACT, linger: 8 },
  kinds: {},

  create(fx) {
    const S = this, P = fx.particles, Q = fx.Q;
    const [W, H] = SIZES[Q.tier] ?? SIZES.high;

    // --- the swarm ---------------------------------------------------------------------------------
    const u = {
      uLeader: { value: new THREE.Vector4() }, uLeaderV: { value: new THREE.Vector4(0, 0, 0, 1) },
      uTarget: { value: new THREE.Vector4(0, 1, 2, 1) }, uMode: { value: new THREE.Vector4() },
      uFlock: { value: new THREE.Vector4() }, uMove: { value: new THREE.Vector4() },
      uSpawnP: { value: new THREE.Vector4() }, uDummyP: { value: new THREE.Vector4() },
      uDummyR: { value: new THREE.Matrix3() }, uClock: { value: new THREE.Vector4(-1, 0.15, 0, 0) },
      uPathA: { value: new THREE.Vector4() }, uPathM: { value: new THREE.Vector4() }, uPathB: { value: new THREE.Vector4() },
      uStream: { value: new THREE.Vector4(DELAY, 0.7, 0, 0) },
      uLook: { value: new THREE.Vector4(1, 1, 1, 0) }, uGlowA: { value: new THREE.Color() }, uGlowB: { value: new THREE.Color() },
      uChitin: { value: new THREE.Color() }, uBody: { value: new THREE.Vector4(1, 0.3, 4, 0.12) },
    };
    const swarm = new Swarm(fx, { W, H, sim: PLAGUE_SIM, look: PLAGUE_LOOK, uniforms: u, grid: true, light: { res: 64, box: 16, soft: 0.3 } });
    swarm.floorU.uFloor.value.set(0.012, 0.045, 0.6, 0);
    fx.systems.push(swarm);
    const glow = swarm.glowMesh();
    fx.scenes.lines.add(glow, swarm.floor);
    // bodies in the opaque pass: full res, depth-tested, motion blur as MSAA coverage
    const body = new THREE.Mesh(swarm.instancedQuad(), swarm.material(PLAGUE_BODY_VERT(W), PLAGUE_BODY_FRAG, {}, { alphaToCoverage: true }));
    body.frustumCulled = false;
    body.visible = false;
    fx.scenes.opaque.add(body);

    // --- the acid family's kinds by full name ------------------------------------------------------
    const sizzle = P.emitter('acid.sizzle', { shape: 'line', radius: 0.26, spread: 0.6 });
    const drip = P.emitter('acid.drip', { shape: 'disk', radius: 0.26, spread: 0.15 });
    const fume = P.emitter('acid.fume', { shape: 'line', radius: 0.22, spread: 0.3 });
    const stain = P.emitter('acid.sizzle', { shape: 'disk', radius: 1, spread: 0.5 });

    // colours (linear)
    const glowA = new THREE.Color(), glowB = new THREE.Color();
    function syncColors() {
      const p = S.params;
      glowA.set(p.color); glowB.set(p.color2);
      u.uGlowA.value.copy(glowA).multiplyScalar(18);
      u.uGlowB.value.copy(glowB).multiplyScalar(18);
      u.uChitin.value.set(p.chitin);
    }

    let owner = null;
    const lead = new THREE.Vector3(), leadPrev = new THREE.Vector3(), centroid = new THREE.Vector3();
    const cloud0 = new THREE.Vector3(), mid = new THREE.Vector3(), tc = new THREE.Vector3();

    function releaseAll(c) {
      const d = c.data;
      d.l0?.release(); d.l1?.release(); d.vortex?.release();
      d.l0 = d.l1 = d.vortex = null;
    }
    function stop() {
      owner = null;
      swarm.active = false;
      swarm.show(false);
      body.visible = false;
      swarm.reset();
    }

    // the cloud's centre (CPU): up out of the orb, churning over the caster until the swoop starts
    function cloudAt(c, T, out) {
      const t = Math.min(T, CHARGE), k = ease(t / 1.3);
      out.copy(c.from).lerp(cloud0, k);
      out.x += Math.sin(t * 1.3 + c.data.ph) * 0.6 * k;
      out.y += Math.sin(t * 0.9) * 0.3 * k;
      return out;
    }
    // the river (mirrors pathAt in the sim): a quadratic Bezier from the cloud over to the target
    const pA = new THREE.Vector3();
    function pathAt(s, out) {
      s = Math.min(1, Math.max(0, s));
      const k = s * s * (3 - 2 * s) * 0.6 + s * s * 0.4, i = 1 - k;
      return out.set(i * i * pA.x + 2 * i * k * mid.x + k * k * tc.x, i * i * pA.y + 2 * i * k * mid.y + k * k * tc.y, i * i * pA.z + 2 * i * k * mid.z + k * k * tc.z);
    }

    return {
      onParam(k) { if (k === 'color' || k === 'color2' || k === 'chitin') syncColors(); },

      phase(c, name) {
        const p = S.params, d = c.data;
        if (name === 'charge') {
          syncColors();
          if (owner && owner !== c) releaseAll(owner);
          if (!swarm.active) swarm.reset();
          owner = c;
          swarm.active = true;
          swarm.show(true);
          body.visible = true;
          d.ph = (c.seed % 100) * 0.0628;
          d.side = c.seed % 2 ? 1 : -1;
          d.hold = p.hold;
          c.durations.linger = p.hold + 5;
          d.nextSplat = 0; d.nextHit = 0; d.arrived = false; d.dispersed = false;
          d.l0 = fx.lights.acquire();
          if (d.l0) { d.l0.range = 7; d.l0.intensity = 0; d.l0.shadow = true; d.l0.color.copy(glowA); }
          d.l1 = null; d.vortex = null;
          // the cloud forms over and in front of the caster, then the dive bends out to one side
          cloud0.copy(c.from).add(_a.set(0, 2.6, -2.4));
          tc.set(c.to.x, c.target >= 0 ? 1.0 : Math.max(c.to.y, 0.9), c.to.z);
          mid.copy(cloud0).lerp(tc, 0.5).add(_a.set(d.side * 5.5, 1.4, 0));
          cloudAt(c, 0, lead); leadPrev.copy(lead); centroid.copy(lead);
          cloudAt(c, CHARGE, pA);
          swarm.simU.uSpawnFrac.value = 0;
        } else if (name === 'done') {
          releaseAll(c);
          if (c === owner) stop();
        }
      },

      update(c, dt) {
        if (c !== owner) { releaseAll(c); return; }
        const p = S.params, d = c.data, T = c.age;
        const swoop = SWOOP / p.speed ** 0.5, tEnv = CHARGE + swoop, tDis = CHARGE + IMPACT + d.hold;
        const dm = c.target >= 0 ? fx.dummies[c.target] : null;

        // --- leader, cloud, phase weights ---
        leadPrev.copy(lead);
        cloudAt(c, T, lead);
        const lv = _b.subVectors(lead, leadPrev).multiplyScalar(dt > 0 ? 1 / dt : 0);
        // env: the share of the swarm that has reached the target (each insect has its own delay)
        const env = ease((T - (tEnv - 0.2)) / (DELAY + 0.4));
        const dis = ease((T - tDis) / 0.6);
        const cloudR = 0.6 + 2.2 * ease(T / 1.6);
        u.uLeader.value.set(lead.x, lead.y, lead.z, cloudR * Math.cbrt(p.count));
        u.uLeaderV.value.set(lv.x, lv.y, lv.z, 1);
        u.uPathA.value.set(pA.x, pA.y, pA.z, swoop);
        u.uPathM.value.set(mid.x, mid.y, mid.z, T);
        u.uPathB.value.set(tc.x, tc.y, tc.z, CHARGE);
        u.uStream.value.set(DELAY, 0.75 * Math.cbrt(p.count), 0, 0);
        const R = p.radius * (0.8 + 0.2 * Math.cbrt(p.count));
        u.uTarget.value.set(tc.x, tc.y, tc.z, R);
        const landing = ease((T - tEnv) / 1.2) * p.landing;
        u.uMode.value.set(T > CHARGE ? 1 : 0, dis, dm ? landing : 0, 0.32);
        u.uFlock.value.set(1.6 * p.flock, 7 * p.flock, 2.2 * p.flock, p.turbulence);
        u.uMove.value.set(5 * p.speed, 3.4 * p.speed, 2.6, 14);
        u.uSpawnP.value.set(c.from.x, c.from.y, c.from.z, 0.22);
        u.uClock.value.x = T > tDis ? T - tDis : -1;
        const fadeFly = 1 - ease((T - tDis - 1.2) / 2.2);
        u.uLook.value.set(p.size, p.glow, fadeFly, p.sync * ease((T - tEnv) / 1.5) * (1 - dis));
        swarm.simU.uSpawnFrac.value = p.count * ease(T / 1.1);
        if (dm) {
          u.uDummyP.value.set(dm.pos.x, 0, dm.pos.z, dis > 0.05 ? 0 : 1);
          u.uDummyR.value.setFromMatrix4(_m4.makeRotationFromQuaternion(dm.group.quaternion));
        } else u.uDummyP.value.w = 0;

        // where the swarm is (lags the leader): the grid and the floor light follow it
        // the middle of the river while it flows
        const sMid = (T - DELAY * 0.5 - CHARGE) / swoop;
        if (T < CHARGE) _d.copy(lead); else if (sMid < 1) pathAt(sMid, _d); else _d.copy(tc);
        centroid.lerp(_d, 1 - Math.exp(-dt * 4));
        const gs = T < CHARGE ? Math.min(14, 5 + cloudR * 3.2) : 16 - 9.5 * env;
        const gb = swarm.gridBox, cell = gs / 32;
        gb.set(centroid.x - gs / 2, Math.max(centroid.y - gs * 0.42, -0.3), centroid.z - gs / 2, cell);
        const lb = swarm.lightBox, snap = lb.z / 64;
        lb.x = Math.round((centroid.x - lb.z / 2) / snap) * snap;
        lb.y = Math.round((centroid.z - lb.z / 2) / snap) * snap;
        swarm.show(true);

        // --- light: the swarm's glow, then two lights orbiting the dummy with the ball ---
        const alive = Math.min(1, swarm.simU.uSpawnFrac.value / Math.max(p.count, 1e-3)) * fadeFly;
        const base = 9 * p.glow * Math.sqrt(p.count) * alive;
        if (d.l0) {
          const L = d.l0;
          if (env < 0.5) { L.pos.copy(centroid); L.range = 6 + cloudR * 1.5; L.intensity = base * 1.25; }
          else {
            const a = T * 2.1 + d.ph;
            L.pos.set(tc.x + Math.cos(a) * R * 1.1, tc.y + 0.6 + 0.25 * Math.sin(T * 1.3), tc.z + Math.sin(a) * R * 1.1);
            L.range = 7; L.intensity = base * 0.6;
          }
          L.color.copy(glowA);
        }
        if (env > 0.5 && !d.l1 && !d.dispersed) {
          d.l1 = fx.lights.acquire();
          if (d.l1) { d.l1.range = 7; d.l1.shadow = true; d.l1.color.copy(glowB).lerp(glowA, 0.5); }
        }
        if (d.l1) {
          const a = T * 2.1 + d.ph + Math.PI;
          d.l1.pos.set(tc.x + Math.cos(a) * R * 1.1, tc.y + 0.35, tc.z + Math.sin(a) * R * 1.1);
          d.l1.intensity = base * 0.6 * env;
        }

        // --- arrival: the ball wraps the target, the corrosion starts ---
        if (!d.arrived && T > tEnv - 0.1) {
          d.arrived = true;
          fx.rig.shake(0.12, 24);
          fx.impacts.add('acid', _a.copy(tc), 1.3 * p.radius, 0.9 * p.corrosion, p.hold + 4, glowA);
          d.vortex = fx.forces.acquire();
          if (d.vortex) {
            const v = d.vortex;
            v.type = 1; v.pos.set(tc.x, 0, tc.z); v.dir.set(0, 1, 0); v.w = 3.2;
            v.p[0] = 0.9 * p.radius; v.p[1] = 6 * p.speed; v.p[2] = 0.7; v.p[3] = 0.2;
          }
        }
        const eating = env > 0.6 && dis < 0.5;
        if (eating) {
          const k = Math.min(1, (T - tEnv) / d.hold);
          if (dm) {
            dm.status.dissolve = Math.max(dm.status.dissolve, Math.min(0.92, p.corrosion * (0.12 + 0.62 * k)));
            d.nextHit -= dt;
            if (d.nextHit <= 0) {
              d.nextHit = 0.18 + 0.25 * fx.rand();
              const a = fx.rand() * 6.283;
              dm.hit(_a.set(Math.cos(a), 0, Math.sin(a)), 0.035 + 0.03 * fx.rand());
            }
          }
          // corrosion pools and spreads under it
          d.nextSplat -= dt;
          if (d.nextSplat <= 0) {
            d.nextSplat = 0.3;
            fx.ground.splat({ x: tc.x, z: tc.z, radius: (0.55 + 0.9 * k) * p.radius, acid: 0.16 * p.corrosion, pattern: 'noise', seed: (c.seed + T * 31) % 97 });
          }
          if (dm) {
            const hgt = 1.45 + 0.1 * Math.sin(T * 3);
            sizzle.pos.set(dm.pos.x, 0.65, dm.pos.z); sizzle.p.set(dm.pos.x, hgt, dm.pos.z); sizzle.rate(170 * p.corrosion * k + 30, dt);
            fume.pos.set(dm.pos.x, 0.7, dm.pos.z); fume.p.set(dm.pos.x, 1.5, dm.pos.z); fume.rate(26 * p.corrosion, dt);
            drip.pos.set(dm.pos.x, 0.72, dm.pos.z); drip.vel.set(0, -0.3, 0); drip.rate(34 * p.corrosion * k, dt);
          }
          stain.pos.set(tc.x, 0.03, tc.z); stain.radius = 0.9 * p.radius; stain.rate(40 * p.corrosion * k, dt);
        }
        if (d.vortex) d.vortex.p[1] = 6 * p.speed * env * (1 - dis);
        if (dis > 0.05 && !d.dispersed) {
          d.dispersed = true;
          d.vortex?.release(); d.vortex = null;
          fx.rig.shake(0.06, 18);
        }
        if (d.l1 && fadeFly <= 0.01) { d.l1.release(); d.l1 = null; }
      },
    };
  },
};
