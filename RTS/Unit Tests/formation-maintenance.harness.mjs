// Behavioral guard for the persistent formation maintenance pass (state.ts
// maintainFormations + setFormation). It drives the REAL bundled simulation
// headlessly: spin up a match, let a side accumulate army Units, form them up, and
// assert the maintenance pass slotted them into the requested shape.
//
// No game logic is re-implemented and no positions are hard-coded — the shape is
// verified from its own definition (a Line's slots are collinear along the team
// facing, centered on the team anchor), so the test stays valid as tuning changes.
//
// Run from the RTS project root:
//   node "Unit Tests/formation-maintenance.harness.mjs"

import { loadSimulationApi } from './selfplay/bundleStore.mjs';

const SIM_DT_SECONDS = 1 / 60;
const SEED = 0x5eed1234;
const LINEUPS = { p0: ['Bear', 'Fox', 'Bunny'], p1: ['Cat', 'Pig', 'Frog'] };
const WARMUP_TICKS = 1500; // long enough for queens to spawn a few army Units
const MIN_MEMBERS = 3;
const COLLINEAR_EPSILON = 0.001; // a Line's slots share zero forward offset

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function main() {
  const api = await loadSimulationApi();
  const { useGameStore, applyNetCommand, setCommandRouter } = api;

  const realLog = console.log;
  console.log = () => {};
  try {
    useGameStore.getState().startMultiplayerMatch({ localRole: 'p0', seed: SEED, lineups: LINEUPS });
    // Behave like a lockstep peer: with a router installed the tick takes each
    // owner's drive vector from the synced `pilotMove` commands (which we issue
    // below) instead of the local pilotInput singleton — which has no value in Node.
    // applyNetCommand still applies locally (it bypasses the router), so commands
    // take effect deterministically. This mirrors how driving is fed in real play.
    setCommandRouter(() => {});

    // Tick until p0 has enough army Units to form a meaningful shape.
    let ownUnits = [];
    for (let tick = 1; tick <= WARMUP_TICKS; tick++) {
      useGameStore.getState().tick(SIM_DT_SECONDS, Date.now());
      ownUnits = useGameStore
        .getState()
        .units.filter((unit) => unit.ownerId === 'p0' && unit.kind === 'Unit' && unit.hp > 0);
      if (ownUnits.length >= MIN_MEMBERS) break;
      if (useGameStore.getState().gameOver) break;
    }
    console.log = realLog;
    assert(ownUnits.length >= MIN_MEMBERS, `p0 never fielded ${MIN_MEMBERS} army Units to form up`);
    console.log = () => {};

    const unitIds = ownUnits.map((unit) => unit.id);
    applyNetCommand('p0', { type: 'setFormation', payload: { unitIds, shape: 'line' } });

    // One tick runs the maintenance pass, which slots every member.
    useGameStore.getState().tick(SIM_DT_SECONDS, Date.now());

    console.log = realLog;
    const state = useGameStore.getState();

    // Exactly one fire team should now exist, holding the requested shape.
    const teamEntries = Object.entries(state.fireTeams);
    assert(teamEntries.length === 1, `expected one fire team, found ${teamEntries.length}`);
    const [teamId, team] = teamEntries[0];
    assert(team.shape === 'line', `expected shape 'line', got '${team.shape}'`);
    assert(team.dirty === false, 'team should be clean (re-slotted) after one tick');

    const members = state.units.filter(
      (unit) => unit.ownerId === 'p0' && unit.kind === 'Unit' && unit.hp > 0 && unit.fireTeamId === teamId
    );
    assert(members.length >= MIN_MEMBERS, `team lost members: ${members.length}`);

    const expectedKey = members
      .map((unit) => unit.id)
      .sort()
      .join(',');
    assert(team.memberKey === expectedKey, 'memberKey should record the sorted membership');

    // Every member must have an anchor on its slot (the maintenance pass pins it),
    // and the slots must describe a Line: collinear along the team facing, i.e. each
    // slot's FORWARD offset from the anchor is ~zero. The RIGHT offsets must be
    // distinct (no two units share a slot) and centered on the anchor.
    const sin = Math.sin(team.facing);
    const cos = Math.cos(team.facing);
    const rights = [];
    for (const unit of members) {
      assert(unit.anchor, `member ${unit.id} has no anchor slot`);
      const dx = unit.anchor.x - team.anchor.x;
      const dz = unit.anchor.z - team.anchor.z;
      const forward = dx * sin + dz * cos;
      const right = dx * cos - dz * sin;
      assert(
        Math.abs(forward) < COLLINEAR_EPSILON,
        `Line slot not collinear: forward offset ${forward.toFixed(4)} for ${unit.id}`
      );
      rights.push(right);
    }

    rights.sort((a, b) => a - b);
    for (let i = 1; i < rights.length; i++) {
      assert(rights[i] - rights[i - 1] > COLLINEAR_EPSILON, 'two members share the same Line slot');
    }
    const rightCentroid = rights.reduce((sum, value) => sum + value, 0) / rights.length;
    assert(Math.abs(rightCentroid) < 0.5, `Line not centered on anchor (centroid ${rightCentroid.toFixed(3)})`);

    // Every member should be either marching to its slot (an order was issued) or
    // already standing on it — a unit that reaches its slot has its order cleared on
    // arrival the same tick, which is correct, not a missing march.
    for (const unit of members) {
      const distToSlot = Math.hypot(unit.position.x - unit.anchor.x, unit.position.z - unit.anchor.z);
      assert(
        state.unitOrders[unit.id] || distToSlot < 2,
        `member ${unit.id} is neither marching to its slot nor on it (dist ${distToSlot.toFixed(2)})`
      );
    }

    // --- Drag-to-direct: a move order redirects the whole formation as one unit,
    // turning it to face the destination, instead of scattering its members. ---
    const directTarget = { x: team.anchor.x + 40, y: 0, z: team.anchor.z + 10 };
    applyNetCommand('p0', { type: 'moveUnits', payload: { unitIds: members.map((u) => u.id), target: directTarget } });
    const afterDirect = useGameStore.getState().fireTeams[teamId];
    assert(afterDirect, 'team disbanded on a move order');
    assert(
      Math.hypot(afterDirect.anchor.x - directTarget.x, afterDirect.anchor.z - directTarget.z) < 0.001,
      `formation anchor did not move to the order target: ${JSON.stringify(afterDirect.anchor)}`
    );
    const expectedFacing = Math.atan2(directTarget.x - team.anchor.x, directTarget.z - team.anchor.z);
    assert(
      Math.abs(afterDirect.facing - expectedFacing) < 0.001,
      `formation did not turn to face the destination (got ${afterDirect.facing.toFixed(3)}, expected ${expectedFacing.toFixed(3)})`
    );
    // Each formed member must be slotted by the maintenance pass — its march order
    // equals its assigned slot (its anchor) — not scattered to the raw click point.
    useGameStore.getState().tick(SIM_DT_SECONDS, Date.now());
    const afterDirectTick = useGameStore.getState();
    for (const unit of afterDirectTick.units.filter((u) => u.fireTeamId === teamId && u.kind === 'Unit' && u.hp > 0)) {
      const order = afterDirectTick.unitOrders[unit.id];
      if (!order) continue;
      assert(
        Math.hypot(order.x - unit.anchor.x, order.z - unit.anchor.z) < 0.001,
        `member ${unit.id} order does not match its slot (scattered, not slotted)`
      );
    }

    // --- Drive-keeps-shape: steer the formation and confirm it TRAVELS in shape. ---
    // Re-read fresh: moveCommand above ran through immer produce, replacing the state
    // object, so the earlier `team` reference is stale.
    const teamBeforeDrive = useGameStore.getState().fireTeams[teamId];
    const anchorBefore = { ...teamBeforeDrive.anchor };
    const facingBefore = teamBeforeDrive.facing;
    applyNetCommand('p0', { type: 'setPilotFireTeam', payload: { teamIds: [teamId] } });
    console.log = () => {};
    for (let i = 0; i < 90; i++) {
      applyNetCommand('p0', { type: 'pilotMove', payload: { x: 1, z: 0 } });
      useGameStore.getState().tick(SIM_DT_SECONDS, Date.now());
    }
    console.log = realLog;

    const driven = useGameStore.getState();
    const drivenTeam = driven.fireTeams[teamId];
    assert(drivenTeam, 'team disbanded while being driven');
    assert(
      drivenTeam.anchor.x > anchorBefore.x + 1,
      `anchor did not travel along the +x drive: ${anchorBefore.x.toFixed(2)} -> ${drivenTeam.anchor.x.toFixed(2)}`
    );
    assert(
      Math.abs(drivenTeam.facing - facingBefore) < COLLINEAR_EPSILON,
      'facing changed while driving (should translate only)'
    );

    // Shape must still be a Line after travelling: slots collinear about the moved anchor.
    const drivenMembers = driven.units.filter(
      (unit) => unit.ownerId === 'p0' && unit.kind === 'Unit' && unit.hp > 0 && unit.fireTeamId === teamId
    );
    const dsin = Math.sin(drivenTeam.facing);
    const dcos = Math.cos(drivenTeam.facing);
    for (const unit of drivenMembers) {
      const dx = unit.anchor.x - drivenTeam.anchor.x;
      const dz = unit.anchor.z - drivenTeam.anchor.z;
      const forward = dx * dsin + dz * dcos;
      assert(
        Math.abs(forward) < COLLINEAR_EPSILON,
        `Line lost its shape while driving: forward offset ${forward.toFixed(4)} for ${unit.id}`
      );
    }

    // --- Audibles: quick state tweaks on the formed team. ---
    const memberIds = drivenMembers.map((unit) => unit.id);
    const beforeAudible = useGameStore.getState().fireTeams[teamId];
    const spacingBefore = beforeAudible.spacing;
    const facingBeforeAudible = beforeAudible.facing;

    applyNetCommand('p0', { type: 'adjustFormation', payload: { unitIds: memberIds, op: 'expand' } });
    applyNetCommand('p0', { type: 'adjustFormation', payload: { unitIds: memberIds, op: 'rotateRight' } });
    const afterAudible = useGameStore.getState().fireTeams[teamId];
    assert(afterAudible.spacing > spacingBefore, `expand did not widen spacing: ${spacingBefore} -> ${afterAudible.spacing}`);
    assert(
      Math.abs(afterAudible.facing - facingBeforeAudible - Math.PI / 6) < 0.001,
      `rotateRight did not pivot facing by 30°: ${facingBeforeAudible.toFixed(3)} -> ${afterAudible.facing.toFixed(3)}`
    );

    // Focus-fire: ordering an attack with a formed team sets the team's focus target.
    const enemy = useGameStore.getState().units.find((unit) => unit.ownerId === 'p1' && unit.hp > 0);
    if (enemy) {
      applyNetCommand('p0', { type: 'attackTarget', payload: { unitIds: memberIds, targetId: enemy.id } });
      const focused = useGameStore.getState().fireTeams[teamId];
      assert(focused.focusTargetId === enemy.id, 'attack order did not set the team focus-fire target');
    }

    // --- Playbook: a call re-shapes & re-postures the team by its role. ---
    applyNetCommand('p0', { type: 'callPlay', payload: { play: 'turtle' } });
    const played = useGameStore.getState().fireTeams[teamId];
    assert(played, 'team disbanded on a play call');
    assert(played.shape === 'box', `turtle play should box the team, got '${played.shape}'`);
    const playedMembers = useGameStore
      .getState()
      .units.filter((unit) => unit.fireTeamId === teamId && unit.kind === 'Unit' && unit.hp > 0);
    for (const unit of playedMembers) {
      assert(
        unit.behavior?.stance === 'holdGround',
        `turtle play should set holdGround stance, got '${unit.behavior?.stance}' on ${unit.id}`
      );
    }

    // Disband: break the formation and free its units.
    applyNetCommand('p0', { type: 'adjustFormation', payload: { unitIds: memberIds, op: 'disband' } });
    const disbanded = useGameStore.getState();
    assert(!disbanded.fireTeams[teamId], 'disband did not remove the formation state');
    for (const id of memberIds) {
      const unit = disbanded.units.find((u) => u.id === id);
      if (unit) assert(unit.fireTeamId === undefined, `disband left ${id} still in a fire team`);
    }

    console.log(
      `PASS: ${members.length} units formed a Line, drove ` +
        `${(drivenTeam.anchor.x - anchorBefore.x).toFixed(1)}u in shape, audibles ` +
        `(expand/rotate/focus-fire) applied, Turtle play boxed+held the team, and disband freed it.`
    );
  } finally {
    console.log = realLog;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
