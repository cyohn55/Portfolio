import { useEffect } from 'react';
import { useGameStore } from '../game/state';
import { keyboardCoordinator } from '../utils/keyboardCoordination';

export function KeyboardShortcuts() {
  const matchStarted = useGameStore((s) => s.matchStarted);
  const localPlayerId = useGameStore((s) => s.localPlayerId);
  const selectedAnimalPool = useGameStore((s) => s.selectedAnimalPool);
  const units = useGameStore((s) => s.units);
  const selectUnits = useGameStore((s) => s.selectUnits);

  useEffect(() => {
    if (!matchStarted) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      // Space bar: Select all units
      if (key === ' ') {
        event.preventDefault(); // Prevent page scroll

        // Block camera input for 0.25 seconds to prevent accidental camera movement
        keyboardCoordinator.blockCameraInput(250);

        // Get all player's units (excluding bases)
        const playerUnits = units.filter(u => u.ownerId === localPlayerId && u.kind !== 'Base');
        const unitIds = playerUnits.map(u => u.id);

        if (unitIds.length > 0) {
          selectUnits(unitIds);
        } else {
        }
        return;
      }

      // Only trigger animal-specific shortcuts if Shift is held down
      if (!event.shiftKey) return;

      // Get player's units (excluding bases)
      const playerUnits = units.filter(u => u.ownerId === localPlayerId && u.kind !== 'Base');

      let targetAnimal = null;

      switch (key) {
        case 'a':
          // Shift + A: Select all units of first animal type
          targetAnimal = selectedAnimalPool[0];
          break;
        case 's':
          // Shift + S: Select all units of second animal type
          targetAnimal = selectedAnimalPool[1];
          break;
        case 'd':
          // Shift + D: Select all units of third animal type
          targetAnimal = selectedAnimalPool[2];
          break;
        default:
          return; // Don't prevent default for other keys
      }

      if (targetAnimal) {
        event.preventDefault(); // Prevent browser shortcuts

        // Block camera input for 0.25 seconds to prevent accidental camera movement
        keyboardCoordinator.blockCameraInput(250);

        // Find all units of the target animal type
        const unitsOfType = playerUnits.filter(u => u.animal === targetAnimal);
        const unitIds = unitsOfType.map(u => u.id);

        if (unitIds.length > 0) {
          selectUnits(unitIds);
        } else {
        }
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [matchStarted, localPlayerId, selectedAnimalPool, units, selectUnits]);

  // This component doesn't render anything, it just handles keyboard events
  return null;
}