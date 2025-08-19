/**
 * Game Configuration
 * Central location for all game constants and settings
 */

// Animal configurations with 3D model paths
window.ANIMAL_CONFIGS = {
    bear: { speed: 1, size: 40, model: 'models/Bear.glb', baseStyle: 'cave', emoji: '🐻' },
    bee: { speed: 3, size: 20, model: 'models/Bee.glb', baseStyle: 'hive', emoji: '🐝' },
    turtle: { speed: 0.5, size: 35, model: 'models/Turtle.glb', baseStyle: 'pond', emoji: '🐢' },
    fox: { speed: 2.5, size: 25, model: 'models/Fox.glb', baseStyle: 'den', emoji: '🦊' },
    frog: { speed: 2, size: 22, model: 'models/Frog.glb', baseStyle: 'lily', emoji: '🐸' },
    owl: { speed: 2, size: 30, model: 'models/Owl.glb', baseStyle: 'tree', emoji: '🦉' },
    pig: { speed: 1.5, size: 28, model: 'models/Pig.glb', baseStyle: 'pen', emoji: '🐷' },
    cat: { speed: 2.2, size: 24, model: 'models/cat.glb', baseStyle: 'house', emoji: '🐱' },
    chicken: { speed: 1.8, size: 20, model: 'models/Chicken.glb', baseStyle: 'coop', emoji: '🐔' },
    dolphin: { speed: 2.5, size: 38, model: 'models/dolphin.glb', baseStyle: 'pool', emoji: '🐬' }
};

// Terrain configuration
window.TERRAIN_CONFIG = {
    models: [
        { file: 'models/Mountain.glb', alt: 'Mountain Tile', type: 'mountain' },
        { file: 'models/Forest.glb', alt: 'Forest Tile', type: 'forest' },
        { file: 'models/Hill.glb', alt: 'Hill Tile', type: 'hill' },
        { file: 'models/FarmLand.glb', alt: 'Farm Land Tile', type: 'farmland' }
    ],
    weights: {
        mountain: 0.15,   // Reduced from 0.25 for better gameplay
        forest: 0.40,     // Most common
        hill: 0.15,       // Reduced from 0.25 for better gameplay
        farmland: 0.30    // Increased for more traversable area
    },
    heights: {
        mountain: 120,
        hill: 80,
        forest: 40,
        farmland: 5
    }
};

// Game balance settings
window.GAME_SETTINGS = {
    population: {
        maxPerTeam: 99,
        maxPerAnimalType: 33,
        spawnInterval: 15000 // milliseconds
    },
    movement: {
        defaultSpeed: 1,
        speedMultiplier: 1,
        pathfindingThreshold: 10
    },
    grid: {
        defaultCols: 12,
        defaultRows: 16,
        tileWidth: 90,
        tileHeight: 120,
        hexOffset: 60
    },
    ui: {
        selectionThreshold: 5,
        cameraSpeed: 2,
        zoomSpeed: 0.1
    }
};

// Performance settings
window.PERFORMANCE_CONFIG = {
    enableProgressiveLoading: true,
    maxVisibleUnits: 200,
    cullingDistance: 1000,
    targetFPS: 60,
    enableDebugMode: false, // Set to true only for development
    modelViewerSettings: {
        fieldOfView: '15deg',
        cameraOrbit: '0deg 75deg 100m',
        autoRotate: false,
        disableZoom: true
    }
};

// Teams configuration
window.TEAMS = Object.freeze({
    PLAYER: 'player',
    AI: 'enemy'
});

// Flying animals (for collision detection)
window.FLYING_ANIMALS = ['owl', 'bee'];

// Export for module systems if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        ANIMAL_CONFIGS: window.ANIMAL_CONFIGS,
        TERRAIN_CONFIG: window.TERRAIN_CONFIG,
        GAME_SETTINGS: window.GAME_SETTINGS,
        PERFORMANCE_CONFIG: window.PERFORMANCE_CONFIG,
        TEAMS: window.TEAMS,
        FLYING_ANIMALS: window.FLYING_ANIMALS
    };
} 