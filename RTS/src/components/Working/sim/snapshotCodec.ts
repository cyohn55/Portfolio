// Worker-offload Phase 1 (P1-4) — the units snapshot codec (structure-of-arrays).
//
// The per-frame snapshot's `units` array is by far the heaviest thing crossing the worker
// boundary: hundreds of objects, each with a nested {x,y,z} position and a sim-internal A*
// path cache (waypoint arrays). Structured-cloning all of that every frame is the main
// thread's dominant post-flip cost. This codec splits a unit into:
//
//   • HOT numeric columns (x, y, z, rotation, hp) packed into one Float64Array — the fields
//     the renderer reads every frame. The buffer is TRANSFERRED (zero-copy) across the
//     boundary instead of structure-cloned.
//   • a COLD object carrying every other field, MINUS the A* path cache (sim-internal, never
//     read on the main thread — see the determinism/render audit). Smaller to clone, and no
//     longer drags the nested position object or the per-unit waypoint arrays over the wire.
//
// decodeUnits reassembles full unit objects identical (for every render/UI-visible field) to
// the source units, so ingest stays semantically the same as a plain clone — this is purely a
// transport optimization, with no change to what the mirror ends up holding.

import type { Unit } from '../../../game/types';

// Hot columns, in packed order: position.x, position.y, position.z, rotation, hp.
const HOT_STRIDE = 5;

// Sim-internal A* path cache (GridPathfinder, ground units only). Recomputed inside the
// worker each tick; never read on the main-thread mirror, so it is dropped from the snapshot.
const PATH_CACHE_FIELDS: ReadonlySet<string> = new Set([
  'pathWaypoints',
  'pathIndex',
  'pathDestX',
  'pathDestZ',
  'pathVersion',
  'pathStall',
  'pathProgressDist',
  'pathStuckTicks',
  'pathLastX',
  'pathLastZ',
]);

// Fields packed into the hot buffer, so they are omitted from the cold object.
const HOT_FIELDS: ReadonlySet<string> = new Set(['position', 'rotation', 'hp']);

/** The packed hot columns. `buffer` is a transferable ArrayBuffer (a Float64Array's storage). */
export interface UnitsHot {
  buffer: ArrayBuffer;
  count: number;
  stride: number;
}

/** The encoded units: transferable hot columns + the plain-cloneable cold remainder. */
export interface EncodedUnits {
  hot: UnitsHot;
  cold: unknown[];
}

/**
 * Encode units into transferable hot columns + a cold object array. Runs in the worker. The
 * cold objects shallow-reference the live unit's nested values (behavior, anchor, …); that is
 * safe because postMessage deep-clones them across the boundary and the cold array is discarded
 * right after — the worker's authoritative units are never mutated here.
 */
export function encodeUnits(units: readonly Unit[]): EncodedUnits {
  const count = units.length;
  const columns = new Float64Array(count * HOT_STRIDE);
  const cold = new Array<unknown>(count);

  for (let i = 0; i < count; i++) {
    const unit = units[i];
    const offset = i * HOT_STRIDE;
    columns[offset] = unit.position.x;
    columns[offset + 1] = unit.position.y;
    columns[offset + 2] = unit.position.z;
    columns[offset + 3] = unit.rotation;
    columns[offset + 4] = unit.hp;

    const lean: Record<string, unknown> = {};
    for (const key in unit) {
      if (HOT_FIELDS.has(key) || PATH_CACHE_FIELDS.has(key)) continue;
      lean[key] = (unit as unknown as Record<string, unknown>)[key];
    }
    cold[i] = lean;
  }

  return { hot: { buffer: columns.buffer, count, stride: HOT_STRIDE }, cold };
}

/**
 * Reassemble full unit objects from the encoded form. Runs on the main thread during ingest.
 * The result is field-for-field equal to the source units for every render/UI field (the only
 * thing dropped is the main-thread-irrelevant path cache), so downstream code is unaffected.
 */
export function decodeUnits(hot: UnitsHot, cold: readonly unknown[]): Unit[] {
  const columns = new Float64Array(hot.buffer);
  const units = new Array<Unit>(hot.count);

  for (let i = 0; i < hot.count; i++) {
    const offset = i * hot.stride;
    units[i] = {
      ...(cold[i] as object),
      position: { x: columns[offset], y: columns[offset + 1], z: columns[offset + 2] },
      rotation: columns[offset + 3],
      hp: columns[offset + 4],
    } as Unit;
  }

  return units;
}
