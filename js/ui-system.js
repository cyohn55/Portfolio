/**
 * UI System - User Interface & Event Management
 * Optimized event handling, DOM caching, and responsive design
 */

class UISystem {
    constructor() {
        // Cache DOM elements to avoid repeated queries
        this.elements = {};
        this.eventListeners = new Map();
        this.isInitialized = false;
        
        // Touch/mobile support
        this.isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        this.lastTouchTime = 0;
        
        // Selection state
        this.selectionBox = {
            element: null,
            isActive: false,
            startX: 0,
            startY: 0
        };
        
        // Performance optimization: Throttle UI updates
        this.lastUIUpdate = 0;
        this.UI_UPDATE_INTERVAL = 100; // 10 FPS for UI updates
    }

    // Initialize UI system
    initialize() {
        if (this.isInitialized) return;
        
        console.log('🎮 Initializing UI System...');
        
        this.cacheElements();
        this.setupEventListeners();
        this.setupTitleScreen();
        this.setupGameUI();
        
        // Apply mobile optimizations
        if (this.isMobile) {
            this.applyMobileOptimizations();
        }
        
        // Hide loading indicator and show title screen
        if (this.elements.loadingIndicator) {
            this.elements.loadingIndicator.style.display = 'none';
        }
        
        if (this.elements.titleScreen) {
            this.elements.titleScreen.style.display = 'flex';
        }
        
        this.isInitialized = true;
        console.log('✅ UI System initialized');
    }

    // Cache DOM elements for performance
    cacheElements() {
        const elementIds = [
            'titleScreen', 'gameScreen', 'loadingIndicator',
            'animalSelection', 'startBtn', 'gameCanvas',
            'resourcePanel', 'population', 'selectedCount',
            'controlPanel', 'miniMap', 'miniMapCanvas', 'selectionBox'
        ];
        
        elementIds.forEach(id => {
            this.elements[id] = document.getElementById(id);
        });
        
        // Additional elements
        this.elements.modelsContainer = document.getElementById('modelsContainer');
        this.elements.hexGrid = document.getElementById('hex-grid');
    }

    // Setup optimized event listeners
    setupEventListeners() {
        // Use event delegation for better performance
        document.addEventListener('click', this.handleGlobalClick.bind(this));
        document.addEventListener('contextmenu', this.handleContextMenu.bind(this));
        
        // Canvas events (mouse and touch)
        if (this.elements.gameCanvas) {
            this.setupCanvasEvents();
        }
        
        // Window events
        window.addEventListener('resize', this.handleResize.bind(this));
        
        // Keyboard events
        document.addEventListener('keydown', this.handleKeyDown.bind(this));
    }

    // Setup canvas-specific events with mobile support
    setupCanvasEvents() {
        const canvas = this.elements.gameCanvas;
        
        // Mouse events
        canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        
        // Touch events for mobile
        canvas.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
        canvas.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });
        canvas.addEventListener('touchend', this.handleTouchEnd.bind(this), { passive: false });
        
        // Prevent default touch behaviors
        canvas.addEventListener('touchstart', e => e.preventDefault());
        canvas.addEventListener('touchmove', e => e.preventDefault());
    }

    // Setup title screen with dynamic animal cards
    setupTitleScreen() {
        if (!this.elements.animalSelection) return;
        
        // Check if animal cards already exist in HTML
        const existingCards = this.elements.animalSelection.querySelectorAll('.animal-card');
        
        if (existingCards.length === 0) {
            // Create animal cards dynamically if none exist
            Object.entries(window.ANIMAL_CONFIGS || {}).forEach(([animal, config]) => {
                const card = this.createAnimalCard(animal, config);
                this.elements.animalSelection.appendChild(card);
            });
        } else {
            console.log('✅ Using existing animal cards from HTML');
        }
        
        this.updateStartButton();
    }

    // Create individual animal selection card
    createAnimalCard(animal, config) {
        const card = document.createElement('div');
        card.className = 'animal-card';
        card.dataset.animal = animal;
        
        const capitalizedName = animal.charAt(0).toUpperCase() + animal.slice(1);
        
        card.innerHTML = `
            <h3>${config.emoji} ${capitalizedName}</h3>
            <p>Speed: ${config.speed} | Size: ${config.size}</p>
            <small>${this.getAnimalDescription(animal)}</small>
        `;
        
        return card;
    }

    // Get animal description for UI
    getAnimalDescription(animal) {
        const descriptions = {
            bear: 'Strong & Durable',
            bee: 'Fast & Agile',
            turtle: 'Defensive',
            fox: 'Cunning & Quick',
            frog: 'Amphibious',
            owl: 'Air Support',
            pig: 'Resource Gatherer',
            cat: 'Stealth Hunter',
            chicken: 'Rapid Breeder',
            dolphin: 'Naval Unit'
        };
        
        return descriptions[animal] || 'Unique Unit';
    }

    // Setup game UI elements
    setupGameUI() {
        // Initialize selection box
        if (this.elements.selectionBox) {
            this.selectionBox.element = this.elements.selectionBox;
        }
        
        // Setup mini-map
        this.setupMiniMap();
    }

    // Setup mini-map functionality
    setupMiniMap() {
        if (!this.elements.miniMapCanvas) return;
        
        const canvas = this.elements.miniMapCanvas;
        canvas.addEventListener('click', this.handleMiniMapClick.bind(this));
        
        // Set canvas size
        canvas.width = 200;
        canvas.height = 150;
    }

    // Handle global click events with delegation
    handleGlobalClick(event) {
        const target = event.target;
        
        // Animal card selection
        if (target.closest('.animal-card')) {
            this.handleAnimalSelection(target.closest('.animal-card'));
        }
        
        // Start button
        if (target.id === 'startBtn' || target.closest('#startBtn')) {
            this.handleStartGame();
        }
        
        // Animal control buttons
        if (target.classList.contains('animal-btn')) {
            this.handleAnimalButton(target);
        }
    }

    // Handle animal card selection
    handleAnimalSelection(card) {
        const animal = card.dataset.animal;
        if (!animal || !window.gameState) return;
        
        const selectedAnimals = window.gameState.selectedAnimals;
        
        if (card.classList.contains('selected')) {
            // Deselect
            card.classList.remove('selected');
            const index = selectedAnimals.indexOf(animal);
            if (index > -1) {
                selectedAnimals.splice(index, 1);
            }
        } else if (selectedAnimals.length < 3) {
            // Select
            card.classList.add('selected');
            selectedAnimals.push(animal);
        }
        
        this.updateStartButton();
        this.animateCard(card);
    }

    // Animate card selection
    animateCard(card) {
        card.style.transform = 'scale(0.95)';
        setTimeout(() => {
            card.style.transform = '';
        }, 150);
    }

    // Update start button state
    updateStartButton() {
        if (!this.elements.startBtn || !window.gameState) return;
        
        const selectedCount = window.gameState.selectedAnimals.length;
        
        if (selectedCount === 3) {
            this.elements.startBtn.classList.add('enabled');
            this.elements.startBtn.textContent = 'Start Game!';
        } else {
            this.elements.startBtn.classList.remove('enabled');
            this.elements.startBtn.textContent = `Select ${3 - selectedCount} more animals`;
        }
    }

    // Handle game start
    handleStartGame() {
        if (!window.gameState || window.gameState.selectedAnimals.length !== 3) return;
        
        this.showLoadingScreen();
        
        // Transition to game screen
        setTimeout(() => {
            this.transitionToGame();
        }, 500);
    }

    // Show loading screen
    showLoadingScreen() {
        if (this.elements.loadingIndicator) {
            this.elements.loadingIndicator.style.display = 'block';
        }
    }

    // Hide loading screen
    hideLoadingScreen() {
        if (this.elements.loadingIndicator) {
            this.elements.loadingIndicator.style.display = 'none';
        }
    }

    // Transition from title to game screen
    transitionToGame() {
        if (this.elements.titleScreen) {
            this.elements.titleScreen.style.display = 'none';
        }
        
        if (this.elements.gameScreen) {
            this.elements.gameScreen.style.display = 'block';
        }
        
        this.hideLoadingScreen();
        
        // Initialize game
        if (window.gameEngine) {
            window.gameEngine.startGame();
        }
        
        console.log('🎮 Transitioned to game screen');
    }

    // Handle mouse events for unit selection and movement
    handleMouseDown(event) {
        if (event.button === 0) { // Left click
            this.startSelection(event);
        } else if (event.button === 2) { // Right click
            this.handleMovement(event);
        }
    }

    handleMouseMove(event) {
        if (window.gameState?.selection?.isSelecting) {
            this.updateSelection(event);
        }
    }

    handleMouseUp(event) {
        if (window.gameState?.selection?.isSelecting) {
            this.finishSelection(event);
        }
    }

    // Handle touch events for mobile
    handleTouchStart(event) {
        event.preventDefault();
        
        const now = Date.now();
        const timeSinceLastTouch = now - this.lastTouchTime;
        
        if (timeSinceLastTouch < 300) {
            // Double tap - treat as right click (movement)
            this.handleMovement(event.touches[0]);
        } else {
            // Single tap - start selection
            this.startSelection(event.touches[0]);
        }
        
        this.lastTouchTime = now;
    }

    handleTouchMove(event) {
        event.preventDefault();
        if (window.gameState?.selection?.isSelecting && event.touches.length === 1) {
            this.updateSelection(event.touches[0]);
        }
    }

    handleTouchEnd(event) {
        event.preventDefault();
        if (window.gameState?.selection?.isSelecting) {
            this.finishSelection(event.changedTouches[0]);
        }
    }

    // Start unit selection
    startSelection(eventOrTouch) {
        if (!this.elements.gameCanvas || !window.gameState) return;
        
        const rect = this.elements.gameCanvas.getBoundingClientRect();
        const x = (eventOrTouch.clientX || eventOrTouch.pageX) - rect.left + window.gameState.camera.x;
        const y = (eventOrTouch.clientY || eventOrTouch.pageY) - rect.top + window.gameState.camera.y;
        
        // Check if clicking on a unit first
        const clickedUnit = this.findUnitAt(x, y);
        
        if (clickedUnit) {
            // Single unit selection
            window.gameState.selectedUnits = [clickedUnit];
            this.updateSelectionUI();
        } else {
            // Start box selection
            window.gameState.startSelection(x, y);
        }
    }

    // Update selection box
    updateSelection(eventOrTouch) {
        if (!this.elements.gameCanvas || !window.gameState?.selection?.isSelecting) return;
        
        const rect = this.elements.gameCanvas.getBoundingClientRect();
        const x = (eventOrTouch.clientX || eventOrTouch.pageX) - rect.left + window.gameState.camera.x;
        const y = (eventOrTouch.clientY || eventOrTouch.pageY) - rect.top + window.gameState.camera.y;
        
        window.gameState.updateSelection(x, y);
        this.renderSelectionBox();
    }

    // Finish selection
    finishSelection(eventOrTouch) {
        if (!window.gameState?.selection?.isSelecting) return;
        
        window.gameState.finishSelection();
        this.hideSelectionBox();
        this.updateSelectionUI();
    }

    // Handle unit movement commands
    handleMovement(eventOrTouch) {
        if (!this.elements.gameCanvas || !window.gameState?.selectedUnits?.length) return;
        
        const rect = this.elements.gameCanvas.getBoundingClientRect();
        const x = (eventOrTouch.clientX || eventOrTouch.pageX) - rect.left + window.gameState.camera.x;
        const y = (eventOrTouch.clientY || eventOrTouch.pageY) - rect.top + window.gameState.camera.y;
        
        this.moveSelectedUnits(x, y);
    }

    // Move selected units to target position
    moveSelectedUnits(x, y) {
        const selectedUnits = window.gameState.selectedUnits;
        if (!selectedUnits.length) return;
        
        console.log(`🎯 Moving ${selectedUnits.length} units to (${Math.round(x)}, ${Math.round(y)})`);
        
        // Create formation around target point
        const formationRadius = Math.sqrt(selectedUnits.length) * 20;
        
        selectedUnits.forEach((unit, index) => {
            const angle = (index / selectedUnits.length) * Math.PI * 2;
            const offsetX = Math.cos(angle) * formationRadius;
            const offsetY = Math.sin(angle) * formationRadius;
            
            const targetX = x + offsetX;
            const targetY = y + offsetY;
            
            // Use pathfinding system
            if (window.pathfinding) {
                window.pathfinding.findUnitPath(unit, targetX, targetY);
            }
        });
    }

    // Find unit at screen position
    findUnitAt(x, y) {
        if (!window.gameState?.units) return null;
        
        return window.gameState.units.find(unit => {
            const dx = unit.x - x;
            const dy = unit.y - y;
            return Math.sqrt(dx * dx + dy * dy) < unit.size;
        });
    }

    // Render selection box
    renderSelectionBox() {
        if (!this.selectionBox.element || !window.gameState?.selection) return;
        
        const selection = window.gameState.selection;
        const camera = window.gameState.camera;
        
        const startX = Math.min(selection.start.x - camera.x, selection.end.x - camera.x);
        const startY = Math.min(selection.start.y - camera.y, selection.end.y - camera.y);
        const width = Math.abs(selection.end.x - selection.start.x);
        const height = Math.abs(selection.end.y - selection.start.y);
        
        this.selectionBox.element.style.left = startX + 'px';
        this.selectionBox.element.style.top = startY + 'px';
        this.selectionBox.element.style.width = width + 'px';
        this.selectionBox.element.style.height = height + 'px';
        this.selectionBox.element.style.display = 'block';
    }

    // Hide selection box
    hideSelectionBox() {
        if (this.selectionBox.element) {
            this.selectionBox.element.style.display = 'none';
        }
    }

    // Update UI elements (throttled for performance)
    updateUI() {
        const now = Date.now();
        if (now - this.lastUIUpdate < this.UI_UPDATE_INTERVAL) return;
        
        this.lastUIUpdate = now;
        
        this.updateResourcePanel();
        this.updateControlPanel();
        this.updateSelectionUI();
        this.renderMiniMap();
    }

    // Update resource panel
    updateResourcePanel() {
        if (!window.gameState) return;
        
        if (this.elements.population) {
            this.elements.population.textContent = window.gameState.population.total;
        }
        
        if (this.elements.selectedCount) {
            this.elements.selectedCount.textContent = window.gameState.selectedUnits.length;
        }
    }

    // Update control panel with animal buttons
    updateControlPanel() {
        if (!this.elements.controlPanel || !window.gameState?.selectedAnimals) return;
        
        // Only create buttons once
        if (this.elements.controlPanel.children.length === 0) {
            window.gameState.selectedAnimals.forEach(animal => {
                const btn = this.createAnimalButton(animal);
                this.elements.controlPanel.appendChild(btn);
            });
        }
    }

    // Create animal control button
    createAnimalButton(animal) {
        const config = window.ANIMAL_CONFIGS?.[animal];
        if (!config) return null;
        
        const btn = document.createElement('button');
        btn.className = 'animal-btn';
        btn.dataset.animal = animal;
        btn.textContent = `Select All ${config.emoji}`;
        
        return btn;
    }

    // Handle animal button clicks
    handleAnimalButton(button) {
        const animal = button.dataset.animal;
        if (!animal || !window.gameState) return;
        
        // Select all units of this type
        window.gameState.selectedUnits = window.gameState.units.filter(
            unit => unit.animal === animal && unit.team === window.TEAMS?.PLAYER
        );
        
        this.updateSelectionUI();
        
        // Visual feedback
        document.querySelectorAll('.animal-btn').forEach(btn => 
            btn.classList.remove('active'));
        button.classList.add('active');
    }

    // Update selection visual feedback
    updateSelectionUI() {
        if (window.unitSystem) {
            window.unitSystem.updateSelectionVisuals();
        }
    }

    // Render mini-map
    renderMiniMap() {
        if (!this.elements.miniMapCanvas || !window.gameState) return;
        
        const canvas = this.elements.miniMapCanvas;
        const ctx = canvas.getContext('2d');
        
        // Clear mini-map
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const mapSize = window.gameState.map;
        const scaleX = canvas.width / mapSize.width;
        const scaleY = canvas.height / mapSize.height;
        
        // Draw units
        window.gameState.units.forEach(unit => {
            ctx.fillStyle = window.gameState.selectedUnits.includes(unit) ? '#00ff88' : '#ffffff';
            ctx.fillRect(
                unit.x * scaleX - 1,
                unit.y * scaleY - 1,
                2, 2
            );
        });
        
        // Draw camera view
        const camera = window.gameState.camera;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.strokeRect(
            camera.x * scaleX,
            camera.y * scaleY,
            window.innerWidth * scaleX,
            window.innerHeight * scaleY
        );
    }

    // Handle mini-map click for camera movement
    handleMiniMapClick(event) {
        if (!window.gameState) return;
        
        const rect = event.target.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        const mapSize = window.gameState.map;
        const scaleX = mapSize.width / rect.width;
        const scaleY = mapSize.height / rect.height;
        
        window.gameState.camera.x = x * scaleX - window.innerWidth / 2;
        window.gameState.camera.y = y * scaleY - window.innerHeight / 2;
        
        // Clamp camera to bounds
        window.gameState.updateCamera(0, 0);
    }

    // Handle window resize
    handleResize() {
        if (this.elements.gameCanvas) {
            this.elements.gameCanvas.width = window.innerWidth;
            this.elements.gameCanvas.height = window.innerHeight;
        }
        
        // Update unit positions
        if (window.unitSystem) {
            window.unitSystem.updateUnitPositions();
        }
    }

    // Handle keyboard shortcuts
    handleKeyDown(event) {
        if (!window.gameState?.gameStarted) return;
        
        switch (event.key) {
            case 'Escape':
                // Clear selection
                window.gameState.selectedUnits = [];
                this.updateSelectionUI();
                break;
                
            case 'a':
            case 'A':
                if (event.ctrlKey || event.metaKey) {
                    // Select all player units
                    event.preventDefault();
                    window.gameState.selectedUnits = window.gameState.units.filter(
                        unit => unit.team === window.TEAMS?.PLAYER
                    );
                    this.updateSelectionUI();
                }
                break;
        }
    }

    // Handle right-click context menu
    handleContextMenu(event) {
        if (event.target === this.elements.gameCanvas) {
            event.preventDefault();
        }
    }

    // Apply mobile-specific optimizations
    applyMobileOptimizations() {
        console.log('📱 Applying mobile optimizations');
        
        // Increase touch targets
        document.querySelectorAll('.animal-card, .animal-btn, .start-btn').forEach(element => {
            element.style.minHeight = '44px';
            element.style.minWidth = '44px';
        });
        
        // Reduce performance settings
        if (window.PERFORMANCE_CONFIG) {
            window.PERFORMANCE_CONFIG.maxVisibleUnits = 100;
            window.PERFORMANCE_CONFIG.targetFPS = 30;
        }
        
        // Add mobile class for CSS
        document.body.classList.add('mobile');
    }

    // Cleanup resources
    destroy() {
        // Remove event listeners
        this.eventListeners.forEach((listener, element) => {
            element.removeEventListener(...listener);
        });
        
        this.eventListeners.clear();
        this.elements = {};
        this.isInitialized = false;
    }
}

// Create global UI system instance
window.uiSystem = new UISystem();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UISystem };
} 