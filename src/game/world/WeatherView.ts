import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  ShaderMaterial,
  Vector3,
  type Camera,
  type Scene,
} from 'three';
import { ROAD } from '../config';
import type { QualityLevel } from '../Settings';
import type { Puddle } from './Surface';
import { mulberry32 } from './random';

/** What the view needs from the weather each frame (all 0..1). */
export interface WeatherViewState {
  rain: number;
  wetness: number;
  puddles: number;
}

/** Rain drops around the camera per graphics level. */
const DROPS: Record<QualityLevel, number> = { ultra: 9000, high: 6000, medium: 3500, low: 1600 };
/** Rain box around the camera (half-size and height, m). */
const BOX_R = 22;
const BOX_H = 18;
const FALL_SPEED = 13;
/** Streak length (m) and width (m). */
const STREAK_LEN = 0.75;
const STREAK_W = 0.02;

const RAIN_VS = /* glsl */ `
  attribute vec3 aBase;
  attribute vec2 aCorner;
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec2 uWind;
  varying float vAlong;
  varying float vFade;
  void main() {
    float speed = ${FALL_SPEED.toFixed(1)} * (0.85 + 0.3 * fract(aBase.x * 12.9898 + aBase.z * 78.233));
    vec3 vel = vec3(uWind.x, -speed, uWind.y);
    // Wrap the drop into a box that moves with the camera (no per-frame CPU work).
    float r2 = ${(BOX_R * 2).toFixed(1)};
    vec3 p;
    p.x = uCam.x + mod(aBase.x - uCam.x + vel.x * uTime, r2) - ${BOX_R.toFixed(1)};
    p.z = uCam.z + mod(aBase.z - uCam.z + vel.z * uTime, r2) - ${BOX_R.toFixed(1)};
    p.y = uCam.y - ${(BOX_H * 0.45).toFixed(2)} + mod(aBase.y + vel.y * uTime, ${BOX_H.toFixed(1)});
    vec3 dir = normalize(vel);
    // Streak along the fall direction, widened across the view direction.
    vec3 toCam = normalize(cameraPosition - p);
    vec3 side = normalize(cross(dir, toCam)) * ${STREAK_W.toFixed(4)};
    p += side * aCorner.x - dir * aCorner.y * ${STREAK_LEN.toFixed(2)};
    vAlong = aCorner.y;
    float d = length(p - uCam);
    // (smoothstep needs edge0 < edge1: a reversed call is undefined in GLSL and returns 0 on some GPUs.)
    vFade = (1.0 - smoothstep(${(BOX_R * 0.55).toFixed(1)}, ${BOX_R.toFixed(1)}, d)) * smoothstep(0.4, 1.6, d);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;
const RAIN_FS = /* glsl */ `
  uniform float uOpacity;
  uniform vec3 uColor;
  varying float vAlong;
  varying float vFade;
  void main() {
    float a = uOpacity * vFade * (1.0 - vAlong * 0.75);
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface WetBase {
  mat: MeshStandardMaterial;
  roughness: number;
  color: Color;
  env: number;
  /** How strongly it reacts (road surfaces 1, grass less). */
  k: number;
}

/**
 * Rain, wet road surfaces and puddles. Pure presentation: the grip effects live in the physics (GripField,
 * TyreModel); this only shows the same weather state.
 */
export class WeatherView {
  private rain: Mesh<BufferGeometry, ShaderMaterial> | null = null;
  private readonly rainMat: ShaderMaterial;
  private readonly puddleMesh: InstancedMesh<CircleGeometry, MeshStandardMaterial>;
  private readonly wet: WetBase[];
  private time = 0;
  private lastWet = -1;
  private lastFill = -1;
  private quality: QualityLevel = 'high';
  private readonly puddles: Puddle[];

  constructor(
    private readonly scene: Scene,
    puddles: Puddle[],
    wetMaterials: MeshStandardMaterial[],
  ) {
    this.puddles = puddles;
    this.rainMat = new ShaderMaterial({
      vertexShader: RAIN_VS,
      fragmentShader: RAIN_FS,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new Vector3() },
        uWind: { value: [1.2, 0.5] },
        uOpacity: { value: 0 },
        uColor: { value: new Color(0xb4c0cc) },
      },
      transparent: true,
      depthWrite: false,
      // The streak quads are built facing either way (cross product): never cull them.
      side: DoubleSide,
    });
    this.buildRain();

    // Puddles: flat dark mirrors on the asphalt (slightly above it, polygon offset against z-fighting).
    const geo = new CircleGeometry(1, 28);
    geo.rotateX(-Math.PI / 2);
    const mat = new MeshStandardMaterial({
      color: 0x15181c,
      roughness: 0.12,
      metalness: 0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
    });
    this.puddleMesh = new InstancedMesh(geo, mat, puddles.length);
    this.puddleMesh.name = 'puddles';
    this.puddleMesh.visible = false;
    this.puddleMesh.receiveShadow = false;
    this.puddleMesh.frustumCulled = false;
    this.layoutPuddles(1);
    scene.add(this.puddleMesh);

    // The last wet material is the grass (see Environment.wetMaterials): it only darkens a little.
    this.wet = wetMaterials.map((m, i) => ({
      mat: m,
      roughness: m.roughness,
      color: m.color.clone(),
      env: m.envMapIntensity,
      k: i === wetMaterials.length - 1 ? 0.35 : 1,
    }));
  }

  /** Number of rain drops at the current graphics level (for tests / diagnostics). */
  get dropCount(): number {
    return DROPS[this.quality];
  }

  setQuality(q: QualityLevel): void {
    if (q === this.quality) return;
    this.quality = q;
    this.buildRain();
  }

  /** Per rendered frame: `state` null = missions (always dry, no rain). */
  update(dt: number, camera: Camera, state: WeatherViewState | null): void {
    const rain = state ? state.rain : 0;
    const wet = state ? state.wetness : 0;
    const fill = state ? state.puddles : 0;
    this.time = (this.time + dt) % 1000;
    if (this.rain) {
      const u = this.rainMat.uniforms;
      u.uTime.value = this.time;
      (u.uCam.value as Vector3).copy(camera.position);
      u.uOpacity.value = 0.55 * Math.min(1, rain * 1.4);
      this.rain.visible = rain > 0.02;
    }
    if (Math.abs(wet - this.lastWet) > 0.004) {
      this.lastWet = wet;
      for (const w of this.wet) {
        const e = wet * w.k;
        // Wet: darker (water fills the texture) and glossier, but not a mirror — the film is thin.
        w.mat.roughness = w.roughness * (1 - 0.45 * e);
        w.mat.color.copy(w.color).multiplyScalar(1 - 0.45 * e);
      }
    }
    if (Math.abs(fill - this.lastFill) > 0.004) {
      this.lastFill = fill;
      this.puddleMesh.visible = fill > 0.01;
      this.puddleMesh.material.opacity = 0.75 * Math.min(1, fill * 1.5);
      this.layoutPuddles(0.45 + 0.55 * fill);
    }
  }

  private layoutPuddles(size: number): void {
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const pos = new Vector3();
    const scl = new Vector3();
    this.puddles.forEach((p, i) => {
      q.setFromAxisAngle(up, Math.atan2(-p.tz, p.tx));
      pos.set(p.x, ROAD.surfaceY + 0.006, p.z);
      scl.set(p.a * size, 1, p.b * size);
      m.compose(pos, q, scl);
      this.puddleMesh.setMatrixAt(i, m);
    });
    this.puddleMesh.instanceMatrix.needsUpdate = true;
  }

  private buildRain(): void {
    if (this.rain) {
      this.scene.remove(this.rain);
      this.rain.geometry.dispose();
    }
    const n = DROPS[this.quality];
    const base = new Float32Array(n * 4 * 3);
    const corner = new Float32Array(n * 4 * 2);
    const index = new Uint32Array(n * 6);
    const rnd = mulberry32(4242);
    for (let d = 0; d < n; d++) {
      const x = rnd() * BOX_R * 2;
      const y = rnd() * BOX_H;
      const z = rnd() * BOX_R * 2;
      for (let c = 0; c < 4; c++) {
        const v = d * 4 + c;
        base.set([x, y, z], v * 3);
        corner.set([c & 1 ? 1 : -1, c >> 1], v * 2);
      }
      index.set([d * 4, d * 4 + 1, d * 4 + 2, d * 4 + 2, d * 4 + 1, d * 4 + 3], d * 6);
    }
    const g = new BufferGeometry();
    // `position` is required by three (bounding volumes); the shader positions drops from aBase.
    g.setAttribute('position', new BufferAttribute(base, 3));
    g.setAttribute('aBase', new BufferAttribute(base, 3));
    g.setAttribute('aCorner', new BufferAttribute(corner, 2));
    g.setIndex(new BufferAttribute(index, 1));
    this.rain = new Mesh(g, this.rainMat);
    this.rain.name = 'rain';
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.renderOrder = 5;
    this.scene.add(this.rain);
  }

  dispose(): void {
    if (this.rain) {
      this.scene.remove(this.rain);
      this.rain.geometry.dispose();
    }
    this.rainMat.dispose();
    this.scene.remove(this.puddleMesh);
    this.puddleMesh.geometry.dispose();
    this.puddleMesh.material.dispose();
    this.puddleMesh.dispose();
    for (const w of this.wet) {
      w.mat.roughness = w.roughness;
      w.mat.color.copy(w.color);
      w.mat.envMapIntensity = w.env;
    }
  }
}
