/**
 * Headless navigation test: POIs, routing round the loop, hysteresis, polylines, arrival.
 * Usage: npm run test:nav
 */
declare const process: { exit(code: number): never };
import { CAREER } from '../src/game/career/Career';
import { LEVELS } from '../src/game/missions/Levels';
import { ARRIVE_RADIUS, buildPois, planRoute, poiAt, routeHeading, routePolyline } from '../src/game/navigation/Navigation';
import { CROSSINGS } from '../src/game/world/Crossings';
import { Track } from '../src/game/world/Track';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const track = new Track();
const n = track.count;
const ds = track.length / n;
// The career event POIs exactly as the game builds them (Game.create).
const events = CAREER.map((e) => ({ id: `career-${e.id}`, title: e.level.title, detail: 'x', i: e.level.playerStart.i, off: Math.sign(e.level.playerStart.off || 1) * 7.9 }));
const pois = buildPois(track, LEVELS, events);

check('one POI per mission, the garage, the impound lot and each career event', pois.filter((p) => p.kind === 'mission').length === LEVELS.length && pois.filter((p) => p.kind === 'garage').length === 1 && pois.filter((p) => p.kind === 'event').length === CAREER.length && pois.filter((p) => p.kind === 'impound').length === 1, pois.map((p) => p.id).join(','));
const onPavement = pois.every((p) => {
  const k = track.nearestIndex(p.x, p.z);
  const lat = Math.abs((p.x - track.px[k]) * track.rx(k) + (p.z - track.pz[k]) * track.rz(k));
  const circ = Math.abs(((k - p.i + n / 2) % n + n) % n - n / 2);
  return lat > 7.35 && lat < 11.55 && circ <= 2;
});
check('every POI is on the pavement beside its own stretch of road (not on the carriageway)', onPavement);
const minGap = Math.min(...pois.flatMap((a, x) => pois.slice(x + 1).map((b) => Math.hypot(a.x - b.x, a.z - b.z))));
check('POIs are far enough apart to tell which one you arrived at', minGap > ARRIVE_RADIUS * 2, `closest pair ${minGap.toFixed(0)} m`);
const g = pois.find((p) => p.kind === 'garage')!;
check('garage is not on a pedestrian crossing', CROSSINGS.every((c) => Math.abs(((c - g.i + n / 2) % n + n) % n - n / 2) > 12));

// Routing
const a = planRoute(track, 100, 200);
const b = planRoute(track, 200, 100);
check('short hop forwards: route goes forwards', a.dir === 1 && a.steps === 100 && Math.abs(a.meters - 100 * ds) < 0.01, `${a.meters.toFixed(0)} m`);
check('short hop backwards: route goes backwards (no lap round the city)', b.dir === -1 && b.steps === 100);
const w = planRoute(track, n - 10, 15);
check('route wraps across the start/finish seam', w.dir === 1 && w.steps === 25, `steps ${w.steps}`);
const half = Math.floor(n / 2);
const h1 = planRoute(track, 0, half + 3, 1);
const h2 = planRoute(track, 0, half + 3, 0);
check('near the half-way point the previous direction is kept (no flip-flopping)', h2.dir === -1 && h1.dir === 1, `fresh ${h2.dir}, kept ${h1.dir}`);
const h3 = planRoute(track, 0, half + 80, 1);
check('...but switches when the other way is clearly shorter', h3.dir === -1);
check('route to where you stand is zero length', planRoute(track, 50, 50).meters === 0);
check('longest route is at most half the loop (+ hysteresis)', Math.max(...Array.from({ length: 60 }, (_, k) => planRoute(track, 0, Math.floor((k * n) / 60)).meters)) <= track.length / 2 + ds);

// Polyline
const out = new Float32Array(1200);
const from = 100;
const plan = planRoute(track, from, g.i);
const np = routePolyline(track, track.px[from], track.pz[from], from, plan, g, out);
let len = 0;
let maxJump = 0;
for (let k = 1; k < np; k++) {
  const d = Math.hypot(out[k * 2] - out[k * 2 - 2], out[k * 2 + 1] - out[k * 2 - 1]);
  len += d;
  maxJump = Math.max(maxJump, d);
}
check('route line starts at the player, ends at the POI, follows the road', Math.abs(out[0] - track.px[from]) < 1e-3 && Math.abs(out[(np - 1) * 2] - g.x) < 1e-3 && Math.abs(len - plan.meters) < plan.meters * 0.08 + 15 && maxJump < 16, `${np} points, line ${len.toFixed(0)} m vs road ${plan.meters.toFixed(0)} m, max segment ${maxJump.toFixed(1)} m`);
check('route line stays on the road (every interior point within the carriageway)', (() => {
  for (let k = 1; k < np - 1; k++) {
    const x = out[k * 2], z = out[k * 2 + 1];
    if (track.distanceTo(x, z) > 7.35) return false;
  }
  return true;
})());
check('polyline never overflows its buffer', routePolyline(track, 0, 0, 0, { dir: 1, steps: n - 1, meters: 0 }, g, new Float32Array(20)) === 10);

// Heading hint
check('heading hint: facing along the route → ahead, facing away → turn around', routeHeading(track, from, plan, track.tx[from] * plan.dir, track.tz[from] * plan.dir) === 'ahead' && routeHeading(track, from, plan, -track.tx[from] * plan.dir, -track.tz[from] * plan.dir) === 'behind');

// Arrival
check('arrival: inside the radius finds the POI, outside does not', poiAt(pois, g.x + 5, g.z)?.id === 'garage' && poiAt(pois, g.x + ARRIVE_RADIUS + 1, g.z) === null);

console.log(failures === 0 ? '\nALL NAVIGATION CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
