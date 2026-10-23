# Open-world crime, police, carjacking and jail update

## 1. Inspection (before editing, at 5ccd1e5)

| System | State found | Reuse |
|---|---|---|
| Character | Kinematic capsule (Rapier KCC), Quaternius model, clips Idle/Walk/Run/Jump only | Same controller; new poses are procedural bone layers on top of the clips |
| Enter / exit | Scripted walk → fade → drive for the single player car (`Game.vehicle`) | Generalised to any target vehicle |
| Traffic | 18 kinematic cars on a lane graph (IDM), 2 body kinds, wrecks become dynamic | Cars can be held, abandoned and released into a drivable vehicle |
| Pedestrians | Sidewalk-bound (track s/lat), dodge + stumble, instanced crowd with baked clips | New panic/surrender/phone/knocked-down modes; extra baked poses |
| Police | 3 pooled cars (shared with race rivals), light bars, siren, wanted 0–3, `busted` = 3 s fine | Extended: markings, officers, line-of-sight search, interception, arrest FSM |
| Saves | `city-racer.progress.v2`, sanitised, cross-tab adopt | New `impound` field, sanitised |
| Boost | **Missing** (never built in Phase 4) | Shift stays sprint on foot; nothing to preserve in the car |
| Weapon, carjacking, arrest, jail | Missing | New |

## 2. Plan (stages, each built and tested before the next)

1. World vehicles: pooled extra `Vehicle`s (parked cars, released traffic cars); `Game.vehicle` = car being driven, `ownCar` = the garage car, never deleted; enter any car; reset on restart/quit.
2. Weapon: state machine (holstered/equipping/ready/aim/reload), ammo, procedural arm poses, gun mesh, muzzle flash, recoil, impacts, sound; desktop 1/RMB/LMB/R, touch buttons.
3. NPC reactions: pedestrians panic-flee along the sidewalk, surrender, call the police (report after a delay), knocked down (non-graphic) by shots; traffic drivers stop, get out and flee when threatened.
4. Wanted/police: new offences (gunfire, assault, carjacking, reported calls), police line-of-sight with search of the last known position, interception unit, police markings, officers on foot at the arrest.
5. Arrest FSM: surrender → officers approach → escorted to the police car → skippable transition → jail; impound of the car used; arrest summary; one-shot (no repeated triggers).
6. Jail: real interior with colliders (cells, corridors, office, security room, yard, maintenance tunnel), guards with vision cones, cameras, keycard / security shutdown / maintenance tunnel / distraction, checkpoints, caught → checkpoint, escape → back to the city with a wanted level.
7. HUD, touch layout, tests, docs.

## 3. Progress

### Stages 1–3 — world vehicles, weapon, NPC reactions (built and tested)

What exists in the running game (free roam only; missions and races disable all of it):

* **Weapon** (`crime/Weapon.ts`, `crime/CrimeController.ts`): pistol state machine holstered → drawing (0.45 s) → ready ⇄ reloading (1.5 s) → holstering (0.4 s); 12-round magazine, 48 reserve (topped up to 48 at the start of a free-roam session, never reduced), semi-automatic (0.24 s cycle), hip / aimed spread, recoil (arm kick + camera kick), muzzle flash, impact puffs + ricochet, gunshot / dry-fire / reload sounds. Shots are real Rapier ray casts from the crosshair (starting past the character), plus a pedestrian ray test.
* **Animation**: the asset has only Idle/Walk/Run/Jump, so holster-reach, low-ready, two-handed aim (pitched with the view), reload, crouch, hands-up and phone are **procedural bone poses** layered over the clips (`character/Poses.ts`); the legs keep walking. The gun is a small mesh parented to the character and placed along the forearm (or on the hip when holstered).
* **Controls**: desktop `1` draw/holster, hold right mouse to aim (it still looks around), left mouse fires only while the pistol is out (otherwise left-drag looks around as before), `R` reload, `C`/`Ctrl` crouch. Mouse chords (aim + fire) are tracked from `PointerEvent.buttons`. Touch: Gun / Crouch / Reload buttons, an Aim toggle and a hold-to-fire button; Gun / Reload / Aim / Fire are hidden whenever the weapon is unavailable. Over-the-shoulder aim camera (closer, offset right, narrower FOV). Key hints and the Controls screen list the new keys.
* **Pedestrians**: aimed at → hands up (close) or flee; gunfire → flee / surrender / phone the police (max 2 callers; a finished call is a *report* that starts or refreshes a police search). Hit by a shot → knocked down (stylised fall, no injury detail), gets up after 7 s and runs. Crossing pedestrians first clear the road.
* **Taking vehicles** (`crime/WorldCars.ts`): a pool of 3 extra drivable `Vehicle`s. Parked cars appear at kerbside spots 70–200 m from the player and are recycled beyond 320 m; walking up shows "Steal car" (car-theft offence if police see it). Aiming at a traffic car: below 9 m/s the driver brakes, stops and gets out with their hands up (carjack offence, always reported) and the car stays as an empty wreck ("Take car"); faster cars speed away. Taking it swaps the traffic car for a pooled drivable car with the same body/paint at the same pose. `Game.vehicle` is the car being driven, `Game.ownCar` the garage car: the owned car is never moved, replaced or deleted, garage/repair always act on it, the garage refuses a stolen car (browser-tested in `arrest-qa --only=garage`), and walking back to it shows "Get in your car". Restarting free roam or starting a mission returns to the owned car and frees the pool.
* **Wanted**: new offences gunfire, assault (shooting a person), carjack, car theft, shooting police; `report()` for phoned-in reports.

Tests:

* `npm run test:crime` (headless, 35 checks): weapon FSM timings / ammo / reload / holster / reset, wanted reports, traffic threaten → stop → abandon → empty static wreck that never drives off, fast car flees, release().
* `npm run test:crime-browser` = `scripts/crime-qa.mjs` (QA build, real keyboard + mouse, 44 checks): equip / aim / fire / reload / crouch / holster with HUD, hint and **measured bone directions** (the aimed arm points forward), left-drag look preserved while holstered, pedestrian reactions + knock-down + get-up + wanted, steal a parked car and drive it with the owned car untouched, get back into the owned car, carjack a slow traffic car (stop, driver out hands-up, take it, drive), weapon disabled in missions, clean reset back in free roam.
* `scripts/mobile-qa.mjs` gained armed-layout checks (portrait and landscape phone, interact button showing): no overlaps / off-screen controls, Gun draws, Aim toggles, holding Fire shoots, Gun holsters; weapon buttons hidden in a mission.

Bugs found and fixed on the way: pose blending used `q.slerpQuaternions(ident, q, w)` (three.js copies the first argument into `q` first, so every weight < 1 produced no rotation); the same aliasing in `CameraRig` meant the camera *rotation* never blended between car and on-foot views (it snapped at the end); traffic paint must only consume a random number when a renderer exists (headless runs keep their old random sequence).

Known limits after stages 1–3: carjacked cars show the matching catalogue body (traffic van/hatch kinds map to the Meridian/Atlas bodies, so the model visibly changes when it is taken); traffic drivers are not visible inside cars; the knocked-down pose is a tilt of the crowd model, not a ragdoll; ammo has no pickups (refilled per session); the city has no indoor cover, so "take cover" is flee-to-distance.

### Stage 4 — visible police (built and tested)

* **Marked cars** (`police/Livery.ts`): door panels + roof number decals fitted to the body, light bar with flashing red/blue lights and siren (existing). A 4th pooled car is the roadblock unit; it stays parked out of the world until needed.
* **Officers** (`police/Officers.ts`): a pool of 4 real character controllers with the character model in a police uniform. A unit that has stopped near a player on foot lets officers out; they run to arm's length with the sidearm aimed and get back in when the pursuit ends. Shooting an officer knocks him down (stylised, collider removed, no injury detail), counts as `shootPolice` (heat 4) and he gets up after a few seconds.
* **Line of sight** (`PoliceSystem`): ray casts from roof height to the player's head against the fixed city geometry. Out of sight → *search* at the last known position (units drive there); found again → pursuit; search time runs out → escape, wanted level cleared.
* **Interception**: at 2★+ a roadblock car is placed ahead on the player's road, only where it can't be seen (beyond sight range or behind buildings); it leaves a gap, and is cleared once the player is well past. No unit is ever placed in view of the player; units drive on the road graph.

### Stage 5 — arrest + impound (built and tested)

* **Capture**: the existing bust rule (car within 8 m and slower than 2 m/s for 4 s, or on foot within 7 m of an officer / unit for 3 s) now starts an **arrest sequence** in free roam (`police/Arrest.ts`): `idle → surrender → cuffed → escort → transfer → done → idle`. Surrender: officers of the nearest unit close in with sidearms; in a car the player is told to get out (E) and is forced out after 3 s; on foot the hands go up (procedural pose, at least 1.5 s). Cuffed once an officer is at arm's length; the officer then walks the player (real character movement) to the rear door of the police car; transfer = fade + arrest card, skippable (Continue / E / Enter) after 0.8 s. Every phase has a hard time limit and `begin()` is refused unless idle, so it can't stick or re-trigger; offences are ignored while jailed.
* **Penalty saved immediately** at the start of the arrest (quitting / reloading mid-arrest changes nothing): fine (`Wanted.fine`), the car used in the chase, `jail = {checkpoint 0, bail, items}`, `arrests + 1`. Nothing else in the save is touched (owned cars, upgrades, unlocks, campaign, credits apart from the fine).
* **Vehicles**: a stolen / carjacked car is returned to the world pool (towed). The **owned car is impounded**: `progress.impound[carId] = fee` (400 + 300·stars; owned cars only). In free roam an impounded selected car stands at the **impound lot** (P on the minimap / map); release it by paying at the office, or *break it out* by just getting in (offence `impoundTheft`, heat 4 → 2★). Missions and races lend a stock car while the selected car is impounded (the impounded car stays at the lot). Choosing another car in the garage works normally.
* **Arrest card**: wanted level, fine, impounded car + release fee (or "stolen car returned"), bail, and a note that the other cars / progress are untouched.

### Stage 6 — jail + escape (built and tested)

* **Harbor County Jail** (`jail/JailLayout.ts`): a walled compound outside the city (x ≈ 634–720) with real colliders: 5 cells with bars (sight lines see through them), corridor, office, common room, maintenance room, sally port, yard with an electric gate, a crawl duct and a drain tunnel with low kinematic ceilings (crouch to get through; you can't stand up under them).
* **Guards** (`jail/JailEscape.ts`): 3 real character controllers on patrol routes (corridor, office, yard) with a 110° / 13 m vision cone (7 m against a crouched player) ray-cast against the walls; restricted area or suspicious action → suspicion meter → chase (slightly slower than a sprinting player) → search → back to patrol. 3 sweeping **security cameras**: seeing the player somewhere restricted for 1 s sends the two nearest guards to investigate that spot. HUD detection meter (Unseen / Noticed / Suspicious / Spotted!).
* **Escape options**: vent behind the bunk → duct → maintenance room (**checkpoint**) → drain hatch → tunnel (maintenance route); breaker cuts the power (cameras off, yard gate open for 60 s; disable security); keycard on the office desk → security door → front gate (key route); fire alarm pulls every guard and opens the yard gate (distraction); yard time on request; bail by the cell phone (credits).
* **Caught** → short freeze, back to the last checkpoint (cell or maintenance room); the keycard is kept. Progress inside the jail (checkpoint, items) is saved, so a reload resumes the sentence.
* **Out**: escape → back on the street by the impound lot with a 1★ police search (the record follows you); bail → clean. The sentence is cleared either way; the impounded car stays impounded until paid for or broken out.
* While jailed the weapon, world cars, traffic / pedestrians, police, map and navigation are off; the touch layout keeps the joystick, Crouch, Run/Jump and the context button (Vent / Open / Card / Bail …).

### Stage 7 — HUD, touch, tests

New / extended tests (all run on the current code; results in the final report):

* `npm run test:jail` (headless, 69 checks): arrest FSM (order, min hands-up time, refusals, every phase times out), and the jail with real physics — closed doors block, crawl spaces need crouching, vent / hatch / breaker / keycard / alarm / yard-time / bail, guards (restricted vs allowed areas, crouch range, sight through bars, walls block), cameras, capture → checkpoint, all three exits, cleanup removes every body.
* `npm run test:arrest-browser` = `scripts/arrest-qa.mjs` (QA build, real E / C / W / Enter / mouse input, 59 checks): busted on foot (officers, hands up, cuffed only at arm's length, escort walks to the door, card, Continue), save checks (fine once, impound fee, sentence, garage untouched), no re-trigger in jail, reload mid-sentence, full tunnel escape, impound lot pay (once), busted in a stolen car (forced out, card button, car returned, own car not impounded), recapture → cell, bail, mission loaner, break-out (wanted 2★). Sections `routes` + `garage` (22 more checks): the key route walked for real (yard time from the guard → office keycard → security door → sally port → front gate) and the power-cut route (breaker → staff door → common room → yard → open gate, at a run within the 60 s), and the garage refusing a stolen car. The jail guards are parked (held) during those walks once the cell is open, so the routes themselves are what is tested; guard detection / chase / capture is tested separately (recapture section, headless jail test).
* `scripts/mobile-qa.mjs`: arrest card Continue by touch, jail layout portrait + landscape (no overlaps / off-screen, 44 px targets), Vent / Crouch buttons, weapon buttons hidden.
* `scripts/police-qa.mjs`: sections now start from a clean record (a bust starts a real arrest and saves a sentence). The officer-shooting check was intermittent (1 failure in 4 full runs): when the officer stepped out on the far side of his car the shot correctly hit the car. The test now stands the player on the open side of the officer; 3/3 runs pass.

Performance (QA build, 960×540, SwiftShader software GL, so counts not frame rates): free roam 170 draw calls / 287k triangles; in the jail 183 calls / 112k triangles; back in the city 170 calls (the jail is built once on first use, hidden and not drawn afterwards; its bodies are removed when it is disposed). Simulating 10 s of game time took 165 ms CPU in the jail and 312 ms in the city. No GPU frame-rate measurement was possible here.

Known limits: officers don't drive the player in the car (the transfer is a fade + card); there is one jail; guards path only through open doorways; the arrest uses the nearest unit's crew (up to 2 officers); guards don't radio each other (only cameras and the fire alarm pull several guards at once); mobile behaviour was tested in an emulated touch browser (Playwright), not on a physical device.
