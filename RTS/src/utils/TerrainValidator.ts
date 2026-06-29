import * as THREE from 'three';
import type { Position3D, AnimalId, MovementType } from '../game/types';
import { ANIMAL_MOVEMENT_TYPES } from '../game/types';
import { nearestWalkableCell } from '../components/Working/terrainSlide';

// Water color in the battle map: #4A99FFFF
const WATER_COLOR = new THREE.Color(0x4A99FF);
const COLOR_TOLERANCE = 0.1; // Per-channel tolerance when matching terrain colors

// Bridge decks are identified by mesh name, not color: every deck mesh lives under a
// node named "Right_Bridge_<frame>" / "Left_Bridge_<frame>". Color is unusable here —
// the deck spans several grays (#a6a6a6, #676365, #c7c7c7, including the walkable
// surface) and hundreds of unrelated map props share those same grays. A position
// over a bridge deck lets ground units cross water there, provided that bridge is
// lowered (see isBridgeTraversable).
const BRIDGE_NAME_PATTERN = /bridge/i;
const RIGHT_NAME_PATTERN = /right/i;
const LEFT_NAME_PATTERN = /left/i;
const CENTER_NAME_PATTERN = /center/i;

// Which bridge a deck mesh belongs to. The right/left bridges raise and lower; the
// center bridge is a static, always-down crossing.
export type BridgeSide = 'right' | 'left' | 'center';

// Max world-space span (largest of x/y/z) a real bridge deck can have. Guards against
// map-sized geometry that happens to be named like a bridge (e.g. a skybox sphere
// accidentally duplicated and renamed) being treated as a crossable deck — which
// would let ground units walk on water everywhere. Real decks are tens of units; the
// longest current one is ~90.
const MAX_BRIDGE_SPAN = 300;

// Reusable straight-down ray direction for terrain raycasts.
const DOWN = new THREE.Vector3(0, -1, 0);

// Side length (world units) of a ground-traversability cache cell. The per-tick
// movement code queries terrain for every ground unit; caching the (raycast-backed)
// result per cell keeps that query O(1) instead of casting a ray every step.
const TERRAIN_CELL_SIZE = 1;

// Single shared "no deck here" object returned by deckAt for misses and stored in
// the deckAtCache, so the hot path (every ground unit, every tick) doesn't allocate.
const DECK_AT_MISS: { onDeck: boolean; side: BridgeSide | null } = Object.freeze({
  onDeck: false,
  side: null,
}) as { onDeck: boolean; side: BridgeSide | null };

// Shared miss object for bridgeAtCache (same rationale as DECK_AT_MISS).
const BRIDGE_AT_MISS: { onBridge: boolean; side: BridgeSide | null } = Object.freeze({
  onBridge: false,
  side: null,
}) as { onBridge: boolean; side: BridgeSide | null };

// Extra Y added to the center bridge's reported surface so a unit standing on it
// sits slightly above the deck primitive's top — clearing the trim/planks/rails
// that sit a fraction of a unit above the picked deck slab on the center bridge.
// The right/left bridges' deck primitives already include the walking surface at
// their top Y, so no headroom is needed for them. Tunable: increase if visible
// clipping persists, decrease if units appear to hover.
const CENTER_DECK_HEADROOM = 0.5;

export class TerrainValidator {
  // Accepts any Object3D (Scene or merged Group); only .traverse() is used.
  private battleMapScene: THREE.Object3D | null = null;
  private waterMeshes: THREE.Mesh[] = [];
  // Combined xz bounding box of all water meshes (with a small margin). Used as a
  // cheap broad-phase: a position outside this box cannot be over water, so the
  // far more expensive per-position raycast is skipped. Most combat happens away
  // from water, so this keeps the per-tick terrain cost negligible at scale.
  private waterBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  // Bridge deck meshes (all raise/lower frames), split by side so the bridge's
  // raised/lowered state can be checked, plus their combined xz broad-phase box.
  private rightBridgeMeshes: THREE.Mesh[] = [];
  private leftBridgeMeshes: THREE.Mesh[] = [];
  // The center bridge is always traversable (static, no raise/lower state).
  private centerBridgeMeshes: THREE.Mesh[] = [];
  private bridgeBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  // Memoized "can a ground unit stand here" per grid cell. Cleared whenever a
  // bridge's raised/lowered state changes (which is the only thing that alters the
  // answer for a fixed cell). Keeps per-tick terrain queries off the raycaster.
  private groundTraversableCache = new Map<number, boolean>();
  // Memoized deckAt per grid cell. Constant for the session — the deck primitive
  // doesn't move (raise/lower frames swap visibility, but the raycaster ignores
  // visibility, so the geometric answer is stable). The per-tick deck-elevation
  // lookup (applyDeckElevation in state.ts) is the hot path that necessitates this
  // cache: without it, every ground unit pays multiple triangle-mesh raycasts per
  // tick, which dominates frame time once bridges are crossed by a crowd.
  private deckAtCache = new Map<number, { onDeck: boolean; side: BridgeSide | null }>();
  // Memoized bridgeAt per grid cell. Stable for the same reason as deckAtCache:
  // every raise/lower frame is a static mesh and the raycaster ignores visibility,
  // so the geometric answer never changes. This is the hot-path equivalent of
  // deckAtCache for callers that need the broader bridge-volume predicate
  // (e.g. the collision pass-through rule in state.ts, which is called once per
  // nearby unit per tick — N units in a bridge crowd would otherwise pay O(N^2)
  // raycasts every frame against the bridge mesh arrays).
  private bridgeAtCache = new Map<number, { onBridge: boolean; side: BridgeSide | null }>();
  // The walkable-deck primitives of each side's lowered frame, identified once
  // at load. The deck is generally a small set of horizontal slabs sharing a top
  // Y — e.g. the right bridge ships as a main span with a multi-unit gap in the
  // middle that two smaller slabs fill. Picking only the single largest mesh
  // leaves the gap unclassified, so A* can't path across the bridge and routes
  // via the center bridge even when it would be the longer crossing. We pick
  // every primitive whose top up-facing surface sits at the dominant deck Y
  // (within tolerance), so the navigator sees a continuous deck.
  //
  // An empty array means no traversable frame could be resolved for that side
  // — in which case the navigator falls back to the broader bridgeAt detection
  // for that side so behavior is preserved.
  private rightDeckMeshes: THREE.Mesh[] = [];
  private leftDeckMeshes: THREE.Mesh[] = [];
  private centerDeckMeshes: THREE.Mesh[] = [];
  // World-space deck top Y per side (max bbox top across the deck primitives
  // chosen for that side). Kept alongside the mesh list so the per-tick
  // elevation lookup is a constant-time read.
  private rightDeckSurfaceY: number | null = null;
  private leftDeckSurfaceY: number | null = null;
  private centerDeckSurfaceY: number | null = null;
  private raycaster: THREE.Raycaster;
  private bridgeState: {
    right: 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';
    left: 'Fully_Up' | 'Almost_Up' | 'Almost_Down' | 'Fully_Down';
  } = {
    right: 'Fully_Down',
    left: 'Fully_Down',
  };

  constructor() {
    this.raycaster = new THREE.Raycaster();
  }

  /**
   * Check if the terrain validator is initialized
   */
  public isInitialized(): boolean {
    return this.battleMapScene !== null;
  }

  /**
   * Initialize the terrain validator with the battle map scene
   */
  public initialize(scene: THREE.Object3D) {
    this.battleMapScene = scene;
    this.findTerrainMeshes();
    console.log('✅ Terrain validator initialized');
  }

  /**
   * Update the bridge state
   */
  public updateBridgeState(state: typeof this.bridgeState) {
    // Only the bridge up/down state changes a cell's ground-traversability, so
    // invalidate the cache solely on an actual change (this runs every frame).
    if (state.right !== this.bridgeState.right || state.left !== this.bridgeState.left) {
      this.groundTraversableCache.clear();
    }
    this.bridgeState = state;
  }

  /**
   * Find all water meshes (by color) and bridge-deck meshes (by name) in a single
   * traversal, and cache their broad-phase bounding boxes.
   */
  private findTerrainMeshes() {
    if (!this.battleMapScene) return;

    this.waterMeshes = [];
    this.rightBridgeMeshes = [];
    this.leftBridgeMeshes = [];
    this.centerBridgeMeshes = [];
    this.groundTraversableCache.clear();
    this.deckAtCache.clear();
    this.bridgeAtCache.clear();

    // Ensure world matrices are current so mesh bounding boxes (size guard below)
    // and the raycasts are computed against final world transforms.
    this.battleMapScene.updateMatrixWorld(true);

    this.battleMapScene.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !child.material) return;

      // Bridge decks are identified by name (covers the whole deck regardless of
      // its several grays), so check that before color.
      const side = this.bridgeSideOf(child);
      if (side) {
        const span = this.maxSpan(child);
        if (span <= MAX_BRIDGE_SPAN) {
          const bucket = side === 'right' ? this.rightBridgeMeshes
            : side === 'left' ? this.leftBridgeMeshes
            : this.centerBridgeMeshes;
          bucket.push(child);
          // Make the deck detectable by the downward raycasts in deckAt/bridgeAt
          // regardless of triangle winding. The Center_Bridge deck (and potentially
          // other frames) is a flat quad whose top face is wound so a FrontSide
          // material culls a top-down ray — the raycaster then misses the deck, the
          // bridge's water cells are never classified as walkable deck, and the
          // landmass it serves (e.g. the center island) becomes an isolated component
          // in the A* grid. Units routed to/from it get no path, beeline into the
          // moat, and freeze at the bank. Forcing DoubleSide here costs nothing
          // visually (the deck underside sits at water level, out of view) and makes
          // every terrain raycast see the deck from above. Done once at load.
          this.forceDoubleSided(child);
        } else {
          console.warn(
            `⚠️ TerrainValidator: ignoring bridge-named "${child.name}" — ` +
            `${span.toFixed(0)}u across, too large to be a deck (likely a mis-named/duplicated object).`
          );
        }
        return; // bridge-named meshes never count as water
      }

      const material = Array.isArray(child.material) ? child.material[0] : child.material;
      if (material instanceof THREE.MeshStandardMaterial ||
          material instanceof THREE.MeshBasicMaterial ||
          material instanceof THREE.MeshPhongMaterial) {
        if (this.colorsMatch(material.color, WATER_COLOR)) {
          this.waterMeshes.push(child);
        }
      }
    });

    console.log(
      `✅ Found ${this.waterMeshes.length} water meshes, ` +
      `${this.rightBridgeMeshes.length + this.leftBridgeMeshes.length + this.centerBridgeMeshes.length} bridge meshes ` +
      `(R:${this.rightBridgeMeshes.length} L:${this.leftBridgeMeshes.length} C:${this.centerBridgeMeshes.length})`
    );
    this.waterBounds = this.computeBounds(this.waterMeshes);
    this.bridgeBounds = this.computeBounds([
      ...this.rightBridgeMeshes, ...this.leftBridgeMeshes, ...this.centerBridgeMeshes,
    ]);
    this.computeDeckSurfaceYs();
  }

  /**
   * Identify the walkable-deck primitive of each bridge frame and record its world
   * top Y, so the movement code can lift a ground unit onto the deck when crossing.
   *
   * Each bridge frame group ships as ~10 primitives (deck slab, arch, rails, supports,
   * pillars). The walkable deck is the primitive whose triangles cover the largest
   * up-facing area — flat horizontal slabs vastly out-area thin curved arches and
   * vertical walls. Picking it this way works regardless of primitive ordering or
   * material naming, which differ across the exported frame meshes.
   *
   * For right/left bridges we use the Fully_Down frame (the only one ground units
   * cross while it's lowered). If a side has no Fully_Down mesh, we fall back to the
   * lowest-Y frame group available, then to the other side's deck Y (the moat is
   * mirrored across the map). Center bridge is static and has only one frame.
   */
  private computeDeckSurfaceYs(): void {
    const right = this.findDeckForSide(this.rightBridgeMeshes);
    const left = this.findDeckForSide(this.leftBridgeMeshes);
    const center = this.findDeckForSide(this.centerBridgeMeshes);
    this.rightDeckMeshes = right?.meshes ?? [];
    this.rightDeckSurfaceY = right?.surfaceY ?? null;
    // The left bridge's Fully_Down frame is missing from the current map export.
    // findDeckForSide falls back to Almost_Down. If that still fails, lean on
    // the right deck's Y for elevation (the moat is mirrored across the map),
    // so a unit crossing whichever stand-in geometry exists still lands at a
    // plausible height rather than at water level.
    this.leftDeckMeshes = left?.meshes ?? [];
    this.leftDeckSurfaceY = left?.surfaceY ?? this.rightDeckSurfaceY;
    this.centerDeckMeshes = center?.meshes ?? [];
    this.centerDeckSurfaceY = center?.surfaceY ?? null;
  }

  // Group meshes by their enclosing frame node ("Right_Bridge_Fully_Down" etc.),
  // pick the frame group at the lowest world Y (the lowered/static state), then
  // pick every primitive whose top up-facing surface sits at the dominant deck Y.
  // A bridge's deck is typically a small set of horizontal slabs sharing a top Y
  // (the right bridge has a main span with a gap in the middle that two smaller
  // slabs fill); picking only the single largest mesh leaves the gap unclassified
  // and breaks pathing through the bridge.
  private findDeckForSide(meshes: THREE.Mesh[]): { meshes: THREE.Mesh[]; surfaceY: number } | null {
    if (meshes.length === 0) return null;

    // Bucket meshes by their frame ancestor (the node whose name contains "Bridge").
    const framesByName = new Map<string, { meshes: THREE.Mesh[]; pivotY: number }>();
    for (const mesh of meshes) {
      const frame = this.findBridgeFrameAncestor(mesh);
      if (!frame) continue;
      const entry = framesByName.get(frame.name) ?? {
        meshes: [],
        pivotY: frame.getWorldPosition(new THREE.Vector3()).y,
      };
      entry.meshes.push(mesh);
      framesByName.set(frame.name, entry);
    }
    if (framesByName.size === 0) return null;

    // Prefer the Fully_Down frame; otherwise take whichever has the lowest pivot
    // (the most-down state available — usually the only one that can be open).
    const frames = [...framesByName.entries()];
    const preferred =
      frames.find(([name]) => /Fully_Down/i.test(name)) ??
      frames.sort((a, b) => a[1].pivotY - b[1].pivotY)[0];
    if (!preferred) return null;

    return this.pickDeckPrimitives(preferred[1].meshes);
  }

  // Closest ancestor (or the object itself) named "*_Bridge_*" — the frame group
  // that the raise/lower visibility toggle is applied to.
  private findBridgeFrameAncestor(object: THREE.Object3D): THREE.Object3D | null {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      if (node.name && BRIDGE_NAME_PATTERN.test(node.name)) return node;
    }
    return null;
  }

  // Y tolerance for considering two primitives part of the same walking surface.
  // Generous enough to include slabs with a small Z slope across them; tight enough
  // that the deck's underside (a few units below the top) is excluded.
  private static readonly DECK_TOP_Y_TOLERANCE = 0.5;

  // Identify the deck within a frame group as the union of primitives whose top
  // up-facing surface sits at the dominant deck Y. The "dominant" Y is the top Y
  // of the primitive contributing the largest up-facing area; other primitives
  // within DECK_TOP_Y_TOLERANCE are part of the same continuous walking surface.
  // Returns the chosen primitives and their combined surface Y (max bbox top).
  private pickDeckPrimitives(meshes: THREE.Mesh[]): { meshes: THREE.Mesh[]; surfaceY: number } | null {
    const upTriangleThreshold = 0.7; // see computeUpFacingTopY
    const candidates: { mesh: THREE.Mesh; upArea: number; topY: number }[] = [];
    for (const mesh of meshes) {
      const { upArea, topY } = this.computeUpFacingTopY(mesh, upTriangleThreshold);
      if (upArea <= 0) continue;
      candidates.push({ mesh, upArea, topY });
    }
    if (candidates.length === 0) return null;

    // Dominant deck Y is the topY of the candidate with the largest up-facing area.
    candidates.sort((a, b) => b.upArea - a.upArea);
    const dominantY = candidates[0].topY;

    // Include every candidate within tolerance of that Y. surfaceY is the max top
    // (so a slightly higher gap-filler still elevates units fully onto it).
    const kept: THREE.Mesh[] = [];
    let surfaceY = -Infinity;
    for (const candidate of candidates) {
      if (Math.abs(candidate.topY - dominantY) > TerrainValidator.DECK_TOP_Y_TOLERANCE) continue;
      kept.push(candidate.mesh);
      if (candidate.topY > surfaceY) surfaceY = candidate.topY;
    }
    if (kept.length === 0) return null;
    return { meshes: kept, surfaceY };
  }

  // Compute the total up-facing area of `mesh` (triangles with world-space normal
  // pointing mostly up, gated by `upDotThreshold`) and the world Y of those
  // triangles' highest vertex — i.e. the top of the up-facing surface. Used by
  // pickDeckPrimitives to identify which primitives sit at the same deck height.
  // One-time cost at load; bridges are ~10 primitives per frame, a few thousand
  // triangles total, well under a millisecond.
  private computeUpFacingTopY(mesh: THREE.Mesh, upDotThreshold: number): { upArea: number; topY: number } {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const positionAttribute = geometry.getAttribute('position');
    if (!positionAttribute) return { upArea: 0, topY: -Infinity };
    const indexAttribute = geometry.index;
    const triangleCount = indexAttribute ? indexAttribute.count / 3 : positionAttribute.count / 3;

    const matrix = mesh.matrixWorld;
    const vertexA = new THREE.Vector3();
    const vertexB = new THREE.Vector3();
    const vertexC = new THREE.Vector3();
    const edgeAB = new THREE.Vector3();
    const edgeAC = new THREE.Vector3();
    const normal = new THREE.Vector3();

    let upArea = 0;
    let topY = -Infinity;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      const indexA = indexAttribute ? indexAttribute.getX(triangle * 3) : triangle * 3;
      const indexB = indexAttribute ? indexAttribute.getX(triangle * 3 + 1) : triangle * 3 + 1;
      const indexC = indexAttribute ? indexAttribute.getX(triangle * 3 + 2) : triangle * 3 + 2;
      vertexA.fromBufferAttribute(positionAttribute, indexA).applyMatrix4(matrix);
      vertexB.fromBufferAttribute(positionAttribute, indexB).applyMatrix4(matrix);
      vertexC.fromBufferAttribute(positionAttribute, indexC).applyMatrix4(matrix);
      edgeAB.subVectors(vertexB, vertexA);
      edgeAC.subVectors(vertexC, vertexA);
      normal.crossVectors(edgeAB, edgeAC);
      const normalLength = normal.length();
      if (normalLength === 0) continue;
      if (normal.y / normalLength <= upDotThreshold) continue;
      upArea += normalLength * 0.5;
      const triTopY = Math.max(vertexA.y, vertexB.y, vertexC.y);
      if (triTopY > topY) topY = triTopY;
    }
    return { upArea, topY };
  }

  /**
   * Which bridge a mesh belongs to, by walking its ancestor names, or null if the
   * mesh is not part of a bridge. Deck meshes sit under "Right_Bridge_<frame>" /
   * "Left_Bridge_<frame>" / "Center_Bridge_<frame>" nodes.
   */
  private bridgeSideOf(object: THREE.Object3D): BridgeSide | null {
    let isBridge = false;
    let side: BridgeSide | null = null;
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      const name = node.name;
      if (!name) continue;
      if (BRIDGE_NAME_PATTERN.test(name)) isBridge = true;
      if (RIGHT_NAME_PATTERN.test(name)) side = 'right';
      else if (LEFT_NAME_PATTERN.test(name)) side = 'left';
      else if (CENTER_NAME_PATTERN.test(name)) side = 'center';
    }
    return isBridge ? side : null;
  }

  /**
   * Force a mesh's material(s) to render/raycast as double-sided. Terrain raycasts
   * (deckAt, bridgeAt) cast straight down and rely on hitting the deck's top face;
   * a deck quad wound so its front face points away from the ray would be culled by
   * the default FrontSide material, hiding the deck from detection. Idempotent.
   */
  private forceDoubleSided(mesh: THREE.Mesh): void {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material) material.side = THREE.DoubleSide;
    }
  }

  /**
   * Largest world-space dimension (x, y, or z) of an object's bounding box. Used to
   * reject map-sized geometry that is named like a bridge but clearly isn't a deck.
   */
  private maxSpan(object: THREE.Object3D): number {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return 0;
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z);
  }

  /**
   * Combined xz bounding box of a set of meshes (plus a margin), or null if empty.
   * Used as a cheap broad-phase so positions clearly away from a feature can be
   * ruled out without a raycast.
   */
  private computeBounds(meshes: THREE.Mesh[]): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    if (meshes.length === 0) return null;

    const combined = new THREE.Box3();
    for (const mesh of meshes) {
      combined.expandByObject(mesh);
    }
    if (combined.isEmpty()) return null;

    const margin = 5; // world units of slack around the footprint
    return {
      minX: combined.min.x - margin,
      maxX: combined.max.x + margin,
      minZ: combined.min.z - margin,
      maxZ: combined.max.z + margin,
    };
  }

  /**
   * Check if two colors match within tolerance
   */
  private colorsMatch(color1: THREE.Color, color2: THREE.Color): boolean {
    return (
      Math.abs(color1.r - color2.r) < COLOR_TOLERANCE &&
      Math.abs(color1.g - color2.g) < COLOR_TOLERANCE &&
      Math.abs(color1.b - color2.b) < COLOR_TOLERANCE
    );
  }

  /**
   * Check if a position is over water using raycasting
   */
  public isPositionOverWater(position: Position3D): boolean {
    if (this.waterMeshes.length === 0) return false;

    // Cheap broad-phase: positions outside the water bounding box are inland and
    // need no raycast.
    if (this.waterBounds &&
        (position.x < this.waterBounds.minX || position.x > this.waterBounds.maxX ||
         position.z < this.waterBounds.minZ || position.z > this.waterBounds.maxZ)) {
      return false;
    }

    // Cast ray downward from position
    const origin = new THREE.Vector3(position.x, position.y + 100, position.z);
    this.raycaster.set(origin, DOWN);
    const intersects = this.raycaster.intersectObjects(this.waterMeshes, true);

    return intersects.length > 0;
  }

  /**
   * Check whether a position sits over a bridge deck, by raycasting straight down
   * against the deck meshes (which side is hit determines bridgeSide). All raise/
   * lower frames are static meshes (only their visibility is toggled), so the lowered
   * deck's footprint is always present for the raycast; whether it is actually
   * crossable is gated separately by the bridge's raised/lowered state
   * (isBridgeTraversable).
   */
  private isPositionOnBridge(position: Position3D): { onBridge: boolean; bridgeSide: BridgeSide | null } {
    if (this.rightBridgeMeshes.length === 0 &&
        this.leftBridgeMeshes.length === 0 &&
        this.centerBridgeMeshes.length === 0) {
      return { onBridge: false, bridgeSide: null };
    }

    // Cheap broad-phase: positions outside the bridge bounding box need no raycast.
    if (this.bridgeBounds &&
        (position.x < this.bridgeBounds.minX || position.x > this.bridgeBounds.maxX ||
         position.z < this.bridgeBounds.minZ || position.z > this.bridgeBounds.maxZ)) {
      return { onBridge: false, bridgeSide: null };
    }

    const origin = new THREE.Vector3(position.x, position.y + 100, position.z);
    this.raycaster.set(origin, DOWN);

    if (this.rightBridgeMeshes.length > 0 &&
        this.raycaster.intersectObjects(this.rightBridgeMeshes, true).length > 0) {
      return { onBridge: true, bridgeSide: 'right' };
    }
    if (this.leftBridgeMeshes.length > 0 &&
        this.raycaster.intersectObjects(this.leftBridgeMeshes, true).length > 0) {
      return { onBridge: true, bridgeSide: 'left' };
    }
    if (this.centerBridgeMeshes.length > 0 &&
        this.raycaster.intersectObjects(this.centerBridgeMeshes, true).length > 0) {
      return { onBridge: true, bridgeSide: 'center' };
    }
    return { onBridge: false, bridgeSide: null };
  }

  /**
   * Check if a bridge is traversable for ground animals. The center bridge is static
   * and always crossable; the right/left bridges must be fully lowered.
   */
  private isBridgeTraversable(bridgeSide: BridgeSide): boolean {
    if (bridgeSide === 'center') return true;
    return this.bridgeState[bridgeSide] === 'Fully_Down';
  }

  /**
   * Whether a position sits over a bridge deck, and which side, irrespective of
   * whether that bridge is currently raised or lowered. Public so the bridge
   * navigator can map out crossing geometry once at load (a deck's footprint is
   * static; only its raised/lowered crossability changes — see isSideOpen).
   *
   * Detects any bridge geometry, including walls/rails/posts — used by callers
   * that care about "is the unit anywhere inside the bridge volume" (e.g., the
   * collision pass-through rule for ground units mid-crossing). Navigators that
   * need to know "is this position on the walkable deck specifically" should use
   * deckAt(), which restricts to the deck primitive's XZ footprint.
   */
  public bridgeAt(position: Position3D): { onBridge: boolean; side: BridgeSide | null } {
    // Broad-phase: outside any bridge's bounding box, no need to raycast or cache.
    if (this.bridgeBounds &&
        (position.x < this.bridgeBounds.minX || position.x > this.bridgeBounds.maxX ||
         position.z < this.bridgeBounds.minZ || position.z > this.bridgeBounds.maxZ)) {
      return BRIDGE_AT_MISS;
    }

    // Memoize per grid cell — bridge frame meshes are static (only visibility
    // toggles, which the raycaster ignores) so the geometric answer is stable.
    // Without this cache, checkCollision in state.ts re-raycasts the bridge mesh
    // arrays once per nearby unit, causing the cliff users see when a crowd
    // crosses the bridge.
    const cellX = Math.floor(position.x / TERRAIN_CELL_SIZE) + 32768;
    const cellZ = Math.floor(position.z / TERRAIN_CELL_SIZE) + 32768;
    const key = cellX * 65536 + cellZ;
    const cached = this.bridgeAtCache.get(key);
    if (cached !== undefined) return cached;

    const { onBridge, bridgeSide } = this.isPositionOnBridge(position);
    const result = onBridge ? { onBridge, side: bridgeSide } : BRIDGE_AT_MISS;

    if (this.bridgeAtCache.size > 200_000) this.bridgeAtCache.clear();
    this.bridgeAtCache.set(key, result);
    return result;
  }

  /**
   * Whether a position sits over a walkable bridge deck (not a rail/wall/post/arch),
   * and which side. Used by the pathfinding and region/portal navigators to mark
   * deck cells in their grids — by restricting classification to the deck primitive's
   * XZ footprint, units route only over the actual walking surface rather than over
   * any cell the bridge mesh covers (which previously let A* corner-cut a path
   * through the railing into the deck).
   *
   * For a side whose deck primitive couldn't be identified at load (e.g. the left
   * bridge in the current map export is missing its Fully_Down frame entirely),
   * the broader bridgeAt detection for that side is used as a fallback so units
   * can still cross. Raycasts honor invisible meshes (three.js skips the visible
   * check), so this returns the same answer regardless of which raise/lower frame
   * is currently shown — the cell classifier callers can run at load time.
   */
  public deckAt(position: Position3D): { onDeck: boolean; side: BridgeSide | null } {
    // Broad-phase: outside any bridge's bounding box, no need to raycast or cache.
    if (this.bridgeBounds &&
        (position.x < this.bridgeBounds.minX || position.x > this.bridgeBounds.maxX ||
         position.z < this.bridgeBounds.minZ || position.z > this.bridgeBounds.maxZ)) {
      return DECK_AT_MISS;
    }

    // Memoize per grid cell — see deckAtCache.
    const cellX = Math.floor(position.x / TERRAIN_CELL_SIZE) + 32768;
    const cellZ = Math.floor(position.z / TERRAIN_CELL_SIZE) + 32768;
    const key = cellX * 65536 + cellZ;
    const cached = this.deckAtCache.get(key);
    if (cached !== undefined) return cached;

    const origin = new THREE.Vector3(position.x, position.y + 100, position.z);
    this.raycaster.set(origin, DOWN);

    let result: { onDeck: boolean; side: BridgeSide | null };
    if (this.isOverDeckForSide(this.rightDeckMeshes, this.rightBridgeMeshes)) {
      result = { onDeck: true, side: 'right' };
    } else if (this.isOverDeckForSide(this.leftDeckMeshes, this.leftBridgeMeshes)) {
      result = { onDeck: true, side: 'left' };
    } else if (this.isOverDeckForSide(this.centerDeckMeshes, this.centerBridgeMeshes)) {
      result = { onDeck: true, side: 'center' };
    } else {
      result = DECK_AT_MISS;
    }

    if (this.deckAtCache.size > 200_000) this.deckAtCache.clear();
    this.deckAtCache.set(key, result);
    return result;
  }

  // Strict deck test for one side: raycast against the identified deck primitives,
  // or — if that side has no deck primitives (broken model export) — fall back to
  // any bridge mesh on that side so the navigator still classifies a crossing.
  // Uses the raycaster already configured by the caller, so it must be set up
  // first (see deckAt).
  private isOverDeckForSide(deck: THREE.Mesh[], fallback: THREE.Mesh[]): boolean {
    if (deck.length > 0) {
      return this.raycaster.intersectObjects(deck, true).length > 0;
    }
    return fallback.length > 0 && this.raycaster.intersectObjects(fallback, true).length > 0;
  }

  /**
   * Whether a given bridge is currently crossable by ground units. Public wrapper
   * over the raised/lowered rule so the navigator can open/close portals when the
   * bridge state changes.
   */
  public isSideOpen(side: BridgeSide): boolean {
    return this.isBridgeTraversable(side);
  }

  /**
   * The xz footprint of all bridge decks (with margin), or null before init. Used
   * by the navigator to bound the area it rasterizes into a navigation grid.
   */
  public getBridgeBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    return this.bridgeBounds;
  }

  /**
   * World Y of the walkable deck a ground unit should stand on at this XZ — the
   * top of the bridge mesh that's currently traversable. Returns null when the
   * position is not over a deck a ground unit may cross. Used by the movement
   * code to lift a unit onto an arched bridge so it appears on top of the deck
   * rather than clipping through the bridge's walls/posts at water level.
   *
   * Resolves the side via deckAt (deck-primitive-restricted) and returns the
   * precomputed deck top for that side, so a unit standing just outside the deck
   * (e.g. clipped to a rail-cell during a knockback) isn't lifted onto the deck,
   * and we never read the arch above the deck as the surface.
   */
  public getBridgeSurfaceY(position: Position3D): number | null {
    const { onDeck, side } = this.deckAt(position);
    if (!onDeck || !side) return null;
    if (!this.isBridgeTraversable(side)) return null; // raised — no walking surface

    if (side === 'right') return this.rightDeckSurfaceY;
    if (side === 'left') return this.leftDeckSurfaceY;
    // Add a small headroom on the center bridge so the unit clears the deck
    // trim sitting just above the picked deck primitive's top surface.
    return this.centerDeckSurfaceY === null ? null : this.centerDeckSurfaceY + CENTER_DECK_HEADROOM;
  }

  /**
   * The lowered walking height of each side's deck, as getBridgeSurfaceY would return it
   * when that side is down (center includes its headroom). Static once meshes are found, so
   * it is captured regardless of the bridges' current raised/lowered frames — used by the
   * worker-offload terrain serializer to bake deck heights into the portable snapshot
   * without depending on the bridges happening to be lowered at capture time.
   */
  public getDeckSurfaceYs(): { right: number | null; left: number | null; center: number | null } {
    return {
      right: this.rightDeckSurfaceY,
      left: this.leftDeckSurfaceY,
      center: this.centerDeckSurfaceY === null ? null : this.centerDeckSurfaceY + CENTER_DECK_HEADROOM,
    };
  }

  /**
   * Check if an animal can move to a specific position
   */
  public canAnimalMoveTo(animal: AnimalId, position: Position3D): boolean {
    // If not initialized, allow all movement (graceful degradation)
    if (!this.isInitialized()) {
      return true;
    }

    const movementType = ANIMAL_MOVEMENT_TYPES[animal];

    // Air and water animals are never blocked (air flies over anything; water
    // animals cross water and walk on land), so they skip the raycast entirely.
    if (movementType === 'air' || movementType === 'water') {
      return true;
    }

    // Ground animals: blocked by water unless standing on a lowered bridge deck.
    // Cached per cell so the raycasts run at most once per cell between bridge
    // state changes.
    return this.isGroundTraversable(position);
  }

  /**
   * Whether a ground unit can stand at this position, memoized per grid cell.
   * Only ground animals can be blocked, so this is the sole raycast path on the
   * per-tick movement hot loop.
   */
  private isGroundTraversable(position: Position3D): boolean {
    const cellX = Math.floor(position.x / TERRAIN_CELL_SIZE) + 32768;
    const cellZ = Math.floor(position.z / TERRAIN_CELL_SIZE) + 32768;
    const key = cellX * 65536 + cellZ;

    const cached = this.groundTraversableCache.get(key);
    if (cached !== undefined) return cached;

    let traversable: boolean;
    if (!this.isPositionOverWater(position)) {
      traversable = true; // on land
    } else {
      const { onBridge, bridgeSide } = this.isPositionOnBridge(position);
      traversable = onBridge && bridgeSide ? this.isBridgeTraversable(bridgeSide) : false;
    }

    // Guard against unbounded growth if units roam the whole map.
    if (this.groundTraversableCache.size > 200_000) this.groundTraversableCache.clear();
    this.groundTraversableCache.set(key, traversable);
    return traversable;
  }

  /**
   * Check if movement path from start to end crosses invalid terrain
   * Returns true if movement is valid
   */
  public isPathValid(animal: AnimalId, start: Position3D, end: Position3D, checkPoints: number = 5): boolean {
    // If not initialized, allow all movement (graceful degradation)
    if (!this.isInitialized()) {
      return true;
    }

    // Air animals can always move
    if (ANIMAL_MOVEMENT_TYPES[animal] === 'air') {
      return true;
    }

    // Check multiple points along the path
    for (let i = 0; i <= checkPoints; i++) {
      const t = i / checkPoints;
      const checkPos: Position3D = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
      };

      if (!this.canAnimalMoveTo(animal, checkPos)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Find the walkable cell center nearest `position` for a ground animal, used to rescue
   * a unit that has been shoved off the traversable map onto forbidden water. Searches the
   * grid in expanding square rings (Chebyshev radius) and, in the first ring that contains
   * any walkable cell, returns the candidate with the smallest true (Euclidean) distance —
   * so the unit is pulled toward the closest shore rather than a corner of the ring.
   *
   * Deterministic by construction (fixed ring/scan order, no RNG, no wall-clock; the
   * underlying terrain query is memoized per cell), so it is safe on the multiplayer
   * lockstep tick path. Returns null when no walkable cell lies within `maxRingRadius`
   * cells — the caller then leaves the unit where it is rather than guessing.
   *
   * @param animal        The stranded unit's animal (only ground animals can be blocked).
   * @param position      The unit's current (forbidden) position.
   * @param maxRingRadius How many cells outward to search before giving up.
   */
  public nearestTraversable(animal: AnimalId, position: Position3D, maxRingRadius: number): Position3D | null {
    // Air/water animals are never blocked, so they are never stranded — nothing to rescue.
    if (ANIMAL_MOVEMENT_TYPES[animal] !== 'ground') {
      return { x: position.x, y: position.y, z: position.z };
    }
    // Delegate the grid search to the pure helper, supplying this validator's per-cell
    // (raycast-backed, memoized) ground-traversability query as the walkability predicate.
    return nearestWalkableCell(
      position,
      (candidate) => this.isGroundTraversable(candidate),
      maxRingRadius,
      TERRAIN_CELL_SIZE,
    );
  }
}

// Singleton instance
export const terrainValidator = new TerrainValidator();
