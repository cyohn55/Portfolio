import { test, expect } from '@playwright/test';
import * as THREE from 'three';
import {
  abilityFor,
  hissPushDirection,
  computeHissPushes,
  selectSwarmTarget,
  swarmStingKills,
  stepGreatCircle,
  surfaceAimDirection,
  eggHitTarget,
  selectNearestUnclaimedEnemy,
  HISS_RANGE,
  HISS_PUSH_DISTANCE,
  HISS_PUSH_MS,
  HISS_PUSH_SPEED,
  SWARM_DIVE_SPEED,
  SWARM_STING_RANGE,
  SWARM_STING_KILL_CHANCE,
  EGG_SPEED,
  EGG_HIT_RADIUS,
  EGG_MAX_RANGE,
  TONGUE_RANGE,
  TONGUE_EXTEND_SPEED,
  OWL_FLIGHT_LIFT,
  OWL_PLUCK_LIFT,
  type AbilityActor,
} from '../src/components/Working/conquest/conquestAbilities';
import { AGGRO_RANGE, CHASE_SPEED } from '../src/components/Working/conquest/conquestCombat';

/**
 * Unit tests for the Conquest per-animal abilities (Increment 3). Pure Node —
 * every helper is side-effect-free, so we assert real geometry (radial push
 * direction tangent to the sphere), real targeting (nearest unclaimed enemy), and
 * the globe-scaled tuning derived from the shared combat anchors, rather than
 * constants copied from the implementation.
 */

/** Build an ability actor at a unit-sphere position from a direction + radius. */
function actorAt(
  id: string,
  controllerId: string,
  direction: THREE.Vector3,
  radius = 1,
  overrides: Partial<AbilityActor> = {},
): AbilityActor {
  return {
    id,
    controllerId,
    position: direction.clone().normalize().multiplyScalar(radius),
    dead: false,
    ...overrides,
  };
}

test.describe('Ability taxonomy', () => {
  test('each special animal maps to its signature ability', () => {
    expect(abilityFor('Turtle')).toBe('shell');
    expect(abilityFor('Cat')).toBe('hiss');
    expect(abilityFor('Bee')).toBe('swarm');
    expect(abilityFor('Chicken')).toBe('eggs');
    expect(abilityFor('Frog')).toBe('tongue');
    expect(abilityFor('Owl')).toBe('pickup');
  });

  test('an animal without a special returns null', () => {
    expect(abilityFor('Bear')).toBeNull();
    expect(abilityFor('Pig')).toBeNull();
  });
});

test.describe('Globe-scaled tuning', () => {
  test('every ability radius is sub-tile (globe units), not battlemap units', () => {
    // A level-3 tile spans ~0.18 globe units; a hiss clears roughly the cat's own
    // bubble and a sting is true contact — both well under a whole-planet reach.
    expect(HISS_RANGE).toBeGreaterThan(0);
    expect(HISS_RANGE).toBeLessThan(1);
    expect(SWARM_STING_RANGE).toBeGreaterThan(0);
    expect(SWARM_STING_RANGE).toBeLessThan(HISS_RANGE);
  });

  test('hiss push speed is exactly the shove distance over its duration', () => {
    expect(HISS_PUSH_SPEED).toBeCloseTo(HISS_PUSH_DISTANCE / (HISS_PUSH_MS / 1000), 9);
  });

  test('a swarm dive is faster than an ordinary chase', () => {
    expect(SWARM_DIVE_SPEED).toBeGreaterThan(CHASE_SPEED);
  });

  test('the sting is an even coin flip', () => {
    expect(SWARM_STING_KILL_CHANCE).toBeGreaterThan(0);
    expect(SWARM_STING_KILL_CHANCE).toBeLessThan(1);
  });
});

test.describe('Hiss push geometry', () => {
  test('the push points away from the cat and lies tangent to the sphere', () => {
    const catDir = new THREE.Vector3(0, 1, 0);
    const targetDir = new THREE.Vector3(0.2, 1, 0); // a little to the side, same hemisphere
    const cat = actorAt('cat', 'p0', catDir);
    const target = actorAt('enemy', 'ai1', targetDir);

    const push = hissPushDirection(cat.position, target.position);

    expect(push.length()).toBeCloseTo(1, 6); // unit direction
    // Tangent: perpendicular to the surface normal at the target.
    const up = target.position.clone().normalize();
    expect(push.dot(up)).toBeCloseTo(0, 6);
    // Outward: a step along the push increases distance from the cat.
    const before = target.position.distanceTo(cat.position);
    const after = target.position.clone().addScaledVector(push, 0.01).distanceTo(cat.position);
    expect(after).toBeGreaterThan(before);
  });

  test('a target sitting exactly on the cat still gets a valid outward tangent', () => {
    const dir = new THREE.Vector3(1, 0, 0);
    const cat = actorAt('cat', 'p0', dir);
    const onTop = actorAt('enemy', 'ai1', dir);
    const push = hissPushDirection(cat.position, onTop.position);
    expect(push.length()).toBeCloseTo(1, 6);
    expect(push.dot(onTop.position.clone().normalize())).toBeCloseTo(0, 6);
  });
});

test.describe('Hiss targeting', () => {
  const cat = actorAt('cat', 'p0', new THREE.Vector3(0, 1, 0));
  const nearEnemy = actorAt('near', 'ai1', new THREE.Vector3(0.05, 1, 0));
  const ally = actorAt('ally', 'p0', new THREE.Vector3(0.05, 1, 0.02));
  const deadEnemy = actorAt('dead', 'ai1', new THREE.Vector3(-0.05, 1, 0), { dead: true });
  // Far around the globe — comfortably outside HISS_RANGE.
  const farEnemy = actorAt('far', 'ai1', new THREE.Vector3(0, -1, 0));

  test('shoves only living enemies inside the hiss radius', () => {
    const pushes = computeHissPushes(cat, [cat, nearEnemy, ally, deadEnemy, farEnemy], HISS_RANGE);
    const ids = pushes.map((p) => p.id);
    expect(ids).toContain('near');
    expect(ids).not.toContain('ally');   // allies are not shoved
    expect(ids).not.toContain('dead');   // the dead are not shoved
    expect(ids).not.toContain('far');    // out of range
    expect(ids).not.toContain('cat');    // never the caster itself
  });

  test('a hiss with no enemy in range shoves nobody', () => {
    expect(computeHissPushes(cat, [cat, ally, farEnemy], HISS_RANGE)).toHaveLength(0);
  });
});

test.describe('Swarm targeting', () => {
  const bee = actorAt('bee', 'p0', new THREE.Vector3(0, 1, 0));
  const near = actorAt('near', 'ai1', new THREE.Vector3(0.03, 1, 0));
  const far = actorAt('far', 'ai1', new THREE.Vector3(0.09, 1, 0));
  const ally = actorAt('ally', 'p0', new THREE.Vector3(0.01, 1, 0));

  test('claims the nearest unclaimed enemy, never an ally', () => {
    const picked = selectSwarmTarget(bee, [bee, ally, near, far], new Set());
    expect(picked).toBe(near);
  });

  test('a claimed target is skipped so a cloud spreads its stings', () => {
    const picked = selectSwarmTarget(bee, [bee, near, far], new Set(['near']));
    expect(picked).toBe(far);
  });

  test('returns null when every enemy is already claimed', () => {
    const picked = selectSwarmTarget(bee, [bee, near, far], new Set(['near', 'far']));
    expect(picked).toBeNull();
  });
});

test.describe('Swarm sting coin flip', () => {
  test('a roll under the kill chance kills both; at or above it fizzles', () => {
    expect(swarmStingKills(0)).toBe(true);
    expect(swarmStingKills(SWARM_STING_KILL_CHANCE - 0.0001)).toBe(true);
    expect(swarmStingKills(SWARM_STING_KILL_CHANCE)).toBe(false);
    expect(swarmStingKills(0.999)).toBe(false);
  });
});

test.describe('Projectile/beam/carry tuning (increment 3 part 2)', () => {
  test('egg flies faster than a chase, hits at near-contact, ranges a few tiles', () => {
    expect(EGG_SPEED).toBeGreaterThan(CHASE_SPEED);
    expect(EGG_HIT_RADIUS).toBeGreaterThan(0);
    expect(EGG_HIT_RADIUS).toBeLessThan(AGGRO_RANGE);   // a near miss whiffs
    expect(EGG_MAX_RANGE).toBeGreaterThan(AGGRO_RANGE); // reaches past the aggro bubble
  });

  test('a tongue reaches past the aggro bubble and extends quickly', () => {
    expect(TONGUE_RANGE).toBeGreaterThan(AGGRO_RANGE);
    expect(TONGUE_EXTEND_SPEED).toBeGreaterThan(CHASE_SPEED);
  });

  test('an owl carries higher than it swoops (a real lift, then a drop)', () => {
    expect(OWL_FLIGHT_LIFT).toBeGreaterThan(OWL_PLUCK_LIFT);
    expect(OWL_PLUCK_LIFT).toBeGreaterThan(0);
  });
});

test.describe('Great-circle surface travel', () => {
  test('a step preserves the projectile altitude and advances the expected arc', () => {
    const radius = 1.05;
    const start = new THREE.Vector3(1, 0, 0).multiplyScalar(radius);
    const heading = new THREE.Vector3(0, 0, 1); // tangent at the start
    const arc = 0.2;

    const stepped = stepGreatCircle(start, heading, arc);

    expect(stepped.position.length()).toBeCloseTo(radius, 9); // stays on its own sphere
    // Arc length = angle * radius, so the angle turned is arc / radius.
    const angle = start.angleTo(stepped.position);
    expect(angle).toBeCloseTo(arc / radius, 6);
    // The carried heading stays a unit tangent at the new point.
    expect(stepped.direction.length()).toBeCloseTo(1, 6);
    expect(stepped.direction.dot(stepped.position.clone().normalize())).toBeCloseTo(0, 6);
  });

  test('a degenerate heading (straight up) leaves the point put', () => {
    const start = new THREE.Vector3(0, 1, 0);
    const stepped = stepGreatCircle(start, new THREE.Vector3(0, 1, 0), 0.3);
    expect(stepped.position.distanceTo(start)).toBeCloseTo(0, 9);
  });
});

test.describe('Surface aim', () => {
  test('the aim heading is a unit tangent pointing toward the target', () => {
    const from = new THREE.Vector3(0, 1, 0);
    const to = new THREE.Vector3(0.3, 1, 0);
    const aim = surfaceAimDirection(from, to);
    expect(aim.length()).toBeCloseTo(1, 6);
    expect(aim.dot(from.clone().normalize())).toBeCloseTo(0, 6); // tangent at the launch point
    // A step along the aim moves closer to the target.
    const before = from.distanceTo(to);
    const after = from.clone().addScaledVector(aim, 0.01).distanceTo(to);
    expect(after).toBeLessThan(before);
  });
});

test.describe('Egg collision', () => {
  const egg = new THREE.Vector3(0, 1, 0).multiplyScalar(1.02);
  test('hits the nearest living enemy inside the radius, never an ally or the dead', () => {
    const near = actorAt('near', 'ai1', new THREE.Vector3(0.005, 1, 0), 1);
    const ally = actorAt('ally', 'p0', new THREE.Vector3(0.004, 1, 0), 1);
    const dead = actorAt('dead', 'ai1', new THREE.Vector3(0.003, 1, 0), 1, { dead: true });
    const far = actorAt('far', 'ai1', new THREE.Vector3(0, -1, 0), 1);
    const hit = eggHitTarget(egg, 'p0', [near, ally, dead, far], EGG_HIT_RADIUS);
    expect(hit?.id).toBe('near');
  });

  test('misses when the nearest enemy is outside the radius', () => {
    const far = actorAt('far', 'ai1', new THREE.Vector3(0.5, 1, 0), 1);
    expect(eggHitTarget(egg, 'p0', [far], EGG_HIT_RADIUS)).toBeNull();
  });
});

test.describe('Tongue/pickup claiming', () => {
  const frog = actorAt('frog', 'p0', new THREE.Vector3(0, 1, 0));
  const near = actorAt('near', 'ai1', new THREE.Vector3(0.02, 1, 0));
  const far = actorAt('far', 'ai1', new THREE.Vector3(0.05, 1, 0));
  const ally = actorAt('ally', 'p0', new THREE.Vector3(0.01, 1, 0));
  const downed = actorAt('downed', 'ai1', new THREE.Vector3(0.015, 1, 0), 1, { downed: true });
  const outOfRange = actorAt('out', 'ai1', new THREE.Vector3(0, -1, 0));

  test('claims the nearest in-range unclaimed enemy, skipping allies and the downed', () => {
    const picked = selectNearestUnclaimedEnemy(
      frog, [frog, ally, downed, near, far, outOfRange], new Set(), TONGUE_RANGE,
    );
    expect(picked?.id).toBe('near');
  });

  test('a claimed enemy is skipped so a line spreads its grabs', () => {
    const picked = selectNearestUnclaimedEnemy(frog, [near, far], new Set(['near']), TONGUE_RANGE);
    expect(picked?.id).toBe('far');
  });

  test('returns null when the only enemy is out of range', () => {
    expect(selectNearestUnclaimedEnemy(frog, [outOfRange], new Set(), TONGUE_RANGE)).toBeNull();
  });
});
