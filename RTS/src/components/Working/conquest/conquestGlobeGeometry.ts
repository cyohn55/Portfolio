// Builds the renderable globe mesh for Conquest from the world + biome data.
//
// Single responsibility: convert the abstract tile graph into a single
// BufferGeometry (positions, per-vertex colors, normals) plus a triangle→tileId
// lookup so the renderer can hover/select tiles. One merged mesh keeps draw calls
// to a minimum (the project already fights draw-call cliffs elsewhere — see the
// Battle_Map merge work), while vertex colors let every biome and every owner
// tint live in one mesh.

import * as THREE from 'three';
import type { GoldbergWorld } from './goldbergWorld';
import { BIOMES, type TileBiome } from './conquestBiomes';

export interface GlobeGeometry {
  geometry: THREE.BufferGeometry;
  /** triangleTileIds[i] = tile id that owns triangle i (for raycast lookup). */
  triangleTileIds: number[];
}

export interface GlobeBuildOptions {
  /** Fractional gap between adjacent tiles (0 = water-tight). */
  tileGap: number;
  /** Half-thickness of the extruded crust. */
  thickness: number;
  /** tileId → owner color (already resolved). Absent = unowned. */
  ownerColors: Map<number, number>;
  /** How strongly an owned tile is tinted toward its owner color (0..1). */
  ownerTint: number;
  /** In-plane fraction of the flat top face replaced by the chamfered rim. */
  bevel: number;
}

export const DEFAULT_GLOBE_OPTIONS: Omit<GlobeBuildOptions, 'ownerColors'> = {
  // Gaps closed: adjacent tiles meet edge-to-edge, with the bevel reading as the
  // only seam between them.
  tileGap: 0.0,
  thickness: 0.012,
  ownerTint: 0.55,
  // Fraction of the flat top face given over to the chamfered rim (in-plane).
  bevel: 0.12,
};

// Radial drop of the bevel rim below the flat top face, as a fraction of crust
// thickness. Small, so the chamfer is a subtle edge rather than a tall wall.
const BEVEL_DROP_FRACTION = 0.6;

/**
 * Radius of a tile's outer (top) surface — the height a unit standing on the
 * tile rests at. Shared by the mesh builder and the unit renderer so models sit
 * exactly on the crust rather than floating above or sinking into it.
 *
 * For now every tile is the SAME height: a single uniform shell, so the planet
 * reads as a clean tiled sphere with no biome relief. (The `tileBiome` argument
 * is retained for callers and for when per-biome elevation is reintroduced.)
 */
export function tileTopRadius(
  _tileBiome: TileBiome,
  thickness: number = DEFAULT_GLOBE_OPTIONS.thickness,
): number {
  return 1.0 + thickness;
}

/**
 * Resolve a tile's display color: its biome color, blended toward the owning
 * player's color when claimed so territory reads at a glance.
 */
function resolveTileColor(
  tileId: number,
  tileBiome: TileBiome,
  options: GlobeBuildOptions,
): THREE.Color {
  const base = new THREE.Color(BIOMES[tileBiome.biome].color);
  const ownerColor = options.ownerColors.get(tileId);
  if (ownerColor === undefined) return base;
  return base.lerp(new THREE.Color(ownerColor), options.ownerTint);
}

/** Append a triangle's three vertices (position + shared color) to the buffers. */
function pushTriangle(
  positions: number[],
  colors: number[],
  triangleTileIds: number[],
  tileId: number,
  color: THREE.Color,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): void {
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < 3; i++) colors.push(color.r, color.g, color.b);
  triangleTileIds.push(tileId);
}

/**
 * The corner direction (unit vector) for a tile corner, accounting for any
 * inter-tile gap. With gap 0 this is just the corner itself.
 */
function cornerDirection(corner: THREE.Vector3, center: THREE.Vector3, inset: number): THREE.Vector3 {
  if (inset >= 1) return corner.clone().normalize();
  const inward = new THREE.Vector3().subVectors(corner, center).multiplyScalar(inset);
  return center.clone().add(inward).normalize();
}

/**
 * Project a corner direction onto the tangent plane {x·n = radius}. Unlike a
 * radial projection (which curves with the sphere), this lands every corner on
 * one plane, so the resulting polygon top is genuinely flat.
 */
function planeCorner(direction: THREE.Vector3, normal: THREE.Vector3, radius: number): THREE.Vector3 {
  const scale = radius / direction.dot(normal);
  return direction.clone().multiplyScalar(scale);
}

/**
 * Build the full globe geometry. Each tile is an extruded prism with a FLAT top
 * face (its corners lie on one tangent plane), a small chamfered bevel around
 * the top rim, vertical side walls, and a bottom cap. Gaps are closed, so the
 * bevels of neighboring tiles form the only seam between them.
 */
export function buildGlobeGeometry(
  world: GoldbergWorld,
  biomes: TileBiome[],
  options: GlobeBuildOptions,
): GlobeGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const triangleTileIds: number[] = [];
  const inset = 1.0 - options.tileGap;
  const bevelDrop = options.thickness * BEVEL_DROP_FRACTION;

  for (const tile of world.tiles) {
    const tileBiome = biomes[tile.id];
    if (!tileBiome) continue;

    const color = resolveTileColor(tile.id, tileBiome, options);

    // Uniform shell: every tile shares the same top and bottom radius.
    const topRadius = tileTopRadius(tileBiome, options.thickness);
    const bottomRadius = 1.0 - options.thickness;
    const normal = tile.center.clone().normalize();
    const center = tile.center;
    const sides = tile.corners.length;

    const topCenter = center.clone().multiplyScalar(topRadius);
    const bottomCenter = center.clone().multiplyScalar(bottomRadius);

    // Three corner rings per tile:
    //   face — flat top face edge, inset in-plane by the bevel amount,
    //   rim  — outer bevel edge / wall top, full footprint a hair lower,
    //   base — bottom of the wall.
    const faceCorners: THREE.Vector3[] = [];
    const rimCorners: THREE.Vector3[] = [];
    const baseCorners: THREE.Vector3[] = [];

    for (const corner of tile.corners) {
      const direction = cornerDirection(corner, center, inset);
      const topPlaneCorner = planeCorner(direction, normal, topRadius);
      // Flat face corner: pull the planar corner inward toward the face center.
      faceCorners.push(topPlaneCorner.clone().lerp(topCenter, options.bevel));
      // Bevel rim: full footprint, dropped slightly below the top plane.
      rimCorners.push(planeCorner(direction, normal, topRadius - bevelDrop));
      baseCorners.push(planeCorner(direction, normal, bottomRadius));
    }

    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;

      // Flat top face (fan from the face center, outward winding).
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        topCenter, faceCorners[i], faceCorners[next]);
      // Beveled rim: from the inset face edge down-and-out to the wall top.
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        faceCorners[i], rimCorners[i], rimCorners[next]);
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        faceCorners[i], rimCorners[next], faceCorners[next]);
      // Side wall.
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        rimCorners[i], baseCorners[i], baseCorners[next]);
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        rimCorners[i], baseCorners[next], rimCorners[next]);
      // Bottom cap (reverse winding).
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        bottomCenter, baseCorners[next], baseCorners[i]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  return { geometry, triangleTileIds };
}

/**
 * Build a thin highlight outline geometry for a single tile (used for hover /
 * selection rings). Returns just the top-cap fan, lifted slightly above the
 * surface so it renders cleanly on top.
 */
export function buildTileHighlightGeometry(
  world: GoldbergWorld,
  biomes: TileBiome[],
  tileId: number,
  options: GlobeBuildOptions,
): THREE.BufferGeometry | null {
  const tile = world.tiles[tileId];
  const tileBiome = biomes[tileId];
  if (!tile || !tileBiome) return null;

  const inset = 1.0 - options.tileGap;
  // Lift the highlight just above the flat top face so it reads as an overlay.
  const radius = tileTopRadius(tileBiome, options.thickness) + 0.008;
  const normal = tile.center.clone().normalize();

  const center = tile.center;
  const topCenter = center.clone().multiplyScalar(radius);
  const corners = tile.corners.map((corner) => {
    const direction = cornerDirection(corner, center, inset);
    // Match the flat face's inset so the highlight traces the visible top.
    return planeCorner(direction, normal, radius).lerp(topCenter, options.bevel);
  });

  const positions: number[] = [];
  const sides = corners.length;
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    positions.push(
      topCenter.x, topCenter.y, topCenter.z,
      corners[i].x, corners[i].y, corners[i].z,
      corners[next].x, corners[next].y, corners[next].z,
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
