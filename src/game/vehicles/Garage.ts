import { PAINTS } from '../missions/Levels';
import { isPaintUnlocked, newCarSave, ownsPart, saveProgress, totalStars, type Progress } from '../missions/Progress';
import { MAX_UPGRADE, SETUP_KEYS, SETUP_STEPS, neutralSetup, partDef, partKey, partPrice, upgradePrice, vehicleById, type PartSlot, type SetupKey, type UpgradeKind } from './VehicleCatalog';

/** Why a garage action is not possible (shown to the player). */
export type GarageBlock = null | 'owned' | 'stars' | 'credits' | 'max' | 'locked' | 'unknown';

/** Can this car be bought right now? */
export function buyBlock(p: Progress, id: string): GarageBlock {
  const def = vehicleById(id);
  if (def.id !== id) return 'unknown';
  if (p.owned.includes(id)) return 'owned';
  if (totalStars(p) < def.requiresStars) return 'stars';
  if (p.credits < def.price) return 'credits';
  return null;
}

export function buyCar(p: Progress, id: string): boolean {
  if (buyBlock(p, id) !== null) return false;
  const def = vehicleById(id);
  p.credits -= def.price;
  p.owned.push(id);
  p.cars[id] = newCarSave(id);
  selectCar(p, id);
  return true;
}

export function selectCar(p: Progress, id: string): boolean {
  if (!p.owned.includes(id)) return false;
  p.car = id;
  p.paint = p.cars[id].paint;
  saveProgress(p);
  return true;
}

export function upgradeBlock(p: Progress, id: string, kind: UpgradeKind): GarageBlock {
  if (!p.owned.includes(id)) return 'locked';
  const lvl = p.cars[id].upgrades[kind];
  if (lvl >= MAX_UPGRADE) return 'max';
  const price = upgradePrice(vehicleById(id), kind, lvl)!;
  if (p.credits < price) return 'credits';
  return null;
}

/** Change one garage setup value by one step (free; owned cars only). */
export function adjustSetup(p: Progress, id: string, key: SetupKey, delta: number): boolean {
  if (!p.owned.includes(id) || !SETUP_KEYS.includes(key) || (delta !== 1 && delta !== -1)) return false;
  const c = p.cars[id];
  const v = c.setup[key] + delta;
  if (v < -SETUP_STEPS || v > SETUP_STEPS) return false;
  c.setup[key] = v;
  saveProgress(p);
  return true;
}

/** Back to the factory setup. */
export function resetSetup(p: Progress, id: string): boolean {
  if (!p.owned.includes(id)) return false;
  p.cars[id].setup = neutralSetup();
  saveProgress(p);
  return true;
}

export function buyUpgrade(p: Progress, id: string, kind: UpgradeKind): boolean {
  if (upgradeBlock(p, id, kind) !== null) return false;
  const lvl = p.cars[id].upgrades[kind];
  p.credits -= upgradePrice(vehicleById(id), kind, lvl)!;
  p.cars[id].upgrades[kind] = lvl + 1;
  saveProgress(p);
  return true;
}

/** A paint is available for a car when unlocked by stars, or when it is that car's factory colour. */
export function paintAvailable(p: Progress, id: string, paint: string): boolean {
  return PAINTS.some((x) => x.id === paint) && (isPaintUnlocked(p, paint) || vehicleById(id).defaultPaint === paint);
}

export function setCarPaint(p: Progress, id: string, paint: string): boolean {
  if (!p.owned.includes(id) || !paintAvailable(p, id, paint)) return false;
  p.cars[id].paint = paint;
  if (p.car === id) p.paint = paint;
  saveProgress(p);
  return true;
}

/** Can this part be fitted to the car now (buying it first if needed)? */
export function partBlock(p: Progress, id: string, slot: PartSlot, part: string): GarageBlock {
  if (!partDef(slot, part)) return 'unknown';
  if (!p.owned.includes(id)) return 'locked';
  const c = p.cars[id];
  if (ownsPart(c, id, slot, part)) return null;
  if (p.credits < partPrice(vehicleById(id), slot, part)) return 'credits';
  return null;
}

/** Fit a cosmetic part; buys it first when the car does not own it yet. */
export function fitPart(p: Progress, id: string, slot: PartSlot, part: string): boolean {
  if (partBlock(p, id, slot, part) !== null) return false;
  const c = p.cars[id];
  if (!ownsPart(c, id, slot, part)) {
    p.credits -= partPrice(vehicleById(id), slot, part);
    c.parts.push(partKey(slot, part));
  }
  (c.look as unknown as Record<string, string>)[slot] = part;
  saveProgress(p);
  return true;
}
