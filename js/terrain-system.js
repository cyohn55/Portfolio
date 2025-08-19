/**
 * Terrain System - Hex Grid & 3D Terrain Management
 * Optimized for performance with progressive loading and caching
 */

class TerrainSystem {
    constructor() {
        this.mapCache = null;
        this.loadedTiles = new Set();
        this.intersectionObserver = null;
        this.tilePool = new Map(); // Reuse tile elements
        
        // Terrain configuration
        this.terrainWeights = {
            mountain: 0.15,  // Reduced for better gameplay
            forest: 0.40,    // Most common
            hill: 0.15,      // Reduced for better gameplay
            farmland: 0.30   // Increased for traversability
        };
        
        this.setupProgressiveLoading();
    }

    // Setup intersection observer for progressive loading
    setupProgressiveLoading() {
        if (!window.PERFORMANCE_CONFIG?.enableProgressiveLoading) return;
        
        this.intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const tile = entry.target;
                    if (tile.hasAttribute('reveal')) {
                        this.loadTile(tile);
                        this.intersectionObserver.unobserve(tile);
                    }
                }
            });
        }, {
            rootMargin: '100px' // Load tiles 100px before they come into view
        });
    }

    // Load a single tile when it becomes visible
    loadTile(tileElement) {
        if (tileElement.dismissPoster) {
            tileElement.dismissPoster();
        }
        
        const tileId = tileElement.dataset.tileId;
        if (tileId) {
            this.loadedTiles.add(tileId);
        }
    }

    // Generate optimized terrain layout
    generateMapLayout(rows = 16, cols = 12, useCache = true) {
        // Return cached map if available and caching enabled
        if (useCache && this.mapCache) {
            console.log('🗺️ Using cached terrain layout');
            return this.mapCache;
        }
        
        console.log(`🏗️ Generating new terrain layout: ${cols}x${rows}`);
        
        const layout = [];
        const terrainModels = window.TERRAIN_CONFIG?.models || [
            { file: 'models/Mountain.glb', alt: 'Mountain Tile', type: 'mountain' },
            { file: 'models/Forest.glb', alt: 'Forest Tile', type: 'forest' },
            { file: 'models/Hill.glb', alt: 'Hill Tile', type: 'hill' },
            { file: 'models/FarmLand.glb', alt: 'Farm Land Tile', type: 'farmland' }
        ];
        
        // Generate terrain with weighted distribution
        for (let x = 0; x < cols; x++) {
            layout[x] = [];
            for (let y = 0; y < rows; y++) {
                const tileData = this.getRandomTerrain(terrainModels);
                layout[x][y] = {
                    ...tileData,
                    x: x,
                    y: y,
                    id: `tile_${x}_${y}`,
                    isLoaded: false
                };
            }
        }
        
        // Cache the generated layout
        this.mapCache = layout;
        
        // Update game state
        if (window.gameState?.map) {
            window.gameState.map.layout = layout;
            window.gameState.map.cols = cols;
            window.gameState.map.rows = rows;
        }
        
        this.logTerrainStats(layout, cols, rows);
        return layout;
    }

    // Get random terrain based on weighted distribution
    getRandomTerrain(terrainModels) {
        const weights = Object.values(this.terrainWeights);
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        let random = Math.random() * totalWeight;
        
        const terrainTypes = Object.keys(this.terrainWeights);
        for (let i = 0; i < terrainTypes.length; i++) {
            const terrainType = terrainTypes[i];
            random -= this.terrainWeights[terrainType];
            
            if (random <= 0) {
                const model = terrainModels.find(m => m.type === terrainType);
                return model || terrainModels[1]; // Fallback to forest
            }
        }
        
        // Fallback to forest
        return terrainModels.find(m => m.type === 'forest') || terrainModels[1];
    }

    // Generate and render hex grid with performance optimizations
    generateHexGrid(rows = 16, cols = 12, forceRegenerate = false) {
        const container = document.getElementById('hex-grid');
        if (!container) {
            console.warn('Hex grid container not found');
            return false;
        }

        // Clear existing tiles if regenerating
        if (forceRegenerate) {
            this.clearGrid(container);
            this.mapCache = null;
        }

        // Generate or use cached map layout
        const mapLayout = this.generateMapLayout(rows, cols, !forceRegenerate);
        
        // Get grid settings
        const settings = window.GAME_SETTINGS?.grid || {
            tileWidth: 90,
            tileHeight: 120,
            hexOffset: 60,
            columnGap: 0,
            rowGap: 0
        };

        // Calculate hex positioning
        const hexWidth = settings.tileWidth + settings.columnGap;
        const hexHeight = settings.tileHeight + settings.rowGap;

        // Performance optimization: Use document fragment for batch DOM insertion
        const fragment = document.createDocumentFragment();
        const tilesToObserve = [];

        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                const tileData = mapLayout[x][y];
                
                // Calculate tile position
                const position = this.calculateTilePosition(x, y, hexWidth, hexHeight, settings.hexOffset);
                
                // Create tile element
                const tileElement = this.createTerrainTile(tileData, position, settings);
                
                if (tileElement) {
                    fragment.appendChild(tileElement);
                    
                    // Add to progressive loading if enabled
                    if (this.intersectionObserver) {
                        tilesToObserve.push(tileElement);
                    }
                }
            }
        }

        // Batch insert all tiles
        container.appendChild(fragment);

        // Setup progressive loading for new tiles
        tilesToObserve.forEach(tile => {
            if (this.intersectionObserver) {
                this.intersectionObserver.observe(tile);
            }
        });

        console.log(`✅ Generated hex grid: ${cols}x${rows} with ${cols * rows} tiles`);
        return true;
    }

    // Calculate tile position with hex offset
    calculateTilePosition(x, y, hexWidth, hexHeight, hexOffset) {
        let xPos, yPos;
        
        if (x % 2 === 0) {
            xPos = x * hexWidth;
            yPos = y * hexHeight;
        } else {
            xPos = x * hexWidth;
            yPos = y * hexHeight + hexOffset;
        }
        
        return { x: xPos, y: yPos };
    }

    // Create optimized terrain tile element
    createTerrainTile(tileData, position, settings) {
        // Try to reuse tile from pool
        let tileContainer = this.tilePool.get(tileData.type);
        if (tileContainer) {
            this.tilePool.delete(tileData.type);
        } else {
            tileContainer = document.createElement('div');
        }
        
        tileContainer.className = `tile-3d-container ${tileData.type}`;
        tileContainer.style.position = 'absolute';
        tileContainer.style.left = position.x + 'px';
        tileContainer.style.top = position.y + 'px';
        tileContainer.style.width = settings.tileWidth + 'px';
        tileContainer.style.height = settings.tileHeight + 'px';
        tileContainer.style.transformStyle = 'preserve-3d';
        
        // Create or reuse model-viewer
        let modelViewer = tileContainer.querySelector('model-viewer');
        if (!modelViewer) {
            modelViewer = document.createElement('model-viewer');
        }
        
        // Setup model-viewer with optimized settings
        this.setupModelViewer(modelViewer, tileData, settings);
        
        // Store tile data
        tileContainer.dataset.tileId = tileData.id;
        tileContainer.dataset.hexX = tileData.x;
        tileContainer.dataset.hexY = tileData.y;
        tileContainer.dataset.terrainType = tileData.type;
        
        if (!tileContainer.contains(modelViewer)) {
            tileContainer.appendChild(modelViewer);
        }
        
        return tileContainer;
    }

    // Setup model-viewer with performance optimizations
    setupModelViewer(modelViewer, tileData, settings) {
        const performanceSettings = window.PERFORMANCE_CONFIG?.modelViewerSettings || {};
        
        modelViewer.className = `hex-tile ${tileData.type}`;
        modelViewer.setAttribute('src', tileData.file);
        modelViewer.setAttribute('alt', tileData.alt);
        modelViewer.setAttribute('interaction-prompt', 'none');
        
        // Performance settings
        modelViewer.setAttribute('loading', 'lazy');
        modelViewer.setAttribute('reveal', 'manual');
        modelViewer.setAttribute('auto-rotate', 'false');
        modelViewer.setAttribute('camera-controls', 'false');
        modelViewer.setAttribute('disable-zoom', '');
        modelViewer.setAttribute('disable-pan', '');
        
        // Camera settings
        const cameraOrbit = performanceSettings.cameraOrbit || '0deg 75deg 100m';
        const fieldOfView = performanceSettings.fieldOfView || '15deg';
        
        modelViewer.setAttribute('camera-orbit', cameraOrbit);
        modelViewer.setAttribute('field-of-view', fieldOfView);
        modelViewer.setAttribute('min-camera-orbit', cameraOrbit);
        modelViewer.setAttribute('max-camera-orbit', cameraOrbit);
        
        // Positioning and styling
        modelViewer.style.position = 'absolute';
        modelViewer.style.width = '100%';
        modelViewer.style.height = '100%';
        modelViewer.style.pointerEvents = 'none';
        
        // Terrain-specific styling
        this.applyTerrainStyling(modelViewer, tileData.type);
        
        // Accessibility
        const terrainDesc = this.getTerrainDescription(tileData.type);
        modelViewer.title = terrainDesc;
    }

    // Apply terrain-specific visual styling
    applyTerrainStyling(modelViewer, terrainType) {
        // Add terrain height effects
        const heights = window.TERRAIN_CONFIG?.heights || {
            mountain: 120, hill: 80, forest: 40, farmland: 5
        };
        
        const height = heights[terrainType] || 0;
        if (height > 0) {
            modelViewer.style.transform = `translateZ(${height}px)`;
        }
        
        // Visual filters for terrain types
        switch (terrainType) {
            case 'mountain':
                modelViewer.style.filter = 'brightness(0.9)';
                break;
            case 'hill':
                modelViewer.style.filter = 'brightness(0.95)';
                break;
            default:
                modelViewer.style.filter = 'none';
        }
    }

    // Get accessibility description for terrain
    getTerrainDescription(terrainType) {
        const descriptions = {
            mountain: 'Mountain terrain (Ground animals cannot pass, Flying animals can pass)',
            hill: 'Hill terrain (Ground animals cannot pass, Flying animals can pass)',
            forest: 'Forest terrain (All animals can pass)',
            farmland: 'Farmland terrain (All animals can pass)'
        };
        
        return descriptions[terrainType] || 'Terrain tile';
    }

    // Clear grid and return tiles to pool for reuse
    clearGrid(container) {
        const tiles = container.querySelectorAll('.tile-3d-container');
        
        tiles.forEach(tile => {
            const terrainType = tile.dataset.terrainType;
            if (terrainType && this.tilePool.size < 100) { // Limit pool size
                // Clean tile for reuse
                tile.style.left = '';
                tile.style.top = '';
                delete tile.dataset.tileId;
                delete tile.dataset.hexX;
                delete tile.dataset.hexY;
                
                this.tilePool.set(terrainType, tile);
            }
            
            tile.remove();
        });
        
        this.loadedTiles.clear();
        console.log(`🧹 Cleared grid, ${this.tilePool.size} tiles returned to pool`);
    }

    // Log terrain generation statistics
    logTerrainStats(layout, cols, rows) {
        const stats = {};
        let totalTiles = 0;
        
        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                const terrainType = layout[x][y].type;
                stats[terrainType] = (stats[terrainType] || 0) + 1;
                totalTiles++;
            }
        }
        
        console.log('🗺️ Terrain Statistics:');
        Object.entries(stats).forEach(([type, count]) => {
            const percentage = Math.round((count / totalTiles) * 100);
            console.log(`  ${type}: ${count} tiles (${percentage}%)`);
        });
        
        const traversableTiles = (stats.forest || 0) + (stats.farmland || 0);
        const nonTraversableTiles = (stats.mountain || 0) + (stats.hill || 0);
        console.log(`🚶 Traversable: ${traversableTiles} tiles, Non-traversable: ${nonTraversableTiles} tiles`);
    }

    // Get terrain height for 3D effects
    getTerrainHeight(terrainType, multiplier = 1) {
        const heights = window.TERRAIN_CONFIG?.heights || {
            mountain: 120, hill: 80, forest: 40, farmland: 5
        };
        
        return (heights[terrainType] || 0) * multiplier;
    }

    // Check if position is on traversable terrain
    isPositionTraversable(screenX, screenY, animalType) {
        if (!window.pathfinding) return true;
        
        const hex = window.pathfinding.screenToHex(screenX, screenY);
        return window.pathfinding.isTileTraversable(hex.x, hex.y, animalType);
    }

    // Update terrain settings (for development)
    updateTerrainSettings(newSettings) {
        if (newSettings.weights) {
            Object.assign(this.terrainWeights, newSettings.weights);
        }
        
        console.log('🔧 Updated terrain settings:', newSettings);
    }

    // Get terrain info at screen position
    getTerrainAt(screenX, screenY) {
        if (!window.pathfinding || !this.mapCache) return null;
        
        const hex = window.pathfinding.screenToHex(screenX, screenY);
        if (hex.x >= 0 && hex.y >= 0 && 
            hex.x < this.mapCache.length && 
            hex.y < this.mapCache[0].length) {
            return this.mapCache[hex.x][hex.y];
        }
        
        return null;
    }

    // Cleanup resources
    destroy() {
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
        }
        
        this.mapCache = null;
        this.loadedTiles.clear();
        this.tilePool.clear();
    }
}

// Create global terrain system instance
window.terrainSystem = new TerrainSystem();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TerrainSystem };
} 