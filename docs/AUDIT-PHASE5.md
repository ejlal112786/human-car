# Phase 5 audit — City Racer

Audit baseline: commit `e538248` (end of Phase 4: 15-mission campaign and 8-car garage).
Regression repairs from this audit are in commit `905328d`.
Environment: headless Chromium with SwiftShader (software WebGL), 2 CPUs. No GPU, no real phone, no gamepad hardware.

## 1. Test results (run during this audit, not carried over from earlier phases)

| Suite | Before repairs (e538248) | After repairs (905328d) |
|---|---|---|
| `npm run build` (release, dist check, no QA hooks) | PASSED | PASSED |
| build parity (release vs QA differ only in the hook regions) | — | PASSED |
| headless: physics, traffic, peds, crowd, vehicles, progress, nav, damage, police, soak | all PASS | all PASS (police +2 new checks) |
| headless: career | 1 FAIL (marker overlap) | ALL PASS |
| headless: campaign (15 missions × success + failure paths) | 2 FAIL (City Grand Prix) | 2 FAIL (City Grand Prix, unchanged — see §3) |
| release smoke (built `dist`, real input) | 31/43 | **43/43** |
| browser QA | not runnable (stale) | **114/114** |
| mobile QA (CDP touch emulation) | — | **55/55** |
| city QA (traffic, peds, context loss, garage, nav, damage, police, audio, career, tabs) | 126 pass / 7 fail, then timed out | all sections pass (first run + re-run of failing sections: 65/65) |
| layout QA | — | 7/7 |
| monkey QA (200 random steps, seed 1) | — | PASSED |
| resource audit | — | 6/6 |

## 2. Regressions found and what they actually were

| Symptom | Root cause | Fix |
|---|---|---|
| Release smoke: "Get in" prompt never appears, 11 follow-on failures | **Stale test.** Find Your Ride gained a 180 s time limit, so the HUD clock counts *down*; the test's "hold W for 7.9 s" waited for the clock to rise by 7.9 and walked for 240 s | `holdSim` uses \|Δclock\|; restart check compares with the mission's own start clock |
| Release smoke: WebGL "object does not belong to this context" after context restore | Only seen on the broken test path above (after a 240 s walk). Not reproducible by a dedicated probe (240 s walk → loss → restore → drive) | No code change; release smoke now passes this check. Recorded as "not reproduced" |
| Browser QA: Mission 2 checks fail | **Stale test.** It assumed the old 5-mission order (City Driving was Mission 2) | Re-mapped to campaign indices, saves seeded with `campaign: 2` |
| Browser QA / city QA: "all rivals finish", "finished 3rd" | **Stale test.** Since Phase 4 a race that can no longer be won fails immediately ("A rival took the win") | Tests check the immediate-fail behaviour and reason |
| Career: markers overlap (Foundry Time Attack 2 m from Hot Pursuit; Grand Loop 6 m from Precision Parking; Championship 37 m from Drift King) | **Real bug.** Phase 4 placed new missions on top of career event starts | Event starts moved to free road; route lengths unchanged (full laps / same 484-sample sprint). Test now lists every pair under 40 m |
| City QA: police escape impossible | **Real bug (Phase 4).** A stuck chasing unit was re-spawned 170 m behind the player, i.e. teleported hundreds of metres closer, and immediately re-spotted the player | `recoverChaser`: a recovery never gains ground — far units are put back in lane at their own road position; only units already closer than 170 m are brought in behind. New headless test (fails on old code: 406 m jump, no escape) |

## 3. Known open defect at audit time (since resolved, see §5)

* **City Grand Prix (mission 15) was not completed by the scripted test driver**: a rival won; rivals needed 21 respawns. In the browser, a rival also rear-ended the player's parked car at the Street Race finish line (shoved 27 m). Both pointed at the race AI's collision avoidance / recovery.

## 4. System inventory (verified in code and tests)

Legend: **F** functional (implemented and covered by tests), **I** incomplete, **M** missing.

| System | Status | Notes |
|---|---|---|
| Character on foot, enter/exit car | F | release smoke, browser QA, mobile QA |
| 15 campaign missions | F (14/15 verified completable) | City Grand Prix not verified completable (§3) |
| Career (7 events) | F | career test, city QA |
| Garage: 8 cars, upgrades, paint, cosmetic parts, orbit preview | F | parts are cosmetic only (labelled in the UI) |
| Vehicle physics (Rapier raycast vehicle, fixed 60 Hz step) | F | |
| Boost / nitro | **M** | no code |
| Tyre smoke | F | driven by real wheel slip (`onWheelSlip`), pooled billboards, off on Low quality |
| Skid marks | F | pooled (3000 segments), from wheel slip |
| Impact dust, engine-damage smoke, sparkles | F | pooled; debris pieces do not exist |
| Traffic AI, signals, pedestrians, crowd | F | traffic / peds / crowd tests, city QA |
| Police / wanted / pursuit / busted / escape | F (after fix) | |
| Damage zones, smoke, repair at garage | F | cosmetic panel effects, power loss; no mesh deformation |
| Engine / tyre / impact / siren / UI audio | F | Web Audio synthesis, per-car engine profile |
| Weather, rain, time of day, night lighting | **M** | single daytime lighting; headlights exist only as a damage flicker effect |
| Keyboard + mouse controls | F | |
| Touch controls (joysticks, buttons) | F (emulated) | tested with CDP touch only, not a real phone |
| Gamepad | **M** | no Gamepad API code |
| Cameras | I | chase camera, on-foot camera, garage orbit; no hood / cockpit / cinematic |
| Replay | **M** | the results-screen button labelled "Replay" restarts the mission |
| AI racers | I | road-following rivals with overtaking offsets, catalogue cars; weak collision avoidance and recovery (§3); no difficulty setting |
| Race modes | I | single race, circuit (laps), GP; no championship points, elimination, sprint series, drift competition (a drift *mission* exists), knockout, free-roam challenges |
| Saves: progress, credits, cars, upgrades, best times, settings | F | corrupt / old saves sanitised and migrated (progress test) |
| Achievements | **M** | |
| Reset progress | **M** | |
| Multiplayer | **M** | no backend exists |
| Minimap / city map / navigation | F | |


## 5. Race AI rework (Phase 5, step 2)

Root causes of the Grand Prix failure, each confirmed with a probe before the fix and re-measured after:

| Cause | Kind | Evidence | Fix |
|---|---|---|---|
| Rivals pushed against a wreck / queue, then "respawned" (reset in place) 11–30+ times | Game AI | Respawn trace: stuck behind a stopped car with a stale lane shift | Recovery is now driven: reverse out (steering away from the obstacle), then a fresh lane choice; a reset only after 4 failed attempts, clear of other cars. Rival respawns per race: 0–1 |
| Test pilot "finished" ~1 km early and cruised mid-race | **Test harness** | Pilot trace: `finished=true` at progress 2003 of ~3000; progress jumped 0→480 on the first step | The harness's AiRacer started counting from sample 0, not the grid. Fixed in `campaign-test.ts`. Police-escape pilot (no gates) now never "finishes" |
| Racers braked for a slow car 45–130 m ahead without changing lanes | Game AI | Held-up time 20–41 s of a ~145 s race; at those moments the lane chooser saw 45 m (its cap) of room on every line | The lane chooser looks as far as the follow logic (stopping distance). Held-up time: rivals 19–38 s → 5–14 s |
| No passing of moving cars in moderate bends | Game AI | Remaining hold-ups at i600/i900/i950 classified "bend" | Pass a slower moving car when the next 50 m bend less than radius ≈ 28 m (was 55 m); stopped cars anywhere. Never across a car alongside; back to the racing line only with ≥ 40 m room |
| Test pilot copied a rival's line and tailgated it from the grid | **Test harness** | Pilot had 2–6 reversals by mid-race, rivals 0 | The pilot uses its own line (1.0 m) in races |

Calibration (measured, documented):

* **Grand Prix stars [160, 172] → [145, 160].** The old thresholds were set against the slower AI; 17 measured wins (7 run orders × 3 late-game cars) took 125–153 s (median 142 s): every win scored 3★. Now ~60 % of the scripted pilot's wins earn 3★.
* **Rival skills unchanged** (0.84/0.86/0.88). Lowering them by 0.06 or 0.10 was tested before the look-ahead fix and did *not* change the win rate (~40–50 %): traffic hold-ups, not pace, decided the race.
* **Mission traffic density is fixed** (new `trafficDensity`, default 18, the value every traffic mission was calibrated with). Previously it followed the graphics quality preset (9/14/18), so the Grand Prix and Rush Hour were easier on Low graphics. Free roam still follows the preset.
* Grand Prix check: the test runs Vortex L2, Vortex L3 and Apex L0 and requires at least one clean win (no pilot reset); see §6 for the current win rate.

Unchanged: solo AI driving (career AI lap times identical to the pre-rework log), Street Race 70.0 s P1, Circuit 207.1 s P1, Hot Pursuit 89.2 s. Logs: `qa-logs/p5/campaign-ai1…7.log`, `career-ai1…7.log`.

Limitation: the scripted pilot is itself an AI driver near the top of the skill range; how often a human wins the Grand Prix has not been measured (no human playtest).


## 6. Race rules: checkpoint validation, difficulty, rubber band (Phase 5, step 2b)

* **AI checkpoint validation.** Rivals now finish only by crossing every checkpoint in order, with the player's rule (gate line crossed forwards, inside the opening; +3 m pavement tolerance because an AI cannot drive back to a missed gate). A rival more than 30 m past a gate's road position without a valid crossing is **disqualified**: it stops racing, never finishes, is ranked last ("DSQ" in the standings) and does not count against the player's position. Before, a finish was purely the distance along the track index, so a shortcut counted.
* **What the validation exposed** (each traced step by step before fixing):
  * A rival lane change at 35 m/s swung across the whole road (10.5 m) into a long bend and slid off → lane changes above 12 m/s are limited to one lane (4.5 m), and the bend check covers the whole distance the change takes (also for the return to the racing line).
  * A rival spun by a collision drove 100 m away from the course at full throttle: pure pursuit diverges when the car points away from the road (its steering shrinks as the target recedes) → **off-road recovery**: more than 6 m off the line, or heading error above 57°, steers by heading error towards the road just ahead at ≤ 12 m/s.
  * Tried and rejected (measured, not kept): a braking lead (fewer excursions but every AI driver slower: Hot Pursuit and Circuit pilots failed); a stiffer brake controller (solo AI laps 2.5 % slower, career margin check failed); understeer braking (did not reduce excursions).
  * Off-course disqualifications over 7 run orders (Street Race, Circuit, Grand Prix x3 each): 7 before → 0–2 after (rare; chaotic multi-car runs vary). Career solo AI lap times are identical to before (recovery only acts off the road).
* **Difficulty presets** (Settings → Racing → Rival skill): Easy / Normal / Hard multiply rival skill by 0.94 / 1 / 1.04, capped at 1. Skill only changes how hard the driver plans corners and straights, never the car's grip, power or position. Measured (Street Race, player parked): winning rival 78.0 / 76.7 / 75.9 s. Rewards are unchanged by difficulty.
* **Rubber band** (Settings → Racing → Catch-up rivals), **off by default**: rivals far ahead of the player drive with up to 0.05 less skill, rivals far behind up to 0.05 more (linear over 300 m). Same limits: skill only. Measured with the player parked: winning rival 78.1 s vs 76.7 s.
* Both options apply from the next race start and are validated on load (invalid or missing values fall back to Normal / Off).
* **Grand Prix win rate** after these fixes (rivals recover from spins instead of losing time off-course): the scripted pilot won 13/21 (7 run orders x Vortex L2 / Vortex L3 / Apex L0), at least 1 of 3 in every order. Lowering rival skill by 0.04 did not change it (13/21). The test requires ≥ 1 clean win of 3.

Tests added: campaign (every race: rivals' finishes come from all checkpoints in order; forced course cut → DSQ, last, race continues; difficulty order; rubber band off by default / effective when on; skill cap), progress (settings validation, old settings saves), browser `npm run test:race-options` (Racing controls persist across reload; on Low graphics free roam keeps 9 cars while Rush Hour keeps its 18; no console errors). Logs: `qa-logs/p5/campaign-rules9.log`, `career-rules9.log`, `headless-rules.log`, `race-options-qa.log`, `layout-rules.log`.

### Parked player car at the race finish (audit finding, now covered)

The audit saw a rival rear-end the player's parked car at the Street Race finish (shoved 27 m). The browser suite never measured it: the race fails the moment a rival finishes. New checks, both A/B tested:

| | Pre-rework AI (905328d) | Current AI |
|---|---|---|
| Headless, player parked on the grid while rivals lap past: Street Race | **moved 16.50 m** (FAIL) | 0.00 m |
| Circuit Championship | **moved 100.67 m** (FAIL) | 0.00 m |
| City Grand Prix | 0.00 m | 0.00 m |
| Browser §9 Street Race (real game, buildings) | — | 0.00 m |

Full browser suite after the AI work: 115/115 (`qa-logs/p5/browser-rules2.log`).
