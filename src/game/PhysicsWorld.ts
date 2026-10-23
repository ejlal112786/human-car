import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT, GRAVITY } from './config';

export type RapierModule = typeof RAPIER;

let rapierReady: Promise<void> | null = null;

/** Initialise the Rapier WASM module exactly once. */
function initRapier(): Promise<void> {
  if (!rapierReady) {
    rapierReady = RAPIER.init().catch((err: unknown) => {
      rapierReady = null;
      throw err;
    });
  }
  return rapierReady;
}

/**
 * Thin wrapper around a Rapier world with helpers for creating static geometry.
 * The world always advances with a fixed timestep (see {@link FIXED_DT}).
 */
export class PhysicsWorld {
  readonly R: RapierModule = RAPIER;
  readonly world: RAPIER.World;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = FIXED_DT;
    this.world.numSolverIterations = 8;
  }

  static async create(): Promise<PhysicsWorld> {
    await initRapier();
    return new PhysicsWorld();
  }

  /**
   * Advance the world by one fixed timestep.
   *
   * Calls the physics pipeline directly instead of `World.step()`. In Rapier 0.21 `World.step()`
   * also runs `mapNewSoftBodies()` after every step, which walks *every* rigid body and collider
   * through WASM→JS callbacks to sync its JS-side handle maps. With this game's ~1,000 static
   * colliders that cost ~137 kB of garbage and a large share of the CPU time per step. The sync is
   * only needed when bodies are created or removed *inside* a step (soft-body tearing); this game
   * has no soft bodies, and every body/collider is created through `world.createRigidBody` /
   * `world.createCollider`, which register them in those maps immediately. Pass
   * `syncHandles = true` to use the stock `World.step()` (used by the regression test).
   */
  step(syncHandles = false): void {
    const w = this.world;
    if (syncHandles) {
      w.step();
      return;
    }
    w.physicsPipeline.step(
      w.gravity,
      w.integrationParameters,
      w.islands,
      w.broadPhase,
      w.narrowPhase,
      w.bodies,
      w.colliders,
      w.softBodies,
      w.impulseJoints,
      w.multibodyJoints,
      w.ccdSolver,
    );
  }

  /** Number of rigid bodies and colliders in the world (diagnostics). */
  get counts(): { bodies: number; colliders: number } {
    return { bodies: this.world.bodies.len(), colliders: this.world.colliders.len() };
  }

  /** Large static ground slab whose top surface lies at y = 0. */
  addGround(halfSize: number): RAPIER.Collider {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    return this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfSize, 0.5, halfSize).setFriction(1.0),
      body,
    );
  }

  addStaticBox(
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    yaw = 0,
    friction = 0.5,
  ): RAPIER.Collider {
    const half = yaw * 0.5;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(x, y, z)
        .setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }),
    );
    return this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction).setRestitution(0.05),
      body,
    );
  }

  addStaticCylinder(x: number, y: number, z: number, halfHeight: number, radius: number): RAPIER.Collider {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    return this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(halfHeight, radius).setFriction(0.4).setRestitution(0.1),
      body,
    );
  }

  addStaticTrimesh(vertices: Float32Array, indices: Uint32Array): RAPIER.Collider {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    return this.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(1.0), body);
  }

  dispose(): void {
    this.world.free();
  }
}
