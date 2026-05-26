// Headless probe: drive the real game, send ground units across the Center_Bridge,
// see if they freeze on the deck. Outputs per-unit telemetry.
//
// Run with libs on the path:
//   LD_LIBRARY_PATH=/tmp/pwlibs/extracted/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH \
//   node Working/sim-center-bridge.mjs
import { chromium } from 'playwright';

const URL = 'http://localhost:3000';
const TICK_MS = 1000 / 60; // matches FIXED_TIMESTEP
const TICKS_TO_RUN = 60 * 30; // 30 seconds of sim
const PROBE_EVERY = 30; // ticks

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/error|Error|warn/i.test(t)) console.log(`[browser ${m.type()}]`, t);
});

await page.goto(URL, { waitUntil: 'load' });

// Click through to a match.
await page.waitForSelector('text=QUICK PLAY', { timeout: 20000 });
await page.click('text=QUICK PLAY');

// Pick three ground animals.
for (const name of ['Bear', 'Bunny', 'Cat']) {
  await page.waitForSelector(`text=${name}`, { timeout: 10000 });
  await page.click(`text=${name}`);
}
// Start button: anything labelled START / Start / Begin
const startBtn = await page.waitForSelector('button:has-text("Start")', { timeout: 10000 });
await startBtn.click();

await page.waitForFunction(
  () => !!(window.__rtsPath?.isReady?.() && window.__rtsStore && window.__rtsNav?.isReady?.()),
  { timeout: 30000 },
);

// Move all of the local player's ground units across the center bridge.
const setup = await page.evaluate(() => {
  const store = window.__rtsStore;
  const state = store.getState();
  state.unpauseGame?.();
  store.setState({ matchStarted: true, isPaused: false });

  const local = state.localPlayerId;
  const GROUND = new Set(['Bear', 'Bunny', 'Chicken', 'Cat', 'Fox', 'Pig', 'Yetti']);
  // Match just started; queens only spawn Units every 10s. Force-spawn one ground Unit per
  // friendly Queen so we have movers right now, positioned next to the queen.
  const queens = state.units.filter((u) => u.ownerId === local && u.kind === 'Queen');
  const idBase = Date.now();
  let extras = [];
  for (let i = 0; i < queens.length; i++) {
    const q = queens[i];
    extras.push({
      id: `probe-unit-${idBase}-${i}`,
      ownerId: q.ownerId,
      animal: q.animal,
      kind: 'Unit',
      position: { x: q.position.x + 2, y: q.position.y, z: q.position.z + 2 },
      hp: 100, maxHp: 100,
      attackDamage: 10, moveSpeed: 12,
      attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0,
      rotation: 0,
    });
  }
  if (extras.length) {
    // Repro the stuck-on-bridge scenario: a lone player ground unit crosses while one
    // enemy unit sits ON the bridge deck. Keep one enemy (the King; rotate to first
    // non-local player) and place it mid-deck on the Center_Bridge.
    const otherOwner = state.units.find((u) => u.ownerId !== local)?.ownerId;
    const enemyAnimal = state.units.find((u) => u.ownerId === otherOwner && u.kind === 'Unit')?.animal
      || state.units.find((u) => u.ownerId === otherOwner)?.animal
      || 'Bear';
    const planted = otherOwner
      ? [{
          id: `enemy-on-bridge-${idBase}`,
          ownerId: otherOwner,
          animal: enemyAnimal,
          kind: 'Unit',
          // Mid-Center_Bridge deck: x≈0, somewhere in the moat. Bridge bounds z ∈ [-81, 89].
          position: { x: 0, y: 0.25, z: 10 },
          hp: 999, maxHp: 999,
          attackDamage: 5, moveSpeed: 0,
          attackRange: 4, attackCooldownMs: 1000, lastAttackAtMs: 0,
          rotation: 0,
        }]
      : [];
    store.setState((s) => ({
      units: [...s.units.filter((u) => u.ownerId === local), ...planted, ...extras],
    }));
  }
  const groundUnits = store
    .getState()
    .units.filter((u) => u.ownerId === local && u.kind === 'Unit' && GROUND.has(u.animal));

  // Push them across the moat to the opposite side, biased to x=0 so they take Center_Bridge.
  const targets = groundUnits.map((u) => ({
    id: u.id,
    spawn: { ...u.position },
    dest: { x: 0, y: 0, z: -Math.sign(u.position.z) * 250 },
  }));

  // Issue one batched move order covering all ground units toward the same target side.
  // Group by sign(z) so each half goes to its opposite side.
  const byHemisphere = new Map();
  for (const t of targets) {
    const key = Math.sign(t.spawn.z) > 0 ? '+' : '-';
    if (!byHemisphere.has(key)) byHemisphere.set(key, { ids: [], dest: t.dest });
    byHemisphere.get(key).ids.push(t.id);
  }
  for (const group of byHemisphere.values()) {
    store.getState().moveCommand({ unitIds: group.ids, target: group.dest });
  }

  return {
    localPlayer: local,
    count: groundUnits.length,
    targets,
    bridgeBounds: window.__rtsTerrain?.getBridgeBounds?.(),
  };
});
console.log('SETUP:', JSON.stringify(setup, null, 2));

// Tick the sim manually since useFrame doesn't pump headlessly.
const trace = await page.evaluate(
  async ({ ticks, probeEvery, dt, ids }) => {
    const store = window.__rtsStore;
    const samples = [];
    let now = Date.now();
    for (let i = 0; i < ticks; i++) {
      now += dt * 1000;
      store.getState().tick(dt, now);
      if (i % probeEvery !== 0) continue;
      const units = store.getState().units;
      const snap = ids.map((id) => {
        const u = units.find((x) => x.id === id);
        if (!u) return { id, gone: true };
        const onBridge = window.__rtsTerrain?.isPositionOnBridge?.(u.position) ?? null;
        return {
          id,
          pos: { x: +u.position.x.toFixed(2), z: +u.position.z.toFixed(2) },
          hp: u.hp,
          order: store.getState().unitOrders?.[id] ? { z: +store.getState().unitOrders[id].z.toFixed(0) } : null,
          state: u.unitState ?? null,
          colAttempts: u.collisionAttempts ?? 0,
          firstBlockedAtMs: u.firstBlockedAtMs ?? null,
          movementPausedUntilMs: u.movementPausedUntilMs ?? null,
          stall: u.pathStall ?? 0,
          stuck: u.pathStuckTicks ?? 0,
          pi: u.pathIndex ?? null,
          plen: u.pathWaypoints?.length ?? 0,
          wp: u.pathWaypoints?.[u.pathIndex ?? 0]
            ? {
                x: +u.pathWaypoints[u.pathIndex ?? 0].x.toFixed(2),
                z: +u.pathWaypoints[u.pathIndex ?? 0].z.toFixed(2),
              }
            : null,
          onBridge,
        };
      });
      samples.push({ tick: i, snap });
    }
    return samples;
  },
  { ticks: TICKS_TO_RUN, probeEvery: PROBE_EVERY, dt: TICK_MS / 1000, ids: setup.targets.map((t) => t.id) },
);

for (const sample of trace) {
  console.log(`\n--- tick ${sample.tick} ---`);
  for (const s of sample.snap) {
    console.log(JSON.stringify(s));
  }
}

await browser.close();
