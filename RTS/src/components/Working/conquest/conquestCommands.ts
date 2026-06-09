// conquestCommands — pure, framework-free selection helpers behind the Conquest
// army-command gestures (Tap/Double-Tap/Hold on the bound "Space" input).
//
// Single responsibility: decide WHICH units a command targets, given the live
// roster and a control predicate. Keeping this free of React, Three.js, and the
// store lets it be unit-tested in isolation and reused by the input layer
// (ConquestField) without duplicating the "is this army mine, alive, and
// orderable?" rules. The caller owns the side effects (mutating selection sets or
// issuing move orders); these functions only compute id lists.
//
// Mirrors Quick Play's Space gesture decomposition (see gestureModes / monarchPilot):
//   - rally (Tap)            → the piloted army's units, so they regroup on the monarch
//   - selectAllUnits (2-Tap) → every unit the player controls
//   - deployUnits (Hold)     → every controlled unit, to muster on the piloted monarch
// The semantics are re-derived for Conquest's always-follow, capture-driven model
// (a player may command several armies at once after a capture).

/**
 * The minimal unit shape these helpers need. A superset of the live field unit
 * (LiveUnit satisfies it), so the field can pass its roster directly. `armyId` is
 * the unit's permanent army identity (used to resolve control); a unit being
 * carried by an Owl is temporarily uncommandable, exactly as the pointer layer
 * treats it.
 */
export interface SelectableUnit {
  id: string;
  armyId: string;
  dead: boolean;
  carriedByOwlId: string | null;
}

/**
 * True when a unit can currently be selected/ordered: it is alive and not held in
 * an Owl's talons. Downed monarchs are intentionally INCLUDED (they can be
 * selected; the order layer separately declines to move a downed unit), matching
 * the pointer-selection rules in ConquestField.
 */
function isCommandable(unit: SelectableUnit): boolean {
  return !unit.dead && unit.carriedByOwlId === null;
}

/**
 * Ids of every commandable unit in `armyId`, but only when the player controls
 * that army. Returns an empty list for an army the player does not control, so the
 * caller can apply the result unconditionally. Backs the Rally (Tap) gesture: the
 * piloted monarch's army is gathered and selected.
 */
export function selectArmyUnitIds<UnitType extends SelectableUnit>(
  units: readonly UnitType[],
  armyId: string,
  controls: (armyId: string) => boolean,
): string[] {
  if (!controls(armyId)) return [];
  const ids: string[] = [];
  for (const unit of units) {
    if (unit.armyId === armyId && isCommandable(unit)) ids.push(unit.id);
  }
  return ids;
}

/**
 * Ids of every commandable unit across all armies the player currently controls
 * (a player may command several after captures). Backs the Select All (Double-Tap)
 * and Muster (Hold) gestures.
 */
export function selectAllControlledUnitIds<UnitType extends SelectableUnit>(
  units: readonly UnitType[],
  controls: (armyId: string) => boolean,
): string[] {
  const ids: string[] = [];
  for (const unit of units) {
    if (isCommandable(unit) && controls(unit.armyId)) ids.push(unit.id);
  }
  return ids;
}
