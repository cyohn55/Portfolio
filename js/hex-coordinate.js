/**
 * Hex Coordinate System
 * Based on Red Blob Games hexagonal grid algorithms
 * Uses axial coordinates (q, r) with cube coordinate support
 */

class HexCoord {
    constructor(q, r) {
        this.q = q; // Column coordinate
        this.r = r; // Row coordinate
        // s = -q - r (cube coordinate, calculated when needed)
    }

    // Convert to cube coordinates for advanced algorithms
    toCube() {
        return { q: this.q, r: this.r, s: -this.q - this.r };
    }

    // Create from cube coordinates
    static fromCube(cube) {
        return new HexCoord(cube.q, cube.r);
    }

    // Hex distance calculation using axial coordinates
    distanceTo(other) {
        return (Math.abs(this.q - other.q) + 
                Math.abs(this.q + this.r - other.q - other.r) + 
                Math.abs(this.r - other.r)) / 2;
    }

    // Check equality
    equals(other) {
        return this.q === other.q && this.r === other.r;
    }

    // Convert to string for use as Map key
    toString() {
        return `${this.q},${this.r}`;
    }

    // Create from string key
    static fromString(str) {
        const [q, r] = str.split(',').map(Number);
        return new HexCoord(q, r);
    }

    // Add two hex coordinates
    add(other) {
        return new HexCoord(this.q + other.q, this.r + other.r);
    }

    // Subtract two hex coordinates
    subtract(other) {
        return new HexCoord(this.q - other.q, this.r - other.r);
    }

    // Scale hex coordinate
    scale(factor) {
        return new HexCoord(this.q * factor, this.r * factor);
    }

    // Get hex neighbors (6 directions)
    getNeighbors() {
        const directions = [
            new HexCoord(+1, 0), new HexCoord(+1, -1), new HexCoord(0, -1),
            new HexCoord(-1, 0), new HexCoord(-1, +1), new HexCoord(0, +1)
        ];
        
        return directions.map(dir => this.add(dir));
    }

    // Get neighbor in specific direction (0-5)
    getNeighbor(direction) {
        const directions = [
            new HexCoord(+1, 0), new HexCoord(+1, -1), new HexCoord(0, -1),
            new HexCoord(-1, 0), new HexCoord(-1, +1), new HexCoord(0, +1)
        ];
        
        return this.add(directions[direction % 6]);
    }
}

class HexMath {
    // Hex interpolation for line drawing
    static hexLerp(a, b, t) {
        const aq = a.q * (1 - t) + b.q * t;
        const ar = a.r * (1 - t) + b.r * t;
        const as = (-a.q - a.r) * (1 - t) + (-b.q - b.r) * t;
        
        return { q: aq, r: ar, s: as };
    }

    // Round fractional hex coordinates to nearest hex
    static hexRound(hex) {
        let rq = Math.round(hex.q);
        let rr = Math.round(hex.r);
        let rs = Math.round(hex.s);

        const q_diff = Math.abs(rq - hex.q);
        const r_diff = Math.abs(rr - hex.r);
        const s_diff = Math.abs(rs - hex.s);

        if (q_diff > r_diff && q_diff > s_diff) {
            rq = -rr - rs;
        } else if (r_diff > s_diff) {
            rr = -rq - rs;
        } else {
            rs = -rq - rr;
        }

        return new HexCoord(rq, rr);
    }

    // Draw line between two hex coordinates
    static hexLineDraw(start, end) {
        const distance = start.distanceTo(end);
        const results = [];
        
        for (let i = 0; i <= distance; i++) {
            const t = distance === 0 ? 0 : i / distance;
            const lerp = this.hexLerp(start, end, t);
            results.push(this.hexRound(lerp));
        }
        
        return results;
    }

    // Get all hexes within a certain range
    static hexRange(center, range) {
        const results = [];
        
        for (let q = -range; q <= range; q++) {
            const r1 = Math.max(-range, -q - range);
            const r2 = Math.min(range, -q + range);
            
            for (let r = r1; r <= r2; r++) {
                results.push(center.add(new HexCoord(q, r)));
            }
        }
        
        return results;
    }

    // Get hexes in a ring at specific distance
    static hexRing(center, radius) {
        if (radius === 0) return [center];
        
        const results = [];
        let hex = center.add(new HexCoord(-radius, +radius));
        
        // Walk around the ring
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < radius; j++) {
                results.push(hex);
                hex = hex.getNeighbor(i);
            }
        }
        
        return results;
    }

    // Get spiral of hexes from center outward
    static hexSpiral(center, radius) {
        let results = [center];
        
        for (let k = 1; k <= radius; k++) {
            results = results.concat(this.hexRing(center, k));
        }
        
        return results;
    }

    // Convert offset coordinates to axial (for backwards compatibility)
    static offsetToAxial(col, row, offsetType = 'odd-r') {
        let q, r;
        
        if (offsetType === 'odd-r') {
            q = col - Math.floor((row + (row & 1)) / 2);
            r = row;
        } else if (offsetType === 'even-r') {
            q = col - Math.floor((row - (row & 1)) / 2);
            r = row;
        } else if (offsetType === 'odd-q') {
            q = col;
            r = row - Math.floor((col + (col & 1)) / 2);
        } else { // even-q
            q = col;
            r = row - Math.floor((col - (col & 1)) / 2);
        }
        
        return new HexCoord(q, r);
    }

    // Convert axial coordinates to offset (for display)
    static axialToOffset(hexCoord, offsetType = 'odd-r') {
        let col, row;
        
        if (offsetType === 'odd-r') {
            col = hexCoord.q + Math.floor((hexCoord.r + (hexCoord.r & 1)) / 2);
            row = hexCoord.r;
        } else if (offsetType === 'even-r') {
            col = hexCoord.q + Math.floor((hexCoord.r - (hexCoord.r & 1)) / 2);
            row = hexCoord.r;
        } else if (offsetType === 'odd-q') {
            col = hexCoord.q;
            row = hexCoord.r + Math.floor((hexCoord.q + (hexCoord.q & 1)) / 2);
        } else { // even-q
            col = hexCoord.q;
            row = hexCoord.r + Math.floor((hexCoord.q - (hexCoord.q & 1)) / 2);
        }
        
        return { col, row };
    }

    // Convert hex coordinates to pixel coordinates
    static hexToPixel(hexCoord, size, layout = 'pointy') {
        let x, y;
        
        if (layout === 'pointy') {
            x = size * (Math.sqrt(3) * hexCoord.q + Math.sqrt(3) / 2 * hexCoord.r);
            y = size * (3.0 / 2 * hexCoord.r);
        } else { // flat
            x = size * (3.0 / 2 * hexCoord.q);
            y = size * (Math.sqrt(3) / 2 * hexCoord.q + Math.sqrt(3) * hexCoord.r);
        }
        
        return { x, y };
    }

    // Convert pixel coordinates to hex coordinates
    static pixelToHex(point, size, layout = 'pointy') {
        let q, r;
        
        if (layout === 'pointy') {
            q = (Math.sqrt(3) / 3 * point.x - 1.0 / 3 * point.y) / size;
            r = (2.0 / 3 * point.y) / size;
        } else { // flat
            q = (2.0 / 3 * point.x) / size;
            r = (-1.0 / 3 * point.x + Math.sqrt(3) / 3 * point.y) / size;
        }
        
        return this.hexRound({ q, r, s: -q - r });
    }
}

// Export for use in other modules
window.HexCoord = HexCoord;
window.HexMath = HexMath;

console.log('✅ Hex Coordinate System loaded - Axial coordinates with Red Blob Games algorithms');
