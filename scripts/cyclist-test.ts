import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { CyclistSystem } from '../src/game/city/CyclistSystem';
import { Track } from '../src/game/world/Track';

function ok(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

const track = new Track(2);
const bicycle = new Group();
const wheel = new Mesh(new BoxGeometry(0.8, 0.8, 1.8), new MeshStandardMaterial({ color: 0xe05235 }));
bicycle.add(wheel);
const riders = new CyclistSystem(track, bicycle);
ok(riders.agents.length === 5, 'five cyclists are pooled');
ok(riders.agents.every((a) => a.person && !a.vehicle && a.halfLen > 0.5), 'cyclists are exposed to traffic as pedestrian-sized moving agents');
const start = { x: riders.agents[0].x, z: riders.agents[0].z };
riders.fixedUpdate(0.5, []);
const moved = Math.hypot(riders.agents[0].x - start.x, riders.agents[0].z - start.z);
ok(moved > 1.2 && moved < 3.0, `NPC cyclists advance along the loop at bike speed (${moved.toFixed(2)} m / 0.5 s)`);
const near = riders.agents[0];
const beforeYield = { x: near.x, z: near.z };
riders.fixedUpdate(0.5, [{ mode: 1, x: near.x, z: near.z }]);
const yielded = Math.hypot(riders.agents[0].x - beforeYield.x, riders.agents[0].z - beforeYield.z);
ok(yielded < 1.0, `cyclist yields when a traffic car enters its buffer (${yielded.toFixed(2)} m / 0.5 s)`);
riders.render(near.x, near.z);
ok(riders.group.children.length >= 4, 'Quaternius bicycle mesh and visible rider parts are instanced');
riders.dispose();
console.log('ALL CYCLIST CHECKS PASSED');
