/**
 * Game Engine - Main Game Loop & System Orchestration
 * Optimized game loop with performance monitoring and system coordination
 */

class GameEngine {
    constructor() {
        this.isRunning = false;
        this.lastFrameTime = 0;
        this.frameCount = 0;
        this.fpsCounter = 0;
        this.lastFPSUpdate = 0;
        
        // Performance monitoring
        this.performance = {
            frameTime: 0,
            fps: 0,
            memoryUsage: 0,
            visibleUnits: 0
        };
        
        // System references
        this.systems = {
            ui: null,
            terrain: null,
            units: null,
            pathfinding: null
        };
        
        // Game timing
        this.targetFPS = window.PERFORMANCE_CONFIG?.targetFPS || 60;
        this.frameInterval = 1000 / this.targetFPS;
        this.accumulator = 0;
        
        // Base management
        this.lastSpawnCheck = 0;
        this.spawnCheckInterval = 1000; // Check every second
        
        // Initialization flag
        this.isInitialized = false;
    }

    // Initialize the game engine and all systems
    static initialize() {
        console.log('🚀 Initializing Game Engine...');
        
        if (!window.gameEngine) {
            window.gameEngine = new GameEngine();
        }
        
        return window.gameEngine.init().then(result => {
            if (result) {
                console.log('✅ Game Engine initialized successfully');
            } else {
                console.error('❌ Game Engine initialization failed');
            }
            return result;
        });
    }

    // Internal initialization
    async init() {
        if (this.isInitialized) return true;
        
        try {
            // Initialize systems in order
            await this.initializeSystems();
            
            // Setup canvas
            this.setupCanvas();
            
            // Initialize UI
            if (window.uiSystem) {
                window.uiSystem.initialize();
                this.systems.ui = window.uiSystem;
            }
            
            this.isInitialized = true;
            console.log('✅ Game Engine initialized successfully');
            
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize Game Engine:', error);
            return false;
        }
    }

    // Initialize all game systems
    async initializeSystems() {
        console.log('🔧 Initializing game systems...');
        
        // Initialize terrain system
        if (window.terrainSystem) {
            this.systems.terrain = window.terrainSystem;
            console.log('✅ Terrain system initialized');
        } else {
            console.error('❌ window.terrainSystem not found!');
        }
        
        // Initialize unit system
        if (window.unitSystem) {
            this.systems.units = window.unitSystem;
        }
        
        // Initialize pathfinding system
        if (window.pathfinding) {
            this.systems.pathfinding = window.pathfinding;
        }
        
        // Preload critical 3D models
        await this.preloadModels();
        
        console.log('✅ All systems initialized');
    }

    // Preload essential 3D models for performance
    async preloadModels() {
        if (!window.gameState?.selectedAnimals?.length) {
            console.log('⏳ Waiting for animal selection...');
            return;
        }
        
        console.log('📦 Preloading 3D models...');
        
        const modelsToLoad = window.gameState.selectedAnimals.map(
            animal => window.ANIMAL_CONFIGS[animal]?.model
        ).filter(Boolean);
        
        // Create invisible model-viewers for preloading
        const preloadContainer = document.createElement('div');
        preloadContainer.style.position = 'absolute';
        preloadContainer.style.top = '-1000px';
        preloadContainer.style.visibility = 'hidden';
        document.body.appendChild(preloadContainer);
        
        const loadPromises = modelsToLoad.map(modelPath => {
            return new Promise((resolve) => {
                const modelViewer = document.createElement('model-viewer');
                modelViewer.src = modelPath;
                modelViewer.style.width = '1px';
                modelViewer.style.height = '1px';
                
                const timeout = setTimeout(() => resolve(), 3000); // 3s timeout
                
                modelViewer.addEventListener('load', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                
                modelViewer.addEventListener('error', () => {
                    clearTimeout(timeout);
                    console.warn(`Failed to preload: ${modelPath}`);
                    resolve();
                });
                
                preloadContainer.appendChild(modelViewer);
            });
        });
        
        await Promise.all(loadPromises);
        document.body.removeChild(preloadContainer);
        
        console.log('✅ Models preloaded');
    }

    // Setup game canvas
    setupCanvas() {
        const canvas = document.getElementById('gameCanvas');
        if (!canvas) {
            console.error('Game canvas not found');
            return;
        }
        
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        
        console.log(`📺 Canvas setup: ${canvas.width}x${canvas.height}`);
    }

    // Start the main game
    startGame() {
        if (!this.isInitialized) {
            console.error('Game engine not initialized');
            return false;
        }
        
        console.log('🎮 Starting game...');
        
        // Initialize game state
        if (window.gameState) {
            window.gameState.gameStarted = true;
            
            // Generate terrain
            if (this.systems.terrain) {
                console.log('🌍 Terrain system found, generating hex grid...');
                const terrainResult = this.systems.terrain.generateHexGrid();
                console.log('🗺️ Terrain generation result:', terrainResult);
            } else {
                console.error('❌ Terrain system not found! Available systems:', Object.keys(this.systems));
            }
            
            // Create bases for selected animals
            this.createPlayerBases();
            this.createEnemyBases();
        }
        
        // Start the game loop
        this.startGameLoop();
        
        console.log('✅ Game started successfully');
        return true;
    }

    // Create player bases
    createPlayerBases() {
        if (!window.gameState?.selectedAnimals) return;
        
        window.gameState.selectedAnimals.forEach((animal, index) => {
            const base = {
                animal: animal,
                team: window.TEAMS?.PLAYER || 'player',
                x: 200 + (index * 150),
                y: 200,
                lastSpawn: 0,
                spawnInterval: window.GAME_SETTINGS?.population?.spawnInterval || 15000,
                size: 40
            };
            
            window.gameState.bases.push(base);
            console.log(`🏠 Created player base: ${animal}`);
        });
    }

    // Create enemy bases
    createEnemyBases() {
        if (!window.gameState?.selectedAnimals) return;
        
        // Get random animals not selected by player
        const availableAnimals = Object.keys(window.ANIMAL_CONFIGS || {})
            .filter(animal => !window.gameState.selectedAnimals.includes(animal));
        
        // Shuffle and take first 3
        for (let i = availableAnimals.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [availableAnimals[i], availableAnimals[j]] = [availableAnimals[j], availableAnimals[i]];
        }
        
        const enemyAnimals = availableAnimals.slice(0, 3);
        
        enemyAnimals.forEach((animal, index) => {
            const base = {
                animal: animal,
                team: window.TEAMS?.AI || 'enemy',
                x: window.gameState.map.width - (200 + (index * 150)),
                y: window.gameState.map.height - 200,
                lastSpawn: 0,
                spawnInterval: window.GAME_SETTINGS?.population?.spawnInterval || 15000,
                size: 40
            };
            
            window.gameState.bases.push(base);
            console.log(`🏠 Created enemy base: ${animal}`);
        });
    }

    // Start the optimized game loop
    startGameLoop() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        this.lastFrameTime = performance.now();
        
        console.log('🔄 Starting game loop...');
        this.gameLoop();
    }

    // Main game loop with performance optimizations
    gameLoop(currentTime) {
        if (!this.isRunning) return;
        
        // Calculate frame timing
        const deltaTime = currentTime - this.lastFrameTime;
        this.lastFrameTime = currentTime;
        
        // Update performance metrics
        this.updatePerformanceMetrics(deltaTime, currentTime);
        
        // Fixed timestep with accumulator for consistent physics
        this.accumulator += deltaTime;
        
        while (this.accumulator >= this.frameInterval) {
            this.update(this.frameInterval);
            this.accumulator -= this.frameInterval;
        }
        
        // Render with interpolation
        this.render();
        
        // Continue loop
        requestAnimationFrame((time) => this.gameLoop(time));
    }

    // Update game systems
    update(deltaTime) {
        if (!window.gameState?.gameStarted) return;
        
        // Update game state performance tracking
        if (window.gameState.updatePerformance) {
            window.gameState.updatePerformance();
        }
        
        // Manage unit spawning
        this.managePopulation();
        
        // Update all units
        this.updateUnits(deltaTime);
        
        // Update UI (throttled)
        if (this.systems.ui) {
            this.systems.ui.updateUI();
        }
        
        // Periodic cleanup
        this.performPeriodicCleanup();
    }

    // Render game elements
    render() {
        const canvas = document.getElementById('gameCanvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Save context for camera transform
        ctx.save();
        if (window.gameState?.camera) {
            ctx.translate(-window.gameState.camera.x, -window.gameState.camera.y);
        }
        
        // Render bases
        this.renderBases(ctx);
        
        // Render movement indicators for selected units
        this.renderMovementIndicators(ctx);
        
        ctx.restore();
        
        // Update unit model positions (3D models are separate from canvas)
        if (this.systems.units) {
            this.systems.units.updateUnitPositions();
        }
    }

    // Render base structures
    renderBases(ctx) {
        if (!window.gameState?.bases) return;
        
        window.gameState.bases.forEach(base => {
            const config = window.ANIMAL_CONFIGS?.[base.animal];
            if (!config) return;
            
            // Base structure
            ctx.fillStyle = base.team === window.TEAMS?.PLAYER ? '#4a4a4a' : '#8a4a4a';
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 3;
            
            // Different shapes based on base style
            if (config.baseStyle === 'hive') {
                this.drawHexagon(ctx, base.x, base.y, base.size);
            } else if (config.baseStyle === 'pond') {
                ctx.beginPath();
                ctx.arc(base.x, base.y, base.size, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            } else {
                ctx.fillRect(base.x - base.size/2, base.y - base.size/2, base.size, base.size);
                ctx.strokeRect(base.x - base.size/2, base.y - base.size/2, base.size, base.size);
            }
            
            // Base emoji/icon
            ctx.font = '24px Arial';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#fff';
            ctx.fillText(config.emoji, base.x, base.y + 8);
        });
    }

    // Draw hexagon shape
    drawHexagon(ctx, x, y, size) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = (i * Math.PI) / 3;
            const px = x + Math.cos(angle) * size;
            const py = y + Math.sin(angle) * size;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    // Render movement indicators
    renderMovementIndicators(ctx) {
        if (!window.gameState?.selectedUnits) return;
        
        window.gameState.selectedUnits.forEach(unit => {
            if (unit.isMoving && unit.targetX && unit.targetY) {
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.beginPath();
                ctx.moveTo(unit.x, unit.y);
                ctx.lineTo(unit.targetX, unit.targetY);
                ctx.stroke();
                ctx.setLineDash([]);
                
                // Target marker
                ctx.fillStyle = '#00ff88';
                ctx.beginPath();
                ctx.arc(unit.targetX, unit.targetY, 5, 0, Math.PI * 2);
                ctx.fill();
            }
        });
    }

    // Update all units with AI and movement
    updateUnits(deltaTime) {
        if (!window.gameState?.units || !this.systems.units) return;
        
        window.gameState.units.forEach(unit => {
            // Update unit movement
            this.systems.units.updateUnit(unit, deltaTime);
            
            // Update AI for enemy units
            if (unit.team === window.TEAMS?.AI) {
                this.systems.units.updateAI(unit);
            }
        });
    }

    // Manage population and spawning
    managePopulation() {
        const now = Date.now();
        if (now - this.lastSpawnCheck < this.spawnCheckInterval) return;
        
        this.lastSpawnCheck = now;
        
        if (!window.gameState?.bases || !this.systems.units) return;
        
        window.gameState.bases.forEach(base => {
            // Check if can spawn and enough time has passed
            if (window.gameState.canSpawnUnit(base.animal, base.team) &&
                now - base.lastSpawn > base.spawnInterval) {
                
                const unit = this.systems.units.spawnUnit(base);
                if (unit) {
                    base.lastSpawn = now;
                }
            }
        });
    }

    // Update performance metrics
    updatePerformanceMetrics(deltaTime, currentTime) {
        this.frameCount++;
        this.performance.frameTime = deltaTime;
        
        // Update FPS counter
        if (currentTime - this.lastFPSUpdate >= 1000) {
            this.performance.fps = this.frameCount;
            this.frameCount = 0;
            this.lastFPSUpdate = currentTime;
            
            // Update memory usage if available
            if (performance.memory) {
                this.performance.memoryUsage = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
            }
            
            // Update visible units count
            this.performance.visibleUnits = this.systems.units?.getPerformanceStats()?.visibleUnits || 0;
            
            // Log performance in debug mode
            if (window.PERFORMANCE_CONFIG?.enableDebugMode) {
                console.log(`🔍 FPS: ${this.performance.fps}, Memory: ${this.performance.memoryUsage}MB, Visible Units: ${this.performance.visibleUnits}`);
            }
        }
    }

    // Periodic cleanup to prevent memory leaks
    performPeriodicCleanup() {
        const now = Date.now();
        
        // Clean up every 30 seconds
        if (now % 30000 < 100) {
            if (window.gameState?.performCleanup) {
                window.gameState.performCleanup();
            }
            
            if (this.systems.units?.performCleanup) {
                this.systems.units.performCleanup();
            }
        }
    }

    // Stop the game loop
    stopGame() {
        this.isRunning = false;
        console.log('🛑 Game stopped');
    }

    // Pause/resume game
    pauseGame() {
        this.isRunning = false;
        console.log('⏸️ Game paused');
    }

    resumeGame() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.lastFrameTime = performance.now();
            this.gameLoop();
            console.log('▶️ Game resumed');
        }
    }

    // Get performance statistics
    getPerformanceStats() {
        return {
            ...this.performance,
            isRunning: this.isRunning,
            systemStatus: {
                ui: !!this.systems.ui,
                terrain: !!this.systems.terrain,
                units: !!this.systems.units,
                pathfinding: !!this.systems.pathfinding
            }
        };
    }

    // Handle window visibility change (pause when hidden)
    handleVisibilityChange() {
        if (document.hidden) {
            this.pauseGame();
        } else {
            this.resumeGame();
        }
    }

    // Cleanup and destroy
    destroy() {
        this.stopGame();
        
        // Clean up systems
        Object.values(this.systems).forEach(system => {
            if (system?.destroy) {
                system.destroy();
            }
        });
        
        // Reset state
        if (window.gameState) {
            window.gameState.reset();
        }
        
        console.log('🧹 Game engine destroyed');
    }
}

// Setup visibility change handling
document.addEventListener('visibilitychange', () => {
    if (window.gameEngine) {
        window.gameEngine.handleVisibilityChange();
    }
});

// Create global game engine instance
window.gameEngine = null;

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    GameEngine.initialize();
});

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GameEngine };
} 