// Removed unused infinite scroll code since projects are static in the HTML

// Function to smoothly scroll to the top
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth' // For smooth scrolling
    });
}

// Simple word-by-word typing animation
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded');
    
    // Elements
    const typingText = document.getElementById('typing-text');
    const typingContainer = document.getElementById('typing-animation-container');
    const originalText = document.getElementById('fade-in');
    
    if (!typingText) {
        console.error('Typing text element not found!');
        return;
    }
    
    // Check for reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
        // Just display the text normally
        return;
    }
    
    // Define exact sequence of content to be displayed
    const finalContent = `Good hiring managers<br>ask

Can you<br><span class="ocr-code">CODE</span>?

<i>Great</i> hiring<br>managers ask<br class="mobile-br">
<a href="Pages/aboutcode.html" class="red-link">'Who&nbsp;<i>IS</i><br><span class="red-code">Code</span><span class="black-question">?</span>'</a>`;

    // Pre-calculate the height by temporarily showing the full content
    function preCalculateHeight() {
        // Temporarily modify the actual element to get the final rendered height
        typingText.style.visibility = 'hidden'; // Hide it briefly
        typingText.classList.add('typing-done'); // Apply final styles
        typingText.innerHTML = finalContent.replace(/\n/g, '<br>');

        const finalHeight = typingText.offsetHeight;
        console.log("Calculated final height:", finalHeight);
        
        // Set the container height
        if (finalHeight > 0) {
            typingContainer.style.minHeight = `${finalHeight}px`;
            typingText.style.minHeight = `${finalHeight}px`;
        }
        
        // Revert the changes
        typingText.style.visibility = 'visible';
        typingText.classList.remove('typing-done');
        typingText.innerHTML = ''; // Clear it for typing
    }
    
    // Run height calculation
    preCalculateHeight();
    
    // The text is already cleared in preCalculateHeight
    // typingText.textContent = '';
    
    // Break down the content into typing sequence - word by word with pre-defined line breaks
    const typingSequence = [
        // Everyone asks - with final layout from start
        { content: "<div class=\"centered-who\"><span class=\"line-everyone\">Good hiring managers<br>&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-everyone\">Good hiring managers<br>ask</span></div>", delay: 1500, isCentered: true },
        
        // How to Code? - with final layout from start
        { content: "<div class=\"centered-who\"><span class=\"line-how\">Can<br>&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-how\">Can you<br>&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-how\">Can you<br><span class=\"ocr-code\">CODE</span>?</span></div>", delay: 1500, isCentered: true },
        
        // But, no one asks - with final layout from start
        { content: "<div class=\"centered-who\"><span class=\"line-but\"><i>Great</i> hiring<br>&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-but\"><i>Great</i> hiring<br>managers&nbsp;</span></div>", delay: 400, isCentered: true },
        { content: "<div class=\"centered-who\"><span class=\"line-but\"><i>Great</i> hiring<br>managers ask</span></div>", delay: 1500, isCentered: true, clearAfter: true },
        
        // Who is Code? - with final layout from start (keep original timing)
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who<br>&nbsp;</a></div>", delay: 600, isCentered: true },
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who&nbsp;<i>is</i><br>&nbsp;</a></div>", delay: 600, isCentered: true },
        { content: "<div class=\"centered-who\"><a href=\"Pages/aboutcode.html\" class=\"red-link line-who\">Who&nbsp;<i>is</i><br><span class=\"red-code\">Code</span><span class=\"black-question\">?</span></a></div>", delay: 800, isCentered: true, isLast: true, triggerBeFirstText: true }
    ];
    
    let currentIndex = 0;
    
    function typeNext() {
        // If we've finished all typing steps, we're done
        if (currentIndex >= typingSequence.length) {
            typingText.classList.add('typing-done');
            return;
        }
        
        const currentStep = typingSequence[currentIndex];
        
        // Ensure text is visible (no transitions)
        typingText.style.opacity = '1';
        typingText.style.transition = 'none';
        
        // Handle centered content differently based on device
        if (currentStep.isCentered && window.innerWidth > 768) {
            typingText.style.textAlign = 'center';
        } else {
            typingText.style.textAlign = 'left';
        }
        
        // Set the content
        typingText.innerHTML = currentStep.content.replace(/\n/g, '<br>');
        
        // Move to next step
        currentIndex++;
        
        // Handle clearing after this step
        if (currentStep.clearAfter) {
            setTimeout(() => {
                // Clear the content
                typingText.innerHTML = '';
                // Continue to next step after a brief pause
                setTimeout(typeNext, 500);
            }, currentStep.delay);
        } else if (currentStep.isLast) {
            // If this is the last step, finish the animation
            setTimeout(() => {
                typingText.classList.add('typing-done');
                
                // Check if we should trigger the "Be the first to ask!" text (both mobile and desktop)
                if (currentStep.triggerBeFirstText) {
                    const beFirstText = document.getElementById('be-first-text');
                    if (beFirstText) {
                        // Make the element visible and trigger fade-in
                        beFirstText.style.visibility = 'visible';
                        beFirstText.style.opacity = '1';
                    }
                }
            }, currentStep.delay);
        } else {
            setTimeout(typeNext, currentStep.delay);
        }
    }
    
    // Function to start the animation
    function startAnimation() {
        setTimeout(typeNext, 400);
    }
    
    // Check if we're on desktop (not mobile)
    const isDesktop = window.innerWidth > 768;
    
    if (isDesktop) {
        // Wait for intro text to be visible before starting animation
        const introText = document.querySelector('#about > div.default-container > div.intro-text');
        
        if (introText) {
            // Create intersection observer
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        // Start animation when intro text is visible
                        startAnimation();
                        // Stop observing once animation starts
                        observer.unobserve(entry.target);
                    }
                });
            }, {
                threshold: 0.1, // Trigger when 10% of the element is visible
                rootMargin: '0px 0px -50px 0px' // Start slightly before element is fully visible
            });
            
            // Start observing the intro text
            observer.observe(introText);
        } else {
            // Fallback: start animation after delay if intro text not found
            startAnimation();
        }
    } else {
        // On mobile, start animation immediately (as requested)
        startAnimation();
    }
});

// Parallax effect for .parallax-3 section if it exists
document.addEventListener('DOMContentLoaded', () => {
    const parallax3 = document.querySelector('.parallax-3');
    
    // Exit early if parallax-3 doesn't exist
    if (!parallax3) return;
    
    const layers = parallax3.querySelectorAll('.parallax-layer');

    // Check for reduced motion preference
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    let ticking = false;

    const handleScroll = () => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                const scrollTop = window.scrollY;
                const parallaxOffset = parallax3.offsetTop;
                const windowHeight = window.innerHeight;

                // Check if parallax-3 is in the viewport
                if (scrollTop + windowHeight > parallaxOffset && scrollTop < parallaxOffset + parallax3.offsetHeight) {
                    layers.forEach(layer => {
                        const speed = layer.getAttribute('data-speed');
                        const yPos = (scrollTop - parallaxOffset) * speed;
                        layer.style.transform = `translateY(${yPos}px)`;
                    });
                }
                ticking = false;
            });
            ticking = true;
        }
    };

    window.addEventListener('scroll', handleScroll);
});

// Removed commented-out carousel code (unused)

// ==========================================================================
// 3D MODEL MODAL FUNCTIONALITY
// ==========================================================================

// Global variables
let autoRotateEnabled = true;
let currentModel = 'dolphin';
let currentModelIndex = 0;
let autoCycleEnabled = true;
let autoCycleTimer = null;

// Array of model keys for cycling
const modelKeys = ['dolphin', 'bee', 'bear', 'fox', 'frog', 'owl', 'pig', 'turtle', 'cat', 'chicken', 'yeti'];

// Model configuration
const modelConfig = {
    dolphin: {
        file: 'models/dolphin.glb',
        title: '🐬 Interactive 3D Dolphin Model',
        emoji: '🐬',
        background: '#00bfff' // Vibrant cyan/blue
    },
    bee: {
        file: 'models/Bee.glb',
        title: '🐝 Interactive 3D Bee Model',
        emoji: '🐝',
        background: '#b300ff' // Vibrant purple
    },
    bear: {
        file: 'models/Bear.glb',
        title: '🐻 Interactive 3D Bear Model',
        emoji: '🐻',
        background: '#00ffd9' // Vibrant aqua
    },
    fox: {
        file: 'models/Fox.glb',
        title: '🦊 Interactive 3D Fox Model',
        emoji: '🦊',
        background: '#006cff' // Vibrant blue
    },
    frog: {
        file: 'models/Frog.glb',
        title: '🐸 Interactive 3D Frog Model',
        emoji: '🐸',
        background: '#ff00ff' // Vibrant magenta
    },
    owl: {
        file: 'models/Owl.glb',
        title: '🦉 Interactive 3D Owl Model',
        emoji: '🦉',
        background: '#00e1ff' // Vibrant cyan
    },
    pig: {
        file: 'models/Pig.glb',
        title: '🐷 Interactive 3D Pig Model',
        emoji: '🐷',
        background: '#00ff6a' // Vibrant green
    },
    turtle: {
        file: 'models/Turtle.glb',
        title: '🐢 Interactive 3D Turtle Model',
        emoji: '🐢',
        background: '#ff7b00' // Vibrant orange
    },
    cat: {
        file: 'models/cat.glb',
        title: '🐱 Interactive 3D Cat Model',
        emoji: '🐱',
        background: '#ffe600' // Vibrant yellow
    },
    chicken: {
        file: 'models/Chicken.glb',
        title: '🐔 Interactive 3D Chicken Model',
        emoji: '🐔',
        background: '#ff1493' // Vibrant pink
    },
    yeti: {
        file: 'models/Yetti.glb',
        title: '👾 Interactive 3D Yeti Model',
        emoji: '👾',
        background: '#007fff' // Vibrant azure
    }
};

// Open models modal
function openModelsModal() {
    const modal = document.getElementById('modelsModal');
    const modelViewer = modal.querySelector('model-viewer');
    const instructions = document.getElementById('zoomInstructions');
    
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
    
    // Set initial background for default model (dolphin)
    if (modelViewer && modelConfig[currentModel]) {
        modelViewer.style.background = modelConfig[currentModel].background;
    }
    
    // Make sure instructions are visible when modal opens
    if (instructions) {
        instructions.style.display = 'block';
    }
    
    // Focus on model viewer for accessibility
    setTimeout(() => {
        if (modelViewer) {
            modelViewer.focus();
        }
    }, 100);
}

// Close models modal
function closeModelsModal() {
    const modal = document.getElementById('modelsModal');
    modal.style.display = 'none';
    document.body.style.overflow = 'auto'; // Restore scrolling
}

// Switch between different 3D models
function switchModel(modelType) {
    if (!modelConfig[modelType]) {
        console.error('Unknown model type:', modelType);
        return;
    }
    
    const modal = document.getElementById('modelsModal');
    const modelViewer = modal.querySelector('#mainModelViewer');
    const modelTitle = modal.querySelector('#modelTitle');
    
    // Update current model
    currentModel = modelType;
    
    // Update model source
    if (modelViewer) {
        modelViewer.src = modelConfig[modelType].file;
        modelViewer.alt = modelConfig[modelType].title;
        // Update background color to complement the model
        modelViewer.style.background = modelConfig[modelType].background;
        // Ensure faster rotation speed
        modelViewer.setAttribute('rotation-per-second', '37.5deg');
    }
    
    // Update modal title
    if (modelTitle) {
        modelTitle.textContent = modelConfig[modelType].title;
    }
    
    // Update button states
    const buttons = modal.querySelectorAll('.model-btn');
    buttons.forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-model') === modelType) {
            btn.classList.add('active');
        }
    });
    
    // Reset camera position for new model
    setTimeout(() => {
        resetCamera();
    }, 100);
}

// Reset camera to default position
function resetCamera() {
    const modal = document.getElementById('modelsModal');
    const modelViewer = modal.querySelector('model-viewer');
    
    if (modelViewer) {
        modelViewer.cameraOrbit = '45deg 75deg 20m';
        modelViewer.fieldOfView = '45deg';
    }
}

// Toggle auto-rotate functionality
function toggleAutoRotate() {
    const modal = document.getElementById('modelsModal');
    const modelViewer = modal.querySelector('model-viewer');
    
    if (modelViewer) {
        autoRotateEnabled = !autoRotateEnabled;
        
        if (autoRotateEnabled) {
            modelViewer.setAttribute('auto-rotate', '');
        } else {
            modelViewer.removeAttribute('auto-rotate');
        }
        
        // Update button text
        const button = event.target;
        button.textContent = autoRotateEnabled ? 'Stop Rotation' : 'Start Rotation';
    }
}

// Toggle zoom instructions visibility
function toggleInstructions() {
    const instructions = document.getElementById('zoomInstructions');
    if (instructions) {
        if (instructions.style.display === 'none') {
            instructions.style.display = 'block';
        } else {
            instructions.style.display = 'none';
        }
    }
}

// Embedded model viewer functions
function switchEmbeddedModel(modelType) {
    if (!modelConfig[modelType]) {
        console.error('Unknown model type:', modelType);
        return;
    }
    
    const modelViewer = document.getElementById('embeddedModelViewer');
    
    // Update current model and index
    currentModel = modelType;
    currentModelIndex = modelKeys.indexOf(modelType);
    
    // Update model source and background
    if (modelViewer) {
        modelViewer.src = modelConfig[modelType].file;
        modelViewer.alt = modelConfig[modelType].title;
        modelViewer.style.background = modelConfig[modelType].background;
        modelViewer.setAttribute('rotation-per-second', '75deg');
    }
    
    // Reset camera position for new model
    setTimeout(() => {
        resetEmbeddedCamera();
    }, 100);
    
    // Restart auto-cycle timer if enabled
    if (autoCycleEnabled) {
        startAutoCycle();
    }
}

function resetEmbeddedCamera() {
    const modelViewer = document.getElementById('embeddedModelViewer');
    if (modelViewer) {
        modelViewer.cameraOrbit = '45deg 75deg 20m';
        modelViewer.fieldOfView = '45deg';
    }
}

function toggleEmbeddedAutoRotate() {
    const modelViewer = document.getElementById('embeddedModelViewer');
    const toggleButton = document.getElementById('rotationToggle');
    
    if (modelViewer && toggleButton) {
        const isRotating = modelViewer.hasAttribute('auto-rotate');
        
        if (isRotating) {
            // Stop rotation and auto-cycling
            modelViewer.removeAttribute('auto-rotate');
            autoCycleEnabled = false;
            stopAutoCycle();
            toggleButton.innerHTML = '&#9658;'; // Play symbol
            toggleButton.setAttribute('aria-label', 'Start rotation');
        } else {
            // Start rotation and auto-cycling
            modelViewer.setAttribute('auto-rotate', '');
            modelViewer.setAttribute('rotation-per-second', '75deg');
            autoCycleEnabled = true;
            startAutoCycle();
            toggleButton.innerHTML = '&#9208;'; // Stop symbol
            toggleButton.setAttribute('aria-label', 'Stop rotation');
        }
    }
}



// Auto-cycle functions
function startAutoCycle() {
    clearTimeout(autoCycleTimer);
    if (autoCycleEnabled) {
        // One full rotation at 75deg/second = 360deg / 75deg = 4.8 seconds
        autoCycleTimer = setTimeout(() => {
            if (autoCycleEnabled) {
                currentModelIndex = (currentModelIndex + 1) % modelKeys.length;
                const nextModelType = modelKeys[currentModelIndex];
                switchEmbeddedModel(nextModelType);
            }
        }, 4800); // 4.8 seconds for one full rotation
    }
}

function stopAutoCycle() {
    clearTimeout(autoCycleTimer);
}



// Arrow navigation functions
function nextModel() {
    currentModelIndex = (currentModelIndex + 1) % modelKeys.length;
    const nextModelType = modelKeys[currentModelIndex];
    switchEmbeddedModel(nextModelType);
}

function previousModel() {
    currentModelIndex = (currentModelIndex - 1 + modelKeys.length) % modelKeys.length;
    const prevModelType = modelKeys[currentModelIndex];
    switchEmbeddedModel(prevModelType);
}

// Close modal when clicking outside of it
document.addEventListener('DOMContentLoaded', function() {
    const modal = document.getElementById('modelsModal');
    
    if (modal) {
        modal.addEventListener('click', function(event) {
            if (event.target === modal) {
                closeModelsModal();
            }
        });
    }
    
    // Handle escape key to close modal
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            const modal = document.getElementById('modelsModal');
            if (modal && modal.style.display === 'block') {
                closeModelsModal();
            }
        }
    });
    
    // Handle model loading events and user interaction
    const modelViewers = document.querySelectorAll('model-viewer');
    modelViewers.forEach(viewer => {
        viewer.addEventListener('load', function() {
            console.log('3D model loaded successfully');
            // Start auto-cycle for embedded viewer
            if (viewer.id === 'embeddedModelViewer') {
                startAutoCycle();
            }
        });
        
        viewer.addEventListener('error', function(event) {
            console.error('Error loading 3D model:', event);
        });
        

    });
});


/* =====================================================================
   HEX-GRID GENERATION (Mountain / Forest / Hill / FarmLand)
   ===================================================================== */

// Configuration for hex-tile GLB models
const hexTileModels = [
    { file: 'models/Mountain.glb', alt: 'Mountain Tile' },
    { file: 'models/Forest.glb', alt: 'Forest Tile' },
    { file: 'models/Hill.glb', alt: 'Hill Tile' },
    { file: 'models/FarmLand.glb', alt: 'Farm Land Tile' }
];

function getRandomHexTile() {
    return hexTileModels[Math.floor(Math.random() * hexTileModels.length)];
}

/**
 * Generates a hex-grid inside #hex-grid.
 * Each odd row is horizontally offset by half a tile so the hexes interlock.
 * @param {number} rows – number of rows
 * @param {number} cols – number of columns per row
 */
function generateHexGrid(rows = 8, cols = 10) {
    const container = document.getElementById('hex-grid');
    if (!container) {
        console.warn('Hex grid container (#hex-grid) not found.');
        return;
    }

    // Clear any existing tiles
    container.innerHTML = '';

    for (let r = 0; r < rows; r++) {
        const rowEl = document.createElement('div');
        rowEl.classList.add('hex-row');
        
        // Offset every other row by half a tile width for proper hex interlocking
        if (r % 2 === 1) {
            rowEl.classList.add('offset-row');
        }

        // Adjust column count for offset rows to maintain visual balance
        const colsForRow = (r % 2 === 1) ? cols - 1 : cols;

        for (let c = 0; c < colsForRow; c++) {
            const { file, alt } = getRandomHexTile();
            const tile = document.createElement('model-viewer');
            tile.classList.add('hex-tile');
            tile.setAttribute('src', file);
            tile.setAttribute('alt', alt);
            tile.setAttribute('camera-controls', '');
            tile.setAttribute('interaction-prompt', 'none');
            tile.setAttribute('touch-action', 'pan-y');
            tile.setAttribute('loading', 'lazy');
            // Perfect top-down view (looking straight down) - pulled back 195m
            tile.setAttribute('camera-orbit', '0deg 0deg 195m');
            tile.setAttribute('field-of-view', '20deg');
            // Ensure all models have identical orientation
            tile.setAttribute('rotation', '0deg 0deg 0deg');
            tile.setAttribute('orientation', '0deg 0deg 0deg');
            // Disable all rotation and movement
            tile.removeAttribute('auto-rotate');
            tile.setAttribute('disable-zoom', '');
            tile.setAttribute('disable-pan', '');
            tile.setAttribute('min-camera-orbit', '0deg 0deg 195m');
            tile.setAttribute('max-camera-orbit', '0deg 0deg 195m');

            rowEl.appendChild(tile);
        }

        container.appendChild(rowEl);
    }
}

// Kick off hex-grid generation after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    generateHexGrid();
    initializeContactForm();
    initializeDarkMode();
    initializeAsteroidsAnimation();
});

/* =====================================================================
   DARK MODE FUNCTIONALITY
   ===================================================================== */

function initializeDarkMode() {
    const darkModeToggle = document.getElementById('darkModeToggle');
    
    if (!darkModeToggle) return; // Toggle doesn't exist on this page
    
    // Check for saved theme preference or default to light mode
    const savedTheme = localStorage.getItem('theme') || 'light';
    
    // Apply saved theme
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    // Add click event listener
    darkModeToggle.addEventListener('click', toggleDarkMode);
}

function toggleDarkMode() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    // Apply new theme
    document.documentElement.setAttribute('data-theme', newTheme);
    
    // Save preference
    localStorage.setItem('theme', newTheme);
    
    // Add transition effect
    document.body.style.transition = 'background-color 0.3s ease, color 0.3s ease';
    setTimeout(() => {
        document.body.style.transition = '';
    }, 300);
}



/* =====================================================================
   ASTEROIDS ANIMATION SYSTEM
   ===================================================================== */

function initializeAsteroidsAnimation() {
    const canvas = document.getElementById('asteroidsCanvas');
    if (!canvas) return;
    
    // Only run on desktop
    if (window.innerWidth < 1024) return;
    
    const ctx = canvas.getContext('2d');
    let animationId;
    
    // Canvas setup
    function setupCanvas() {
        const section = document.getElementById('about');
        canvas.width = section.offsetWidth;
        canvas.height = section.offsetHeight;
    }
    
    // Vector2 utility class
    class Vector2 {
        constructor(x = 0, y = 0) {
            this.x = x;
            this.y = y;
        }
        
        add(other) {
            return new Vector2(this.x + other.x, this.y + other.y);
        }
        
        subtract(other) {
            return new Vector2(this.x - other.x, this.y - other.y);
        }
        
        multiply(scalar) {
            return new Vector2(this.x * scalar, this.y * scalar);
        }
        
        magnitude() {
            return Math.sqrt(this.x * this.x + this.y * this.y);
        }
        
        normalize() {
            const mag = this.magnitude();
            return mag > 0 ? new Vector2(this.x / mag, this.y / mag) : new Vector2(0, 0);
        }
        
        distance(other) {
            return this.subtract(other).magnitude();
        }
    }
    
    // Spaceship class
    class Spaceship {
        constructor(x, y, color = '#00ff00', team = 0) {
            this.position = new Vector2(x, y);
            this.velocity = new Vector2(0, 0);
            this.angle = Math.random() * Math.PI * 2;
            this.size = 12;
            this.color = color;
            this.team = team;
            this.health = 3;
            this.shootCooldown = 0;
            this.maxSpeed = 2;
            this.thrust = 0.1;
            this.turnSpeed = 0.05;
            this.target = null;
        }
        
        update(gameObjects) {
            // Simple AI behavior
            if (!this.target || this.target.health <= 0) {
                this.target = gameObjects.spaceships.find(ship => ship.team !== this.team && ship.health > 0);
            }
            
            if (this.target) {
                const targetDir = this.target.position.subtract(this.position).normalize();
                const currentDir = new Vector2(Math.cos(this.angle), Math.sin(this.angle));
                
                // Turn towards target
                const cross = currentDir.x * targetDir.y - currentDir.y * targetDir.x;
                if (Math.abs(cross) > 0.1) {
                    this.angle += cross > 0 ? this.turnSpeed : -this.turnSpeed;
                }
                
                // Move forward
                const forward = new Vector2(Math.cos(this.angle), Math.sin(this.angle));
                this.velocity = this.velocity.add(forward.multiply(this.thrust));
                
                // Shoot at target
                if (this.shootCooldown <= 0 && this.position.distance(this.target.position) < 200) {
                    this.shoot(gameObjects);
                    this.shootCooldown = 60; // 1 second at 60 FPS
                }
            }
            
            // Apply velocity and drag
            this.position = this.position.add(this.velocity);
            this.velocity = this.velocity.multiply(0.98);
            
            // Limit speed
            if (this.velocity.magnitude() > this.maxSpeed) {
                this.velocity = this.velocity.normalize().multiply(this.maxSpeed);
            }
            
            // Wrap around screen
            this.wrapPosition();
            
            // Update cooldowns
            if (this.shootCooldown > 0) this.shootCooldown--;
        }
        
        shoot(gameObjects) {
            const bulletSpeed = 5;
            const direction = new Vector2(Math.cos(this.angle), Math.sin(this.angle));
            const bulletPos = this.position.add(direction.multiply(this.size + 5));
            const bulletVel = this.velocity.add(direction.multiply(bulletSpeed));
            
            gameObjects.bullets.push(new Bullet(bulletPos.x, bulletPos.y, bulletVel.x, bulletVel.y, this.team));
        }
        
        wrapPosition() {
            if (this.position.x < 0) this.position.x = canvas.width;
            if (this.position.x > canvas.width) this.position.x = 0;
            if (this.position.y < 0) this.position.y = canvas.height;
            if (this.position.y > canvas.height) this.position.y = 0;
        }
        
        checkCollision(other, radius) {
            return this.position.distance(other.position) < (this.size + radius);
        }
        
        takeDamage() {
            this.health--;
            // Flash effect could be added here
        }
        
        draw(ctx) {
            if (this.health <= 0) return;
            
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.rotate(this.angle);
            
            ctx.strokeStyle = this.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            
            // Draw triangular spaceship
            ctx.moveTo(this.size, 0);
            ctx.lineTo(-this.size, -this.size/2);
            ctx.lineTo(-this.size/2, 0);
            ctx.lineTo(-this.size, this.size/2);
            ctx.closePath();
            
            ctx.stroke();
            ctx.restore();
        }
    }
    
    // Bullet class
    class Bullet {
        constructor(x, y, vx, vy, team) {
            this.position = new Vector2(x, y);
            this.velocity = new Vector2(vx, vy);
            this.team = team;
            this.life = 180; // 3 seconds at 60 FPS
            this.size = 2;
        }
        
        update() {
            this.position = this.position.add(this.velocity);
            this.life--;
            
            // Wrap around screen
            if (this.position.x < 0) this.position.x = canvas.width;
            if (this.position.x > canvas.width) this.position.x = 0;
            if (this.position.y < 0) this.position.y = canvas.height;
            if (this.position.y > canvas.height) this.position.y = 0;
        }
        
        checkCollision(other, radius) {
            return this.position.distance(other.position) < (this.size + radius);
        }
        
        draw(ctx) {
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(this.position.x, this.position.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    
    // Asteroid class
    class Asteroid {
        constructor(x, y, size = 'large') {
            this.position = new Vector2(x, y);
            this.velocity = new Vector2(
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2
            );
            this.angle = 0;
            this.rotationSpeed = (Math.random() - 0.5) * 0.1;
            this.size = size;
            this.radius = size === 'large' ? 25 : size === 'medium' ? 15 : 8;
            this.health = size === 'large' ? 3 : size === 'medium' ? 2 : 1;
            this.vertices = this.generateVertices();
        }
        
        generateVertices() {
            const vertices = [];
            const numVertices = 8 + Math.floor(Math.random() * 4);
            
            for (let i = 0; i < numVertices; i++) {
                const angle = (i / numVertices) * Math.PI * 2;
                const variance = 0.7 + Math.random() * 0.6;
                const x = Math.cos(angle) * this.radius * variance;
                const y = Math.sin(angle) * this.radius * variance;
                vertices.push(new Vector2(x, y));
            }
            
            return vertices;
        }
        
        update() {
            this.position = this.position.add(this.velocity);
            this.angle += this.rotationSpeed;
            
            // Wrap around screen
            if (this.position.x < -this.radius) this.position.x = canvas.width + this.radius;
            if (this.position.x > canvas.width + this.radius) this.position.x = -this.radius;
            if (this.position.y < -this.radius) this.position.y = canvas.height + this.radius;
            if (this.position.y > canvas.height + this.radius) this.position.y = -this.radius;
        }
        
        checkCollision(other, radius) {
            return this.position.distance(other.position) < (this.radius + radius);
        }
        
        takeDamage() {
            this.health--;
            return this.health <= 0;
        }
        
        split() {
            if (this.size === 'large') {
                return [
                    new Asteroid(this.position.x, this.position.y, 'medium'),
                    new Asteroid(this.position.x, this.position.y, 'medium')
                ];
            } else if (this.size === 'medium') {
                return [
                    new Asteroid(this.position.x, this.position.y, 'small'),
                    new Asteroid(this.position.x, this.position.y, 'small')
                ];
            }
            return [];
        }
        
        draw(ctx) {
            ctx.save();
            ctx.translate(this.position.x, this.position.y);
            ctx.rotate(this.angle);
            
            ctx.strokeStyle = '#888888';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            
            if (this.vertices.length > 0) {
                ctx.moveTo(this.vertices[0].x, this.vertices[0].y);
                for (let i = 1; i < this.vertices.length; i++) {
                    ctx.lineTo(this.vertices[i].x, this.vertices[i].y);
                }
                ctx.closePath();
            }
            
            ctx.stroke();
            ctx.restore();
        }
    }
    
    // Game state
    const gameObjects = {
        spaceships: [
            new Spaceship(100, 100, '#00ff00', 0),
            new Spaceship(canvas.width - 100, canvas.height - 100, '#ff6600', 1)
        ],
        bullets: [],
        asteroids: []
    };
    
    // Initialize asteroids
    function spawnAsteroids() {
        for (let i = 0; i < 5; i++) {
            let x, y;
            do {
                x = Math.random() * canvas.width;
                y = Math.random() * canvas.height;
            } while (
                gameObjects.spaceships.some(ship => 
                    new Vector2(x, y).distance(ship.position) < 100
                )
            );
            
            gameObjects.asteroids.push(new Asteroid(x, y, 'large'));
        }
    }
    
    // Collision detection and handling
    function handleCollisions() {
        // Bullets vs Asteroids
        for (let i = gameObjects.bullets.length - 1; i >= 0; i--) {
            const bullet = gameObjects.bullets[i];
            
            for (let j = gameObjects.asteroids.length - 1; j >= 0; j--) {
                const asteroid = gameObjects.asteroids[j];
                
                if (bullet.checkCollision(asteroid, asteroid.radius)) {
                    // Remove bullet
                    gameObjects.bullets.splice(i, 1);
                    
                    // Damage asteroid
                    if (asteroid.takeDamage()) {
                        const newAsteroids = asteroid.split();
                        gameObjects.asteroids.splice(j, 1);
                        gameObjects.asteroids.push(...newAsteroids);
                    }
                    break;
                }
            }
        }
        
        // Bullets vs Spaceships
        for (let i = gameObjects.bullets.length - 1; i >= 0; i--) {
            const bullet = gameObjects.bullets[i];
            
            for (const ship of gameObjects.spaceships) {
                if (ship.team !== bullet.team && ship.health > 0 && 
                    bullet.checkCollision(ship, ship.size)) {
                    
                    gameObjects.bullets.splice(i, 1);
                    ship.takeDamage();
                    break;
                }
            }
        }
        
        // Spaceships vs Asteroids
        for (const ship of gameObjects.spaceships) {
            if (ship.health <= 0) continue;
            
            for (const asteroid of gameObjects.asteroids) {
                if (ship.checkCollision(asteroid, asteroid.radius)) {
                    ship.takeDamage();
                    // Push ship away from asteroid
                    const pushDir = ship.position.subtract(asteroid.position).normalize();
                    ship.velocity = ship.velocity.add(pushDir.multiply(3));
                }
            }
        }
        
        // Remove dead bullets
        gameObjects.bullets = gameObjects.bullets.filter(bullet => bullet.life > 0);
        
        // Respawn destroyed asteroids occasionally
        if (gameObjects.asteroids.length < 3 && Math.random() < 0.01) {
            spawnAsteroids();
        }
        
        // Respawn dead spaceships
        gameObjects.spaceships.forEach(ship => {
            if (ship.health <= 0 && Math.random() < 0.005) {
                ship.health = 3;
                ship.position = new Vector2(
                    Math.random() * canvas.width,
                    Math.random() * canvas.height
                );
                ship.velocity = new Vector2(0, 0);
            }
        });
    }
    
    // Game loop
    function gameLoop() {
        // Clear canvas
        ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Update all objects
        gameObjects.spaceships.forEach(ship => ship.update(gameObjects));
        gameObjects.bullets.forEach(bullet => bullet.update());
        gameObjects.asteroids.forEach(asteroid => asteroid.update());
        
        // Handle collisions
        handleCollisions();
        
        // Draw all objects
        gameObjects.spaceships.forEach(ship => ship.draw(ctx));
        gameObjects.bullets.forEach(bullet => bullet.draw(ctx));
        gameObjects.asteroids.forEach(asteroid => asteroid.draw(ctx));
        
        animationId = requestAnimationFrame(gameLoop);
    }
    
    // Initialize and start
    setupCanvas();
    spawnAsteroids();
    gameLoop();
    
    // Handle window resize
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 1024) {
            setupCanvas();
        } else {
            if (animationId) {
                cancelAnimationFrame(animationId);
                animationId = null;
            }
        }
    });
    
    // Stop animation when leaving page
    window.addEventListener('beforeunload', () => {
        if (animationId) {
            cancelAnimationFrame(animationId);
        }
    });
}

/* =====================================================================
   CONTACT FORM FUNCTIONALITY
   ===================================================================== */

function initializeContactForm() {
    const contactForm = document.getElementById('contactForm');
    
    if (!contactForm) return; // Form doesn't exist on this page
    
    // Check for success parameter in URL
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('success') === 'true') {
        showSuccessMessage();
        // Clean up URL
        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }
    
    contactForm.addEventListener('submit', handleContactFormSubmit);
}

function showSuccessMessage() {
    // Create success message element
    const successDiv = document.createElement('div');
    successDiv.className = 'success-message';
    successDiv.innerHTML = `
        <h3>✅ Message Sent Successfully!</h3>
        <p>Thank you for reaching out! I've received your message and will get back to you within 24 hours.</p>
        <p>You can also reach me directly at:</p>
        <ul>
            <li>📧 Email: <a href="mailto:cyohn55@yahoo.com">cyohn55@yahoo.com</a></li>
            <li>📱 Phone: <a href="tel:17177589087">1-717-758-9087</a></li>
        </ul>
    `;
    
    // Insert success message before the contact form
    const formSection = document.querySelector('.contact-form-section');
    formSection.insertBefore(successDiv, formSection.firstChild);
    
    // Hide the form temporarily
    const form = document.getElementById('contactForm');
    form.style.display = 'none';
    
    // Show form again after 10 seconds
    setTimeout(() => {
        successDiv.remove();
        form.style.display = 'flex';
    }, 10000);
}

function showErrorMessage() {
    // Create error message element
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.innerHTML = `
        <h3>⚠️ Submission Error</h3>
        <p>There was an issue sending your message. Please try again or contact me directly:</p>
        <ul>
            <li>📧 Email: <a href="mailto:cyohn55@yahoo.com">cyohn55@yahoo.com</a></li>
            <li>📱 Phone: <a href="tel:17177589087">1-717-758-9087</a></li>
        </ul>
    `;
    
    // Insert error message before the contact form
    const formSection = document.querySelector('.contact-form-section');
    formSection.insertBefore(errorDiv, formSection.firstChild);
    
    // Remove error message after 8 seconds
    setTimeout(() => {
        errorDiv.remove();
    }, 8000);
}

function handleContactFormSubmit(event) {
    event.preventDefault(); // Prevent default form submission
    
    const form = event.target;
    const submitBtn = form.querySelector('.contact-submit-btn');
    
    // Get form data for validation
    const formData = {
        name: form.name.value.trim(),
        phone: form.phone.value.trim(),
        email: form.email.value.trim() || form._replyto.value.trim(),
        request: form.message.value.trim()
    };
    
    // Validate required fields
    if (!formData.name || !formData.email || !formData.request) {
        alert('Please fill out all required fields (Name, Email, and Request).');
        return;
    }
    
    // Show loading state
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';
    
    // Send both to Formspree and SMS gateway
    Promise.all([
        sendToFormspree(form, formData),
        sendToSMSGateway(formData)
    ]).then(() => {
        // Show success message
        showSuccessMessage();
        form.reset();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send';
    }).catch((error) => {
        console.error('Error sending form:', error);
        showErrorMessage();
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send';
    });
}

function sendToFormspree(form, formData) {
    const formDataObj = new FormData(form);
    
    return fetch(form.action, {
        method: 'POST',
        body: formDataObj,
        headers: {
            'Accept': 'application/json'
        }
    }).then(response => {
        if (!response.ok) {
            throw new Error('Formspree submission failed');
        }
        return response.json();
    });
}

function sendToSMSGateway(formData) {
    // Create SMS-friendly message (keep it short for SMS)
    const smsMessage = `Portfolio Contact: ${formData.name} (${formData.email}) - ${formData.request.substring(0, 120)}${formData.request.length > 120 ? '...' : ''}`;
    
    // Use FormSubmit.co - free service that can send to any email address
    const smsFormData = new FormData();
    smsFormData.append('_to', '17177589087@tmomail.net');
    smsFormData.append('_subject', 'Portfolio SMS');
    smsFormData.append('message', smsMessage);
    smsFormData.append('name', formData.name);
    smsFormData.append('email', formData.email);
    smsFormData.append('_captcha', 'false');
    smsFormData.append('_template', 'table');
    
    return fetch('https://formsubmit.co/17177589087@tmomail.net', {
        method: 'POST',
        body: smsFormData
    }).then(response => {
        if (!response.ok) {
            console.log('FormSubmit failed, SMS may not have been sent');
        }
        return { success: true, service: 'formsubmit' };
    }).catch((error) => {
        console.log('Error sending to SMS gateway:', error);
        return { success: false, error: error.message };
    });
}



