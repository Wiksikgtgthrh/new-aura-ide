import * as THREE from 'three';

// Black Flame (hybrid, void + fire). Fire that drinks light instead of giving it: the reference is
// the sodium-lamp "black fire" (a sodium-laden flame under monochromatic sodium light absorbs it
// and burns as an opaque black flame with fire's own motion), with a violet corona and embers.
// Charge: the caster's orb dims as if its light were being drawn off, violet motes converge on
// the target and black licks start to smoulder at its feet while a void sigil draws itself.
// Release: the flame erupts into a roaring column round the target (overshooting, then settling),
// cinders burst out with weight and paint corruption where they land.
// Impact: the column burns. Its body is a cold, opaque black medium (faintly sun-lit, so it keeps
// its form); only its thin outer skin burns violet, so it reads black face-on and glows at the
// silhouette and the tongue tips, white-violet at the roots. Black licks tear off it, violet embers
// spiral up a vortex, black ash rises, a violet line light inside throws the dummy's shadow, an
// attractor drags loose particles in and swallows them, the dummy burns and corrupts.
// Aftermath: the column gutters from the top down into low black flames on a scar of char and
// corruption, with absorbing smoke and the last embers drifting.
//
// The flame mass is isolated in flameMass below (acquire / drive / release) so it can move onto
// the shared FluidVolume's absorbing mode when that is ready; everything else drives it through
// those three calls.

const MAX = 2;

// --- flame mass: raymarched capsule (fx.volumes) -----------------------------------------------
const MASS_GLSL = /* glsl */`
uniform vec4 uBF;      // radius m, height m, time s, seed
uniform vec4 uBF2;     // skin gain, swirl, die (0 -> 1), body density
uniform vec3 uBFBase;  // floor centre
uniform vec3 uBFRim;   // corona colour (linear)
uniform vec3 uBFCore;  // root colour (linear)
void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission) {
  sigma = 0.0; albedo = vec3(0.0); emission = vec3(0.0);
  float R = uBF.x, H = uBF.y, time = uBF.z, die = uBF2.z;
  vec3 q = pw - uBFBase;
  float h = q.y / H;
  if (h < -0.05 || h > 1.35) return;
  // profile: a wide root hugging the target, necking in, tongues tearing off above
  float rad = R * (0.62 - 0.42 * h + 0.3 * exp(-h * 6.0));
  float amp = R * (0.28 + 0.55 * h);
  float d0 = rad - length(q.xz);
  if (d0 < -amp) return;
  // a frame that turns with the vortex, faster low down; band-limited rising noise as fire.js
  float ang = uBF2.y * time * (1.5 - 0.8 * h);
  float c = cos(ang), s = sin(ang);
  vec2 xz = vec2(c * q.x - s * q.z, s * q.x + c * q.z);
  // stretched upwards (flame tongues are tall), rising fast; a slow lobe octave and a detail octave
  float f = 0.36 / R;
  vec3 np = vec3(xz.x, q.y * 0.4 - time * 2.2, xz.y) * f + uBF.w;
  np += curl3(np * 0.45 + vec3(0.0, -0.3 * time, uBF.w)) * 0.35;
  float n1 = noise3(np), n2 = noise3(np * vec3(2.2, 1.6, 2.2) + vec3(0.31, -0.7 * f * time, 0.17));
  float detail = 1.0 - smoothstep(0.35, 0.9, gVolDt / R);
  float d = d0 + (n1 - 0.5) * 2.2 * amp + (n2 - 0.5) * 0.7 * amp * detail - die * R * 0.9;
  // the top tears into separate tongues: the cut-off height itself is noise
  float top = 1.0 - smoothstep(0.55, 1.0, h + (n1 - 0.5) * 1.1 + (n2 - 0.5) * 0.35 + die * 0.6);
  float body = smoothstep(0.0, 0.3 * R, d) * top;
  // the burning skin: a thin glow just outside the black surface (sharp on the inside)
  float skin = (d < 0.0 ? exp(d / (0.1 * R)) : exp(-d / (0.02 * R))) * top;
  if (body + skin < 2e-3) return;
  // it burns at the column's outline, the tongue tips and the roots, and hardly where the camera
  // looks straight into the black (so the body reads black face-on, like the sodium flame)
  vec2 vd = normalize(cameraPosition.xz - pw.xz + 1e-4), rd = q.xz / max(length(q.xz), 1e-3);
  float sil = 1.0 - abs(dot(rd, vd));
  float root = exp(-max(q.y, 0.0) / 0.22);
  float sil2 = sil * sil;
  float burn = 2.4 * sil2 * sil2 + 0.6 * sil2 * smoothstep(0.6, 1.0, h) + 1.6 * root;
  float sb = body * 11.0 * uBF2.w, ss = skin * 0.5;
  sigma = (sb + ss) / R;
  vec3 L = mix(uBFRim, uBFCore, 0.6 * root) * (0.3 + 1.4 * n2 * n2) * burn;
  emission = ss * L * uBF2.x / R;
  // albedo stays 0: a pure absorber (the violet light inside would otherwise light it up), and
  // zero-albedo samples skip the lighting taps entirely
}`;

function makeFlameMass(fx, count) {
  const rim = new THREE.Color(), core = new THREE.Color();
  const list = [];
  for (let i = 0; i < count; i++) {
    const h = fx.volumes.add({
      shape: 'capsule', glsl: MASS_GLSL, maxSteps: 28,
      uniforms: { uBF: { value: new THREE.Vector4() }, uBF2: { value: new THREE.Vector4() }, uBFBase: { value: new THREE.Vector3() }, uBFRim: { value: rim }, uBFCore: { value: core } },
    });
    h.g = 0.2; h.ambient = 1; h.sun = 1;
    h.busy = false;
    list.push(h);
  }
  return {
    rim, core,
    acquire() { for (const h of list) if (!h.busy) { h.busy = true; h.visible = false; return h; } return null; },
    // base: floor point; R radius, H height (m); die 0..1 gutters it from the top down
    drive(h, base, R, H, time, seed, skin, swirl, die, density) {
      h.visible = H > 0.05 && die < 1;
      if (!h.visible) return;
      const ra = R * 1.6, hy = Math.max((1.3 * H + ra) * 0.5, ra);
      h.position.set(base.x, 1.3 * H - hy, base.z);
      h.scale.set(ra, hy, ra);
      h.uniforms.uBF.value.set(R, H, time, seed);
      h.uniforms.uBF2.value.set(skin, swirl, die, density);
      h.uniforms.uBFBase.value.set(base.x, 0, base.z);
    },
    release(h) { h.visible = false; h.busy = false; },
  };
}

// --- module scratch ------------------------------------------------------------------------------
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _col = new THREE.Color();
const SPLAT = { x: 0, z: 0, radius: 1, char: 0, corruption: 0, glow: 0, pattern: 'noise', seed: 0, width: 0 };
const SHOCK = { pos: new THREE.Vector3(), radius0: 0.3, radius1: 4, duration: 0.5, thickness: 0.7, distortion: 0.05, intensity: 0, ground: true, color: null };
const SIGIL = { pos: new THREE.Vector3(), radius: 1.8, style: 'void', intensity: 0, reveal: 0, seed: 0, color: null };
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export default {
  id: 'black-flame', name: 'Black Flame', element: 'hybrid', order: 70, hue: '#7a2dff',
  shape: 'area', radius: 0.4,
  params: { size: 1, height: 1, intensity: 1, absorb: 1, embers: 1, swirl: 1, smoke: 1, corruption: 1, knockback: 1, rim: '#8a3dff', core: '#efdcff' },
  ranges: { size: [0.5, 1.8, 0.01], height: [0.5, 1.8, 0.01], intensity: [0, 3, 0.01], absorb: [0.2, 2, 0.01], embers: [0, 3, 0.01], swirl: [0, 3, 0.01], smoke: [0, 3, 0.01], corruption: [0, 3, 0.01], knockback: [0, 3, 0.01] },
  presets: {
    hellmouth: { rim: '#ff3a1e', core: '#ffd9b8', embers: 1.6, swirl: 1.4 },
    'soul fire': { rim: '#2dffc0', core: '#dafff2', absorb: 0.8, smoke: 0.5 },
    eclipse: { rim: '#ffae3a', core: '#fff3d6', absorb: 1.6, intensity: 1.4, height: 1.25, embers: 0.6 },
  },
  timing: { charge: 1.0, impact: 3.0, linger: 2.2 },
  kinds: {
    // black licks that tear off the column: absorbing, no glow, buoyant, curling, eroding away
    lick: { style: 'media', absorbing: true, lightResponse: 0.1, drag: 2.6, buoyancy: 4.4, curl: 3.0, curlScale: 0.55, forceResponse: 0, life: [0.3, 0.7], size: [0.16, 0.42], sizePow: 0.6, color: ['#030206', '#010102'], alpha: [0.95, 0], density: 9, erosion: 1.7, fadeIn: 0.08, fadeOut: 0.45 },
    // the corona round the licks: violet glowing media, short-lived
    corona: { style: 'media', emissive: 3, drag: 3.2, buoyancy: 3.6, curl: 3.2, curlScale: 0.5, forceResponse: 0, life: [0.2, 0.5], size: [0.14, 0.32], sizePow: 0.7, color: ['#c9a0ff', '#6a20ff'], alpha: [0.7, 0], density: 4, erosion: 1.6, fadeIn: 0.05, fadeOut: 0.5 },
    // violet embers, as bonfire embers: light, buoyant, carried on the curling draught (high drag, so
    // the air not their launch decides where they go), twinkling as they tumble, and cooling the way
    // a blackbody does (bright, then fast to a dull deep violet) instead of fading flat
    ember: { style: 'glow', drag: 1.7, buoyancy: 2.3, gravity: 1.1, curl: 5.5, curlScale: 0.75, restitution: 0.3, friction: 0.4, life: [1.4, 3.2], size: [0.026, 0.01], sizePow: 0.5, stretch: 0.03, emissive: 16, flicker: 0.65, color: ['#b47dff', '#2a0a5c'], alpha: [1, 0.15], fadeIn: 0.1, fadeOut: 0.35, paints: 'corruption', paintAmount: 0.04 },
    // heavy cinders flung by the eruption: violet coals with weight, short motion blur, no white
    cinder: { style: 'glow', drag: 0.6, gravity: 9.8, restitution: 0.35, friction: 0.3, forceResponse: 0.4, life: [0.6, 1.5], size: [0.03, 0.012], stretch: 0.012, emissive: 11, flicker: 0.5, color: ['#9a55ff', '#260850'], alpha: [1, 0.2], paints: 'corruption', paintAmount: 0.06 },
  },

  create(fx) {
    const S = this, P = fx.particles;
    const mass = makeFlameMass(fx, MAX);
    const lickEm = P.emitter('black-flame.lick', { shape: 'shell', radius: 0.45, spread: 0.5, radial: 0.7 });
    const coronaEm = P.emitter('black-flame.corona', { shape: 'shell', radius: 0.5, spread: 0.5, radial: 0.8 });
    const emberEm = P.emitter('black-flame.ember', { shape: 'shell', radius: 0.6, spread: 0.8, radial: 1.1 });
    const cinderEm = P.emitter('black-flame.cinder', { shape: 'sphere', radius: 0.4, spread: 1.6, radial: 3.2 });
    const groundEm = P.emitter('black-flame.lick', { shape: 'disk', radius: 1.1, spread: 0.3 });
    const moteIn = P.emitter('void.mote', { shape: 'shell', radius: 2.6, spread: 0.3, radial: -2.2 });
    const ashEm = P.emitter('void.ash', { shape: 'sphere', radius: 0.6, spread: 0.6 });
    const smokeEm = P.emitter('void.smoke', { shape: 'sphere', radius: 0.6, spread: 0.5 });

    const rim = mass.rim, core = mass.core;
    // per-cast state, allocated here (the cast record only holds a slot)
    const slots = Array.from({ length: MAX }, () => ({ busy: false, base: new THREE.Vector3() }));
    const takeSlot = () => { for (const s of slots) if (!s.busy) { s.busy = true; return s; } return null; };
    // kind colours follow the rim / core params (texels, no recompile)
    const KC = { corona: { color: [new THREE.Color(), new THREE.Color()] }, ember: { color: [new THREE.Color(), new THREE.Color()] }, cinder: { color: [new THREE.Color(), new THREE.Color()] } };
    let lastRim = '', lastCore = '';
    function retint() {
      const p = S.params;
      if (p.rim === lastRim && p.core === lastCore) return;
      lastRim = p.rim; lastCore = p.core;
      rim.set(p.rim); core.set(p.core);
      KC.corona.color[0].copy(core).lerp(rim, 0.5); KC.corona.color[1].copy(rim).multiplyScalar(0.7);
      // embers and cinders burn in the rim's own hue (the core colour only tints the hottest); they
      // cool to a dark ember of it, never to white
      KC.ember.color[0].copy(rim).lerp(core, 0.3); KC.ember.color[1].copy(rim).multiplyScalar(0.18);
      KC.cinder.color[0].copy(rim).lerp(core, 0.1); KC.cinder.color[1].copy(rim).multiplyScalar(0.15);
      for (const k in KC) P.setKind(`black-flame.${k}`, KC[k]);
    }
    retint();

    function splat(x, z, radius, char, corruption, pattern, seed, width = 0) {
      SPLAT.x = x; SPLAT.z = z; SPLAT.radius = radius; SPLAT.char = char; SPLAT.corruption = corruption; SPLAT.glow = 0;
      SPLAT.pattern = pattern; SPLAT.seed = seed % 100; SPLAT.width = width;
      fx.ground.splat(SPLAT);
    }

    // the column's height over the cast's clock: a low smoulder late in the charge, an overshooting
    // eruption, a roar, then it gutters
    function heightAt(c, p) {
      const T = c.age, Tc = c.durations.charge, Hm = 4.4 * p.height * p.size;
      if (T < Tc) return 0.45 * p.size * smooth(0.45, 1.0, T);
      const r = T - Tc;
      return Hm * (1 - Math.exp(-r * 7)) * (1 + 0.18 * Math.exp(-r * 2.5) * Math.sin(r * 8));
    }

    return {
      onParam(k) { if (k === 'rim' || k === 'core') retint(); },

      phase(c, name) {
        const p = S.params, d = c.data;
        retint();
        if (name === 'charge') {
          d.s = takeSlot();
          d.base = d.s ? d.s.base.set(c.to.x, 0, c.to.z) : null;
          if (!d.base) return;
          d.mass = mass.acquire(); d.light = fx.lights.acquire();
          d.vortex = fx.forces.acquire(); d.attr = fx.forces.acquire();
          SIGIL.pos.set(d.base.x, 0.03, d.base.z); SIGIL.radius = 1.9 * p.size; SIGIL.seed = c.seed % 997; SIGIL.color = rim; SIGIL.intensity = 0; SIGIL.reveal = 0;
          d.sigil = fx.sigils.acquire(SIGIL);
          d.hitT = 0.1; d.ring = false; d.flick = 0;
          if (d.light) { d.light.type = 1; d.light.range = 8 * p.size; d.light.intensity = 0; d.light.shadow = true; d.light.color.copy(rim); }
          if (d.vortex) { d.vortex.type = 1; d.vortex.dir.set(0, 1, 0); d.vortex.p[0] = 0.6 * p.size; d.vortex.p[1] = 0; d.vortex.p[2] = 0; d.vortex.p[3] = 0; d.vortex.w = 5; }
          if (d.attr) { d.attr.type = 2; d.attr.p[0] = 0; d.attr.p[1] = 0.5; d.attr.p[2] = 0.35; d.attr.p[3] = 4.5 * p.size; }
        } else if (name === 'release') {
          const b = d.base;
          if (!b) return;
          fx.rig.shake(0.3, 10);
          if (!fx.reduced) fx.rig.punch(1.2, 0.08);
          SHOCK.pos.copy(b); SHOCK.radius1 = 4.5 * p.size; SHOCK.distortion = 0.05; fx.shocks?.spawn(SHOCK);
          cinderEm.pos.set(b.x, 0.4, b.z); cinderEm.vel.set(0, 3.5, 0); cinderEm.burst(90 * p.embers);
          emberEm.pos.set(b.x, 0.5, b.z); emberEm.vel.set(0, 2.6, 0); emberEm.radius = 0.6 * p.size; emberEm.burst(260 * p.embers);
          lickEm.pos.set(b.x, 0.5, b.z); lickEm.vel.set(0, 3.5, 0); lickEm.radius = 0.5 * p.size; lickEm.size = p.size; lickEm.burst(60);
          splat(b.x, b.z, 2.2 * p.size, 0.6, 1.4 * p.corruption, 'radial', c.seed);
          fx.impacts.add('corruption', _a.set(b.x, 0.4, b.z), 2.4 * p.size, 1, 8, rim);
          if (c.target >= 0) {
            const dm = fx.dummies[c.target];
            dm.hit(_a.copy(c.dir).setY(0).normalize(), 0.35 * p.knockback);
          }
        } else if (name === 'done') {
          if (d.mass) mass.release(d.mass);
          d.light?.release(); d.vortex?.release(); d.attr?.release(); d.sigil?.release();
          d.mass = d.light = d.vortex = d.attr = d.sigil = null;
          if (d.s) d.s.busy = false;
          d.s = d.base = null;
          fx.arena.setFocus(_col.set(S.hue), 2.5);
        }
      },

      update(c, dt) {
        const p = S.params, d = c.data, b = d.base;
        if (!b) return;
        const T = c.age, Tc = c.durations.charge, Ti = c.durations.impact, R = 0.8 * p.size;
        const rel = T - Tc, tl = T - Tc - Ti;   // since release; since the burn ended
        const die = smooth(0, 1.5, tl), on = 1 - die;
        const H = heightAt(c, p) * (1 - 0.55 * die);
        d.flick = 0.85 + 0.15 * Math.sin(T * 31 + Math.sin(T * 13) * 2) * Math.sin(T * 7.3);
        if (d.mass) mass.drive(d.mass, b, R, Math.max(H, 0.06), T, (c.seed % 83) * 0.41, 4 * p.intensity * d.flick, 1.3 * p.swirl, die, p.absorb);

        // the orb's light is drawn off while the flame burns, and comes back as it dies
        fx.arena.setFocus(rim, 0.15 + 2.4 * (1 - smooth(0.05, 0.85, T)) + 2.2 * smooth(0.6, 2.0, tl));

        if (d.sigil) {
          d.sigil.reveal = smooth(0, 0.85, T);
          d.sigil.intensity = 1.6 * smooth(0, 0.3, T) * (1 - smooth(0.2, 1.6, tl));
          d.sigil.rotation += dt * 0.35;
        }
        if (d.light) {
          d.light.pos.set(b.x, 0.25, b.z); d.light.end.set(b.x, 0.25 + Math.max(0.2, H * 0.55), b.z);
          d.light.color.copy(rim);
          d.light.intensity = (T < Tc ? 4 * smooth(0.4, 1, T) : 16 * p.intensity * smooth(0, 0.12, rel) * on) * d.flick;
        }
        if (d.vortex) { d.vortex.pos.copy(b); d.vortex.p[1] = 7 * p.swirl * on * smooth(0, 0.3, rel); d.vortex.p[2] = 3.5 * on * smooth(0, 0.3, rel); d.vortex.p[3] = 1.4 * on; d.vortex.w = H + 1; }
        if (d.attr) { d.attr.pos.set(b.x, 0.9, b.z); d.attr.p[0] = 4 * on * smooth(0.3, 1.0, T); }

        if (T < Tc) {
          // anticipation: motes converge, the ground starts to smoulder, corruption creeps in
          const k = smooth(0.15, 1, T / Tc);
          moteIn.pos.set(b.x, 0.5, b.z); moteIn.radius = 2.6 * p.size; moteIn.rate(700 * k, dt);
          groundEm.pos.set(b.x, 0.05, b.z); groundEm.radius = 0.9 * p.size; groundEm.vel.set(0, 0.8, 0); groundEm.size = 0.6 * p.size; groundEm.rate(40 * k, dt);
          if (!d.ring && T > 0.25) { d.ring = true; splat(b.x, b.z, 1.9 * p.size, 0, 0.9 * p.corruption, 'ring', c.seed + 7, 0.3); }
          return;
        }

        // the burn: licks and corona tear off the column at random heights, embers spiral up, ash rises
        const burn = on * smooth(0, 0.1, rel);
        if (burn > 0.01) {
          // licks leave from the upper half, where the tongues tear off
          const y = H * (0.6 + 0.4 * fx.rand()), w = Math.max(0.15, 1 - y / Math.max(H, 0.1));
          lickEm.pos.set(b.x, y, b.z); lickEm.radius = R * (0.3 + 0.4 * w); lickEm.vel.set(0, 2.4, 0); lickEm.size = p.size; lickEm.rate(40 * burn, dt);
          coronaEm.pos.set(b.x, H * (0.75 + 0.3 * fx.rand()), b.z); coronaEm.radius = 0.35 * R; coronaEm.vel.set(0, 2.2, 0); coronaEm.size = 0.7 * p.size; coronaEm.rate(30 * burn * p.intensity, dt);
          emberEm.pos.set(b.x, 0.3 + fx.rand() * H * 0.5, b.z); emberEm.radius = 0.7 * R; emberEm.vel.set(0, 1.4, 0); emberEm.rate(150 * p.embers * burn, dt);
          ashEm.pos.set(b.x, H * 0.75, b.z); ashEm.vel.set(0, 1.6, 0); ashEm.rate(30 * p.smoke * burn, dt);
        }
        if (tl > 0) {
          // aftermath: low black flames on the scar, smoke, the last embers
          const k = 1 - smooth(0.3, 2.0, tl);
          groundEm.pos.set(b.x, 0.05, b.z); groundEm.radius = 1.0 * p.size; groundEm.vel.set(0, 0.9, 0); groundEm.size = 0.7 * p.size; groundEm.rate(55 * k, dt);
          emberEm.pos.set(b.x, 0.2, b.z); emberEm.radius = 0.9 * R; emberEm.vel.set(0, 0.8, 0); emberEm.rate(80 * p.embers * k, dt);
          smokeEm.pos.set(b.x, Math.max(0.6, H * 0.8), b.z); smokeEm.vel.set(0, 1.1, 0); smokeEm.size = 0.35 * p.size; smokeEm.rate(4 * p.smoke * (1 - smooth(0.4, 1.6, tl)), dt);
        }

        // the dummy burns: corrupt, char, short shoves as the flame flares
        d.hitT -= dt;
        if (d.hitT <= 0 && burn > 0.2) {
          d.hitT = 0.3;
          if (c.target >= 0) {
            const dm = fx.dummies[c.target];
            if (Math.hypot(dm.pos.x - b.x, dm.pos.z - b.z) < 1.6 * p.size) {
              dm.status.corrupt = Math.max(dm.status.corrupt, 1);
              dm.status.burn = Math.max(dm.status.burn, 0.3);   // char, little ember heat
              dm.hit(_b.set(fx.rand() - 0.5, 0, fx.rand() - 0.5).normalize(), 0.08 * p.knockback);
            }
          }
          splat(b.x + (fx.rand() - 0.5) * 1.6 * R, b.z + (fx.rand() - 0.5) * 1.6 * R, 0.9 * p.size, 0.35, 0.5 * p.corruption, 'noise', c.seed + T * 37);
        }
      },
    };
  },
};
