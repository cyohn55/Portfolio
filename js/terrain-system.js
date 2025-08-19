/**
 * Enhanced Terrain System - Strategic Hex Grid with Red Blob Games Algorithms
 * Features: Axial coordinates, advanced pathfinding, strategic terrain placement
 */

class TerrainSystem {
    constructor() {
        this.hexGrid = new Map(); // Map<string, HexTile> using axial coordinates
        this.loadedTiles = new Set();
        this.intersectionObserver = null;
        this.tilePool = new Map(); // Reuse tile elements
        this.gridRadius = 8; // Hex map radius
        
        // Enhanced terrain configuration from TERRAIN_CONFIG
        this.terrainTypes = window.TERRAIN_CONFIG?.types || this.getDefaultTerrainTypes();
        this.terrainWeights = window.TERRAIN_CONFIG?.weights || this.getDefaultWeights();
        this.strategicPatterns = window.TERRAIN_CONFIG?.patterns || {};
        
        console.log('🏗️ Enhanced Terrain System initialized with axial coordinates');
        this.setupProgressiveLoading();
    }

    // Fallback terrain types if config not loaded
    getDefaultTerrainTypes() {
        return {
            FARMLAND: { model: 'models/FarmLand.glb', type: 'farmland', movement: { ground: 1.0, flying: 1.0 } },
            HILL: { model: 'models/Hill.glb', type: 'hill', movement: { ground: 0.7, flying: 1.0 } },
            MOUNTAIN: { model: 'models/Mountain.glb', type: 'mountain', movement: { ground: 0.0, flying: 1.0 } },
            PINETREE: { model: 'models/PineTree.glb', type: 'pinetree', movement: { ground: 0.8, flying: 0.9 } },
            FOREST: { model: 'models/Forest.glb', type: 'forest', movement: { ground: 0.8, flying: 0.9 } }
        };
    }

    // Fallback weights
    getDefaultWeights() {
        return { farmland: 0.25, hill: 0.15, mountain: 0.10, pinetree: 0.20, forest: 0.30 };
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

    // === NEW HEX-BASED METHODS ===
    
    // Generate strategic hex map using axial coordinates
    generateHexMap(radius = null, useCache = true) {
        const mapRadius = radius || this.gridRadius;
        console.log(`🗺️ Generating strategic hex map: radius ${mapRadius} (cache: ${useCache})`);
        
        if (useCache && this.hexGrid.size > 0) {
            console.log('📋 Using cached hex map layout');
            return this.hexGrid;
        }

        // Clear existing grid
        this.hexGrid.clear();
        
        // Generate hexagonal map shape using Red Blob Games range algorithm
        const centerCoord = new HexCoord(0, 0);
        const hexPositions = HexMath.hexRange(centerCoord, mapRadius);
        
        console.log(`🔧 Creating ${hexPositions.length} hex tiles in strategic layout`);
        
        // Apply strategic terrain placement
        this.applyStrategicPlacement(hexPositions);
        
        // Fill remaining positions with weighted random terrain
        for (const hexCoord of hexPositions) {
            const key = hexCoord.toString();
            if (!this.hexGrid.has(key)) {
                const terrainType = this.selectWeightedTerrain();
                this.createHexTile(hexCoord, terrainType);
            }
        }

        this.logHexTerrainDistribution();
        console.log('✅ Strategic hex map generated');
        return this.hexGrid;
    }

    // Apply strategic terrain placement patterns
    applyStrategicPlacement(hexPositions) {
        const patterns = Object.values(this.strategicPatterns);
        const totalPatternWeight = patterns.reduce((sum, pattern) => sum + pattern.weight, 0);
        
        for (const pattern of patterns) {
            const patternCount = Math.floor(hexPositions.length * (pattern.weight / totalPatternWeight));
            
            for (let i = 0; i < patternCount; i++) {
                const centerHex = hexPositions[Math.floor(Math.random() * hexPositions.length)];
                const neighbors = centerHex.getNeighbors();
                
                // Place pattern terrain in center and neighbors
                const terrains = pattern.terrains;
                this.createHexTile(centerHex, terrains[0]);
                
                for (let j = 0; j < Math.min(neighbors.length, terrains.length - 1); j++) {
                    const neighbor = neighbors[j];
                    const terrainType = terrains[j + 1] || terrains[Math.floor(Math.random() * terrains.length)];
                    this.createHexTile(neighbor, terrainType);
                }
            }
        }
    }

    // Create a hex tile with terrain properties
    createHexTile(hexCoord, terrainType) {
        const key = hexCoord.toString();
        const terrainConfig = this.terrainTypes[terrainType.toUpperCase()] || this.terrainTypes.FARMLAND;
        
        const hexTile = {
            coord: hexCoord,
            terrain: terrainConfig,
            units: [],
            visibility: new Set(),
            explored: false,
            resources: terrainConfig.resources || {},
            lastUpdate: Date.now()
        };
        
        this.hexGrid.set(key, hexTile);
        return hexTile;
    }

    // Select terrain type using weighted distribution
    selectWeightedTerrain() {
        const weights = Object.values(this.terrainWeights);
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        let random = Math.random() * totalWeight;
        
        const terrainTypes = Object.keys(this.terrainWeights);
        for (const terrainType of terrainTypes) {
            random -= this.terrainWeights[terrainType];
            if (random <= 0) {
                return terrainType;
            }
        }
        
        return 'farmland'; // Fallback
    }

    // Get hex tile at coordinate
    getHexTile(hexCoord) {
        const key = hexCoord.toString();
        return this.hexGrid.get(key);
    }

    // Get all hex neighbors that exist on the map
    getHexNeighbors(hexCoord) {
        return hexCoord.getNeighbors()
            .map(neighborCoord => this.getHexTile(neighborCoord))
            .filter(tile => tile !== undefined);
    }

    // Check line of sight between two hex positions
    hasLineOfSight(startCoord, endCoord) {
        const line = HexMath.hexLineDraw(startCoord, endCoord);
        
        for (const coord of line) {
            const tile = this.getHexTile(coord);
            if (tile?.terrain.vision?.blocks) {
                return false;
            }
        }
        return true;
    }

    // Get movement cost for unit type on terrain
    getMovementCost(hexCoord, unitType) {
        const tile = this.getHexTile(hexCoord);
        if (!tile) return Infinity;
        
        const isFlying = window.FLYING_ANIMALS?.includes(unitType) || false;
        const movementType = isFlying ? 'flying' : 'ground';
        
        return 1 / (tile.terrain.movement[movementType] || 0.1);
    }

    // Log hex terrain distribution
    logHexTerrainDistribution() {
        const distribution = {};
        let total = 0;
        
        for (const tile of this.hexGrid.values()) {
            const type = tile.terrain.type;
            distribution[type] = (distribution[type] || 0) + 1;
            total++;
        }
        
        console.log('🗺️ Hex Terrain Distribution:', distribution);
        console.log(`📊 Total hex tiles: ${total}`);
    }

    // === END HEX-BASED METHODS ===

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
        console.log(`🏗️ Starting hex grid generation: ${cols}x${rows} tiles`);
        
        const container = document.getElementById('hex-grid');
        if (!container) {
            console.error('❌ Hex grid container (#hex-grid) not found!');
            console.log('Available elements:', document.getElementById('gameScreen') ? 'gameScreen found' : 'gameScreen missing');
            return false;
        }
        
        console.log('✅ Hex grid container found:', container);

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
        let tilesCreated = 0;

        console.log(`🔧 Creating ${cols * rows} terrain tiles...`);

        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                const tileData = mapLayout[x][y];
                
                // Calculate tile position
                const position = this.calculateTilePosition(x, y, hexWidth, hexHeight, settings.hexOffset);
                
                // Create tile element
                const tileElement = this.createTerrainTile(tileData, position, settings);
                
                if (tileElement) {
                    fragment.appendChild(tileElement);
                    tilesCreated++;
                    
                    // Add to progressive loading if enabled
                    if (this.intersectionObserver) {
                        tilesToObserve.push(tileElement);
                    }
                } else {
                    console.warn(`⚠️ Failed to create tile at (${x}, ${y}):`, tileData);
                }
            }
        }

        console.log(`✅ Created ${tilesCreated} terrain tiles, adding to container...`);

        // Batch insert all tiles
        container.appendChild(fragment);
        
        console.log(`🎯 Hex grid generation complete! Container now has ${container.children.length} tiles`);

        // Setup progressive loading for new tiles
        tilesToObserve.forEach(tile => {
            if (this.intersectionObserver) {
                this.intersectionObserver.observe(tile);
            }
        });

        console.log(`✅ Generated hex grid: ${cols}x${rows} with ${cols * rows} tiles`);
        console.log(`🌍 Terrain distribution:`, this.getTerrainDistribution(mapLayout, cols, rows));
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
        try {
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
                // Check if model-viewer is available
                if (typeof customElements.get('model-viewer') === 'undefined') {
                    console.warn('⚠️ model-viewer not available yet, creating fallback div');
                    modelViewer = document.createElement('div');
                    modelViewer.textContent = `🌍 ${tileData.type}`;
                    modelViewer.style.display = 'flex';
                    modelViewer.style.alignItems = 'center';
                    modelViewer.style.justifyContent = 'center';
                    modelViewer.style.background = this.getTerrainColor(tileData.type);
                    modelViewer.style.color = 'white';
                    modelViewer.style.fontSize = '12px';
                } else {
                    modelViewer = document.createElement('model-viewer');
                }
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
        } catch (error) {
            console.error(`❌ Error creating terrain tile for ${tileData.type}:`, error);
            
            // Return a fallback div even on error
            const fallbackContainer = document.createElement('div');
            fallbackContainer.textContent = `❌ ${tileData.type}`;
            fallbackContainer.style.position = 'absolute';
            fallbackContainer.style.left = position.x + 'px';
            fallbackContainer.style.top = position.y + 'px';
            fallbackContainer.style.width = settings.tileWidth + 'px';
            fallbackContainer.style.height = settings.tileHeight + 'px';
            fallbackContainer.style.background = 'red';
            fallbackContainer.style.color = 'white';
            fallbackContainer.style.display = 'flex';
            fallbackContainer.style.alignItems = 'center';
            fallbackContainer.style.justifyContent = 'center';
            
            return fallbackContainer;
        }
    }

    // Get fallback color for terrain types
    getTerrainColor(terrainType) {
        const colors = {
            mountain: '#666',
            hill: '#8B4513',
            forest: '#228B22',
            farmland: '#90EE90',
            pinetree: '#006400'
        };
        return colors[terrainType] || '#444';
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
            mountain: 120, hill: 80, forest: 40, farmland: 5, pinetree: 60
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
            farmland: 'Farmland terrain (All animals can pass)',
            pinetree: 'Pine tree terrain (All animals can pass)'
        };
        
        return descriptions[terrainType] || 'Terrain tile';
    }

    // Get terrain distribution for debugging
    getTerrainDistribution(mapLayout, cols, rows) {
        const distribution = {};
        
        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                const terrainType = mapLayout[x][y].type;
                distribution[terrainType] = (distribution[terrainType] || 0) + 1;
            }
        }
        
        return distribution;
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