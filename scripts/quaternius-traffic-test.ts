import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { TrafficRenderer } from '../src/game/traffic/TrafficModels';

const renderer = new TrafficRenderer([2, 2]);
const make = (name: string, color: number): Group => {
  const group = new Group();
  group.name = name;
  group.add(new Mesh(new BoxGeometry(1.8, 1.1, 4.2), new MeshStandardMaterial({ color })));
  return group;
};
const car = make('Quaternius car', 0x236a9f);
const taxi = make('Quaternius taxi', 0xd9b622);
const suv = make('Quaternius SUV', 0x5b6572);
const bus = make('Quaternius bus', 0xe2e2df);
renderer.useQuaternius([car, taxi, suv, bus]);
const authored = renderer.group.children.filter((child) => child.name === 'Quaternius ambient car');
const buses = renderer.group.children.filter((child) => child.name === 'Quaternius bus in traffic');
if (authored.length !== 3 || buses.length !== 1) throw new Error(`Expected 3 normal cars + 1 bus, got ${authored.length} + ${buses.length}`);
renderer.set(0, 0, 10, 0, 20, 0, 0, 0, 1, false);
if (!authored[0].visible) throw new Error('Authored car slot did not become visible');
renderer.set(1, 0, -5, 0, 6, 0, 0, 0, 1, false);
if (!buses[0].visible) throw new Error('Quaternius bus slot did not become visible');
renderer.hide(0, 0);
if (authored[0].visible) throw new Error('Authored car slot did not hide');
renderer.commit();
renderer.dispose();
console.log('PASS Quaternius cars and one bus replace ambient traffic, follow transforms and hide cleanly');
