// Goldberg polyhedron world geometry for the Conquest game mode.
//
// Single responsibility: turn a subdivision level into the tile graph of a
// Goldberg polyhedron — a sphere tiled by exactly 12 pentagons and a field of
// hexagons. Conquest is played on this graph: every tile is a territory a player
// can claim, the 12 pentagons are the fixed spawn nodes (up to 12 players), and
// the neighbor adjacency drives movement and border combat.
//
// The construction is the classic three-step pipeline:
//   1. Seed an icosahedron (12 vertices, 20 triangular faces).
//   2. Geodesic-subdivide each triangle `subdivisions` times and re-project the
//      new vertices onto the unit sphere.
//   3. Take the dual: every geodesic vertex becomes a tile whose corners are the
//      centroids of the triangles meeting at that vertex. Degree-5 vertices (the
//      12 icosahedron corners) become pentagons; every other vertex becomes a
//      hexagon.
//
// This module is intentionally pure and free of React/R3F so it can be unit
// tested in Node and reused by both the renderer and the simulation. The only
// dependency is three.js for its Vector3 math.

import * as THREE from 'three';

/**
 * A single playable territory on the globe. Positions are on the unit sphere
 * (radius 1); the renderer scales/extrudes them, the simulation only cares about
 * `center` direction and `neighbors`.
 */
export interface GoldbergTile {
  /** Stable index into GoldbergWorld.tiles. */
  id: number;
  /** 5 for the twelve pentagon spawn nodes, 6 for every hexagon. */
  sides: number;
  /** Tile center on the unit sphere (also the outward surface normal). */
  center: THREE.Vector3;
  /** Polygon corner positions on the unit sphere, wound consistently. */
  corners: THREE.Vector3[];
  /** Ids of edge-adjacent tiles (shared edge = two shared corners). */
  neighbors: number[];
  /** Solid-angle area on the unit sphere; pentagons are slightly smaller. */
  area: number;
}

export interface GoldbergWorld {
  tiles: GoldbergTile[];
  /** The twelve pentagon tile ids — the only valid spawn nodes. */
  pentagonIds: number[];
  /** Subdivision level the world was built at. */
  subdivisions: number;
}

/** Canonical icosahedron, normalized to the unit sphere. */
function createIcosahedron(): { vertices: THREE.Vector3[]; faces: number[][] } {
  const goldenRatio = (1 + Math.sqrt(5)) / 2;

  const vertices = [
    [-1, goldenRatio, 0], [1, goldenRatio, 0], [-1, -goldenRatio, 0], [1, -goldenRatio, 0],
    [0, -1, goldenRatio], [0, 1, goldenRatio], [0, -1, -goldenRatio], [0, 1, -goldenRatio],
    [goldenRatio, 0, -1], [goldenRatio, 0, 1], [-goldenRatio, 0, -1], [-goldenRatio, 0, 1],
  ].map((coordinates) => new THREE.Vector3(coordinates[0], coordinates[1], coordinates[2]).normalize());

  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  // Enforce consistent outward (counter-clockwise) winding so every triangle
  // centroid and downstream normal points away from the sphere center.
  faces.forEach((face) => {
    const a = vertices[face[0]];
    const b = vertices[face[1]];
    const c = vertices[face[2]];
    const outwardReference = new THREE.Vector3().add(a).add(b).add(c);
    const edgeCB = new THREE.Vector3().subVectors(c, b);
    const edgeAB = new THREE.Vector3().subVectors(a, b);
    const normal = new THREE.Vector3().crossVectors(edgeCB, edgeAB);
    if (normal.dot(outwardReference) < 0) {
      const swap = face[1];
      face[1] = face[2];
      face[2] = swap;
    }
  });

  return { vertices, faces };
}

/** Recursively split each triangle into four, re-projecting midpoints onto the sphere. */
function subdivideGeodesic(
  baseVertices: THREE.Vector3[],
  baseFaces: number[][],
  levels: number,
): { vertices: THREE.Vector3[]; faces: number[][] } {
  const vertices = [...baseVertices];
  let faces = [...baseFaces];

  for (let level = 0; level < levels; level++) {
    const nextFaces: number[][] = [];
    const midpointCache = new Map<string, number>();

    const getMidpoint = (firstIndex: number, secondIndex: number): number => {
      const cacheKey = firstIndex < secondIndex
        ? `${firstIndex}_${secondIndex}`
        : `${secondIndex}_${firstIndex}`;
      const cached = midpointCache.get(cacheKey);
      if (cached !== undefined) return cached;

      const midpoint = new THREE.Vector3()
        .addVectors(vertices[firstIndex], vertices[secondIndex])
        .normalize();
      vertices.push(midpoint);
      const newIndex = vertices.length - 1;
      midpointCache.set(cacheKey, newIndex);
      return newIndex;
    };

    for (const [a, b, c] of faces) {
      const ab = getMidpoint(a, b);
      const bc = getMidpoint(b, c);
      const ca = getMidpoint(c, a);

      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nextFaces;
  }

  return { vertices, faces };
}

/**
 * Build the dual Goldberg polyhedron from a geodesic sphere: one tile per
 * geodesic vertex, cornered by the centroids of its incident triangles, with the
 * corners angularly sorted so the polygon is convex and consistently wound.
 */
function buildDualTiles(
  geodesicVertices: THREE.Vector3[],
  geodesicFaces: number[][],
): GoldbergTile[] {
  // Dual vertices: one per geodesic triangle (its normalized centroid).
  const dualVertices = geodesicFaces.map((face) => {
    const a = geodesicVertices[face[0]];
    const b = geodesicVertices[face[1]];
    const c = geodesicVertices[face[2]];
    return new THREE.Vector3().add(a).add(b).add(c).divideScalar(3).normalize();
  });

  // For each geodesic vertex, gather the triangles touching it — those become
  // the corners of the dual tile centered on that vertex.
  const facesPerVertex: number[][] = Array.from({ length: geodesicVertices.length }, () => []);
  geodesicFaces.forEach((face, faceIndex) => {
    facesPerVertex[face[0]].push(faceIndex);
    facesPerVertex[face[1]].push(faceIndex);
    facesPerVertex[face[2]].push(faceIndex);
  });

  // Track which dual-vertex indices each tile uses, so we can derive adjacency
  // (two tiles sharing two corner indices share an edge).
  const cornerIndicesPerTile: number[][] = [];
  const tiles: GoldbergTile[] = [];

  for (let vertexIndex = 0; vertexIndex < geodesicVertices.length; vertexIndex++) {
    const incidentFaces = facesPerVertex[vertexIndex];
    if (incidentFaces.length === 0) continue;

    const center = geodesicVertices[vertexIndex].clone();
    const normal = center.clone().normalize();

    // Build a tangent basis at the tile center to measure corner angles.
    const tangentU = Math.abs(normal.x) < 0.9
      ? new THREE.Vector3().crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize()
      : new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize();
    const tangentV = new THREE.Vector3().crossVectors(normal, tangentU).normalize();

    const sortedCornerIndices = incidentFaces
      .map((faceIndex) => {
        const offset = new THREE.Vector3().subVectors(dualVertices[faceIndex], center);
        return { faceIndex, angle: Math.atan2(offset.dot(tangentV), offset.dot(tangentU)) };
      })
      .sort((first, second) => first.angle - second.angle)
      .map((entry) => entry.faceIndex);

    const corners = sortedCornerIndices.map((faceIndex) => dualVertices[faceIndex].clone());

    // Spherical-fan area of the polygon (triangulated around the center).
    let area = 0;
    for (let i = 0; i < corners.length; i++) {
      const edgeA = new THREE.Vector3().subVectors(corners[i], center);
      const edgeB = new THREE.Vector3().subVectors(corners[(i + 1) % corners.length], center);
      area += 0.5 * new THREE.Vector3().crossVectors(edgeA, edgeB).length();
    }

    tiles.push({
      id: tiles.length,
      sides: sortedCornerIndices.length,
      center,
      corners,
      neighbors: [],
      area,
    });
    cornerIndicesPerTile.push(sortedCornerIndices);
  }

  linkNeighbors(tiles, cornerIndicesPerTile);
  return tiles;
}

/**
 * Populate each tile's `neighbors` from shared corners. Two Goldberg tiles are
 * edge-adjacent exactly when they share two dual-vertex (corner) indices, so we
 * index tiles by corner and connect any pair that co-occurs on two corners.
 */
function linkNeighbors(tiles: GoldbergTile[], cornerIndicesPerTile: number[][]): void {
  const tilesPerCorner = new Map<number, number[]>();
  cornerIndicesPerTile.forEach((cornerIndices, tileId) => {
    for (const cornerIndex of cornerIndices) {
      const list = tilesPerCorner.get(cornerIndex);
      if (list) list.push(tileId);
      else tilesPerCorner.set(cornerIndex, [tileId]);
    }
  });

  const sharedCornerCount = new Map<string, number>();
  for (const tileList of tilesPerCorner.values()) {
    for (let i = 0; i < tileList.length; i++) {
      for (let j = i + 1; j < tileList.length; j++) {
        const low = Math.min(tileList[i], tileList[j]);
        const high = Math.max(tileList[i], tileList[j]);
        const pairKey = `${low}_${high}`;
        sharedCornerCount.set(pairKey, (sharedCornerCount.get(pairKey) ?? 0) + 1);
      }
    }
  }

  for (const [pairKey, count] of sharedCornerCount) {
    if (count < 2) continue; // share only a corner, not an edge — not neighbors
    const [low, high] = pairKey.split('_').map(Number);
    tiles[low].neighbors.push(high);
    tiles[high].neighbors.push(low);
  }
}

/**
 * Build the full Conquest world graph at the given subdivision level.
 *
 * Tile counts follow GP(2^s, 0): faces F = 10 * 4^s + 2, always with exactly 12
 * pentagons. Level 3 (362 tiles) is a good default — enough territory for 12
 * players without overwhelming the renderer.
 */
export function buildGoldbergWorld(subdivisions: number): GoldbergWorld {
  const clampedSubdivisions = Math.max(1, Math.min(6, Math.floor(subdivisions)));
  const icosahedron = createIcosahedron();
  const geodesic = subdivideGeodesic(icosahedron.vertices, icosahedron.faces, clampedSubdivisions);
  const tiles = buildDualTiles(geodesic.vertices, geodesic.faces);
  const pentagonIds = tiles.filter((tile) => tile.sides === 5).map((tile) => tile.id);

  return { tiles, pentagonIds, subdivisions: clampedSubdivisions };
}
