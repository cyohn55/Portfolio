import { useFrame, useThree } from '@react-three/fiber';
import { getSimSnapshot } from '../game/state';
import { useEffect, useMemo, useRef } from 'react';

// Dynamically adapts render resolution to keep the frame rate stable as unit
// counts grow, with tighter caps on mobile where fill rate is the bottleneck.
export function PerformanceOptimizer() {
  const { gl } = useThree();
  const lastPixelRatio = useRef(-1);

  const isMobile = useMemo(
    () => typeof window !== 'undefined' && (window.innerWidth <= 768 || 'ontouchstart' in window),
    []
  );

  // Highest pixel ratio we'll ever request on this device. Mobile GPUs choke on
  // native 3x framebuffers, so cap aggressively there.
  const deviceMaxPixelRatio = useMemo(() => {
    const native = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return Math.min(native, isMobile ? 1.5 : 2);
  }, [isMobile]);

  useEffect(() => {
    // No light in the scene casts shadows, so the shadow map is pure overhead on
    // mobile — disable it to skip the renderer's shadow bookkeeping entirely.
    if (isMobile) {
      gl.shadowMap.enabled = false;
    }
  }, [gl, isMobile]);

  useFrame(() => {
    const unitCount = getSimSnapshot().units.length;

    // Step the resolution down as the battlefield fills up.
    let targetPixelRatio = deviceMaxPixelRatio;
    if (unitCount > 150) {
      targetPixelRatio = Math.min(deviceMaxPixelRatio, isMobile ? 1.0 : 1.25);
    } else if (unitCount > 80) {
      targetPixelRatio = Math.min(deviceMaxPixelRatio, isMobile ? 1.25 : 1.5);
    }

    // Only resize the drawing buffer when the target actually changes —
    // calling setPixelRatio every frame needlessly reallocates buffers.
    if (Math.abs(targetPixelRatio - lastPixelRatio.current) > 0.01) {
      gl.setPixelRatio(targetPixelRatio);
      lastPixelRatio.current = targetPixelRatio;
    }
  });

  return null; // This component only manages performance, doesn't render anything
}
