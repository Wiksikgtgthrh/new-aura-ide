import * as THREE from 'three';

import {
  ARENA,
  U,
  forces,
  lights,
  impacts,
  occluders,
  packWorld,
} from '../ue/vfx/common.js';
import { Q, TIERS } from '../ue/engine/quality.js';
import { CameraRig } from '../ue/engine/camera.js';
import { bakeNoise } from '../ue/vfx/noise.js';
import { GroundField } from '../ue/vfx/GroundField.js';
import { Particles } from '../ue/vfx/Particles.js';
import { TrailRibbons, AnalyticRibbons } from '../ue/vfx/Ribbons.js';
import { Bolts } from '../ue/vfx/Bolts.js';
import { Volumes } from '../ue/vfx/Volumes.js';
import { Shockwaves } from '../ue/vfx/Shockwaves.js';
import { Spikes } from '../ue/vfx/Spikes.js';
import { Sigils } from '../ue/vfx/Sigils.js';
import { Metaballs } from '../ue/vfx/Metaballs.js';
import { FxTarget } from '../ue/vfx/FxTarget.js';
import { Lens } from '../ue/vfx/Lens.js';
import { Casts } from '../ue/spells/cast.js';
import { SPELLS, ELEMENTS } from '../ue/spells/index.js';

/**
 * Хост заклинаний Ultra-Elements (Humpalumps, MIT).
 *
 * Собирает ровно тот объект `fx`, который ждут заклинания, и гоняет их
 * симуляцию. Арена автора заменена нашим миром: земля — `islandHeight`,
 * цели — наши враги (объекты вида { x, z, pos, status.frozen, hit() }).
 */

export interface SpellTarget {
  x: number;
  z: number;
  pos: THREE.Vector3;
  status: { frozen: number };
  hit: (dir: THREE.Vector3, strength?: number) => void;
}

export interface SpellHostDeps {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  /** Куб неба (для отражений в ледяных шейдерах). */
  skyCube: THREE.Texture;
  /** Направление и цвет солнца. */
  sunDir: THREE.Vector3;
  sunColor: THREE.Vector3;
  /** Центр площадки, где работают декали (иней и лёд на земле). */
  groundCenter: THREE.Vector3;
  /** Размер площадки в метрах. */
  groundSize?: number;
  /** Уровень качества для их профиля: low | medium | high | ultra. */
  tier?: string;
  /** Высота рельефа — тот же islandHeight, что у мира. */
  groundHeight: (x: number, z: number) => number;
}

const GROUND_EXTENT = 260;

export class SpellHost {
  readonly fx: any;
  readonly casts: any;
  /** Сцены эффектов: их надо отрисовать в тот же HDR-буфер, что и воду. */
  readonly refract = new THREE.Scene();
  readonly lines = new THREE.Scene();
  readonly fxScene = new THREE.Scene();
  /** Меши, которым нужна глубина сцены (шипы) — кладём в наш мир. */
  readonly opaque = new THREE.Scene();

  private ground: any;
  private particles: any;
  private spikes: any;
  private sigils: any;
  private trails: any;
  private bolts: any;
  private volumes: any;
  private shocks: any;
  private metaballs: any;
  private fxTarget: any;
  private lens: any;
  private rig: any;
  private probePts = Array.from({ length: 16 }, () => [0, 0]);
  private probeXZ = Array.from({ length: 16 }, () => new THREE.Vector2());
  private probeN = 0;
  private probeReadN = 0;
  private probeOut = new Float32Array(8);
  private probeList: number[][] = [];
  private seed = 1;
  private warmQueue: any[] = [];
  private warming = false;
  private warmAt = 0;
  private simTime = 0;
  targets: SpellTarget[] = [];
  /** Шаги конструктора, отключённые через ?skip= (для бисекции). */
  readonly skipped: string[] = [];

  constructor(private deps: SpellHostDeps) {
    const { renderer, camera, skyCube, sunDir, sunColor, groundCenter } = deps;
    // ── ФЛАГ БИСЕКЦИИ: ?skip=bake,ground,particles,fx,lens ─────────────────
    // Отключает шаги конструктора по одному, чтобы найти, какой из них ломает
    // кадр. Пустой список = всё включено (обычный режим).
    this.skipped = (new URLSearchParams(location.search).get('skip') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const off = (name: string): boolean => this.skipped.includes(name);
    if (deps.tier) {
      // ВАЖНО: Q собран из TIERS на импорте, поэтому одной смены tier мало —
      // надо пересчитать производные поля (размер поля земли, пул частиц, шум),
      // иначе движок аллоцирует ресурсы чужого тира.
      (Q as any).tier = deps.tier;
      Object.assign(Q, (TIERS as any)[deps.tier] ?? {});
    }

    // ── конфигурация арены под наш мир ─────────────────────────────────────
    // Площадка для декалей (иней, лёд, грязь) — вокруг стартовой точки героя.
    ARENA.ground.min.set(groundCenter.x - GROUND_EXTENT / 2, groundCenter.z - GROUND_EXTENT / 2);
    ARENA.ground.size = GROUND_EXTENT;
    U.uGroundRect.value.set(ARENA.ground.min.x, ARENA.ground.min.y, GROUND_EXTENT, 1 / GROUND_EXTENT);
    // Лужи в нашем мире нет: ровняем «воду бассейна» с землёй, чтобы рельеф не дырявился.
    // Бассейн арены (4.5×9 м) у воды — якорь для водных заклинаний. В нашем
    // мире ставим его на мелководье рядом со спавном, чтобы цунами и брызги
    // взаимодействовали с настоящим морем, а не с центром острова.
    ARENA.pool.water = 0;
    {
      const found = this.findShallowNear(groundCenter, 90);
      if (found) {
        ARENA.pool.center.set(found.x, found.z);
        ARENA.pool.half.set(6, 11);
        U.uGroundRect.value.set(ARENA.ground.min.x, ARENA.ground.min.y, GROUND_EXTENT, 1 / GROUND_EXTENT);
      }
    }
    ARENA.focus.copy(groundCenter).setY(groundCenter.y + 1.6);

    (U as any).uSkyCube.value = skyCube;
    U.uSunDir.value.copy(sunDir);
    U.uSunColor.value.copy(sunColor);

    this.rig = new CameraRig();

    if (!off('bake')) bakeNoise(renderer, Q);
    this.ground = off('ground')
      ? { update() {}, setProbes() {}, splat() {}, probes: new Float32Array(8), probeCount: 0 }
      : new GroundField(renderer, Q.groundSize);

    const post = {
      // заглушка: настоящая постобработка у нас от Ultra-Water, а заклинаниям
      // нужен только этот интерфейс (вспышка кадра)
      params: { flash: 0, bloomLevels: Q.bloomLevels, anamorphic: 0, maxExposure: 20 },
      viewCamera: camera,
      setSize: () => {},
      render: () => {},
    };
    const sky = { cube: skyCube, sunDir, sunColor, update: () => {} };
    // Заглушка арены. Заклинания читают конкретные поля: pool.swirl/ripple,
    // arena.focus.color, arena.setFocus(), arena.orb — без них каст падает
    // («Cannot read properties of undefined (reading 'color')»).
    const pool = {
      center: new THREE.Vector2(ARENA.pool.center.x, ARENA.pool.center.y),
      half: new THREE.Vector2(ARENA.pool.half.x, ARENA.pool.half.y),
      swirl: () => {},
      ripple: () => {},
    };
    const arena = {
      group: new THREE.Group(),
      refractGroup: new THREE.Group(),
      dummies: [],
      pool,
      uniforms: {},
      focus: { color: new THREE.Color(0.42, 0.8, 1.0) },
      orb: { visible: false },
      setFocus: () => {},
      update: () => {},
      updateSun: () => {},
    };

    this.particles = off('particles')
      ? { addKind() {}, build() {}, update() {}, glow: null, media: null, debris: [] }
      : new Particles(renderer, { ground: this.ground });
    this.trails = new TrailRibbons({ max: 64, points: 48 });
    this.bolts = new Bolts();
    this.volumes = new Volumes();
    this.shocks = new Shockwaves();
    this.spikes = new Spikes({ max: 48 });
    this.sigils = new Sigils({ max: 8 });
    this.metaballs = new Metaballs({ max: 4 });
    // FxTarget (полуразрешённый MRT с float-глубиной) ломает кадр: с ним
    // измеренная яркость падает с 115 до 36 (84 % кадра в чёрном). Пока не
    // разобрано, создаём его только по явному запросу ?fx=on — для проверки
    // на GPU. Без него композит просто отдаёт сцену как есть, а ледяные
    // заклинания рисуются проходом преломления и видны.
    const wantFx = new URLSearchParams(location.search).get('fx') !== 'off';   // слой эффектов включён по умолчанию (?fx=off — отладка)
    this.fxTarget = !off('fx') && wantFx ? new FxTarget(renderer) : null;
    this.lens = off('lens') ? null : new Lens(renderer);

    const self = this;
    this.fx = {
      renderer,
      camera,
      scenes: { opaque: this.opaque, refract: this.refract, lines: this.lines, fx: this.fxScene },
      U,
      Q,
      ARENA,
      sky,
      arena,
      ground: this.ground,
      particles: this.particles,
      trails: this.trails,
      bolts: this.bolts,
      volumes: this.volumes,
      shocks: this.shocks,
      spikes: this.spikes,
      sigils: this.sigils,
      metaballs: this.metaballs,
      lights,
      forces,
      impacts,
      occluders,
      rig: this.rig,
      post,
      lens: this.lens,
      fxTarget: this.fxTarget,
      AnalyticRibbons,
      dummies: [] as SpellTarget[],
      pool,
      spells: {} as Record<string, unknown>,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      systems: [] as { update(dt: number, camera: THREE.Camera): void }[],
      rand() {
        self.seed = (Math.imul(self.seed, 1664525) + 1013904223) >>> 0;
        return self.seed / 4294967296;
      },
      flash(amount: number) {
        post.params.flash = Math.min(2, Math.max(post.params.flash, amount));
      },
      groundAt: (x: number, z: number) => this.groundAt(x, z),
    };
    this.fx.dummies = this.targets;

    // ── общие меши и регистрация умений (порядок как у автора) ─────────────
    this.lines.add(this.bolts.cores, this.trails.lines, this.sigils.mesh);
    this.opaque.add(this.spikes.opaque);
    this.refract.add(this.spikes.refract, this.metaballs.group);
    this.fxScene.add(this.bolts.glows, this.trails.fx, this.shocks.mesh, this.volumes.group);

    for (const s of SPELLS as any[]) {
      s.defaults = { ...s.params };
      s.params = { ...s.params };
      for (const [k, def] of Object.entries(s.kinds ?? {})) {
        this.particles.addKind(`${s.id}.${k}`, def as never);
      }
      this.fx.spells[s.id] = s;
    }
    // Заклинания создаются ЛЕНИВО: create() компилирует свои программы, и делать
    // это для всех 39 сразу — значит заморозить первые кадры. Материализуем то,
    // которое реально кастуют (ensureInst).
    this.particles.build();    this.particles.build();
    if (this.particles.glow) this.lines.add(this.particles.glow);
    if (this.particles.media) this.fxScene.add(this.particles.media);
    if (this.particles.debris?.length) this.opaque.add(...this.particles.debris);
    this.refract.add(this.lines);

    this.casts = new Casts(this.fx);
    this.fx.casts = this.casts;

    // Фоновый прогрев (приём автора): первый каст каждого заклинания компилирует
    // его программы, и без прогрева это фриз на кадр. Греем по одному в секунду.
    this.warmQueue = [...(SPELLS as any[])];

    // постоянный ветер: нулевой слот сил
    const wind = forces.acquire();
    Object.assign(wind, { type: 0, p: [0, 0.35, 0.25, 0] });
    wind.dir.set(1, 0, 0.3).normalize();
  }

  /** Мелководье рядом с точкой — для «бассейна» водных заклинаний. */
  private findShallowNear(center: THREE.Vector3, reach: number): { x: number; z: number } | null {
    for (let r = 12; r < reach; r += 6) {
      for (let a = 0; a < Math.PI * 2; a += 0.35) {
        const x = center.x + Math.cos(a) * r;
        const z = center.z + Math.sin(a) * r;
        const h = this.deps.groundHeight(x, z);
        if (h > -3 && h < -0.4) return { x, z };
      }
    }
    return null;
  }

  // ── цели: наши враги в виде манекенов автора ────────────────────────────

  setTargets(list: SpellTarget[]): void {
    this.targets = list;
    this.fx.dummies = list;
  }

  // ── кадр ────────────────────────────────────────────────────────────────

  setSun(dir: THREE.Vector3, color: THREE.Vector3, ambient: THREE.Vector3): void {
    U.uSunDir.value.copy(dir);
    U.uSunColor.value.copy(color);
    U.uAmbient.value.copy(ambient);
  }

  setTargets2(w: number, h: number, depth: THREE.Texture, color: THREE.Texture, near: number, far: number): void {
    (U as any).uSceneDepth.value = depth;
    (U as any).uSceneColor.value = color;
    U.uResolution.value.set(w, h);
    U.uNearFar.value.set(near, far);
    this.fxTarget?.setSize(w, h, Q.fxScale);
    this.lens?.setSize?.(w, h);
  }

  /** Прогреть одно заклинание: создать и скомпилировать его программы. */
  private warmNext(): void {
    if (this.warming) return;
    const s = this.warmQueue.shift();
    if (!s) return;
    this.warming = true;
    try {
      this.ensureInst(s);
      const r = this.deps.renderer as unknown as {
        compileAsync?: (o: THREE.Object3D, c: THREE.Camera, sc: THREE.Scene) => Promise<unknown>;
      };
      const jobs: Promise<unknown>[] = [];
      if (r.compileAsync) {
        for (const sc of [this.opaque, this.refract, this.lines, this.fxScene]) {
          jobs.push(r.compileAsync(sc, this.deps.camera, sc).catch(() => undefined));
        }
      }
      Promise.all(jobs).finally(() => {
        this.warming = false;
      });
    } catch {
      this.warming = false;
    }
  }

  /** Поставить стихию в начало очереди прогрева (её кастуют сейчас). */
  prioritize(spells: unknown[]): void {
    const set = new Set(spells);
    this.warmQueue.sort((a, b) => Number(set.has(b)) - Number(set.has(a)));
  }

  /** Симуляция эффектов — до отрисовки. Порядок как в их renderFrame. */
  update(dt: number, camera: THREE.Camera): void {
    this.simTime += dt;
    // прогрев: не чаще одного заклинания в секунду, чтобы не отбирать кадр
    this.warmAt += dt;
    if (this.warmAt > 1 && this.warmQueue.length) {
      this.warmAt = 0;
      this.warmNext();
    }
    U.uTime.value = this.simTime;
    U.uDt.value = dt;
    U.uFrame.value = (U.uFrame.value as number) + 1;

    this.casts.update(dt);
    for (const s of SPELLS as any[]) s.inst?.tick?.(dt);
    this.spikes.update(dt); // пишет капсулы-окклюдеры, поэтому до packWorld
    this.sigils.update();
    packWorld(dt, { maxLights: Q.maxLights, maxShadowed: Q.shadowLights });

    this.particles.update(dt, this.simTime);
    this.updateProbes();
    this.ground.update(dt);
    this.trails.update(dt);
    this.bolts.update();
    this.volumes.update(camera);
    this.shocks.update(dt);
    this.metaballs.update();
    for (const sys of this.fx.systems) sys.update(dt, camera);
  }

  /**
   * Композит эффектов поверх уже отрисованной сцены.
   * Возвращает HDR-текстуру, которую дальше берёт постобработка.
   */
  composite(sceneTex: THREE.Texture): THREE.Texture {
    return this.fxTarget ? this.fxTarget.render(this.fxScene, this.deps.camera, sceneTex, null, null) : sceneTex;
  }

  /**
   * Камера-риг автора: затухание тряски и hitstop + наложение на камеру.
   * Вызывать после того, как контроллер игрока выставил камеру, и до отрисовки —
   * тогда тряска живёт один кадр и не накапливается (следующий кадр её сбросит).
   */
  applyRig(camera: THREE.Camera, dt: number): void {
    this.rig.apply(camera, dt);
  }

  // ── прицеливание по земле (как в их probes) ─────────────────────────────

  private groundAt(x: number, z: number): Float32Array | null {
    let best = -1;
    let bd = 1;
    for (let i = 0; i < Math.min(this.probeReadN, this.ground.probeCount); i++) {
      const d = Math.hypot(this.probeXZ[i].x - x, this.probeXZ[i].y - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return null;
    for (let k = 0; k < 8; k++) this.probeOut[k] = this.ground.probes[best * 8 + k];
    return this.probeOut;
  }

  private updateProbes(): void {
    this.probeReadN = this.probeN;
    for (let i = 0; i < this.probeN; i++) {
      this.probeXZ[i].set(this.probePts[i][0], this.probePts[i][1]);
    }
    this.probeN = 0;
    for (const d of this.targets) {
      if (this.probeN >= 16) break;
      this.probePts[this.probeN][0] = d.x;
      this.probePts[this.probeN][1] = d.z;
      this.probeN++;
    }
    for (const c of this.casts.list) {
      if (!c.alive || this.probeN >= 16) continue;
      this.probePts[this.probeN][0] = c.to.x;
      this.probePts[this.probeN][1] = c.to.z;
      this.probeN++;
    }
    this.probeList.length = 0;
    for (let i = 0; i < this.probeN; i++) this.probeList.push(this.probePts[i]);
    this.ground.setProbes(this.probeList);
  }

  // ── каст ────────────────────────────────────────────────────────────────

  /** Стихии автора в их порядке (с клавишами 1…0, H). */
  get elements(): { id: string; name: string; hue: string; key: string }[] {
    return ELEMENTS as { id: string; name: string; hue: string; key: string }[];
  }

  /** Сколько всего форм у автора. */
  get totalForms(): number {
    return (SPELLS as any[]).reduce((n, s) => n + Math.max(1, s.forms?.length ?? 0), 0);
  }

  /** Список доступных форм умений выбранного элемента. */
  formsOf(element: string): { key: string; name: string; hue: string; spell: any; form: string }[] {
    return (SPELLS as any[])
      .filter((s) => s.element === element)
      .flatMap((s) =>
        (s.forms?.length ? s.forms : [s.name]).map((form: string) => ({
          key: `${s.id}:${form}`,
          name: s.forms?.length ? form : s.name,
          hue: s.hue,
          spell: s,
          form: s.forms?.length ? form : '',
        })),
      );
  }

  cast(spell: any, to: THREE.Vector3, form = '', target = -1, held = true): void {
    this.ensureInst(spell);
    // held: у автора каст каналируется удержанием («hold for channelled
    // spells»). Без этого лучи и щиты обрывались сразу после начала.
    this.casts.cast(spell, to, { form, target, held, from: this.deps.camera.position.clone() });
  }

  /** Самый свежий живой каст — для строки отладки в интерфейсе. */
  activeCast(): { spell: unknown; phase: string; t: number } | null {
    return this.casts.active();
  }

  /** Отпустить удержание: каналируемое заклинание доводится до конца. */
  releaseHeld(): void {
    this.casts.releaseHeld();
  }

  /** Создать заклинание при первом касте и сразу спрятать его холостые меши. */
  private ensureInst(s: any): void {
    if (s.inst) return;
    const before = new Set<unknown>();
    for (const sc of [this.opaque, this.refract, this.lines, this.fxScene]) {
      sc.traverse((o: THREE.Object3D) => before.add(o));
    }
    s.inst = s.create(this.fx);
    for (const sc of [this.opaque, this.refract, this.lines, this.fxScene]) {
      sc.traverse((o: THREE.Object3D) => {
        if (!before.has(o)) (o as THREE.Object3D).visible = false;
      });
    }
  }
}
