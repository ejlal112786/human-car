import {
  ACESFilmicToneMapping,
  BackSide,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CAMERA } from './config';
import { QUALITY_PRESETS, type QualityLevel } from './Settings';

const SUN_ELEVATION = 36;
const SUN_AZIMUTH = 135;
const SHADOW_EXTENT = 65;

/** Clear-weather values the weather look blends from. */
const BASE = { sun: 2.5, hemi: 0.45, exposure: 0.72, env: 0.75, fogNear: 220, fogFar: 1500, fog: 0xb9c8d6 };
/** Grey of an overcast / rainy sky and of fog. */
const OVERCAST_FOG = new Color(0x969fa7);
const FOG_GREY = new Color(0xc2c7cb);

/** How the weather looks: cloud cover, rain and fog (0..1) and the visibility factor (1 clear … 0.3 thick fog). */
export interface WeatherLook {
  cloud: number;
  rain: number;
  fog: number;
  visibility: number;
}

/**
 * Owns the renderer, scene, camera, sky, lighting and resize handling.
 */
export class SceneManager {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly sun: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private readonly sky: Sky;
  /** Grey dome blended over the sky as the cloud cover thickens (the sky shader itself cannot look overcast). */
  private readonly overcast: Mesh<SphereGeometry, MeshBasicMaterial>;
  private readonly fogColor = new Color(BASE.fog);
  private readonly sunDir = new Vector3();
  /** Pre-filtered sky reflection map (rendered on the GPU, so it is rebuilt after a context loss). */
  private envTarget: WebGLRenderTarget;
  private readonly resizeObserver: ResizeObserver;
  private shadowTexel = (SHADOW_EXTENT * 2) / 2048;
  private pixelRatioCap = 1.75;
  private qualityLevel: QualityLevel = 'high';
  /** Set when something changed that requires a redraw while paused. */
  needsRender = true;

  constructor(private readonly container: HTMLElement) {
    try {
      this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
      // Per-material clipping (the cockpit view cuts the body top out of the cabin); no cost for unclipped materials.
      this.renderer.localClippingEnabled = true;
    } catch (err) {
      throw new Error(`Could not create a WebGL context: ${err instanceof Error ? err.message : String(err)}`);
    }
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 0.72;
    r.domElement.className = 'game-canvas';
    r.domElement.tabIndex = -1;
    container.prepend(r.domElement);

    this.camera = new PerspectiveCamera(CAMERA.fov, 1, 0.1, 2400);

    // Sky + matching fog
    this.sky = new Sky();
    this.sky.scale.setScalar(2000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 5.5;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    const phi = MathUtils.degToRad(90 - SUN_ELEVATION);
    const theta = MathUtils.degToRad(SUN_AZIMUTH);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.scene.add(this.sky);
    this.scene.fog = new Fog(0xb9c8d6, 220, 1500);

    // Image-based lighting generated from the same sky, for paint/glass reflections.
    this.envTarget = this.buildEnvironment();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.75;

    // Lights
    const hemi = new HemisphereLight(0xcfe0ff, 0x6b6250, BASE.hemi);
    this.hemi = hemi;
    this.scene.add(hemi);
    // Overcast dome: light grey at the horizon (meets the fog), darker overhead.
    const dome = new SphereGeometry(1800, 32, 16);
    const pos = dome.getAttribute('position');
    const col: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const up = Math.max(0, pos.getY(i) / 1800);
      const k = 1 - 0.32 * Math.sqrt(up);
      col.push(k, k, k * 1.02);
    }
    dome.setAttribute('color', new Float32BufferAttribute(col, 3));
    this.overcast = new Mesh(dome, new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, side: BackSide, depthWrite: false, fog: false }));
    this.overcast.name = 'overcast';
    this.overcast.visible = false;
    this.overcast.frustumCulled = false;
    this.scene.add(this.overcast);
    this.sun = new DirectionalLight(0xfff0dc, 2.5);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = 1;
    sc.far = 500;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get quality(): QualityLevel {
    return this.qualityLevel;
  }

  /** Apply a graphics preset at runtime (pixel ratio, shadow on/off and resolution). */
  applyQuality(level: QualityLevel): void {
    const p = QUALITY_PRESETS[level];
    this.qualityLevel = level;
    this.pixelRatioCap = p.pixelRatio;
    // Toggling castShadow changes the lights hash, so three.js recompiles affected programs itself.
    this.sun.castShadow = p.shadows;
    if (this.sun.shadow.mapSize.x !== p.shadowMapSize) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
    }
    this.shadowTexel = (SHADOW_EXTENT * 2) / p.shadowMapSize;
    this.resize();
  }

  get maxAnisotropy(): number {
    return Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.applyFraming(w, h);
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /**
   * Off-centre framing: returns the fraction of the view to shift the image by ([x, y], +x = right,
   * +y = up), e.g. so the garage car sits beside the menu panel instead of behind it. null = centred.
   */
  private framing: ((w: number, h: number) => [number, number]) | null = null;

  setFraming(f: ((w: number, h: number) => [number, number]) | null): void {
    this.framing = f;
    this.resize();
  }

  private applyFraming(w: number, h: number): void {
    const [fx, fy] = this.framing ? this.framing(w, h) : [0, 0];
    if (fx === 0 && fy === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, -fx * w, fy * h, w, h);
  }

  /** Lighting, fog and sky for the weather (clear values when called with the clear look). */
  setWeatherLook(w: WeatherLook): void {
    const c = MathUtils.clamp(w.cloud, 0, 1);
    const vis = MathUtils.clamp(w.visibility, 0.2, 1);
    this.sun.intensity = BASE.sun * (1 - 0.82 * Math.pow(c, 1.5));
    // Overcast daylight: the sun fades but the sky still lights everything (diffuse), so the scene dims only a bit.
    this.hemi.intensity = BASE.hemi * (1 + 0.6 * c);
    this.scene.environmentIntensity = BASE.env * (1 - 0.15 * c);
    this.renderer.toneMappingExposure = BASE.exposure * (1 - 0.08 * c);
    this.fogColor.set(BASE.fog).lerp(OVERCAST_FOG, Math.min(1, c * 0.85)).lerp(FOG_GREY, MathUtils.clamp(w.fog, 0, 1) * 0.8);
    const fog = this.scene.fog as Fog;
    fog.color.copy(this.fogColor);
    const k = Math.pow(vis, 2.2);
    fog.far = BASE.fogFar * k;
    fog.near = BASE.fogNear * k * k;
    const o = Math.min(0.97, 0.9 * Math.pow(c, 1.4) + 0.9 * w.fog);
    this.overcast.material.opacity = o;
    this.overcast.material.color.copy(this.fogColor).multiplyScalar(1.02);
    this.overcast.visible = o > 0.02;
    // Reflections (paint, glass, wet road) come from a sky map: rebuild it with the overcast grey when the
    // cloud cover has changed noticeably (a handful of levels, so this is rare).
    const level = Math.round(Math.min(1, c + w.fog * 0.6) * 3);
    if (level !== this.envLevel) {
      this.envLevel = level;
      this.envTarget.dispose();
      this.envTarget = this.buildEnvironment(level / 3, this.fogColor);
      this.scene.environment = this.envTarget.texture;
    }
    this.needsRender = true;
  }

  /** Overcast level the reflection map was built for (0 clear … 3 fully overcast). */
  private envLevel = 0;

  /** Keep the shadow frustum centred on the area around the player (snapped to texels to avoid shimmer). */
  updateShadowFocus(focus: Vector3): void {
    const t = this.shadowTexel;
    const x = Math.round(focus.x / t) * t;
    const z = Math.round(focus.z / t) * t;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + this.sunDir.x * 250, this.sunDir.y * 250, z + this.sunDir.z * 250);
    this.sun.target.updateMatrixWorld();
  }

  /** Render the sky into a pre-filtered environment map for image-based lighting / reflections. */
  private buildEnvironment(overcast = 0, grey: Color = OVERCAST_FOG): WebGLRenderTarget {
    const pmrem = new PMREMGenerator(this.renderer);
    const envScene = new Scene();
    let dome: Mesh<SphereGeometry, MeshBasicMaterial> | null = null;
    if (overcast > 0) {
      dome = new Mesh(new SphereGeometry(40, 24, 12), new MeshBasicMaterial({ color: grey.clone().multiplyScalar(0.85), transparent: true, opacity: Math.min(0.95, overcast), side: BackSide, depthWrite: false }));
      envScene.add(dome);
    }
    const envSky = new Sky();
    envSky.scale.setScalar(50);
    const eu = envSky.material.uniforms;
    eu.turbidity.value = 5.5;
    eu.rayleigh.value = 1.4;
    eu.mieCoefficient.value = 0.004;
    eu.mieDirectionalG.value = 0.8;
    eu.sunPosition.value.copy(this.sunDir);
    envScene.add(envSky);
    const target = pmrem.fromScene(envScene, 0.02, 0.1, 200);
    envSky.geometry.dispose();
    envSky.material.dispose();
    dome?.geometry.dispose();
    dome?.material.dispose();
    pmrem.dispose();
    return target;
  }

  /**
   * Call after the browser restores a lost WebGL context. Three.js re-uploads geometry and
   * textures by itself, but GPU-rendered content (the environment map) must be rebuilt.
   */
  /**
   * The graphics context is gone: release the environment map now. Its GL calls are ignored on a lost
   * context — disposing it after the restore would make three delete objects that belong to the old
   * context (a WebGL error per object).
   */
  releaseForContextLoss(): void {
    this.envTarget.dispose();
  }

  rebuildAfterContextRestore(): void {
    this.envTarget = this.buildEnvironment(this.envLevel / 3, this.fogColor);
    this.scene.environment = this.envTarget.texture;
    this.needsRender = true;
  }

  render(): void {
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.needsRender = false;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.envTarget.dispose();
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
