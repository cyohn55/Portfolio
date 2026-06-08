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
}

export const DEFAULT_GLOBE_OPTIONS: Omit<GlobeBuildOptions, 'ownerColors'> = {
  tileGap: 0.06,
  thickness: 0.012,
  ownerTint: 0.55,
};

/**
 * Radius of a tile's outer (top) surface — the height a unit standing on the
 * tile rests at. Shared by the mesh builder and the army renderer so models sit
 * exactly on the crust rather than floating above or sinking into it. Mountains
 * rise further the higher their noise elevation, matching the rendered relief.
 */
export function tileTopRadius(
  tileBiome: TileBiome,
  thickness: number = DEFAULT_GLOBE_OPTIONS.thickness,
): number {
  const elevationOffset = BIOMES[tileBiome.biome].elevationOffset;
  const mountainBoost = tileBiome.biome === 'mountain'
    ? (tileBiome.elevation - 0.5) * 0.18
    : 0;
  return 1.0 + elevationOffset + mountainBoost + thickness;
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
 * Build the full globe geometry. Each tile becomes an inset, extruded polygon:
 * a top cap, a bottom cap, and side walls, so tiles read as distinct raised hex
 * plates with thin trenches between them.
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

  for (const tile of world.tiles) {
    const tileBiome = biomes[tile.id];
    if (!tileBiome) continue;

    const color = resolveTileColor(tile.id, tileBiome, options);
    const elevationOffset = BIOMES[tileBiome.biome].elevationOffset;

    const topRadius = tileTopRadius(tileBiome, options.thickness);
    const bottomRadius = 1.0 + elevationOffset - options.thickness;

    const center = tile.center;
    const topCorners: THREE.Vector3[] = [];
    const bottomCorners: THREE.Vector3[] = [];

    for (const corner of tile.corners) {
      // Contract the corner toward the tile center to open the inter-tile gap,
      // then re-project radially to the top/bottom shells.
      const inwardDirection = new THREE.Vector3().subVectors(corner, center).multiplyScalar(inset);
      const contracted = center.clone().add(inwardDirection).normalize();
      topCorners.push(contracted.clone().multiplyScalar(topRadius));
      bottomCorners.push(contracted.clone().multiplyScalar(bottomRadius));
    }

    const topCenter = center.clone().multiplyScalar(topRadius);
    const bottomCenter = center.clone().multiplyScalar(bottomRadius);
    const sides = tile.corners.length;

    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;

      // Top cap (outward winding).
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        topCenter, topCorners[i], topCorners[next]);
      // Bottom cap (reverse winding).
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        bottomCenter, bottomCorners[next], bottomCorners[i]);
      // Side wall (two triangles).
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        topCorners[i], bottomCorners[i], bottomCorners[next]);
      pushTriangle(positions, colors, triangleTileIds, tile.id, color,
        topCorners[i], bottomCorners[next], topCorners[next]);
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
  const radius = tileTopRadius(tileBiome, options.thickness) + 0.012;

  const center = tile.center;
  const topCenter = center.clone().multiplyScalar(radius);
  const corners = tile.corners.map((corner) => {
    const inwardDirection = new THREE.Vector3().subVectors(corner, center).multiplyScalar(inset);
    return center.clone().add(inwardDirection).normalize().multiplyScalar(radius);
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
