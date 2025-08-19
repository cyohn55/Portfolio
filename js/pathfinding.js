/**
 * Pathfinding System - A* Algorithm
 * Optimized for hex grid navigation with performance enhancements
 */

class AStarNode {
    constructor(x, y, gCost = 0, hCost = 0, parent = null) {
        this.x = x;
        this.y = y;
        this.gCost = gCost; // Distance from start
        this.hCost = hCost; // Heuristic distance to goal
        this.fCost = gCost + hCost; // Total cost
        this.parent = parent;
    }
    
    equals(other) {
        return this.x === other.x && this.y === other.y;
    }
}

class PathfindingSystem {
    constructor() {
        // Performance optimization: Pre-allocate node pool
        this.nodePool = [];
        this.poolIndex = 0;
        this.maxPoolSize = 1000;
        
        // Initialize node pool
        for (let i = 0; i < this.maxPoolSize; i++) {
            this.nodePool.push(new AStarNode(0, 0));
        }
    }

    // Get a node from the pool to avoid garbage collection
    getPooledNode(x, y, gCost = 0, hCost = 0, parent = null) {
        if (this.poolIndex >= this.maxPoolSize) {
            this.poolIndex = 0; // Reset pool if exhausted
        }
        
        const node = this.nodePool[this.poolIndex++];
        node.x = x;
        node.y = y;
        node.gCost = gCost;
        node.hCost = hCost;
        node.fCost = gCost + hCost;
        node.parent = parent;
        
        return node;
    }

    // Convert screen coordinates to hex grid coordinates
    screenToHex(x, y) {
        const settings = window.GAME_SETTINGS?.grid || { tileWidth: 90, tileHeight: 120, hexOffset: 60, columnGap: 0, rowGap: 0 };
        const hexWidth = settings.tileWidth + settings.columnGap;
        const hexHeight = settings.tileHeight + settings.rowGap;
        
        const hexX = Math.floor(x / hexWidth);
        let hexY = Math.floor(y / hexHeight);
        
        // Adjust for hex offset on odd columns
        if (hexX % 2 === 1) {
            hexY = Math.floor((y - settings.hexOffset) / hexHeight);
        }
        
        return { x: hexX, y: hexY };
    }

    // Convert hex coordinates to screen coordinates
    hexToScreen(hexX, hexY) {
        const settings = window.GAME_SETTINGS?.grid || { tileWidth: 90, tileHeight: 120, hexOffset: 60, columnGap: 0, rowGap: 0 };
        const hexWidth = settings.tileWidth + settings.columnGap;
        const hexHeight = settings.tileHeight + settings.rowGap;
        
        let screenX = hexX * hexWidth + settings.tileWidth / 2;
        let screenY = hexY * hexHeight + settings.tileHeight / 2;
        
        // Adjust for hex offset on odd columns
        if (hexX % 2 === 1) {
            screenY += settings.hexOffset;
        }
        
        return { x: screenX, y: screenY };
    }

    // Check if a tile is traversable by a specific animal type
    isTileTraversable(x, y, animalType = null) {
        const gameMap = window.gameState?.map?.layout;
        if (!gameMap || x < 0 || y < 0 || x >= gameMap.length || y >= gameMap[0].length) {
            return false;
        }
        
        const tile = gameMap[x][y];
        
        // Flying animals can traverse all terrain
        if (window.FLYING_ANIMALS?.includes(animalType)) {
            return true;
        }
        
        // Ground animals cannot traverse mountains or hills
        if (tile.type === 'mountain' || tile.type === 'hill') {
            return false;
        }
        
        return true;
    }

    // A* pathfinding implementation with performance optimizations
    findPath(startX, startY, goalX, goalY, animalType) {
        // Reset pool index for this search
        this.poolIndex = 0;
        
        const openSet = [];
        const closedSet = new Set(); // Use Set for O(1) lookup
        const startNode = this.getPooledNode(startX, startY, 0, this.heuristic(startX, startY, goalX, goalY));
        
        openSet.push(startNode);
        
        // Performance limit: max iterations to prevent infinite loops
        let iterations = 0;
        const maxIterations = 500;
        
        while (openSet.length > 0 && iterations < maxIterations) {
            iterations++;
            
            // Find node with lowest fCost (optimized binary heap would be better for large sets)
            let currentNode = openSet[0];
            let currentIndex = 0;
            
            for (let i = 1; i < openSet.length; i++) {
                if (openSet[i].fCost < currentNode.fCost || 
                    (openSet[i].fCost === currentNode.fCost && openSet[i].hCost < currentNode.hCost)) {
                    currentNode = openSet[i];
                    currentIndex = i;
                }
            }
            
            // Move current from open to closed
            openSet.splice(currentIndex, 1);
            closedSet.add(`${currentNode.x},${currentNode.y}`);
            
            // Check if we reached the goal
            if (currentNode.x === goalX && currentNode.y === goalY) {
                return this.reconstructPath(currentNode);
            }
            
            // Check all neighbors
            const neighbors = this.getNeighbors(currentNode.x, currentNode.y);
            for (const [nx, ny] of neighbors) {
                const neighborKey = `${nx},${ny}`;
                
                // Skip if not traversable or already in closed set
                if (!this.isTileTraversable(nx, ny, animalType) || closedSet.has(neighborKey)) {
                    continue;
                }
                
                const gCost = currentNode.gCost + this.getMovementCost(currentNode.x, currentNode.y, nx, ny, animalType);
                const hCost = this.heuristic(nx, ny, goalX, goalY);
                
                // Check if this path to neighbor is better
                const existingIndex = openSet.findIndex(node => node.x === nx && node.y === ny);
                
                if (existingIndex === -1) {
                    const neighborNode = this.getPooledNode(nx, ny, gCost, hCost, currentNode);
                    openSet.push(neighborNode);
                } else if (gCost < openSet[existingIndex].gCost) {
                    const neighborNode = this.getPooledNode(nx, ny, gCost, hCost, currentNode);
                    openSet[existingIndex] = neighborNode;
                }
            }
        }
        
        return null; // No path found
    }

    // Optimized heuristic for hex grids
    heuristic(x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        
        // Hex grid distance calculation
        if (Math.sign(dx) === Math.sign(dy)) {
            return Math.abs(dx + dy);
        } else {
            return Math.max(Math.abs(dx), Math.abs(dy));
        }
    }

    // Calculate movement cost with terrain preferences
    getMovementCost(x1, y1, x2, y2, animalType) {
        let cost = 1;
        
        // Diagonal movement penalty (minimal for hex grids)
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        if (dx > 0 && dy > 0) {
            cost *= 1.1;
        }
        
        // Terrain-specific costs
        const gameMap = window.gameState?.map?.layout;
        if (gameMap && x2 >= 0 && y2 >= 0 && x2 < gameMap.length && y2 < gameMap[0].length) {
            const tile = gameMap[x2][y2];
            switch (tile.terrainType) {
                case 'forest':
                    cost *= 1.2; // Slightly harder to traverse
                    break;
                case 'farmland':
                    cost *= 0.9; // Easier to traverse
                    break;
            }
        }
        
        return cost;
    }

    // Get hex grid neighbors (6 directions)
    getNeighbors(x, y) {
        if (x % 2 === 0) { // Even column
            return [
                [x, y - 1],     // North
                [x + 1, y - 1], // Northeast
                [x + 1, y],     // Southeast
                [x, y + 1],     // South
                [x - 1, y],     // Southwest
                [x - 1, y - 1]  // Northwest
            ];
        } else { // Odd column
            return [
                [x, y - 1],     // North
                [x + 1, y],     // Northeast
                [x + 1, y + 1], // Southeast
                [x, y + 1],     // South
                [x - 1, y + 1], // Southwest
                [x - 1, y]      // Northwest
            ];
        }
    }

    // Reconstruct path from goal to start
    reconstructPath(goalNode) {
        const path = [];
        let current = goalNode;
        
        while (current) {
            path.unshift({ x: current.x, y: current.y });
            current = current.parent;
        }
        
        return path;
    }

    // High-level pathfinding interface
    findUnitPath(unit, targetX, targetY) {
        const startHex = this.screenToHex(unit.x, unit.y);
        const goalHex = this.screenToHex(targetX, targetY);
        
        console.log(`🗺️ Finding path for ${unit.animal} from (${startHex.x}, ${startHex.y}) to (${goalHex.x}, ${goalHex.y})`);
        
        const path = this.findPath(startHex.x, startHex.y, goalHex.x, goalHex.y, unit.animal);
        
        if (path && path.length > 1) {
            // Convert path back to screen coordinates and assign to unit
            unit.path = path.slice(1); // Remove starting position
            unit.pathIndex = 0;
            unit.isMoving = true;
            unit.targetX = null;
            unit.targetY = null;
            console.log(`✅ ${unit.animal} found A* path with ${path.length} steps`);
            return true;
        } else {
            // Fallback to direct movement
            unit.targetX = targetX;
            unit.targetY = targetY;
            unit.isMoving = true;
            unit.path = null;
            unit.pathIndex = 0;
            console.log(`⚠️ ${unit.animal} using direct movement (no A* path found)`);
            return false;
        }
    }
}

// Create global pathfinding instance
window.pathfinding = new PathfindingSystem();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PathfindingSystem };
} 