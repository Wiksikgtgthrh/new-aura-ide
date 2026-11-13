import * as THREE from 'three';

import { OceanSim, defaultOceanParams } from '../uw/water/OceanSim.js';
import { OceanSurface } from '../uw/water/OceanSurface.js';
import { bakeShoreMap } from '../uw/water/shoreMap.js';
import { bakeWaterTextures } from '../uw/water/bakeTextures.js';
import { WaveCaustics } from '../uw/water/Caustics.js';
import { UnderwaterPass } from '../uw/water/UnderwaterPass.js';
import { Spray } from '../uw/water/Spray.js';
import { MarineSnow } from '../uw/water/MarineSnow.js';
import { WaterQuery } from '../uw/water/WaterQuery.js';
import { SkySystem } from '../uw/scene/sky.js';
import { createTerrain } from '../uw/scene/terrain.js';
import { islandHeight } from '../uw/scene/islandHeight.js';
import { Floaters } from '../uw/scene/floaters.js';
import { FloaterShadow } from '../uw/scene/floaterShadow.js';
import { PlanarReflection } from '../uw/engine/PlanarReflection.js';
import { PostFX } from '../uw/engine/PostFX.js';
import { GpuTimer } from '../uw/engine/gpuTimer.js';
import { FullscreenQuad, rawPass } from '../uw/engine/fullscreen.js';

/**
 * Мир на движке Ultra-Water (Humpalumps, MIT): атмосферное небо, FFT-океан
 * с каустиками и прибоем, подводный проход, постобработка. Здесь только
 * сборка конвейера и один кадр — геймплей живёт слоем выше.
 */

const REFLECT_LAYER = 1;
const RESTORE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`;

export type QualityProfile = 'high' | 'medium' | 'low' | 'min';

export interface WorldQuality {
  resolution: number;
  msaa: number;
  reflections: boolean;
  reflectionScale: number;
  bloom: boolean;
}

function profileFor(name: QualityProfile): WorldQuality {
  if (name === 'min') return { resolution: 0.4, msaa: 0, reflections: false, reflectionScale: 0.25, bloom: false };
  if (name === 'low') return { resolution: 0.7, msaa: 2, reflections: false, reflectionScale: 0.35, bloom: false };
  if (name === 'medium') return { resolution: 1, msaa: 2, reflections: true, reflectionScale: 0.4, bloom: true };
  return { resolution: 1, msaa: 4, reflections: true, reflectionScale: 0.5, bloom: true };
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene = new THREE.Scene();
  readonly quality: WorldQuality;

  private sky: any;
  private shore: any;
  private ocean: any;
  private caustics: any;
  private floatShadow: any;
  private surface: any;
  private terrain: any;
  private sunLight: THREE.DirectionalLight;
  private query: any;
  private floaters: any;
  private underwater: any;
  private reflection: any;
  private spray: any;
  private snow: any;
  private post: any;
  private timer: any;
  private waterScene = new THREE.Scene();
  private hdrRT: THREE.WebGLRenderTarget | null = null;
  private emptyReflection: THREE.DataTexture;
  private reflectionRoots: THREE.Object3D[] = [];

  /** Высота воды под камерой (читается из GPU с задержкой 1–3 кадра). */
  camWater = 0;
  /** Камера под водой — для кислорода и интерфейса. */
  submerged = false;
  /** Сколько секунд камера под водой подряд (для эффектов). */
  underwaterTime = 0;

  private elapsed = 0;
  private uwComp = 1;
  private wasSubmerged = false;
  private sunDirty = true;
  private exposure = 1;
  private eas = { elevation: 14, azimuth: 208 };

  constructor(canvas: HTMLCanvasElement, quality: QualityProfile = 'high') {
    this.quality = profileFor(quality);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      depth: false,
      stencil: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.4, 80000);

    // --- мир -------------------------------------------------------------------
    this.sky = new SkySystem(this.renderer);
    this.sky.params.elevation = this.eas.elevation;
    this.sky.params.azimuth = this.eas.azimuth;

    this.shore = bakeShoreMap(islandHeight, 1800, 512);
    const tex = bakeWaterTextures(this.renderer);
    this.ocean = new OceanSim(this.renderer, defaultOceanParams());
    this.caustics = new WaveCaustics(this.renderer, this.ocean);
    this.floatShadow = new FloaterShadow();
    this.surface = new OceanSurface(this.ocean, this.shore, this.sky, this.floatShadow.uniforms);
    this.surface.uniforms.uFoamTex.value = tex.foam;

    this.scene.environment = this.sky.cube;
    this.scene.add(this.sky.background);

    this.terrain = createTerrain({
      sky: this.sky,
      caustics: this.caustics.uniforms,
      floatShadow: this.floatShadow.uniforms,
      water: this.surface.uniforms,
      absorption: this.surface.uniforms.uAbsorption.value,
      reflectionLayer: REFLECT_LAYER,
    });
    this.scene.add(this.terrain.group);

    this.sunLight = new THREE.DirectionalLight(0xffffff, Math.PI);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sunLight.shadow.camera, {
      left: -700,
      right: 700,
      top: 700,
      bottom: -700,
      near: 10,
      far: 4000,
    });
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.6;
    this.scene.add(this.sunLight, this.sunLight.target);

    this.surface.uniforms.uShadowMatrix.value = this.terrain.uniforms.uSunShadowMatrix.value =
      this.sunLight.shadow.matrix;
    this.surface.uniforms.uShadowBias.value = 0.05 / (this.sunLight.shadow.camera.far - this.sunLight.shadow.camera.near);

    this.query = new WaterQuery(this.renderer, this.surface, 512);
    this.floaters = new Floaters({
      scene: this.scene,
      heightAt: islandHeight,
      patchMaterial: this.terrain.patchProp,
    });
    this.enableReflection(this.floaters.scene);

    this.underwater = new UnderwaterPass(this.surface, this.camera, this.caustics.uniforms);

    this.reflection = new PlanarReflection(REFLECT_LAYER);
    this.surface.uniforms.uReflMatrix.value = this.reflection.textureMatrix;
    this.emptyReflection = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    this.emptyReflection.needsUpdate = true;

    const restore = new FullscreenQuad(
      rawPass(RESTORE_FRAG, { uTex: { value: null } }),
    );
    restore.mesh.renderOrder = -1;
    if (/OculusBrowser/.test(navigator.userAgent)) this.waterScene.add(restore.mesh);

    this.spray = new Spray(this.surface, this.shore);
    this.snow = new MarineSnow(this.surface);
    this.waterScene.add(this.surface.mesh, this.spray.mesh, this.spray.splash, this.snow.mesh);

    this.post = new PostFX(this.renderer);
    this.post.params.bloomStrength = this.quality.bloom ? 0.05 : 0;
    this.post.params.bloomThreshold = 1.5;

    this.timer = new GpuTimer(this.renderer.getContext());
    this.setSun(this.eas.elevation, this.eas.azimuth);
    this.resize();
  }

  // --- внешние запросы ---------------------------------------------------------

  /** Высота рельефа (суша и дно). */
  heightAt(x: number, z: number): number {
    return islandHeight(x, z);
  }

  /** Точка на пляже — для спавна героя и врагов. */
  findSpawn(): THREE.Vector3 {
    for (let a = 0; a < Math.PI * 2; a += 0.13) {
      let r = 120;
      while (r < 900 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > 1.6) r += 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = islandHeight(x, z);
      if (h > 0.4 && h < 2.6) return new THREE.Vector3(x, h + 1.2, z);
    }
    return new THREE.Vector3(0, 3, 340);
  }

  /** Добавить объект геймплея в отражаемую сцену. */
  add(obj: THREE.Object3D): void {
    this.scene.add(obj);
    this.reflectionRoots.push(obj);
    this.enableReflection(obj);
  }

  /** Зарегистрировать объект, который должен отражаться в воде. */
  register(obj: THREE.Object3D): void {
    this.reflectionRoots.push(obj);
    this.enableReflection(obj);
  }

  /** Все потомки попадают в отражение воды (слой 1). */
  enableReflection(root: THREE.Object3D): void {
    root.traverse((o) => o.layers.enable(REFLECT_LAYER));
  }

  setExposure(v: number): void {
    this.exposure = v;
  }

  setSun(elevation: number, azimuth: number): void {
    this.eas.elevation = elevation;
    this.eas.azimuth = azimuth;
    this.sky.params.elevation = elevation;
    this.sky.params.azimuth = azimuth;
    this.sunDirty = true;
  }

  get sunDirection(): THREE.Vector3 {
    return this.sky.sunDir;
  }

  spawnFloater(position: THREE.Vector3, direction: THREE.Vector3): void {
    this.floaters.spawn(position, direction);
  }

  // --- кадр --------------------------------------------------------------------

  private applySun(): void {
    this.sky.update();
    this.sunLight.position.copy(this.sky.sunDir).multiplyScalar(2000);
    this.sunLight.color
      .setRGB(this.sky.sunColor.x, this.sky.sunColor.y, this.sky.sunColor.z)
      .multiplyScalar(1 / Math.max(this.sky.sunColor.x, 1e-4));
    this.sunLight.intensity = Math.PI * Math.max(this.sky.sunColor.x, 1e-4);
    this.renderer.shadowMap.needsUpdate = true;
    this.sunDirty = false;
  }

  private makeTargets(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.hdrRT?.dispose();
    this.hdrRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: this.quality.msaa,
      generateMipmaps: false,
      depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType),
    });
    const su = this.surface.uniforms;
    su.uSceneColor.value = this.hdrRT.texture;
    su.uSceneDepth.value = this.hdrRT.depthTexture;
    su.uResolution.value.copy(size);
    this.reflection.scale = this.quality.reflectionScale;
    this.reflection.setSize(size.x, size.y);
    this.post.setSize(size.x, size.y);
    this.underwater.setSize(size.x, size.y);
  }

  resize(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.quality.resolution);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.makeTargets();
  }

  /** Один кадр: вода, отражение, непрозрачное, подводный проход, пост. */
  render(dt: number): void {
    const gl = this.renderer;
    this.elapsed += dt;
    if (this.sunDirty) this.applySun();
    this.timer.beginFrame();

    for (const root of this.reflectionRoots) this.enableReflection(root);

    if (this.query.resultCount > 0) this.camWater = this.query.result[0];
    this.floaters.ingest(this.query, 1);
    this.floaters.step(dt);
    this.floatShadow.update(gl, this.floaters.scene, this.floaters.bodies, this.sky.sunDir);

    const su = this.surface.uniforms;
    for (let i = 0; i < 8; i++) {
      const e = this.floaters.impacts[i];
      const age = e ? this.floaters.time - e.t : 1e9;
      su.uImpact.value[i].set(e?.x ?? 0, e?.z ?? 0, age, age < 30 ? e.amp : 0);
      su.uImpactSize.value[i] = e?.size ?? 1;
    }

    this.ocean.update(dt, this.timer);
    if (this.quality.msaa > 0 || this.quality.resolution > 0.5) this.caustics.update(this.sky.sunDir);
    this.surface.update(this.camera, this.elapsed % 3600);
    this.spray.update();

    const pts = this.floaters.collectPoints([this.camera.position]);
    this.query.submit(pts, this.floaters.count, this.floaters.layout, this.elapsed);

    const camY = this.camera.position.y;
    const submerged = camY < this.camWater - 0.3;
    const nearSurface = camY < this.camWater + 1.2;
    this.submerged = submerged;
    this.underwaterTime = submerged ? this.underwaterTime + dt : 0;
    su.uCamSide.value = camY > this.camWater + 0.5 ? -1 : camY < this.camWater - 0.5 ? 1 : 0;

    this.snow.update(this.camera, this.hdrRT ? this.hdrRT.height : window.innerHeight, nearSurface);
    this.uwComp += ((submerged ? 0.55 : 1) - this.uwComp) * Math.min(1, dt * 3);
    this.post.params.exposure = this.exposure * this.uwComp;
    this.post.params.droplets =
      this.wasSubmerged && !submerged ? 1 : submerged ? 0 : Math.max(0, this.post.params.droplets - dt / 5);
    this.wasSubmerged = submerged;

    if (this.quality.reflections && !submerged) {
      this.reflection.render(gl, this.scene, this.camera);
      su.uReflection.value = this.reflection.target.texture;
    } else {
      su.uReflection.value = this.emptyReflection;
    }

    gl.setRenderTarget(this.hdrRT);
    gl.setClearColor(0x000000, 1);
    gl.clear(true, true, false);
    gl.render(this.scene, this.camera);

    su.uShadowMap.value = this.sunLight.shadow.map?.depthTexture ?? null;
    if (this.hdrRT) this.hdrRT.resolveDepthBuffer = nearSurface;
    gl.render(this.waterScene, this.camera);
    if (this.hdrRT) this.hdrRT.resolveDepthBuffer = true;

    let frame: THREE.Texture = this.hdrRT!.texture;
    if (nearSurface) frame = this.underwater.render(gl, this.hdrRT, camY < this.camWater - 0.8);

    this.post.render(frame, dt);
    this.timer.endFrame();
  }

  dispose(): void {
    this.hdrRT?.dispose();
    this.post?.dispose?.();
  }
}
