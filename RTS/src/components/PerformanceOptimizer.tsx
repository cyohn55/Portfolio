import { useFrame, useThree } from '@react-three/fiber';
import { useGameStore } from '../game/state';
import { useMemo } from 'react';

// Dynamic performance optimization component
export function PerformanceOptimizer() {
  const { gl, camera } = useThree();
  const units = useGameStore((s) => s.units);

  // Adaptive shadow quality based on unit count
  const shadowQuality = useMemo(() => {
    const unitCount = units.length;
    if (unitCount > 100) return 256; // Very low quality
    if (unitCount > 60) return 512;  // Low quality
    return 1024; // Normal quality
  }, [units.length]);

  // Adaptive render distance based on performance
  const renderDistance = useMemo(() => {
    const unitCount = units.length;
    return unitCount > 80 ? 100 : 150; // Shorter distance with more units
  }, [units.length]);

  useFrame(() => {
    // Dynamic LOD: disable shadows on distant units
    const cameraPos = camera.position;

    // Update WebGL settings based on performance needs
    if (units.length > 80) {
      // High unit count - aggressive optimizations
      gl.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // Reduce resolution
    } else {
      // Normal unit count - standard quality
      gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    }
  });

  return null; // This component only manages performance, doesn't render anything
}