import * as THREE from 'three';
import { ARENA } from '../../vfx/common.js';
import { createStars } from '../light/solar-flare.glsl.js';
import { createFireballs, placeFireball, createShells, ARC_PATH, ARC_SHADE } from './supernova.glsl.js';

// Supernova (SPELLBOOK hybrid: light + fire + void). Over the target a red giant is born: motes
// pour into a seed of light over a holy sigil and it swells into a ray-traced star (giant
// convection cells, spots, deep limb darkening, a streamered corona) shedding a stellar wind, then
// pulsates, faster and harder. It implodes: the core falls in with an accelerating collapse and
// heats from red to white-blue, a contracting distortion shell and an attractor pull the wind, void
// motes and dark drain smoke in, the sigil is dragged inwards, the lights die, the gravitational
// lens (Lens.js, slot 1 preferred) bends the arena around it and for an instant it is a black hole.
// Then it explodes, matched to real high-speed explosion film: hitstop and a flash, a white-hot
// fireball that boils into lobes and cools outside-in through yellow, orange and red into
// sunlit soot as it climbs (the explosion mass: see supernova.glsl.js, kept separate so it can move
// onto the shared FluidVolume), a condensation dome riding the shock front for a fraction of a
// second (Beirut 2020), a misty condensation ring racing out, a refracting blast sphere, a dust skirt
// across the floor, blackbody ejecta arcing down and scorching, sparks that bounce. In the smoke the
// remnant pulsar sweeps two searchlight beams round and gently lenses the cloud behind it, while
// ionised filaments glow on in the cooling gas. Dummies lean into the collapse and are thrown as the
// front reaches them; the pool swirls, then ripples and flashes; the floor is scorched.

const MAX_N = 2;          // live supernovae at once (each holds a star, a fireball, a shell, four arcs)
const TI = 0.55;          // implosion length (s) at the start of the impact phase; then the bang
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _v = new THREE.Vector3(), _fp = new THREE.Vector3();
const _white = new THREE.Color(1, 1, 1), _fire = new THREE.Color(1, 0.42, 0.13);
const clamp = THREE.MathUtils.clamp, sstep = THREE.MathUtils.smoothstep;
const easeOutBack = (x) => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2;
const SPLAT = { x: 0, z: 0, radius: 1, heat: 0, char: 0, glow: 0, pattern: 'radial', seed: 0, width: 0 };
const SHOCK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 6, duration: 0.6, thickness: 0.6, distortion: 0.05, color: null, intensity: 0, ground: true };
const SIGIL = { pos: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), radius: 2, color: null, intensity: 0, reveal: 0, rotation: 0, style: 'holy', seed: 0 };

export default {
  id: 'supernova', name: 'Supernova', element: 'light', order: 30, hue: '#ff8a3a',
  shape: 'area', radius: 4,
  params: {
    size: 1, intensity: 1, collapse: 1, blast: 1, fireball: 1, soot: 1, rays: 1, lensing: 1, pulsar: 1, sparks: 1, smoke: 1, granules: 3,
    star: '#ffb468', limb: '#d42a08', shock: '#bfe9ff', filament: '#ff4a2a', void: '#8a3dff',
  },
  ranges: {
    size: [0.6, 1.6, 0.01], intensity: [0, 3, 0.01], collapse: [0, 2, 0.01], blast: [0.4, 2, 0.01], fireball: [0, 3, 0.01], soot: [0, 2, 0.01],
    rays: [0, 3, 0.01], lensing: [0, 3, 0.01], pulsar: [0, 2, 0.01], sparks: [0, 3, 0.01], smoke: [0, 3, 0.01], granules: [1.5, 10, 0.1],
  },
  presets: {
    betelgeuse: { star: '#ffb468', limb: '#d42a08', shock: '#bfe9ff', filament: '#ff4a2a', void: '#8a3dff', size: 1, granules: 3, pulsar: 1, collapse: 1, soot: 1 },
    'blue hypergiant': { star: '#eef3ff', limb: '#3d6dff', shock: '#ffffff', filament: '#ff4fb0', void: '#5a3dff', size: 1.2, granules: 5, pulsar: 1.4, soot: 0.7 },
    kilonova: { star: '#fff2c4', limb: '#ff9a10', shock: '#fff0c8', filament: '#ffc040', void: '#ff5a2a', size: 0.8, granules: 2.2, pulsar: 0, collapse: 1.5, rays: 1.6, soot: 1.4 },
  },
  timing: { charge: 1.8, impact: 1.4, linger: 3.4 },
  kinds: {
    // stellar wind off the giant; the collapse sucks it back in
    wind: { style: 'glow', drag: 1.2, buoyancy: 0.4, curl: 2, curlScale: 0.6, forceResponse: 1, life: [0.6, 1.4], size: [0.022, 0.006], stretch: 0.02, emissive: 3.5, color: ['#ffcf8a', '#ff4a14'], alpha: [1, 0], fadeIn: 0.1, fadeOut: 0.4 },
    // blackbody ejecta: white streaks cooling to orange as they arc down, scorching where they land
    ejecta: { style: 'glow', drag: 0.45, gravity: 7, restitution: 0.25, friction: 0.5, forceResponse: 0.3, life: [0.8, 2.0], size: [0.04, 0.01], stretch: 0.025, emissive: 7, temp: [4500, 1200], alpha: [1, 0], fadeIn: 0.02, fadeOut: 0.3, paints: 'heat', paintAmount: 0.05 },
    // fallback fireball (no volume free): blackbody flame that turns to smoke
    flame: { style: 'media', drag: 2.6, buoyancy: 1.6, curl: 2.4, curlScale: 0.6, forceResponse: 0.5, life: [0.45, 1.0], size: [0.3, 1.3], sizePow: 0.6, emissive: 1.3, temp: [4200, 800], toSmokeAt: 0.55, smokeAlbedo: 0.05, alpha: [0.8, 0], density: 7, distortion: 0.4, erosion: 1.5, fadeIn: 0.04, fadeOut: 0.3 },
    // the dust skirt the shock drives across the floor (lit, not glowing)
    dust: { style: 'media', emissive: 0, drag: 1.6, buoyancy: 0.3, curl: 0.9, curlScale: 0.3, forceResponse: 0.8, life: [1.2, 2.4], size: [0.35, 1.8], sizePow: 0.5, color: ['#6a5b4e', '#4a4038'], alpha: [0.42, 0], density: 1.4, erosion: 0.7, fadeIn: 0.05 },
    // soot that keeps climbing off the cloud (lit, not glowing)
    smoke: { style: 'media', emissive: 0, drag: 1.2, buoyancy: 1.3, curl: 1.5, curlScale: 0.35, life: [2.2, 4.0], size: [0.5, 2.2], sizePow: 0.55, color: ['#191513', '#2c2826'], alpha: [0.5, 0], density: 2.2, erosion: 0.8, fadeIn: 0.15, fadeOut: 0.45 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const gather = P.emitter('light.mote', { shape: 'shell', radius: 2.2, spread: 0.2, radial: -3.2, life: 0.45 });
    const windE = P.emitter('supernova.wind', { shape: 'shell', radius: 1, spread: 0.3, radial: 1.4 });
    const inMote = P.emitter('void.mote', { shape: 'shell', radius: 3.2, spread: 0.3, radial: -7 });
    const sparkE = P.emitter('light.spark', { shape: 'shell', radius: 0.4, spread: 3, radial: 12 });
    const ejectaE = P.emitter('supernova.ejecta', { shape: 'shell', radius: 0.5, spread: 2.5, radial: 10 });
    const flameE = P.emitter('supernova.flame', { shape: 'shell', radius: 0.5, spread: 1.2, radial: 8 });
    const dustE = P.emitter('supernova.dust', { shape: 'ring', radius: 1.2, spread: 0.9, radial: 11 });
    const smokeE = P.emitter('supernova.smoke', { shape: 'sphere', radius: 1, spread: 0.4 });
    const moteE = P.emitter('light.mote', { shape: 'disk', radius: 2.5, spread: 0.5 });

    // colours: parsed only when the param strings change (Color.set allocates)
    const starCol = new THREE.Color(), limbCol = new THREE.Color(), shockCol = new THREE.Color(), filCol = new THREE.Color(), voidCol = new THREE.Color();
    const giantLight = new THREE.Color(), coreCol = new THREE.Color(), hue = new THREE.Color(this.hue);
    const coreTmp = new THREE.Color(), limbTmp = new THREE.Color();
    let hex = '';
    function colours(p) {
      const h = p.star + p.limb + p.shock + p.filament + p.void;
      if (h === hex) return;
      hex = h;
      starCol.set(p.star); limbCol.set(p.limb); shockCol.set(p.shock); filCol.set(p.filament); voidCol.set(p.void);
      giantLight.copy(limbCol).lerp(starCol, 0.5);
      coreCol.copy(shockCol).lerp(voidCol, 0.35);
    }
    SHOCK.color = shockCol;

    const stars = createStars(fx, MAX_N);
    const balls = createFireballs(fx, MAX_N);
    const shells = createShells(fx, MAX_N);
    const arcs = new fx.AnalyticRibbons({ max: MAX_N * 4, segments: 96, pathGLSL: ARC_PATH, shadeGLSL: ARC_SHADE, target: 'fx' });
    fx.scenes.fx.add(arcs.mesh);

    // per cast record (cast.js keeps 16): no allocation per cast
    const ST = Array.from({ length: 16 }, () => ({
      live: false, star: null, fb: null, sh: null, light: null, force: null, sigil: null, arcs: [null, null, null, null], nArc: 0,
      S: new THREE.Vector3(), G: new THREE.Vector3(), e1: new THREE.Vector3(), e2: new THREE.Vector3(), ax: new THREE.Vector3(),
      Rg: 0, ph: 0, ring: 0, lastPeak: 0, rot: 0, banged: false, shockR: 0, hitMask: 0, pullMask: 0, poolHit: false, pool: false,
      lens: 0, E: 0, hz: 0, seed: 0,
    }));

    function splat(x, z, radius, heat, char, glow, pattern, seed, width = 0) {
      SPLAT.x = x; SPLAT.z = z; SPLAT.radius = radius; SPLAT.heat = heat; SPLAT.char = char; SPLAT.glow = glow;
      SPLAT.pattern = pattern; SPLAT.seed = seed % 100; SPLAT.width = width;
      fx.ground.splat(SPLAT);
    }
    const focus = (k) => fx.arena.setFocus(hue, k);

    // the star impostor: centre, radius, intensity, pulse, ring, corona extent (radii), spots, core/limb colours
    function placeStar(st, pos, R, I, p, pulse, ring, ext, spots, core, limb, cor = 1.2) {
      const u = st.u;
      st.core.visible = st.corona.visible = R > 1e-3;
      u.uStarA.value.set(pos.x, pos.y, pos.z, R);
      u.uStarB.value.set(p.granules, 0.12, pulse, I);
      u.uStarC.value.set(cor, ext, 0.9, 0.05);
      u.uStarD.value.y = 0.78; u.uStarD.value.z = spots; u.uStarD.value.w = ring;
      u.uStarCore.value.copy(core);
      u.uStarLimb.value.copy(limb);
    }

    // the lens: ours prefers slot 1, takes slot 0 only when 1 is held by someone else (the void
    // ticks first and rewrites its slots every frame), and only ever clears a slot still holding
    // what we wrote
    let lensSlot = -1, lensStr = 0;
    const lensPos = new THREE.Vector3();
    const lensMine = (i) => i === lensSlot && fx.lens.lenses[i].strength === lensStr && fx.lens.lenses[i].pos.equals(lensPos);
    const lensFree = (i) => !(fx.lens.lenses[i].strength > 1e-4) || lensMine(i);

    function arcsOff(d) {
      for (let k = 0; k < d.nArc; k++) { d.arcs[k]?.release(); d.arcs[k] = null; }
      d.nArc = 0;
    }

    return {
      onParam(k) { if (k === 'star' || k === 'limb' || k === 'shock' || k === 'filament' || k === 'void') colours(S.params); },

      tick() {
        arcs.update();
        let best = null;
        for (const d of ST) if (d.live && d.lens > 1e-3 && (!best || d.lens > best.lens)) best = d;
        const L = fx.lens;
        if (best) {
          const slot = lensFree(1) ? 1 : lensFree(0) ? 0 : -1;
          if (lensSlot >= 0 && slot !== lensSlot && lensMine(lensSlot)) L.lenses[lensSlot].strength = 0;
          lensSlot = slot;
          if (slot >= 0) {
            L.set(slot, best.S, Math.max(best.E, 1e-3), best.hz, best.lens);
            lensPos.copy(best.S); lensStr = best.lens;
            L.active = true;
          }
        } else if (lensSlot >= 0) {
          if (lensMine(lensSlot)) L.lenses[lensSlot].strength = 0;
          lensSlot = -1;
          if (!L.warming && !(L.lenses[0].strength > 1e-4) && !(L.lenses[1].strength > 1e-4)) L.active = false;
        }
      },

      phase(c, name) {
        const p = S.params, d = ST[c.index];
        colours(p);
        if (name === 'charge') {
          d.live = true;
          const pool = ARENA.pool;
          d.pool = Math.abs(c.to.x - pool.center.x) < pool.half.x && Math.abs(c.to.z - pool.center.y) < pool.half.y;
          d.G.set(c.to.x, d.pool ? pool.water : 0, c.to.z);
          d.Rg = 0.9 * p.size;
          d.S.set(c.to.x, d.G.y + 2.0 + d.Rg, c.to.z);
          d.ph = 0; d.ring = 0; d.lastPeak = -9; d.rot = (c.seed % 628) / 100; d.banged = false; d.shockR = 0;
          d.hitMask = 0; d.pullMask = 0; d.poolHit = false; d.lens = 0; d.E = 0; d.hz = 0; d.seed = (c.seed % 89) * 0.37;
          d.star = null;
          for (const st of stars) if (!st.busy) { d.star = st; break; }
          if (d.star) { d.star.busy = true; d.star.u.uStarD.value.x = (c.seed % 97) * 0.173; placeStar(d.star, d.S, 0, 0, p, 0, 0, 2.6, 0.6, starCol, limbCol); }
          d.fb = null; d.sh = null;
          d.light = fx.lights.acquire();
          if (d.light) { d.light.type = 0; d.light.range = 10; d.light.intensity = 0; d.light.shadow = true; d.light.color.copy(giantLight); d.light.pos.copy(d.S); }
          d.force = null;
          SIGIL.pos.copy(d.G).setY(d.G.y + 0.03); SIGIL.radius = 2.3 * p.size; SIGIL.color = starCol; SIGIL.seed = c.seed % 1000; SIGIL.rotation = d.rot;
          d.sigil = fx.sigils.acquire(SIGIL);
          if (d.sigil) { d.sigil.reveal = 0; d.sigil.intensity = 0; }
          arcsOff(d);
          // the ring's plane leans towards the camera so it opens into an ellipse from any view
          _a.subVectors(fx.camera.position, d.S).setY(0);
          if (_a.lengthSq() < 1e-4) _a.set(0, 0, 1);
          _a.normalize();
          _b.copy(UP).addScaledVector(_a, 0.3).normalize();
          d.e1.crossVectors(_b, _a).normalize();
          d.e2.crossVectors(_b, d.e1);
        } else if (name === 'impact') {
          // the collapse begins: the pull and the contracting shell
          d.force = fx.forces.acquire();
          if (d.force) { const F = d.force; F.type = 2; F.pos.copy(d.S); F.p[0] = 0; F.p[1] = 0.4; F.p[2] = 0.15; F.p[3] = 9; }
          SHOCK.pos.copy(d.S); SHOCK.radius0 = 4 * p.size; SHOCK.radius1 = 0.3; SHOCK.duration = TI; SHOCK.thickness = 1.0;
          SHOCK.distortion = 0.035 * p.collapse; SHOCK.intensity = 0; SHOCK.ground = false;
          fx.shocks?.spawn(SHOCK);
          fx.rig.shake(0.2, 5);
        } else if (name === 'done') {
          d.live = false;
          if (d.star) { d.star.busy = false; d.star.core.visible = d.star.corona.visible = false; d.star.u.uStarA.value.w = 0; }
          if (d.fb) { d.fb.busy = false; d.fb.v.visible = false; }
          if (d.sh) { d.sh.busy = false; d.sh.mesh.visible = false; d.sh.u.uNebA.value.w = 0; d.sh.u.uNebC.value.z = 0; }
          arcsOff(d);
          d.light?.release(); d.sigil?.release(); d.force?.release();
          d.star = d.fb = d.sh = d.light = d.sigil = d.force = null;
          d.lens = 0;
          focus(2.5);
        }
      },

      update(c, dt) {
        const p = S.params, d = ST[c.index], L = d.light, I = p.intensity, st = d.star;
        colours(p);
        d.rot += dt * (c.phase === 'charge' ? 0.8 : 6);
        if (d.sigil) d.sigil.rotation = d.rot;

        if (c.phase === 'charge') {
          const k = c.t / c.durations.charge;
          // a seed of light, then the giant swells; then it pulsates, faster and harder
          const grow = easeOutBack(sstep(k, 0.08, 0.5));
          const amp = 0.06 * sstep(k, 0.45, 1);
          d.ph += dt * (4 + 22 * k * k);
          const wob = Math.sin(d.ph);
          if (wob > 0.97 && c.age - d.lastPeak > 0.2) d.lastPeak = c.age;
          const since = c.age - d.lastPeak;
          d.ring = k > 0.45 && since < 0.7 ? 1 + since * 3 : 0;
          const R = Math.max(d.Rg * grow * (1 + amp * wob), 0.04 * sstep(k, 0, 0.08));
          const pulse = amp * 8 * Math.max(wob, 0);
          if (st) placeStar(st, d.S, R, (1.1 + 1.2 * k) * I * (1 + 0.5 * pulse), p, pulse, d.ring, 2.6, 0.6, starCol, limbCol);
          gather.pos.copy(d.S); gather.rate(700 * (1 - sstep(k, 0.2, 0.6)) * p.sparks, dt);
          windE.pos.copy(d.S); windE.radius = R; windE.rate(140 * p.sparks * sstep(k, 0.3, 0.6), dt);
          if (L) { L.pos.copy(d.S); L.range = 10; L.color.copy(giantLight); L.intensity = (26 * grow * (1 + 0.6 * pulse)) * I; }
          if (d.sigil) { d.sigil.reveal = sstep(k, 0, 0.6); d.sigil.intensity = (1.5 + 2.5 * k) * I; d.sigil.radius = 2.3 * p.size; }
          focus(2.5 * (1 - k) * (1 - k) + 0.2);   // the caster's orb gives its light to the star
          return;
        }

        const t = c.phase === 'impact' ? c.t : c.durations.impact + c.t;
        const lx = c.phase === 'linger' ? c.t / c.durations.linger : 0;
        if (t < TI) { implode(c, p, d, t / TI, dt); return; }
        if (!d.banged) bang(c, p, d);
        afterglow(c, p, d, t - TI, lx, dt);
      },
    };

    // --- the collapse --------------------------------------------------------------------------
    function implode(c, p, d, x, dt) {
      const I = p.intensity, st = d.star, L = d.light, cl = p.collapse;
      const R = d.Rg * Math.max(0.06, 1 - Math.pow(x, 2.2));
      if (st) {
        const core = coreTmp.copy(starCol).lerp(_white, sstep(x, 0.2, 0.9));
        const limb = limbTmp.copy(limbCol).lerp(shockCol, sstep(x, 0.3, 1));
        placeStar(st, d.S, R, (2 + 10 * x * x * x) * I, p, 0.4 * x, 0, 2.6 + 1.5 * x, 0.6 * (1 - x), core, limb);
      }
      // the lens grows as the mass gets compact; at the very end, an instant of black hole
      d.E = (0.25 + 0.4 * x) * p.size;
      d.hz = 0.2 * p.size * sstep(x, 0.85, 1) * Math.min(cl, 1);
      d.lens = p.lensing * cl * (0.1 + 0.7 * x * x);
      if (d.force) d.force.p[0] = 80 * cl * x * x;
      // everything falls in: the wind and the void's motes
      windE.pos.copy(d.S); windE.radius = R; windE.rate(100 * p.sparks * (1 - x), dt);
      inMote.pos.copy(d.S); inMote.radius = 3.2 * p.size; inMote.rate(1400 * x * cl * p.sparks, dt);
      if (L) { L.pos.copy(d.S); L.color.copy(giantLight).lerp(voidCol, x); L.intensity = 26 * I * (1 - sstep(x, 0, 0.8)) + 1; }
      if (d.sigil) { d.sigil.radius = 2.3 * p.size * (1 - 0.85 * Math.pow(x, 1.5)); d.sigil.intensity = (4 + 10 * x) * I; d.sigil.color.copy(starCol).lerp(voidCol, x); }
      focus(0.2 * (1 - x) + 0.02);
      fx.rig.shake(0.04 + 0.2 * x * x, 7);
      // the dummies lean into the pull, and are tainted by it
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i];
        const dist = dm.pos.distanceTo(d.S);
        if (dist > 7 * p.size) continue;
        dm.status.corrupt = Math.max(dm.status.corrupt, 0.5 * x * (1 - dist / (7 * p.size)));
        if (x > 0.35 && !(d.pullMask & (1 << i))) { d.pullMask |= 1 << i; dm.hit(_a.subVectors(d.S, dm.pos).setY(0), 0.3 * cl * (1 - dist / (7 * p.size)) + 0.05); }
      }
      if (x > 0.5) {
        const pool = ARENA.pool;
        const px = clamp(d.S.x, pool.center.x - pool.half.x, pool.center.x + pool.half.x), pz = clamp(d.S.z, pool.center.y - pool.half.y, pool.center.y + pool.half.y);
        if (Math.hypot(px - d.S.x, pz - d.S.z) < 4) fx.pool.swirl(px, pz, 0.3 * x * cl);
      }
    }

    // --- the explosion ---------------------------------------------------------------------------
    function bang(c, p, d) {
      d.banged = true;
      const I = p.intensity, s = p.size, bl = p.blast, G = d.G, Sx = d.S;
      fx.flash(0.35 * I);
      fx.rig.shake(1.0, 12);
      if (!fx.reduced) { fx.rig.punch(5, 0.25); fx.rig.hitstop(0.08); }
      if (d.sigil) { d.sigil.release(); d.sigil = null; }
      // the explosion mass (FLUID PORT: acquire a FluidVolume domain here and emit the core)
      d.fb = null;
      for (const f of balls) if (!f.busy) { d.fb = f; break; }
      if (d.fb) d.fb.busy = true;
      else { flameE.pos.copy(Sx); flameE.vel.set(0, 0.5, 0); flameE.burst(160 * bl); }
      d.sh = null;
      for (const sh of shells) if (!sh.busy) { d.sh = sh; break; }
      if (d.sh) { d.sh.busy = true; d.sh.mesh.visible = true; }
      // the condensation ring (a dense strand and a thin wide one) and the pulsar's beams
      arcsOff(d);
      for (let k = 0; k < 4; k++) { const h = arcs.acquire(); if (!h) break; h.intensity = 0; d.arcs[k] = h; d.nArc = k + 1; }
      _a.set(Math.cos(d.rot), 0, Math.sin(d.rot));
      d.ax.copy(UP).addScaledVector(_a, 0.55).normalize();
      // blast sphere (refraction) and a ground ring (refraction only)
      SHOCK.pos.copy(Sx); SHOCK.radius0 = 0.4; SHOCK.radius1 = 7 * s * bl; SHOCK.duration = 0.9; SHOCK.thickness = 1.2; SHOCK.distortion = 0.12 * bl; SHOCK.intensity = 0; SHOCK.ground = false;
      fx.shocks?.spawn(SHOCK);
      SHOCK.pos.copy(G).setY(G.y + 0.02); SHOCK.radius0 = 0.8; SHOCK.radius1 = 10 * s * bl; SHOCK.duration = 1.1; SHOCK.thickness = 1.0; SHOCK.distortion = 0.05 * bl; SHOCK.intensity = 0; SHOCK.ground = true;
      fx.shocks?.spawn(SHOCK);
      // ejecta, sparks, the dust skirt
      sparkE.pos.copy(Sx); sparkE.vel.set(0, 2, 0); sparkE.burst(120 * p.sparks);
      ejectaE.pos.copy(Sx); ejectaE.vel.set(0, 3, 0); ejectaE.burst(320 * p.sparks * bl);
      dustE.pos.copy(G).setY(G.y + 0.2); dustE.radius = 1.2 * s; dustE.vel.set(0, 0.5, 0); dustE.burst(d.pool ? 0 : 260 * p.smoke * bl);
      // the floor: a scorched blast pattern and a burnt ring
      splat(G.x, G.z, 3 * s, 0.35, 0.8, 0, 'noise', c.seed);
      splat(G.x, G.z, 4.4 * s * bl, 0, 0.45, 0, 'radial', c.seed + 1);
      splat(G.x, G.z, 2.6 * s, 0.25, 0.4, 0.5, 'ring', c.seed + 2, 0.5 * s);
      fx.impacts.add('scorch', G, 3.5 * s, 0.8, 6, _fire);
      if (d.force) { const F = d.force; F.type = 4; F.pos.copy(Sx); F.p[0] = 0.4; F.p[1] = 1.4; F.p[2] = 0; F.p[3] = 0; }
      d.shockR = 0.4;
      if (d.light) { d.light.range = 14; d.light.pos.copy(Sx); }
    }

    function afterglow(c, p, d, tb, lx, dt) {
      const I = p.intensity, s = p.size, bl = p.blast, st = d.star, L = d.light;
      const fade = 1 - sstep(lx, 0.55, 1);
      const pulsarOn = sstep(tb, 0.9, 1.4) * p.pulsar * (1 - sstep(lx, 0.7, 1));
      // the fireball: fast Sedov-like growth, then it climbs as it cools
      const Rf = 0.25 + 1.7 * s * Math.sqrt(bl) * Math.pow(1 - Math.exp(-tb * 5.5), 0.55) + 0.12 * tb;
      _fp.copy(d.S); _fp.y += 0.45 * Math.pow(Math.max(tb - 0.3, 0), 1.4);
      if (d.fb) {
        placeFireball(d.fb, _fp, Rf, tb, 1.0 * p.fireball * I, 5500, p.soot, fade, d.seed, filCol, sstep(tb, 0.8, 2.6));
        if (fade <= 0) { d.fb.busy = false; d.fb.v.visible = false; d.fb = null; }
      }
      // the remnant: a flash that shrinks to a pulsar, hidden in the cloud until it thins
      if (st) {
        const R = (0.07 + 0.35 * Math.exp(-tb / 0.05)) * s * (1 - sstep(lx, 0.85, 1));
        placeStar(st, d.S, R, (10 + 60 * Math.exp(-tb / 0.08)) * I, p, 0.5, 0, 8, 0, _white, shockCol, 1.2 * Math.max(Math.exp(-tb / 0.1), pulsarOn));
      }
      // the bang releases the lens
      d.lens = 0;
      // condensation dome, glare and shafts, wind nebula
      const front = 0.4 + (7 * s * bl - 0.4) * Math.pow(Math.min(tb / 0.9, 1), 0.4);
      const cond = sstep(tb, 0.02, 0.05) * (1 - sstep(tb, 0.08, 0.22));
      const sh = d.sh;
      if (sh) {
        const u = sh.u, glare = 2.5 * Math.exp(-tb / 0.07), shafts = 1.2 * p.rays * Math.exp(-tb / 0.15);
        u.uNebA.value.set(d.S.x, d.S.y, d.S.z, cond > 0 ? front : 0);
        u.uNebB.value.set(tb, I, 0.14, d.seed);
        u.uNebC.value.set(glare, shafts, (1.6 + 4.4 * Math.exp(-tb / 0.15)) * s, 0.45 * pulsarOn);
        u.uNebD.value.set(cond * bl, 2 * Math.exp(-tb / 0.1), 0, 0);
        u.uNebHot.value.copy(_white).lerp(shockCol, 0.3);
        u.uNebShock.value.copy(shockCol);
        u.uNebCore.value.copy(coreCol);
        sh.mesh.visible = cond > 0 || glare + shafts > 0.01 || pulsarOn > 0.001;
      }
      // the condensation ring and the pulsar's beams
      const xr = Math.min(tb / 1.1, 1), rr = 0.4 + 9 * s * bl * Math.pow(xr, 0.45);
      const ring = d.arcs[0], wide = d.arcs[1];
      if (ring) {
        ring.p0.set(d.S.x, d.S.y, d.S.z, rr); ring.p1.set(d.e1.x, d.e1.y, d.e1.z, 0.22 * s * (1 + 2.5 * xr)); ring.p2.set(d.e2.x, d.e2.y, d.e2.z, 0.03);
        ring.p3.set(d.seed * 0.1, 1, 0.75 * sstep(tb, 0.02, 0.08) * (1 - xr) ** 1.2, 3 * Math.exp(-tb / 0.08));
        ring.color.copy(shockCol); ring.intensity = I;
      }
      if (wide) {
        wide.p0.set(d.S.x, d.S.y, d.S.z, rr * 0.9); wide.p1.set(d.e1.x, d.e1.y, d.e1.z, 0.6 * s * (1 + 2 * xr)); wide.p2.set(d.e2.x, d.e2.y, d.e2.z, 0.05);
        wide.p3.set(d.seed * 0.1 + 0.3, 1, 0.3 * sstep(tb, 0.04, 0.12) * (1 - xr) ** 1.5, 0);
        wide.color.copy(shockCol); wide.intensity = I;
      }
      // lighthouse: the spin axis precesses about the vertical
      const om = c.age * 7.5, ca = Math.cos(om), sa = Math.sin(om);
      _a.set(d.ax.x * ca - d.ax.z * sa, d.ax.y, d.ax.x * sa + d.ax.z * ca);
      const len = 5.5 * s * sstep(tb, 0.9, 1.3);
      for (let k = 0; k < 2; k++) {
        const h = d.arcs[2 + k];
        if (!h) continue;
        const sg = k ? -1 : 1;
        h.p0.set(d.S.x + _a.x * sg * 0.05, d.S.y + _a.y * sg * 0.05, d.S.z + _a.z * sg * 0.05, 0.03 * s);
        h.p1.set(d.S.x + _a.x * sg * len, d.S.y + _a.y * sg * len, d.S.z + _a.z * sg * len, 0.3 * s);
        h.p2.set(0, 0, 0, 0);
        h.p3.set(k * 0.5, 0, 0, 0);
        h.color.copy(shockCol).lerp(voidCol, 0.2); h.intensity = 1.2 * I * pulsarOn;
      }
      // light: the blast, cooling like the fireball, then the pulsar's beat
      if (L) {
        _v.subVectors(fx.camera.position, d.S).normalize();
        const beat = Math.abs(_a.dot(_v));
        L.pos.copy(_fp);
        L.color.copy(shockCol).lerp(_fire, sstep(tb, 0.03, 0.6));
        L.intensity = (150 * Math.exp(-tb / 0.08) + 70 * Math.exp(-tb / 0.6) + 14 * Math.exp(-tb / 2) * fade + 8 * pulsarOn * (0.6 + 0.8 * beat)) * I;
        L.range = 14 - 4 * sstep(tb, 0.3, 1.5);
      }
      // the force shell runs out with the blast and lets go
      const F = d.force;
      if (F && F.type === 4) {
        d.shockR += dt * 16;
        F.p[0] = d.shockR; F.p[2] = 150 * bl * Math.max(0, 1 - d.shockR / 14);
        if (d.shockR > 14) { F.release(); d.force = null; }
      }
      // the front reaches the dummies and the pool
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i];
        if (d.hitMask & (1 << i)) continue;
        const dist = dm.pos.distanceTo(d.S);
        if (dist > front) continue;
        d.hitMask |= 1 << i;
        const reach = 10 * s * bl;
        if (dist > reach) continue;
        const k = 1 - dist / reach;
        _b.subVectors(dm.pos, d.S).setY(0);
        if (_b.lengthSq() < 1e-4) _b.copy(d.e1);
        dm.hit(_b, 1.3 * k + 0.25);
        dm.status.burn = Math.max(dm.status.burn, 0.9 * k + 0.2);
      }
      if (!d.poolHit) {
        const pool = ARENA.pool;
        const px = clamp(d.S.x, pool.center.x - pool.half.x, pool.center.x + pool.half.x), pz = clamp(d.S.z, pool.center.y - pool.half.y, pool.center.y + pool.half.y);
        if (Math.hypot(px - d.S.x, pz - d.S.z, pool.water - d.S.y) < front) {
          d.poolHit = true;
          if (front < 10 * s * bl) { fx.pool.ripple(px, pz, 0.1 * bl, 2.5); fx.pool.flash(shockCol, 1.2 * I); }
        }
      }
      // soot keeps climbing off the top of the cloud; motes rise off the scorch
      if (tb > 0.5 && lx < 0.8) {
        smokeE.pos.copy(_fp).setY(_fp.y + 0.6 * Rf); smokeE.radius = 0.6 * Rf; smokeE.vel.set(0, 1.0, 0); smokeE.rate(14 * p.smoke * (1 - lx), dt);
      }
      if (lx > 0 && lx < 0.85) {
        moteE.pos.copy(d.G).setY(d.G.y + 0.05); moteE.radius = 2.6 * s; moteE.vel.set(0, 1.2, 0); moteE.rate(80 * p.sparks * (1 - lx), dt);
      }
      focus(Math.min(2.5, 0.02 + tb * 1.5));
    }
  },
};
