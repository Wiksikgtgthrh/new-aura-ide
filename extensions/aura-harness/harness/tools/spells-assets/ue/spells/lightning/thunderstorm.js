import * as THREE from 'three';
import { STORM_VERT, STORM_FRAG, RAIN_VERT, RAIN_FRAG, FILM_VERT, FILM_FRAG, DOME_VERT, DOME_FRAG, SHADE_FRAG, NF } from './thunderstorm.glsl.js';
import { FX_BLENDING } from '../../vfx/common.js';
import { arenaUniforms } from '../../scene/arenaMaterial.js';

// Thunderstorm (wind + lightning + water). Reference: supercell and lightning-storm footage. The
// caster's orb drinks in wind and charge while a dark deck spreads out overhead from the target and
// starts to turn, flickering from inside. Then the first strike and the gust front land together,
// and the rain comes in with it, driven in sheets round the cell. Strikes keep arriving, staggered:
// stepped leader, return stroke, restrikes on the same channel, a mirrored channel in the wet floor,
// Lichtenberg burns, crawl arcs, sparks, steam, thunder arriving late. Spider lightning crawls along
// the base between them. The floor soaks, puddles fill and reflect the flashes, the pool boils with
// rain, dummies are soaked and shocked. Finally the rain thins and the deck erodes away.
//
// Nothing here emits except the bolts: rain and cloud are lit media, lit by the sky and the flashes.
// While the deck is overhead the sun and sky are really dimmed (U.uSunColor/uAmbient, restored in
// tick) and the exposure key drops, so the arena sits in the storm's shadow and flashes stand out.
// ponytail: one sky per arena; overlapping casts share it (the newest sets the centre).

const TAU = Math.PI * 2;
const MAX_STRIKES = 4, MAX_CRAWL = 3, N_ARCS = 3, FADE = 3.2, RCYL = 75;
const STATES = 16, RAIN_MAX = 40000, RAIN_BASE = 13000;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const V3 = () => new THREE.Vector3();
const _a = V3(), _b = V3();
const SPL = { x: 0, z: 0, radius: 1, heat: 0, char: 0, wet: 0, glow: 0, pattern: 'radial', seed: 0, width: 0 };

export default {
  id: 'thunderstorm', name: 'Thunderstorm', element: 'lightning', order: 20, hue: '#8fa6d8',
  shape: 'area',
  params: {
    radius: 9, duration: 8, height: 9.5, strikes: 1, intensity: 1, branches: 7, jag: 0.12, spin: 1, rain: 1, sheets: 1,
    wind: 1, angle: 195, gust: 1, darkness: 1, wetness: 1, core: '#dfe9ff', glow: '#6f80ff', cloud: '#8b8e92',
  },
  ranges: {
    radius: [5, 16, 0.1], duration: [3, 16, 0.1], height: [7.5, 14, 0.1], strikes: [0.2, 2.5, 0.01], intensity: [0.2, 2.5, 0.01], branches: [0, 8, 1],
    jag: [0.04, 0.25, 0.005], spin: [0, 3, 0.01], rain: [0, 2, 0.01], sheets: [0, 2.5, 0.01], wind: [0, 2.5, 0.01], angle: [0, 360, 1],
    gust: [0, 2, 0.01], darkness: [0, 1.5, 0.01], wetness: [0, 2, 0.01],
  },
  presets: {
    supercell: { radius: 13, spin: 1.9, strikes: 0.85, height: 10.5, rain: 0.7, sheets: 1.5, cloud: '#6f7f8c' },
    monsoon: { rain: 1.9, sheets: 1.7, strikes: 0.55, wind: 1.5, wetness: 1.6, cloud: '#8a919c' },
    'dry lightning': { rain: 0.08, sheets: 0.3, strikes: 1.9, wetness: 0.1, gust: 1.5, cloud: '#8a7a6c', glow: '#a07dff', core: '#efe6ff' },
  },
  timing: { charge: 1.6, impact: 0.3, linger: 11 },
  kinds: {
    // the gust front's roller: spray and dust thrown along the floor, lit, never glowing
    // the front's edge: thin, faint, it catches the light; it does not glow
    gust: { style: 'glow', drag: 0.4, curl: 0.6, curlScale: 0.3, forceResponse: 1.2, life: [0.25, 0.5], size: [0.008, 0.003], stretch: 0.03, emissive: 0.3, color: ['#c8d4e0', '#8a98a8'], alpha: [0.5, 0], fadeIn: 0.2, fadeOut: 0.5 },
    scud: { style: 'media', drag: 1.3, buoyancy: 0.03, curl: 0.9, curlScale: 0.25, forceResponse: 1.4, life: [0.8, 1.6], size: [0.5, 2], sizePow: 0.6, color: ['#aab4c0', '#8e98a4'], alpha: [0.13, 0], density: 1.4, erosion: 0.6, fadeIn: 0.12, fadeOut: 0.5, lightResponse: 2 },
  },

  create(fx) {
    const S = this, P = fx.particles, U = fx.U, ARENA = fx.ARENA, post = fx.post;
    const E = {
      gather: P.emitter('wind.streak', { shape: 'shell', radius: 1.7, spread: 0.4, radial: -3.5 }),
      mote: P.emitter('lightning.mote', { shape: 'shell', radius: 2.2, spread: 0.2 }),
      spark: P.emitter('lightning.spark', { shape: 'sphere', radius: 0.15, spread: 6, radial: 3 }),
      smoke: P.emitter('lightning.smoke', { shape: 'disk', radius: 0.8, spread: 0.4 }),
      spray: P.emitter('water.spray', { shape: 'sphere', radius: 0.3, spread: 2.2 }),
      steam: P.emitter('water.mist', { shape: 'disk', radius: 1.2, spread: 0.4 }),
      drop: P.emitter('water.drop', { shape: 'sphere', radius: 0.25, spread: 4, radial: 2.5 }),
      scud: P.emitter('thunderstorm.scud', { shape: 'ring', radius: 2, spread: 0.5 }),
      gust: P.emitter('thunderstorm.gust', { shape: 'ring', radius: 1, spread: 1.2, radial: 8 }),
      leaf: P.emitter('wind.leaf', { shape: 'ring', radius: 2, spread: 1.4, radial: 5 }),
    };

    // --- the sky: every cast feeds it, tick pushes it to the shared uniforms ---
    const uFlash = Array.from({ length: NF }, () => new THREE.Vector4());
    const flashes = Array.from({ length: NF }, () => ({ x: 0, y: 0, z: 0, I: 0, tau: 0.1 }));
    const u = {
      uCell: { value: new THREE.Vector4() }, uDeck: { value: new THREE.Vector4() }, uRain: { value: new THREE.Vector4() },
      uFlash: { value: uFlash }, uFlashCol: { value: new THREE.Color() }, uAmb0: { value: V3() }, uSun0: { value: V3() }, uCloudCol: { value: new THREE.Color() },
    };
    const uShape = { value: new THREE.Vector4(1.6, 3, 1.7, 1.2) };
    const uLook = { value: new THREE.Vector4(0.5, 0.11, 0.13, RCYL) };
    const uFog = { value: new THREE.Vector4() }, uMarch = { value: new THREE.Vector4(12, 5, 26, 1) };

    const storm = new THREE.Mesh(
      new THREE.CylinderGeometry(RCYL, RCYL, 62, 32, 1, false).translate(0, 30, 0),
      new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: STORM_VERT, fragmentShader: STORM_FRAG, ...FX_BLENDING,
        side: THREE.BackSide, depthTest: false, depthWrite: false,
        uniforms: { ...U, ...u, uShape, uLook, uFog, uMarch },
      }),
    );
    storm.frustumCulled = false; storm.visible = false;
    fx.scenes.fx.add(storm);

    // rain: one quad per streak, position.x across, position.y along
    const rainGeo = new THREE.InstancedBufferGeometry();
    rainGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    rainGeo.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(RAIN_MAX * 4);
    { let s = 12345; for (let i = 0; i < seeds.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; seeds[i] = s / 4294967296; } }
    rainGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    rainGeo.instanceCount = 0;
    const uRainShape = { value: new THREE.Vector4(0.042, 0.005, 1.8, 0.65) }, uBurst = { value: new THREE.Vector4() };
    const rain = new THREE.Mesh(rainGeo, new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, ...FX_BLENDING, side: THREE.DoubleSide,
      uniforms: { ...U, ...u, uRainShape, uBurst },
    }));
    rain.frustumCulled = false; rain.visible = false;
    fx.scenes.fx.add(rain);

    // the wet floor: drawn over the floor before the other translucents, destination alpha kept
    const uFilm = { value: new THREE.Vector4(0, 1, 1, 0) };
    const film = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA.radius, 72).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: FILM_VERT, fragmentShader: FILM_FRAG, uniforms: { ...U, ...u, uFilm, uRuneColor: arenaUniforms.uRuneColor },
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      }),
    );
    film.position.y = 0.006; film.renderOrder = -1; film.frustumCulled = false; film.visible = false;
    fx.scenes.refract.add(film);

    // the deck closes over the horizon: only sky pixels pass the depth test
    const uDome = { value: new THREE.Vector4() };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(340, 16, 10),
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, uniforms: { ...u, uDome }, side: THREE.BackSide,
        transparent: true, depthWrite: false,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      }),
    );
    dome.renderOrder = -2; dome.frustumCulled = false; dome.visible = false;
    fx.scenes.refract.add(dome);

    // the pool under the deck: it reflects no bright sky either
    const uShade = { value: new THREE.Color() };
    const poolShade = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA.pool.half.x * 2, ARENA.pool.half.y * 2).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, fragmentShader: SHADE_FRAG, vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', uniforms: { uShade },
        transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      }),
    );
    poolShade.position.set(ARENA.pool.center.x, ARENA.pool.water + 0.012, ARENA.pool.center.y);
    poolShade.renderOrder = 1; poolShade.frustumCulled = false; poolShade.visible = false;
    fx.scenes.refract.add(poolShade);

    const sky = {
      cover: 0, rain: 0, erode: 0, dim: 0, spin: 0, wet: 0, x: 0, z: 0, burst: 0,
      wCover: 0, wRain: 0, wErode: 1, wDim: 0, wx: 0, wz: 0, live: 0,
      baseSun: V3(), baseAmb: V3(), lastSun: V3(), lastAmb: V3(), baseKey: 0.18, lastKey: -1, dimmed: false, time: 0,
    };
    function flashAdd(x, y, z, I, tau) {
      let best = flashes[0];
      for (let i = 1; i < NF; i++) if (flashes[i].I < best.I) best = flashes[i];
      best.x = x; best.y = y; best.z = z; best.I = I * (fx.reduced ? 0.45 : 1); best.tau = tau;
    }

    // look
    const core = new THREE.Color(), glow = new THREE.Color(), glowDim = new THREE.Color();
    function applyLook() {
      const p = S.params;
      core.set(p.core); glow.set(p.glow); glowDim.copy(glow).multiplyScalar(0.08);
      u.uFlashCol.value.copy(glow).lerp(core, 0.86);
      u.uCloudCol.value.set(p.cloud);
    }
    applyLook();

    // --- per-cast state ---
    const newStrike = () => ({
      live: false, hit: false, t: 0, leader: 0.08, left: 0, nextR: 0, bolt: null, light: null, crawl: new Array(MAX_CRAWL).fill(null), nc: 0,
      a: V3(), g: V3(), dist: 0, power: 1,
    });
    const states = Array.from({ length: STATES }, () => ({
      strikes: Array.from({ length: MAX_STRIKES }, newStrike), arcs: new Array(N_ARCS).fill(null),
      spider: null, spiderT: 0, spiderLen: 0.5, g: V3(), glow: null, wind: null, vortex: null, shock: null,
      age: 0, next: 0, count: 0, lastTarget: -1, reseed: 0, icT: 0, icLeft: 0, icx: 0, icz: 0,
      gustR: 0, gustOn: false, gustHit: 0, wetT: 0, buffetT: 0, lastFlash: -1, seedF: 0,
    }));

    const seedInt = () => (fx.rand() * 16777215) | 0;
    const BOLT = { a: V3(), b: V3(), branches: 7, subBranches: 10, jag: 0.12, width: 0.04, color: core, glowColor: glowDim, intensity: 0, glowWidth: 10, reveal: 0, snapToArena: false, seed: 1, branchSeed: 1 };
    function bolt(a, b, branches, sub, jag, width, glowWidth, reveal, snap) {
      BOLT.a.copy(a); BOLT.b.copy(b); BOLT.branches = branches; BOLT.subBranches = sub; BOLT.jag = jag; BOLT.width = width;
      BOLT.glowWidth = glowWidth; BOLT.reveal = reveal; BOLT.snapToArena = snap; BOLT.seed = seedInt(); BOLT.branchSeed = seedInt();
      return fx.bolts.acquire(BOLT);
    }
    function splat(x, z, radius, pattern, seed, wet, heat, char, glowAmt, width) {
      SPL.x = x; SPL.z = z; SPL.radius = radius; SPL.pattern = pattern; SPL.seed = seed % 1000;
      SPL.wet = wet; SPL.heat = heat; SPL.char = char; SPL.glow = glowAmt; SPL.width = width;
      fx.ground.splat(SPL);
    }
    const SHK = { pos: V3(), radius0: 0.3, radius1: 5, duration: 0.4, thickness: 0.5, distortion: 0.05, ground: true, intensity: 0 };
    function shock(x, z, r0, r1, dur, thick, dist) {
      SHK.pos.set(x, 0.04, z); SHK.radius0 = r0; SHK.radius1 = r1; SHK.duration = dur; SHK.thickness = thick; SHK.distortion = dist;
      fx.shocks.spawn(SHK);
    }
    const inPool = (x, z, m = 0) => {
      const P0 = ARENA.pool;
      return Math.abs(x - P0.center.x) < P0.half.x + m && Math.abs(z - P0.center.y) < P0.half.y + m;
    };

    function endStrike(s) {
      s.live = false;
      s.bolt?.release(); s.bolt = null;
      s.light?.release(); s.light = null;
      for (let i = 0; i < s.nc; i++) s.crawl[i]?.release();
      s.crawl.fill(null); s.nc = 0;
    }
    function releaseAll(st) {
      for (let i = 0; i < MAX_STRIKES; i++) endStrike(st.strikes[i]);
      for (let i = 0; i < N_ARCS; i++) { st.arcs[i]?.release(); st.arcs[i] = null; }
      st.spider?.release(); st.spider = null;
      st.glow?.release(); st.glow = null;
      st.wind?.release(); st.wind = null;
      st.vortex?.release(); st.vortex = null;
      st.shock?.release(); st.shock = null;
    }

    // where the next bolt lands: mostly the tallest or nearest thing, as lightning does
    function pickTarget(c, st, p, out) {
      const g = st.g, R = p.radius, roll = fx.rand();
      if (st.count === 0) { out.copy(c.to); out.y = Math.max(out.y, 0.02); return false; }
      if (roll < 0.38) {
        for (let k = 0; k < fx.dummies.length; k++) {
          const i = (st.lastTarget + 1 + k) % fx.dummies.length, dm = fx.dummies[i];
          if (i !== st.lastTarget && Math.hypot(dm.pos.x - g.x, dm.pos.z - g.z) < R + 3) { st.lastTarget = i; out.copy(dm.pos).setY(1.2); return false; }
        }
      } else if (roll < 0.6) {
        for (let k = 0, i0 = (fx.rand() * ARENA.pillars.length) | 0; k < ARENA.pillars.length; k++) {
          const pl = ARENA.pillars[(i0 + k) % ARENA.pillars.length];
          if (Math.hypot(pl.x - g.x, pl.z - g.z) < R + 9) { out.set(pl.x, ARENA.pillarHeight, pl.z); return true; }
        }
      } else if (roll < 0.74) {
        const P0 = ARENA.pool;
        if (Math.hypot(P0.center.x - g.x, P0.center.y - g.z) < R + 7) {
          out.set(P0.center.x + (fx.rand() - 0.5) * P0.half.x * 1.6, 0, P0.center.y + (fx.rand() - 0.5) * P0.half.y * 1.6);
          return false;
        }
      }
      const a = fx.rand() * TAU, r = R * (0.25 + 0.85 * Math.sqrt(fx.rand()));
      out.set(g.x + Math.cos(a) * r, 0.02, g.z + Math.sin(a) * r);
      if (Math.hypot(out.x, out.z) > ARENA.radius - 1) out.multiplyScalar((ARENA.radius - 1) / Math.hypot(out.x, out.z));
      return false;
    }

    function startStrike(c, st, p) {
      let s = null;
      for (let i = 0; i < MAX_STRIKES; i++) if (!st.strikes[i].live) { s = st.strikes[i]; break; }
      if (!s) return;
      pickTarget(c, st, p, s.g);
      s.a.set(s.g.x + (fx.rand() - 0.5) * 5, p.height + 2.5, s.g.z + (fx.rand() - 0.5) * 5);
      s.bolt = bolt(s.a, s.g, p.branches, Math.round(p.branches * 1.5), p.jag, 0.042, 10, 0, false);
      if (!s.bolt) return;
      s.live = true; s.hit = false; s.t = 0; s.leader = 0.06 + 0.05 * fx.rand();
      s.left = 1 + ((fx.rand() * 3) | 0); s.nextR = 0; s.power = (0.75 + 0.5 * fx.rand()) * p.intensity;
      s.dist = s.g.distanceTo(fx.camera.position);
      s.light = fx.lights.acquire();
      if (s.light) { s.light.type = 0; s.light.pos.lerpVectors(s.g, s.a, 0.3); s.light.range = 38; s.light.intensity = 0; s.light.color.copy(core).lerp(glow, 0.25); s.light.shadow = true; for (let i = 0; i < MAX_STRIKES; i++) { const o = st.strikes[i]; if (o !== s && o.live && o.light?.shadow) s.light.shadow = false; } }
      st.count++;
      // the charge in the deck lights up just before it comes down
      flashAdd(s.a.x, p.height + 1, s.a.z, 7 * s.power, 0.1);
    }

    function returnStroke(c, st, p, s) {
      const g = s.g, x = g.x, z = g.z, first = st.count === 1, pw = s.power;
      s.hit = true;
      // at most 3 screen flashes a second, however many strokes land
      if (st.age - st.lastFlash > 0.36) { fx.flash((first ? 0.5 : 0.32) * Math.min(pw, 1.4)); st.lastFlash = st.age; }
      flashAdd(s.a.x, p.height + 0.4, s.a.z, 24 * pw, 0.11);
      flashAdd(x, 3.2, z, 12 * pw, 0.09);
      const y = Math.max(g.y, 0.05);
      E.spark.pos.set(x, y, z); E.spark.vel.set(0, 1, 0); E.spark.burst(first ? 700 : 300);
      if (g.y < 2) {   // pillar hits burn the top, not the floor
        E.smoke.pos.set(x, 0.2, z); E.smoke.burst(70);
        const wet = sky.wet * p.wetness;
        if (wet > 0.05) {
          E.spray.pos.set(x, 0.25, z); E.spray.vel.set(0, 3.2, 0); E.spray.size = 1.1; E.spray.burst(36 * Math.min(1, wet + 0.3));
          E.steam.pos.set(x, 0.15, z); E.steam.vel.set(0, 0.6, 0); E.steam.size = 1.2; E.steam.burst(14);
          E.drop.pos.set(x, 0.1, z); E.drop.vel.set(0, 3.4, 0); E.drop.burst(240 * Math.min(1, wet + 0.3));
        }
        splat(x, z, 2.4, 'lichtenberg', c.seed + st.count * 7, 0, 0.75, 0.8, 0.8, 0);
        fx.impacts.add('electric', _a.set(x, 0.3, z), 2.8, 1, 1.4, core);
        fx.impacts.add('scorch', _a.set(x, 0.1, z), 1.6, 0.6, 8);
        shock(x, z, 0.2, 4.2, 0.36, 0.5, 0.045);
        // crawl arcs run across the wet stone
        const nCrawl = Math.min(MAX_CRAWL, 1 + ((sky.wet * 3) | 0)), len0 = 1.6 + 3.2 * Math.min(1, sky.wet);
        for (let i = 0; i < nCrawl; i++) {
          const an = fx.rand() * TAU, len = len0 * (0.5 + 0.7 * fx.rand());
          _a.set(x, 0.05, z); _b.set(x + Math.cos(an) * len, 0.02, z + Math.sin(an) * len);
          const h = bolt(_a, _b, 2, 2, 0.18, 0.012, 7, 1, true);
          if (h) s.crawl[s.nc++] = h;
        }
      } else fx.impacts.add('electric', _a.copy(g), 2.2, 1, 1.2, core);
      if (inPool(x, z, 1.2)) { fx.pool.flash(glow, 1.8); fx.pool.ripple(Math.min(Math.max(x, ARENA.pool.center.x - ARENA.pool.half.x), ARENA.pool.center.x + ARENA.pool.half.x), z, 0.1, 0.5); }
      // everything standing in the wet is on the circuit
      const reach = 2.6 + 3.4 * Math.min(1, sky.wet);
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i], dist = Math.hypot(dm.pos.x - x, dm.pos.z - z);
        if (dist < reach) {
          dm.status.shock = 1; dm.status.burn = Math.max(dm.status.burn, 0.35 * (1 - dist / reach));
          dm.hit(_b.set(dm.pos.x - x, 0, dm.pos.z - z).normalize(), (dist < 1 ? 0.9 : 0.5) * (1 - 0.6 * dist / reach));
        }
      }
      // light first, thunder a sound-speed later
      fx.rig.shake(0.08 + 0.08 * pw, 22);
      fx.rig.shake(0.12 + 0.1 * pw, 28, Math.min(s.dist / 343, 0.2));
      if (first && !fx.reduced) { fx.rig.punch(1.6, 0.06); fx.rig.hitstop(0.04); }
    }

    function updateStrike(c, st, p, s, dt) {
      s.t += dt;
      const m = s.bolt;
      if (s.t < s.leader) {
        // the stepped leader feels its way down
        m.reveal = s.t / s.leader; m.intensity = 5 * s.power;
      } else {
        m.reveal = 1;
        if (!s.hit) { returnStroke(c, st, p, s); m.intensity = 80 * s.power; s.nextR = 0.035 + 0.04 * fx.rand(); }
        else {
          s.nextR -= dt;
          if (s.left > 0 && s.nextR <= 0) {
            // restrike: same channel, new branches, dimmer each time
            s.left--; s.nextR = 0.05 + 0.07 * fx.rand();
            m.branchSeed = seedInt();
            m.intensity = (34 + 26 * fx.rand()) * s.power;
            flashAdd(s.a.x, p.height + 0.6, s.a.z, 16 * s.power, 0.08);
            E.spark.pos.set(s.g.x, Math.max(s.g.y, 0.05), s.g.z); E.spark.burst(70);
          } else {
            // continuing current: the channel holds a dying glow, then goes out
            m.intensity *= Math.exp(-dt * (s.left > 0 ? 26 : 13));
            if (s.left === 0 && m.intensity < 0.5) { endStrike(s); return; }
          }
        }
      }
      if (s.light) s.light.intensity = m.intensity * 2.4;
      const fade = Math.min(1, m.intensity / 40);
      for (let i = 0; i < s.nc; i++) {
        const h = s.crawl[i];
        h.intensity = fx.rand() < 0.55 ? 30 * s.power * fade : 0;
        if (fx.rand() < 0.2) h.branchSeed = seedInt();
      }
    }

    // spider lightning: a slow discharge crawling along the base of the deck
    function startSpider(st, p) {
      const a0 = fx.rand() * TAU, r0 = 3 + 8 * fx.rand(), a1 = a0 + 1 + 1.8 * fx.rand(), r1 = 6 + 12 * fx.rand(), y = p.height - 0.4;
      _a.set(st.g.x + Math.cos(a0) * r0, y, st.g.z + Math.sin(a0) * r0);
      _b.set(st.g.x + Math.cos(a1) * r1, y + 0.8 * fx.rand(), st.g.z + Math.sin(a1) * r1);
      st.spider = bolt(_a, _b, 8, 10, 0.1, 0.018, 8, 0, false);
      st.spiderT = 0; st.spiderLen = 0.28 + 0.3 * fx.rand();
      flashAdd(_b.x, y + 1, _b.z, 15 * p.intensity, 0.2);
    }
    function updateSpider(st, p, dt) {
      const h = st.spider;
      if (!h) return;
      st.spiderT += dt;
      const k = st.spiderT / st.spiderLen;
      if (k >= 1.5) { h.release(); st.spider = null; return; }
      h.reveal = Math.min(1, k * 1.15);
      h.intensity = 26 * p.intensity * (k < 1 ? 0.6 + 0.4 * fx.rand() : Math.pow(1.5 - k, 2) * 4);
      if (st.glow && k < 1) st.glow.pos.copy(h.b);
    }

    // in-cloud flashes: pulse groups somewhere in the deck, most of them never reach the ground
    function cloudFlicker(st, p, dt, rate, scale) {
      st.icT -= dt;
      if (st.icT > 0) return;
      if (st.icLeft > 0) {
        st.icLeft--;
        flashAdd(st.icx, p.height + 1.4, st.icz, (9 + 16 * fx.rand()) * p.intensity * scale, 0.05 + 0.08 * fx.rand());
        st.icT = 0.03 + 0.09 * fx.rand();
      } else {
        const a = fx.rand() * TAU, r = (p.radius * 1.7) * Math.sqrt(fx.rand());
        st.icx = st.g.x + Math.cos(a) * r; st.icz = st.g.z + Math.sin(a) * r;
        st.icLeft = 2 + ((fx.rand() * 3) | 0);
        st.icT = (0.35 + 1.0 * fx.rand()) / Math.max(rate, 0.05);
      }
    }

    function worldRain(c, st, p, dt, T, rain) {
      const g = st.g;
      // soaking: patches first, then everything; the pool fills the rest of the frame with rings
      st.wetT -= dt;
      if (st.wetT <= 0 && p.wetness > 0 && rain > 0.1) {
        st.wetT = 0.22;
        const a = fx.rand() * TAU, r = 16 * Math.sqrt(fx.rand());
        splat(Math.cos(a) * r, Math.sin(a) * r, 4 + 3 * fx.rand(), 'noise', (c.seed + (T * 40) | 0), 0.3 * p.wetness * rain, 0, 0, 0, 0);
        splat(g.x * 0.5, g.z * 0.5, 22, 'radial', c.seed + 1, 0.075 * p.wetness * rain, 0, 0, 0, 0);
      }
      if (fx.pool && rain > 0.05) {
        const P0 = ARENA.pool;
        for (let i = 0; i < 3; i++) fx.pool.ripple(P0.center.x + (fx.rand() - 0.5) * 2 * P0.half.x, P0.center.y + (fx.rand() - 0.5) * 2 * P0.half.y, 0.007 * rain * p.rain, 0.07 + 0.05 * fx.rand());
        const qx = Math.max(Math.abs(g.x - P0.center.x) - P0.half.x, 0), qz = Math.max(Math.abs(g.z - P0.center.y) - P0.half.y, 0), pd = Math.hypot(qx, qz);
        if (pd < p.radius + 2) fx.pool.swirl(Math.min(Math.max(g.x, P0.center.x - P0.half.x), P0.center.x + P0.half.x), Math.min(Math.max(g.z, P0.center.y - P0.half.y), P0.center.y + P0.half.y), 1.6 * rain * (1 - pd / (p.radius + 2)));
      }
      // soaked and buffeted
      st.buffetT -= dt;
      const hit = st.buffetT <= 0;
      if (hit) st.buffetT = 0.36;
      for (let i = 0; i < fx.dummies.length; i++) {
        const dm = fx.dummies[i];
        dm.status.wet = Math.max(dm.status.wet, Math.min(1, T * 0.33 * p.rain * p.wetness) * rain);
        if (hit && p.wind > 0) {
          const dx = dm.pos.x - g.x, dz = dm.pos.z - g.z, d = Math.hypot(dx, dz);
          if (d < p.radius + 4) dm.hit(_b.set(dz * 0.12 + Math.cos(p.angle * Math.PI / 180), 0, -dx * 0.12 + Math.sin(p.angle * Math.PI / 180)).normalize(), 0.11 * p.wind * rain);
        }
      }
    }

    function updateGust(c, st, p, dt) {
      if (!st.gustOn) return;
      const g = st.g, v = 17 * Math.pow(Math.max(0.25, 1 - st.gustR / 28), 0.7), die = 1 - smooth(14, 22, st.gustR);
      st.gustR += v * dt;
      if (st.shock) { st.shock.pos.set(g.x, 0.5, g.z); st.shock.p[0] = st.gustR; st.shock.p[1] = 1.8; st.shock.p[2] = 26 * p.gust; }
      // the roller along the front
      E.scud.pos.set(g.x, 0.25, g.z); E.scud.radius = st.gustR; E.scud.radial = v * 0.6; E.scud.vel.set(0, 0.5, 0); E.scud.size = 1; E.scud.rate(190 * p.gust * die, dt);
      E.gust.pos.set(g.x, 0.5, g.z); E.gust.radius = st.gustR; E.gust.radial = v; E.gust.vel.set(0, 0.2, 0); E.gust.rate(320 * p.gust * die, dt);
      for (let i = 0; i < fx.dummies.length && i < 30; i++) {
        const dm = fx.dummies[i], bit = 1 << i;
        if (st.gustHit & bit) continue;
        const dx = dm.pos.x - g.x, dz = dm.pos.z - g.z, d = Math.hypot(dx, dz);
        if (d < st.gustR) { st.gustHit |= bit; dm.hit(_b.set(dx, 0.1, dz).normalize(), 0.65 * p.gust); }
      }
      // the front crossing the pool
      if (fx.pool) {
        for (let i = 0; i < 2; i++) {
          const a = fx.rand() * TAU, x = g.x + Math.cos(a) * st.gustR, z = g.z + Math.sin(a) * st.gustR;
          if (inPool(x, z)) fx.pool.ripple(x, z, 0.03 * p.gust, 0.35);
        }
      }
      if (st.gustR > 22) { st.gustOn = false; st.shock?.release(); st.shock = null; }
    }

    return {
      onParam() { applyLook(); },

      tick(dt) {
        // the sky follows what the casts asked for this frame, and falls away with none alive
        const k = 1 - Math.exp(-dt * 5);
        sky.cover += (sky.wCover - sky.cover) * k;
        sky.rain += (sky.wRain - sky.rain) * k;
        sky.erode += (sky.wErode - sky.erode) * k;
        sky.dim += (sky.wDim - sky.dim) * k;
        sky.burst *= Math.exp(-dt * 0.9);
        sky.wCover = 0; sky.wRain = 0; sky.wDim = 0;
        const alive = sky.cover > 0.002 || sky.live > 0;
        if (sky.live > 0) { if (sky.cover < 0.02) { sky.x = sky.wx; sky.z = sky.wz; } else { sky.x += (sky.wx - sky.x) * k; sky.z += (sky.wz - sky.z) * k; } }
        sky.live = 0; sky.wErode = 1;
        sky.wet = Math.min(1, sky.wet + dt * 0.3 * (sky.rain > 0.1 ? sky.rain : 0));
        if (!alive) sky.wet = Math.max(0, sky.wet - dt * 0.2);
        storm.visible = rain.visible = film.visible = dome.visible = poolShade.visible = alive;
        for (let i = 0; i < NF; i++) { const fl = flashes[i]; fl.I *= Math.exp(-dt / fl.tau); if (fl.I < 0.01) fl.I = 0; }
        // the storm's shadow on the arena: dim from wherever the sun currently is, restore exactly
        const sun = U.uSunColor.value, amb = U.uAmbient.value, pp = post.params;
        if (!alive && sky.dim < 0.003) {
          if (sky.dimmed) { sun.copy(sky.baseSun); amb.copy(sky.baseAmb); pp.keyValue = sky.baseKey; sky.dimmed = false; sky.dim = 0; }
          return;
        }
        if (!sky.dimmed || !sun.equals(sky.lastSun) || !amb.equals(sky.lastAmb) || pp.keyValue !== sky.lastKey) {
          sky.baseSun.copy(sun); sky.baseAmb.copy(amb); sky.baseKey = pp.keyValue; sky.dimmed = true;
        }
        const dm = Math.min(1, sky.dim);
        // no direct sun under the deck, and what sky gets through is cold and grey
        const lum = 0.3 * sky.baseAmb.x + 0.6 * sky.baseAmb.y + 0.1 * sky.baseAmb.z;
        sun.copy(sky.baseSun).multiplyScalar(1 - 0.985 * dm);
        amb.set(lum * 0.86, lum * 0.95, lum * 1.12).lerp(sky.baseAmb, 1 - dm).multiplyScalar(1 - 0.62 * dm);
        pp.keyValue = sky.baseKey * (1 - 0.74 * dm);
        sky.lastSun.copy(sun); sky.lastAmb.copy(amb); sky.lastKey = pp.keyValue;
        if (!alive) return;

        const p = S.params;
        sky.time += dt;
        sky.spin += dt * 0.075 * p.spin * Math.min(1, sky.cover * 1.5);
        const H = p.height, fall = 12.5, drift = 7 * p.wind * H / fall * (1 + 0.4 * Math.sin(sky.time * 0.9) * Math.sin(sky.time * 0.37 + 1));
        const an = p.angle * Math.PI / 180;
        u.uCell.value.set(sky.x, sky.z, p.radius, sky.spin);
        u.uDeck.value.set(H, H + 8.5, 3 + (RCYL - 12) * Math.pow(sky.cover, 1.6), sky.erode);
        u.uRain.value.set(sky.rain, Math.cos(an) * drift, Math.sin(an) * drift, fall);
        u.uAmb0.value.set(lum * 0.92, lum * 0.97, lum * 1.05); u.uSun0.value.copy(sky.baseSun);
        // brightest flash first: it casts the deck's relief
        let top = 0;
        for (let i = 1; i < NF; i++) if (flashes[i].I > flashes[top].I) top = i;
        for (let i = 0; i < NF; i++) { const fl = flashes[i === 0 ? top : i === top ? 0 : i]; uFlash[i].set(fl.x, fl.y, fl.z, fl.I); }
        storm.position.set(sky.x, 0, sky.z);
        dome.position.copy(fx.camera.position);
        uDome.value.set(maxFlash() * 0.012, smooth(0.15, 0.85, sky.cover) * (1 - smooth(0.15, 0.8, sky.erode)), 0, 0);
        { const a = Math.min(1, sky.cover * 1.2) * (1 - sky.erode * sky.erode); uShade.value.setRGB(1 - 0.86 * a, 1 - 0.76 * a, 1 - 0.52 * a); }   // the dusk it mirrored goes neutral and dark
        const Q = fx.Q, camFade = 1 - 0.88 * smooth(H + 6, H + 18, fx.camera.position.y);   // from above it's a thin veil, or nothing shows
        uMarch.value.set(Math.min(16, Math.max(6, Math.round(Q.volumeSteps * Q.auto.steps * 0.35))), Q.volumeSteps >= 24 ? 4 : 3, 26, camFade);
        uFog.value.set(0.042 * p.sheets, 0.001, 0.035 * Math.max(sky.rain, 0.85 * smooth(0.5, 1, sky.cover) * (1 - sky.erode)) * Math.min(1.3, 0.25 + 0.75 * p.rain + 0.3 * p.sheets), 0.012).multiplyScalar(camFade);
        uBurst.value.set(0.45 * p.spin, 0.02 + 0.14 * sky.burst * p.gust, Math.max(0.06, 0.55 - 0.4 * p.sheets), 0);
        uFilm.value.set(smooth(0.35, 1, sky.cover) * (1 - sky.erode * sky.erode), 0.55 * p.rain, 1, 0);
        rainGeo.instanceCount = sky.rain > 0.01 ? Math.min(RAIN_MAX, Math.round(RAIN_BASE * p.rain * Q.emission * Q.auto.emission)) : 0;
        rain.visible = rainGeo.instanceCount > 0;
      },

      phase(c, name) {
        const p = S.params, st = states[c.index];
        if (name === 'charge') {
          applyLook();
          releaseAll(st);
          c.durations.linger = p.duration + FADE;
          st.g.set(c.to.x, 0, c.to.z);
          st.age = 0; st.next = 0; st.count = 0; st.lastTarget = c.target; st.reseed = 0;
          st.icT = 0.3; st.icLeft = 0; st.gustR = 0; st.gustOn = false; st.gustHit = 0; st.wetT = 0; st.buffetT = 0; st.lastFlash = -1;
          st.seedF = (c.seed % 997) / 997;
          uLook.value.z = 0.13 + st.seedF * 0.5;
          for (let i = 0; i < N_ARCS; i++) st.arcs[i] = bolt(c.from, c.from, 0, 0, 0.25, 0.012, 8, 1, false);
          st.glow = fx.lights.acquire();
          if (st.glow) { st.glow.range = 34; st.glow.intensity = 0; st.glow.color.copy(u.uFlashCol.value); st.glow.pos.set(st.g.x, p.height - 1, st.g.z); }
          st.vortex = fx.forces.acquire();
          if (st.vortex) { st.vortex.type = 1; st.vortex.pos.copy(st.g); st.vortex.dir.set(0, 1, 0); st.vortex.p[1] = 0; st.vortex.w = 6; }
          st.wind = fx.forces.acquire();
          if (st.wind) { st.wind.type = 0; const an = p.angle * Math.PI / 180; st.wind.dir.set(Math.cos(an), 0, Math.sin(an)); st.wind.p[0] = 0; st.wind.p[1] = 0.9; st.wind.p[2] = 0.5; }
        } else if (name === 'release') {
          fx.rig.shake(0.12, 9);
        } else if (name === 'impact') {
          for (let i = 0; i < N_ARCS; i++) { st.arcs[i]?.release(); st.arcs[i] = null; }
          st.age = 0;
          // the gust front and the first strike land together
          const g = st.g;
          st.gustOn = p.gust > 0; st.gustR = 1;
          if (st.gustOn) {
            sky.burst = 1;
            st.shock = fx.forces.acquire();
            if (st.shock) st.shock.type = 4;
            shock(g.x, g.z, 0.5, 15 * Math.max(p.gust, 0.4), 1, 1, 0.05 * p.gust);
            E.leaf.pos.set(g.x, 0.25, g.z); E.leaf.radius = 2; E.leaf.vel.set(0, 2, 0); E.leaf.burst(26 * p.gust);
            fx.rig.shake(0.22 * p.gust, 7);
          }
          startStrike(c, st, p);
          st.next = 0.5 + 0.35 * fx.rand();
        } else if (name === 'done') releaseAll(st);
      },

      update(c, dt) {
        const p = S.params, st = states[c.index];
        st.age += dt;
        let cover, rainK, erode;
        if (c.phase === 'charge') {
          const k = Math.min(1, c.t / c.durations.charge), f = c.from;
          cover = smooth(0, 1, k); erode = 0; rainK = 0.1 * smooth(0.7, 1, k);
          // the orb drinks in wind and charge
          E.gather.pos.copy(f); E.gather.rate(420 * (0.3 + 0.7 * k), dt);
          E.mote.pos.copy(f); E.mote.vel.set(0, 0, 0); E.mote.rate(1500 * k, dt);
          st.reseed -= dt;
          for (let i = 0; i < N_ARCS; i++) {
            const h = st.arcs[i];
            if (!h) continue;
            if (st.reseed <= 0) {
              h.a.copy(f).add(_a.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).normalize().multiplyScalar(0.28));
              h.b.copy(f).add(_a.set(fx.rand() - 0.5, fx.rand() - 0.5, fx.rand() - 0.5).normalize().multiplyScalar(0.28 + 0.5 * k * fx.rand()));
              h.seed = seedInt();
            }
            h.intensity = 24 * p.intensity * (0.4 + 0.6 * k) * (fx.rand() < 0.75 ? 1 : 0);
          }
          if (st.reseed <= 0) st.reseed = 0.05;
          // the air starts to circle under the gathering deck, and it starts to flicker
          if (st.vortex) { st.vortex.p[0] = 0.4 * p.radius; st.vortex.p[1] = 16 * p.radius * p.spin * k; st.vortex.p[2] = 0.5 * k; st.vortex.p[3] = 1.2 * k; }
          if (k > 0.35) cloudFlicker(st, p, dt, 1.6, 0.45 + 0.55 * k);
          if (st.glow) { st.glow.intensity = maxFlash() * 3.2; }
        } else {
          const total = c.durations.impact + c.durations.linger, T = c.phase === 'linger' ? c.durations.impact + c.t : c.t;
          const out = smooth(total - FADE, total - 0.1, T);
          cover = 1; erode = out; rainK = smooth(0, 0.9, T) * (1 - smooth(total - FADE, total - FADE + 1.8, T));
          // a turning wind, gusting, gone when the rain goes
          if (st.vortex) { st.vortex.p[0] = 0.4 * p.radius; st.vortex.p[1] = 30 * p.radius * p.spin * (1 - out); st.vortex.p[2] = 0.6 * (1 - out); st.vortex.p[3] = 2 * (1 - out); }
          if (st.wind) { st.wind.p[0] = 8 * p.wind * (1 - out); st.wind.p[2] = 0.5 * (1 - out); }
          updateGust(c, st, p, dt);
          // staggered strikes: the storm builds to its middle and wears out
          if (T < total - FADE - 0.3 && p.strikes > 0) {
            st.next -= dt;
            if (st.next <= 0) {
              const build = 0.65 + 0.6 * Math.sin(Math.min(1, T / Math.max(total - FADE, 1)) * Math.PI);
              startStrike(c, st, p);
              if (fx.rand() < 0.22) startStrike(c, st, p);   // sometimes two at once
              st.next = Math.max(0.38, (0.5 + 1 * fx.rand()) / (p.strikes * build));
            }
            if (!st.spider && fx.rand() < dt * 0.7 * p.strikes) startSpider(st, p);
          }
          updateSpider(st, p, dt);
          for (let i = 0; i < MAX_STRIKES; i++) if (st.strikes[i].live) updateStrike(c, st, p, st.strikes[i], dt);
          cloudFlicker(st, p, dt, 1.6 * p.strikes * (1 - 0.7 * out), 1 - 0.6 * out);
          worldRain(c, st, p, dt, T, rainK * p.rain);
          if (st.glow) { st.glow.intensity = maxFlash() * 2.6; if (!st.spider) { const fl = brightest(); st.glow.pos.set(fl.x, Math.min(fl.y, p.height - 1), fl.z); } }
        }
        // what this cast asks of the sky
        sky.wCover = Math.max(sky.wCover, cover);
        sky.wRain = Math.max(sky.wRain, rainK * Math.min(p.rain, 1.2));
        sky.wErode = Math.min(sky.wErode, erode);
        sky.wDim = Math.max(sky.wDim, cover * (1 - erode) * Math.min(p.darkness, 1.2));
        sky.wx = st.g.x; sky.wz = st.g.z; sky.live++;
      },
    };

    function brightest() {
      let top = flashes[0];
      for (let i = 1; i < NF; i++) if (flashes[i].I > top.I) top = flashes[i];
      return top;
    }
    function maxFlash() { return brightest().I; }
  },
};
