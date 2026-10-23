import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Vector3, type Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { PhysicsWorld } from './PhysicsWorld';
import { buildCity, type Footprint } from './world/CityBuilder';
import { furnitureBlocker } from './pedestrians/obstacles';
import { CrossingVisuals } from './world/Crossings';
import { DynamicProps, buildStaticProps } from './world/Props';
import { buildRoad } from './world/RoadBuilder';
import { createTextures, type TextureSet } from './world/Textures';
import { Track } from './world/Track';

/** Ground plane subdivisions per side (see the depth-precision note where the ground is built). */
const GROUND_SEGMENTS = 48;

const WORLD_HALF = 800;
const BOUNDARY = 560;

/**
 * Builds and owns the whole static world (ground, road network, city, props)
 * and the dynamic props that live in the physics world.
 */
export class Environment {
  readonly track: Track;
  readonly root = new Group();
  readonly footprints: Footprint[];
  readonly props: DynamicProps;
  /** Ground-level materials that look wet in the rain: road materials (asphalt first), then the grass. */
  readonly wetMaterials: MeshStandardMaterial[] = [];
  readonly crossings: CrossingVisuals;
  private readonly textures: TextureSet;
  private readonly disposers: Array<() => void> = [];
  /** Authored cyclist model template; CityLife instances this for moving NPC cyclists. */
  quaterniusBicycle: Group | null = null;
  readonly quaterniusCars: Group[] = [];
  readonly interiorDoors: Array<{ id: string; label: string; x: number; z: number; yaw: number; roomX: number; roomZ: number }> = [];
  private readonly physics: PhysicsWorld;

  constructor(scene: Scene, physics: PhysicsWorld, anisotropy: number) {
    this.physics = physics;
    this.root.name = 'environment';
    this.textures = createTextures(anisotropy);
    this.track = new Track(2);

    // Ground
    // Subdivided (not one giant quad) and pushed back in depth with a polygon offset: the road surface is
    // only 2 cm above the grass, and depth interpolated across a huge clipped triangle is not precise enough
    // on software rasterisers and some mobile GPUs (the grass showed through the asphalt in blocks).
    const groundGeo = new PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2, GROUND_SEGMENTS, GROUND_SEGMENTS);
    groundGeo.rotateX(-Math.PI / 2);
    const uv = groundGeo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 200, uv.getY(i) * 200);
    const groundMat = new MeshStandardMaterial({ map: this.textures.grass, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
    const ground = new Mesh(groundGeo, groundMat);
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.root.add(ground);
    physics.addGround(WORLD_HALF);
    this.disposers.push(() => {
      groundGeo.dispose();
      groundMat.dispose();
    });

    // Invisible boundary walls so the car can never leave the world.
    for (const [x, z, hx, hz] of [
      [BOUNDARY, 0, 1, BOUNDARY],
      [-BOUNDARY, 0, 1, BOUNDARY],
      [0, BOUNDARY, BOUNDARY, 1],
      [0, -BOUNDARY, BOUNDARY, 1],
    ] as const) {
      physics.addStaticBox(x, 5, z, hx, 5, hz);
    }

    const road = buildRoad(this.track, this.textures, physics);
    this.root.add(road.group);
    this.disposers.push(road.dispose);
    this.wetMaterials.push(...road.wetMaterials, groundMat);

    this.props = new DynamicProps(physics, this.track);
    this.root.add(this.props.group);
    this.disposers.push(() => this.props.dispose());

    const city = buildCity(this.track, this.textures, physics);
    this.footprints = city.footprints;
    this.root.add(city.group);
    this.disposers.push(city.dispose);

    this.crossings = new CrossingVisuals(this.track, physics);
    this.root.add(this.crossings.group);
    this.disposers.push(() => this.crossings.dispose());

    const propPositions = this.props.positions;
    const blocked = furnitureBlocker(this.track, propPositions);
    const statics = buildStaticProps(this.track, physics, blocked);
    this.root.add(statics.group);
    this.disposers.push(statics.dispose);

    scene.add(this.root);
  }

  /** Load and place the authored Quaternius CC0 building, street, vehicle and bicycle assets. */
  async loadQuaterniusBuildings(): Promise<number> {
    const names = ['1story', '2story_balcony', '3story_slim', '4story', '6story_stack', 'basiccar', 'copcar', 'racecar', 'taxi', 'simplecarhigh', 'bicycle', 'bus', 'ambulance', 'sign_stop', 'sign_noparking', 'streetlight_single', 'streetlight_double'];
    const files = Object.fromEntries(names.map((name) => [name, new URL(`../assets/quaternius/${name}.glb`, import.meta.url).href]));
    const loader = new GLTFLoader();
    const loaded = new Map<string, Group>();
    await Promise.all(Object.entries(files).map(async ([name, url]) => {
      const gltf = await loader.loadAsync(url);
      loaded.set(name, gltf.scene);
    }));
    this.quaterniusCars.push(loaded.get('basiccar')!, loaded.get('taxi')!, loaded.get('simplecarhigh')!, loaded.get('bus')!);
    const authored = new Group();
    authored.name = 'Quaternius CC0 buildings';
    let count = 0;
    const bounds = new Box3();
    const size = new Vector3();
    for (const lot of this.footprints) {
      if (!lot.quaterniusModel) continue;
      const source = loaded.get(lot.quaterniusModel);
      if (!source) continue;
      const model = source.clone(true);
      bounds.setFromObject(model);
      bounds.getSize(size);
      if (size.x < 0.01 || size.y < 0.01 || size.z < 0.01) continue;
      model.scale.set(lot.w / size.x, lot.h / size.y, lot.d / size.z);
      model.position.set(
        lot.x - (bounds.min.x + bounds.max.x) * 0.5 * model.scale.x,
        -bounds.min.y * model.scale.y,
        lot.z - (bounds.min.z + bounds.max.z) * 0.5 * model.scale.z,
      );
      model.rotation.y = lot.yaw;
      model.traverse((node) => {
        if ('isMesh' in node && node.isMesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
      authored.add(model);
      count++;
    }

    const place = (name: string, sample: number, side: number, width: number, height: number, depth: number, nameTag = name): void => {
      const source = loaded.get(name);
      if (!source) return;
      const i = ((sample % this.track.count) + this.track.count) % this.track.count;
      const yaw = Math.atan2(this.track.tx[i], this.track.tz[i]);
      const model = source.clone(true);
      bounds.setFromObject(model);
      bounds.getSize(size);
      if (size.x < 0.01 || size.y < 0.01 || size.z < 0.01) return;
      model.scale.set(width / size.x, height / size.y, depth / size.z);
      const ox = (bounds.min.x + bounds.max.x) * 0.5 * model.scale.x;
      const oy = bounds.min.y * model.scale.y;
      const oz = (bounds.min.z + bounds.max.z) * 0.5 * model.scale.z;
      const x = this.track.px[i] + this.track.rx(i) * side;
      const z = this.track.pz[i] + this.track.rz(i) * side;
      model.position.set(x - ox, -oy, z - oz);
      model.rotation.y = yaw;
      model.name = `Quaternius ${nameTag}`;
      model.traverse((node) => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
      authored.add(model);
    };
    // Curated curbside fleet and transport: clearly visible authored models, kept out of the traffic lanes.
    const parked = ['basiccar', 'taxi', 'simplecarhigh', 'copcar', 'racecar'];
    parked.forEach((name, k) => place(name, Math.floor(this.track.count * (0.08 + k * 0.17)), 10.5, 2.0, 1.8, 4.6));
    place('bus', Math.floor(this.track.count * 0.42), -11.5, 2.7, 3.8, 10.5, 'city bus');
    place('ambulance', Math.floor(this.track.count * 0.68), 10.5, 2.2, 2.2, 5.2);
    for (let k = 0; k < 18; k++) {
      const sample = Math.floor(this.track.count * (k + 0.5) / 18);
      place(k % 5 === 0 ? 'sign_stop' : 'sign_noparking', sample, k % 2 ? 8.5 : -8.5, 0.8, 2.4, 0.8, 'road sign');
      if (k % 2 === 0) place(k % 4 === 0 ? 'streetlight_double' : 'streetlight_single', sample + 5, k % 4 === 0 ? 9.5 : -9.5, 0.9, 6.5, 0.9, 'street light');
    }
    this.quaterniusBicycle = loaded.get('bicycle')!.clone(true);
    this.quaterniusBicycle.name = 'Quaternius bicycle template';
    this.quaterniusBicycle.visible = false;
    authored.add(this.quaterniusBicycle);

    // Three compact, walkable interiors staged off-map; doors are paired with sampled Quaternius buildings.
    const lots = this.footprints.filter((lot) => lot.quaterniusModel).slice(0, 3);
    const interiorNames = ['Corner Shop', 'Workshop', 'Townhouse'];
    const floorMat = new MeshStandardMaterial({ color: 0x776c5b, roughness: 0.95 });
    const wallMat = new MeshStandardMaterial({ color: 0xc4b89f, roughness: 0.95 });
    const trimMat = new MeshStandardMaterial({ color: 0xd6a948, emissive: 0x553600, emissiveIntensity: 0.55, roughness: 0.55 });
    const furnMat = new MeshStandardMaterial({ color: 0x57433a, roughness: 0.85 });
    const addBox = (name: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: MeshStandardMaterial): void => {
      const mesh = new Mesh(new BoxGeometry(sx, sy, sz), mat);
      mesh.position.set(x, y, z);
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      authored.add(mesh);
    };
    lots.forEach((lot, index) => {
      const roomX = 700 + index * 24;
      const roomZ = 0;
      // Floor, three walls and a split front wall make a real walkable doorway; matching static boxes block passage.
      addBox(`${interiorNames[index]} interior floor`, roomX, -0.15, roomZ, 10, 0.3, 8, floorMat);
      addBox(`${interiorNames[index]} back wall`, roomX, 1.5, roomZ - 4, 10, 3, 0.3, wallMat);
      addBox(`${interiorNames[index]} left wall`, roomX - 4.85, 1.5, roomZ, 0.3, 3, 8, wallMat);
      addBox(`${interiorNames[index]} right wall`, roomX + 4.85, 1.5, roomZ, 0.3, 3, 8, wallMat);
      addBox(`${interiorNames[index]} front wall left`, roomX - 3.35, 1.5, roomZ + 3.85, 3.3, 3, 0.3, wallMat);
      addBox(`${interiorNames[index]} front wall right`, roomX + 3.35, 1.5, roomZ + 3.85, 3.3, 3, 0.3, wallMat);
      this.physics.addStaticBox(roomX, -0.15, roomZ, 5, 0.15, 4);
      this.physics.addStaticBox(roomX, 1.5, roomZ - 4, 5, 1.5, 0.15);
      this.physics.addStaticBox(roomX - 4.85, 1.5, roomZ, 0.15, 1.5, 4);
      this.physics.addStaticBox(roomX + 4.85, 1.5, roomZ, 0.15, 1.5, 4);
      this.physics.addStaticBox(roomX - 3.35, 1.5, roomZ + 3.85, 1.65, 1.5, 0.15);
      this.physics.addStaticBox(roomX + 3.35, 1.5, roomZ + 3.85, 1.65, 1.5, 0.15);
      // Furnish each room with usable walk-around space.
      if (index === 0) {
        addBox('shop counter', roomX, 0.55, roomZ - 1.3, 3.8, 1.1, 0.8, furnMat);
        addBox('shop shelf', roomX - 3.5, 1.0, roomZ - 2, 0.5, 2, 3.3, furnMat);
      } else if (index === 1) {
        addBox('workbench', roomX + 1.3, 0.55, roomZ - 2.4, 4.3, 1.1, 1.1, furnMat);
        addBox('tool cabinet', roomX - 3.2, 1.0, roomZ - 1.7, 1.1, 2, 2.5, furnMat);
      } else {
        addBox('townhouse table', roomX, 0.45, roomZ - 1.3, 2.6, 0.9, 1.7, furnMat);
        addBox('townhouse sofa', roomX - 2.9, 0.55, roomZ - 2.6, 2.1, 1.1, 0.9, furnMat);
      }
      // Visible, paired doorway marker on the city side and inside the room.
      const off = lot.d / 2 + 2;
      const dx = lot.x + Math.sin(lot.yaw) * off;
      const dz = lot.z + Math.cos(lot.yaw) * off;
      addBox(`${interiorNames[index]} door jamb`, dx - Math.cos(lot.yaw) * 0.7, 1.15, dz + Math.sin(lot.yaw) * 0.7, 0.18, 2.3, 0.18, trimMat);
      addBox(`${interiorNames[index]} door jamb`, dx + Math.cos(lot.yaw) * 0.7, 1.15, dz - Math.sin(lot.yaw) * 0.7, 0.18, 2.3, 0.18, trimMat);
      addBox(`${interiorNames[index]} door lintel`, dx, 2.25, dz, 1.55, 0.18, 0.18, trimMat);
      addBox(`${interiorNames[index]} interior exit marker`, roomX, 1.05, roomZ + 3.2, 1.4, 2.1, 0.12, trimMat);
      this.interiorDoors.push({ id: `interior-${index}`, label: interiorNames[index], x: dx, z: dz, yaw: lot.yaw, roomX, roomZ });
    });
    authored.updateMatrixWorld(true);
    this.root.add(authored);
    this.disposers.push(() => {
      authored.removeFromParent();
      const geometries = new Set<object>();
      const materials = new Set<object>();
      authored.traverse((node) => {
        if (node instanceof Mesh) {
          geometries.add(node.geometry);
          for (const mat of Array.isArray(node.material) ? node.material : [node.material]) materials.add(mat);
        }
      });
      for (const geometry of geometries) (geometry as { dispose(): void }).dispose();
      for (const material of materials) (material as { dispose(): void }).dispose();
    });
    return count;
  }

  /** Per-frame visual sync of dynamic props. */
  update(): void {
    this.props.sync();
  }

  resetProps(): void {
    this.props.reset();
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const d of this.disposers) d();
    this.textures.dispose();
  }
}
