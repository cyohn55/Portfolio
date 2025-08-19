/**
 * Game State Management
 * Centralized state management with performance optimizations
 */

class GameState {
    constructor() {
        this.reset();
        
        // Performance optimization: Pre-allocate arrays to avoid garbage collection
        this._tempArray = new Array(100);
        this._unitPool = new Map(); // Object pooling for units
        this._lastCleanupTime = 0;
        this.CLEANUP_INTERVAL = 30000; // 30 seconds
        
        // Bind methods to avoid creating new functions in loops
        this.updateUnit = this.updateUnit.bind(this);
        this.renderUnit = this.renderUnit.bind(this);
    }

    reset() {
        this.selectedAnimals = [];
        this.units = [];
        this.bases = [];
        this.selectedUnits = [];
        this.gameStarted = false;
        this.camera = { x: 0, y: 0, zoom: 1 };
        this.selection = {
            isSelecting: false,
            start: { x: 0, y: 0 },
            end: { x: 0, y: 0 }
        };
        
        // Population tracking - Use fallback if TEAMS not loaded
        const playerTeam = window.TEAMS?.PLAYER || 'player';
        const aiTeam = window.TEAMS?.AI || 'enemy';
        
        this.population = {
            total: 0,
            byTeam: { [playerTeam]: 0, [aiTeam]: 0 },
            byAnimal: this._initializeAnimalPopulation()
        };
        
        // Performance metrics
        this.performance = {
            frameCount: 0,
            lastFPSUpdate: 0,
            currentFPS: 0,
            visibleUnits: 0
        };
        
        // Game map - Use fallback if GAME_SETTINGS not loaded
        const gridSettings = window.GAME_SETTINGS?.grid || { defaultCols: 12, defaultRows: 16 };
        
        this.map = {
            layout: null,
            width: 2000,
            height: 1500,
            cols: gridSettings.defaultCols,
            rows: gridSettings.defaultRows
        };
    }

    _initializeAnimalPopulation() {
        const animalPop = {};
        Object.keys(ANIMAL_CONFIGS).forEach(animal => {
            animalPop[animal] = { [TEAMS.PLAYER]: 0, [TEAMS.AI]: 0 };
        });
        return animalPop;
    }

    // Unit management with object pooling
    createUnit(baseConfig) {
        let unit = this._unitPool.get(baseConfig.animal);
        
        if (!unit) {
            // Create new unit if none available in pool
            unit = {
                id: this._generateUnitId(),
                animal: baseConfig.animal,
                team: baseConfig.team,
                x: 0, y: 0,
                targetX: null, targetY: null,
                isMoving: false,
                size: ANIMAL_CONFIGS[baseConfig.animal].size,
                speed: ANIMAL_CONFIGS[baseConfig.animal].speed,
                modelElement: null,
                path: null,
                pathIndex: 0,
                lastUpdate: 0,
                isVisible: true
            };
        } else {
            // Reuse pooled unit
            this._unitPool.delete(baseConfig.animal);
            unit.id = this._generateUnitId();
            unit.team = baseConfig.team;
            unit.isMoving = false;
            unit.path = null;
            unit.pathIndex = 0;
        }

        // Set position
        const angle = Math.random() * Math.PI * 2;
        const distance = baseConfig.size + 30;
        unit.x = baseConfig.x + Math.cos(angle) * distance;
        unit.y = baseConfig.y + Math.sin(angle) * distance;

        this.units.push(unit);
        this.updatePopulation(unit.animal, unit.team, 1);
        
        return unit;
    }

    removeUnit(unit) {
        const index = this.units.indexOf(unit);
        if (index === -1) return false;

        // Remove from arrays
        this.units.splice(index, 1);
        
        // Remove from selected units if present
        const selectedIndex = this.selectedUnits.indexOf(unit);
        if (selectedIndex !== -1) {
            this.selectedUnits.splice(selectedIndex, 1);
        }

        // Clean up 3D model
        if (unit.modelElement && unit.modelElement.parentNode) {
            unit.modelElement.parentNode.removeChild(unit.modelElement);
            unit.modelElement = null;
        }

        // Update population
        this.updatePopulation(unit.animal, unit.team, -1);

        // Return to pool for reuse (if pool isn't full)
        if (this._unitPool.size < 50) {
            this._unitPool.set(unit.animal, unit);
        }

        return true;
    }

    updatePopulation(animal, team, delta) {
        this.population.byTeam[team] += delta;
        this.population.byAnimal[animal][team] += delta;
        this.population.total = this.population.byTeam[TEAMS.PLAYER] + this.population.byTeam[TEAMS.AI];
    }

    canSpawnUnit(animal, team) {
        return this.population.byTeam[team] < GAME_SETTINGS.population.maxPerTeam &&
               this.population.byAnimal[animal][team] < GAME_SETTINGS.population.maxPerAnimalType;
    }

    // Selection management
    startSelection(x, y) {
        this.selection.isSelecting = true;
        this.selection.start = { x, y };
        this.selection.end = { x, y };
        this.selectedUnits.length = 0; // Clear without creating new array
    }

    updateSelection(x, y) {
        if (!this.selection.isSelecting) return;
        this.selection.end = { x, y };
    }

    finishSelection() {
        if (!this.selection.isSelecting) return;
        
        this.selection.isSelecting = false;
        
        const minX = Math.min(this.selection.start.x, this.selection.end.x);
        const maxX = Math.max(this.selection.start.x, this.selection.end.x);
        const minY = Math.min(this.selection.start.y, this.selection.end.y);
        const maxY = Math.max(this.selection.start.y, this.selection.end.y);

        // Clear selection array efficiently
        this.selectedUnits.length = 0;
        
        // Find units in selection area
        for (let i = 0; i < this.units.length; i++) {
            const unit = this.units[i];
            if (unit.team === TEAMS.PLAYER &&
                unit.x >= minX && unit.x <= maxX && 
                unit.y >= minY && unit.y <= maxY) {
                this.selectedUnits.push(unit);
            }
        }
    }

    // Camera management
    updateCamera(deltaX, deltaY, zoomDelta = 0) {
        this.camera.x += deltaX * GAME_SETTINGS.ui.cameraSpeed;
        this.camera.y += deltaY * GAME_SETTINGS.ui.cameraSpeed;
        
        if (zoomDelta !== 0) {
            this.camera.zoom = Math.max(0.5, Math.min(3, this.camera.zoom + zoomDelta * GAME_SETTINGS.ui.zoomSpeed));
        }
        
        // Clamp camera to map bounds
        this.camera.x = Math.max(0, Math.min(this.map.width - window.innerWidth, this.camera.x));
        this.camera.y = Math.max(0, Math.min(this.map.height - window.innerHeight, this.camera.y));
    }

    // Performance monitoring
    updatePerformance() {
        this.performance.frameCount++;
        const now = performance.now();
        
        if (now - this.performance.lastFPSUpdate >= 1000) {
            this.performance.currentFPS = this.performance.frameCount;
            this.performance.frameCount = 0;
            this.performance.lastFPSUpdate = now;
        }
        
        // Count visible units (for optimization)
        this.performance.visibleUnits = this.units.filter(unit => 
            this.isUnitVisible(unit)).length;
    }

    isUnitVisible(unit) {
        return unit.x >= this.camera.x - 100 && 
               unit.x <= this.camera.x + window.innerWidth + 100 &&
               unit.y >= this.camera.y - 100 && 
               unit.y <= this.camera.y + window.innerHeight + 100;
    }

    // Periodic cleanup to prevent memory leaks
    performCleanup() {
        const now = Date.now();
        if (now - this._lastCleanupTime < this.CLEANUP_INTERVAL) return;
        
        this._lastCleanupTime = now;
        
        // Clean up orphaned model elements
        const modelContainer = document.getElementById('modelsContainer');
        if (modelContainer) {
            const modelElements = modelContainer.children;
            const unitIds = new Set(this.units.map(u => u.id));
            
            for (let i = modelElements.length - 1; i >= 0; i--) {
                const element = modelElements[i];
                const unitId = element.id.replace('unit-', '');
                if (!unitIds.has(parseInt(unitId))) {
                    element.remove();
                }
            }
        }
        
        // Limit unit pool size
        if (this._unitPool.size > 100) {
            const entries = Array.from(this._unitPool.entries());
            entries.slice(50).forEach(([key]) => this._unitPool.delete(key));
        }
    }

    _generateUnitId() {
        return Date.now() + Math.floor(Math.random() * 1000);
    }

    // Utility methods
    getUnitsOfType(animalType, team = null) {
        return this.units.filter(unit => 
            unit.animal === animalType && 
            (team === null || unit.team === team)
        );
    }

    getNearestEnemyUnit(x, y, team) {
        let nearest = null;
        let nearestDistance = Infinity;
        
        for (let i = 0; i < this.units.length; i++) {
            const unit = this.units[i];
            if (unit.team !== team) {
                const distance = Math.hypot(unit.x - x, unit.y - y);
                if (distance < nearestDistance) {
                    nearest = unit;
                    nearestDistance = distance;
                }
            }
        }
        
        return nearest;
    }
}

// Create global game state instance
window.gameState = new GameState();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GameState };
} 