import { readFile } from 'node:fs/promises';
import { Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const files = ['1story', '2story_balcony', '3story_slim', '4story', '6story_stack', 'basiccar', 'copcar', 'racecar', 'taxi', 'simplecarhigh', 'bicycle', 'bus', 'ambulance', 'sign_stop', 'sign_noparking', 'streetlight_single', 'streetlight_double'];
for (const name of files) {
  const bytes = await readFile(`src/assets/quaternius/${name}.glb`);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
  const bounds = new Box3().setFromObject(gltf.scene);
  let meshCount = 0;
  gltf.scene.traverse((node) => { if (node.isMesh) meshCount++; });
  if (!meshCount || bounds.isEmpty()) throw new Error(`Invalid rendered scene: ${name}`);
  console.log(`PASS ${name}.glb parses into ${meshCount} mesh(es)`);
}
console.log('ALL QUATERNIUS GLTF LOAD CHECKS PASSED');
