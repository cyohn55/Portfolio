/**
 * Hexagon Animation Module
 * Creates falling hexagons on the left and right sides of the about section
 * Only active in dark mode
 */

class HexagonAnimator {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);

        if (!this.container) {
            console.error(`Container with ID "${containerId}" not found`);
            return;
        }

        this.options = {
            spawnInterval: options.spawnInterval || 800,
            maxHexagons: options.maxHexagons || 20,
            minSize: options.minSize || 20,
            maxSize: options.maxSize || 60,
            fallDuration: options.fallDuration || { min: 4000, max: 8000 },
            colors: options.colors || {
                primary: '#f5a623',
                secondary: '#ff8c00'
            },
            ...options
        };

        this.hexagons = [];
        this.animationId = null;
        this.isRunning = false;
        this.containersCreated = false;

        this.init();
    }

    isDarkMode() {
        return document.documentElement.getAttribute('data-theme') === 'dark';
    }

    init() {
        this.setupThemeObserver();
        this.setupVisibilityObserver();

        if (this.isDarkMode()) {
            this.createContainers();
            this.start();
        }
    }

    setupThemeObserver() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.attributeName === 'data-theme') {
                    this.handleThemeChange();
                }
            });
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }

    handleThemeChange() {
        if (this.isDarkMode()) {
            if (!this.containersCreated) {
                this.createContainers();
            }
            this.showContainers();
            this.start();
        } else {
            this.stop();
            this.hideContainers();
            this.clearAllHexagons();
        }
    }

    showContainers() {
        if (this.leftContainer) this.leftContainer.style.display = '';
        if (this.rightContainer) this.rightContainer.style.display = '';
    }

    hideContainers() {
        if (this.leftContainer) this.leftContainer.style.display = 'none';
        if (this.rightContainer) this.rightContainer.style.display = 'none';
    }

    clearAllHexagons() {
        this.hexagons.forEach(hex => {
            if (hex.element && hex.element.parentNode) {
                hex.element.remove();
            }
        });
        this.hexagons = [];
    }

    createContainers() {
        if (this.containersCreated) return;

        this.leftContainer = document.createElement('div');
        this.leftContainer.className = 'hexagon-container hexagon-container-left';
        this.leftContainer.setAttribute('aria-hidden', 'true');

        this.rightContainer = document.createElement('div');
        this.rightContainer.className = 'hexagon-container hexagon-container-right';
        this.rightContainer.setAttribute('aria-hidden', 'true');

        this.container.appendChild(this.leftContainer);
        this.container.appendChild(this.rightContainer);

        this.containersCreated = true;
    }

    createHexagon() {
        const hexagon = document.createElement('div');
        const size = this.getRandomSize();
        const isOutlineOnly = Math.random() > 0.5;
        const side = Math.random() > 0.5 ? 'left' : 'right';
        const targetContainer = side === 'left' ? this.leftContainer : this.rightContainer;

        hexagon.className = `falling-hexagon ${isOutlineOnly ? 'hexagon-outline' : 'hexagon-filled'}`;

        const horizontalPosition = this.getRandomHorizontalPosition(side, size);
        const fallDuration = this.getRandomFallDuration();
        const delay = Math.random() * 500;
        const rotation = Math.random() * 360;
        const rotationSpeed = (Math.random() - 0.5) * 720;

        hexagon.style.cssText = `
            --hex-size: ${size}px;
            --fall-duration: ${fallDuration}ms;
            --horizontal-pos: ${horizontalPosition}%;
            --initial-rotation: ${rotation}deg;
            --rotation-speed: ${rotationSpeed}deg;
            --delay: ${delay}ms;
        `;

        targetContainer.appendChild(hexagon);

        const hexagonData = {
            element: hexagon,
            createdAt: Date.now(),
            duration: fallDuration + delay
        };

        this.hexagons.push(hexagonData);

        setTimeout(() => {
            this.removeHexagon(hexagonData);
        }, fallDuration + delay + 1000);

        return hexagonData;
    }

    getRandomSize() {
        return Math.floor(
            Math.random() * (this.options.maxSize - this.options.minSize) + this.options.minSize
        );
    }

    getRandomHorizontalPosition(side, size) {
        return Math.floor(Math.random() * 80) + 10;
    }

    getRandomFallDuration() {
        const { min, max } = this.options.fallDuration;
        return Math.floor(Math.random() * (max - min) + min);
    }

    removeHexagon(hexagonData) {
        const index = this.hexagons.indexOf(hexagonData);
        if (index > -1) {
            this.hexagons.splice(index, 1);
        }

        if (hexagonData.element && hexagonData.element.parentNode) {
            hexagonData.element.remove();
        }
    }

    start() {
        if (this.isRunning) return;
        if (!this.isDarkMode()) return;

        this.isRunning = true;
        this.spawnLoop();
    }

    stop() {
        this.isRunning = false;
        if (this.animationId) {
            clearTimeout(this.animationId);
            this.animationId = null;
        }
    }

    spawnLoop() {
        if (!this.isRunning) return;

        if (this.hexagons.length < this.options.maxHexagons) {
            this.createHexagon();
        }

        const jitter = Math.random() * 400 - 200;
        const nextSpawn = this.options.spawnInterval + jitter;

        this.animationId = setTimeout(() => {
            this.spawnLoop();
        }, Math.max(nextSpawn, 200));
    }

    setupVisibilityObserver() {
        if (typeof IntersectionObserver === 'undefined') return;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && this.isDarkMode()) {
                    this.start();
                } else {
                    this.stop();
                }
            });
        }, { threshold: 0.1 });

        observer.observe(this.container);
    }

    destroy() {
        this.stop();

        this.hexagons.forEach(hex => {
            if (hex.element && hex.element.parentNode) {
                hex.element.remove();
            }
        });
        this.hexagons = [];

        if (this.leftContainer) this.leftContainer.remove();
        if (this.rightContainer) this.rightContainer.remove();
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
        return;
    }

    const aboutSection = document.getElementById('about');
    if (aboutSection) {
        window.hexagonAnimator = new HexagonAnimator('about', {
            spawnInterval: 600,
            maxHexagons: 15,
            minSize: 15,
            maxSize: 50,
            fallDuration: { min: 5000, max: 10000 }
        });
    }
});
