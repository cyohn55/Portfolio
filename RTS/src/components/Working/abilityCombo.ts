/**
 * abilityCombo — the single source of truth for the "use the selected animal's
 * special ability" gesture, shared by every input device.
 *
 * Each animal has one signature ability: the Turtle locks its shell, the Chicken
 * throws eggs, the Frog fires its tongue, the Cat hisses a radial knockback, the
 * Bee dives in a sacrificial swarm, and the Owl swoops to pick up a unit (or sets
 * down cargo it is already holding). On keyboard & mouse this fires on a
 * simultaneous left+right click; on a controller it fires from a single bound
 * button (default RB). Both paths converge here so the behaviour can never drift
 * between devices and can be unit tested without the DOM or Three.js.
 *
 * The flow is split into three pure-ish steps so callers can reuse the parts they
 * need: `planAbilityCombo` resolves *what* the current selection + cursor would
 * do, `abilityPlanIsActionable` reports whether anything would actually happen
 * (so a caller like the mouse handler can decide whether to swallow the event),
 * and `executeAbilityCombo` dispatches the store commands. `tryFireAbilityCombo`
 * is the convenience wrapper that does all three and returns whether it fired.
 */

import {
  ANIMAL_MOVEMENT_TYPES,
  type AnimalId,
  type Position3D,
  type Unit,
  type CommandThrowEggs,
  type CommandFireTongues,
  type CommandHiss,
  type CommandSwarm,
  type CommandOwlPickup,
  type CommandOwlDeliver,
} from '../../game/types';

/** The minimal slice of game state the combo reads. */
export interface AbilityComboContext {
  units: Unit[];
  localPlayerId: string | null;
  selectedUnitIds: string[];
}

/**
 * Where the gesture is aimed. Supplied differently per device — the mouse reads
 * the pointer, the controller reads its on-screen reticle — so the combo logic
 * stays device-agnostic.
 */
export interface AbilityComboCursor {
  /** Ground-plane (y=0) world point under the cursor/reticle, or null if it misses the map. */
  groundPoint(): Position3D | null;
  /** Nearest non-Base unit (any owner) under the cursor/reticle, or null when none is close. */
  unitUnderCursor(): Unit | null;
}

/**
 * The store actions the combo dispatches. Structurally matches the matching
 * GameStore methods, so callers can pass the store state directly.
 */
export interface AbilityComboActions {
  toggleTurtleShell(unitIds: string[]): void;
  throwEggs(cmd: CommandThrowEggs): void;
  fireTongues(cmd: CommandFireTongues): void;
  hiss(cmd: CommandHiss): void;
  swarm(cmd: CommandSwarm): void;
  pickup(cmd: CommandOwlPickup): void;
  deliverCargo(cmd: CommandOwlDeliver): void;
}

/** A resolved description of what the combo would do for the current state. */
export interface AbilityComboPlan {
  turtleIds: string[];
  catIds: string[];
  beeIds: string[];
  chickenIds: string[];
  frogIds: string[];
  /** Selected Owls (Unit kind) — the squad that would swoop on a pickup. */
  owlIds: string[];
  /** Subset of owlIds already holding cargo — a delivery press takes priority over a new pickup. */
  deliveringOwlIds: string[];
  /** The unit the Owls would grab (animal + owner), or null when no valid target sits under the cursor. */
  owlPickupTarget: { animal: AnimalId; ownerId: string } | null;
  /** Resolved ground point for the cursor-aimed abilities (eggs, tongues, owl delivery). */
  groundPoint: Position3D | null;
}

/**
 * The local player's selected, regular (Unit-kind) units of one animal — the only
 * units a combo ability ever affects. Kings and Queens are excluded so a royal-only
 * selection keeps the normal per-button behaviour and a monarch is never risked.
 */
function selectedUnitKindIdsForAnimal(ctx: AbilityComboContext, animal: AnimalId): string[] {
  if (!ctx.localPlayerId) return [];
  const selected = new Set(ctx.selectedUnitIds);
  return ctx.units
    .filter(
      (unit) =>
        unit.ownerId === ctx.localPlayerId &&
        unit.animal === animal &&
        unit.kind === 'Unit' &&
        selected.has(unit.id)
    )
    .map((unit) => unit.id);
}

export function planAbilityCombo(
  ctx: AbilityComboContext,
  cursor: AbilityComboCursor
): AbilityComboPlan {
  const selected = new Set(ctx.selectedUnitIds);
  const owlIds = selectedUnitKindIdsForAnimal(ctx, 'Owl');

  // Owls already holding friendly cargo make this a DELIVERY press (drop-off at the
  // cursor), which takes priority over starting a new pickup.
  const deliveringOwlIds =
    owlIds.length > 0
      ? ctx.units
          .filter(
            (unit) =>
              unit.ownerId === ctx.localPlayerId &&
              unit.animal === 'Owl' &&
              selected.has(unit.id) &&
              unit.owlPickup?.phase === 'holding'
          )
          .map((unit) => unit.id)
      : [];
  const deliverActive = deliveringOwlIds.length > 0;

  // PICKUP target: only when owls are selected, none are mid-delivery, a grabbable
  // unit sits under the cursor, and it isn't an air unit (those can't be plucked
  // out of the sky). The unit's animal type AND owner decide what the Owls grab.
  let owlPickupTarget: { animal: AnimalId; ownerId: string } | null = null;
  if (owlIds.length > 0 && !deliverActive) {
    const cursorUnit = cursor.unitUnderCursor();
    if (cursorUnit && cursorUnit.kind !== 'Base' && ANIMAL_MOVEMENT_TYPES[cursorUnit.animal] !== 'air') {
      owlPickupTarget = { animal: cursorUnit.animal, ownerId: cursorUnit.ownerId };
    }
  }

  return {
    turtleIds: selectedUnitKindIdsForAnimal(ctx, 'Turtle'),
    catIds: selectedUnitKindIdsForAnimal(ctx, 'Cat'),
    beeIds: selectedUnitKindIdsForAnimal(ctx, 'Bee'),
    chickenIds: selectedUnitKindIdsForAnimal(ctx, 'Chicken'),
    frogIds: selectedUnitKindIdsForAnimal(ctx, 'Frog'),
    owlIds,
    deliveringOwlIds,
    owlPickupTarget,
    groundPoint: cursor.groundPoint(),
  };
}

/** True when the plan would actually trigger at least one ability. */
export function abilityPlanIsActionable(plan: AbilityComboPlan): boolean {
  const owlsActive = plan.deliveringOwlIds.length > 0 || plan.owlPickupTarget !== null;
  return (
    plan.turtleIds.length > 0 ||
    plan.chickenIds.length > 0 ||
    plan.frogIds.length > 0 ||
    plan.catIds.length > 0 ||
    plan.beeIds.length > 0 ||
    owlsActive
  );
}

/** Dispatch every ability the plan calls for. Cursor-aimed abilities no-op when the cursor missed the map. */
export function executeAbilityCombo(plan: AbilityComboPlan, actions: AbilityComboActions): void {
  if (plan.turtleIds.length > 0) actions.toggleTurtleShell(plan.turtleIds);
  // Hiss is radial from each cat and Swarm has each bee pick its own target, so
  // neither needs a cursor position.
  if (plan.catIds.length > 0) actions.hiss({ unitIds: plan.catIds });
  if (plan.beeIds.length > 0) actions.swarm({ unitIds: plan.beeIds });

  if (plan.deliveringOwlIds.length > 0) {
    if (plan.groundPoint) {
      actions.deliverCargo({
        unitIds: plan.deliveringOwlIds,
        target: { x: plan.groundPoint.x, y: 0, z: plan.groundPoint.z },
      });
    }
  } else if (plan.owlPickupTarget) {
    actions.pickup({
      unitIds: plan.owlIds,
      targetAnimal: plan.owlPickupTarget.animal,
      targetOwnerId: plan.owlPickupTarget.ownerId,
    });
  }

  if ((plan.chickenIds.length > 0 || plan.frogIds.length > 0) && plan.groundPoint) {
    const cursor: Position3D = { x: plan.groundPoint.x, y: 0, z: plan.groundPoint.z };
    if (plan.chickenIds.length > 0) actions.throwEggs({ unitIds: plan.chickenIds, target: cursor });
    if (plan.frogIds.length > 0) actions.fireTongues({ unitIds: plan.frogIds, cursor });
  }
}

/**
 * Plan, check, and (if anything would fire) execute the combo in one call.
 * Returns whether an ability fired, so a caller can decide whether to consume the
 * input that triggered it.
 */
export function tryFireAbilityCombo(
  ctx: AbilityComboContext,
  cursor: AbilityComboCursor,
  actions: AbilityComboActions
): boolean {
  const plan = planAbilityCombo(ctx, cursor);
  if (!abilityPlanIsActionable(plan)) return false;
  executeAbilityCombo(plan, actions);
  return true;
}
