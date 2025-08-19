/**
 * Unit System - 3D Unit Management & Animation
 * Optimized with object pooling, viewport culling, and efficient model handling
 */

class UnitSystem {
    constructor() {
        this.modelPool = new Map();
        this.maxPoolSize = 50;
        this.lastUpdateTime = 0;
        this.frameCount = 0;
        
        // Performance tracking
        this.performance = {
            visibleUnits: 0,
            culledUnits: 0,
            pooledModels: 0
        };
        
        // Bind methods to avoid function creation in loops
        this.updateUnit = this.updateUnit.bind(this);
        
        // Unit movement threshold for precision
        this.movementThreshold = window.GAME_SETTINGS?.movement?.pathfindingThreshold || 10;
    }

    // Create unit with optimized 3D model
    createUnit(config) {
        // Use game state's object pooling
        const unit = window.gameState?.createUnit(config);
        if (!unit) return null;

        // Create 3D model
        unit.modelElement = this.createUnitModel(unit);
        
        console.log(`🐾 Created ${unit.animal} (${unit.team}) at (${Math.round(unit.x)}, ${Math.round(unit.y)})`);
        
        return unit;
    }

    // Create optimized 3D model for unit
    createUnitModel(unit) {
        const animalConfig = window.ANIMAL_CONFIGS?.[unit.animal];
        if (!animalConfig) {
            console.warn(`No config found for animal: ${unit.animal}`);
            return null;
        }

        // Try to reuse model from pool
        let modelContainer = this.modelPool.get(unit.animal);
        if (modelContainer) {
            this.modelPool.delete(unit.animal);
            this.performance.pooledModels++;
        } else {
            modelContainer = this.createNewModelContainer(unit, animalConfig);
        }

        // Setup model for this unit
        this.setupModelForUnit(modelContainer, unit, animalConfig);
        
        // Add to DOM
        const modelsContainer = document.getElementById('modelsContainer');
        if (modelsContainer) {
            modelsContainer.appendChild(modelContainer);
        }

        return modelContainer;
    }

    // Create new model container element
    createNewModelContainer(unit, animalConfig) {
        const modelContainer = document.createElement('div');
        modelContainer.className = 'unit-model';
        
        const modelViewer = document.createElement('model-viewer');
        this.setupModelViewer(modelViewer, animalConfig);
        
        modelContainer.appendChild(modelViewer);
        return modelContainer;
    }

    // Setup model-viewer with performance optimizations
    setupModelViewer(modelViewer, animalConfig) {
        const performanceSettings = window.PERFORMANCE_CONFIG?.modelViewerSettings || {};
        
        modelViewer.src = animalConfig.model;
        modelViewer.alt = `${animalConfig.emoji} ${animalConfig.model} unit`;
        
        // Performance settings
        modelViewer.autoRotate = false;
        modelViewer.cameraControls = false;
        modelViewer.setAttribute('disable-zoom', '');
        modelViewer.setAttribute('interaction-prompt', 'none');
        modelViewer.setAttribute('loading', 'eager');
        modelViewer.setAttribute('reveal', 'auto');
        
        // Camera and framing settings
        modelViewer.setAttribute('camera-orbit', performanceSettings.cameraOrbit || '0deg 75deg 100m');
        modelViewer.setAttribute('field-of-view', performanceSettings.fieldOfView || '15deg');
        modelViewer.setAttribute('camera-target', 'auto auto auto');
        modelViewer.setAttribute('min-camera-orbit', 'auto auto auto');
        modelViewer.setAttribute('max-camera-orbit', 'auto auto auto');
        
        // Prevent model clipping and improve visibility
        modelViewer.addEventListener('load', () => {
            setTimeout(() => {
                try {
                    modelViewer.setAttribute('camera-orbit', '0deg 75deg 80m');
                    modelViewer.setAttribute('field-of-view', '20deg');
                } catch (e) {
                    // Fallback if camera adjustment fails
                    console.warn('Model camera adjustment failed:', e);
                }
            }, 100);
        });

        // Styling
        modelViewer.style.width = '100%';
        modelViewer.style.height = '100%';
        modelViewer.style.pointerEvents = 'none';
    }

    // Setup model container for specific unit
    setupModelForUnit(modelContainer, unit, animalConfig) {
        modelContainer.id = `unit-${unit.id}`;
        
        // Size based on unit config and settings
        const sizeMultiplier = window.devSettings?.units?.sizeMultiplier || 1;
        const modelSize = unit.size * 3 * sizeMultiplier;
        
        modelContainer.style.width = modelSize + 'px';
        modelContainer.style.height = modelSize + 'px';
        modelContainer.style.position = 'absolute';
        modelContainer.style.pointerEvents = 'none';
        modelContainer.style.zIndex = '15';
        
        // Performance optimizations
        modelContainer.style.willChange = 'transform';
        modelContainer.style.contain = 'strict';
        
        // Store unit reference for updates
        modelContainer.unitId = unit.id;
    }

    // Update unit movement and behavior
    updateUnit(unit, deltaTime) {
        if (!unit.isMoving) return;

        const speedMultiplier = window.devSettings?.units?.speedMultiplier || 1;
        
        // A* path-based movement
        if (unit.path && unit.pathIndex < unit.path.length) {
            this.updatePathMovement(unit, speedMultiplier);
        }
        // Direct movement fallback
        else if (unit.targetX !== null && unit.targetY !== null) {
            this.updateDirectMovement(unit, speedMultiplier);
        }
    }

    // Update movement along A* path
    updatePathMovement(unit, speedMultiplier) {
        const currentTarget = unit.path[unit.pathIndex];
        const targetPos = window.pathfinding?.hexToScreen(currentTarget.x, currentTarget.y);
        
        if (!targetPos) return;
        
        const dx = targetPos.x - unit.x;
        const dy = targetPos.y - unit.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > this.movementThreshold) {
            const moveX = (dx / distance) * unit.speed * speedMultiplier;
            const moveY = (dy / distance) * unit.speed * speedMultiplier;
            
            const nextX = unit.x + moveX;
            const nextY = unit.y + moveY;
            
            // Check collision
            if (!this.checkCollision(nextX, nextY, unit)) {
                unit.x = nextX;
                unit.y = nextY;
                this.rotateUnitToMovement(unit, dx, dy);
            } else {
                this.handleCollision(unit, nextX, nextY);
            }
        } else {
            // Reached waypoint, move to next
            unit.pathIndex++;
            if (unit.pathIndex >= unit.path.length) {
                unit.isMoving = false;
                unit.path = null;
                unit.pathIndex = 0;
            }
        }
    }

    // Update direct movement (fallback)
    updateDirectMovement(unit, speedMultiplier) {
        const dx = unit.targetX - unit.x;
        const dy = unit.targetY - unit.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > this.movementThreshold) {
            const moveX = (dx / distance) * unit.speed * speedMultiplier;
            const moveY = (dy / distance) * unit.speed * speedMultiplier;
            
            const nextX = unit.x + moveX;
            const nextY = unit.y + moveY;
            
            // Check collision
            if (!this.checkCollision(nextX, nextY, unit)) {
                unit.x = nextX;
                unit.y = nextY;
                this.rotateUnitToMovement(unit, dx, dy);
            } else {
                this.handleCollision(unit, nextX, nextY);
            }
        } else {
            unit.isMoving = false;
            unit.targetX = null;
            unit.targetY = null;
        }
    }

    // Rotate unit model to face movement direction
    rotateUnitToMovement(unit, dx, dy) {
        if (!unit.modelElement) return;
        
        const modelViewer = unit.modelElement.querySelector('model-viewer');
        if (!modelViewer) return;
        
        const angleRad = Math.atan2(dy, dx);
        const angleDeg = angleRad * 180 / Math.PI;
        const yaw = -(angleDeg - 90);
        
        modelViewer.setAttribute('rotation', `0deg ${yaw.toFixed(2)}deg 0deg`);
    }

    // Simple collision detection
    checkCollision(x, y, unit) {
        // Flying animals don't collide with terrain
        if (window.FLYING_ANIMALS?.includes(unit.animal)) {
            return false;
        }
        
        // Use terrain system for collision detection
        return !window.terrainSystem?.isPositionTraversable(x, y, unit.animal);
    }

    // Handle collision by recalculating path
    handleCollision(unit, blockedX, blockedY) {
        console.log(`🚫 ${unit.animal} collision detected - recalculating path`);
        
        // Get final destination
        let finalDestination;
        if (unit.path && unit.path.length > 0) {
            finalDestination = unit.path[unit.path.length - 1];
        } else if (unit.targetX !== null && unit.targetY !== null) {
            finalDestination = window.pathfinding?.screenToHex(unit.targetX, unit.targetY);
        } else {
            unit.isMoving = false;
            return;
        }
        
        // Recalculate path
        if (window.pathfinding && finalDestination) {
            const success = window.pathfinding.findUnitPath(unit, 
                window.pathfinding.hexToScreen(finalDestination.x, finalDestination.y).x,
                window.pathfinding.hexToScreen(finalDestination.x, finalDestination.y).y
            );
            
            if (!success) {
                console.log(`❌ ${unit.animal} no alternative path - stopping`);
                unit.isMoving = false;
            }
        }
    }

    // Update all unit positions with viewport culling
    updateUnitPositions() {
        if (!window.gameState?.units) return;
        
        const camera = window.gameState.camera;
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        
        this.performance.visibleUnits = 0;
        this.performance.culledUnits = 0;
        
        window.gameState.units.forEach(unit => {
            if (!unit.modelElement) return;
            
            // Viewport culling - only update visible units
            const isVisible = this.isUnitVisible(unit, camera, screenWidth, screenHeight);
            
            if (isVisible) {
                this.updateUnitModelPosition(unit, camera);
                this.performance.visibleUnits++;
            } else {
                // Hide off-screen units for performance
                unit.modelElement.style.display = 'none';
                this.performance.culledUnits++;
            }
        });
    }

    // Check if unit is visible in viewport
    isUnitVisible(unit, camera, screenWidth, screenHeight) {
        const margin = 100; // Extra margin for smooth transitions
        return unit.x >= camera.x - margin && 
               unit.x <= camera.x + screenWidth + margin &&
               unit.y >= camera.y - margin && 
               unit.y <= camera.y + screenHeight + margin;
    }

    // Update individual unit model position
    updateUnitModelPosition(unit, camera) {
        if (!unit.modelElement) return;
        
        const modelSize = parseFloat(unit.modelElement.style.width) || (unit.size * 3);
        const screenX = unit.x - camera.x - modelSize / 2;
        const screenY = unit.y - camera.y - modelSize / 2;
        
        unit.modelElement.style.left = screenX + 'px';
        unit.modelElement.style.top = screenY + 'px';
        unit.modelElement.style.display = 'block';
    }

    // Update selection visuals
    updateSelectionVisuals() {
        if (!window.gameState?.units || !window.gameState?.selectedUnits) return;
        
        window.gameState.units.forEach(unit => {
            if (!unit.modelElement) return;
            
            const isSelected = window.gameState.selectedUnits.includes(unit);
            
            if (isSelected) {
                unit.modelElement.classList.add('selected');
            } else {
                unit.modelElement.classList.remove('selected');
            }
        });
    }

    // Remove unit and return model to pool
    removeUnit(unit) {
        if (!unit) return false;
        
        // Remove from game state
        const removed = window.gameState?.removeUnit(unit);
        if (!removed) return false;
        
        // Return model to pool for reuse
        if (unit.modelElement && this.modelPool.size < this.maxPoolSize) {
            // Clean model for reuse
            unit.modelElement.id = '';
            unit.modelElement.classList.remove('selected');
            unit.modelElement.style.display = 'none';
            delete unit.modelElement.unitId;
            
            this.modelPool.set(unit.animal, unit.modelElement);
        } else if (unit.modelElement) {
            // Remove if pool is full
            unit.modelElement.remove();
        }
        
        console.log(`💀 Removed ${unit.animal} (${unit.team})`);
        return true;
    }

    // Spawn unit at base
    spawnUnit(base) {
        if (!window.gameState?.canSpawnUnit(base.animal, base.team)) {
            return null;
        }
        
        // Calculate spawn position around base
        const angle = Math.random() * Math.PI * 2;
        const distance = base.size + 30;
        
        const spawnConfig = {
            animal: base.animal,
            team: base.team,
            x: base.x + Math.cos(angle) * distance,
            y: base.y + Math.sin(angle) * distance,
            size: base.size
        };
        
        return this.createUnit(spawnConfig);
    }

    // AI behavior for enemy units
    updateAI(unit) {
        if (unit.team !== window.TEAMS?.AI || unit.isMoving) return;
        
        // Simple AI: move toward nearest player base
        const playerBases = window.gameState?.bases?.filter(b => b.team === window.TEAMS?.PLAYER);
        if (!playerBases || playerBases.length === 0) return;
        
        let nearest = playerBases[0];
        let nearestDist = Math.hypot(nearest.x - unit.x, nearest.y - unit.y);
        
        playerBases.forEach(base => {
            const dist = Math.hypot(base.x - unit.x, base.y - unit.y);
            if (dist < nearestDist) {
                nearest = base;
                nearestDist = dist;
            }
        });
        
        // Use pathfinding for AI movement
        if (window.pathfinding) {
            window.pathfinding.findUnitPath(unit, nearest.x, nearest.y);
        } else {
            // Fallback to direct movement
            unit.targetX = nearest.x;
            unit.targetY = nearest.y;
            unit.isMoving = true;
        }
    }

    // Performance cleanup
    performCleanup() {
        // Limit model pool size
        if (this.modelPool.size > this.maxPoolSize) {
            const excess = this.modelPool.size - this.maxPoolSize;
            const entries = Array.from(this.modelPool.entries());
            
            entries.slice(0, excess).forEach(([key, element]) => {
                element.remove();
                this.modelPool.delete(key);
            });
        }
        
        // Clean up orphaned model elements
        const modelsContainer = document.getElementById('modelsContainer');
        if (modelsContainer && window.gameState?.units) {
            const unitIds = new Set(window.gameState.units.map(u => u.id));
            const modelElements = modelsContainer.children;
            
            for (let i = modelElements.length - 1; i >= 0; i--) {
                const element = modelElements[i];
                const unitId = element.unitId;
                
                if (unitId && !unitIds.has(unitId)) {
                    element.remove();
                }
            }
        }
    }

    // Get performance statistics
    getPerformanceStats() {
        return {
            ...this.performance,
            totalUnits: window.gameState?.units?.length || 0,
            poolSize: this.modelPool.size,
            visibilityRatio: this.performance.visibleUnits / (this.performance.visibleUnits + this.performance.culledUnits) || 0
        };
    }

    // Cleanup resources
    destroy() {
        this.modelPool.forEach(element => element.remove());
        this.modelPool.clear();
    }
}

// Create global unit system instance
window.unitSystem = new UnitSystem();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UnitSystem };
} 