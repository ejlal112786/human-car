# City Racer

A browser 3D city game built with **Three.js**, **Rapier** (WASM physics), **TypeScript** and
**Vite**. You start on foot, walk to your car, get in and drive through five missions: finding
your ride, checkpoints, an obstacle course, a time trial and a street race against AI rivals.
The city is alive (traffic that obeys signals, pedestrians, police), and a seven-event career
pays credits for cars and upgrades in the garage.
It is a fully static site with no backend, so it can be deployed on Vercel or any static host.

## Features

- **On foot**: an animated 3D human (Quaternius "Animated Human", CC0) with Idle, Walk, Run and
  Jump clips blended by speed. Turning is procedural: the body rotates towards the movement
  direction. The model has **no dedicated turn or get-in/get-out animations**, so entering a car
  is a short scripted walk to the door followed by a fade.
  Movement uses a Rapier kinematic capsule controller. It climbs curbs automatically, snaps to the
  ground, collides with buildings, props and the car, and walking into cones pushes them.
  Movement is camera-relative, with a third-person orbit camera that avoids walls.
- **Vehicle interaction**: a "Get in" prompt appears only near a door. E (or the touch button)
  walks to the door, blends the camera to the chase view, starts the engine and hands control to
  the car physics. Getting out is only allowed when slow (< 8 km/h). The exit spot is picked from
  10 candidates around the car using ground, wall and capsule-overlap tests, so the character
  never ends up inside a wall or below ground. If every side is blocked, you stay in the car.
  The car keeps its position and state; you can get back in at any time. The character and car
  controllers never run at the same time (explicit, guarded state machine in `GameState.ts`).
- **Car**: the original Rapier ray-cast vehicle (rear-wheel drive, 6-speed automatic, aero,
  skid marks), chase camera, procedural engine/tyre/impact audio and tyre smoke particles.
  *Handling realism layer* (`CAR` in `src/game/config.ts`): road-tyre grip (sports cars ≈ 1.0 g, SUVs
  ≈ 0.8 g), little downforce, body roll from a roll moment of the tyre forces (2–7 °/g by vehicle), tyre
  load sensitivity and slower turn-in at speed; brake dive and acceleration squat come from the suspension.
  Measured per car with `scripts/tune/handling-probe.ts` (table in `docs/REALISM-UPDATE.md`).
  *Mechanical damage*: a damaged side bends the alignment (the car pulls to that side), a crushed nose
  cuts steering lock and engine power, bent panels add drag (lower top speed); the garage repair resets it.
  *Garage setup* (free, per car): tyre pressure, spring rate and brake bias, each with a measured effect.
  *Tyres*: per-wheel heat (grip window 35–105 °C) and wear; wear is saved per owned car and the garage
  sells new tyres. Braking and traction are limited by tyre grip, so surface and wetness change stopping
  distances. A drive-only HUD widget shows tyre temperature and wear.
- **Weather and surfaces** (free roam only; missions stay dry): clear, overcast, rain, storm and fog with
  smooth transitions (Settings → World → Weather: changing or fixed). Rain streaks, overcast sky, wet
  darker road, puddles that fill and dry, fog distance; wet grip (≈ 0.7 of dry), aquaplaning in puddles
  (depends on speed, tyre pressure and wear), grass and kerb grip, fog shortens police sight; rain and tyre
  spray audio. No day/night cycle, road bumps, dirt or ice (see `docs/REALISM-UPDATE.md`).
- **Pistol** (free roam, on foot): Quaternius Pistol_4 (CC0) with a moving slide and three-dot sights.
  Holding Aim looks down the sights (first-person hands and gun, zoom, breathing sway, slide lock on an
  empty magazine, ejected casings, gun tucks back near walls); Settings → Controls → Aim view switches to
  an over-the-shoulder aim instead.
- **Missions** (unlocked in order; best times and stars are saved in `localStorage`):

  | # | Mission | Gameplay | Fail condition |
  | --- | --- | --- | --- |
  | 1 | Find Your Ride | Walk to the parked car, drive to and stop inside a parking bay | – |
  | 2 | City Driving | 9 direction-aware checkpoints | 60 s time limit |
  | 3 | Obstacle Course | Slalom, narrow barrier passage, speed bumps, chicane, precision park; +2 s per knocked cone/barrel, +3 s per barrier hit, +5 s per missed slalom gate | 150 s, or 12 strikes |
  | 4 | Time Trial | Full lap, 14 ordered checkpoints, closed street with a detour | 125 s |
  | 5 | Street Race | 3 AI rivals after a countdown; you cannot leave the car mid-race | finishing anywhere but 1st |

  Results screens show the time, stars, penalties, race standings and rewards: the next mission
  unlocks, and star totals unlock car paints in the Garage. Every mission can be restarted from
  the pause menu or the results screen, and unlocked missions can be replayed.
- **Free Roam**: drive or walk around the city. Mission starts, career events and the garage
  are marked in the world (ring + icon) and on the maps; walk or drive up to one and press E.
- **Living city**
  - *Traffic*: cars follow a lane graph built from the road network, keep gaps, stop at the five
    signal-controlled crossings (green / yellow / all-red / walk cycle), yield to pedestrians,
    change lanes around blockages and never drive into the parked player car. Decisions run every
    4 ticks near the player and every 12 far away; cars are instanced (a few draw calls in total).
  - *Pedestrians*: animated people walk the pavements, keep right, cross only at crossings on
    WALK, dodge the player and cars, and never spawn on the road or inside buildings. Far
    pedestrians update at a third of the rate. The crowd is GPU-instanced: the four animation
    clips are baked into a bone-matrix texture and twelve outfit variants share one texture atlas.
    Skirt, ponytail, skateboard, helmet, apron, workwear and courier-pack details use bounded instanced
    meshes for women, skaters, riders, shopkeepers, mechanics and couriers. High quality now keeps up
    to 32 pedestrians active; the base crowd remains two instanced batches (near/far). People
    within 60 m who are between clips (starting, stopping, slow walking, speeding up to a run)
    get an exact blend instead — per-joint rotation slerp plus the bone hierarchy, solved on the
    CPU for up to 24 people (~0.2 ms) and read from a small dynamic pose texture — so limbs do
    not fold in the way a linear mix of baked matrices makes them.
  - *Police (prototype)*: one patrol car in free roam. Speeding, red lights, hitting cars or
    people and ramming police add heat; witnessed offences give 1–3 wanted stars with one pursuit
    unit per star. Break line of sight and stay unseen for 10 s to escape; being boxed in and
    stopped for 4 s is an arrest with a fine of 250 cr per star. No police in missions.
- **Garage** (title menu, or the garage marker in the city): eight distinct cars plus the Striker 900 sport motorcycle and Dune 650 dual-sport, with vehicle-specific mass, power, gearing, grip, brakes and engine sound. The bike
  has a bespoke two-wheel procedural model, rider silhouette, lean-in steering presentation and a narrow
  chassis tune; it uses the shared ray-cast vehicle solver for the driving loop. Vehicles unlock through
  credits and career stars. Upgrades, paint, live 3D preview and paid repairs are available as appropriate.
- **Prison escape** (after an arrest): a walled county-jail compound with collidable cells and crawlways,
  guard patrols and line-of-sight suspicion, sweeping security cameras, interactive doors, keycard,
  breaker, alarm, yard-time routines, bail and multiple escape routes. A fast cell-wall emergency cutoff
  disables cameras and releases the security locks for 180 seconds; a jail-only torch comes on in the dark.
  The escape loadout includes an easier semi-auto sidearm; hits briefly stop guards non-lethally.
  Settings → Driving & accessibility offers Guided support; guards and capture remain active.
- **Navigation**: a minimap with route line and markers, and a full city map (N) where any
  destination can be selected; a route is planned along the road and a beacon marks arrival.
- **Damage**: impacts above a small threshold dent the body in four zones (front / rear / left /
  right) and break individual head- and tail-lamps (damaged ones flicker). A crushed front
  costs up to 25 % engine power and smokes from the bonnet. Small knocks do nothing. Repairs cost credits in the garage.
- **Career** (title menu → Career, or the R markers in the city): seven events in three tiers
  (Rookie → Pro → Elite): sprints, time trials and races against rivals in their own catalogue
  cars and upgrades. Each event needs the previous one cleared and a total of career stars; it
  pays a first-clear reward, 30 % on replays and a bonus per new star. In races, 1★ is for
  qualifying, 2★ for also beating the target rival's time, 3★ for beating it by ≥ 2 %.
  Difficulty is checked by `npm run test:career`: AI drivers race every event in the real
  physics, and the test asserts a shrinking but human-sized margin over a perfect AI lap in the
  car a player can realistically own by then (Rookie: stock Kestrel ≥ 12 % → Pro: Kestrel L1
  ≥ 7 % → Elite: maxed Kestrel ≥ 5 % → Final: Vortex RS ≥ 7 %, maxed Kestrel ≥ 1.5 %), with the
  final out of reach in the stock starter car and every rival staying on the road. Progress, credits, cars and
  upgrades are saved with a backup copy; corrupt or missing saves fall back safely.
- **In-car view** (V, the HUD camera button or RB): driver's-eye camera in the left seat with a dashboard,
  live gauges, a steering wheel that turns with the steering, pillars and seats; the body top is cut away
  inside the cabin. The head lags with acceleration, braking and cornering, nods over bumps and picks up
  engine and road vibration (Settings → Camera motion: Full / Reduced / Off). Purely visual: the car drives
  exactly the same in both views. Engine, wind and rain sound muffled inside.
- **Audio** (all procedural Web Audio, no sound files): engine note per car (cylinders, pitch,
  rasp), turbo whistle with spool lag and blow-off on lift / upshift (Pip, Atlas, Ridgeback, Meridian),
  supercharger whine (Brute), gear-shift dips, tyre squeal, wind, impacts, doors, footsteps, horns, sirens, and city
  ambience: a distant-traffic bed, the nearest passing car (distance falloff + Doppler) and the
  ticking of crossing signals during WALK.
- **Menus**: title (Play / Continue, Missions, Career, Free Roam, Garage, Settings, Credits), loading
  screen, mission briefing, pause, results and failure screens.
- **Settings** (saved in `localStorage`):
  - master volume (scales every sound) and mute
  - graphics quality (Auto / Ultra / High / Medium / Low: pixel ratio, shadow-map resolution, particles; Ultra is demanding)
  - camera sensitivity, mouse sensitivity and touch sensitivity
  - HUD scale (also scales the touch controls)
  - control hints, FPS counter, and touch controls (Auto / On / Off)
  - driving feel (Arcade / Balanced / Realistic) and prison escape support (Standard / Guided)
  - car camera (Chase / In car), camera motion (Full / Reduced / Off), controller vibration (On / Off)
- **Mobile**: on-screen controls for phones and tablets in portrait and landscape:
  - On foot: a floating joystick with multitouch, a magnitude cap, return to neutral and cancel
    safety, plus Run and Jump. Drag on the right half of the screen to look around.
  - Driving: steer left/right, gas, brake/reverse, handbrake.
  - Shared: a context-sensitive Enter/Exit button and a pause button.

  Safe-area insets are respected, and page scrolling, pinch zoom and pull-to-refresh are disabled.
  Every touch releases its own input, and pause, blur or a layout switch releases everything.

## Controls

| | Keyboard / mouse | Touch |
| --- | --- | --- |
| Move / drive | WASD or arrow keys | Joystick (on foot) · steer pads + pedals (driving) |
| Run | Shift | Run (toggle) |
| Jump / handbrake | Space | Jump · Handbrake |
| Get in / out · use a marker (mission, career event, garage) | E (F also interacts) | Enter / Exit / Start / Garage button |
| Jail sidearm | 1 draw/holster · Q toggle aim (or hold right mouse) · Z fire (or left click) · R reload | Gun, Aim and Fire buttons |
| Jail torch | T toggles (auto-on when the cutoff kills the lights) | Auto-on at blackout |
| Look around | Drag with the mouse, wheel to zoom | Drag on the right half of the screen |
| Reset car | R | HUD reset button |
| Pause · Back in menus | Esc | HUD pause button · Back buttons |
| City map | N | HUD map button or tap the minimap |
| Sound on/off | M | HUD sound button |
| Camera: chase / in car | V | HUD camera button |

**Game controller** (standard mapping, Xbox / PlayStation layout; Chrome, Edge, Firefox): left stick move / steer,
RT / LT accelerate / brake-reverse (with the pistol out: fire / aim), A jump / handbrake, Y get in / out / use,
X reset car / reload, B crouch, LB pistol, RB camera view, L3 run, right stick look, View city map, Menu pause.
In menus the D-pad or left stick moves a visible focus ring, A selects, B goes back. The HUD hints switch to
controller buttons while the controller is the device in use. Rumble (where the browser supports it): kerbs,
grass, bumps, tyre slip, aquaplaning, impacts and gunshots; trigger rumble for wheelspin / brake lock on
controllers and browsers that support it. Settings → Controller → Vibration turns it off.

## Requirements

- Node.js **20.19+** (or 22.12+) and npm
- A browser with **WebGL 2** (current Chrome, Edge, Firefox, Safari)

## Local development

```bash
npm install
npm run dev        # http://localhost:5173/
```

## Production build

```bash
npm ci
npm run build      # tsc --noEmit → vite build → dist/ → release check (scripts/check-dist.mjs)
npm run preview    # serves dist/ at http://localhost:4173/
```

`npm run build` fails if the release check fails. The check verifies:

- `index.html`, every referenced chunk and the character model are present;
- asset URLs are relative, and there are no third-party runtime URLs, local paths, source maps
  or `.env` files;
- no development text (phase labels, placeholders, debug wording) appears in the game code;
- no automated-test code is included.

Expected output in `dist/` (hashes change between builds):

```
dist/index.html
dist/assets/index-<hash>.css
dist/assets/index-<hash>.js       ~225 kB  game code
dist/assets/character-<hash>.glb  ~565 kB  animated character (CC0)
dist/assets/three-<hash>.js       ~610 kB  Three.js
dist/assets/rapier-<hash>.js      ~4.2 MB  Rapier physics (WASM embedded, ~1.6 MB gzipped)
```

## Tests

```bash
npm run typecheck
npm run test:physics   # headless Rapier: vehicle dynamics, character controller, exit-spot search, obstacle stability
npm run test:weather   # headless: weather cycle, wet / grass / worn-tyre grip, stopping distances, aquaplaning, tyre heat
npm run test:setup     # headless: garage setup values change the measured handling
npm run test:campaign-sample  # ~5 min: samples the chaotic campaign checks (Hot Pursuit, rivals) from several states
```

Browser tests use Playwright, which is intentionally **not** a project dependency:

```bash
npm i --no-save playwright
npx playwright install --with-deps chromium
```

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm run test:browser -- <url>` | Full desktop gameplay suite: menus, on-foot movement / curbs / building collision, enter and exit, controls switching, all 5 missions (checkpoint direction, penalties, time-out, race placing), unlocks and saves, restarts, pause in every state, settings effects and persistence. | dev server or QA build |
| `npm run test:mobile -- <url>` | Emulated phone and tablet (portrait and landscape) with real CDP multi-touch: joystick + run + look at the same time, gas + steer, partial release, touchcancel, layout switching, overlap / size / scroll checks. | dev server or QA build |
| `npm run test:resources -- <url>` | GPU resources and JS heap stay flat across mission cycles; per-step allocation budget; no per-frame shader rebuilds. | dev server or QA build |
| `npm run test:release` | The real `dist/` served from a nested sub-path and played with real keys only. It walks to the car using the HUD mission clock, drives, gets out and back in, then pauses, restarts and quits. It also checks that the test hook is absent, that no request leaves the sub-path, and covers blur / hidden-tab auto-pause, WebGL context loss and restore, and the crash screen. | `npm run build` |
| `npm run test:weather-browser -- <url>` | Weather in the real game: storm / fog look values and screenshots, wet grip, grass, police sight in fog, HUD weather tag, missions stay dry, Settings → Weather click + persistence, tyre wear saved and surviving a reload, garage New tyres purchase, no console errors. | QA build |
| `npm run test:cockpit-browser -- <url> [--only=ui,physics,head,padmenu,pad,audio]` | In-car view: V / HUD toggle, camera at the driver eye point, body clipping, persistence, physics identical in both views, head lag under acceleration / braking / cornering, Camera motion Off / Reduced; game controller through a **simulated** Gamepad API (menus, driving, hints, rumble, Vibration Off, unplugging with the throttle held); turbo boost / blow-off and supercharger whine diagnostics. | QA build |
| `npm run test:parity` | Proves the release and QA builds contain identical game code apart from the test hook. | – |
| `npm run test:city -- <url> [--only=a,b]` | Living city, Phase 3 features: title backdrop, traffic, peds, WebGL context loss/restore (pixel-identical frame, no stale GL objects), garage (+ phone), nav (+ phone), damage, police, audio (including silence on a hidden page in menus, briefing and gameplay), career, two tabs sharing one save and settings (no lost purchases or settings). | QA build |
| `npm run test:layout -- <url>` | Every menu screen at 1280×720, 1024×768, 960×540, 844×390, 740×360 and 390×844: closing actions (Start / Back / Done) visible without scrolling, all other actions reachable. | QA build |
| `npm run test:monkey -- <url> [--seed=N] [--steps=N] [--touch]` | Seeded random player (clicks any visible button, presses / holds game keys; `--touch` plays as a phone with real multitouch and also checks for stuck touch input) with invariant checks after every action: no errors, no crash screen, finite positions above ground, state matches the screen, saves stay valid. | QA build |
| `npm run test:crowd` | Crowd pose blending on the real character asset: exact blends reproduce the baked frames and match three's AnimationMixer on every vertex (the old linear mix was off by up to 23% of body height); per-frame cost. | – |
| `npm run test:soak [-- minutes [startSample]]` | Long-session soak (headless): traffic + pedestrians + signals + physics while the player walks, drives laps and idles (default 60 simulated minutes, about 25 s). Checks NaN drift, overlaps, rule violations, gridlock, pedestrian clearance, population, flow degradation, pool / physics-body / heap growth. `SOAK_TRACE=from-to` (minutes) traces close calls. | – |
| `npm run test:traffic` / `test:peds` / `test:vehicles` / `test:progress` / `test:nav` / `test:damage` / `test:police` / `test:career` | Headless logic + physics suites (no browser) for each Phase 3 system; `test:career -- --tune` prints AI event timings. | – |
| `node scripts/perf-profile.mjs <url>` | CPU profile of free roam (top self-time functions + draw calls). | QA build |

QA build: `npm run build:qa && npm run preview:qa` → `http://localhost:4174/`.

### The automated-test hook

`window.__cityRacer` (state snapshot, frame-rate-independent stepping, teleports, level
selection) exists **only** in the dev server and the QA build (`dist-qa/`). It is controlled by the
compile-time constant `__QA_HOOK__`, is stripped from the release build, and `check-dist.mjs`
enforces this. **Never upload `dist-qa/`.**

## Deploying with Vercel Drop

The game is a static site: no backend, server functions, environment variables or secrets.

1. Run `npm ci` then `npm run build`; the output must end with `DIST CHECK PASSED (release build)`.
2. Open <https://vercel.com/drop> while signed in to Vercel.
3. Drag the **`dist` folder** onto the page. Do not upload the project folder or `dist-qa`.
   A `.zip` also works if `index.html` is at its top level.
4. Pick a team and project name, then select **Deploy**.

The build uses relative asset URLs (`base: './'`), so it also works from a sub-path or any static
host over HTTPS. For a Git-based deploy, Vercel auto-detects Vite (`npm run build`, output `dist`).

## Project structure

```
src/
  main.ts                      Bootstrap, WebGL 2 check, fatal error screen
  assets/character.glb         Quaternius Animated Human (CC0)
  game/
    Game.ts                    Integration: fixed-step loop, mode switching, level flow, test hook
    GameState.ts               Explicit state machine with guarded transitions
    VehicleInteraction.ts      Door detection, enter/exit rules, safe exit-spot search
    InputManager.ts            Keyboard + touch → one control state (no stuck keys)
    LookInput.ts               Mouse / touch camera drag
    Settings.ts                Persisted settings and quality presets
    CameraRig.ts               Showcase / vehicle / character camera blending
    Particles.ts               Tyre smoke, impact sparks, checkpoint sparkle (Points)
    AudioEngine.ts             Procedural WebAudio (engine, skids, impacts, footsteps, UI, missions)
    character/
      CharacterController.ts   Rapier kinematic capsule (curbs, slopes, jump, collisions)
      CharacterModel.ts        GLB loading, animation mixer, speed-based blending, footsteps
      CharacterCamera.ts       Third-person orbit camera with wall avoidance
    missions/
      Levels.ts                Mission definitions (start, route, gates, obstacles, limits, rewards)
      MissionManager.ts        Objectives, clock, gates, penalties, parking, race standings
      ObstacleManager.ts       Pooled, instanced cones/barrels/barriers/roadblocks/bumps + reset
      MissionVisuals.ts        Checkpoint gates, arrows, parking bay
      RaceAI.ts                AI opponents: racing line, speed profile, following and overtaking
      Progress.ts              Unlocks, best times, stars, paints (localStorage)
    city/CityLife.ts           Owns traffic, signals and pedestrians for the current mode
    traffic/                   Lane graph, signals, traffic AI, instanced traffic models
    pedestrians/               Pedestrian AI (pavement paths, crossings, avoidance) + renderer
    police/                    Wanted level, pursuit units, police system
    vehicles/                  Car catalogue (handling, prices, upgrades) and garage rules
    navigation/                Points of interest, route planning, world markers
    damage/DamageModel.ts      Collision → zone damage, lamps, power loss, repair cost
    career/Career.ts           Career events, unlock rules, rewards
    TyreModel.ts               Per-wheel tyre temperature, wear and their grip factor
    world/Weather.ts           Weather states, transitions, wetness and puddle fill (fixed step)
    world/Surface.ts           Road / pavement / grass grip, wetness and puddle depth under each wheel
    world/WeatherView.ts       Rain streaks, puddle meshes, wet-material look
    Vehicle.ts, VehiclePhysics.ts, Drivetrain.ts, CarModel.ts, FollowCamera.ts, SkidMarks.ts,
    PhysicsWorld.ts, SceneManager.ts, Environment.ts, config.ts, world/ (city, roads, props)
  ui/
    Menu.ts, HUD.ts, Minimap.ts, CityMap.ts, TouchControls.ts
  styles/main.css
scripts/
  physics-test.ts, weather-test.ts, setup-test.ts, browser-qa.mjs, mobile-qa.mjs, weather-qa.mjs,
  setup-qa.mjs, ads-qa.mjs, campaign-sample.sh, resource-audit.mjs,
  release-smoke.mjs, build-parity.mjs, check-dist.mjs
```

## Credits and licences

- Character: "Animated Human" by Quaternius, **CC0 1.0** (opengameart.org/content/animated-human-low-poly)
- Pistol: "Ultimate Gun Pack" (Pistol_4) by Quaternius, **CC0 1.0** (opengameart.org/content/low-poly-guns-pack); source OBJ in `assets-src/`, converted by `scripts/gen-pistol.py`
- three.js (MIT), Rapier (Apache-2.0)
- All other geometry, textures and sounds are generated procedurally at runtime (incl. the first-person gloves / sleeves).

## Known limitations

- All testing ran in headless Chromium with software rendering (SwiftShader) and emulated touch.
  Not yet tested on real hardware:
  - frame rates on real GPUs and phones;
  - iOS Safari and Android Chrome on real devices (notch insets, audio unlock, multitouch);
  - haptics.
- Character animation is limited to the four clips in the CC0 model. Turning, getting in and
  getting out are procedural (rotation and fade), not motion-captured. Both bikes are first-pass
  rideable vehicles using the shared ray-cast solver with closely paired wheel rays; their visual
  lean is presentational, not a full rider/bike balance simulation, and there is no dedicated riding
  animation or helmet equipment system.
- AI rivals drive the same vehicle physics as the player (so they collide with the player, each
  other and props). They follow a racing line with a curvature-based speed profile, slow down
  for the construction zone, keep a gap to the car ahead (including the player) and overtake it
  one lane to the left on straights when that side is clear, then pull over to the right after
  finishing. Corner and braking speeds are planned from each car's own tyre grip and brakes
  (so a Vortex rival really is faster in the bends and a Brute brakes earlier), and a simple
  driver aid counter-steers and eases off the power or brakes when the car starts to slide.
  There is no blocking, rubber-banding or tactical racecraft, and a rival that gets stuck or
  flips is put back on the track after a few seconds.
- The Rapier package embeds its WASM in JS (~4.2 MB raw, ~1.6 MB gzipped), which dominates load time.
- Career difficulty (time limits, star times, rival pace) was calibrated from AI drives in the
  real physics, scaled by the same ratios as the shipped missions. It has **not** been
  play-tested by humans; the final events may feel too hard or too easy.
- Traffic, pedestrians and police are intentionally bounded prototypes: one loop road with five
  crossings, no junction turning, no parked-car spawning, no police roadblocks or helicopters.
  Pedestrians are not physically simulated; hits are detected and they stumble away.
- There is no day/night cycle; lighting is a fixed afternoon sun with shadows.
- Game controllers were tested only with a simulated Gamepad API object in headless Chromium: no physical
  controller, steering wheel or rumble motor has been tried. Steering wheels work only as far as the browser
  maps them to axes; there is no force-feedback torque (browsers have no API for it).
- The in-car view is a simple procedural dashboard (wheel, gauges, pillars, seats): no hands on the wheel, no
  mirrors, no windscreen rain or wipers.
- Ambient audio was verified through Web Audio diagnostics in headless Chromium, not by ear on
  real speakers.
