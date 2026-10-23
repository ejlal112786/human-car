import { START_RESERVE } from './crime/Weapon';
import { AIM_PITCH_BIAS } from './character/CharacterCamera';
import { PoliceSystem, type PlayerState } from './police/PoliceSystem';
import { Officers, characterPalette, uniformTexture, uniformedClone } from './police/Officers';
import { ArrestSequence, CUFF_RANGE, type ArrestSummary } from './police/Arrest';
import { JailEscape, type JailContext, type JailPlayer } from './jail/JailEscape';
import { JAIL_ORIGIN } from './jail/JailLayout';
import { WantedSystem, type Offence } from './police/Wanted';
import { AGENT_PLAYER_CAR } from './city/CityLife';
import { Object3D, Quaternion, SpotLight, Vector3 } from 'three';
import { HUD } from '../ui/HUD';
import { Menu, showFatalError, type GarageAction, type MapModel, type ScreenName } from '../ui/Menu';
import { Minimap, createMapMarkers } from '../ui/Minimap';
import { TouchControls } from '../ui/TouchControls';
import { AudioEngine } from './AudioEngine';
import { CameraRig } from './CameraRig';
import { CityLife, type CityActors } from './city/CityLife';
import { CharacterController } from './character/CharacterController';
import { CharacterModel, loadCharacter } from './character/CharacterModel';
import { FIXED_DT, MAX_SUBSTEPS } from './config';
import type { DriverInput } from './Drivetrain';
import { Environment } from './Environment';
import { GameStateMachine, type GameStateName } from './GameState';
import { InputManager, createControlState, type InputAction } from './InputManager';
import { LookInput } from './LookInput';
import { FREE_ROAM, LEVELS, MISSION_TRAFFIC_DENSITY, PAINTS, type LevelDef, type TrackPos } from './missions/Levels';
import { MissionManager, createMissionInput, type MissionInput } from './missions/MissionManager';
import type { AmbientCar } from './missions/RaceAI';
import { RedLightDetector } from './traffic/RedLight';
import { MissionVisuals } from './missions/MissionVisuals';
import { ObstacleManager } from './missions/ObstacleManager';
import { bailFor, fitNewTyres, impoundCar, impoundFee, isImpounded, payImpound, releaseImpound, tyrePrice, tyreWearOf } from './missions/Progress';
import { PROGRESS_KEY, adoptProgress, isMissionUnlocked, loadProgress, missionLockReason, readStoredProgress, newCarSave, recordCompletion, saveProgress, sanitizeProgress, type Progress } from './missions/Progress';
import { adjustSetup, buyCar, buyUpgrade, fitPart, resetSetup, selectCar, setCarPaint } from './vehicles/Garage';
import { DEFAULT_VEHICLE, noUpgrades, vehicleById } from './vehicles/VehicleCatalog';
import { CROSSINGS } from './world/Crossings';
import { CAREER, careerEvent, careerStatus, isCareerUnlocked, recordCareer } from './career/Career';
import { ARRIVE_RADIUS, GARAGE_SPOT, IMPOUND_SPOT, buildPois, planRoute, poiAt, poiDistance, routeHeading, routePolyline, type Poi } from './navigation/Navigation';
import { PoiMarkers } from './navigation/PoiMarkers';
import { CityMap } from '../ui/CityMap';
import { damageEffects, damageLevel, isDamaged, repairCost, type HitResult } from './damage/DamageModel';
import { Particles } from './Particles';
import { PhysicsWorld } from './PhysicsWorld';
import { SceneManager } from './SceneManager';
import { AI_SKILL_SCALE, CAMERA_MOTION_SCALE, AdaptiveQuality, QUALITY_ORDER, QUALITY_PRESETS, SETTINGS_KEY, loadSettings, readStoredSettings, saveSettings, type QualityLevel, type QualityMode, type Settings } from './Settings';
import { Vehicle } from './Vehicle';
import { EXIT_MAX_SPEED, VehicleInteraction } from './VehicleInteraction';
import { CrimeController } from './crime/CrimeController';
import { ADS_VIEW_THRESHOLD, AdsView, Casings } from './crime/AdsView';
import { WorldCars } from './crime/WorldCars';
import { WEATHER_MODES, WEATHER_NAME, Weather, type WeatherMode } from './world/Weather';
import { TYRE } from './TyreModel';
import { GripField } from './world/Surface';
import { WeatherView } from './world/WeatherView';
import { CockpitInterior } from './CockpitView';
import { GamepadInput } from './GamepadInput';

/** Read-only state snapshot returned by the test hook (dev server / QA builds only). */
export interface GameSnapshot {
  state: GameStateName;
  resumeState: GameStateName | null;
  screen: ScreenName | null;
  inCar: boolean;
  speedKmh: number;
  forwardSpeed: number;
  gear: string;
  rpm: number;
  steer: number;
  position: { x: number; y: number; z: number };
  heading: number;
  upY: number;
  flippedTime: number;
  rearSlip: number;
  propsDisplaced: number;
  physicsSteps: number;
  street: string;
  quality: QualityLevel;
  qualityMode: QualityMode;
  muted: boolean;
  volume: number;
  audioState: string;
  audioGain: number;
  engineOn: boolean;
  skidSegments: number;
  physicsCounts: { bodies: number; colliders: number };
  laneOffset: number;
  headingError: number;
  character: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    grounded: boolean;
    actualSpeed: number;
    speed: number;
    enabled: boolean;
    visible: boolean;
  };
  prompt: string | null;
  mission: {
    levelId: string;
    levelIndex: number;
    stage: string;
    nextGate: number;
    gates: number;
    elapsed: number;
    penalty: number;
    strikes: number;
    position: number | null;
    zoneHold: number;
    racers: Array<{ name: string; progress: number; finished: boolean; x: number; z: number }>;
    obstacles: Record<string, number>;
    obstaclesDisplaced: number;
  };
  touch: { visible: boolean; layout: string; joyX: number; joyY: number; holds: Record<string, number>; run: boolean };
  control: { moveX: number; moveY: number; run: boolean; throttle: number; brake: number; steer: number; handbrake: boolean };
  hudVisible: boolean;
  cameraMode: string;
  /** On-foot camera yaw (forward = (sin, cos)) and the ground-projected camera forward. */
  camYaw: number;
  camFwd: { x: number; z: number };
  exitCandidate: number;
  particles: boolean;
  progress: Progress;
  settings: Settings;
}

/** HUD text when an offence is reported. */
const OFFENCE_TEXT: Record<Offence, string> = {
  redLight: 'Ran a red light',
  speeding: 'Speeding',
  hitTraffic: 'Hit a car',
  hitPedestrian: 'Hit a pedestrian',
  hitPolice: 'Rammed a police car',
  gunfire: 'Shots fired',
  assault: 'Assault',
  carjack: 'Carjacking',
  carTheft: 'Car theft',
  shootPolice: 'Fired on the police',
  impoundTheft: 'Broke a car out of the impound',
};
/** Jail guard uniform (khaki shirt, dark trousers). */
const GUARD_UNIFORM = { shirt: [176, 150, 98], pants: [52, 56, 52] } as const;
/** Arrest: hands-up / escort blend rate (1/s). */
const HANDS_RATE = 3;
/** Fade to black for the arrest transfer and jail captures (1/s). */
const FADE_RATE = 2.5;

/** Automated-test controls; only exists in dev / QA builds (see Game.createTestHook). */
export interface GameTestHook {
  snapshot(): GameSnapshot;
  qaAdvance(seconds: number): void;
  /** Stop / restart the real-time loop (screenshots under software GL; qaAdvance still works). */
  qaFreeze(on: boolean): void;
  /** Visible meshes grouped by top-level scene child (draw-call budget analysis). */
  sceneStats(): Array<{ group: string; meshes: number; shadow: number; instanced: number; tris: number }>;
  renderInfo(): { calls: number; triangles: number; geometries: number; textures: number; programs: number };
  debugTeleport(sampleIndex: number, lateralOffset: number, yawOffset?: number): void;
  debugTeleportCharacter(sampleIndex: number, lateralOffset: number, yaw?: number): void;
  debugFlip(): void;
  /** Start a level directly (skipping menus); -1 = free roam. */
  startLevel(index: number): void;
  setProgress(p: unknown): void;
  damageInfo(): { zones: Record<string, number>; lamps: Record<string, boolean>; level: number; powerScale: number; repairPrice: number };
  weatherInfo(): {
    mode: string;
    kind: string;
    cloud: number;
    rain: number;
    fog: number;
    wetness: number;
    puddles: number;
    visibility: number;
    fogFar: number;
    rainVisible: boolean;
    puddlesVisible: boolean;
    asphaltRoughness: number;
    sightScale: number;
    label: string;
    surface: string[];
    gripScale: number[];
    aquaplane: number[];
    tyreTemp: number[];
    tyreWear: number[];
    carHasSurface: boolean;
  };
  /** Force the free-roam weather (instant = jump to its steady state, wet road included). */
  qaWeather(mode: string, instant: boolean): void;
  /** Set the driven car's tyre wear / temperature (all four wheels). */
  qaTyres(wear: number, temp?: number): void;
  /** qaAdvance that also renders every `every` steps with a real frame time (deterministic per-frame systems). */
  qaAdvanceFrames(seconds: number, every?: number): void;
  /** In-car view: setting, whether it is in use, interior / clipping, camera and eye in the car frame, head motion. */
  cockpitInfo(): {
    view: string;
    motion: string;
    active: boolean;
    blending: boolean;
    interior: boolean;
    clipping: boolean;
    clipsCabin: boolean;
    cam: { x: number; y: number; z: number };
    eye: { x: number; y: number; z: number };
    offset: { x: number; y: number; z: number };
    accel: { x: number; y: number; z: number };
    level: { vibration: number; road: number; bump: number };
    fov: number;
    cabinAudio: boolean;
    charVisible: boolean;
  };
  /** Game controller: in use, name, HUD controller hints, diagnostics counters. */
  padInfo(): { active: boolean; name: string; hudPad: boolean; diag: { rumbles: number; triggerRumbles: number; strong: number; weak: number; nav: number; presses: number } };
  debugHit(dv: number, hitFwd: number, hitRight: number): void;
  policeInfo(): {
    enabled: boolean;
    playerIdx: number;
    stars: number;
    heat: number;
    state: string;
    bustTimer: number;
    nearest: number;
    units: Array<{ active: boolean; carActive: boolean; x: number; z: number; idx: number; dir: number; speed: number; lightbar: boolean; livery: { visible: boolean; panels: number }; yaw: number }>;
    seen: boolean;
    lastKnown: { x: number; z: number; idx: number; valid: boolean };
    roadblockUp: boolean;
    roadblocks: number;
    lastBlock: { dist: number; hiddenBy: string };
    deployments: number;
    officers: Array<{ mode: string; unit: number; x: number; y: number; z: number; visible: boolean; aim: number; collider: boolean }>;
  };
  /** Report an offence as if the player committed it (witness rules apply). */
  policeOffence(o: string): boolean;
  /** Place police unit k at road sample i, travelling in `dir`. */
  /** Police line of sight between two ground points (unit roof height → player head height). */
  policeSight(ax: number, az: number, bx: number, bz: number): boolean;
  policePlace(k: number, i: number, dir: 1 | -1, lane?: number): void;
  navInfo(): { dest: string | null; routeCount: number; route: number[]; poiPrompt: string | null; prompt: string | null; markersVisible: boolean; pois: Array<{ id: string; kind: string; i: number; off: number; x: number; z: number }> };
  /** Audio context state + procedural-audio diagnostics (shift / tick counters, ambience levels). */
  audioInfo(): { state: string; hidden: boolean; engineOn: boolean; diag: { shifts: number; upshifts: number; beeps: number; bed: number; pass: number; boost: number; turbo: number; whine: number; blowoffs: number; cabin: boolean } };
  /** Current career event, its gates (sample index, offset), and the pooled rival / police cars' catalogue ids. */
  careerInfo(): { id: string | null; levelId: string; gates: Array<{ i: number; off: number }>; pool: Array<{ car: string; style: string }> };
  garageInfo(): {
    vehicleId: string;
    style: string;
    mass: number;
    maxDriveForce: number;
    redline: number;
    driveFront: number;
    wheelRadius: number;
    rideHeight: number;
    suspensionStiffness: number;
    frictionSlipFront: number;
    brakeImpulseFront: number;
    brakeImpulseRear: number;
    rollingResistance: number;
    look: unknown;
    orbit: { yaw: number; pitch: number; zoom: number; interactive: boolean; lookEnabled: boolean };
    progress: unknown;
  };
  /** Snap the chase / on-foot camera to its target (screenshots after teleports). */
  snapCamera(): void;
  /** On-foot camera yaw (forward = (sin yaw, cos yaw)). */
  setCameraYaw(yaw: number): void;
  /** True if (x, z) lies inside a building footprint shrunk by `margin` metres. */
  buildingAt(x: number, z: number, margin?: number): boolean;
  /** Track sample position + right vector (for test placement). */
  trackPoint(i: number, off: number): { x: number; z: number; rx: number; rz: number; tx: number; tz: number };
  /** Living-city state: traffic stats and cars, signal states. */
  cityInfo(): CityInfo;
  /** Crime update: weapon, driven / owned car, world cars, occupied traffic, ped reactions, wanted. */
  crimeInfo(): CrimeInfo;
  /** Arrest sequence state (phase, officers making it, summary, overlays). */
  arrestInfo(): { phase: string; t: number; started: number; refused: number; officers: Array<{ id: number; mode: string; x: number; z: number; aim: number }>; summary: unknown; handsW: number; card: boolean; fade: number; door: { x: number; z: number } | null };
  /** Jail state: zone, checkpoint, doors, timers, guards, prompt. Local = world − origin. */
  jailInfo(): {
    jailed: boolean;
    active: boolean;
    origin: { x: number; z: number };
    zone: string | null;
    checkpoint: number;
    items: string[];
    detect: number;
    chased: boolean;
    doors: Record<string, boolean>;
    power: number;
    alarm: number;
    yard: number;
    lockdown: boolean;
    task: string | null;
    catches: number;
    guards: Array<{ x: number; z: number; state: string; sus: number; visible: boolean }>;
    cameras: number[];
  } | null;
  /** Jail tests: park the guards in the yard corner and hold them (until the next jail entry) so geometry / interactions can be tested alone. */
  qaJailGuardsAway(): void;
  /** Point the on-foot camera so the screen centre looks at (x, y, z). */
  qaAimAt(x: number, y: number, z: number): void;
  /** Teleport the on-foot character to (x, z) on the ground, facing `yaw` (forward = (sin, cos)). */
  qaPlaceCharacter(x: number, z: number, yaw: number): void;
  /** Force signal k to the start of phase p (0 green, 1 yellow, 2 all-red, 3 walk, 4 flash, 5 all-red). */
  setSignalPhase(k: number, phase: number): void;
  /** Show / hide the traffic and pedestrian renderers (render-cost measurements). */
  setCityVisible(traffic: boolean, peds: boolean): void;
}

export interface CityInfo {
  trafficOn: boolean;
  traffic: { active: number; driving: number; wrecks: number; laneChanges: number; forcedChanges: number; redStops: number; violations: number; hits: number; minGap: number };
  cars: Array<{ x: number; z: number; v: number; lane: number; mode: number; leadKind: number; gap: number }>;
  signals: Array<{ car: string; ped: string }>;
  peds: {
    stats: { active: number; crossStarted: number; crossDone: number; badStarts: number; offCrossingRoad: number; onRoadAtGreen: number; dodges: number; hits: number; minClear: number; minSep: number };
    visible: number;
    exactRow0: number;
    sepInfo: string;
    list: Array<{ x: number; z: number; lat: number; mode: number; speed: number }>;
    draw: Array<{ name: string; instanced: boolean; count: number; visible: boolean; shadow: boolean; poses: number[][] }>;
  };
}

export interface CrimeInfo {
  enabled: boolean;
  state: string;
  weapon: { state: string; drawn: boolean; inHand: boolean; aiming: boolean; mag: number; reserve: number; spread: number; sights: number };
  ads: { blend: number; firstPerson: boolean; viewModel: boolean; crosshair: boolean; casings: number; rearOff: number; frontOff: number; fov: number; slide: number; tuck: number; bodyColor: boolean };
  crouched: boolean;
  aimKind: string;
  shots: number;
  lastShot: { kind: string; x: number; y: number; z: number; distance: number };
  stats: { carjacks: number; driversFled: number; thefts: number; pedsHit: number; reports: number };
  peds: { flees: number; surrenders: number; calls: number; reports: number; knockdowns: number; drivers: number; modes: number[] };
  driven: { vehicleId: string; own: boolean; world: boolean; x: number; z: number; speed: number; yaw: number };
  own: { vehicleId: string; active: boolean; x: number; z: number };
  worldCars: Array<{ state: string; origin: string; defId: string; active: boolean; x: number; z: number; yaw: number }>;
  traffic: Array<{ i: number; x: number; z: number; yaw: number; v: number; mode: number; occupied: boolean; held: boolean; fleeing: number }>;
  wanted: { stars: number; state: string; heat: number };
  hud: { weapon: boolean; crosshair: boolean; prompt: string | null };
  character: { x: number; y: number; z: number };
  camera: { x: number; y: number; z: number; dx: number; dy: number; dz: number };
  /** Procedural pose weights on the player model and whether the gun mesh is in the hand / visible. */
  pose: { aim: number; lowReady: number; reload: number; crouch: number; gunInHand: boolean; gunVisible: boolean; rightArm: number[]; rightFore: number[] };
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

const NO_CARS: readonly AmbientCar[] = [];
const PARKED: Readonly<DriverInput> = { throttle: 0, brake: 0, steer: 0, handbrake: true };
/** Enter: walk to the door (max), then fade. Exit: fade in. Seconds of simulation time. */
const ENTER_FADE = 0.35;
const EXIT_FADE = 0.45;
const CAMERA_BLEND = 0.9;

function lerpAngle(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

/**
 * Top-level game object: owns every subsystem, the state machine and the fixed-timestep loop.
 *
 * Fixed step order: input → (character controller | vehicle) → race AI → physics.step →
 * vehicle/AI post-step → mission logic. Animation, camera, HUD and audio run per frame.
 */
export class Game {
  private readonly sm = new GameStateMachine();
  private rafId = 0;
  private lastTime = -1;
  private accumulator = 0;
  private physicsSteps = 0;
  private trackIndex = 0;
  private charTrackIndex = 0;
  private fpsTime = 0;
  private fpsFrames = 0;
  private fps = 60;
  private disposed = false;
  private contextLost = false;
  private contextTimer = 0;
  private readonly ctrl = createControlState();
  private readonly driverInput: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private readonly abort = new AbortController();
  private readonly audio = new AudioEngine();
  private readonly adaptive = new AdaptiveQuality();
  private readonly markers = createMapMarkers();
  /** Free-roam police (borrows the pooled race-opponent cars, which free roam does not use). */
  private readonly police: PoliceSystem;
  private readonly playerState: PlayerState = { inCar: false, x: 0, z: 0, vx: 0, vz: 0, speed: 0, idx: 0 };
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly feet = new Vector3();
  private readonly shadowFocus = new Vector3();
  private readonly camFwd = new Vector3(0, 0, 1);
  private readonly target = new Vector3();
  private readonly torchForward = new Vector3();
  private readonly jailTorchTarget = new Object3D();
  private readonly jailTorch = new SpotLight(0xffe8bd, 13, 24, 0.48, 0.62, 1.5);
  private jailTorchOn = false;
  private readonly missionInput: MissionInput;
  /** Red-light detection for missions that penalise it (police has its own detector). */
  private readonly missionRedLight = new RedLightDetector();
  private readonly carPrev = new Vector3();
  private cityActors!: CityActors;
  /** Car being driven (or last driven): the garage car, or a world car the player took. */
  private vehicle: Vehicle;
  /** The player's own garage car (never replaced or deleted when another car is driven). */
  private readonly ownCar: Vehicle;
  /** Parked cars and taken traffic cars (pooled, free roam only). */
  private readonly worldCars: WorldCars;
  /** Weapon, threats, carjacking. */
  private readonly crime: CrimeController;
  /** First-person pistol for aiming down the sights, and spent brass. */
  private readonly adsView: AdsView;
  private readonly casings: Casings;
  private readonly sightA = new Vector3();
  private readonly sightB = new Vector3();
  /** Other dynamic vehicles the city reacts to (rebuilt every step, no allocation). */
  private readonly otherCars: Vehicle[] = [];
  /** Simulation time owed to the ambient city behind the title menu. */
  private menuCityAcc = 0;
  // Level state
  private level: LevelDef = FREE_ROAM;
  /** Free-roam weather (missions are always dry and clear: their timing and rivals are calibrated on that). */
  /** A new weather sequence each session (the QA test hook reseeds it to a fixed value). */
  private readonly weather = new Weather((Date.now() ^ 0x5bd1e995) >>> 0);
  /** In-car view interior (dash, wheel, gauges) of the car being driven. */
  private readonly cockpitInterior = new CockpitInterior();
  /** Game controller (Gamepad API): driving, on foot, menus and rumble. */
  private readonly pad: GamepadInput;
  private rumbleTimer = 0;
  /** A one-off rumble (collision) plays out before the continuous road / grip rumble resumes. */
  private rumbleHold = 0;
  private rumbleOn = false;
  private readonly grip: GripField;
  private readonly weatherView: WeatherView;
  /** Every pooled car (own, rivals / police, world cars, roadblock), for the surface they drive on. */
  private readonly allCars: Vehicle[];
  private weatherLookKey = '';
  /** Weather setting last applied (only a changed setting changes the weather). */
  private weatherSetting: WeatherMode = 'dynamic';
  private levelIndex = -1;
  /** Career event being played (levelIndex is −2 then), else null. */
  private careerId: string | null = null;
  private jumpQueued = false;
  // Enter / exit script
  private readonly scriptFrom = new Vector3();
  private readonly scriptTo = new Vector3();
  private scriptYaw = 0;
  private walkDur = 0;
  private doorClosed = false;
  private touchSeen = false;
  private hudTimer = 0;
  private promptText: string | null = null;
  // Arrest / impound / jail (free roam)
  private readonly arrest = new ArrestSequence();
  private jail: JailEscape | null = null;
  /** Serving the jail sentence (free roam). */
  private jailed = false;
  private arrestUnit = -1;
  private readonly arrestOfficers: number[] = [];
  private arrestSide = 1;
  private arrestSkip = false;
  /** Player hands-up blend (fixed step). */
  private handsW = 0;
  private fade = 0;
  private fadeTarget = 0;
  /** The own car was put at the impound lot. */
  private ownAtLot = false;
  /** Selected car impounded during a mission: driving the stock loaner. */
  private loaner = false;
  private pendingResult: {
    kind: 'complete' | 'failed';
    delay: number;
    time: number;
    stars: number;
    reason: string;
    score: number | null;
    details: Array<[string, string]>;
  } | null = null;

  private constructor(
    private readonly scene: SceneManager,
    private readonly physics: PhysicsWorld,
    private readonly env: Environment,
    vehicle: Vehicle,
    private readonly opponents: Vehicle[],
    worldPool: Vehicle[],
    private readonly policeBlock: Vehicle,
    private readonly officers: Officers,
    private readonly character: CharacterController,
    private readonly charModel: CharacterModel,
    private readonly rig: CameraRig,
    private readonly look: LookInput,
    private readonly input: InputManager,
    private readonly touch: TouchControls,
    private readonly hud: HUD,
    private readonly minimap: Minimap,
    private readonly menu: Menu,
    private readonly obstacles: ObstacleManager,
    private readonly visuals: MissionVisuals,
    private readonly mission: MissionManager,
    private readonly interaction: VehicleInteraction,
    private readonly particles: Particles,
    private readonly settings: Settings,
    private readonly progress: Progress,
    private readonly container: HTMLElement,
    private readonly city: CityLife,
    private readonly makeGuard: (() => CharacterModel) | null = null,
  ) {
    this.vehicle = vehicle;
    this.jailTorch.visible = false;
    this.scene.scene.add(this.jailTorch, this.jailTorchTarget);
    this.jailTorch.target = this.jailTorchTarget;
    this.ownCar = vehicle;
    this.pad = new GamepadInput(
      (a) => input.emit(a),
      (dx, dy) => look.addStick(dx, dy),
      () => this.menu.setController(this.pad.connectedName),
    );
    input.addSource(this.pad);
    this.cityActors = { player: vehicle, inCar: false, footX: 0, footZ: 0, footVX: 0, footVZ: 0, opponents: this.otherCars };
    this.police = new PoliceSystem(env.track, [...opponents, policeBlock]);
    this.grip = new GripField(env.track, this.weather);
    this.weatherView = new WeatherView(scene.scene, this.grip.puddles, env.wetMaterials);
    this.allCars = [vehicle, ...opponents, ...worldPool, policeBlock];
    this.police.officers = officers;
    {
      // Police line of sight: buildings and other fixed geometry block it (cars, people and props do not).
      const { R, world } = physics;
      const flags = R.QueryFilterFlags.EXCLUDE_DYNAMIC | R.QueryFilterFlags.EXCLUDE_KINEMATIC | R.QueryFilterFlags.EXCLUDE_SENSORS;
      const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
      this.police.sight = (ax, ay, az, bx, by, bz) => {
        const dx = bx - ax;
        const dy = by - ay;
        const dz = bz - az;
        const len = Math.hypot(dx, dy, dz);
        if (len < 0.5) return true;
        ray.origin = { x: ax, y: ay, z: az };
        ray.dir = { x: dx / len, y: dy / len, z: dz / len };
        return world.castRay(ray, len - 0.3, true, flags) === null;
      };
    }
    this.worldCars = new WorldCars(worldPool, env.track, [IMPOUND_SPOT.carI, ...CROSSINGS, ...LEVELS.flatMap((l) => [l.carStart.i, l.playerStart.i]), ...CAREER.map((e) => e.level.playerStart.i)]);
    this.crime = new CrimeController(physics, character, charModel, scene.camera, city, this.police, this.worldCars, interaction, this.audio, this.particles, hud, rig, () => this.fillPlayerState());
    this.crime.onJailShotRay = (origin, direction, range) => { if (this.jailed) this.jail?.hitGuardRay(origin, direction, range); };
    this.crime.onJailAimRay = (origin, direction, range) => this.jailed && !!this.jail?.guardOnRay(origin, direction, range);
    this.crime.onShot = () => {
      if (this.settings.vibration) this.pad.rumble(0.35, 0.75, 90);
    };
    this.adsView = new AdsView(scene.scene, physics);
    this.casings = new Casings(scene.scene);
    this.crime.ads = this.adsView;
    this.crime.casings = this.casings;
    input.attachMouse(scene.renderer.domElement);
    this.missionInput = Object.assign(createMissionInput(), { dt: FIXED_DT, carPrev: this.carPrev });
    const canvas = scene.renderer.domElement;
    const sig = { signal: this.abort.signal };
    canvas.addEventListener('webglcontextlost', this.onContextLost, sig);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, sig);
    // Hidden page: pause gameplay, and silence audio in every state (title / briefing / results included).
    document.addEventListener(
      'visibilitychange',
      () => {
        this.audio.setHidden(document.hidden);
        if (document.hidden) this.pause();
      },
      sig,
    );
    // Another tab of the game saved progress: adopt it, so this tab never writes back a stale copy.
    window.addEventListener(
      'storage',
      (e) => {
        if (e.key === PROGRESS_KEY || e.key === null) this.syncProgress();
        if (e.key === SETTINGS_KEY || e.key === null) this.syncSettings();
      },
      sig,
    );
    window.addEventListener('pagehide', () => this.audio.setHidden(true), sig);
    window.addEventListener('pageshow', () => this.audio.setHidden(document.hidden), sig);
    this.audio.setHidden(document.hidden); // opened in a background tab
    window.addEventListener('blur', () => this.pause(), sig);
    // Any touch anywhere enables the touch layout in 'auto' mode.
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'touch' && !this.touchSeen) {
          this.touchSeen = true;
          this.updateTouchVisibility();
        }
      },
      { ...sig, capture: true },
    );
    // No pinch-zoom / page gestures on iOS (touch-action covers the rest).
    document.addEventListener('gesturestart', (e) => e.preventDefault(), sig);

    charModel.onFootstep = (k) => this.audio.footstep(k);
    vehicle.onWheelSlip = (x, y, z, s) => this.particles.tyre(x, y, z, s);
    this.sm.onChange((to, from) => this.onStateChange(to, from));

    this.applyAllSettings();
    this.menu.setProgress(progress);
    this.pois = buildPois(
      env.track,
      LEVELS,
      CAREER.map((e) => ({
        id: `career-${e.id}`,
        title: e.level.title,
        detail: `Career · ${e.tier} ${e.level.kind === 'race' ? 'race' : e.level.kind === 'timetrial' ? 'time trial' : 'sprint'}`,
        i: e.level.playerStart.i,
        off: Math.sign(e.level.playerStart.off || 1) * 7.9,
      })),
    );
    this.poiMarkers = new PoiMarkers(this.pois);
    scene.scene.add(this.poiMarkers.group);
    this.cityMap = new CityMap(env.track, env.footprints);
    this.applyPlayerCar();
    this.loadLevel(FREE_ROAM, -1);
    this.rig.setMode('showcase');
  }

  static async create(container: HTMLElement, onStatus: (s: string) => void): Promise<Game> {
    onStatus('Starting renderer…');
    const scene = new SceneManager(container);
    const settings = loadSettings();
    scene.applyQuality(settings.quality === 'auto' ? 'high' : settings.quality);
    let physics: PhysicsWorld | null = null;
    try {
      onStatus('Loading physics…');
      physics = await PhysicsWorld.create();
      onStatus('Building the city…');
      await nextFrame();
      const env = new Environment(scene.scene, physics, scene.maxAnisotropy);
      onStatus('Loading Quaternius buildings, vehicles and street assets…');
      await env.loadQuaterniusBuildings();
      const spawn = new Vector3();
      const yaw = env.track.startPose(spawn);
      const vehicle = new Vehicle(physics, scene.scene, spawn, yaw);
      // Race opponents: created once, parked and disabled until a race needs them.
      const opponents: Vehicle[] = [];
      for (let k = 0; k < 3; k++) {
        const v = new Vehicle(physics, scene.scene, new Vector3(0, -40 - k * 6, 0), 0, 0x333333);
        v.setActive(false);
        opponents.push(v);
      }
      // World cars the player can take (parked cars, traffic cars whose driver got out).
      const worldPool: Vehicle[] = [];
      for (let k = 0; k < 3; k++) {
        const v = new Vehicle(physics, scene.scene, new Vector3(0, -80 - k * 6, 400), 0, 0x777777);
        v.setActive(false);
        worldPool.push(v);
      }
      // Fourth police car: roadblocks (never used by races).
      const policeBlock = new Vehicle(physics, scene.scene, new Vector3(0, -120, 0), 0, 0x333333);
      policeBlock.setActive(false);
      onStatus('Loading character…');
      const asset = await loadCharacter();
      const character = new CharacterController(physics);
      const charModel = new CharacterModel(scene.scene, asset);
      const officers = new Officers(physics, asset, (a) => new CharacterModel(scene.scene, a));
      // Jail guards: the same character in a guard uniform (texture shared, built on first use).
      let guardTex: ReturnType<typeof uniformTexture> | undefined;
      const makeGuard = (): CharacterModel => {
        if (guardTex === undefined) {
          const src = characterPalette(asset.scene);
          guardTex = src ? uniformTexture(src, GUARD_UNIFORM) : null;
        }
        return new CharacterModel(scene.scene, uniformedClone(asset, guardTex));
      };

      let game: Game | null = null;
      const look = new LookInput(scene.renderer.domElement, () => undefined);
      const rig = new CameraRig(scene.camera, physics, look);
      const input = new InputManager((a: InputAction) => game?.handleAction(a));
      const touch = new TouchControls(container, (a) => input.emit(a));
      input.addSource(touch);
      const menu = new Menu(container, {
        onStartLevel: (i) => game?.startLevel(i),
        onStartCareer: (id) => game?.startCareer(id),
        onFreeRoam: () => game?.startFreeRoam(),
        onResume: () => game?.resume(),
        onRestart: () => game?.restart(),
        onQuit: () => game?.quitToMenu(),
        onNextLevel: () => game?.nextLevel(),
        onGarage: (a) => game?.garageAction(a),
        onGarageView: (id) => game?.previewCar(id),
        onMapSelect: (id) => game?.selectDestination(id),
        onSetting: (k, v) => game?.setSetting(k, v),
        onUiGesture: () => game?.uiGesture(),
        onScreen: (s) => game?.onScreen(s),
      });
      const hud = new HUD(container, {
        onPause: () => game?.togglePause(),
        onReset: () => game?.resetCar(),
        onMute: () => game?.toggleMute(),
        onMap: () => game?.openMap(),
        onContinue: () => game?.arrestContinue(),
        onCamera: () => game?.toggleCarView(),
      });
      const minimap = new Minimap(hud.minimapCanvas, env.track, env.footprints);
      const obstacles = new ObstacleManager(physics, env.track);
      scene.scene.add(obstacles.group);
      const visuals = new MissionVisuals(env.track);
      scene.scene.add(visuals.group);
      const mission = new MissionManager(env.track, obstacles, visuals, opponents);
      const interaction = new VehicleInteraction(physics);
      const particles = new Particles(scene.scene);
      const progress = loadProgress();
      const city = new CityLife(physics, scene.scene, env, asset);
      game = new Game(
        scene,
        physics,
        env,
        vehicle,
        opponents,
        worldPool,
        policeBlock,
        officers,
        character,
        charModel,
        rig,
        look,
        input,
        touch,
        hud,
        minimap,
        menu,
        obstacles,
        visuals,
        mission,
        interaction,
        particles,
        settings,
        progress,
        container,
        city,
        makeGuard,
      );

      onStatus('Compiling shaders…');
      await nextFrame();
      rig.follow.snap(vehicle);
      scene.updateShadowFocus(vehicle.object.position);
      scene.renderer.compile(scene.scene, scene.camera);
      menu.setReady();
      return game;
    } catch (err) {
      physics?.dispose();
      scene.dispose();
      throw err;
    }
  }

  get currentState(): GameStateName {
    return this.sm.state;
  }

  /** Begin the render loop (title screen with the showcase camera). */
  start(): void {
    if (this.rafId) return;
    this.menu.show('title');
    this.rafId = requestAnimationFrame(this.frame);
  }

  // ================================================================== level setup

  private paintColor(id = this.progress.paint): number {
    return (PAINTS.find((p) => p.id === id) ?? PAINTS[0]).color;
  }

  /** Make the player's car the selected garage vehicle: handling + upgrades, body, paint, engine sound. */
  private applyPlayerCar(): void {
    this.storeTyreWear(false);
    const id = this.progress.car;
    // The selected car is at the police impound: missions lend a stock car (the impounded one stays put).
    this.loaner = this.level.kind !== 'free' && isImpounded(this.progress, id);
    if (this.loaner) {
      const loan = vehicleById(DEFAULT_VEHICLE);
      this.ownCar.configure(loan, noUpgrades(), PAINTS[0].color, newCarSave(loan.id).look);
      this.loadTyreWear(null);
      if (this.vehicle === this.ownCar) this.applyEngineSound(this.ownCar);
      this.previewing = loan.id;
      return;
    }
    const def = vehicleById(id);
    const save = this.progress.cars[def.id];
    this.ownCar.configure(def, save.upgrades, this.paintColor(), save.look, save.setup);
    this.loadTyreWear(def.id);
    if (this.vehicle === this.ownCar) this.applyEngineSound(this.ownCar);
    this.previewing = def.id;
  }

  /** Owned car whose saved tyre wear is on the own car's tyres right now (null: loaner / showroom car, fresh tyres). */
  private wearOwner: string | null = null;
  private wearTimer = 0;

  private loadTyreWear(id: string | null): void {
    const save = id && this.progress.owned.includes(id) ? this.progress.cars[id] : null;
    this.wearOwner = save ? id : null;
    if (save) this.ownCar.physics.tyres.wear.set(save.tyreWear);
    else this.ownCar.fitNewTyres();
  }

  /** Copy the own car's tyre wear into its save (persist = also write it to storage) when it changed. */
  private storeTyreWear(persist: boolean): void {
    const id = this.wearOwner;
    if (!id) return;
    const changed = (): boolean => {
      const save = this.progress.cars[id];
      if (!save) return false;
      const w = this.ownCar.physics.tyres.wear;
      return w.some((x, i) => Math.abs(x - save.tyreWear[i]) >= 0.005);
    };
    if (!changed()) return;
    if (persist) this.syncProgress(); // write into the latest save (another tab may have changed it)
    const save = this.progress.cars[id];
    if (!save || !this.progress.owned.includes(id)) return;
    save.tyreWear = Array.from(this.ownCar.physics.tyres.wear, (x) => Math.round(x * 1000) / 1000);
    if (persist) saveProgress(this.progress);
  }

  /** Engine sound + rev counter of the car being driven. */
  private applyEngineSound(v: Vehicle): void {
    const def = vehicleById(v.vehicleId);
    const eng = v.physics.drivetrain.engine;
    this.audio.setEngineProfile(def.audio.cylinders, def.audio.pitch, def.audio.growl, eng.redlineRpm, def.audio.induction ?? 'none', def.audio.boost ?? 1);
    this.hud.setEngine(eng.redlineRpm, eng.limiterRpm);
  }

  /** Make `v` the car the player drives (the previous one stays where it is, parked). */
  private setDriven(v: Vehicle): void {
    if (this.vehicle === v) return;
    this.vehicle.onWheelSlip = null;
    this.vehicle = v;
    v.onWheelSlip = (x, y, z, s) => this.particles.tyre(x, y, z, s);
    this.cityActors.player = v;
    this.applyEngineSound(v);
    this.hud.setDamage(damageLevel(v.damage));
    if (vehicleById(v.vehicleId).style === 'motorcycle') this.hud.toast('Bike: steer with A / D; the bike leans with your turn. Brake early in rain.', 4200);
  }

  /** Rebuild the list of other dynamic vehicles (rivals / police, idle own car, world cars) for the city. */
  private fillOtherCars(): void {
    const o = this.otherCars;
    o.length = 0;
    for (const v of this.opponents) if (v.isActive) o.push(v);
    if (this.policeBlock.isActive) o.push(this.policeBlock);
    if (this.ownCar !== this.vehicle && this.ownCar.isActive) o.push(this.ownCar);
    this.worldCars.forEachIdle(this.vehicle, (v) => o.push(v));
  }

  /**
   * Adopt progress saved by another tab of the game since this tab last read or wrote it. Called on 'storage'
   * events and right before every change to progress (purchase, upgrade, repair, fine, results), so a change
   * is always applied to the latest save (read + modify + write in one synchronous step) instead of
   * overwriting another tab's purchases or rewards with a stale copy.
   */
  private syncProgress(): boolean {
    const stored = readStoredProgress();
    if (!stored || !adoptProgress(this.progress, stored)) return false;
    if (this.sm.is('menu')) {
      // Menu stage: show the (possibly changed) selected car, or keep previewing the car being browsed.
      const browsing = this.menu.screen === 'garage' && this.previewing && this.previewing !== this.progress.car ? this.previewing : null;
      this.applyPlayerCar();
      if (browsing) this.previewCar(browsing);
    }
    // In a run the car being driven stays as it is; the existing garage / next-run paths apply the new selection.
    this.menu.setProgress(this.progress);
    return true;
  }

  /** Car currently shown on the menu stage (garage browsing). */
  private previewing = '';

  // ------------------------------------------------------------ navigation
  private pois: Poi[] = [];
  private poiMarkers: PoiMarkers | null = null;
  private cityMap: CityMap | null = null;
  /** Selected free-roam destination. */
  private navDest: Poi | null = null;
  private navDir: 1 | -1 | 0 = 0;
  private navTimer = 0;
  /** POI the player can act on right now (prompt shown). */
  private poiPrompt: Poi | null = null;
  private interiorAction: { index: number; exit: boolean } | null = null;
  private activeInterior = -1;
  private readonly interiorReturn = new Vector3();
  private interiorReturnYaw = 0;
  /** First serious damage of the session has been announced. */
  private damageWarned = false;
  private fxTime = 0;
  /** Audio bookkeeping: last gear heard, nearest traffic car and its previous distance (Doppler). */
  private lastGear = 0;
  private passCar: unknown = null;
  private passPrevDist = 0;
  /** Which screen the paused state shows. */
  private pauseScreen: 'pause' | 'map' | 'garage' = 'pause';

  private pose(p: TrackPos, out: Vector3): number {
    const t = this.env.track;
    const i = ((Math.round(p.i) % t.count) + t.count) % t.count;
    out.set(t.px[i] + t.rx(i) * p.off, 0, t.pz[i] + t.rz(i) * p.off);
    return Math.atan2(-t.tz[i], t.tx[i]);
  }

  /** Lay out a level: obstacles, gates, car, character, opponents. Leaves the state unchanged. */
  private loadLevel(level: LevelDef, index: number, careerId: string | null = null): void {
    this.activeInterior = -1;
    this.interiorAction = null;
    if (level.kind !== 'free') this.navDest = null;
    this.careerId = careerId;
    this.markers.routeCount = 0;
    this.markers.pois = null;
    this.hud.setNav(null);
    this.level = level;
    this.levelIndex = index;
    // Police only patrol free roam; release the pooled cars before the mission claims them.
    this.police.setEnabled(false, null);
    this.hud.setWanted(0, 'clear');
    this.mission.load(level, index);
    this.casings.clear();
    this.placeActors();
  }

  /** Reset actors to the level's start (also used for restart). */
  private placeActors(): void {
    const level = this.level;
    // Any arrest in progress is dropped (its penalty is already saved); the jail scene is left (the sentence stays saved).
    this.abortArrest();
    this.closeJail();
    // Back in the own car; world cars are released (nothing taken survives a restart or a mode change).
    this.setDriven(this.ownCar);
    this.worldCars.setEnabled(level.kind === 'free');
    this.crime.setEnabled(level.kind === 'free');
    // Free roam: grass, pavement, wet roads and puddles change the grip; missions run on the calibrated dry road.
    for (const car of this.allCars) car.physics.surface = level.kind === 'free' ? this.grip : null;
    // New session: magazine full, reserve topped up to the starting amount (never reduced).
    this.crime.weapon.resetLoadout(Math.max(START_RESERVE, this.crime.weapon.reserve));
    this.character.setCrouch(false);
    // Always start with the selected car (the garage preview may have changed the body), undamaged.
    this.applyPlayerCar();
    this.vehicle.repair();
    this.hud.setDamage(0);
    this.damageWarned = false;
    this.env.resetProps();
    this.mission.reset();
    // Car: parked, engine off.
    const carYaw = this.pose(level.carStart, this.tmp);
    this.vehicle.reset(this.tmp, carYaw);
    this.vehicle.skids.clear();
    this.trackIndex = ((level.carStart.i % this.env.track.count) + this.env.track.count) % this.env.track.count;
    // Character: on the pavement, facing along the road towards the car.
    const roadYaw = this.pose(level.playerStart, this.feet);
    this.feet.y = 0.15;
    const t = this.env.track;
    const k = ((level.playerStart.i % t.count) + t.count) % t.count;
    const ground = this.groundHeight(this.feet.x, this.feet.z);
    this.feet.y = ground ?? 0.15;
    // Character yaw convention: forward = (sin yaw, cos yaw); road tangent (tx, tz).
    const charYaw = Math.atan2(t.tx[k], t.tz[k]);
    void roadYaw;
    this.character.setEnabled(true);
    this.character.teleport(this.feet, charYaw);
    this.charTrackIndex = k;
    this.charModel.resetPose();
    this.charModel.setOpacity(1);
    this.charModel.root.position.copy(this.feet);
    this.charModel.root.rotation.set(0, charYaw, 0);
    this.rig.character.snap(this.feet, charYaw);
    this.rig.follow.snap(this.vehicle);
    this.particles.clear();
    this.pendingResult = null;
    this.accumulator = 0;
    this.jumpQueued = false;
    this.carPrev.copy(this.vehicle.physicsPosition);
    this.audio.setEngineOn(false);
    const cp = this.vehicle.physicsPosition;
    this.ownAtLot = false;
    this.syncImpoundedCar();
    this.city.configure(level.kind === 'free' || !!level.traffic, this.feet.x, this.feet.z, [[cp.x, cp.z]], level.traffic === 'same' ? 1 : 0, !!(level.race && level.traffic), level.traffic ? (level.trafficDensity ?? MISSION_TRAFFIC_DENSITY) : undefined);
    this.missionRedLight.reset();
  }

  private groundHeight(x: number, z: number): number | null {
    const { world, R } = this.physics;
    const F = R.QueryFilterFlags;
    const ray = new R.Ray({ x, y: 5, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 10, true, F.EXCLUDE_DYNAMIC | F.EXCLUDE_KINEMATIC | F.EXCLUDE_SENSORS);
    return hit ? 5 - hit.timeOfImpact : null;
  }

  // ================================================================== flow

  startLevel(index: number): void {
    if (this.contextLost || index < 0 || index >= LEVELS.length || !isMissionUnlocked(this.progress, index)) return;
    this.audio.start();
    if (this.sm.state !== 'briefing' && !this.sm.go('briefing')) return;
    this.loadLevel(LEVELS[index], index);
    this.beginPlay();
  }

  /** Start a career event (from its briefing or a city marker). Locked events are ignored. */
  startCareer(id: string): void {
    const ev = careerEvent(id);
    if (this.contextLost || !ev || !isCareerUnlocked(this.progress, id)) return;
    this.audio.start();
    if (this.sm.state !== 'briefing' && !this.sm.go('briefing')) return;
    this.loadLevel(ev.level, -2, id);
    this.beginPlay();
  }

  startFreeRoam(): void {
    if (this.contextLost) return;
    this.audio.start();
    this.loadLevel(FREE_ROAM, -1);
    if (this.sm.state === 'briefing') this.sm.go('menu');
    this.beginPlay();
  }

  private beginPlay(): void {
    if (!this.sm.go('onFoot')) return;
    this.menu.hideAll();
    this.rig.setMode('character', 0);
    this.rig.character.snap(this.character.position, this.character.yaw);
    if (this.level.kind !== 'free') this.hud.pop(this.level.title, 'good', 1800);
    if (this.level.kind === 'free' && !this.progress.jail && isImpounded(this.progress, this.ownCar.vehicleId)) {
      this.hud.toast(`Your ${vehicleById(this.ownCar.vehicleId).name} is at the police impound lot (P on the map)`, 3200);
    }
    if (this.loaner) this.hud.toast(`Your ${vehicleById(this.progress.car).name} is impounded: you get a loaner for this event`, 3200);
    this.startPolice();
  }

  /** Free roam: (re)start the police patrol with a clean record. */
  private startPolice(): void {
    this.police.setEnabled(false, null);
    this.hud.setWanted(0, 'clear');
    // Free roam holds the busted state for the arrest sequence (it releases it); missions auto-release.
    this.police.wanted.autoRelease = this.level.kind !== 'free';
    // Still serving a sentence (arrested, then quit or reloaded): back to the jail, not the street.
    if (this.level.kind === 'free' && this.progress.jail) {
      this.enterJail();
      return;
    }
    if (this.level.kind === 'free') this.police.setEnabled(true, this.fillPlayerState());
  }

  // ================================================================== arrest / impound / jail

  /**
   * Busted in free roam. The penalty, the impound and the jail sentence are saved right away (so quitting
   * or reloading mid-arrest changes nothing), then the arrest plays out: officers close in, the player gets
   * out (forced after a few seconds), is cuffed and walked to the police car, short skippable transfer, jail.
   */
  private beginArrest(stars: number): void {
    if (this.arrest.active || this.jailed) return;
    this.syncProgress();
    const p = this.progress;
    const fine = WantedSystem.fine(stars, p.credits);
    p.credits -= fine;
    const ps = this.fillPlayerState();
    const inCar = ps.inCar;
    // The car used in the chase: the one being driven, or the one the player just left (close by).
    const cp = this.vehicle.physicsPosition;
    let vehicle: ArrestSummary['vehicle'] = { kind: 'none', name: '', fee: 0 };
    if (inCar || Math.hypot(cp.x - ps.x, cp.z - ps.z) < 25) {
      const name = vehicleById(this.vehicle.vehicleId).name;
      if (this.vehicle === this.ownCar) {
        if (!this.loaner && impoundCar(p, this.ownCar.vehicleId, impoundFee(stars))) vehicle = { kind: 'own', name, fee: p.impound[this.ownCar.vehicleId] };
      } else vehicle = { kind: 'stolen', name, fee: 0 };
    }
    const bail = bailFor(stars);
    p.jail = { checkpoint: 0, bail, items: [] };
    p.arrests++;
    saveProgress(p);
    this.menu.setProgress(p);
    this.arrest.begin({ stars, fine, vehicle, bail });
    this.arrestSkip = false;
    this.crime.weapon.forceHolster();
    this.character.setCrouch(false);
    this.navDest = null;
    // The nearest unit's crew makes the arrest (already out on foot, or getting out now).
    this.arrestUnit = this.police.unitNear(ps.x, ps.z);
    this.arrestOfficers.length = 0;
    for (const o of this.officers.list) if (o.mode !== 'off' && o.unit === this.arrestUnit && this.arrestOfficers.length < 2) this.arrestOfficers.push(o.id);
    const car = this.police.unitVehicle(this.arrestUnit);
    if (car) {
      const q = car.physicsPosition;
      const [fx, fz] = this.carForward(car);
      this.arrestSide = (ps.x - q.x) * -fz + (ps.z - q.z) * fx > 0 ? 1 : -1;
      while (this.arrestOfficers.length < 2) {
        const o = this.officers.deploy(this.arrestUnit, car, this.arrestOfficers.length === 0 ? this.arrestSide : -this.arrestSide, 'chase');
        if (!o) break;
        this.arrestOfficers.push(o.id);
      }
    }
    this.hud.setBanner('Busted', inCar ? 'Get out of the car (E)' : 'Hands up: you are under arrest', 'bad');
    this.audio.failure();
  }

  /** Planar forward (x, z) of a car (its local +X). */
  private carForward(v: Vehicle): [number, number] {
    const r = v.physics.body.rotation();
    const fx = 1 - 2 * (r.y * r.y + r.z * r.z);
    const fz = 2 * (r.x * r.z - r.w * r.y);
    const l = Math.hypot(fx, fz) || 1;
    return [fx / l, fz / l];
  }

  /** Rear door of the arresting unit on the player's side (escort target), or null. */
  private arrestDoor(): { x: number; z: number } | null {
    const car = this.police.unitVehicle(this.arrestUnit);
    if (!car) return null;
    const q = car.physicsPosition;
    const [fx, fz] = this.carForward(car);
    const s = this.arrestSide;
    return { x: q.x - fz * s * 1.5 - fx * 0.6, z: q.z + fx * s * 1.5 - fz * 0.6 };
  }

  /** Escort: the player walks to the police car door (fixed step input), else stands still. */
  private arrestMove(): [number, number] {
    if (this.arrest.phase !== 'escort') return [0, 0];
    const d = this.arrestDoor();
    if (!d) return [0, 0];
    const c = this.character.position;
    const dx = d.x - c.x;
    const dz = d.z - c.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.3) return [0, 0];
    const m = Math.min(0.8, l / 0.8 + 0.2);
    return [(dx / l) * m, (dz / l) * m];
  }

  /** Arrest sequence, fixed step (before the police / officers step). */
  private stepArrest(dt: number): void {
    const a = this.arrest;
    const st = this.sm.state;
    const inCar = st === 'driving' || st === 'entering';
    if (a.active) {
      const c = this.character.position;
      let near = Infinity;
      for (const i of this.arrestOfficers) {
        const o = this.officers.list[i];
        if (o && o.mode !== 'off') near = Math.min(near, Math.hypot(o.ctrl.position.x - c.x, o.ctrl.position.z - c.z));
      }
      // No officer could get out (pool used up): the capture still completes when the timer runs out.
      const door = this.arrestDoor();
      const atDoor = door ? Math.hypot(door.x - c.x, door.z - c.z) < 0.9 : true;
      a.step(dt, { inCar, officerDist: inCar ? Infinity : near, atDoor, skip: this.arrestSkip });
      const evs = a.events.splice(0);
      for (const e of evs) this.onArrestEvent(e);
    }
    if (a.active) {
      const ph = a.phase;
      const target = inCar ? this.vehicle.physicsPosition : this.character.position;
      const px = target.x;
      const pz = target.z;
      const yaw = this.character.yaw;
      this.arrestOfficers.forEach((id, k) => {
        const o = this.officers.list[id];
        if (!o || o.mode === 'off') return;
        const ox = o.ctrl.position.x;
        const oz = o.ctrl.position.z;
        const d = Math.hypot(px - ox, pz - oz) || 1;
        const face = Math.atan2(px - ox, pz - oz);
        if (ph === 'surrender') {
          // First officer to arm's length (outside the car's door at a distance), the second covers from further back.
          const stand = k === 0 ? (inCar ? 3.4 : CUFF_RANGE * 0.6) : 4.5;
          this.officers.script(id, px - ((px - ox) / d) * stand, pz - ((pz - oz) / d) * stand, d > 7, face, true);
        } else if (ph === 'cuffed' || ph === 'escort') {
          if (k === 0) {
            // At the player's right shoulder, half a step behind.
            const tx = px - Math.sin(yaw) * 0.45 + Math.cos(yaw) * 0.65;
            const tz = pz - Math.cos(yaw) * 0.45 - Math.sin(yaw) * 0.65;
            this.officers.script(id, tx, tz, false, ph === 'cuffed' ? face : null, false);
          } else this.officers.script(id, ox, oz, false, face, ph === 'cuffed');
        } else this.officers.script(id, ox, oz, false, null, false);
      });
    }
    const up = a.active && !inCar && (a.phase === 'surrender' || a.phase === 'cuffed' || a.phase === 'escort');
    this.handsW = Math.max(0, Math.min(1, this.handsW + (up ? 1 : -1) * HANDS_RATE * dt));
  }

  private onArrestEvent(e: string): void {
    const s = this.arrest.summary;
    if (e === 'forceExit') {
      this.hud.setBanner('Busted', 'Out of the car!', 'bad');
      if (this.sm.state === 'driving') this.tryExit();
    } else if (e === 'cuffed') {
      this.hud.setBanner('Busted', 'You are under arrest', 'bad');
      this.audio.door(true);
    } else if (e === 'escort') {
      this.hud.setBanner('Busted', 'Escorted to the police car', 'bad');
    } else if (e === 'transfer' && s) {
      this.fadeTarget = 1;
      this.hud.setBanner(null);
      this.touch.setLayout('none');
      const stars = '★'.repeat(s.stars) + '☆'.repeat(Math.max(0, 3 - s.stars));
      const rows: Array<[string, string]> = [
        ['Wanted level', stars],
        ['Fine', s.fine > 0 ? `−${s.fine.toLocaleString('en-US')} cr` : 'none (no credits)'],
      ];
      if (s.vehicle.kind === 'own') rows.push(['Impounded', `${s.vehicle.name} · release fee ${s.vehicle.fee.toLocaleString('en-US')} cr`]);
      else if (s.vehicle.kind === 'stolen') rows.push(['Vehicle', `${s.vehicle.name} (stolen) returned to its owner`]);
      rows.push(['Bail', `${s.bail.toLocaleString('en-US')} cr`]);
      this.hud.setArrestCard({
        title: 'Arrested',
        rows,
        note:
          (s.vehicle.kind === 'own' ? 'Recover your car at the impound lot (P on the map). ' : '') +
          'Your other cars, upgrades and progress are untouched. Break out of the county jail, or post bail from the phone in your cell.',
        canContinue: true,
      });
    } else if (e === 'done') {
      this.enterJail();
    }
  }

  /** Arrest card: Continue (button / E) skips the rest of the transfer. */
  arrestContinue(): void {
    if (this.arrest.phase === 'transfer') this.arrestSkip = true;
  }

  /** Leaving the level mid-arrest: the record is already saved; just drop the sequence and its UI. */
  private abortArrest(): void {
    if (this.arrest.active) {
      this.arrest.reset();
      this.officers.clear();
    }
    this.arrestOfficers.length = 0;
    this.arrestUnit = -1;
    this.arrestSkip = false;
    this.handsW = 0;
    this.hud.setBanner(null);
    this.hud.setArrestCard(null);
    this.fade = 0;
    this.fadeTarget = 0;
    this.hud.setFade(0);
  }

  /** Put the character on its feet at (x, y, z) facing `yaw`, camera behind it. */
  private placeCharacter(x: number, y: number, z: number, yaw: number): void {
    const c = this.character;
    c.setEnabled(true);
    this.feet.set(x, y, z);
    c.teleport(this.feet, yaw);
    // Stand up at the new spot (from a crawl space the old spot has no headroom).
    c.setCrouch(false);
    this.charModel.resetPose();
    this.charModel.setVisible(true);
    this.charModel.setOpacity(1);
    this.charModel.root.position.copy(this.feet);
    this.charModel.root.rotation.set(0, yaw, 0);
    this.rig.setMode('character', 0);
    this.rig.character.snap(this.feet, yaw);
  }

  private jailPlayer(): JailPlayer {
    const c = this.character;
    return { x: c.position.x, y: c.position.y, z: c.position.z, crouched: c.crouched, speed: c.actualSpeed };
  }

  private jailCtx(): JailContext {
    return { credits: this.progress.credits, bail: this.progress.jail?.bail ?? 0 };
  }

  /** Into the jail (end of an arrest, or free roam started while still sentenced). */
  private enterJail(): void {
    const save = this.progress.jail;
    if (!save) return;
    this.arrest.reset();
    this.arrestOfficers.length = 0;
    this.arrestSkip = false;
    this.handsW = 0;
    this.hud.setArrestCard(null);
    this.hud.setBanner(null);
    // A taken world car is towed away (back to the street pool); the own car goes to the impound lot.
    if (this.vehicle !== this.ownCar) this.setDriven(this.ownCar);
    this.worldCars.setEnabled(false);
    this.police.wanted.release();
    this.police.setEnabled(false, null);
    this.officers.clear();
    this.hud.setWanted(0, 'clear');
    // Sentence start confiscates the old loadout, but the escape scenario intentionally provides a basic sidearm.
    this.crime.setEnabled(true);
    this.crime.weapon.resetLoadout();
    this.syncImpoundedCar();
    if (this.sm.state !== 'onFoot') this.sm.go('onFoot');
    this.audio.setEngineOn(false);
    this.touch.setLayout('foot');
    if (!this.jail) {
      this.jail = new JailEscape(this.physics, this.makeGuard, this.scene.scene);
      this.jail.setGuidedSupport(this.settings.escapeSupport === 'guided');
    }
    const s = this.jail.enter(save);
    this.placeCharacter(s.x, s.y, s.z, s.yaw);
    this.city.configure(false, s.x, s.z, []);
    this.jailed = true;
    this.jailTorchOn = false;
    this.navDest = null;
    this.hud.setNav(null);
    this.visuals.setBeacon(null);
    this.visuals.setCarMarker(null);
    this.hud.setMapVisible(false);
    this.fade = 1;
    this.fadeTarget = 0;
    this.hud.pop('E cutoff · 1 gun · Q or right mouse aim · Z or left click fire · R reload · T torch', 'bad', 5200);
  }

  /** Out of the jail: escaped (wanted, searched for) or bailed out (clean). */
  private leaveJail(how: 'escaped' | 'bail', route = ''): void {
    if (!this.jailed) return;
    this.syncProgress();
    const p = this.progress;
    const bail = p.jail?.bail ?? 0;
    if (how === 'bail') {
      if (p.credits < bail) {
        this.hud.toast(`Bail is ${bail.toLocaleString('en-US')} cr`, 1800);
        return;
      }
      p.credits -= bail;
    }
    p.jail = null;
    saveProgress(p);
    this.menu.setProgress(p);
    this.jail?.exit();
    this.jailed = false;
    this.hud.setMapVisible(true);
    this.hud.setDetect(null);
    this.hud.setMission(null, null);
    // Out on the pavement by the impound lot.
    const t = this.env.track;
    const i = IMPOUND_SPOT.releaseI;
    const x = t.px[i] + t.rx(i) * IMPOUND_SPOT.off;
    const z = t.pz[i] + t.rz(i) * IMPOUND_SPOT.off;
    this.placeCharacter(x, (this.groundHeight(x, z) ?? 0) + 0.02, z, Math.atan2(-t.tx[i], -t.tz[i]));
    this.crime.setEnabled(true);
    this.crime.weapon.resetLoadout(Math.max(START_RESERVE, this.crime.weapon.reserve));
    this.worldCars.setEnabled(true);
    this.syncImpoundedCar();
    const cp = this.ownCar.physicsPosition;
    this.city.configure(true, x, z, [[cp.x, cp.z]]);
    this.police.setEnabled(true, this.fillPlayerState());
    if (how === 'escaped') {
      this.police.wanted.report();
      this.audio.fanfare();
      const via = route === 'tunnel' ? 'through the drain tunnel' : route === 'yard' ? 'over the yard' : 'through the front gate';
      this.hud.pop(`You broke out ${via}! Lie low: the police are searching`, 'good', 3200);
    } else {
      this.audio.checkpoint();
      this.hud.pop('Bail posted: you are free to go', 'good', 2600);
    }
    if (isImpounded(p, this.ownCar.vehicleId)) this.hud.toast(`Your ${vehicleById(this.ownCar.vehicleId).name} is at the impound lot just down the street`, 3200);
    this.fade = 1;
    this.fadeTarget = 0;
  }

  /** Leave the jail scene without serving / clearing the sentence (quit, mode change). */
  private closeJail(): void {
    if (!this.jailed) return;
    this.jail?.exit();
    this.jailed = false;
    this.hud.setMapVisible(true);
    this.hud.setDetect(null);
  }

  private saveJail(): void {
    if (!this.jail || !this.jailed) return;
    this.syncProgress();
    const p = this.progress;
    if (!p.jail) return;
    p.jail = this.jail.save(p.jail.bail);
    saveProgress(p);
  }

  private processJailEvents(): void {
    const j = this.jail;
    if (!j || !j.events.length) return;
    const evs = j.events.splice(0);
    for (const e of evs) {
      switch (e.type) {
        case 'caught': {
          const s = j.spawnFor(e.checkpoint);
          this.fade = 1;
          this.fadeTarget = 0;
          this.placeCharacter(s.x, s.y, s.z, s.yaw);
          this.audio.failure();
          this.hud.pop(e.checkpoint >= 1 ? 'Caught! Back to the maintenance room' : 'Caught! Back in your cell', 'bad', 2600);
          this.saveJail();
          break;
        }
        case 'escaped':
          this.leaveJail('escaped', e.route);
          return;
        case 'bail':
          this.leaveJail('bail');
          return;
        case 'checkpoint':
          this.audio.checkpoint();
          this.hud.pop('Checkpoint', 'good', 1400);
          this.saveJail();
          break;
        case 'item':
          this.audio.checkpoint();
          this.saveJail();
          break;
        case 'toast':
          if (e.text.startsWith('Power cut:') || e.text.startsWith('Emergency circuit cut:') || e.text.startsWith('Maintenance power cut:')) { this.jailTorchOn = true; this.hud.toast(`${e.text} — torch on (T toggles)`, 3000); }
          else this.hud.toast(e.text, 2400);
          break;
        case 'spotted':
          this.audio.penalty();
          break;
      }
    }
  }

  /**
   * Free roam: an impounded selected car stands at the impound lot, where it can be released (fee at the
   * office) or broken out (entering it: wanted). Released, it stays where it is.
   */
  private syncImpoundedCar(): void {
    if (this.level.kind !== 'free' || this.loaner) return;
    const imp = isImpounded(this.progress, this.ownCar.vehicleId);
    if (imp && !this.ownAtLot) {
      const t = this.env.track;
      const i = IMPOUND_SPOT.carI;
      this.tmp.set(t.px[i] + t.rx(i) * IMPOUND_SPOT.carOff, 0, t.pz[i] + t.rz(i) * IMPOUND_SPOT.carOff);
      this.ownCar.reset(this.tmp, Math.atan2(-t.tz[i], t.tx[i]));
      this.ownAtLot = true;
    } else if (!imp) this.ownAtLot = false;
  }

  private fillPlayerState(): PlayerState {
    const s = this.playerState;
    s.inCar = this.sm.state === 'driving' || this.sm.state === 'exiting' || this.sm.state === 'entering';
    if (s.inCar) {
      const p = this.vehicle.physicsPosition;
      const v = this.vehicle.physics.body.linvel();
      s.x = p.x;
      s.z = p.z;
      s.vx = v.x;
      s.vz = v.z;
      s.speed = Math.abs(this.vehicle.physics.forwardSpeed);
      s.idx = this.trackIndex;
    } else {
      const c = this.character;
      s.x = c.position.x;
      s.z = c.position.z;
      s.vx = c.velocity.x;
      s.vz = c.velocity.z;
      s.speed = Math.hypot(s.vx, s.vz);
      s.idx = this.charTrackIndex;
    }
    return s;
  }

  private processPoliceEvents(): void {
    const ps = this.police;
    if (ps.reported.length) {
      this.hud.pop(OFFENCE_TEXT[ps.reported[ps.reported.length - 1]], 'bad', 1300);
      ps.reported.length = 0;
    }
    const w = ps.wanted;
    for (const e of w.events) {
      if (e.type === 'escaped') {
        this.hud.pop('You lost the police', 'good', 2000);
        this.audio.checkpoint();
      } else if (e.type === 'busted' && this.level.police) {
        // Police Escape: the arrest ends the mission (no fine).
        this.audio.failure();
        this.hud.pop('Busted!', 'bad', 2000);
      } else if (e.type === 'busted') {
        // Free roam: the arrest sequence (officers, escort, transfer) → impound + jail.
        this.beginArrest(e.stars);
      }
    }
    w.events.length = 0;
    if (ps.enabled) this.hud.setWanted(w.stars, w.state);
  }

  restart(): void {
    if (this.contextLost || this.sm.is('menu', 'briefing')) return;
    this.audio.start();
    this.placeActors();
    if (this.sm.go('onFoot')) {
      this.startPolice();
      this.menu.hideAll();
      this.rig.setMode('character', 0);
      this.rig.character.snap(this.character.position, this.character.yaw);
      this.hud.toast('Restarted', 1000);
    }
  }

  nextLevel(): void {
    if (this.careerId) {
      const k = CAREER.findIndex((e) => e.id === this.careerId);
      const nxt = CAREER[k + 1];
      if (nxt && isCareerUnlocked(this.progress, nxt.id)) this.menu.showCareerBriefing(nxt.id);
      return;
    }
    const next = this.levelIndex + 1;
    if (next >= LEVELS.length || !isMissionUnlocked(this.progress, next)) return;
    this.menu.showBriefing(next);
  }

  quitToMenu(): void {
    if (!this.sm.go('menu')) return;
    this.loadLevel(FREE_ROAM, -1);
    this.rig.setMode('showcase', 0.6);
    this.menu.show('title');
  }

  pause(): void {
    if (!this.sm.simulating) return;
    this.pauseScreen = 'pause';
    this.sm.go('paused');
  }

  // ================================================================== navigation

  /** City map (N key, HUD map button, tapping the minimap). Pauses the game while open. */
  openMap(): void {
    if (this.sm.state === 'paused' && this.menu.screen === 'map') {
      this.resume();
      return;
    }
    if (!this.sm.is('onFoot', 'driving')) return;
    if (this.jailed || this.arrest.active) {
      this.hud.toast(this.jailed ? 'No city map in jail' : 'You are under arrest', 1400);
      return;
    }
    this.pauseScreen = 'map';
    this.sm.go('paused');
  }

  private get navPos(): { x: number; z: number; i: number; fx: number; fz: number } {
    const inCar = this.inCar;
    const p = inCar ? this.vehicle.physicsPosition : this.character.position;
    const f = inCar ? this.vehicle.forward : this.camFwd;
    return { x: p.x, z: p.z, i: inCar ? this.trackIndex : this.charTrackIndex, fx: f.x, fz: f.z };
  }

  private mapModel(): MapModel {
    const free = this.level.kind === 'free';
    const pos = this.navPos;
    const t = this.env.track;
    const route = this.markers.route;
    const destinations = free
      ? this.pois.map((p) => ({
          id: p.id,
          kind: p.kind,
          label: p.kind === 'mission' ? `${p.label}: ${p.detail}` : p.label,
          detail: p.kind === 'mission' ? 'Walk or drive here to start' : p.kind === 'event' ? `${p.detail} · walk or drive here to enter` : p.detail,
          meters: planRoute(t, pos.i, p.i).meters,
          locked: this.poiLock(p),
          x: p.x,
          z: p.z,
        }))
      : null;
    const kind = this.mission.target(this.vehicle.physicsPosition, this.inCar, this.target);
    const objective = !free && kind !== null && kind !== 'car' ? { x: this.target.x, z: this.target.z } : null;
    const car = this.inCar ? null : { x: this.vehicle.physicsPosition.x, z: this.vehicle.physicsPosition.z };
    return {
      subtitle: free
        ? 'Choose a destination: the route appears on your minimap and a beacon marks the spot.'
        : 'Mission in progress: follow the green marker. Destinations can be chosen in Free Roam.',
      destinations,
      destId: this.navDest?.id ?? null,
      draw: (canvas) =>
        this.cityMap!.draw(canvas, {
          x: pos.x,
          z: pos.z,
          fx: pos.fx,
          fz: pos.fz,
          onFoot: !this.inCar,
          car,
          pois: free ? this.pois : [],
          destId: this.navDest?.id ?? null,
          route,
          routeCount: free && this.navDest ? this.markers.routeCount : 0,
          objective,
        }),
    };
  }

  /** Choose (or clear) the free-roam destination from the map, then return to the game. */
  selectDestination(id: string | null): void {
    if (this.level.kind !== 'free') return;
    const poi = id ? (this.pois.find((p) => p.id === id) ?? null) : null;
    this.navDest = poi;
    this.navDir = 0;
    this.navTimer = 0;
    this.markers.routeCount = 0;
    this.resume();
    this.updateNav(0, true);
    if (poi) this.hud.toast(`Route set: ${poi.kind === 'mission' ? `${poi.label} · ${poi.detail}` : poi.label}`);
  }

  /** Route, HUD pill, beacon and arrival (free roam). Runs at 5 Hz; `force` recomputes now. */
  private updateNav(dt: number, force = false): void {
    const free = this.level.kind === 'free';
    const m = this.markers;
    m.pois = free ? this.pois : null;
    m.destId = this.navDest?.id ?? null;
    this.poiMarkers?.setVisible(free && !this.jailed && this.sm.state !== 'menu');
    this.poiMarkers?.update(dt, m.destId);
    const dest = free && !this.jailed ? this.navDest : null;
    if (!dest) {
      if (m.routeCount !== 0 || force) {
        m.routeCount = 0;
        this.hud.setNav(null);
      }
      return;
    }
    // Objective arrow on the minimap rim + light beacon over the destination.
    m.hasTarget = true;
    m.targetX = dest.x;
    m.targetZ = dest.z;
    this.visuals.setBeacon(dest.x, dest.z, 0x34e89e);
    // 5 Hz, on simulation time (route updates only matter while the game runs).
    if (!force && Math.abs(this.sm.time - this.navTimer) < 0.2) return;
    this.navTimer = this.sm.time;
    const pos = this.navPos;
    if (poiDistance(dest, pos.x, pos.z) <= ARRIVE_RADIUS) {
      this.hud.toast(`Arrived: ${dest.kind === 'mission' ? `${dest.label} · ${dest.detail}` : dest.label}`);
      this.navDest = null;
      m.routeCount = 0;
      m.hasTarget = false;
      this.visuals.setBeacon(null);
      this.hud.setNav(null);
      return;
    }
    const plan = planRoute(this.env.track, pos.i, dest.i, this.navDir);
    this.navDir = plan.dir;
    m.routeCount = routePolyline(this.env.track, pos.x, pos.z, pos.i, plan, dest, m.route);
    const behind = this.inCar && Math.abs(this.vehicle.physics.forwardSpeed) > 1 && routeHeading(this.env.track, pos.i, plan, pos.fx, pos.fz) === 'behind';
    this.hud.setNav(dest.kind === 'mission' ? `${dest.label} · ${dest.detail}` : dest.label, Math.max(plan.meters, poiDistance(dest, pos.x, pos.z)), behind);
  }

  private onCarDamaged(hit: HitResult): void {
    const level = damageLevel(this.vehicle.damage);
    this.hud.setDamage(level);
    if (!this.damageWarned && (level >= 0.45 || hit.brokeLamps.length > 0)) {
      this.damageWarned = true;
      this.hud.toast(this.level.kind === 'free' ? 'Car damaged: repair it at the garage' : 'Car damaged');
    }
  }

  /** Garage tyre row: wear of the selected car's tyres and the price of a new set. */
  private updateTyreRow(): void {
    this.storeTyreWear(false);
    const p = this.progress;
    this.menu.setTyres(p.owned.includes(p.car) ? tyrePrice(p, p.car) : 0, p.owned.includes(p.car) ? tyreWearOf(p, p.car) : 0);
  }

  /** Garage repair price for the current car (0 = nothing to repair). */
  private get repairPrice(): number {
    return isDamaged(this.ownCar.damage) ? repairCost(this.ownCar.damage, vehicleById(this.ownCar.vehicleId).upgradeCost) : 0;
  }

  /** Why a POI can't be used yet (null = open). */
  private poiLock(p: Poi): string | null {
    if (p.kind === 'mission') {
      const why = missionLockReason(this.progress, p.index);
      return why ? `Locked — ${why.charAt(0).toLowerCase()}${why.slice(1)}` : null;
    }
    if (p.kind === 'event') {
      const st = careerStatus(this.progress)[p.index];
      return st && !st.unlocked ? `Locked — ${st.lockReason ?? 'complete the previous event'}` : null;
    }
    return null;
  }

  /** Enter or leave a furnished walkable Quaternius building interior. */
  private actInterior(index: number, exit: boolean): void {
    if (this.sm.state !== 'onFoot') return;
    if (exit) {
      this.activeInterior = -1;
      this.character.teleport(this.interiorReturn, this.interiorReturnYaw);
      this.hud.pop('Back outside', 'good', 900);
      return;
    }
    const door = this.env.interiorDoors[index];
    if (!door) return;
    this.interiorReturn.copy(this.character.position);
    this.interiorReturnYaw = this.character.yaw;
    this.activeInterior = index;
    this.tmp2.set(door.roomX, 0, door.roomZ + 2.6);
    this.character.teleport(this.tmp2, Math.PI);
    this.hud.pop(`Entered ${door.label}`, 'good', 1200);
  }

  /** Free roam: act on the POI the player stands at (start a mission / open the garage). */
  private poiAction(poi: Poi): void {
    if (poi.kind === 'event') {
      const ev = CAREER[poi.index];
      if (!ev || this.poiLock(poi)) return;
      this.navDest = null;
      this.quitToMenu();
      this.menu.showCareerBriefing(ev.id);
      return;
    }
    if (poi.kind === 'mission') {
      if (!isMissionUnlocked(this.progress, poi.index)) return;
      this.navDest = null;
      this.quitToMenu();
      this.menu.showBriefing(poi.index);
    } else if (poi.kind === 'impound') {
      const id = this.ownCar.vehicleId;
      this.syncProgress();
      const fee = this.progress.impound[id];
      if (fee === undefined) {
        this.hud.toast('None of your cars are held here', 1600);
        return;
      }
      if (payImpound(this.progress, id)) {
        saveProgress(this.progress);
        this.menu.setProgress(this.progress);
        this.ownAtLot = false;
        this.audio.checkpoint();
        this.hud.pop(`${vehicleById(id).name} released: −${fee.toLocaleString('en-US')} cr`, 'good', 2400);
      } else this.hud.toast(`Release fee ${fee.toLocaleString('en-US')} cr: not enough credits. You could break it out…`, 2600);
    } else if (poi.kind === 'garage') {
      if (this.vehicle !== this.ownCar) {
        if (this.sm.state === 'driving') {
          this.hud.toast('The garage only works on your own car — leave this one outside', 2200);
          return;
        }
        // On foot: the garage serves your own car again (the other car stays parked where you left it).
        this.setDriven(this.ownCar);
      }
      this.pauseScreen = 'garage';
      this.sm.go('paused');
    }
  }

  resume(): void {
    if (this.sm.state !== 'paused' || this.contextLost) return;
    const to = this.sm.resumeState;
    if (!to) return;
    const fromGarage = this.pauseScreen === 'garage';
    this.pauseScreen = 'pause';
    this.audio.start();
    if (fromGarage) {
      // Back from the city garage: drive the selected car, camera back behind the player.
      if (this.previewing !== this.progress.car || this.ownCar.vehicleId !== this.progress.car) this.applyPlayerCar();
      if (this.ownAtLot && !isImpounded(this.progress, this.ownCar.vehicleId)) {
        // Another (free) car was chosen while the impounded one stood at the lot: it comes out of the garage.
        const t = this.env.track;
        const i = GARAGE_SPOT.i;
        this.tmp.set(t.px[i] + t.rx(i) * 6, 0, t.pz[i] + t.rz(i) * 6);
        this.ownCar.reset(this.tmp, Math.atan2(-t.tz[i], t.tx[i]));
        this.ownAtLot = false;
      } else this.syncImpoundedCar();
      this.rig.setMode(to === 'driving' || to === 'entering' ? 'vehicle' : 'character', 0.6);
    }
    this.sm.go(to);
    this.menu.hideAll();
  }

  togglePause(): void {
    if (this.sm.simulating) this.pause();
    else if (this.sm.state === 'paused') {
      if (this.menu.screen === 'settings') this.menu.showPause(this.level.title, this.mission.hud(this.inCar)?.objective ?? '');
      else this.resume();
    }
  }

  /** Menu screen changes: preview the briefed level behind the briefing panel. */
  /**
   * Camera look input: driving / on foot use it for the chase and orbit cameras; in the garage (menu or city)
   * it orbits and zooms the car preview. Anywhere else it is off.
   */
  private syncLookMode(): void {
    const garage = this.menu.screen === 'garage' && this.garageOpen;
    const enabled = this.sm.simulating || garage;
    if (this.look.enabled && !enabled) this.look.clear();
    this.look.enabled = enabled;
    this.look.pinchZoom = garage;
    this.rig.interactiveShowcase = garage;
  }

  onScreen(screen: ScreenName | null): void {
    this.syncLookMode();
    if (screen === 'settings') this.menu.setController(this.pad.connectedName);
    if (screen === 'garage') {
      this.menu.setRepair(this.repairPrice, damageLevel(this.vehicle.damage));
      this.updateTyreRow();
    }
    // Garage: frame the car beside the panel (right on wide screens, above it on portrait phones).
    this.scene.setFraming(
      screen === 'garage'
        ? (w, h) => (w / h < 0.85 ? [0, 0.3] : w < 700 ? [0.2, 0] : [Math.min(0.26, 280 / w), 0])
        : null,
    );
    // Leaving the garage: put the selected car back on the stage.
    if (screen !== 'garage' && this.previewing !== this.progress.car && this.sm.is('menu')) this.applyPlayerCar();
    if (screen === 'briefing' && this.sm.is('menu', 'complete')) {
      if (this.sm.go('briefing')) {
        const cid = this.menu.briefingCareerId;
        this.loadLevel(this.menu.briefingLevel, cid ? -2 : LEVELS.indexOf(this.menu.briefingLevel), cid);
        this.rig.setMode('showcase', 0.6);
      }
    } else if (screen === 'career' && this.sm.is('complete', 'failed')) {
      // "Career" from a result screen: back to the menu with the city in free-roam layout.
      if (this.sm.go('menu')) {
        this.loadLevel(FREE_ROAM, -1);
        this.rig.setMode('showcase', 0.6);
      }
    } else if (screen !== null && screen !== 'briefing' && screen !== 'settings' && this.sm.state === 'briefing') {
      this.sm.go('menu');
      this.loadLevel(FREE_ROAM, -1);
    }
  }

  private get inCar(): boolean {
    return this.sm.is('driving') || (this.sm.state === 'paused' && this.sm.resumeState === 'driving');
  }

  /** Side effects of every state change (one place, so nothing is left half-switched). */
  private onStateChange(to: GameStateName, from: GameStateName): void {
    const sim = this.sm.simulating;
    if (!sim) this.storeTyreWear(true);
    this.input.capturing = sim;
    if (!sim || from === 'paused') {
      this.input.clearAll();
      this.look.clear();
    }
    this.syncLookMode();
    this.accumulator = 0;
    this.lastTime = -1;
    this.hud.setVisible(sim || to === 'paused');
    this.audio.setPaused(to === 'paused');
    if (to === 'paused') {
      if (this.pauseScreen === 'map') this.menu.showMap(this.mapModel());
      else if (this.pauseScreen === 'garage') {
        this.hud.setVisible(false);
        this.rig.setMode('showcase', 0.6);
        this.menu.setRepair(this.repairPrice, damageLevel(this.ownCar.damage));
        this.updateTyreRow();
        this.menu.showGarage(true);
      } else this.menu.showPause(this.level.title, this.mission.hud(this.inCar)?.objective ?? '');
      this.hud.clearTransient();
    }
    if (to === 'menu' || to === 'briefing') {
      this.audio.setEngineOn(false);
      this.hud.clearTransient();
    }
    if (to === 'complete' || to === 'failed') {
      this.audio.setEngineOn(false);
      this.audio.update(900, 0, 0, 0);
      this.hud.clearTransient();
    }
    const foot = to === 'onFoot' || to === 'entering' || to === 'exiting';
    if (sim) this.hud.setMode(to === 'driving' ? 'drive' : 'foot');
    this.touch.setLayout(to === 'driving' ? 'drive' : foot ? 'foot' : 'none');
    this.updateTouchVisibility();
    this.scene.needsRender = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  // ================================================================== enter / exit

  private tryEnter(): void {
    if (this.sm.state !== 'onFoot') return;
    const target = this.crime.enterTarget(this.character.position, this.vehicle, this.ownCar);
    if (!target || 'occupied' in target) {
      if (target) this.hud.toast('Someone is at the wheel — threaten the driver with your weapon (aim at the car)', 2200);
      return;
    }
    let car = target.vehicle;
    if (!car && target.traffic >= 0) car = this.crime.takeTraffic(target.traffic, this.vehicle, this.ownCar);
    if (!car) return;
    const door = this.interaction.nearestDoor(car, this.character.position);
    if (!door) return;
    const stolen = car !== this.ownCar && this.worldCars.byVehicle(car)?.state === 'parked';
    if (car === this.ownCar && this.level.kind === 'free' && isImpounded(this.progress, car.vehicleId)) {
      // Breaking your own car out of the impound: the record is cleared, but the police want you for it.
      this.syncProgress();
      releaseImpound(this.progress, car.vehicleId);
      saveProgress(this.progress);
      this.menu.setProgress(this.progress);
      this.ownAtLot = false;
      this.police.offence('impoundTheft', this.fillPlayerState());
    }
    this.setDriven(car);
    if (this.interaction.carUpY(this.vehicle) < 0.7) {
      // Flipped car: put it back on its wheels where it stands.
      const p = this.vehicle.physicsPosition;
      const f = this.vehicle.forward;
      this.tmp.set(p.x, 0, p.z);
      this.vehicle.reset(this.tmp, Math.atan2(-f.z, f.x));
      this.hud.toast('Car flipped upright', 1200);
      return;
    }
    const block = this.interaction.enterBlockReason(this.vehicle);
    if (block) {
      this.hud.toast(block, 1400);
      return;
    }
    this.scriptFrom.copy(this.character.position);
    this.scriptTo.copy(door.point);
    this.scriptTo.y = this.character.position.y;
    this.walkDur = Math.min(0.6, Math.max(0.15, door.distance / 2.2));
    this.scriptYaw = this.interaction.faceCarYaw(this.vehicle, door.side);
    this.doorClosed = false;
    this.character.setEnabled(false);
    this.character.setCrouch(false);
    this.crime.weapon.forceHolster();
    if (this.vehicle !== this.ownCar) {
      this.worldCars.markTaken(this.vehicle);
      if (stolen) {
        this.crime.stats.thefts++;
        this.police.offence('carTheft', this.fillPlayerState());
      }
    }
    this.sm.go('entering');
  }

  private tryExit(): void {
    if (this.sm.state !== 'driving') return;
    const reason = this.mission.exitBlockReason() ?? this.interaction.exitBlockReason(this.vehicle);
    if (reason) {
      this.hud.toast(reason, 1400);
      return;
    }
    const spot = this.interaction.findExit(this.vehicle, this.character.body);
    if (!spot) {
      this.hud.toast('No room to get out here', 1400);
      return;
    }
    this.character.setEnabled(true);
    this.character.teleport(spot.feet, spot.yaw);
    this.charModel.resetPose();
    this.charModel.setOpacity(0);
    this.charModel.root.position.copy(spot.feet);
    this.charModel.root.rotation.set(0, spot.yaw, 0);
    const f = this.vehicle.forward;
    this.rig.character.snap(spot.feet, Math.atan2(f.x, f.z));
    this.rig.setMode('character', CAMERA_BLEND);
    this.audio.door(false);
    this.audio.setEngineOn(false);
    this.doorClosed = false;
    this.sm.go('exiting');
  }

  /** Scripted enter / exit progress (fixed step). */
  private stepScript(dt: number): void {
    const t = this.sm.time;
    const c = this.character;
    if (this.sm.state === 'entering') {
      c.prevPosition.copy(c.position);
      c.prevYaw = c.yaw;
      if (t < this.walkDur) {
        const k = Math.min(1, t / this.walkDur);
        c.position.lerpVectors(this.scriptFrom, this.scriptTo, k);
        const dx = this.scriptTo.x - this.scriptFrom.x;
        const dz = this.scriptTo.z - this.scriptFrom.z;
        const walkYaw = Math.hypot(dx, dz) > 0.2 ? Math.atan2(dx, dz) : this.scriptYaw;
        c.yaw = lerpAngle(c.yaw, k > 0.7 ? this.scriptYaw : walkYaw, Math.min(1, dt * 12));
      } else {
        c.position.copy(this.scriptTo);
        c.yaw = lerpAngle(c.yaw, this.scriptYaw, Math.min(1, dt * 14));
        if (!this.doorClosed) {
          this.doorClosed = true;
          this.audio.door(false);
          this.rig.follow.snap(this.vehicle);
          this.rig.setMode('vehicle', CAMERA_BLEND);
        }
        const f = (t - this.walkDur) / ENTER_FADE;
        this.charModel.setOpacity(1 - f);
        if (f >= 1) {
          this.charModel.setOpacity(0);
          this.audio.door(true);
          this.audio.setEngineOn(true);
          this.audio.engineStart();
          this.sm.go('driving');
          this.mission.onEnterCar();
          this.hud.setPrompt(null);
        }
      }
    } else if (this.sm.state === 'exiting') {
      const f = Math.min(1, t / EXIT_FADE);
      this.charModel.setOpacity(f);
      if (!this.doorClosed && t > 0.3) {
        this.doorClosed = true;
        this.audio.door(true);
      }
      c.step(dt, 0, 0, false, false);
      if (f >= 1) this.sm.go('onFoot');
    }
  }

  // ================================================================== actions & settings

  private handleAction(a: InputAction): void {
    if (a === 'mute') {
      this.toggleMute();
      return;
    }
    if (a === 'pause') {
      this.togglePause();
      return;
    }
    if (a === 'map') {
      this.openMap();
      return;
    }
    if (a === 'camera') {
      if (this.sm.simulating) this.toggleCarView();
      return;
    }
    if (!this.sm.simulating) return;
    if (this.arrest.active) {
      // Under arrest: E gets out of the car when told to, or skips the transfer; nothing else.
      if (a === 'skip' && this.arrest.phase === 'transfer') this.arrestContinue();
      if (a === 'interact') {
        if (this.arrest.phase === 'transfer') this.arrestContinue();
        else if (this.sm.state === 'driving') this.tryExit();
      }
      return;
    }
    if (a === 'torch') {
      if (this.jailed) {
        this.jailTorchOn = !this.jailTorchOn;
        this.hud.toast(this.jailTorchOn ? 'Torch on' : 'Torch off', 900);
      }
      return;
    }
    if (this.jailed && this.jail) {
      if (a === 'interact') {
        if (this.sm.state === 'onFoot') this.jail.interact(this.jailPlayer(), this.jailCtx());
        return;
      }
      // Jail escape includes a basic non-lethal sidearm; weapon toggle and firing remain available.
    }
    if (a === 'interact') {
      if (this.interiorAction) this.actInterior(this.interiorAction.index, this.interiorAction.exit);
      else if (this.poiPrompt) this.poiAction(this.poiPrompt);
      else if (this.sm.state === 'onFoot') this.tryEnter();
      else if (this.sm.state === 'driving') this.tryExit();
    } else if (a === 'jump') {
      if (this.sm.state === 'onFoot') this.jumpQueued = true;
    } else if (a === 'weapon') {
      if (this.sm.state === 'onFoot' && this.crime.enabled && this.police.wanted.state !== 'busted') this.crime.weapon.toggle();
    } else if (a === 'crouch') {
      if (this.sm.state === 'onFoot' && !this.character.setCrouch(!this.character.crouched)) this.hud.toast('No room to stand up here', 1200);
    } else if (a === 'reset' && this.sm.state === 'onFoot' && this.crime.weapon.drawn) this.crime.weapon.reload();
    else if (a === 'reset' && this.sm.state === 'driving') this.resetCar();
  }

  /** Chase camera ↔ in-car view (V, controller RB, HUD button); remembered in the settings. */
  toggleCarView(): void {
    const next = this.settings.carView === 'cockpit' ? 'chase' : 'cockpit';
    this.setSetting('carView', next);
    if (this.sm.simulating) this.hud.toast(next === 'cockpit' ? 'In-car view' : 'Chase camera', 900);
  }

  /** Put the car back on the road at the nearest point (R key / HUD button). */
  resetCar(): void {
    if (this.sm.state !== 'driving' || this.mission.inputLocked) return;
    const t = this.env.track;
    const p = this.vehicle.physicsPosition;
    const i = t.trackIndex(p.x, p.z, this.trackIndex);
    const lat = (p.x - t.px[i]) * t.rx(i) + (p.z - t.pz[i]) * t.rz(i);
    const off = Math.max(-5.25, Math.min(5.25, Math.round(lat / 3.5) * 3.5 + (lat >= 0 ? 1.75 : -1.75)));
    this.tmp.set(t.px[i] + t.rx(i) * Math.max(-5.25, Math.min(5.25, off)), 0, t.pz[i] + t.rz(i) * off);
    this.vehicle.reset(this.tmp, Math.atan2(-t.tz[i], t.tx[i]));
    this.carPrev.copy(this.vehicle.physicsPosition);
    this.rig.follow.snap(this.vehicle);
    this.trackIndex = i;
    this.accumulator = 0;
    this.hud.toast('Car reset', 1000);
  }

  private recoverIfFlipped(): void {
    if (this.sm.state !== 'driving' || this.vehicle.physics.flippedTime < 2.5) return;
    const t = this.env.track;
    const i = this.trackIndex;
    this.tmp.set(t.px[i] + t.rx(i) * 1.75, 0, t.pz[i] + t.rz(i) * 1.75);
    this.vehicle.reset(this.tmp, Math.atan2(-t.tz[i], t.tx[i]));
    this.carPrev.copy(this.vehicle.physicsPosition);
    this.rig.follow.snap(this.vehicle);
    this.hud.toast('Car recovered');
  }

  uiGesture(): void {
    this.audio.start();
    this.audio.click();
  }

  /** Garage purchase / selection / upgrade / paint (rules live in vehicles/Garage). */
  private get garageOpen(): boolean {
    return this.sm.is('menu') || (this.sm.state === 'paused' && this.pauseScreen === 'garage');
  }

  garageAction(a: GarageAction): boolean {
    if (!this.garageOpen) return false;
    this.syncProgress(); // apply the action to the latest save (another tab may have spent or earned credits)
    const p = this.progress;
    let ok: boolean;
    if (a.type === 'buy') ok = buyCar(p, a.car);
    else if (a.type === 'select') ok = selectCar(p, a.car);
    else if (a.type === 'upgrade') ok = buyUpgrade(p, a.car, a.upgrade);
    else if (a.type === 'paint') ok = setCarPaint(p, a.car, a.paint);
    else if (a.type === 'part') ok = fitPart(p, a.car, a.slot, a.part);
    else if (a.type === 'setup') ok = adjustSetup(p, a.car, a.key, a.delta);
    else if (a.type === 'setupReset') ok = resetSetup(p, a.car);
    else if (a.type === 'tyres') {
      this.storeTyreWear(false);
      ok = fitNewTyres(p, p.car);
      if (ok && this.wearOwner === p.car) this.ownCar.fitNewTyres();
    }
    else if (a.type === 'repair') {
      const price = this.repairPrice;
      ok = price > 0 && p.credits >= price;
      if (ok) {
        p.credits -= price;
        saveProgress(p);
        this.ownCar.repair();
        if (this.vehicle === this.ownCar) this.hud.setDamage(0);
      }
    } else ok = false;
    this.menu.setRepair(this.repairPrice, damageLevel(this.ownCar.damage));
    this.updateTyreRow();
    if (ok && a.type !== 'repair' && a.type !== 'tyres') {
      if (a.type === 'buy' || a.type === 'select') this.applyPlayerCar();
      else if ((a.type === 'upgrade' || a.type === 'part' || a.type === 'setup' || a.type === 'setupReset') && a.car === p.car) this.applyPlayerCar();
      this.previewCar(a.car);
    }
    this.menu.setProgress(p);
    return ok;
  }

  /**
   * Show a garage car on the stage: body, parts, paint, wheel size and ride height (its tuning is applied
   * so the stance is real). Leaving the garage, starting a run or resuming re-applies the selected car.
   */
  previewCar(id: string): void {
    if (!this.garageOpen) return;
    const def = vehicleById(id);
    const p = this.progress;
    const save = p.owned.includes(def.id) ? p.cars[def.id] : newCarSave(def.id);
    this.storeTyreWear(false);
    this.ownCar.configure(def, save.upgrades, this.paintColor(save.paint), save.look, save.setup);
    this.loadTyreWear(def.id);
    this.previewing = def.id;
  }

  /** Adopt settings changed in another tab (global preferences: volume, mute, quality... follow everywhere). */
  private syncSettings(): boolean {
    const s = readStoredSettings();
    if (!s || JSON.stringify(s) === JSON.stringify(this.settings)) return false;
    const qualityChanged = s.quality !== this.settings.quality;
    Object.assign(this.settings, s);
    if (qualityChanged) {
      this.scene.applyQuality(s.quality === 'auto' ? 'high' : (s.quality as QualityLevel));
      this.adaptive.reset();
    }
    this.applyAllSettings();
    return true;
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.syncSettings(); // change the latest stored settings, not a stale copy from another tab's point of view
    this.settings[key] = value;
    saveSettings(this.settings);
    if (key === 'quality') {
      this.scene.applyQuality(value === 'auto' ? 'high' : (value as QualityLevel));
      this.adaptive.reset();
    }
    this.applyAllSettings();
  }

  toggleMute(): void {
    this.setSetting('muted', !this.settings.muted);
    if (this.sm.simulating) this.hud.toast(this.settings.muted ? 'Sound off' : 'Sound on', 1000);
  }

  private applyAllSettings(): void {
    const s = this.settings;
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.hud.setMuted(s.muted);
    this.look.cameraSensitivity = s.cameraSensitivity;
    this.look.mouseSensitivity = s.mouseSensitivity;
    this.look.touchSensitivity = s.touchSensitivity;
    this.touch.setSensitivity(s.touchSensitivity);
    document.documentElement.style.setProperty('--hud-scale', String(s.hudScale));
    this.hud.setShowFps(s.showFps);
    this.particles.setEnabled(QUALITY_PRESETS[this.scene.quality].particles);
    this.city.setQuality(this.scene.quality);
    this.mission.setRaceOptions({ skillScale: AI_SKILL_SCALE[s.aiDifficulty], rubberBand: s.rubberBand });
    const stability = s.drivingFeel === 'arcade' ? 1.35 : s.drivingFeel === 'realistic' ? 0.82 : 1;
    for (const car of this.allCars) car.physics.stabilityAssist = stability;
    this.jail?.setGuidedSupport(s.escapeSupport === 'guided');
    // A fixed weather chosen before the session starts is there at once; changed while driving, it blends in.
    if (s.weather !== this.weatherSetting) {
      this.weatherSetting = s.weather;
      this.weather.setMode(s.weather, this.sm.time === 0);
    }
    this.weatherView.setQuality(this.scene.quality);
    const motion = CAMERA_MOTION_SCALE[s.cameraMotion];
    this.rig.cockpit.motion = motion;
    this.rig.shakeScale = motion;
    this.pad.vibration = s.vibration;
    if (!s.vibration) this.pad.stopRumble();
    this.updateTouchVisibility();
    this.menu.setSettings(s, this.scene.quality);
  }

  private get touchActive(): boolean {
    const m = this.settings.touchControls;
    if (m === 'on') return true;
    if (m === 'off') return false;
    return this.touchSeen || (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);
  }

  private updateTouchVisibility(): void {
    const show = this.touchActive && this.sm.simulating;
    this.touch.setVisible(show);
    this.container.classList.toggle('touch-ui', this.touchActive);
    // Keyboard hints make no sense with touch controls.
    this.hud.setHints(this.settings.showHints && !this.touchActive);
  }

  private updateAdaptiveQuality(dt: number): void {
    if (this.settings.quality !== 'auto' || !this.adaptive.sample(dt)) return;
    const idx = QUALITY_ORDER.indexOf(this.scene.quality);
    if (idx < 0 || idx >= QUALITY_ORDER.length - 1) return;
    const next = QUALITY_ORDER[idx + 1];
    this.scene.applyQuality(next);
    this.applyAllSettings();
  }

  // ================================================================== simulation

  /** One fixed tick. */
  private fixedStep(): void {
    const dt = FIXED_DT;
    const state = this.sm.state;
    this.sm.time += dt;
    if (this.level.kind === 'free') this.weather.update(dt);
    // Tyre wear of the own car is kept in the save (written every 10 s when it changed, and on pause / menu).
    this.wearTimer += dt;
    if (this.wearTimer >= 10) {
      this.wearTimer = 0;
      this.storeTyreWear(true);
    }
    this.police.sightScale = this.level.kind === 'free' ? this.weather.visibility : 1;
    this.input.read(this.ctrl);

    if (state === 'onFoot') {
      // Camera-relative movement: forward = camera view on the ground, right = forward × up.
      const fx = this.camFwd.x;
      const fz = this.camFwd.z;
      const mx = fx * this.ctrl.moveY - fz * this.ctrl.moveX;
      const mz = fz * this.ctrl.moveY + fx * this.ctrl.moveX;
      const held = this.police.wanted.state === 'busted' || this.arrest.active;
      this.crime.stepOnFoot(dt, this.ctrl, this.camFwd, !held);
      if (this.arrest.active) {
        // Under arrest: no control; the escort walks the player to the police car.
        const [ax, az] = this.arrestMove();
        this.character.step(dt, ax, az, false, false);
      } else this.character.step(dt, held ? 0 : mx, held ? 0 : mz, this.ctrl.run, this.jumpQueued && !held);
      if (this.character.jumped) this.charModel.startJump();
      this.vehicle.fixedUpdate(dt, PARKED);
    } else if (state === 'driving') {
      this.crime.stepOther(dt);
      if (this.mission.inputLocked || this.police.wanted.state === 'busted') this.vehicle.fixedUpdate(dt, PARKED);
      else this.vehicle.fixedUpdate(dt, InputManager.toDriver(this.ctrl, this.driverInput));
    } else {
      this.crime.stepOther(dt);
      this.stepScript(dt);
      this.vehicle.fixedUpdate(dt, PARKED);
    }
    // Cars nobody is driving keep their handbrake on (the own car while another is driven, world cars).
    if (this.ownCar !== this.vehicle && this.ownCar.isActive) this.ownCar.fixedUpdate(dt, PARKED);
    this.worldCars.fixedUpdate(dt, this.vehicle);
    this.fillOtherCars();
    this.jumpQueued = false;
    this.mission.preStep(dt, this.vehicle, this.level.traffic && this.level.race ? this.city.traffic.cars : NO_CARS);
    this.police.playerCar = this.sm.state === 'driving' ? this.vehicle : null;
    this.stepArrest(dt);
    if (this.jailed && this.jail) this.jail.fixedUpdate(dt, this.jailPlayer());
    this.fade = Math.max(0, Math.min(1, this.fade + Math.sign(this.fadeTarget - this.fade) * FADE_RATE * dt));
    if (Math.abs(this.fade - this.fadeTarget) < FADE_RATE * dt) this.fade = this.fadeTarget;
    this.hud.setFade(this.fade);
    if (this.police.enabled) this.police.fixedUpdate(dt, this.fillPlayerState(), this.city.signals, this.city.traffic.cars);
    this.city.fixedUpdate(dt, this.fillCityActors());

    this.carPrev.copy(this.vehicle.physicsPosition);
    this.physics.step();
    this.vehicle.afterStep();
    if (this.ownCar !== this.vehicle && this.ownCar.isActive) this.ownCar.afterStep();
    this.worldCars.afterStep(this.vehicle);
    this.police.afterStep();
    this.physicsSteps++;
    // In-car camera / rumble read the chassis motion (read only: the camera never feeds back into physics).
    if (this.sm.state === 'driving') this.rig.cockpit.sample(this.vehicle, dt);
    const hit = this.vehicle.updateDamage(dt);
    if (hit) this.onCarDamaged(hit);

    const vp = this.vehicle.physics;
    const mi = this.missionInput;
    mi.inCar = this.sm.state === 'driving';
    mi.carPos.copy(this.vehicle.physicsPosition);
    const r = vp.body.rotation();
    mi.carFwdX = 1 - 2 * (r.y * r.y + r.z * r.z);
    mi.carFwdZ = 2 * (r.x * r.z - r.w * r.y);
    mi.carSpeed = Math.abs(vp.forwardSpeed);
    mi.forwardSpeed = vp.forwardSpeed;
    const lv = vp.body.linvel();
    mi.carVelX = lv.x;
    mi.carVelZ = lv.z;
    mi.handbrake = mi.inCar && this.ctrl.handbrake;
    mi.impact = vp.impact;
    if (this.level.redLight) {
      const cp = mi.carPos;
      const idx = this.env.track.trackIndex(cp.x, cp.z, this.trackIndex);
      mi.redLight = this.missionRedLight.update(this.env.track, this.city.signals, idx, cp.x, cp.z, mi.carSpeed, mi.inCar);
    } else mi.redLight = false;
    mi.pedHit = false;
    if (mi.inCar) for (const e of this.city.pedEvents) if (e.type === 'pedHit' && Math.hypot(e.x - mi.carPos.x, e.z - mi.carPos.z) < 5) mi.pedHit = true;
    mi.policeNear = this.police.enabled ? this.police.nearestUnit(mi.carPos.x, mi.carPos.z) : Infinity;
    mi.busted = this.police.enabled && this.police.wanted.state === 'busted';
    this.mission.postStep(mi);
    this.recoverIfFlipped();
    const p = this.vehicle.physicsPosition;
    this.trackIndex = this.env.track.trackIndex(p.x, p.z, this.trackIndex);
    this.processMissionEvents();
    this.processCityEvents();
    this.processPoliceEvents();
    this.processJailEvents();
    if (this.worldCars.isEnabled) {
      const f = this.fillPlayerState();
      this.worldCars.manage(dt, f.x, f.z, this.vehicle, this.ownCar);
    }

    if (this.pendingResult) {
      this.pendingResult.delay -= dt;
      if (this.pendingResult.delay <= 0) this.showResult();
    }
  }

  private processMissionEvents(): void {
    const ev = this.mission.events;
    if (ev.length === 0) return;
    for (const e of ev) {
      switch (e.type) {
        case 'checkpoint':
          this.audio.checkpoint();
          this.hud.pop(e.index >= e.total ? 'Final checkpoint!' : `Checkpoint ${e.index}/${e.total}`, 'good');
          this.particles.sparkle(this.vehicle.physicsPosition.x, this.vehicle.physicsPosition.y + 1.5, this.vehicle.physicsPosition.z);
          break;
        case 'missedGate':
          this.hud.pop(`Missed gate +${e.seconds}s`, 'bad');
          break;
        case 'penalty':
          this.audio.penalty();
          this.hud.pop(`+${e.seconds}s  ${e.reason}`, 'bad');
          break;
        case 'countdown':
          this.audio.countdown(false);
          this.hud.showCountdown(String(e.value));
          break;
        case 'go':
          this.audio.countdown(true);
          this.hud.showCountdown('GO!', 800);
          break;
        case 'lap':
          this.audio.checkpoint();
          this.hud.pop(e.lap === e.total ? 'Final lap!' : `Lap ${e.lap}/${e.total}`, 'good', 1500);
          break;
        case 'task':
          this.audio.checkpoint();
          this.hud.pop(e.next ? `${e.text}  Next: ${e.next}` : e.text, 'good', 2200);
          this.particles.sparkle(this.vehicle.physicsPosition.x, this.vehicle.physicsPosition.y + 1.5, this.vehicle.physicsPosition.z);
          break;
        case 'section':
          if (e.ok) this.audio.checkpoint();
          else this.audio.penalty();
          this.hud.pop(`Section ${e.index + 1}: ${Math.round(e.avg)} km/h ${e.ok ? '✓' : `— needed ${e.target}`}`, e.ok ? 'good' : 'bad', 1800);
          break;
        case 'drift':
          if (e.lost) this.hud.pop(`Drift lost! −${e.points.toLocaleString('en-US')}`, 'bad', 1200);
          else if (e.points >= 100) this.hud.pop(`+${e.points.toLocaleString('en-US')} drift`, 'good', 1100);
          break;
        case 'cargo':
          this.hud.pop(`Cargo damaged — ${e.integrity}%`, 'bad', 1200);
          break;
        case 'police':
          this.police.startPursuit(e.stars, e.behind, this.fillPlayerState());
          this.hud.pop('The police are on to you — get away!', 'bad', 2400);
          this.audio.penalty();
          break;
        case 'complete':
          this.audio.fanfare();
          this.hud.pop('Mission complete!', 'good', 1400);
          this.pendingResult = { kind: 'complete', delay: 1.2, time: e.time, stars: e.stars, reason: '', score: e.score, details: e.details };
          break;
        case 'failed':
          this.audio.failure();
          this.hud.pop('Mission failed', 'bad', 1400);
          this.pendingResult = { kind: 'failed', delay: 1.2, time: 0, stars: 0, reason: e.reason, score: null, details: [] };
          break;
      }
    }
    ev.length = 0;
    const pe = this.city.pedEvents;
    for (const e of pe) {
      if (e.type === 'report') this.crime.onReport();
      if (e.type !== 'pedHit') continue;
      this.audio.impact(Math.min(0.5, e.speed / 30));
      // Only the player's own hits are reported (police and traffic can bump pedestrians too).
      const cp = this.vehicle.physicsPosition;
      if (this.sm.state === 'driving' && Math.hypot(e.x - cp.x, e.z - cp.z) < 5) this.police.offence('hitPedestrian', this.fillPlayerState());
    }
    pe.length = 0;
  }

  private fillCityActors(): CityActors {
    const ca = this.cityActors;
    ca.inCar = this.sm.state === 'driving' || this.sm.state === 'exiting';
    ca.footX = this.character.position.x;
    ca.footZ = this.character.position.z;
    ca.footVX = this.character.velocity.x;
    ca.footVZ = this.character.velocity.z;
    return ca;
  }

  /** The title screen shows the open city: keep its traffic and pedestrians moving (no gameplay physics). */
  private updateMenuCity(dt: number): void {
    this.menuCityAcc = Math.min(this.menuCityAcc + dt, 4 * FIXED_DT);
    while (this.menuCityAcc >= FIXED_DT) {
      this.menuCityAcc -= FIXED_DT;
      this.city.fixedUpdate(FIXED_DT, this.fillCityActors());
    }
    this.city.trafficEvents.length = 0;
    this.city.pedEvents.length = 0;
  }

  private processCityEvents(): void {
    const ev = this.city.trafficEvents;
    for (const e of ev) {
      if (e.type === 'hit' && e.agent === AGENT_PLAYER_CAR) this.police.offence('hitTraffic', this.fillPlayerState());
      if (e.type === 'horn') this.audio.horn(Math.hypot(e.x - this.vehicle.physicsPosition.x, e.z - this.vehicle.physicsPosition.z));
      if (e.type === 'abandon') this.crime.onAbandon(e.x, e.z);
    }
    ev.length = 0;
  }

  private showResult(): void {
    const r = this.pendingResult;
    this.pendingResult = null;
    if (!r) return;
    const standings = this.level.race ? this.mission.standings() : null;
    if (this.careerId) {
      const id = this.careerId;
      if (r.kind === 'complete') {
        if (!this.sm.go('complete')) return;
        this.syncProgress();
        const res = recordCareer(this.progress, id, r.time, r.stars, this.mission.finishPosition);
        this.menu.setProgress(this.progress);
        if (!res) return;
        const k = CAREER.findIndex((e) => e.id === id);
        const nxt = CAREER[k + 1];
        this.menu.showCareerComplete(id, r.time, res, this.mission.penaltyTime, standings, nxt && isCareerUnlocked(this.progress, nxt.id) ? nxt.id : null);
      } else {
        if (!this.sm.go('failed')) return;
        this.menu.showCareerFailed(id, r.reason, standings);
      }
      return;
    }
    if (this.levelIndex < 0) return;
    if (r.kind === 'complete') {
      if (!this.sm.go('complete')) return;
      this.syncProgress();
      const res = recordCompletion(this.progress, this.levelIndex, r.time, r.stars, r.score);
      this.menu.setProgress(this.progress);
      this.menu.showComplete(this.levelIndex, r.time, res, this.mission.penaltyTime, standings, r.details, r.score);
    } else {
      if (!this.sm.go('failed')) return;
      this.menu.showFailed(this.levelIndex, r.reason, standings);
    }
  }

  // ================================================================== frame

  private onContextLost = (): void => {
    if (this.contextLost || this.disposed) return;
    this.contextLost = true;
    this.pause();
    this.scene.releaseForContextLoss();
    this.menu.showNotice('Graphics interrupted', 'The browser reset the graphics context. Restoring…');
    window.clearTimeout(this.contextTimer);
    this.contextTimer = window.setTimeout(
      () => this.fail(new Error('The graphics context was lost and the browser did not restore it.'), 'Graphics context lost'),
      10000,
    );
  };

  private onContextRestored = (): void => {
    if (!this.contextLost || this.disposed) return;
    window.clearTimeout(this.contextTimer);
    try {
      this.scene.rebuildAfterContextRestore();
      this.city.onContextRestored();
    } catch (err) {
      this.fail(err, 'Graphics could not be restored');
      return;
    }
    this.contextLost = false;
    this.lastTime = -1;
    this.menu.hideNotice();
    this.hud.toast('Graphics restored', 2000);
  };

  private fail(err: unknown, title: string): void {
    if (this.disposed) return;
    console.error(err);
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.dispose();
    } catch (disposeErr) {
      console.error(disposeErr);
    }
    showFatalError(this.container, title, message, 'Reload the page to start again. If it keeps happening, try another browser or update your graphics drivers.');
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.frame);
    if (this.contextLost) return;
    try {
      this.tick(now);
    } catch (err) {
      this.fail(err, 'The game stopped unexpectedly');
    }
  };

  private tick(now: number): void {
    const dt = this.lastTime < 0 ? FIXED_DT : Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    // Controller first (also while paused / in menus, where it moves the focus).
    this.pad.poll(dt, { capturing: this.input.capturing, armed: this.input.mouseWeapon });
    this.hud.setPadMode(this.pad.active && this.pad.lastInput > this.input.lastKeyTime);
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    if (this.sm.state === 'paused' && this.pauseScreen === 'garage') {
      this.renderFrame(dt, 1); // live car preview in the city garage (simulation frozen)
      return;
    }
    if (this.sm.is('paused', 'complete', 'failed')) {
      if (this.scene.needsRender) {
        this.scene.render();
        this.scene.needsRender = false;
      }
      return;
    }

    let alpha = 1;
    if (this.sm.simulating) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_SUBSTEPS && this.sm.simulating) {
        this.fixedStep();
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_SUBSTEPS) this.accumulator = 0;
      alpha = Math.min(1, this.accumulator / FIXED_DT);
      this.updateAdaptiveQuality(dt);
    }
    this.renderFrame(dt, alpha);
  }

  /** Everything visual for one displayed frame (interpolation, animation, camera, HUD, audio). */
  /** City ambience around the listener: traffic bed, nearest passing car (Doppler), crossing ticks. */
  private updateAmbience(dt: number, at: { x: number; z: number }): void {
    const city = this.city;
    let best: (typeof city.traffic.cars)[number] | null = null;
    let bestD = 1e9;
    let moving = 0;
    for (const c of city.traffic.cars) {
      if (c.mode === 0) continue;
      if (c.v > 1) moving++;
      const d = Math.hypot(c.x - at.x, c.z - at.z);
      if (d < bestD) [bestD, best] = [d, c];
    }
    const closing = best && best === this.passCar && dt > 0 ? (this.passPrevDist - bestD) / dt : 0;
    this.passCar = best;
    this.passPrevDist = bestD;
    let walkD = 1e9;
    const t = this.env.track;
    for (let k = 0; k < CROSSINGS.length; k++) {
      if (city.signals.ped(k) !== 'walk') continue;
      const i = CROSSINGS[k];
      walkD = Math.min(walkD, Math.hypot(t.px[i] - at.x, t.pz[i] - at.z));
    }
    const busy = city.trafficOn ? Math.min(1, 0.45 + moving / 20) : 0.3;
    this.audio.ambience(busy, bestD, best ? best.v : 0, closing, walkD);
    {
      const free = this.level.kind === 'free';
      const inCar = this.sm.state === 'driving';
      this.audio.weather(free ? this.weather.rain : 0, free ? this.weather.wetness : 0, inCar ? Math.abs(this.vehicle.physics.forwardSpeed) : 0, inCar);
    }
  }

  private updateJailTorch(): void {
    const on = this.jailed && this.jailTorchOn && this.sm.state === 'onFoot';
    this.jailTorch.visible = on;
    if (!on) return;
    const p = this.character.position;
    this.jailTorch.position.set(p.x, p.y + 1.52, p.z);
    this.scene.camera.getWorldDirection(this.torchForward);
    this.jailTorchTarget.position.copy(this.jailTorch.position).addScaledVector(this.torchForward, 14);
  }

  private renderFrame(dt: number, alpha: number): void {
    const state = this.sm.state;
    const sim = this.sm.simulating;
    this.updateJailTorch();
    this.vehicle.render(alpha);
    if (this.ownCar !== this.vehicle && this.ownCar.isActive) this.ownCar.render(alpha);
    this.worldCars.render(alpha, this.vehicle);
    for (const o of this.opponents) if (o.isActive) o.render(alpha);
    if (this.policeBlock.isActive) this.policeBlock.render(alpha);
    this.officers.render(alpha, sim ? dt : 0);
    this.jail?.render(alpha, sim ? dt : 0);
    // Police light bars and siren (siren level falls off with the distance to the nearest unit).
    this.police.frame(this.sm.time);
    {
      const ps = this.police;
      const chasing = sim && ps.enabled && (ps.wanted.state === 'pursuit' || ps.wanted.state === 'search');
      const st = chasing ? this.fillPlayerState() : null;
      this.audio.siren(st ? Math.max(0, 1 - ps.nearestUnit(st.x, st.z) / 220) : 0);
    }
    const menuCity = this.sm.state === 'menu' && this.city.trafficOn;
    if (menuCity) this.updateMenuCity(dt);
    this.city.render(menuCity ? 1 : alpha, sim || menuCity ? dt : 0, this.scene.camera.position.x, this.scene.camera.position.z);
    this.env.update();
    this.obstacles.sync();
    this.visuals.update(dt);
    this.particles.update(sim ? dt : 0);

    // Character: interpolated transform + animation.
    const c = this.character;
    this.feet.lerpVectors(c.prevPosition, c.position, alpha);
    const yaw = lerpAngle(c.prevYaw, c.yaw, alpha);
    this.charModel.root.position.copy(this.feet);
    this.charModel.root.rotation.y = yaw;
    let animSpeed = c.actualSpeed;
    if (state === 'entering' && this.sm.time < this.walkDur) animSpeed = this.scriptFrom.distanceTo(this.scriptTo) / Math.max(0.15, this.walkDur);
    else if (state === 'entering' || state === 'exiting') animSpeed = 0;
    if (state !== 'driving') {
      this.crime.frame();
      this.charModel.overlay.handsUp = this.handsW;
      this.charModel.update(sim ? dt : 0, animSpeed, state === 'onFoot' ? c.turnSpeed : 0, state === 'onFoot' && !c.grounded);
    }
    this.updateWeaponUi(state === 'onFoot' && sim);

    const moveYaw = c.actualSpeed > 0.3 ? Math.atan2(c.velocity.x, c.velocity.z) : yaw;
    // In-car view only while actually driving (walking to the car and getting out use the outside cameras).
    this.rig.setCockpit(this.settings.carView === 'cockpit' && state === 'driving');
    this.cockpitInterior.update(dt, this.vehicle, this.rig.cockpitActive);
    this.rig.cockpitEye.copy(this.cockpitInterior.eye);
    this.audio.setCabin(this.rig.cockpitActive);
    this.rig.update(dt, this.vehicle, this.feet, moveYaw, c.actualSpeed);
    const cam = this.scene.camera;
    this.updateSights(dt, state === 'onFoot', c.actualSpeed);
    this.casings.update(sim ? dt : 0);
    cam.getWorldDirection(this.camFwd);
    this.camFwd.y = 0;
    if (this.camFwd.lengthSq() < 1e-6) this.camFwd.set(0, 0, 1);
    this.camFwd.normalize();

    const carPos = this.vehicle.object.position;
    const fwd = this.vehicle.forward;
    const driving = state === 'driving';
    if (driving || state === 'menu' || state === 'briefing') this.shadowFocus.set(carPos.x + fwd.x * 18, 0, carPos.z + fwd.z * 18);
    else this.shadowFocus.set(this.feet.x + this.camFwd.x * 10, 0, this.feet.z + this.camFwd.z * 10);
    this.scene.updateShadowFocus(this.shadowFocus);
    this.updateAmbience(dt, sim ? (driving ? carPos : this.feet) : cam.position);

    const vp = this.vehicle.physics;
    if (sim) {
      const t = this.env.track;
      if (driving) {
        const dtrain = vp.drivetrain;
        this.hud.update({
          speedKmh: vp.speedKmh,
          rpm: dtrain.rpm,
          gear: dtrain.gearLabel,
          handbrake: this.driverInput.handbrake && !this.mission.inputLocked,
          reversing: dtrain.reversing,
          shifting: dtrain.isShifting,
          street: t.streetName(this.trackIndex),
          fps: this.fps,
        });
      } else {
        this.charTrackIndex = t.trackIndex(this.feet.x, this.feet.z, this.charTrackIndex);
        this.hud.setStreet(t.streetName(this.charTrackIndex));
        this.hud.update({
          speedKmh: 0,
          rpm: 0,
          gear: 'N',
          handbrake: false,
          reversing: false,
          shifting: false,
          street: t.streetName(this.charTrackIndex),
          fps: this.fps,
        });
      }
      this.updatePrompt();
      this.updateMissionHud(dt);
      this.updateNav(dt);
      const onFoot = !driving;
      const m = this.markers;
      m.onFoot = onFoot;
      m.showCar = onFoot;
      m.carX = carPos.x;
      m.carZ = carPos.z;
      m.rivalCount = Math.min(4, this.mission.racers.length);
      for (let k = 0; k < m.rivalCount; k++) {
        const rp = this.mission.racers[k].vehicle.object.position;
        m.rivals[k * 2] = rp.x;
        m.rivals[k * 2 + 1] = rp.z;
      }
      m.policeCount = this.police.enabled ? this.police.positions(m.police) : 0;
      m.policeAlert = this.police.alert;
      m.policeFlash = Math.floor(this.sm.time * 4) % 2 === 0;
      if (onFoot) this.minimap.update(dt, this.feet.x, this.feet.z, this.camFwd.x, this.camFwd.z, m);
      else this.minimap.update(dt, carPos.x, carPos.z, fwd.x, fwd.z, m);
      this.visuals.setCarMarker(onFoot && this.feet.distanceTo(carPos) > 3.5 ? carPos : null);
      this.audio.update(vp.drivetrain.rpm, driving ? vp.drivetrain.appliedThrottle : 0, vp.maxSlip, Math.abs(vp.forwardSpeed), sim ? dt : 0);
      const gear = vp.drivetrain.reversing ? -1 : vp.drivetrain.gear;
      if (driving && this.lastGear > 0 && gear > 0 && gear !== this.lastGear) this.audio.gearShift(gear > this.lastGear);
      this.lastGear = driving ? gear : 0;
      // Damage effects: engine smoke from the bonnet, flickering damaged headlights.
      this.fxTime += dt;
      const fx = damageEffects(this.vehicle.damage);
      if (fx.smoke > 0) {
        this.tmp2.set(1.55, 0.95, 0).applyQuaternion(this.vehicle.object.quaternion).add(carPos);
        this.particles.engineSmoke(this.tmp2.x, this.tmp2.y - this.vehicle.physics.car.rideHeight, this.tmp2.z, fx.smoke, dt);
      }
      this.vehicle.model.flickerHeadlights(this.fxTime, !fx.flickerHead);
      if (vp.impact > 0) {
        if (vp.impact > 1.2) {
          this.audio.impact(vp.impact);
          if (vp.impact > 3) this.particles.impact(carPos.x, carPos.y - 0.3, carPos.z, vp.impact);
        }
        if (vp.impact > 2.5) this.rig.shake(Math.min(0.3, vp.impact * 0.018));
        if (vp.impact > 1.2 && driving && this.settings.vibration) {
          this.pad.rumble(Math.min(1, vp.impact / 10), Math.min(1, vp.impact / 8) * 0.6, 160 + Math.min(240, vp.impact * 15));
          this.rumbleHold = 0.25;
          this.rumbleOn = true;
        }
        vp.impact = 0;
      }
      this.updateRumble(sim ? dt : 0, driving && sim);
    } else {
      this.visuals.setCarMarker(null);
    }
    this.updateWeatherView(sim ? dt : 0);
    this.scene.render();
  }

  /**
   * Controller rumble while driving, refreshed every 0.1 s: kerbs / pavement and grass under the wheels,
   * suspension hits, tyres scrubbing or sliding, aquaplaning; trigger motors for wheelspin and locking brakes
   * where supported. Silent (and stopped) when not driving, paused, or with vibration off.
   */
  private updateRumble(dt: number, driving: boolean): void {
    const pad = this.pad;
    if (!driving || !pad.active || !this.settings.vibration) {
      if (this.rumbleOn) {
        pad.stopRumble();
        this.rumbleOn = false;
      }
      return;
    }
    this.rumbleHold -= dt;
    this.rumbleTimer -= dt;
    if (this.rumbleTimer > 0 || this.rumbleHold > 0) return;
    this.rumbleTimer = 0.1;
    const vp = this.vehicle.physics;
    const sk = Math.min(1, Math.abs(vp.forwardSpeed) / 20);
    let grass = 0;
    let kerb = 0;
    let aqua = 0;
    for (let i = 0; i < 4; i++) {
      if (!vp.wheels[i].contact) continue;
      const k = vp.surfaceKind[i];
      if (k === 'grass') grass += 0.25;
      else if (k === 'pavement') kerb += 0.25;
      aqua = Math.max(aqua, vp.aquaplane[i]);
    }
    const t = this.sm.time;
    const slip = vp.maxSlip * sk;
    const bump = this.rig.cockpit.bumpLevel;
    const strong = Math.min(1, bump * 0.9 + grass * 0.18 * sk + kerb * (0.5 + 0.5 * Math.sin(t * 40)) * 0.14 * sk);
    const weak = Math.min(1, slip * 0.45 + grass * 0.3 * sk + kerb * 0.15 * sk + aqua * 0.35 * (0.6 + 0.4 * Math.sin(t * 23)));
    if (strong > 0.02 || weak > 0.02) {
      pad.rumble(strong, weak, 140);
      this.rumbleOn = true;
    } else if (this.rumbleOn) {
      pad.stopRumble();
      this.rumbleOn = false;
    }
    const d = vp.drivetrain;
    const spin = d.appliedThrottle > 0.5 ? slip : 0;
    const lock = d.braking ? slip : 0;
    if (spin > 0.05 || lock > 0.05) pad.triggerRumble(lock * 0.8, spin * 0.8, 140);
  }

  private weatherLabel(w: Weather): string {
    const road = w.puddles > 0.5 ? 'standing water' : w.wetness > 0.6 ? 'wet road' : w.wetness > 0.15 ? 'damp road' : '';
    return road ? `${WEATHER_NAME[w.kind]} · ${road}` : WEATHER_NAME[w.kind];
  }

  /** Rain, wet roads, puddles, light and fog for the current weather (clear and dry outside free roam). */
  private updateWeatherView(dt: number): void {
    const w = this.level.kind === 'free' ? this.weather : null;
    this.weatherView.update(dt, this.scene.camera, w);
    const ty = this.vehicle.physics.tyres;
    this.hud.setTyres(ty.temp, ty.wear, TYRE.windowLow, TYRE.windowHigh);
    this.hud.setWeather(w ? this.weatherLabel(w) : null);
    const look = w ? { cloud: w.cloud, rain: w.rain, fog: w.fog, visibility: w.visibility } : { cloud: 0.08, rain: 0, fog: 0, visibility: 1 };
    const key = `${look.cloud.toFixed(3)} ${look.rain.toFixed(3)} ${look.fog.toFixed(3)}`;
    if (key !== this.weatherLookKey) {
      this.weatherLookKey = key;
      this.scene.setWeatherLook(look);
    }
  }

  /** Weapon HUD, crosshair, mouse and touch modes. */
  private updateWeaponUi(onFoot: boolean): void {
    const w = this.crime.weapon;
    const armed = onFoot && this.crime.enabled && w.inHand;
    this.input.mouseWeapon = armed;
    this.look.primaryFires = armed;
    this.touch.setWeaponAvailable(onFoot && this.crime.enabled && !this.arrest.active);
    this.touch.setArmed(armed && w.drawn);
    this.touch.setCrouched(onFoot && this.character.crouched);
    this.rig.character.aimTarget = armed && w.isAiming ? 1 : 0;
    // Down the sights only while the gun is ready (a reload drops back to the shoulder view, where the
    // reload is animated) and only in the character camera (no blend from the chase camera).
    this.rig.character.adsTarget = armed && w.isAiming && w.state === 'ready' && this.settings.aimView === 'sights' && this.rig.currentMode === 'character' ? 1 : 0;
    this.rig.character.crouchTarget = onFoot && this.character.crouched ? 1 : 0;
    this.hud.setWeapon(armed ? { mag: w.mag, reserve: w.reserve, state: w.state } : null);
    const cam = this.scene.camera;
    const px = (w.spread / Math.tan((cam.fov * Math.PI) / 360)) * (this.container.clientHeight / 2);
    // Down the sights the pistol's own sights are the reticle: no HUD crosshair.
    const sightsUp = this.rig.character.ads > ADS_VIEW_THRESHOLD;
    this.hud.setCrosshair(armed && w.drawn && !sightsUp ? px : -1, armed && w.isAiming && this.crime.lastAimKind !== 'none');
  }

  /** Sights view: weapon spread blend, body hidden from the eye camera, first-person pistol placed. */
  private updateSights(dt: number, onFoot: boolean, speed: number): void {
    const ch = this.rig.character;
    if (!onFoot || this.rig.currentMode !== 'character' || !this.crime.enabled) ch.resetAds();
    const w = this.crime.weapon;
    w.sights = ch.ads;
    const fp = ch.ads > ADS_VIEW_THRESHOLD;
    this.charModel.setFirstPerson(fp);
    this.adsView.update(fp ? dt : 0, this.scene.camera, {
      ads: ch.ads,
      recoil: w.recoil,
      sinceShot: w.sinceShot,
      empty: w.mag === 0 && w.state !== 'reloading',
      speed,
      self: this.character.collider,
    });
  }

  private updatePrompt(): void {
    let text: string | null = null;
    let touchLabel: string | null = null;
    const state = this.sm.state;
    if (this.arrest.active) {
      this.poiPrompt = null;
      const exit = this.arrest.phase === 'surrender' && state === 'driving';
      this.promptText = exit ? 'Get out of the car' : this.arrest.phase === 'transfer' ? 'Continue' : null;
      this.hud.setPrompt(this.touchActive ? null : this.promptText);
      this.touch.setInteract(exit ? 'Exit' : null);
      return;
    }
    if (this.jailed && this.jail) {
      const pr = state === 'onFoot' ? this.jail.prompt(this.jailPlayer(), this.jailCtx()) : null;
      this.poiPrompt = null;
      this.promptText = pr?.text ?? null;
      this.hud.setPrompt(this.touchActive ? null : this.promptText);
      this.touch.setInteract(pr?.touch ?? null);
      return;
    }
    if (state === 'onFoot') {
      const target = this.crime.enterTarget(this.character.position, this.vehicle, this.ownCar);
      if (target && 'occupied' in target) {
        text = 'Occupied — aim your weapon at the driver';
      } else if (target) {
        if (target.vehicle === this.ownCar && this.level.kind === 'free' && isImpounded(this.progress, this.ownCar.vehicleId)) {
          text = 'Break your car out of the impound (wanted ★★)';
          touchLabel = 'Steal';
        } else if (target.vehicle && this.interaction.carUpY(target.vehicle) < 0.7) {
          text = 'Flip car upright';
          touchLabel = 'Flip';
        } else {
          text = target.label;
          touchLabel = 'Enter';
        }
      }
    } else if (state === 'driving') {
      const slow = Math.abs(this.vehicle.physics.forwardSpeed) <= EXIT_MAX_SPEED;
      if (slow && !this.mission.exitBlockReason() && !this.mission.inputLocked) {
        text = 'Get out';
        touchLabel = 'Exit';
      }
    }
    // Free roam: points of interest (mission starts, garage) — after the door prompt in priority
    // on foot, ahead of "Get out" when stopped at one in the car.
    this.poiPrompt = null;
    if (this.level.kind === 'free' && (state === 'onFoot' ? !text : state === 'driving' && Math.abs(this.vehicle.physics.forwardSpeed) < 3)) {
      const pos = state === 'driving' ? this.vehicle.physicsPosition : this.character.position;
      const poi = poiAt(this.pois, pos.x, pos.z, state === 'driving' ? ARRIVE_RADIUS : 3.5);
      if (poi) {
        if (this.poiLock(poi)) {
          if (state === 'onFoot') {
            text = poi.kind === 'event' ? `${poi.label}: ${this.poiLock(poi)}` : `${poi.label} is locked`;
            touchLabel = null;
          }
        } else if (poi.kind === 'impound') {
          const id = this.ownCar.vehicleId;
          const fee = this.progress.impound[id];
          if (fee !== undefined && !this.loaner) {
            this.poiPrompt = poi;
            const name = vehicleById(id).name;
            text = this.progress.credits >= fee ? `Pay ${fee.toLocaleString('en-US')} cr: release your ${name}` : `Release fee ${fee.toLocaleString('en-US')} cr: not enough credits`;
            touchLabel = 'Pay';
          } else if (state === 'onFoot') {
            text = 'Impound lot: none of your cars are held here';
            touchLabel = null;
          }
        } else {
          this.poiPrompt = poi;
          text = poi.kind === 'mission' ? `Start ${poi.label}: ${poi.detail}` : poi.kind === 'event' ? `Enter ${poi.label} (${poi.detail})` : 'Open garage';
          touchLabel = poi.kind === 'garage' ? 'Garage' : 'Start';
        }
      }
    }
    this.interiorAction = null;
    if (this.level.kind === 'free' && state === 'onFoot' && this.env.interiorDoors.length) {
      const p = this.character.position;
      if (this.activeInterior >= 0) {
        const door = this.env.interiorDoors[this.activeInterior];
        if (door && Math.hypot(p.x - door.roomX, p.z - (door.roomZ + 3.2)) < 2.5) {
          this.interiorAction = { index: this.activeInterior, exit: true };
          this.poiPrompt = null;
          text = `Exit ${door.label}`;
          touchLabel = 'Exit';
        }
      } else {
        let nearest = -1;
        let best = 2.5;
        this.env.interiorDoors.forEach((door, index) => {
          const d = Math.hypot(p.x - door.x, p.z - door.z);
          if (d < best) { best = d; nearest = index; }
        });
        if (nearest >= 0) {
          this.interiorAction = { index: nearest, exit: false };
          this.poiPrompt = null;
          text = `Enter ${this.env.interiorDoors[nearest].label}`;
          touchLabel = 'Enter';
        }
      }
    }
    this.promptText = text;
    this.hud.setPrompt(this.touchActive ? null : text);
    this.touch.setInteract(touchLabel);
  }

  private updateMissionHud(dt: number): void {
    this.hudTimer -= dt;
    if (this.jailed && this.jail) {
      this.markers.hasTarget = false;
      this.visuals.setBeacon(null);
      this.hud.setDetect(this.jail.detect, this.jail.chased);
      if (this.hudTimer > 0) return;
      this.hudTimer = 0.1;
      const o = this.jail.objectives(this.jailCtx());
      this.hud.setMission({ title: o.title, objective: o.lines[0] ?? '', timer: null, timerWarning: false, info: o.lines.slice(1) }, null);
      return;
    }
    const inCar = this.sm.state === 'driving';
    const kind = this.mission.target(this.vehicle.physicsPosition, inCar, this.target);
    const m = this.markers;
    m.hasTarget = kind !== null && kind !== 'car';
    m.targetX = this.target.x;
    m.targetZ = this.target.z;
    this.visuals.setBeacon(kind === 'gate' || kind === 'zone' ? this.target.x : null, this.target.z, kind === 'zone' ? 0xffd54a : 0x34e89e);
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.1;
    const from = inCar ? this.vehicle.physicsPosition : this.feet;
    const dist = kind ? Math.hypot(this.target.x - from.x, this.target.z - from.z) : null;
    this.hud.setMission(this.mission.hud(inCar), kind && dist !== null && dist > 8 ? dist : null);
  }

  // ================================================================== test hook

  /**
   * Automated-test hook, exposed as `window.__cityRacer` by main.ts.
   * `__QA_HOOK__` is a compile-time constant: true for the dev server and `npm run build:qa`,
   * false for the release build, where this whole branch is removed (scripts/check-dist.mjs
   * verifies that after every `npm run build`).
   */
  createTestHook(): GameTestHook | null {
    if (__QA_HOOK__) {
      // Automated runs need the same weather sequence every time (the release build is random per session).
      this.weather.reseed(20261021);
      const snapshot = (): GameSnapshot => {
        const vp = this.vehicle.physics;
        const p = this.vehicle.physicsPosition;
        const r = vp.body.rotation();
        const fx = 1 - 2 * (r.y * r.y + r.z * r.z);
        const fz = 2 * (r.x * r.z - r.w * r.y);
        const t = this.env.track;
        const i = t.trackIndex(p.x, p.z, this.trackIndex);
        const heading = Math.atan2(-fz, fx);
        const roadYaw = Math.atan2(-t.tz[i], t.tx[i]);
        const c = this.character;
        const mm = this.mission;
        return {
          state: this.sm.state,
          resumeState: this.sm.resumeState,
          screen: this.menu.screen,
          inCar: this.sm.state === 'driving',
          speedKmh: vp.speedKmh,
          forwardSpeed: vp.forwardSpeed,
          gear: vp.drivetrain.gearLabel,
          rpm: vp.drivetrain.rpm,
          steer: vp.steerInput,
          position: { x: p.x, y: p.y, z: p.z },
          heading,
          upY: 1 - 2 * (r.x * r.x + r.z * r.z),
          flippedTime: vp.flippedTime,
          rearSlip: vp.rearSlip,
          propsDisplaced: this.env.props.displacedCount(),
          physicsSteps: this.physicsSteps,
          street: t.streetName(i),
          quality: this.scene.quality,
          qualityMode: this.settings.quality,
          muted: this.settings.muted,
          volume: this.audio.masterVolume,
          audioState: this.audio.state,
          audioGain: this.audio.outputGain,
          engineOn: this.audio.isEngineOn,
          skidSegments: this.vehicle.skids.segmentCount,
          physicsCounts: this.physics.counts,
          laneOffset: (p.x - t.px[i]) * t.rx(i) + (p.z - t.pz[i]) * t.rz(i),
          headingError: Math.atan2(Math.sin(heading - roadYaw), Math.cos(heading - roadYaw)),
          character: {
            x: c.position.x,
            y: c.position.y,
            z: c.position.z,
            yaw: c.yaw,
            grounded: c.grounded,
            speed: c.planarSpeed,
            actualSpeed: c.actualSpeed,
            enabled: c.isEnabled,
            visible: this.charModel.root.visible,
          },
          prompt: this.promptText,
          mission: {
            levelId: this.level.id,
            levelIndex: this.levelIndex,
            stage: mm.stage,
            nextGate: mm.nextGate,
            gates: this.level.gates.length,
            elapsed: mm.elapsed,
            penalty: mm.penaltyTime,
            strikes: mm.strikes,
            position: mm.playerPosition(),
            zoneHold: mm.zoneHold,
            racers: mm.racers.map((rc) => ({
              name: rc.name,
              progress: rc.progress,
              finished: rc.finished,
              x: rc.vehicle.physicsPosition.x,
              z: rc.vehicle.physicsPosition.z,
            })),
            obstacles: this.obstacles.counts,
            obstaclesDisplaced: this.obstacles.displacedCount(),
          },
          touch: { visible: this.touch.isVisible, layout: this.touch.root.dataset.layout ?? 'none', ...this.touch.debugState },
          control: { ...this.ctrl },
          hudVisible: this.hud.isVisible,
          cameraMode: this.rig.currentMode,
          camYaw: this.rig.character.yaw,
          camFwd: { x: this.camFwd.x, z: this.camFwd.z },
          exitCandidate: this.interaction.lastExitCandidate,
          particles: this.particles.isEnabled,
          progress: JSON.parse(JSON.stringify(this.progress)) as Progress,
          settings: { ...this.settings },
        };
      };
      return {
        snapshot,
        // Advance the simulation by `seconds` of game time using the live input state,
        // independent of the display frame rate (software-rendered CI browsers run at ~2 FPS).
        qaAdvance: (seconds: number): void => {
          const n = Math.round(seconds / FIXED_DT);
          for (let k = 0; k < n && this.sm.simulating; k++) {
            this.fixedStep();
            if (k % 30 === 0) {
              this.env.update();
              this.renderFrame(0, 1);
            }
          }
          if (this.sm.simulating) this.renderFrame(0, 1);
        },
        qaAdvanceFrames: (seconds: number, every = 4): void => {
          // Like qaAdvance, but renders every `every` fixed steps with the matching frame time, so per-frame
          // systems (camera springs, shake, rumble timers) behave as in a real game at 60 / every fps.
          const n = Math.round(seconds / FIXED_DT);
          for (let k = 1; k <= n && this.sm.simulating; k++) {
            this.fixedStep();
            if (k % every === 0) {
              this.env.update();
              this.renderFrame(FIXED_DT * every, 1);
            }
          }
        },
        qaFreeze: (on: boolean): void => {
          // Lives entirely in the hook so the game loop is byte-identical to the release build.
          cancelAnimationFrame(this.rafId);
          if (on) {
            this.renderFrame(0, 1);
          } else if (!this.disposed) {
            this.lastTime = -1;
            this.rafId = requestAnimationFrame(this.frame);
          }
        },
        sceneStats: () => {
          const out = new Map<string, { group: string; meshes: number; shadow: number; instanced: number; tris: number }>();
          for (const top of this.scene.scene.children) {
            const key = `${top.name || top.type}#${this.scene.scene.children.indexOf(top)}`;
            top.traverseVisible((o) => {
              const m = o as unknown as { isMesh?: boolean; isInstancedMesh?: boolean; castShadow: boolean; count?: number; geometry?: { index: { count: number } | null; attributes: { position?: { count: number } } } };
              if (!m.isMesh) return;
              const e = out.get(key) ?? { group: key, meshes: 0, shadow: 0, instanced: 0, tris: 0 };
              e.meshes++;
              if (m.castShadow) e.shadow++;
              if (m.isInstancedMesh) e.instanced++;
              const g = m.geometry;
              const n = g ? (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3 : 0;
              e.tris += n * (m.isInstancedMesh ? m.count ?? 1 : 1);
              out.set(key, e);
            });
          }
          return [...out.values()].sort((a, b) => b.meshes - a.meshes);
        },
        renderInfo: () => {
          const ri = this.scene.renderer.info;
          return { calls: ri.render.calls, triangles: ri.render.triangles, geometries: ri.memory.geometries, textures: ri.memory.textures, programs: ri.programs?.length ?? 0 };
        },
        debugTeleport: (sampleIndex: number, lateralOffset: number, yawOffset = 0): void => {
          const yaw = this.pose({ i: sampleIndex, off: lateralOffset }, this.tmp);
          this.vehicle.reset(this.tmp, yaw + yawOffset);
          this.carPrev.copy(this.vehicle.physicsPosition);
          this.rig.follow.snap(this.vehicle);
          this.trackIndex = ((sampleIndex % this.env.track.count) + this.env.track.count) % this.env.track.count;
        },
        debugTeleportCharacter: (sampleIndex: number, lateralOffset: number, yaw?: number): void => {
          const t = this.env.track;
          const k = ((sampleIndex % t.count) + t.count) % t.count;
          this.pose({ i: sampleIndex, off: lateralOffset }, this.tmp2);
          this.tmp2.y = this.groundHeight(this.tmp2.x, this.tmp2.z) ?? 0;
          const cy = yaw ?? Math.atan2(t.tx[k], t.tz[k]);
          this.character.teleport(this.tmp2, cy);
          this.charTrackIndex = k;
        },
        debugFlip: (): void => {
          const body = this.vehicle.physics.body;
          const r = body.rotation();
          const p = body.translation();
          const q = new Quaternion(r.x, r.y, r.z, r.w).multiply(new Quaternion(1, 0, 0, 0));
          body.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
          body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
          body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        },
        startLevel: (index: number): void => {
          if (!this.sm.is('menu', 'briefing')) this.quitToMenu();
          if (index < 0) this.startFreeRoam();
          else {
            if (this.sm.state === 'menu') this.sm.go('briefing');
            this.startLevel(index);
          }
        },
        snapCamera: (): void => {
          // qaAdvance renders with dt = 0, so the smoothed chase camera never catches up after a teleport.
          this.rig.finishBlend();
          this.rig.follow.snap(this.vehicle);
          this.rig.character.snap(this.feet, this.rig.character.yaw);
          this.renderFrame(0, 1);
        },
        setCameraYaw: (yaw: number): void => {
          this.rig.character.yaw = yaw;
          this.renderFrame(0, 1);
        },
        buildingAt: (x: number, z: number, margin = 0): boolean => {
          for (const f of this.env.footprints) {
            const c = Math.cos(f.yaw);
            const sn = Math.sin(f.yaw);
            const dx = x - f.x;
            const dz = z - f.z;
            const lx = dx * c - dz * sn;
            const lz = dx * sn + dz * c;
            if (Math.abs(lx) < f.w / 2 - margin && Math.abs(lz) < f.d / 2 - margin) return true;
          }
          return false;
        },
        trackPoint: (i: number, off: number) => {
          const t = this.env.track;
          const k = ((Math.round(i) % t.count) + t.count) % t.count;
          return { x: t.px[k] + t.rx(k) * off, z: t.pz[k] + t.rz(k) * off, rx: t.rx(k), rz: t.rz(k), tx: t.tx[k], tz: t.tz[k] };
        },
        cityInfo: (): CityInfo => ({
          trafficOn: this.city.trafficOn,
          traffic: { ...this.city.traffic.stats },
          cars: this.city.traffic.snapshot(),
          signals: Array.from({ length: this.city.signals.count }, (_, k) => ({ car: this.city.signals.car(k), ped: this.city.signals.ped(k) })),
          peds: {
            stats: { ...this.city.peds.stats },
            visible: this.city.pedestriansVisible,
            exactRow0: this.city.pedestrianExactRow0,
            sepInfo: this.city.peds.minSepInfo,
            list: this.city.peds.peds.filter((p) => p.mode !== 0).map((p) => ({ x: p.x, z: p.z, lat: p.lat, mode: p.mode, speed: p.speed })),
            // Crowd draw objects; per instance: pose rows A, B, weight B, outfit, x, z (rows ≥ exactRow0 are exact blends).
            draw: this.city.groups.peds.children.map((o) => {
              const m = o as unknown as { name: string; isInstancedMesh?: boolean; count?: number; visible: boolean; castShadow: boolean; geometry?: { getAttribute(n: string): { array: ArrayLike<number> } | undefined }; instanceMatrix?: { array: ArrayLike<number> } };
              const crowd = m.geometry?.getAttribute('aCrowd');
              const n = m.count ?? 0;
              return { name: m.name, instanced: !!m.isInstancedMesh, count: n, visible: m.visible, shadow: m.castShadow, poses: crowd ? Array.from({ length: n }, (_, k) => [crowd.array[k * 4], crowd.array[k * 4 + 1], crowd.array[k * 4 + 2], crowd.array[k * 4 + 3], m.instanceMatrix?.array[k * 16 + 12] ?? 0, m.instanceMatrix?.array[k * 16 + 14] ?? 0]) : [] };
            }),
          },
        }),
        setSignalPhase: (k: number, phase: number): void => this.city.signals.setPhase(k, phase),
        crimeInfo: (): CrimeInfo => {
          const w = this.crime.weapon;
          const st = this.city.peds.stats;
          const yawOf = (v: Vehicle): number => {
            const q = v.physics.body.rotation();
            return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
          };
          const dp = this.vehicle.physicsPosition;
          const op = this.ownCar.physicsPosition;
          const c = this.character.position;
          const modes = Array.from({ length: 12 }, () => 0);
          for (const p of this.city.peds.peds) if (p.mode < 12) modes[p.mode]++;
          return {
            enabled: this.crime.enabled,
            state: this.sm.state,
            weapon: { state: w.state, drawn: w.drawn, inHand: w.inHand, aiming: w.isAiming, mag: w.mag, reserve: w.reserve, spread: w.spread, sights: w.sights },
            ads: (() => {
              // Sight picture check: distance (m) of the rear / front sight tops from the camera's view axis,
              // and the camera's distance to the eye position it should be at.
              const cam = this.scene.camera;
              const out = { blend: this.rig.character.ads, firstPerson: this.charModel.isFirstPerson, viewModel: this.adsView.visible, crosshair: !!this.container.querySelector('.crosshair:not(.hidden)'), casings: this.casings.active, rearOff: -1, frontOff: -1, fov: cam.fov, slide: this.adsView.slide, tuck: this.adsView.tuckAmount, bodyColor: (this.charModel as unknown as { meshes: Array<{ material: { colorWrite: boolean } }> }).meshes[0]?.material.colorWrite ?? true };
              if (this.adsView.visible) {
                this.adsView.sightWorld(this.sightA, this.sightB);
                const f = cam.getWorldDirection(this.tmp2);
                const off = (p: Vector3): number => {
                  const d = p.clone().sub(cam.position);
                  return d.sub(f.clone().multiplyScalar(d.dot(f))).length();
                };
                out.rearOff = off(this.sightA);
                out.frontOff = off(this.sightB);
              }
              return out;
            })(),
            crouched: this.character.crouched,
            aimKind: this.crime.lastAimKind,
            shots: this.crime.shots,
            lastShot: { ...this.crime.lastShot },
            stats: { ...this.crime.stats },
            peds: { flees: st.flees, surrenders: st.surrenders, calls: st.calls, reports: st.reports, knockdowns: st.knockdowns, drivers: st.drivers, modes },
            driven: { vehicleId: this.vehicle.vehicleId, own: this.vehicle === this.ownCar, world: !!this.worldCars.byVehicle(this.vehicle), x: dp.x, z: dp.z, speed: this.vehicle.physics.forwardSpeed, yaw: yawOf(this.vehicle) },
            own: { vehicleId: this.ownCar.vehicleId, active: this.ownCar.isActive, x: op.x, z: op.z },
            worldCars: this.worldCars.cars.map((wc) => ({ state: wc.state, origin: wc.origin, defId: wc.defId, active: wc.vehicle.isActive, x: wc.vehicle.physicsPosition.x, z: wc.vehicle.physicsPosition.z, yaw: yawOf(wc.vehicle) })),
            traffic: this.city.traffic.cars.map((t, i) => ({ i, x: t.x, z: t.z, yaw: t.yaw, v: t.v, mode: t.mode, occupied: t.occupied, held: t.held, fleeing: t.fleeing })).filter((t) => t.mode !== 0),
            wanted: { stars: this.police.wanted.stars, state: this.police.wanted.state, heat: this.police.wanted.heat },
            hud: {
              weapon: !!this.container.querySelector('.weapon-hud:not(.hidden)'),
              crosshair: !!this.container.querySelector('.crosshair:not(.hidden)'),
              prompt: this.promptText,
            },
            character: { x: c.x, y: c.y, z: c.z },
            pose: { aim: this.charModel.overlay.aim, lowReady: this.charModel.overlay.lowReady, reload: this.charModel.overlay.reload, crouch: this.charModel.overlay.crouch, gunInHand: this.charModel.gunInHand, gunVisible: this.charModel.gun.visible, rightArm: this.charModel.boneDir('RightArm', 'RightForeArm'), rightFore: this.charModel.boneDir('RightForeArm', 'RightHand') },
            camera: (() => {
              const cam = this.scene.camera;
              const d = cam.getWorldDirection(this.tmp);
              return { x: cam.position.x, y: cam.position.y, z: cam.position.z, dx: d.x, dy: d.y, dz: d.z };
            })(),
          };
        },
        qaAimAt: (x: number, y: number, z: number): void => {
          const o = this.scene.camera.position;
          const dx = x - o.x;
          const dy = y - o.y;
          const dz = z - o.z;
          this.rig.character.yaw = Math.atan2(dx, dz);
          // Aiming looks AIM_PITCH_BIAS above the orbit pitch (see CharacterCamera).
          const bias = this.crime.weapon.isAiming ? AIM_PITCH_BIAS : 0;
          this.rig.character.pitch = Math.max(-0.32, Math.min(1.15, -Math.atan2(dy, Math.hypot(dx, dz)) + bias));
        },
        arrestInfo: () => {
          const a = this.arrest;
          return {
            phase: a.phase,
            t: a.t,
            started: a.started,
            refused: a.refused,
            officers: this.arrestOfficers.map((id) => {
              const o = this.officers.list[id];
              return { id, mode: o.mode, x: o.ctrl.position.x, z: o.ctrl.position.z, aim: o.aimW };
            }),
            summary: a.summary ? JSON.parse(JSON.stringify(a.summary)) : null,
            handsW: this.handsW,
            card: this.hud.arrestCardVisible,
            fade: this.fade,
            door: a.active ? this.arrestDoor() : null,
          };
        },
        jailInfo: () => {
          const j = this.jail;
          if (!j) return null;
          const c = this.character.position;
          return {
            jailed: this.jailed,
            active: j.active,
            origin: { x: JAIL_ORIGIN.x, z: JAIL_ORIGIN.z },
            zone: j.zoneOf(c),
            checkpoint: j.checkpoint,
            items: [...j.items],
            detect: j.detect,
            chased: j.chased,
            doors: j.doors(),
            power: j.powerT,
            alarm: j.alarmT,
            yard: j.yardT,
            lockdown: j.lockdown,
            task: j.task ? j.task.id : null,
            catches: j.catches,
            guards: j.guards.map((g) => ({ x: g.ctrl.position.x - JAIL_ORIGIN.x, z: g.ctrl.position.z - JAIL_ORIGIN.z, state: g.state, sus: g.sus, visible: !!g.model?.root.visible })),
            cameras: [...j.camSus],
          };
        },
        qaJailGuardsAway: (): void => {
          if (!this.jail) return;
          this.jail.guards.forEach((g, k) => {
            this.tmp2.set(JAIL_ORIGIN.x + 38 - k * 2, 0.02, JAIL_ORIGIN.z + 20);
            g.ctrl.teleport(this.tmp2, 0);
            g.state = 'patrol';
            g.sus = 0;
          });
          this.jail.guardsHeld = true;
        },
        qaPlaceCharacter: (x: number, z: number, yaw: number): void => {
          this.tmp2.set(x, this.groundHeight(x, z) ?? 0, z);
          this.character.teleport(this.tmp2, yaw);
          this.rig.character.yaw = yaw;
        },
        setCityVisible: (traffic: boolean, peds: boolean): void => {
          this.city.groups.traffic.visible = traffic;
          this.city.groups.peds.visible = peds;
        },
        setProgress: (p: unknown): void => {
          const s = sanitizeProgress(p);
          Object.assign(this.progress, s);
          saveProgress(this.progress);
          this.menu.setProgress(this.progress);
          if (this.sm.is('menu')) this.applyPlayerCar();
        },
        weatherInfo: () => {
          const w = this.weather;
          const vp = this.vehicle.physics;
          const rain = this.scene.scene.getObjectByName('rain');
          const pud = this.scene.scene.getObjectByName('puddles');
          return {
            mode: w.mode,
            kind: w.kind,
            cloud: w.cloud,
            rain: w.rain,
            fog: w.fog,
            wetness: w.wetness,
            puddles: w.puddles,
            visibility: w.visibility,
            fogFar: (this.scene.scene.fog as { far: number }).far,
            rainVisible: !!rain?.visible,
            puddlesVisible: !!pud?.visible,
            asphaltRoughness: this.env.wetMaterials[0].roughness,
            sightScale: this.police.sightScale,
            label: this.level.kind === 'free' ? this.weatherLabel(w) : '',
            surface: Array.from(vp.surfaceKind),
            gripScale: Array.from(vp.gripScale),
            aquaplane: Array.from(vp.aquaplane),
            tyreTemp: Array.from(vp.tyres.temp),
            tyreWear: Array.from(vp.tyres.wear),
            carHasSurface: vp.surface !== null,
          };
        },
        qaWeather: (mode: string, instant: boolean): void => {
          if (!(WEATHER_MODES as readonly string[]).includes(mode)) throw new Error(`unknown weather ${mode}`);
          this.weather.setMode(mode as WeatherMode, instant);
        },
        qaTyres: (wear: number, temp?: number): void => {
          const t = this.vehicle.physics.tyres;
          t.wear.fill(wear);
          if (temp !== undefined) t.temp.fill(temp);
        },
        cockpitInfo: () => {
          const cam = this.scene.camera;
          const obj = this.vehicle.object;
          obj.updateMatrixWorld();
          const local = obj.worldToLocal(cam.position.clone());
          const eye = this.cockpitInterior.eye.clone().add(this.vehicle.model.root.position);
          const ck = this.rig.cockpit;
          const xyz = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });
          return {
            view: this.settings.carView,
            motion: this.settings.cameraMotion,
            active: this.rig.cockpitActive,
            blending: this.rig.blending,
            interior: this.cockpitInterior.visible,
            clipping: this.cockpitInterior.clipping,
            clipsCabin: this.cockpitInterior.clipsPoint(obj.localToWorld(eye.clone().setY(eye.y - 0.25))),
            cam: xyz(local),
            eye: xyz(eye),
            offset: xyz(ck.offset),
            accel: xyz(ck.accel),
            level: { ...ck.level },
            fov: cam.fov,
            cabinAudio: this.audio.diag.cabin,
            charVisible: this.charModel.root.visible,
          };
        },
        padInfo: () => ({ active: this.pad.active, name: this.pad.connectedName, hudPad: this.hud.padMode, diag: { ...this.pad.diag } }),
        damageInfo: () => ({
          zones: { ...this.vehicle.damage.zones },
          lamps: { ...this.vehicle.damage.lamps },
          level: damageLevel(this.vehicle.damage),
          powerScale: this.vehicle.physics.drivetrain.powerScale,
          repairPrice: this.repairPrice,
        }),
        policeInfo: () => {
          const ps = this.police;
          const st = this.fillPlayerState();
          return {
            enabled: ps.enabled,
            playerIdx: st.idx,
            stars: ps.wanted.stars,
            heat: ps.wanted.heat,
            state: ps.wanted.state,
            bustTimer: ps.wanted.bustTimer,
            nearest: ps.nearestUnit(st.x, st.z),
            units: ps.units.map((u, k) => ({
              active: ps.isActive(k),
              carActive: u.vehicle.isActive,
              x: u.vehicle.physicsPosition.x,
              z: u.vehicle.physicsPosition.z,
              idx: u.idx,
              dir: u.dir,
              speed: u.vehicle.physics.forwardSpeed,
              lightbar: u.vehicle.object.getObjectByName('police-lightbar')?.visible ?? false,
              livery: ps.liveryInfo(k),
              yaw: (() => {
                const r = u.vehicle.physics.body.rotation();
                return Math.atan2(-(2 * (r.x * r.z - r.w * r.y)), 1 - 2 * (r.y * r.y + r.z * r.z));
              })(),
            })),
            seen: ps.seen,
            lastKnown: { ...ps.lastKnown },
            roadblockUp: ps.roadblockUp,
            roadblocks: ps.roadblocks,
            lastBlock: { ...ps.lastBlock },
            deployments: ps.deployments,
            officers: this.officers.list.map((o) => ({
              mode: o.mode,
              unit: o.unit,
              x: o.ctrl.position.x,
              y: o.ctrl.position.y,
              z: o.ctrl.position.z,
              visible: o.model ? o.model.root.visible : false,
              aim: o.aimW,
              collider: o.ctrl.isEnabled,
            })),
          };
        },
        policeSight: (ax: number, az: number, bx: number, bz: number): boolean => (this.police.sight ? this.police.sight(ax, 2.1, az, bx, 1.5, bz) : true),
        policeOffence: (o: string): boolean => this.police.offence(o as Offence, this.fillPlayerState()),
        policePlace: (k: number, i: number, dir: 1 | -1, lane = 5.25): void => {
          if (!this.police.isActive(k)) return;
          this.police.units[k].place(i, dir, lane);
        },
        debugHit: (dv: number, hitFwd: number, hitRight: number): void => {
          const p = this.vehicle.physics;
          p.hitDv = dv;
          p.hitFwd = hitFwd;
          p.hitRight = hitRight;
        },
        navInfo: () => ({
          dest: this.navDest?.id ?? null,
          routeCount: this.markers.routeCount,
          route: Array.from(this.markers.route.subarray(0, this.markers.routeCount * 2)),
          poiPrompt: this.poiPrompt?.id ?? null,
          prompt: this.promptText,
          markersVisible: this.poiMarkers?.group.visible ?? false,
          pois: this.pois.map((p) => ({ id: p.id, kind: p.kind, i: p.i, off: p.off, x: p.x, z: p.z })),
        }),
        audioInfo: () => ({ state: this.audio.state, hidden: this.audio.isHidden, engineOn: this.audio.isEngineOn, diag: { ...this.audio.diag } }),
        careerInfo: () => ({
          id: this.careerId,
          levelId: this.level.id,
          gates: this.level.gates.map((g) => ({ i: g.i, off: g.off })),
          pool: this.police.units.map((u) => ({ car: u.vehicle.vehicleId, style: u.vehicle.model.style })),
        }),
        garageInfo: () => ({
          vehicleId: this.vehicle.vehicleId,
          style: this.vehicle.model.style,
          mass: this.vehicle.physics.car.mass,
          maxDriveForce: this.vehicle.physics.drivetrain.engine.maxDriveForce,
          redline: this.vehicle.physics.drivetrain.engine.redlineRpm,
          driveFront: this.vehicle.physics.car.driveFront,
          wheelRadius: this.vehicle.physics.car.wheelRadius,
          rideHeight: this.vehicle.physics.car.rideHeight,
          suspensionStiffness: this.vehicle.physics.car.suspensionStiffness,
          frictionSlipFront: this.vehicle.physics.car.frictionSlipFront,
          brakeImpulseFront: this.vehicle.physics.car.brakeImpulseFront,
          brakeImpulseRear: this.vehicle.physics.car.brakeImpulseRear,
          rollingResistance: this.vehicle.physics.car.rollingResistance,
          look: { ...this.vehicle.model.look },
          orbit: { ...this.rig.follow.showcaseView, interactive: this.rig.interactiveShowcase, lookEnabled: this.look.enabled },
          progress: JSON.parse(JSON.stringify(this.progress)) as unknown,
        }),
      };
    }
    return null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.contextTimer);
    this.abort.abort();
    this.input.dispose();
    this.pad.dispose();
    this.cockpitInterior.dispose();
    this.look.dispose();
    this.touch.dispose();
    this.audio.dispose();
    this.scene.scene.remove(this.jailTorch, this.jailTorchTarget);
    this.jailTorchTarget.clear();
    this.hud.dispose();
    this.menu.dispose();
    this.particles.dispose();
    this.visuals.dispose();
    this.obstacles.dispose();
    this.charModel.dispose();
    this.character.dispose();
    for (const o of this.opponents) o.dispose();
    this.policeBlock.dispose();
    this.officers.dispose();
    this.city.dispose();
    this.vehicle.dispose();
    this.env.dispose();
    this.physics.dispose();
    this.scene.dispose();
  }
}
