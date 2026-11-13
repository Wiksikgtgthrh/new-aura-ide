import * as THREE from 'three';
import { arenaSDF, LINES_BLENDING, FX_BLENDING } from '../../vfx/common.js';
import { BODY_VERT, BODY_FRAG, HALO_VERT, HALO_FRAG } from './ball-lightning.glsl.js';

// Ball Lightning (SPELLBOOK, Lightning hero). Charge: micro-arcs converge on the focus and a
// plasma sphere swells out of them (overshoot), motes streaming in. Travel: a slow, wandering
// drift (two-sine lateral weave, bob, jitter, speed surges). The sphere is an analytic shell in
// the lines pass (hot white core, a chord-weighted body, ridged-noise veins crawling over the
// front AND back of the shell, a soft sheath, vertex wobble) plus a half-res corona with a heat
// shimmer. Three bolt filaments churn inside it. It throws short snapped arcs to whatever is near:
// dummies (shock), pillars (electric scorch), the pool (flash + ripple) or the floor (a small
// Lichtenberg burn), each with a line light along the arc. Close to the target it destabilises:
// wobble, flicker and arc rate climb, it shudders and swells. Impact: it collapses for 0.1 s,
// then detonates: a stepped leader of 10+ branching bolts out from the centre (to the floor, the
// air, any dummy or pillar in reach), a restrike, an expanding flash shell, a ground shock ring,
// a shock force on loose particles, sparks and molten plasma beads, a Lichtenberg scorch, floor
// crawl arcs (much longer over wet ground or the pool) that flicker out over the aftermath.

const MAX_BALLS = 3, N_FIL = 3, N_ARC = 2, MAX_BLAST = 14, MAX_CRAWL = 8, COLLAPSE = 0.1;
const TAU = Math.PI * 2;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const backOut = (x) => { const u = x - 1; return 1 + 2.70158 * u * u * u + 1.70158 * u * u; };
const flicker = (t, s) => 0.8 + 0.2 * Math.sin(t * 31 + s) * Math.sin(t * 13.7 + s * 0.3) + 0.07 * Math.sin(t * 71 + s);

export default {
  id: 'ball-lightning', name: 'Ball Lightning', element: 'lightning', order: 10,
  shape: 'projectile', radius: 0.3,
  params: {
    size: 1, speed: 3.6, wander: 1, intensity: 1, arcs: 1, reach: 5.5, instability: 1, blast: 1, bolts: 12, sparks: 1,
    core: '#eef3ff', glow: '#5b78ff', plasma: '#a48dff',
  },
  ranges: {
    size: [0.4, 2.5, 0.01], speed: [1, 12, 0.1], wander: [0, 3, 0.01], intensity: [0.1, 3, 0.01], arcs: [0, 3, 0.01],
    reach: [1, 9, 0.1], instability: [0, 2, 0.01], blast: [0.3, 2.5, 0.01], bolts: [0, 14, 1], sparks: [0, 3, 0.01],
  },
  presets: {
    'st elmo': { core: '#e8fffb', glow: '#1fd6c8', plasma: '#7fffe6', wander: 1.4 },
    ember: { core: '#fff2dc', glow: '#ff7a1f', plasma: '#ffc35a', speed: 2.6, instability: 1.4 },
    'violet storm': { core: '#f5e8ff', glow: '#8a3dff', plasma: '#ff6bf0', arcs: 1.8, blast: 1.4, intensity: 1.3 },
  },
  timing: { charge: 0.9, impact: 0.5, linger: 2.6, sustain: 8 },
  kinds: {
    // tintable copies of lightning.spark (presets recolour them; lightning's own stay blue)
    spark: { style: 'glow', drag: 0.4, gravity: 9.8, restitution: 0.4, friction: 0.35, life: [0.25, 0.9], size: [0.025, 0.008], stretch: 0.035, emissive: 6, color: ['#e8f0ff', '#6f8cff'], alpha: [1, 0], paints: 'heat', paintAmount: 0.03 },
    // molten plasma beads: dribble off the ball, bounce and skitter on the floor, burning in
    bead: { style: 'glow', drag: 0.25, gravity: 9.8, restitution: 0.5, friction: 0.25, life: [0.7, 1.7], size: [0.034, 0.012], stretch: 0.012, emissive: 8, color: ['#ffffff', '#8a7dff'], alpha: [1, 0], fadeOut: 0.4, paints: 'glow', paintAmount: 0.06 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const spark = P.emitter('ball-lightning.spark', { shape: 'sphere', radius: 0.12, spread: 5, radial: 3 });
    const drip = P.emitter('ball-lightning.spark', { shape: 'sphere', radius: 0.25, spread: 1.2 });
    const bead = P.emitter('ball-lightning.bead', { shape: 'sphere', radius: 0.2, spread: 3.5, radial: 2.5 });
    const mote = P.emitter('lightning.mote', { shape: 'shell', radius: 1.5, spread: 0.15 });
    const ozone = P.emitter('lightning.ozone', { shape: 'sphere', radius: 0.35, spread: 0.3 });
    const smoke = P.emitter('lightning.smoke', { shape: 'disk', radius: 1.1, spread: 0.4 });
    const lineSpark = P.emitter('ball-lightning.spark', { shape: 'line', radius: 0.04, spread: 2 });

    // --- look ---
    const core = new THREE.Color(), glow = new THREE.Color(), plasma = new THREE.Color(), glowDim = new THREE.Color(), lightCol = new THREE.Color();
    const uCore = new THREE.Vector3(), uGlow = new THREE.Vector3(), uVein = new THREE.Vector3();
    let lastLook = '';
    function applyLook() {
      const p = S.params, key = p.core + p.glow + p.plasma;
      core.set(p.core); glow.set(p.glow); plasma.set(p.plasma);
      glowDim.copy(glow).multiplyScalar(0.08);
      lightCol.copy(core).lerp(glow, 0.55);
      uCore.set(core.r, core.g, core.b); uGlow.set(glow.r, glow.g, glow.b); uVein.set(plasma.r, plasma.g, plasma.b);
      if (key === lastLook) return;
      lastLook = key;
      P.setKind('ball-lightning.spark', { color: [core.clone().lerp(glow, 0.15), glow.clone().lerp(core, 0.25)] });
      P.setKind('ball-lightning.bead', { color: [core.clone(), plasma.clone().lerp(glow, 0.4)] });
    }

    // --- plasma bodies (lines, full res) + coronas (fx, half res): one program each ---
    const sphereGeo = new THREE.IcosahedronGeometry(1, 4);
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const balls = [];
    for (let i = 0; i < MAX_BALLS; i++) {
      const uBall = { value: new THREE.Vector4() };
      const body = new THREE.Mesh(sphereGeo, new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: BODY_VERT, fragmentShader: BODY_FRAG, ...LINES_BLENDING,
        uniforms: { ...fx.U, uBall, uBall2: { value: new THREE.Vector4() }, uLook: { value: new THREE.Vector4() }, uCore: { value: uCore }, uGlow: { value: uGlow }, uVein: { value: uVein } },
      }));
      const halo = new THREE.Mesh(quadGeo, new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, ...FX_BLENDING, side: THREE.DoubleSide,
        uniforms: { ...fx.U, uBall, uHalo: { value: new THREE.Vector4() }, uGlow: { value: uGlow }, uCore: { value: uCore } },
      }));
      body.frustumCulled = halo.frustumCulled = false;
      body.visible = halo.visible = false;
      fx.scenes.lines.add(body);
      fx.scenes.fx.add(halo);
      balls.push({ body, halo, free: true, u: body.material.uniforms, h: halo.material.uniforms.uHalo.value });
    }
    const takeBall = () => { for (const b of balls) if (b.free) { b.free = false; return b; } return null; };
    const dropBall = (b) => { if (b) { b.body.visible = b.halo.visible = false; b.free = true; } };
    // C centre, R radius, I intensity, wob wobble, inst instability, veins, flash, halo extent / intensity / shimmer
    function poseBall(b, C, R, I, wob, inst, veins, flash, hx, hi, hd, seed) {
      b.body.visible = b.halo.visible = true;
      b.u.uBall.value.set(C.x, C.y, C.z, R);
      b.u.uBall2.value.set(fx.U.uTime.value, wob, seed, inst);
      b.u.uLook.value.set(I, 0.36 + 0.14 * inst, veins, flash);
      b.h.set(hx, hi, hd, fx.U.uTime.value);
    }

    // --- per-cast state by cast index: nothing allocated per cast ---
    const V3 = () => new THREE.Vector3();
    const st = Array.from({ length: 16 }, () => ({
      ball: null, fil: [null, null, null], arcs: Array.from({ length: N_ARC }, () => ({ h: null, age: 0, life: 0, end: V3(), dir: V3() })),
      blast: new Array(MAX_BLAST).fill(null), nb: 0, crawl: new Array(MAX_CRAWL).fill(null), nc: 0,
      L1: null, L2: null, force: null, trail: null, perp: V3(), g: V3(), arcEnd: V3(),
      s: 0, D: 1, amp: 0, ph1: 0, ph2: 0, ph3: 0, nextArc: 0, reseed: 0, inst: 0, R: 0, kick: 0, arcLight: 0,
      det: false, boom: 0, restrike: false, wet: false, bseed: 0,
    }));
    const _a = V3(), _b = V3(), _c = V3(), _d = V3(), _up = new THREE.Vector3(0, 1, 0);
    const seedInt = () => (fx.rand() * 16777215) | 0;
    const BOLT = { a: V3(), b: V3(), branches: 3, subBranches: 3, jag: 0.17, width: 0.012, color: core, glowColor: glowDim, intensity: 0, glowWidth: 9, reveal: 1, snapToArena: false, seed: 1, branchSeed: 1 };
    function bolt(a, b, branches, sub, jag, width, glowWidth, reveal, snap) {
      BOLT.a.copy(a); BOLT.b.copy(b); BOLT.branches = branches; BOLT.subBranches = sub; BOLT.jag = jag; BOLT.width = width;
      BOLT.glowWidth = glowWidth; BOLT.reveal = reveal; BOLT.snapToArena = snap; BOLT.seed = seedInt(); BOLT.branchSeed = seedInt();
      return fx.bolts.acquire(BOLT);
    }
    const SPL = { x: 0, z: 0, radius: 1, heat: 0, char: 0, glow: 0, pattern: 'lichtenberg', seed: 0 };
    const SCORCH = new THREE.Color(1, 0.4, 0.1);   // impacts.add allocates its default colour when given none
    function splat(x, z, radius, heat, char, glowAmt, seed) {
      SPL.x = x; SPL.z = z; SPL.radius = radius; SPL.heat = heat; SPL.char = char; SPL.glow = glowAmt; SPL.seed = seed % 1000;
      fx.ground.splat(SPL);
    }
    const SHK = { pos: V3(), radius0: 0.3, radius1: 4, duration: 0.5, thickness: 0.5, distortion: 0.04, color: glow, intensity: 0, ground: false };
    function shock(pos, r0, r1, dur, thick, dist, intensity, ground) {
      SHK.pos.copy(pos); SHK.radius0 = r0; SHK.radius1 = r1; SHK.duration = dur; SHK.thickness = thick;
      SHK.distortion = dist; SHK.intensity = intensity; SHK.ground = ground;
      fx.shocks.spawn(SHK);
    }
    const pool = fx.ARENA.pool;
    const inPool = (x, z, pad) => Math.abs(x - pool.center.x) < pool.half.x + pad && Math.abs(z - pool.center.y) < pool.half.y + pad;
    const isWet = (x, z) => inPool(x, z, 0) || (fx.groundAt(x, z)?.[2] ?? 0) > 0.3;

    // the drift: a two-sine weave across the line and a bob, both pinned at the ends
    function pathAt(c, d, s, out) {
      const env = Math.sin(Math.PI * Math.min(s, 1)), w = S.params.wander;
      const lat = d.amp * w * env * (0.65 * Math.sin(TAU * 1.15 * s + d.ph1) + 0.35 * Math.sin(TAU * 2.6 * s + d.ph2));
      out.lerpVectors(c.from, c.to, Math.min(s, 1)).addScaledVector(d.perp, lat);
      out.y += 0.35 * w * env * Math.sin(TAU * 1.7 * s + d.ph3);
      return out;
    }

    // a snapped arc to the nearest conductor in reach (dummy, pillar, pool), else the floor
    function spawnArc(c, p, d, arc) {
      const C = c.pos, R = d.R, reach = p.reach * p.size;
      let best = reach, kind = 0, dmi = -1;
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i].pos;
        const dist = Math.hypot(dm.x - C.x, dm.z - C.z) - 0.35;
        if (dist < best && fx.rand() < 0.8) { best = dist; kind = 1; dmi = i; _c.set(dm.x, 0.7 + 0.8 * fx.rand(), dm.z); }
      }
      for (const pl of fx.ARENA.pillars) {
        const dist = Math.hypot(pl.x - C.x, pl.z - C.z) - 0.6;
        if (dist < best && fx.rand() < 0.7) {
          best = dist; kind = 2;
          _d.set(C.x - pl.x, 0, C.z - pl.z).normalize();
          _c.set(pl.x + _d.x * 0.6, Math.min(5.5, Math.max(0.3, C.y + (fx.rand() - 0.4) * 2)), pl.z + _d.z * 0.6);
        }
      }
      if (inPool(C.x, C.z, reach * 0.6) && fx.rand() < 0.7) {
        kind = 3;
        _c.set(Math.min(Math.max(C.x + (fx.rand() - 0.5), pool.center.x - pool.half.x + 0.2), pool.center.x + pool.half.x - 0.2), pool.water,
          Math.min(Math.max(C.z + (fx.rand() - 0.5), pool.center.y - pool.half.y + 0.2), pool.center.y + pool.half.y - 0.2));
      }
      if (kind === 0) {
        const ang = fx.rand() * TAU, r = (0.3 + 1.1 * fx.rand()) * p.size + 0.25 * C.y;
        _c.set(C.x + Math.cos(ang) * r, 0.01, C.z + Math.sin(ang) * r);
      }
      arc.end.copy(_c);
      arc.dir.subVectors(_c, C).normalize();
      _a.copy(C).addScaledVector(arc.dir, R * 0.9);
      const len = _a.distanceTo(_c);
      arc.h = bolt(_a, _c, len > 2.5 ? 5 : 2, len > 2.5 ? 6 : 2, 0.15 + 0.04 * fx.rand(), (0.012 + 0.003 * Math.min(len, 5)) * p.size, 10, 1, false);
      if (!arc.h) return;
      arc.age = 0; arc.life = 0.1 + 0.08 * fx.rand();
      // contact: sparks, a burn, whatever the target does
      spark.pos.copy(_c); spark.vel.copy(arc.dir).multiplyScalar(-1.5); spark.burst(110 * p.sparks);
      d.kick = 1; d.arcLight = 1; d.arcEnd.copy(_c);
      if (kind === 0) { splat(_c.x, _c.z, 0.55 * p.size, 0.25, 0.55, 0.35, seedInt()); }
      else if (kind === 1) { const dm = fx.dummies[dmi]; dm.status.shock = 1; dm.hit(_d.copy(arc.dir).setY(0).normalize(), 0.18); }
      else if (kind === 2) { fx.impacts.add('electric', _c, 0.9, 1, 1.2, core); fx.impacts.add('scorch', _c, 0.5, 0.6, 6, SCORCH); }
      else { fx.pool.flash(glow, 0.8); fx.pool.ripple(_c.x, _c.z, 0.025, 0.5); }
    }

    function releaseAll(d) {
      for (let i = 0; i < N_FIL; i++) { d.fil[i]?.release(); d.fil[i] = null; }
      for (const a of d.arcs) { a.h?.release(); a.h = null; }
      for (let i = 0; i < d.nb; i++) d.blast[i]?.release();
      for (let i = 0; i < d.nc; i++) d.crawl[i]?.release();
      d.blast.fill(null); d.crawl.fill(null); d.nb = d.nc = 0;
      d.L1?.release(); d.L2?.release(); d.force?.release(); d.trail?.release(); d.L1 = d.L2 = d.force = d.trail = null;
      dropBall(d.ball); d.ball = null;
    }

    return {
      onParam() { applyLook(); },

      // slow wandering flight; detonates on reaching the target or touching anything solid
      travel(c, dt) {
        const p = S.params, d = st[c.index];
        const surge = Math.min(1, c.t / 0.6) * (1 + 0.28 * Math.sin(c.t * 2.3 + d.ph2));
        d.s += p.speed * surge * dt / d.D;
        _b.copy(c.pos);
        pathAt(c, d, d.s, c.pos);
        const j = 0.035 * p.size * (1 + 2.5 * d.inst * p.instability);
        c.pos.x += j * Math.sin(c.age * 7.3); c.pos.y += j * Math.sin(c.age * 9.1 + 1); c.pos.z += j * Math.sin(c.age * 6.7 + 2);
        if (dt > 0) c.vel.subVectors(c.pos, _b).divideScalar(dt);
        c.travelled += _b.distanceTo(c.pos);
        d.inst = smooth(0, 1, 1 - (1 - d.s) * d.D / 3.2);
        return d.s >= 1 || (c.travelled > 1 && arenaSDF(c.pos) < d.R * 0.7) || c.t > c.durations.travel;
      },

      phase(c, name) {
        const p = S.params, d = st[c.index];
        if (name === 'charge') {
          applyLook();
          releaseAll(d);
          d.ball = takeBall();
          for (let i = 0; i < N_FIL; i++) d.fil[i] = bolt(c.from, c.from, 0, 0, 0.25, 0.008 * p.size, 7, 1, false);
          d.L1 = fx.lights.acquire();
          if (d.L1) { d.L1.range = 9; d.L1.intensity = 0; d.L1.color.copy(lightCol); d.L1.shadow = true; d.L1.type = 0; }
          d.L2 = fx.lights.acquire();
          if (d.L2) { d.L2.range = 8; d.L2.intensity = 0; d.L2.color.copy(core).lerp(glow, 0.3); d.L2.type = 0; }
          d.force = fx.forces.acquire();
          if (d.force) { d.force.type = 2; d.force.p[0] = 20; d.force.p[1] = 0.5; d.force.p[2] = 0.15; d.force.p[3] = 3; d.force.pos.copy(c.from); }
          d.s = 0; d.inst = 0; d.R = 0; d.kick = 0; d.arcLight = 0; d.reseed = 0; d.det = false; d.boom = 0; d.restrike = false;
          d.nextArc = 0.25;
          d.ph1 = fx.rand() * TAU; d.ph2 = fx.rand() * TAU; d.ph3 = fx.rand() * TAU; d.bseed = (c.seed % 97) * 0.37;
        } else if (name === 'release') {
          d.D = Math.max(c.from.distanceTo(c.to), 1);
          d.perp.crossVectors(c.dir, _up);
          if (d.perp.lengthSq() < 1e-6) d.perp.set(1, 0, 0);
          d.perp.normalize();
          d.amp = Math.min(1.7, 0.16 * d.D);
          fx.rig.shake(0.1, 14);
          spark.pos.copy(c.from); spark.vel.copy(c.dir).multiplyScalar(2); spark.burst(80 * p.sparks);
          if (d.force) { d.force.p[0] = 6; d.force.p[2] = 0; d.force.p[3] = 1.6; }
          // a faint ionised wake that draws the meander
          const t = d.trail = fx.trails.acquire();
          if (t) { t.width = 0.2 * p.size; t.intensity = 2.2 * p.intensity; t.glow = 4; t.glowIntensity = 0.4; t.fadeTime = 0.5; t.distortion = 0.04; t.color.copy(glow).lerp(core, 0.3); }
        } else if (name === 'impact') {
          for (const a of d.arcs) { a.h?.release(); a.h = null; }
          d.trail?.release(); d.trail = null;
        } else if (name === 'done') {
          releaseAll(d);
        }
      },

      update(c, dt) {
        const p = S.params, d = st[c.index], b = d.ball, C = c.pos;
        const fl = flicker(c.age, c.seed % 17), R0 = 0.32 * p.size;
        d.kick *= Math.exp(-dt * 22);
        d.arcLight *= Math.exp(-dt * 30);
        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge, grow = backOut(smooth(0.08, 0.85, k));
          d.R = R0 * Math.max(grow, 0.02);
          if (b) poseBall(b, C, d.R, (0.35 + 0.75 * k) * fl * p.intensity, 0.08, 0, 0.4 + 0.6 * k, 0, 3.4, 1.6 * k * p.intensity, 0.02 * k, d.bseed);
          // micro-arcs converge from a shrinking shell into the forming ball, reseeded at 20 Hz
          d.reseed -= dt;
          for (let i = 0; i < N_FIL; i++) {
            const h = d.fil[i];
            if (!h) continue;
            if (d.reseed <= 0) {
              _a.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).normalize();
              h.a.copy(C).addScaledVector(_a, (1.1 - 0.75 * k) * p.size); h.b.copy(C);
              h.seed = seedInt(); h.branches = 1; h.subBranches = 1;
            }
            h.intensity = 26 * p.intensity * (0.3 + 0.7 * k) * (fx.rand() < 0.75 ? 1 : 0);
          }
          if (d.reseed <= 0) d.reseed = 0.05;
          mote.pos.copy(C); mote.vel.set(0, 0, 0); mote.rate(1700 * p.sparks * k, dt);
          if (d.L1) { d.L1.pos.copy(C); d.L1.intensity = 12 * k * fl * p.intensity; }
          if (d.force) d.force.pos.copy(C);
          return;
        }

        if (c.phase === 'travel') {
          const inst = d.inst * p.instability;
          // shudders, pulses and swells as it destabilises
          const R = d.R = R0 * (1 + 0.04 * Math.sin(c.age * 11) + 0.1 * inst * Math.sin(c.age * 37) * Math.sin(c.age * 5.3) + 0.12 * inst);
          const I = (0.9 + 0.35 * inst) * (fl + 0.35 * d.kick) * p.intensity;
          if (b) poseBall(b, C, R, I, 0.06 + 0.2 * inst, inst, 1 + 1.3 * inst, 0.25 * d.kick, 3.4, (1.5 + 0.8 * d.kick + inst) * p.intensity, 0.03 * p.size, d.bseed);
          // filaments churn inside the shell
          d.reseed -= dt;
          for (let i = 0; i < N_FIL; i++) {
            const h = d.fil[i];
            if (!h) continue;
            const th = c.age * (1.3 + 0.45 * i) * (1 + inst) + i * 2.1, ph = Math.sin(c.age * (0.9 + 0.3 * i) + i) * 1.2;
            _a.set(Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th));
            h.a.copy(C).addScaledVector(_a, -0.25 * R); h.b.copy(C).addScaledVector(_a, 0.95 * R);
            if (d.reseed <= 0) { h.seed = seedInt(); h.branchSeed = seedInt(); h.branches = 2; h.subBranches = 0; h.jag = 0.3; }
            h.intensity = (30 + 20 * inst) * p.intensity * (0.6 + 0.4 * fx.rand());
          }
          if (d.reseed <= 0) d.reseed = 0.06 - 0.03 * inst;
          // snapped arcs
          d.nextArc -= dt;
          if (d.nextArc <= 0 && p.arcs > 0) {
            for (const a of d.arcs) if (!a.h) { spawnArc(c, p, d, a); break; }
            d.nextArc = (0.36 - 0.24 * Math.min(inst, 1)) * (0.6 + 0.8 * fx.rand()) / p.arcs;
          }
          updateArcs(c, p, d, dt);
          // sheds sparks, beads and ozone along the way
          drip.pos.copy(C); drip.radius = R; drip.vel.copy(c.vel).multiplyScalar(0.3); drip.rate((30 + 90 * inst) * p.sparks, dt);
          bead.pos.copy(C); bead.radius = 0.8 * R; bead.vel.copy(c.vel).multiplyScalar(0.2); bead.rate((5 + 20 * inst) * p.sparks, dt);
          ozone.pos.copy(C); ozone.vel.set(0, 0.2, 0); ozone.rate(45, dt);
          d.trail?.push(C);
          if (inPool(C.x, C.z, 0.3)) fx.pool.swirl(C.x, C.z, 0.6);
          if (d.L1) { d.L1.pos.copy(C); d.L1.intensity = (13 + 8 * inst + 22 * d.kick) * fl * p.intensity; }
          // a point at the strike end: a line light this low mirrors in the polished floor as a straight CG streak
          if (d.L2) { d.L2.pos.lerpVectors(C, d.arcEnd, 0.7); d.L2.intensity = 22 * d.arcLight * p.intensity; }
          if (d.force) d.force.pos.copy(C);
          return;
        }

        // impact: collapse, then detonate; impact + linger: the blast plays out
        if (!d.det) {
          const k = Math.min(1, c.t / COLLAPSE);
          const R = d.R * (1 - 0.55 * k * k * k);
          if (b) poseBall(b, C, R, (1.3 + 3 * k * k) * p.intensity, 0.25 * (1 - k), 1, 2.4 * (1 - k), 0.6 * k, 3.4, (2.5 + 4 * k) * p.intensity, 0.05 * p.size, d.bseed);
          for (let i = 0; i < N_FIL; i++) { const h = d.fil[i]; if (h) { h.b.copy(C); h.intensity = 30 * p.intensity * (fx.rand() < 0.8 ? 1 : 0); h.seed = seedInt(); } }
          if (d.L1) d.L1.intensity = (20 + 40 * k) * p.intensity;
          if (d.force) { d.force.pos.copy(C); d.force.p[0] = 40; d.force.p[3] = 3; }
          if (c.t >= COLLAPSE) detonate(c, p, d);
          return;
        }
        const a = (d.boom += dt), bl = p.blast, fade = c.phase === 'linger' ? Math.max(0, 1 - c.t / c.durations.linger) : 1;
        // the flash shell: swells fast, burns out eased
        if (b) {
          if (a > 0.55) { dropBall(b); d.ball = null; }
          else {
            const out = 1 - smooth(0.12, 0.55, a);
            poseBall(b, C, d.R * (0.45 + 2.6 * bl * (1 - Math.exp(-a * 13))), (0.5 + 2.2 * Math.exp(-a / 0.05)) * out * p.intensity, 0.3, 1, 2.2 * out, 0.06 * Math.exp(-a / 0.04), 2.6, 3.2 * out * out * p.intensity, 0.06 * out * p.size, d.bseed);
          }
        }
        // stepped leader out from the centre, then return stroke, one restrike, decay
        for (let i = 0; i < d.nb; i++) {
          const h = d.blast[i];
          if (!h) continue;
          if (a < 0.07) { h.reveal = a / 0.07; h.intensity = 10 * p.intensity; }
          else {
            h.reveal = 1;
            if (!d.restrike && a >= 0.16) { h.branchSeed = seedInt(); h.intensity = 55 * p.intensity; }
            else if (a < 0.07 + dt * 1.5) h.intensity = 75 * p.intensity;
            else h.intensity *= Math.exp(-dt * 13);
            if (h.intensity < 0.2) { h.release(); d.blast[i] = null; }
          }
        }
        if (!d.restrike && a >= 0.16) {
          d.restrike = true;
          fx.flash(0.18 * p.intensity);
          spark.pos.copy(C); spark.vel.set(0, 1, 0); spark.burst(500 * p.sparks);
          if (d.L1) d.L1.intensity = 130 * p.intensity;
        }
        // floor crawl flickers out over the aftermath
        for (let i = 0; i < d.nc; i++) {
          const h = d.crawl[i];
          if (!h) continue;
          h.intensity = fx.rand() < 0.4 * fade + 0.1 ? 32 * p.intensity * fade : 0;
          if (fx.rand() < 0.2) h.branchSeed = seedInt();
        }
        if (d.force) {
          if (a < 0.45) { d.force.p[0] = 0.5 + 9 * bl * Math.pow(a / 0.45, 0.4); d.force.p[2] = 45 * (1 - a / 0.45); }
          else { d.force.release(); d.force = null; }
        }
        if (d.L1) {
          d.L1.intensity *= Math.exp(-dt / 0.13);
          if (c.phase === 'linger') d.L1.intensity = Math.max(d.L1.intensity, 3 * fl * fade * p.intensity);
        }
        if (d.L2) d.L2.intensity *= Math.exp(-dt / 0.09);
        if (c.phase === 'linger' && fade > 0.3) { ozone.pos.copy(d.g).setY(0.4); ozone.radius = 1.2; ozone.vel.set(0, 0.3, 0); ozone.rate(70 * fade, dt); }
      },
    };

    function updateArcs(c, p, d, dt) {
      for (const a of d.arcs) {
        const h = a.h;
        if (!h) continue;
        a.age += dt;
        if (a.age > a.life) { h.release(); a.h = null; continue; }
        h.a.copy(c.pos).addScaledVector(a.dir, d.R * 0.9);
        h.intensity = (fx.rand() < 0.8 ? 1 : 0.15) * 70 * Math.sqrt(1 - a.age / a.life) * p.intensity;
        if (fx.rand() < 0.35) h.branchSeed = seedInt();
      }
    }

    function detonate(c, p, d) {
      d.det = true; d.boom = 0;
      const C = c.pos, g = d.g.set(C.x, 0, C.z), bl = p.blast, s = p.size;
      for (let i = 0; i < N_FIL; i++) { d.fil[i]?.release(); d.fil[i] = null; }
      d.wet = isWet(g.x, g.z);
      // radial bolts: to every dummy and pillar in reach first, then the floor and the air
      const n = Math.min(MAX_BLAST, Math.round(p.bolts));
      d.nb = 0;
      let splats = 0;
      for (let i = 0; i < fx.dummies.length && d.nb < n; i++) {
        const dm = fx.dummies[i].pos;
        if (Math.hypot(dm.x - C.x, dm.z - C.z) < 5.5 * bl) { _c.set(dm.x, 0.6 + 0.9 * fx.rand(), dm.z); addBlast(d, C, _c, 0.024); }
      }
      for (const pl of fx.ARENA.pillars) {
        if (d.nb >= n) break;
        const dist = Math.hypot(pl.x - C.x, pl.z - C.z);
        if (dist < 7 * bl) { _d.set(C.x - pl.x, 0, C.z - pl.z).normalize(); _c.set(pl.x + _d.x * 0.6, 0.6 + 2.5 * fx.rand(), pl.z + _d.z * 0.6); addBlast(d, C, _c, 0.022); fx.impacts.add('electric', _c, 1.4, 1, 1.6, core); }
      }
      const a0 = fx.rand() * TAU;
      for (let i = d.nb, k = 0; i < n; i++, k++) {
        const ang = a0 + k * 2.4 + (fx.rand() - 0.5) * 0.5;
        if (k % 5 < 3) {   // grounded
          const r = (2.2 + 3 * fx.rand()) * bl;
          _c.set(C.x + Math.cos(ang) * r, 0.01, C.z + Math.sin(ang) * r);
          if (splats < 6) { splat(_c.x, _c.z, 0.9 * s, 0.3, 0.7, 0.3, seedInt()); splats++; }
        } else {            // into the air
          const el = 0.1 + 0.55 * fx.rand(), r = (2.4 + 2 * fx.rand()) * bl;
          _c.set(C.x + Math.cos(ang) * Math.cos(el) * r, C.y + Math.sin(el) * r, C.z + Math.sin(ang) * Math.cos(el) * r);
        }
        addBlast(d, C, _c, 0.02);
      }
      // floor crawl, much further over wet ground
      d.nc = 0;
      const nCrawl = Math.min(MAX_CRAWL, 6);
      for (let i = 0; i < nCrawl; i++) {
        const ang = (i / nCrawl) * TAU + fx.rand(), len = (d.wet ? 4 + 5 * fx.rand() : 1.2 + 1.8 * fx.rand()) * bl;
        _a.copy(g).setY(0.05);
        _b.set(g.x + Math.cos(ang) * len, 0.02, g.z + Math.sin(ang) * len);
        const h = bolt(_a, _b, 2, 2, 0.18, 0.012, 8, 1, true);
        if (h) d.crawl[d.nc++] = h;
      }
      // a burn, not a neon decal: real Lichtenberg ground marks glow for milliseconds, then stay as char
      splat(g.x, g.z, 3.2 * bl, 0.8, 1, 0.3, c.seed);
      if (d.wet) { fx.pool.flash(glow, 1.6); splat(g.x, g.z, 6 * bl, 0, 0, 0.7, c.seed + 777); }
      if (inPool(g.x, g.z, 1.5)) fx.pool.ripple(g.x, g.z, 0.06, 1.5);
      fx.impacts.add('electric', g, 3.4 * bl, 0.25, 0.7, core);
      fx.impacts.add('scorch', g, 2.4 * bl, 0.9, 9, SCORCH);
      shock(_a.copy(g).setY(0.04), 0.3, 6 * bl, 0.45, 0.5, 0.05, 1.3, true);
      shock(C, 0.2, 3.4 * bl, 0.32, 0.5, 0.07, 0, false);
      spark.pos.copy(C); spark.vel.set(0, 1.5, 0); spark.burst(2000 * p.sparks);
      bead.pos.copy(C); bead.vel.set(0, 2.5, 0); bead.burst(140 * p.sparks);
      smoke.pos.copy(g).setY(0.3); smoke.burst(150);
      ozone.pos.copy(C); ozone.radius = 0.8; ozone.vel.set(0, 0.5, 0); ozone.burst(120);
      if (d.L1) { d.L1.pos.copy(C); d.L1.range = 18 * bl; d.L1.intensity = 220 * p.intensity; }
      if (d.L2) { d.L2.type = 0; d.L2.pos.copy(g).setY(0.3); d.L2.range = 9 * bl; d.L2.intensity = 50 * p.intensity; }
      if (d.force) { d.force.type = 4; d.force.pos.copy(C); d.force.p[0] = 0.5; d.force.p[1] = 1.2; d.force.p[2] = 45; d.force.p[3] = 0; }
      fx.flash(0.42 * p.intensity);
      fx.rig.shake(0.6, 22);
      if (!fx.reduced) { fx.rig.punch(2.5, 0.07); fx.rig.hitstop(0.06); }
      const RD = 4.5 * bl;
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i], dist = Math.hypot(dm.pos.x - C.x, dm.pos.z - C.z);
        if (i === c.target || dist < RD) {
          const k = Math.max(0, 1 - dist / RD);
          dm.status.shock = 1; dm.status.burn = Math.max(dm.status.burn, 0.35 * k);
          dm.hit(_d.subVectors(dm.pos, C).setY(0).normalize(), 1.1 * k);
        }
      }
    }
    function addBlast(d, C, end, width) {
      const p = S.params;
      _d.subVectors(end, C).normalize();
      _a.copy(C).addScaledVector(_d, d.R * 0.4);
      const h = bolt(_a, end, 5, 7, 0.13, width * p.size, 11, 0, false);
      if (h) d.blast[d.nb++] = h;
      // sparks shed down the outer half of each bolt
      if (h && d.nb <= 6) { lineSpark.pos.copy(h.point(0.5, _b)); lineSpark.p.copy(end); lineSpark.burst(120 * p.sparks); }
    }
  },
};
