# Realism, weapons, police, prisons and rescue update: feasibility and plan

Written after inspecting the code at c7c54b6 and measuring the current car physics (headless Rapier).
Each item is classed as **CAN** (build it for real and test it), **PARTLY** (part can be built
honestly, part can't), or **CANNOT** (not possible here or in a browser game, with the reason).

## What exists today (measured or read from the code)

| Area | Current state |
|---|---|
| Car physics | Rapier ray-cast vehicle, 1350 kg, fixed 60 Hz step, 6-speed gearbox with torque curve, drag, downforce, rolling resistance, speed-dependent steering limit, handbrake / drift grip |
| Suspension | Real spring/damper per wheel. Measured: squat 0.9° under full throttle, dive 1.3° under full braking, **body roll 0.4° at 1.28 g**, so roll is effectively invisible |
| Grip | 1.05 g at 40 km/h rising to 1.21–1.28 g at 130–150 km/h (downforce). The car corners hard at any speed; there's no need to brake before corners |
| Tyres | No heat, no wear, no surface types (one friction value everywhere) |
| Damage | 4 body zones + 4 lamps; visual dents (body vertices pushed in per zone with a crumple pattern), broken / flickering lamps, smoke; mechanical effect = up to −25 % engine power only, no steering / alignment effect |
| World | Completely flat city (every system — roads, traffic, pedestrians, police, missions — assumes ground height 0); no weather; fixed daytime sun; distance fog only |
| Audio | Procedural engine (RPM + throttle, per-car profile), gear-shift dips, tyre skid noise, wind from speed, impacts, siren. No turbo |
| Camera | Chase camera with speed FOV, damped vertical pivot, shake on impacts. No cockpit / bumper view |
| Input | Keyboard, mouse, touch. **No gamepad support at all** |
| Tuning | 4 upgrade levels each for engine / tyres / brakes / suspension (buy-only, no sliders) |
| Weapon | One procedural pistol mesh (boxes), over-the-shoulder aim (closer camera, narrower FOV), no sights |
| Police | 3 pooled cars + 1 roadblock car, 4 officers, no stations; 1 jail |
| Missions | 15 campaign missions, 7 career events; no rescue type |

## Requested items

### Weapons
| Item | Verdict | What will be done / why not |
|---|---|---|
| Realistic gun | **CAN** | Replace the box pistol with a real modelled pistol: Quaternius "Ultimate Gun Pack" Pistol_4 (CC0 public domain, verified on OpenGameArt and the author's itch.io page), bundled locally. Slide, frame, sights, trigger guard. Low-poly flat-shaded style (matches the game); not a photoreal scanned gun. |
| ADS (aim down sights) | **CAN** | Hold right mouse / touch Aim: camera moves to the eye position behind the rear sight, the front and rear sights line up on the crosshair point, FOV zooms in, spread tightens, weapon sway / breathing, slide recoil + camera kick, ejected casings, magazine drop on reload. Hip-fire stays available. |

### "Make everything real like 3D"
| Item | Verdict | Notes |
|---|---|---|
| The game is 3D | already | Every object is a real 3D mesh with physics. |
| Photorealism | **CANNOT** | Photoreal needs scanned / hand-textured high-poly assets, baked lighting and GPU budgets far above what this browser game (low-poly style, mobile target, software-rendered test machine) can use. Swapping the art style would mean rebuilding every asset. |
| More realistic look within the style | **PARTLY** | Possible: procedural normal / roughness detail on roads and buildings, wet-road reflections in rain, time-of-day lighting, optional post-processing (bloom / ambient occlusion) behind the quality setting. Can't be measured for GPU speed here (software GL only). |

### Police, stations, prisons
| Item | Verdict | Notes |
|---|---|---|
| More police | **CAN** | Larger pool scaling with the wanted level (up to 6 pursuit cars + roadblocks, 8 officers), same no-teleport spawn rules, with a performance check. |
| Police stations | **CAN** | Station buildings placed in the city (map markers), units dispatched from and returning to the nearest station by road, arrested player taken to the nearest station before the transfer. |
| Prisons | **CAN** (large) | A second facility ("State Prison") with its own layout, guards and escape routes, used for 3★ arrests; the county jail stays for 1–2★. |

### Rescue missions
| Item | Verdict | Notes |
|---|---|---|
| Rescue missions | **CAN** | New free-roam mission type with a hospital: (1) drive an injured / stranded person (non-graphic) to the hospital before the timer, where hard hits and rough driving lower their condition; (2) a crashed car with a trapped driver: pry the door (hold interact), help them out, take them to the hospital. Rewards through the existing progress system (no duplicate rewards). |

### Physics and handling
| Item | Verdict | Notes |
|---|---|---|
| Weight and momentum | **CAN** | Tyre load sensitivity + less grip growth with speed + slower steering at speed, so the car runs wide at 100+ km/h unless you brake first. Before / after numbers in the headless physics test (the fixed timestep and existing tests stay). |
| Suspension (roll, dive, squat) | **CAN** | Visible body roll / pitch: softer roll stiffness in the physics within safe limits (rollover check), plus body-on-chassis motion of the car model driven by the measured accelerations. |
| Tyre grip on wet / dirt / ice | **PARTLY** | Wet: CAN (rain lowers grip, measured). Dirt: only where the city has unpaved ground (park paths, a gravel lot), as the city has no dirt roads. Ice: no winter setting exists; could be a "freezing" weather state with ice patches, which is lower priority. |
| Tyre heat and wear | **CAN** | Heat from slip and load, optimum window, wear over distance and abuse; grip follows both; HUD tyre indicator; garage / repair renews tyres. |
| Damage model | **CAN** | Hits bend the alignment (car pulls to one side), reduce steering lock and top speed by zone; the existing visual dents / lamps / smoke stay (vertex dents, not a soft-body simulation). |

### Environment and world
| Item | Verdict | Notes |
|---|---|---|
| Bumps, cracks, rough patches | **PARTLY** | CAN: real low colliders (speed bumps, manhole covers, expansion joints, patched / broken tarmac strips) that the suspension feels, plus crack / patch decals. |
| Elevation changes and camber | **CANNOT** (city-wide) | The whole city, traffic, pedestrians, police and missions are built on flat ground at height 0. Hills or cambered roads would mean rebuilding the road network and every system that moves on it. |
| Dynamic weather | **CAN** | Rain (particles + wet road look + less grip), puddles with hydroplaning (grip loss above a speed, real physics effect), fog that limits visibility, changing light (time of day). Grip effects measured in the headless test before being claimed. |
| Authentic audio | **PARTLY** | RPM / gear shifts / tyre screech / wind already exist and follow the car. CAN add turbo spool + blow-off for turbo cars, rain and surface noise. These are synthesised (Web Audio), not recordings of real cars. |

### Controls and immersion
| Item | Verdict | Notes |
|---|---|---|
| Gamepad support | **CAN** | Standard Gamepad API mapping (Xbox / PlayStation layout) for driving and on foot. **Can't be tested here** (no controller attached); only the code path with a simulated gamepad object can be tested. |
| Controller rumble | **PARTLY** | Chrome / Edge expose dual-rumble on Xbox / PS controllers: kerb, impact, grip-loss and gunfire rumble can be added. Untestable here, and not available in every browser (Safari / Firefox support varies). |
| Steering-wheel force feedback (torque) | **CANNOT** | Browsers have no API for wheel force feedback (the Gamepad API only offers rumble; WebHID would need per-device drivers). Real wheel FFB needs a native game. |
| Dynamic cockpit camera | **CAN** | New camera modes (chase / bumper / cockpit) with g-force lag, engine vibration and road-impact shake. The cockpit is a simple procedural dashboard + steering wheel, not a detailed modelled interior. |
| Realistic tuning | **CAN** | Garage sliders: tyre pressure, final drive / gear spacing, spring stiffness, damping, brake bias, saved per car, each with a measured effect in the headless physics test. |

## Not testable here (will be reported as untested, not as working)
* Physical gamepads, controller rumble, steering wheels.
* Real phones / tablets (only emulated touch in a desktop browser).
* GPU frame rates (the machine only has software rendering).

## Build order (each stage built, tested, committed before the next)
1. Real pistol model + ADS.
2. Handling: weight / momentum, suspension roll / pitch, mechanical damage effects, garage tuning.
3. Tyre heat / wear, surfaces, weather (rain, puddles, fog, time of day), road bumps. *(Done except time of day and bumps — see Stage 3.)*
4. Turbo audio, cockpit camera, gamepad + rumble. *(Done — see Stage 4; no bumper camera, no wheel force feedback.)*
5. More police + police stations.
6. Second prison.
7. Rescue missions + hospital.
8. Visual pass within the art style (quality-gated).

## Progress

### Stage 1 — real pistol + aim down sights (done)
* **Model**: Quaternius "Ultimate Gun Pack" Pistol_4 (CC0), converted by `scripts/gen-pistol.py` into
  `src/game/crime/pistolModel.ts` (1320 triangles, 18.8 cm long, frame and slide as separate parts).
  Replaces the old box pistol in the hand / holster. White three-dot sights added.
* **Aim down sights** (Settings → Controls → Aim view: *Down sights* (default) / *Over shoulder*):
  holding Aim moves the camera from the shoulder to the eye (1.62 m, lower when crouched) in ~0.2 s,
  FOV 60° → 40°, look sensitivity × 0.55 while zoomed, HUD crosshair hidden (the sights are the reticle).
  The body is drawn only into the shadow map (the player keeps a shadow); a first-person copy of the
  pistol in gloved hands is placed so the rear and front sights lie on the view axis (measured 0.00 mm off).
* Spread down the sights 0.0025 rad (shoulder 0.006, hip 0.05); recoil opens it 40 % less.
* Breathing sway (figure of eight, ±0.0016 rad standing, half crouched, more when moving); the shot follows
  the sway because it leaves along the camera axis.
* Recoil: gun kicks back and up, camera kick; slide cycles back 28 mm and returns within 90 ms (fixed-step
  clock), locks back when the magazine is empty, goes forward after the reload.
* Spent brass ejected to the right, bounces and lies for 5 s (16-casing pool, one instanced mesh).
* Reload drops back to the shoulder view (the reload is animated in third person), then returns to the sights.
* Wall tuck: something closer than 0.62 m in front pulls the gun back to low ready; the shot ray starts at
  the eye, so it can't begin beyond a wall the player is pressed against (measured: hit at 0.28 m).
* Not done: no animated hand / finger movement (the gloves are fixed shapes), no reload animation in the
  sights view, one pistol only.
* Tests: `scripts/ads-qa.mjs` (browser, real mouse input) 20/20; crime-qa 44/44 (one check changed: the
  first shot may now hit a pedestrian walking right in front, because the ray starts at the eye, so the check
  is "hit point ahead of the camera" instead of "beyond 8 m"); crime-test (headless) new pistol / ADS checks pass.
  police-qa 25/25 on the Stage 1 build.

### Stage 2 — weight, grip, suspension, mechanical damage (done; tuning sliders not yet)
Five parameters in `CAR` (`src/game/config.ts`), inherited by every vehicle, applied in `VehiclePhysics.ts`:

| Parameter | Value | What it does |
|---|---|---|
| `tyreMu` | 0.82 | road-tyre friction: every tyre's limit × 0.82 |
| `aeroScale` | 0.3 | road cars make little downforce: the old downforce × 0.3 |
| `rollArm` | 0.4 m | roll moment of the tyre forces about the centre of mass (Rapier's ray-cast vehicle has no roll lever) → real body roll and load transfer |
| `loadSensitivity` | 0.15 | a tyre carrying more than its share grips proportionally less (so load transfer costs grip, like real tyres) |
| `steerRateFalloff` | 50 m/s | how fast the wheels can be turned in falls with speed (÷1.6 at 108 km/h): heavier, slower turn-in at speed |

Per-wheel friction is now `tyre value × tyreMu × load factor × gripScale`; `gripScale[4]` is the hook for
surfaces, tyre wear and rain (Stage 3). Measured with `scripts/tune/handling-probe.ts` (headless, fixed step):

| Car | max lateral g @100 km/h before → after | body roll °/g before → after | brake dive ° | 0–100 / 100–0 |
|---|---|---|---|---|
| Kestrel GT (sports) | 1.27 → 0.99 | 0.30 → 2.78 | 1.39 | unchanged 4.4 s / 35.8 m |
| Meridian (sedan) | 1.16 → 0.89 | 0.46 → 4.34 | 1.71 | unchanged |
| Pip (hatch) | 1.35 → 1.02 | 0.31 → 2.79 | 1.43 | unchanged |
| Atlas (SUV) | 1.11 → 0.87 | 0.91 → 5.89 | 3.31 | unchanged |
| Ridgeback (off-road) | 1.01 → 0.80 | 1.07 → 6.80 | 3.66 | unchanged |
| Brute (muscle) | 1.13 → 0.90 | 0.40 → 3.59 | 1.59 | unchanged |
| Vortex (super) | 1.58 → 1.19 | 0.21 → 2.13 | 1.39 | unchanged |
| Apex (track) | 1.84 → 1.33 | 0.10 → 1.33 | 0.89 | unchanged |

Real-world reference: road sports cars ≈ 0.95–1.0 g, sedans ≈ 0.85–0.9, SUVs ≈ 0.75–0.85; roll 2–3 °/g for
sports cars, 4–7 for sedans / SUVs. No vehicle rolls over (full lock at 120 km/h and a 110 km/h slalom:
min up.y ≥ 0.994). Squat under acceleration was already present (0.9–3°) and is unchanged.

Consequences, measured and handled:
* Corner speeds are ~12 % lower (√ of the grip), so the player must brake earlier. The rival AI plans corners
  with `GRIP = 9.5 × 0.98 / 1.25` (same safety margin as before) and its per-car grip index now includes
  tyreMu and aeroScale.
* Two career times were re-set because laps really are slower: Grand Loop limit 98 → 104 s (≥ 1.4× the AI
  Kestrel lap of 73.0 s), City Championship stars 66.5 / 67.8 → 68.5 / 71.5 s (the old 3★ time was faster than
  the ideal best-car lap of 66.6 s, i.e. unreachable).
* Less trail-brake rotation (extra yaw 0.175 → 0.058 rad/s): the extra load transfer keeps the rear planted
  when braking into a corner. Handbrake drifting still works but needs a faster entry and a longer pull; the
  scripted drift driver in campaign-test was retuned (entry 15 → 18 m/s, kick 0.35 → 0.7 s) and scores 2,326
  (3★) against 1,013 before. That scripted driver was a single tuned point before and still is.
* `steerRateFalloff` 35 was tried first; it made a rival ram the parked player car in one race check; 50
  passes every campaign check, 70 broke four. The value is the tested one, not a guess.

Tests: all 14 headless suites pass (campaign 71, career all, physics 56, vehicles 28, police 60, traffic 22,
soak 12, damage 14, jail 69, crime 45, nav 16, ped 19, progress 55, crowd 9).

**Mechanical damage** (`damageEffects` in `src/game/damage/DamageModel.ts` → `Vehicle.applyDamageEffects` →
`VehiclePhysics`), on top of the existing engine-power loss and the visual dents / broken lamps:
* Bent alignment: a damaged left / right side adds a constant front-wheel angle towards that side (max
  0.012 rad ≈ 0.7°). Measured hands off at 100 km/h for 3 s: straight car 0.0°, fully damaged side 21°.
* Crushed nose: up to 30 % less steering lock (full lock at 30 km/h: yaw rate 0.95 → 0.81 rad/s).
* Bent / torn panels: up to 35 % more drag; with the power loss, a wrecked nose reaches 163 km/h after
  14 s flat out instead of 194.
* Repair (garage) resets all of it. Applies to every car that uses `Vehicle` (player, rivals, police).
* damage-test: 6 new checks, 20/20.
* Not modelled: individual broken parts (a wheel falling off, a punctured tyre), damage to the gearbox.

**Garage setup** (free, per car, saved; Garage → Setup; applied in `tuningFor`, used everywhere the car is driven):

| Setting | Range | Measured effect (Kestrel, `scripts/setup-test.ts`) |
|---|---|---|
| Tyre pressure | 1.90 – 2.50 bar | max lateral g 0.998 (low) / 0.957 / 0.915 (high); 40 km/h coast for 5 s loses 14.8 vs 13.9 km/h (rolling drag) |
| Springs | 70 – 130 % rate (dampers follow √rate) | body roll 3.99 / 2.70 / 2.02 °/g; brake dive 1.72° (soft) → 1.05° (stiff) |
| Brake bias | 49 – 73 % front | trail-braking rotation 0.082 (rear) / 0.072 / 0.063 (front) rad/s extra yaw; straight-line stops unchanged (35.8 m: grip-limited) |

Tried and **left out, honestly**:
* *Gear ratios*: final drive ±24 % changed 80–160 km/h and top speed by only a few per cent and not consistently
  (the automatic gearbox shifts at a fixed rpm, and every car is drag-limited below its rev limiter), so a
  slider would not "actually change the driving". Gear ratios would need a manual gearbox / shift-point model.
* *Tyre pressure → steering sharpness*: raising the tyre side stiffness in Rapier's model made the response
  slightly slower, not sharper, so pressure only changes grip and rolling drag (and tyre heat in Stage 3).

Tests: setup-test 10/10 (headless); `scripts/setup-qa.mjs` 10/10 in the browser (real clicks on −/+: value
shown, save, physics of the car, range limits, survives a reload, "Factory setup" resets, costs nothing).

### Stage 3 — tyres, surfaces, weather (done; time of day, bumps, dirt and ice not built)

**Tyre heat and wear** (`src/game/TyreModel.ts`, per wheel, every car that uses `Vehicle`):
* Tyres heat from slip work and cool towards the air temperature (which follows the weather). Best grip
  between 35 and 105 °C; cold tyres lose a little grip, overheated tyres lose more (Kestrel sliding for 15 s:
  160 °C, grip ×0.85, 4.7 % tread gone).
* Wear removes grip slowly in the dry and a lot in the wet (less tread to clear water). Worn wet stop from
  100 km/h: 65.1 m against 46.9 m on new tyres.
* The player's wear is saved per owned car (every 10 s, on leaving the car and on garage actions), survives a
  reload, and the garage shows "Tyres N% worn" from 5 % with a **New tyres** button (Kestrel 400 cr; price
  scales with the car and its tyre upgrade). A borrowed / stolen car has fresh tyres. Rivals and police
  always start on fresh tyres. Missions reset tyre temperature and do not wear the saved set.
* A drive-only HUD widget shows the four tyres (blue cold / green ok / amber hot / red overheated) and wear.

**Surfaces** (`src/game/world/Surface.ts`): road, pavement (kerb / sidewalk, 0.95 grip) and grass (0.55 grip, 5×
rolling drag). Wetness removes 28 % of asphalt grip, 32 % of pavement grip and 25 % of grass grip. Measured
with the Kestrel: lateral 0.94 g dry / 0.70 g wet / 0.54 g on grass; 0–60 km/h 2.43 s dry, 2.72 s wet,
4.32 s on grass; 100–0 km/h 37.8 m dry, 46.9 m wet, 54.8 m on grass.

**Brakes and traction are now grip-limited.** Before this stage Rapier applied brake and engine forces
without any friction limit, so wet roads would not have changed stopping distances. Brake force is now capped
by the tyre's longitudinal grip × load, and drive force by a traction cap that only engages when the tyre is
actually overloaded (so dry 0–100 times are unchanged for all eight cars). Side effects, measured:
* Dry 100–0 got longer where the old value was physically impossible: Kestrel 35.8 → 37.8 m, Pip 32.6 → 37.4 m,
  Brute 43.7 → 45.0 m, Apex 19.1 → 26.0 m (19 m would be 2 g of braking on road tyres).
* Brake upgrades now add grip as well as force (L0–L3 Kestrel: 37.8 / 35.2 / 33.1 / 31.8 m) so they still help.
* Brake bias now changes straight-line stops (it did not in Stage 2): rear-biased 41.4 m, factory 37.5 m,
  front-biased 37.6 m.
* Rival braking points are planned from the same grip cap.

**Aquaplaning**: puddles (standing water) on the road lift the tyre at speed — none at 50 km/h, full at
120 km/h. Tyre pressure and wear matter: at 95 km/h, low pressure 0.75 vs high 0.16; new tread 0.45 vs worn 1.0.

**Weather** (`src/game/world/Weather.ts`): clear, overcast, rain, storm and fog, with smooth transitions.
"Changing" (default) starts clear and changes every few minutes; Settings → World → Weather can fix any
state. The sequence is random per session (QA builds use a fixed seed). After rain starts, the road is soaked
in about 74 s and puddles fill; it takes about 4 minutes of dry weather to dry again.
* **Visuals** (`src/game/world/WeatherView.ts`, `SceneManager.setWeatherLook`): falling rain streaks
  (6,000 / 3,500 / 1,600 drops by quality level), an overcast cloud layer, a greyer reflection map, weaker sun,
  wet darker and glossier road, pavement and kerbs, puddles that fill and dry, fog distance down to ~100 m.
* **Gameplay**: wet grip, aquaplaning, fog cuts police sight (150 m × visibility: 0.63 in a storm,
  0.30 in thick fog) and makes roadblocks harder to see. The HUD location tag shows the weather and road state
  ("Heavy rain · standing water").
* **Audio**: rain noise (muffled inside the car), tyre spray that rises with speed on a wet road, quieter tyre
  squeal in the wet.
* **Free roam only**: missions and races always run in the dry on a plain road so their times, stars and
  rival tests stay fair and comparable. This is a design decision, not a limitation of the code.

**Not built in this stage, honestly:**
* *Time of day*: no day/night cycle; the lighting changes only with weather.
* *Road bumps, cracks, elevation and camber*: the city is flat and the road surface is smooth. Rapier
  wheels on a flat collider; a bump field would need a heightfield road and a re-test of every handling value.
* *Dirt and ice*: there is no dirt road or ice in the city; grass is the only loose surface.
* *Rain on the windscreen / wipers*: there is no cockpit view yet (Stage 4).
* *GPU cost of the rain*: visuals were checked in SwiftShader screenshots only; frame
  rate on a real GPU or phone with 6,000 drops is not measured (Low quality uses 1,600).

**Campaign check (`scripts/campaign-test.ts`)**: 68/71 in the fixed order. The three failures (Hot Pursuit
"Time's up", a rival stuck, a parked car moved 132 m in the Circuit Championship) come from state carried over
from earlier missions in one long run (the order is chaotic: tiny changes anywhere move these outcomes). Each
passes when run alone. `scripts/campaign-sample.sh` samples them with different starting states: Hot Pursuit
escapes 14/15 (3/15 before Stage 3), rivals 53 finish / 13 stuck (55 / 11 before) — within noise.

Tests: weather-test 35/35, progress 63/63 (8 new: tyre-wear save sanitising, new-tyre rules, price, weather
setting), setup-test 11/11; all other headless suites unchanged.
Browser (SwiftShader, desktop Chromium; Playwright): `scripts/weather-qa.mjs` 18/18, setup-qa 10/10, release
smoke 43/43, mobile (emulated) 85/85, browser-qa 115/115, police-qa 25/25, crime-qa 44/44, arrest-qa 79/79;
build parity passed (the weather seed is random per session in both builds; only the QA test hook reseeds it).
Not tested: frame rate on a real GPU or phone, real touch devices.

### Stage 4 — in-car camera, game controller + rumble, turbo audio (done)

**In-car view** (`src/game/CockpitView.ts`; V, the HUD camera button or controller RB; Settings → Controls → Car camera):
* Driver's eye in the left seat (the cars are left-hand drive, matching the door you get in by). A procedural
  interior is fitted to each of the eight body styles: dashboard, an instrument cluster with live speed / rpm /
  gear (a small canvas redrawn at most 12 times a second), a three-spoke steering wheel that turns with the
  steering input, pillars, headliner, door panels, seats, centre console and gear lever. The body top inside the
  cabin is cut away with clip planes on the paint material only, so the outside of the car is unchanged.
  The low race car gets a smaller wheel so the rim stays under the eye line. Screenshots of all eight were checked.
* Used only while driving; on foot, in menus and during the get-in / get-out transitions the normal cameras
  are used. The choice is saved.
* **Head motion** (Settings → Camera motion: Full / Reduced / Off): the chassis acceleration is sampled on the
  fixed physics step and drives a damped neck spring (integrated in substeps, so it behaves the same at 10 fps
  and 144 fps). Measured in the browser with the Kestrel: full throttle 7.1 m/s² → head back 4.1 cm; braking
  10.3 m/s² → head forward 5.9 cm; left turn 8.3 m/s² → head 3.9 cm to the right. Reduced 2.6 cm (Full 5.9 cm);
  Off exactly 0 (the head is fixed to the seat; the chassis' own pitch and roll from Stage 2 remain). On top
  of that: a small head tilt against the side force and nod under braking, engine vibration from rpm and
  throttle, road texture by surface and speed, suspension-hit jolts, collision kicks, and a slight look
  towards the apex. Mouse / touch / right stick look around in the car and spring back after release.
* **Visual only**: the same inputs give bit-identical results in both views (browser test: Δposition 0 m,
  Δspeed 0 m/s, with a chase-vs-chase control run that also matched exactly).
* Inside the car the engine loses some treble and gains some body boom, and wind and rain are quieter.

**Game controller** (`src/game/GamepadInput.ts`, standard Gamepad API mapping):
* Driving and on foot: left stick move / steer (progressive near centre), RT / LT throttle / brake-reverse
  (analogue), A handbrake / jump, Y get in / out / use, X reset car / reload, B crouch, LB pistol, RB camera view,
  L3 run, right stick look, View map, Menu pause. With the pistol out RT fires and LT aims.
* Menus: D-pad or left stick moves a visible focus ring between the buttons of the current screen, A presses,
  B does exactly what Escape does on that screen (back / resume / close). Mouse use hides the ring again.
* HUD hints and prompts switch to controller buttons while the controller is the last device used, and back
  to keyboard keys when the keyboard is used. Settings → Controller shows the connected controller's name.
* Unplugging the controller releases every input it was holding (tested with full throttle held: the car coasts).
* **Rumble** (Chrome / Edge `vibrationActuator`): strong motor for suspension hits, kerbs and grass; weak motor
  for tyre slip, grass, kerbs and aquaplaning; impact and gunshot jolts; trigger rumble for wheelspin (right) and
  brake lock (left) where the browser and controller support it. Silent when not driving, paused, or with
  Settings → Controller → Vibration off.

**Turbo and supercharger audio** (`src/game/AudioEngine.ts`, per car in `VehicleCatalog`):
* Turbo cars — Pip (strongest), Atlas, Ridgeback, Meridian — get a compressor whistle whose pitch and level follow
  boost. Boost builds from rpm × throttle with lag (it takes about half a second to spool), collapses off throttle,
  and vents with a blow-off "pssh" when the throttle closes or on an upshift under boost, with compressor flutter
  on the stronger setups. The Brute gets a supercharger whine that follows rpm instantly. Kestrel, Vortex and
  Apex stay naturally aspirated. Sound only: power and handling are unchanged.
* Boost follows game time (frame time from the game loop), so it pauses with the game and behaves the same at any
  frame rate. Measured (Pip, browser, deterministic frames): boost 0.87 at the top of 2nd gear, one blow-off on
  the 1→2 upshift and one on lift-off, boost 0.87 → 0.13 within one frame of lifting. Kestrel: no boost, whistle,
  blow-off or whine. Brute: whine present, no boost.
* Two bugs were found by the test and fixed before commit: the lift-off blow-off required the throttle to fall
  from > 55 % to < 15 % between two frames (the game's throttle eases off over several frames, so it would
  almost never have fired), and spool / cooldown used the audio clock capped at 0.1 s per update (slow at low
  frame rates).

**Not built / not possible here, honestly:**
* *Steering-wheel force feedback (torque)*: browsers have no API for it. Wheels that the browser exposes as a
  gamepad will steer, but without resistance or self-centring.
* *Real controllers*: every controller test used a scripted stand-in for `navigator.getGamepads()` in headless
  Chromium. No physical controller, rumble motor or wheel was available. Button layouts follow the standard
  mapping; controllers the browser does not map as "standard" may have buttons in other places.
* *Cockpit details*: no hands on the wheel, no mirrors, no windscreen rain, wipers or dirt; the interior is
  simple procedural geometry in the game's low-poly style.
* *Bumper camera*: not added (chase and in-car only).
* *Touch devices*: the HUD keeps touch hints hidden on touch screens even if a controller is connected.

Tests (browser = headless Chromium with SwiftShader software rendering):
* New `scripts/cockpit-qa.mjs` (`npm run test:cockpit-browser`): 42/42 — in-car toggle by V / HUD / RB, eye point
  and clipping, persistence over a reload, physics identical in both views, head lag under acceleration / braking /
  cornering, Camera motion Off / Reduced, simulated controller in menus and driving, HUD hints, rumble and
  Vibration Off, unplugging with the throttle held, Pip turbo boost and blow-offs, Kestrel silent, Brute whine.
  It uses a new QA-only hook `qaAdvanceFrames` (deterministic physics steps plus rendered frames at 20 fps).
* Regression, all re-run on this build: browser-qa 115/115, police-qa 25/25, crime-qa 44/44, arrest-qa 79/79,
  release smoke 43/43, weather-qa 18/18, ads-qa 20/20, setup-qa 10/10, layout-qa 7/7, mobile (emulated) 85/85.
  mobile-qa first failed 84/85: the extra camera button made the HUD button row touch the mission panel on a
  portrait tablet (768 × 1024). Fixed by moving the panel below the row at that size; 85/85 after the fix.
* Headless: all 15 suites unchanged (career 41, crime 45, crowd 9, damage 20, jail 69, nav 16, ped 19,
  physics 56, police 60, progress 63, setup 11, soak 12, traffic 22, vehicles 28, weather 35); campaign 68/71
  with the same three known failures and identical numbers as before (physics untouched). Build parity passed.
* Not tested: physical controllers, rumble motors, steering wheels, real phones / tablets, GPU frame rate.
