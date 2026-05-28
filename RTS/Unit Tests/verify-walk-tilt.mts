/**
 * Headless verification for the title-screen walk gait & turtle follow distance.
 * Builds a minimal three.js scene with named animal groups, drives the real
 * TitleChaseChoreographer, and asserts on the live transforms it writes.
 *
 * Run: npx ts-node --esm "Unit Tests/verify-walk-tilt.mts"
 */
import * as THREE from 'three';
import {
  TitleChaseChoreographer,
  CHASE_PAIRS,
} from '../src/components/Working/titleScreenChoreography.ts';

function makeAnimal(name: string, x: number, z: number, headingY = 0): THREE.Object3D {
  const group = new THREE.Object3D();
  group.name = name;
  group.position.set(x, 1, z);
  group.rotation.set(0, headingY, 0); // authored facing about world Y
  return group;
}

const root = new THREE.Object3D();
// Index 0 pair (Bee/Bear) plays first; Bear walks, Bee flies.
root.add(makeAnimal('Bear', 0, 0, 0));
root.add(makeAnimal('Bee', 0, 5, 0));
// Index 1 pair (Turtle chases Bunny, aimed at Pig) — used to check follow gap.
root.add(makeAnimal('Bunny', 40, 0, Math.PI / 4));
root.add(makeAnimal('Turtle', 38, 0, Math.PI / 4));
root.add(makeAnimal('Pig', 80, 40, 0));

const bearStartQuat = root.getObjectByName('Bear')!.quaternion.clone();
const beeStartQuat = root.getObjectByName('Bee')!.quaternion.clone();

const choreo = new TitleChaseChoreographer(root);

let failures = 0;
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
};

// Advance so the active (Bear/Bee) pair is mid-stride, away from a tilt zero.
// TRAVEL_SPEED 12, WALK_STRIDE 6 -> quarter stride at t = 0.125s gives peak-ish tilt.
choreo.update(0.125, undefined);

const bear = root.getObjectByName('Bear')!;
const bee = root.getObjectByName('Bee')!;

// Bear (walk) should pitch about its local X relative to authored facing.
const bearDelta = bear.quaternion.clone().premultiply(bearStartQuat.clone().invert());
const bearEuler = new THREE.Euler().setFromQuaternion(bearDelta, 'XYZ');
const bearPitchDeg = THREE.MathUtils.radToDeg(bearEuler.x);
check('walker pitches on X (nonzero)', Math.abs(bearPitchDeg) > 1, `pitch=${bearPitchDeg.toFixed(2)}°`);
check('walker pitch within 0–15° envelope', Math.abs(bearPitchDeg) <= 15.01, `|pitch|=${Math.abs(bearPitchDeg).toFixed(2)}°`);
check('walker has no spurious yaw/roll', Math.abs(THREE.MathUtils.radToDeg(bearEuler.y)) < 0.01 && Math.abs(THREE.MathUtils.radToDeg(bearEuler.z)) < 0.01);

// Bee (fly) keeps authored rotation exactly.
check('flyer rotation unchanged', bee.quaternion.angleTo(beeStartQuat) < 1e-6);

// At a stride boundary the walker is level (tilt returns to 0).
choreo.update(0.5, undefined); // distance = 6 = exactly one WALK_STRIDE -> sin(pi)=0
const bearLevel = bear.quaternion.clone().angleTo(bearStartQuat);
check('walker returns to level at stride boundary', THREE.MathUtils.radToDeg(bearLevel) < 0.01,
  `residual=${THREE.MathUtils.radToDeg(bearLevel).toFixed(4)}°`);

// Turtle follow distance: configured lagMultiplier=2 should double the gap vs a
// notional 1x. We read the gap from the prepared routes by advancing the
// sequence to the Turtle/Bunny pair and measuring leader↔chaser spacing.
const turtlePairIndex = CHASE_PAIRS.findIndex((p) => p.chaser === 'Turtle');
check('Turtle pair carries lagMultiplier=2', CHASE_PAIRS[turtlePairIndex].lagMultiplier === 2);

// MIN_CHASE_GAP is 12; authored gap here (~2.8) is smaller, so lag = 12 * 2 = 24.
// Drive the sequence until Turtle/Bunny is active, then read the live spacing.
let guard = 0;
let t = 1;
while (choreo.activeIndex !== turtlePairIndex && guard++ < 5000) {
  t += 0.5;
  choreo.update(t, undefined);
}
// Park the active pair at distance 0 by reading immediately after activation:
choreo.update(t, undefined);
const bunny = root.getObjectByName('Bunny')!.position;
const turtle = root.getObjectByName('Turtle')!.position;
const gap = Math.hypot(bunny.x - turtle.x, bunny.z - turtle.z);
check('Turtle trails Bunny by the doubled min gap (~24u)', Math.abs(gap - 24) < 0.5, `gap=${gap.toFixed(2)}u`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
