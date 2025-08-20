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
            
            // Generate terrain - simple approach
            console.log('🌍 Generating terrain...');
            this.generateSimpleTerrain();
            
            // Create bases for selected animals
            this.createPlayerBases();
            this.createEnemyBases();
        }
        
        // Start the game loop
        this.startGameLoop();
        
        console.log('✅ Game started successfully');
        return true;
    }

    // Create player bases with Kings and Queens
    createPlayerBases() {
        if (!window.gameState?.selectedAnimals) return;
        
        console.log('🏰 Creating player bases with Kings and Queens...');
        
        window.gameState.selectedAnimals.forEach((animal, index) => {
            const baseX = 150 + (index * 200);
            const baseY = 150;
            
            // Create base structure
            const base = {
                animal: animal,
                team: window.TEAMS?.PLAYER || 'player',
                x: baseX,
                y: baseY,
                lastSpawn: 0,
                spawnInterval: window.GAME_SETTINGS?.population?.spawnInterval || 8000,
                size: 60
            };
            
            window.gameState.bases.push(base);
            
            // Create visual base representation
            this.createBaseModel(base, index);
            
            // Spawn King (3x larger) immediately
            this.spawnKing(animal, baseX - 80, baseY - 80);
            
            // Spawn Queen (2x larger) immediately  
            this.spawnQueen(animal, baseX + 80, baseY - 80);
            
            // Spawn some initial regular units
            for (let i = 0; i < 3; i++) {
                setTimeout(() => {
                    this.spawnRegularUnit(base);
                }, i * 1000); // Stagger the spawning
            }
            
            console.log(`👑 Created player base with King and Queen: ${animal}`);
        });
    }

    // Create enemy bases with Kings and Queens
    createEnemyBases() {
        if (!window.gameState?.selectedAnimals) return;
        
        console.log('🏰 Creating enemy bases with Kings and Queens...');
        
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
            const baseX = window.innerWidth - (150 + (index * 200));
            const baseY = window.innerHeight - 200;
            
            const base = {
                animal: animal,
                team: window.TEAMS?.AI || 'enemy',
                x: baseX,
                y: baseY,
                lastSpawn: 0,
                spawnInterval: window.GAME_SETTINGS?.population?.spawnInterval || 8000,
                size: 60
            };
            
            window.gameState.bases.push(base);
            
            // Create visual base representation
            this.createBaseModel(base, index + 3); // Offset index for enemy bases
            
            // Spawn King (3x larger) immediately
            this.spawnKing(animal, baseX - 80, baseY + 80, 'enemy');
            
            // Spawn Queen (2x larger) immediately
            this.spawnQueen(animal, baseX + 80, baseY + 80, 'enemy');
            
            // Spawn some initial regular units
            for (let i = 0; i < 3; i++) {
                setTimeout(() => {
                    this.spawnRegularUnit(base);
                }, (i + 3) * 1000); // Stagger the spawning, offset from player
            }
            
            console.log(`👑 Created enemy base with King and Queen: ${animal}`);
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
        
        if (!window.gameState?.bases) return;
        
        window.gameState.bases.forEach(base => {
            // Check if can spawn and enough time has passed
            if (window.gameState.canSpawnUnit(base.animal, base.team) &&
                now - base.lastSpawn > base.spawnInterval) {
                
                // Use our own spawn method instead of unit system
                const unit = this.spawnRegularUnit(base);
                if (unit) {
                    base.lastSpawn = now;
                    console.log(`⏰ Spawned unit from ${base.team} ${base.animal} base`);
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

    // Generate Red Blob Games compliant hex terrain
    generateSimpleTerrain() {
        const hexContainer = document.getElementById('hex-grid');
        if (!hexContainer) {
            console.error('❌ Hex container not found for terrain generation');
            return false;
        }

        console.log('🎨 Generating Red Blob Games compliant hex terrain...');
        hexContainer.innerHTML = '';

        const terrainTypes = [
            { type: 'farmland', color: '#90EE90', emoji: '🌾', model: 'models/FarmLand.glb' },
            { type: 'forest', color: '#228B22', emoji: '🌲', model: 'models/Forest.glb' },
            { type: 'mountain', color: '#696969', emoji: '🏔️', model: 'models/Mountain.glb' },
            { type: 'hill', color: '#8FBC8F', emoji: '🏞️', model: 'models/Hill.glb' },
            { type: 'pinetree', color: '#006400', emoji: '🌲', model: 'models/PineTree.glb' }
        ];

        // Red Blob Games compliant hex grid parameters
        const hexSize = 60; // Radius of hexagon (1.5x original size)
        const layout = 'flat'; // flat-top hexagons (as per current clip-path)
        const mapRadius = 4; // Creates a roughly 8x8 hex map
        let tilesCreated = 0;

        // Generate hexagonal map using Red Blob Games axial coordinates
        if (window.HexCoord && window.HexMath) {
            console.log('✅ Using Red Blob Games hex coordinate system');
            
            // Generate hex positions using axial coordinates
            const centerCoord = new window.HexCoord(0, 0);
            const hexPositions = window.HexMath.hexRange(centerCoord, mapRadius);
            
            console.log(`🔧 Creating ${hexPositions.length} hex tiles using axial coordinates`);
            
            hexPositions.forEach(hexCoord => {
                const terrain = terrainTypes[Math.floor(Math.random() * terrainTypes.length)];
                
                // Convert hex coordinates to pixel coordinates using Red Blob Games formula
                const pixelPos = window.HexMath.hexToPixel(hexCoord, hexSize, layout);
                
                // Center the grid in the container
                const centerX = 400;
                const centerY = 300;
                
                // Create tile container (proper hex proportions)
                const tileContainer = document.createElement('div');
                tileContainer.className = `tile-3d-container ${terrain.type}`;
                const containerSize = hexSize * 2.2; // Slightly larger than hex for padding
                tileContainer.style.cssText = `
                    position: absolute;
                    width: ${containerSize}px;
                    height: ${containerSize}px;
                    left: ${centerX + pixelPos.x - (containerSize / 2)}px;
                    top: ${centerY + pixelPos.y - (containerSize / 2)}px;
                    transform-style: preserve-3d;
                `;
                
                // Try to create model-viewer, fallback to colored hex
                if (window.customElements && window.customElements.get('model-viewer')) {
                    const modelViewer = document.createElement('model-viewer');
                    modelViewer.className = `hex-tile ${terrain.type}`;
                    modelViewer.setAttribute('src', terrain.model);
                    modelViewer.setAttribute('alt', `${terrain.type} tile`);
                    modelViewer.setAttribute('interaction-prompt', 'none');
                    modelViewer.setAttribute('disable-zoom', 'true');
                    modelViewer.setAttribute('disable-pan', 'true');
                    modelViewer.setAttribute('disable-tap', 'true');
                    modelViewer.setAttribute('auto-rotate', 'false');
                    modelViewer.setAttribute('camera-orbit', '0deg 0deg 75m');
                    modelViewer.setAttribute('field-of-view', '45deg');
                    modelViewer.setAttribute('touch-action', 'none');
                    modelViewer.removeAttribute('camera-controls');
                    modelViewer.style.cssText = `
                        width: 100%;
                        height: 100%;
                        background: transparent;
                        pointer-events: none;
                        touch-action: none;
                        user-select: none;
                    `;
                    tileContainer.appendChild(modelViewer);
                } else {
                    // Fallback to simple colored hex
                    const hexTile = document.createElement('div');
                    hexTile.style.cssText = `
                        width: 80px;
                        height: 70px;
                        background: ${terrain.color};
                        border: 2px solid #fff;
                        clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 20px;
                        color: white;
                        text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
                        margin: 5px;
                    `;
                    hexTile.textContent = terrain.emoji;
                    tileContainer.appendChild(hexTile);
                }
                
                // Store hex coordinates for gameplay
                tileContainer.dataset.terrainType = terrain.type;
                tileContainer.dataset.hexQ = hexCoord.q;
                tileContainer.dataset.hexR = hexCoord.r;
                tileContainer.title = `${terrain.type} at axial(${hexCoord.q}, ${hexCoord.r})`;
                
                hexContainer.appendChild(tileContainer);
                tilesCreated++;
            });
        } else {
            // Fallback to offset coordinates if hex system not available
            console.warn('⚠️ Red Blob Games hex system not available, using fallback offset coordinates');
            
            for (let row = 0; row < 6; row++) {
                for (let col = 0; col < 8; col++) {
                    const terrain = terrainTypes[Math.floor(Math.random() * terrainTypes.length)];
                    
                    // Create tile container with offset coordinates (1.5x size)
                    const tileContainer = document.createElement('div');
                    tileContainer.className = `tile-3d-container ${terrain.type}`;
                    const fallbackSize = 120; // Reduced by 25% from 160
                    tileContainer.style.cssText = `
                        position: absolute;
                        width: ${fallbackSize}px;
                        height: ${fallbackSize}px;
                        left: ${col * (fallbackSize * 0.75) + (row % 2) * (fallbackSize * 0.375)}px;
                        top: ${row * (fallbackSize * 0.866)}px;
                        transform-style: preserve-3d;
                    `;
                    
                    // Try to create model-viewer, fallback to colored hex
                    if (window.customElements && window.customElements.get('model-viewer')) {
                        const modelViewer = document.createElement('model-viewer');
                        modelViewer.className = `hex-tile ${terrain.type}`;
                        modelViewer.setAttribute('src', terrain.model);
                        modelViewer.setAttribute('alt', `${terrain.type} tile`);
                        modelViewer.setAttribute('interaction-prompt', 'none');
                        modelViewer.setAttribute('disable-zoom', 'true');
                        modelViewer.setAttribute('disable-pan', 'true');
                        modelViewer.setAttribute('disable-tap', 'true');
                        modelViewer.setAttribute('auto-rotate', 'false');
                        modelViewer.setAttribute('camera-orbit', '0deg 0deg 75m');
                        modelViewer.setAttribute('field-of-view', '45deg');
                        modelViewer.setAttribute('touch-action', 'none');
                        modelViewer.removeAttribute('camera-controls');
                        modelViewer.style.cssText = `
                            width: 100%;
                            height: 100%;
                            background: transparent;
                            pointer-events: none;
                            touch-action: none;
                            user-select: none;
                        `;
                        tileContainer.appendChild(modelViewer);
                    } else {
                        // Fallback to simple colored hex
                        const hexTile = document.createElement('div');
                        hexTile.style.cssText = `
                            width: 70px;
                            height: 60px;
                            background: ${terrain.color};
                            border: 2px solid #fff;
                            clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 16px;
                            color: white;
                            text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
                            margin: 5px;
                        `;
                        hexTile.textContent = terrain.emoji;
                        tileContainer.appendChild(hexTile);
                    }
                    
                    tileContainer.dataset.terrainType = terrain.type;
                    tileContainer.dataset.hexX = col;
                    tileContainer.dataset.hexY = row;
                    tileContainer.title = `${terrain.type} at offset(${col}, ${row})`;
                    
                    hexContainer.appendChild(tileContainer);
                    tilesCreated++;
                }
            }
        }

        // Ensure container visibility
        hexContainer.style.display = 'block';
        hexContainer.style.visibility = 'visible';
        hexContainer.style.opacity = '1';
        hexContainer.style.zIndex = '3';

        console.log(`✅ Generated ${tilesCreated} terrain tiles`);
        return true;
    }

    // Create visual base model
    createBaseModel(base, index) {
        const modelsContainer = document.getElementById('modelsContainer');
        if (!modelsContainer) return;

        // Create base structure using model-viewer
        const baseModel = document.createElement('model-viewer');
        baseModel.className = `base-model ${base.team}`;
        baseModel.setAttribute('src', `models/${base.animal}.glb`);
        baseModel.setAttribute('alt', `${base.animal} base`);
        baseModel.setAttribute('interaction-prompt', 'none');
        baseModel.setAttribute('disable-zoom', 'true');
        baseModel.setAttribute('disable-pan', 'true');
        baseModel.setAttribute('disable-tap', 'true');
        baseModel.setAttribute('auto-rotate', 'false');
        baseModel.setAttribute('camera-orbit', '0deg 0deg 132m');
        baseModel.setAttribute('field-of-view', '45deg');
        baseModel.setAttribute('touch-action', 'none');
        baseModel.removeAttribute('camera-controls');
        
        baseModel.style.cssText = `
            position: absolute;
            width: ${base.size}px;
            height: ${base.size}px;
            left: ${base.x - base.size/2}px;
            top: ${base.y - base.size/2}px;
            border: 3px solid ${base.team === 'player' ? '#00ff88' : '#ff4444'};
            border-radius: 50%;
            background: rgba(${base.team === 'player' ? '0,255,136' : '255,68,68'}, 0.2);
            z-index: 4;
            pointer-events: none;
            touch-action: none;
            user-select: none;
        `;
        
        baseModel.dataset.baseId = index;
        baseModel.dataset.team = base.team;
        baseModel.dataset.animal = base.animal;
        baseModel.title = `${base.team} ${base.animal} base`;
        
        modelsContainer.appendChild(baseModel);
        console.log(`🏗️ Created visual base model for ${base.team} ${base.animal}`);
    }

    // Spawn King (3x larger)
    spawnKing(animal, x, y, team = 'player') {
        const modelsContainer = document.getElementById('modelsContainer');
        if (!modelsContainer) return;

        const animalConfig = window.ANIMAL_CONFIGS?.[animal] || { size: 30, model: `models/${animal}.glb` };
        const kingSize = animalConfig.size * 3; // 3x larger

        const kingModel = document.createElement('model-viewer');
        kingModel.className = `king-model ${team} ${animal}`;
        kingModel.setAttribute('src', animalConfig.model);
        kingModel.setAttribute('alt', `King ${animal}`);
        kingModel.setAttribute('interaction-prompt', 'none');
        kingModel.setAttribute('disable-zoom', 'true');
        kingModel.setAttribute('disable-pan', 'true');
        kingModel.setAttribute('disable-tap', 'true');
        kingModel.setAttribute('auto-rotate', 'false');
        kingModel.setAttribute('camera-orbit', '0deg 0deg 176m');
        kingModel.setAttribute('field-of-view', '45deg');
        kingModel.setAttribute('touch-action', 'none');
        kingModel.removeAttribute('camera-controls');
        
        kingModel.style.cssText = `
            position: absolute;
            width: ${kingSize}px;
            height: ${kingSize}px;
            left: ${x - kingSize/2}px;
            top: ${y - kingSize/2}px;
            border: 4px solid gold;
            border-radius: 50%;
            background: linear-gradient(45deg, rgba(255,215,0,0.3), rgba(255,140,0,0.3));
            box-shadow: 0 0 20px rgba(255,215,0,0.6);
            z-index: 6;
            filter: drop-shadow(0 0 10px gold);
            pointer-events: auto;
            touch-action: none;
            user-select: none;
        `;
        
        kingModel.dataset.unitType = 'king';
        kingModel.dataset.team = team;
        kingModel.dataset.animal = animal;
        kingModel.dataset.size = kingSize;
        kingModel.title = `👑 King ${animal} (${team})`;
        
        modelsContainer.appendChild(kingModel);
        console.log(`👑 Spawned King ${animal} for ${team} team`);
    }

    // Spawn Queen (2x larger)
    spawnQueen(animal, x, y, team = 'player') {
        const modelsContainer = document.getElementById('modelsContainer');
        if (!modelsContainer) return;

        const animalConfig = window.ANIMAL_CONFIGS?.[animal] || { size: 30, model: `models/${animal}.glb` };
        const queenSize = animalConfig.size * 2; // 2x larger

        const queenModel = document.createElement('model-viewer');
        queenModel.className = `queen-model ${team} ${animal}`;
        queenModel.setAttribute('src', animalConfig.model);
        queenModel.setAttribute('alt', `Queen ${animal}`);
        queenModel.setAttribute('interaction-prompt', 'none');
        queenModel.setAttribute('disable-zoom', 'true');
        queenModel.setAttribute('disable-pan', 'true');
        queenModel.setAttribute('disable-tap', 'true');
        queenModel.setAttribute('auto-rotate', 'false');
        queenModel.setAttribute('camera-orbit', '0deg 0deg 154m');
        queenModel.setAttribute('field-of-view', '45deg');
        queenModel.setAttribute('touch-action', 'none');
        queenModel.removeAttribute('camera-controls');
        
        queenModel.style.cssText = `
            position: absolute;
            width: ${queenSize}px;
            height: ${queenSize}px;
            left: ${x - queenSize/2}px;
            top: ${y - queenSize/2}px;
            border: 3px solid silver;
            border-radius: 50%;
            background: linear-gradient(45deg, rgba(192,192,192,0.3), rgba(255,255,255,0.3));
            box-shadow: 0 0 15px rgba(192,192,192,0.6);
            z-index: 5;
            filter: drop-shadow(0 0 8px silver);
            pointer-events: auto;
            touch-action: none;
            user-select: none;
        `;
        
        queenModel.dataset.unitType = 'queen';
        queenModel.dataset.team = team;
        queenModel.dataset.animal = animal;
        queenModel.dataset.size = queenSize;
        queenModel.title = `👸 Queen ${animal} (${team})`;
        
        modelsContainer.appendChild(queenModel);
        console.log(`👸 Spawned Queen ${animal} for ${team} team`);
    }

    // Spawn regular unit around base
    spawnRegularUnit(base) {
        const modelsContainer = document.getElementById('modelsContainer');
        if (!modelsContainer || !window.gameState?.canSpawnUnit(base.animal, base.team)) {
            return null;
        }

        const animalConfig = window.ANIMAL_CONFIGS?.[base.animal] || { size: 30, model: `models/${base.animal}.glb` };
        
        // Calculate spawn position around base
        const angle = Math.random() * Math.PI * 2;
        const distance = base.size + 40;
        const x = base.x + Math.cos(angle) * distance;
        const y = base.y + Math.sin(angle) * distance;

        const unitModel = document.createElement('model-viewer');
        unitModel.className = `unit-model ${base.team} ${base.animal}`;
        unitModel.setAttribute('src', animalConfig.model);
        unitModel.setAttribute('alt', `${base.animal} unit`);
        unitModel.setAttribute('interaction-prompt', 'none');
        unitModel.setAttribute('disable-zoom', 'true');
        unitModel.setAttribute('disable-pan', 'true');
        unitModel.setAttribute('disable-tap', 'true');
        unitModel.setAttribute('auto-rotate', 'false');
        unitModel.setAttribute('camera-orbit', '0deg 0deg 110m');
        unitModel.setAttribute('field-of-view', '45deg');
        unitModel.setAttribute('touch-action', 'none');
        unitModel.removeAttribute('camera-controls');
        
        unitModel.style.cssText = `
            position: absolute;
            width: ${animalConfig.size}px;
            height: ${animalConfig.size}px;
            left: ${x - animalConfig.size/2}px;
            top: ${y - animalConfig.size/2}px;
            border: 2px solid ${base.team === 'player' ? '#00ff88' : '#ff4444'};
            border-radius: 50%;
            background: rgba(${base.team === 'player' ? '0,255,136' : '255,68,68'}, 0.1);
            z-index: 3;
            transition: all 0.3s ease;
            cursor: pointer;
            touch-action: none;
            user-select: none;
        `;
        
        unitModel.dataset.unitType = 'regular';
        unitModel.dataset.team = base.team;
        unitModel.dataset.animal = base.animal;
        unitModel.dataset.size = animalConfig.size;
        unitModel.dataset.x = x;
        unitModel.dataset.y = y;
        unitModel.title = `${base.animal} unit (${base.team})`;
        
        // Add click handler for unit selection
        unitModel.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectUnit(unitModel);
        });
        
        modelsContainer.appendChild(unitModel);
        
        // Update game state
        if (window.gameState) {
            window.gameState.units.push({
                id: Date.now() + Math.random(),
                animal: base.animal,
                team: base.team,
                x: x,
                y: y,
                size: animalConfig.size,
                element: unitModel
            });
            
            // Update population count
            const teamUnits = window.gameState.units.filter(u => u.team === base.team);
            window.gameState.population[base.team] = teamUnits.length;
        }
        
        console.log(`🐾 Spawned regular ${base.animal} unit for ${base.team} team`);
        return unitModel;
    }

    // Select unit (basic implementation)
    selectUnit(unitElement) {
        // Clear previous selections
        document.querySelectorAll('.unit-model.selected').forEach(el => {
            el.classList.remove('selected');
            el.style.boxShadow = '';
        });
        
        // Select this unit
        unitElement.classList.add('selected');
        unitElement.style.boxShadow = '0 0 20px #00ff88';
        
        console.log(`📍 Selected ${unitElement.dataset.animal} unit`);
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