import {
  Box3, BoxGeometry, BufferGeometry, CapsuleGeometry, DynamicDrawUsage, Group, InstancedMesh,
  Matrix4, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3,
} from 'three';
import type { Group as ThreeGroup, MeshStandardMaterial as StandardMaterial } from 'three';
import type { TrafficAgent } from '../traffic/TrafficSystem';
import type { Track } from '../world/Track';

const COUNT = 5;

/** Small loop-following city cyclists, rendered with the Quaternius bicycle model. */
export class CyclistSystem {
  readonly group = new Group();
  readonly agents: TrafficAgent[] = Array.from({ length: COUNT }, (_, id) => ({
    x: 0, z: 0, vx: 0, vz: 0, halfLen: 0.9, halfWidth: 0.38, person: true, vehicle: false, id: 100 + id, hint: 0,
  }));
  private readonly bikeMeshes: InstancedMesh[] = [];
  private readonly riderMeshes: InstancedMesh[] = [];
  private readonly bikeGeometries: BufferGeometry[] = [];
  private readonly materials: MeshStandardMaterial[] = [];
  private readonly positions = new Float32Array(COUNT);
  private readonly velocities = [4.2, 4.8, 3.8, 4.5, 4.0];
  private readonly matrix = new Matrix4();
  private readonly pos = new Vector3();
  private readonly quat = new Quaternion();
  private readonly scale = new Vector3(1, 1, 1);
  private readonly zero = new Matrix4().makeScale(0, 0, 0);
  private readonly up = new Vector3(0, 1, 0);

  constructor(private readonly track: Track, bicycle: ThreeGroup) {
    this.group.name = 'Quaternius NPC cyclists';
    bicycle.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(bicycle);
    const size = new Vector3();
    bounds.getSize(size);
    const offset = new Matrix4().makeTranslation(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
    const resize = new Matrix4().makeScale(0.62 / Math.max(0.01, size.x), 1.0 / Math.max(0.01, size.y), 1.8 / Math.max(0.01, size.z));
    bicycle.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const geo = node.geometry.clone().applyMatrix4(node.matrixWorld).applyMatrix4(offset).applyMatrix4(resize);
      this.bikeGeometries.push(geo);
      const source = (Array.isArray(node.material) ? node.material[0] : node.material) as StandardMaterial;
      const mat = new MeshStandardMaterial({ color: source.color ?? 0xffffff, map: source.map ?? null, roughness: 0.78, metalness: 0.05 });
      this.materials.push(mat);
      const im = new InstancedMesh(geo, mat, COUNT);
      im.name = 'Quaternius bicycle mesh';
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = true;
      for (let i = 0; i < COUNT; i++) im.setMatrixAt(i, this.zero);
      this.group.add(im);
      this.bikeMeshes.push(im);
    });
    const torso = new CapsuleGeometry(0.22, 0.48, 4, 8);
    torso.translate(0, 1.05, -0.12);
    const head = new SphereGeometry(0.16, 8, 6);
    head.translate(0, 1.45, 0.1);
    const leg = new BoxGeometry(0.12, 0.5, 0.42);
    leg.translate(0.13, 0.52, 0.12);
    const riderMat = new MeshStandardMaterial({ color: 0x236f8c, roughness: 0.82 });
    const skinMat = new MeshStandardMaterial({ color: 0xc98962, roughness: 0.9 });
    for (const [geometry, material, name] of [[torso, riderMat, 'cyclist torso'], [head, skinMat, 'cyclist head'], [leg, riderMat, 'cyclist leg']] as const) {
      const mesh = new InstancedMesh(geometry, material, COUNT);
      mesh.name = name;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      this.group.add(mesh);
      this.riderMeshes.push(mesh);
    }
    this.materials.push(riderMat, skinMat);
    for (let i = 0; i < COUNT; i++) {
      this.positions[i] = this.track.length * (i + 0.1) / COUNT;
      this.updateAgent(i, this.agents[i]);
    }
  }

  private updateAgent(i: number, a: TrafficAgent): void {
    const s = ((this.positions[i] % this.track.length) + this.track.length) % this.track.length;
    const idx = Math.floor(s / this.track.spacing) % this.track.count;
    const side = i % 2 ? 8.6 : -8.6;
    a.x = this.track.px[idx] + this.track.rx(idx) * side;
    a.z = this.track.pz[idx] + this.track.rz(idx) * side;
    a.vx = this.track.tx[idx] * this.velocities[i];
    a.vz = this.track.tz[idx] * this.velocities[i];
    a.hint = idx;
  }

  /** Advance cyclists and yield briefly when a car occupies their sidewalk-side buffer. */
  fixedUpdate(dt: number, cars: readonly { mode: number; x: number; z: number }[]): void {
    for (let i = 0; i < COUNT; i++) {
      const a = this.agents[i];
      let speed = this.velocities[i];
      for (const car of cars) {
        if (car.mode !== 1) continue;
        if (Math.hypot(car.x - a.x, car.z - a.z) < 4.2) speed = Math.min(speed, 1.0);
      }
      this.positions[i] = (this.positions[i] + speed * dt) % this.track.length;
      this.updateAgent(i, a);
    }
  }

  render(focusX: number, focusZ: number): void {
    for (let i = 0; i < COUNT; i++) {
      const a = this.agents[i];
      const visible = Math.hypot(a.x - focusX, a.z - focusZ) < 270;
      this.pos.set(a.x, 0, a.z);
      this.quat.setFromAxisAngle(this.up, Math.atan2(this.track.tx[a.hint], this.track.tz[a.hint]));
      this.scale.setScalar(1);
      this.matrix.compose(this.pos, this.quat, this.scale);
      for (const mesh of this.bikeMeshes) mesh.setMatrixAt(i, visible ? this.matrix : this.zero);
      for (const mesh of this.riderMeshes) mesh.setMatrixAt(i, visible ? this.matrix : this.zero);
    }
    for (const mesh of [...this.bikeMeshes, ...this.riderMeshes]) mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const geometry of this.bikeGeometries) geometry.dispose();
    for (const mesh of [...this.bikeMeshes, ...this.riderMeshes]) mesh.dispose();
    for (const material of this.materials) material.dispose();
    this.group.removeFromParent();
  }
}
