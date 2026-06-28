/**
 * UnitPlacementIndicator — the blue, upside-down teardrop that floats above a
 * piloted King/Queen while the player holds the rally key to designate units for
 * a placement order. The number inside counts how many followers will peel off
 * (one per UNIT_PLACEMENT_INTERVAL_MS held); the teardrop's point aims down at
 * the monarch it belongs to.
 *
 * It lives in the Canvas tree (a sibling of the units) and tracks the monarch's
 * live position every frame via a ref, off the React render path, so following a
 * fast-moving piloted unit never triggers re-renders. Only the designated count
 * (which changes at most once per interval) drives React updates.
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useGameStore, getSimSnapshot } from '../../game/state';
import { useUiStore } from '../../game/uiStore';
import { getKindTargetScale } from '../../utils/ModelPreloader';
import type { MonarchKind } from './monarchPilot';

// Extra lift above the monarch's model so the teardrop clears its head; the
// model's target scale approximates its height, so larger royals get more room.
const HEADROOM_PADDING = 2;
// Fixed lift above the targeting cursor (clears the spinning pyramid) when the
// gesture deploys at a cursor point rather than on the monarch.
const CURSOR_HEADROOM = 4.5;

export function UnitPlacementIndicator() {
  const groupRef = useRef<THREE.Group>(null);
  const pilotedUnitId = useUiStore((s) => s.pilotedUnitId); // pilot mirror is local-UI (P1-1)
  // Placement teardrop state lives on useUiStore (local-UI, P1-1).
  const placementCount = useUiStore((s) => s.unitPlacementCount);
  // When set, the teardrop floats above this ground point (the controller's
  // cursor deploy) instead of above the piloted monarch.
  const placementCursor = useUiStore((s) => s.unitPlacementCursor);

  // Keep the teardrop pinned over its anchor — the cursor point when deploying at
  // the cursor, otherwise the piloted monarch as it is driven around.
  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    if (placementCursor) {
      group.position.set(placementCursor.x, placementCursor.y + CURSOR_HEADROOM, placementCursor.z);
      return;
    }
    if (!pilotedUnitId) return;
    const monarch = getSimSnapshot().units.find((unit) => unit.id === pilotedUnitId);
    if (!monarch) return;
    const headroom = getKindTargetScale(monarch.animal, monarch.kind as MonarchKind) + HEADROOM_PADDING;
    group.position.set(monarch.position.x, monarch.position.y + headroom, monarch.position.z);
  });

  // Only visible mid-gesture: a piloted monarch with at least one designated unit.
  if (!pilotedUnitId || placementCount < 1) return null;

  // Seed the group at the anchor's current spot so it never flashes at the origin
  // for the first frame before useFrame takes over tracking.
  const monarch = getSimSnapshot().units.find((unit) => unit.id === pilotedUnitId);
  const initialPosition: [number, number, number] = placementCursor
    ? [placementCursor.x, placementCursor.y + CURSOR_HEADROOM, placementCursor.z]
    : monarch
      ? [
          monarch.position.x,
          monarch.position.y + getKindTargetScale(monarch.animal, monarch.kind as MonarchKind) + HEADROOM_PADDING,
          monarch.position.z,
        ]
      : [0, 0, 0];

  return (
    <group ref={groupRef} position={initialPosition}>
      <Html center zIndexRange={[100, 0]} style={{ pointerEvents: 'none' }}>
        <div style={teardropWrapperStyle}>
          <div style={teardropShapeStyle} />
          <span style={teardropNumberStyle}>{placementCount}</span>
        </div>
      </Html>
    </group>
  );
}

// The pointed teardrop is a rounded square with one sharp corner, rotated 45° so
// the sharp corner points straight down at the monarch; the number sits in an
// un-rotated overlay so it stays upright.
const TEARDROP_SIZE_PX = 30;

const teardropWrapperStyle: React.CSSProperties = {
  position: 'relative',
  width: TEARDROP_SIZE_PX,
  height: TEARDROP_SIZE_PX,
  // Lift the wrapper so the downward point (not the center) sits at the anchor.
  transform: `translateY(-${TEARDROP_SIZE_PX / 2}px)`,
  userSelect: 'none',
};

const teardropShapeStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: '#2f6bff',
  border: '2px solid #cfe0ff',
  borderRadius: '50% 50% 50% 0',
  // Rotate so the one sharp corner points straight DOWN at the monarch (rotate(45deg)
  // would aim it left; -45deg swings it the extra 90° to vertical).
  transform: 'rotate(-45deg)',
  boxShadow: '0 2px 6px rgba(0, 0, 0, 0.45)',
};

const teardropNumberStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#ffffff',
  fontWeight: 700,
  fontSize: 14,
  fontFamily: 'system-ui, sans-serif',
  lineHeight: 1,
  pointerEvents: 'none',
};
