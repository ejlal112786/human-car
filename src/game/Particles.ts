import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  DynamicDrawUsage,
  Float32BufferAttribute,
  NormalBlending,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  type Scene,
} from 'three';

function softDot(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/** A fixed-size pool of billboard particles in one draw call (no per-frame allocation). */
class Pool {
  readonly points: Points;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly base: Float32Array;
  private next = 0;
  private alive = 0;

  constructor(
    private readonly capacity: number,
    material: PointsMaterial,
    private readonly drag: number,
    private readonly rise: number,
  ) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.base = new Float32Array(capacity * 3);
    for (let i = 0; i < capacity; i++) this.pos[i * 3 + 1] = -100;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('color', new Float32BufferAttribute(this.col, 4).setUsage(DynamicDrawUsage));
    this.points = new Points(geo, material);
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, r: number, g: number, b: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.base[i * 3] = r;
    this.base[i * 3 + 1] = g;
    this.base[i * 3 + 2] = b;
    this.alive = this.capacity;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    let any = 0;
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const a = this.life[i] > 0 ? this.life[i] / this.maxLife[i] : 0;
      if (a <= 0) {
        this.pos[i * 3 + 1] = -100;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      any++;
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + this.rise * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.col[i * 4] = this.base[i * 3];
      this.col[i * 4 + 1] = this.base[i * 3 + 1];
      this.col[i * 4 + 2] = this.base[i * 3 + 2];
      this.col[i * 4 + 3] = a * a * 0.7;
    }
    this.alive = any;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    for (let i = 0; i < this.capacity; i++) {
      this.pos[i * 3 + 1] = -100;
      this.col[i * 4 + 3] = 0;
    }
    this.alive = 0;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
  }
}

/**
 * Tyre smoke (sliding / spinning wheels), impact dust and checkpoint sparkles.
 * Disabled entirely on the Low graphics preset.
 */
export class Particles {
  private readonly smoke: Pool;
  private readonly sparks: Pool;
  private readonly tex = softDot();
  private readonly smokeMat: PointsMaterial;
  private readonly sparkMat: PointsMaterial;
  private enabled = true;
  private seed = 1;

  constructor(scene: Scene) {
    this.smokeMat = new PointsMaterial({
      size: 1.6,
      map: this.tex,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      sizeAttenuation: true,
    });
    this.sparkMat = new PointsMaterial({
      size: 0.45,
      map: this.tex,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      sizeAttenuation: true,
    });
    this.smoke = new Pool(160, this.smokeMat, 1.6, 0.6);
    this.sparks = new Pool(64, this.sparkMat, 1.2, -6);
    this.smoke.points.name = 'tyre-smoke';
    this.sparks.points.name = 'sparkles';
    scene.add(this.smoke.points, this.sparks.points);
  }

  /** Deterministic cheap random in [0,1). */
  private rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.smoke.points.visible = on;
    this.sparks.points.visible = on;
    if (!on) this.clear();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Tyre smoke puff at a wheel contact (called per physics step while sliding). */
  tyre(x: number, y: number, z: number, slip: number): void {
    if (!this.enabled || this.rnd() > slip * 0.55) return;
    const g = 0.78 + this.rnd() * 0.1;
    this.smoke.emit(x, y + 0.15, z, (this.rnd() - 0.5) * 1.2, 0.4 + this.rnd() * 0.5, (this.rnd() - 0.5) * 1.2, 0.9 + this.rnd() * 0.7, g, g, g * 1.02);
  }

  /** Dust burst on a collision; strength = velocity change (m/s). */
  impact(x: number, y: number, z: number, strength: number): void {
    if (!this.enabled) return;
    const n = Math.min(14, 4 + Math.round(strength));
    for (let k = 0; k < n; k++) {
      const a = this.rnd() * Math.PI * 2;
      const s = 1 + this.rnd() * 2.5;
      this.smoke.emit(x, y + 0.3, z, Math.cos(a) * s, 0.5 + this.rnd(), Math.sin(a) * s, 0.6 + this.rnd() * 0.5, 0.62, 0.58, 0.5);
    }
  }

  /** Engine smoke from a damaged car (level 0..1); call per frame with dt. */
  engineSmoke(x: number, y: number, z: number, level: number, dt: number): void {
    if (!this.enabled || level <= 0 || this.rnd() > level * dt * 14) return;
    const g = 0.22 + this.rnd() * 0.12;
    this.smoke.emit(x + (this.rnd() - 0.5) * 0.5, y, z + (this.rnd() - 0.5) * 0.5, (this.rnd() - 0.5) * 0.6, 1.1 + this.rnd() * 0.8, (this.rnd() - 0.5) * 0.6, 1.4 + this.rnd(), g, g, g);
  }

  /** Bullet impact: a few sparks off the surface normal and a small dust puff. */
  bulletImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, metal: boolean): void {
    if (!this.enabled) return;
    for (let k = 0; k < (metal ? 7 : 3); k++) {
      const s = 2 + this.rnd() * 3;
      this.sparks.emit(x, y, z, (nx + (this.rnd() - 0.5) * 1.2) * s, (ny + this.rnd() * 0.8) * s, (nz + (this.rnd() - 0.5) * 1.2) * s, 0.18 + this.rnd() * 0.15, 1, 0.8, 0.4);
    }
    const g = metal ? 0.5 : 0.62;
    for (let k = 0; k < 3; k++) this.smoke.emit(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, nx * 0.8 + (this.rnd() - 0.5) * 0.4, ny * 0.8 + 0.3, nz * 0.8 + (this.rnd() - 0.5) * 0.4, 0.5 + this.rnd() * 0.3, g, g * 0.96, g * 0.9);
  }

  /** Sparkle burst (checkpoint passed). */
  sparkle(x: number, y: number, z: number, r = 0.2, g = 0.95, b = 0.6): void {
    if (!this.enabled) return;
    for (let k = 0; k < 24; k++) {
      const a = this.rnd() * Math.PI * 2;
      const s = 2 + this.rnd() * 4;
      this.sparks.emit(x, y, z, Math.cos(a) * s, 2 + this.rnd() * 4, Math.sin(a) * s, 0.6 + this.rnd() * 0.5, r, g, b);
    }
  }

  update(dt: number): void {
    if (!this.enabled) return;
    this.smoke.update(dt);
    this.sparks.update(dt);
  }

  clear(): void {
    this.smoke.clear();
    this.sparks.clear();
  }

  dispose(): void {
    this.smoke.dispose();
    this.sparks.dispose();
    this.smokeMat.dispose();
    this.sparkMat.dispose();
    this.tex.dispose();
  }
}
