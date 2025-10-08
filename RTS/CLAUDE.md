# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` - Start both client and server in parallel
- `npm run dev:client` - Start only the Vite development server (port 5173)
- `npm run dev:server` - Start only the Node.js server (port 3001)
- `npm run build` - Build the client and compile server TypeScript
- `npm run preview` - Preview the built application

## Architecture Overview

This is a 3D Real-Time Strategy (RTS) game built with React Three Fiber for 3D rendering and Socket.IO for multiplayer support. The game uses a 3D battle map instead of a hex grid system.

### Key Technologies
- **Frontend**: React 18 + TypeScript + Vite
- **3D Rendering**: React Three Fiber (@react-three/fiber) + Three.js + @react-three/drei
- **State Management**: Zustand with Immer for immutable updates
- **Backend**: Express + Socket.IO
- **Development**: Vite dev server with proxy configuration

### Project Structure

**Client (src/)**
- `game/state.ts` - Main game state using Zustand store with all game logic
- `game/types.ts` - TypeScript interfaces for game entities (Unit, Player, GameState, etc.)
- `components/HexGrid.tsx` - BattleMap component that loads the 3D battle map model
- `components/UnitsLayer.tsx` - 3D unit rendering and animations
- `components/HexInteraction.tsx` - MapInteraction component for terrain clicking
- `components/HUD.tsx` - UI overlay for game controls
- `App.tsx` - Main React component with Canvas setup

**Server (server/)**
- `index.ts` - Express server with Socket.IO and static file serving
- `dev.cjs` - Development server wrapper for nodemon

**3D Models (models/)**
- `Battle_Map.glb` - Main 3D battle terrain map
- `[Animal].glb` - Individual animal unit models (Bear.glb, Bee.glb, etc.)

### Game Architecture

The game uses a **client-side game loop** with the main logic in `src/game/state.ts`:

- **3D Coordinate System**: Uses Position3D (x, y, z) world coordinates instead of hex grid
- **Unit System**: 4 unit types (Unit, Queen, King, Base) with different stats per animal
- **AI Behavior**: Continuous movement toward closest enemies using 3D pathfinding
- **Combat**: Distance-based combat with cooldowns, damage, and HP regeneration near Queens
- **Win Conditions**: Eliminate all enemy Bases, Kings, and Queens

### Key Game Logic Flow

1. **Initialization**: Creates local player and AI with 3 animals each, spawns Bases/Queens/Kings at fixed 3D positions
2. **Game Loop** (`tick` function): Handles regeneration, spawning, smooth 3D movement, combat, win detection
3. **Commands**: Player can select units and issue move orders via right-click on 3D terrain
4. **Spawning**: Queens spawn new units every 10 seconds at random positions around them

### 3D Movement System

- **Smooth Movement**: Units move continuously using direction vectors and speed-based displacement
- **Distance Calculations**: Uses 3D Euclidean distance for all proximity checks (combat range, regeneration, etc.)
- **Terrain Interaction**: Ray casting against ground plane for mouse-to-world coordinate conversion

### Development Notes

- Server serves 3D models from `/models` endpoint via Express static middleware
- Vite proxy routes Socket.IO and API calls to Express server (localhost:3001)
- Game state is entirely client-side - server currently only provides basic Socket.IO infrastructure
- Uses TypeScript throughout with strict typing for game entities
- All hex-based coordinate system has been replaced with 3D world coordinates