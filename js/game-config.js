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

// Enhanced Terrain configuration with strategic properties
window.TERRAIN_CONFIG = {
    types: {
        FARMLAND: {
            model: 'models/FarmLand.glb',
            alt: 'Farm Land Tile',
            type: 'farmland',
            movement: { 
                ground: 1.0,    // Normal speed for ground units
                flying: 1.0     // Normal speed for flying units
            },
            height: 5,
            vision: { blocks: false, penalty: 0, bonus: 0 },
            buildable: true,
            resources: { food: 2, strategic_value: 'high' },
            defensive: false,
            concealment: false
        },
        HILL: {
            model: 'models/Hill.glb',
            alt: 'Hill Tile', 
            type: 'hill',
            movement: {
                ground: 0.7,    // 30% slower for ground units
                flying: 1.0     // Normal for flying units
            },
            height: 80,
            vision: { blocks: false, penalty: 0, bonus: 1.5 }, // 50% vision bonus
            buildable: true,
            resources: { strategic_value: 'medium', defensive_bonus: 0.3 },
            defensive: true,
            concealment: false
        },
        MOUNTAIN: {
            model: 'models/Mountain.glb',
            alt: 'Mountain Tile',
            type: 'mountain',
            movement: {
                ground: 0.0,    // Impassable for ground units  
                flying: 1.0     // Normal for flying units
            },
            height: 120,
            vision: { blocks: true, penalty: 0, bonus: 0 },
            buildable: false,
            resources: { strategic_value: 'fortress' },
            defensive: true,
            concealment: false
        },
        PINETREE: {
            model: 'models/PineTree.glb',
            alt: 'Pine Tree Tile',
            type: 'pinetree',
            movement: {
                ground: 0.8,    // 20% slower for ground units
                flying: 0.9     // 10% slower for flying units (branches)
            },
            height: 60,
            vision: { blocks: true, penalty: 0.3, bonus: 0 },
            buildable: false,
            resources: { wood: 1, strategic_value: 'medium' },
            defensive: false,
            concealment: true // Units can hide in forests
        },
        FOREST: {
            model: 'models/Forest.glb',
            alt: 'Forest Tile',
            type: 'forest',
            movement: {
                ground: 0.8,    // 20% slower for ground units
                flying: 0.9     // 10% slower for flying units
            },
            height: 40,
            vision: { blocks: true, penalty: 0.2, bonus: 0 },
            buildable: false,
            resources: { wood: 2, strategic_value: 'medium' },
            defensive: false,
            concealment: true
        }
    },
    
    // Terrain generation weights
    weights: {
        farmland: 0.25,   // Valuable resource areas
        hill: 0.15,       // Strategic high ground
        mountain: 0.10,   // Natural barriers
        pinetree: 0.20,   // Forest coverage
        forest: 0.30      // Primary forest coverage
    },
    
    // Strategic placement patterns
    patterns: {
        centralHighlands: {
            terrains: ['hill', 'mountain', 'hill'],
            purpose: 'control_point',
            weight: 0.15
        },
        farmingValleys: {
            terrains: ['farmland', 'farmland', 'hill'],
            purpose: 'resource_zone',
            weight: 0.25
        },
        mountainRanges: {
            terrains: ['mountain', 'pinetree', 'mountain'],
            purpose: 'natural_barrier',
            weight: 0.10
        },
        wilderness: {
            terrains: ['pinetree', 'forest', 'hill'],
            purpose: 'mixed_terrain',
            weight: 0.30
        },
        defensivePositions: {
            terrains: ['hill', 'forest', 'mountain'],
            purpose: 'tactical_advantage',
            weight: 0.20
        }
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

// Flying animals (for collision detection and pathfinding)
window.FLYING_ANIMALS = ['bee', 'owl']; // These animals can fly over obstacles

// Initialize enhanced terrain system
window.initializeEnhancedSystems = function() {
    console.log('🚀 Initializing Enhanced Hex Systems...');
    
    // Create global terrain system instance
    if (!window.terrainSystem) {
        window.terrainSystem = new TerrainSystem();
        console.log('✅ Enhanced Terrain System created');
    }
    
    // Generate hex map if not already generated
    if (window.terrainSystem.hexGrid.size === 0) {
        window.terrainSystem.generateHexMap();
        console.log('✅ Strategic hex map generated');
    }
    
    console.log('🎯 Enhanced systems ready for strategic gameplay!');
};

// Enhanced unit movement and tactical systems ready

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