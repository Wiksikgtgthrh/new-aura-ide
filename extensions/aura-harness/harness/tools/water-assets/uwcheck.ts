import { World } from './world/world';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const world = new World(canvas, 'low');
const spawn = world.findSpawn();
world.camera.position.set(spawn.x, spawn.y + 7, spawn.z + 28);
world.camera.lookAt(spawn.x, 1, spawn.z);

let last = 0;
const loop = (now: number): void => {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  world.camera.lookAt(spawn.x, 0.5, spawn.z);
  world.camera.position.y = spawn.y + 7;
  world.render(dt);
};
requestAnimationFrame(loop);
(window as unknown as { __world: World }).__world = world;
