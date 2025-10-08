import { useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGameStore } from '../game/state';

interface DayNightCycleProps {
  cycleDurationSeconds?: number;
}

export function DayNightCycle({ cycleDurationSeconds = 120 }: DayNightCycleProps) {
  const lightingSettings = useGameStore((s) => s.lightingSettings);
  const isPaused = useGameStore((s) => s.isPaused);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const moonRef = useRef<THREE.DirectionalLight>(null);
  const hemisphereRef = useRef<THREE.HemisphereLight>(null);
  const sunMeshRef = useRef<THREE.Mesh>(null);
  const moonMeshRef = useRef<THREE.Mesh>(null);
  const sunGlowRef = useRef<THREE.Mesh>(null);
  const moonGlowRef = useRef<THREE.Mesh>(null);
  const sunGlow2Ref = useRef<THREE.Mesh>(null);
  const sunGlow3Ref = useRef<THREE.Mesh>(null);
  const sunGlow4Ref = useRef<THREE.Mesh>(null);
  const moonGlow2Ref = useRef<THREE.Mesh>(null);
  const moonGlow3Ref = useRef<THREE.Mesh>(null);
  const moonGlow4Ref = useRef<THREE.Mesh>(null);
  const sunLightRef = useRef<THREE.PointLight>(null);
  const moonLightRef = useRef<THREE.PointLight>(null);
  const horizonLightRef = useRef<THREE.PointLight>(null);

  const { scene } = useThree();

  const cycleSpeed = (Math.PI * 2) / (lightingSettings.dayNightSpeed || cycleDurationSeconds);

  useFrame((state, delta) => {
    // Pause the day/night cycle when game is paused
    if (isPaused) return;

    const time = state.clock.getElapsedTime();
    const angle = (time * cycleSpeed) % (Math.PI * 2);

    // Elliptical path from east to west over the battle map center
    // Battle map center is at (0, 0, 0), camera looks from above
    // Sun/Moon arc across the sky: X-axis (east-west), Y-axis (height)
    const radiusX = 275; // East-West distance (wider ellipse) - 10% wider
    const radiusY = 88;  // Height arc (not too high to stay visible) - 10% higher

    // Sun position: moves from east (+X) to west (-X), arcs in Y (up)
    const sunX = Math.cos(angle) * radiusX;
    const sunY = Math.sin(angle) * radiusY + 20; // Arc height, baseline at 20
    const sunZ = 0; // Keep centered over map Z-axis

    // Moon position: opposite of sun (180° behind on same path)
    const moonX = Math.cos(angle + Math.PI) * radiusX;
    const moonY = Math.sin(angle + Math.PI) * radiusY + 20;
    const moonZ = 0;

    // Update sun position and mesh
    if (sunRef.current && sunMeshRef.current) {
      sunRef.current.position.set(sunX, sunY, sunZ);
      sunMeshRef.current.position.set(sunX, sunY, sunZ);

      // Point sun light at battle map center for realistic shadows
      sunRef.current.target.position.set(0, 0, 0);
      sunRef.current.target.updateMatrixWorld();

      // Sun is brightest when above horizon (higher Y = brighter)
      // Add minimum intensity so sun always provides some light
      const sunIntensity = Math.max(0.5, ((sunY - 20) / radiusY)) * lightingSettings.sunBrightness;
      sunRef.current.intensity = sunIntensity;

      // Sun glow effect - always fully visible
      (sunMeshRef.current.material as THREE.MeshBasicMaterial).opacity = 1.0; // Always fully opaque

      // Update sun glow positions
      if (sunGlowRef.current) {
        sunGlowRef.current.position.set(sunX, sunY, sunZ);
      }
      if (sunGlow2Ref.current) {
        sunGlow2Ref.current.position.set(sunX, sunY, sunZ);
      }
      if (sunGlow3Ref.current) {
        sunGlow3Ref.current.position.set(sunX, sunY, sunZ);
      }
      if (sunGlow4Ref.current) {
        sunGlow4Ref.current.position.set(sunX, sunY, sunZ);
      }

      // Update sun point light position
      if (sunLightRef.current) {
        sunLightRef.current.position.set(sunX, sunY, sunZ);
      }
    }

    // Update moon position and mesh
    if (moonRef.current && moonMeshRef.current) {
      moonRef.current.position.set(moonX, moonY, moonZ);
      moonMeshRef.current.position.set(moonX, moonY, moonZ);

      // Point moon light at battle map center for realistic shadows
      moonRef.current.target.position.set(0, 0, 0);
      moonRef.current.target.updateMatrixWorld();

      // Moon is brightest when above horizon (higher Y = brighter)
      // Add minimum intensity so moon always provides some light
      const moonIntensity = Math.max(2.0, ((moonY - 20) / radiusY)) * lightingSettings.moonBrightness; // Minimum 2.0 for brighter nighttime
      moonRef.current.intensity = moonIntensity;

      // Moon glow effect - always fully visible
      (moonMeshRef.current.material as THREE.MeshBasicMaterial).opacity = 1.0; // Always fully opaque

      // Update moon glow positions
      if (moonGlowRef.current) {
        moonGlowRef.current.position.set(moonX, moonY, moonZ);
      }
      if (moonGlow2Ref.current) {
        moonGlow2Ref.current.position.set(moonX, moonY, moonZ);
      }
      if (moonGlow3Ref.current) {
        moonGlow3Ref.current.position.set(moonX, moonY, moonZ);
      }
      if (moonGlow4Ref.current) {
        moonGlow4Ref.current.position.set(moonX, moonY, moonZ);
      }

      // Update moon point light position
      if (moonLightRef.current) {
        moonLightRef.current.position.set(moonX, moonY, moonZ);
      }
    }

    // Update horizon light - increases intensity as sun/moon approach horizon
    if (horizonLightRef.current) {
      // Calculate how close the sun/moon is to the horizon
      // sunY and moonY range from (20 - radiusY) to (20 + radiusY)
      // Horizon is at Y = 20
      const horizonY = 20;
      const fortyDegreesDistance = radiusY * 0.67; // Approximate 40 degrees

      // Distance from horizon for both sun and moon
      const sunDistanceFromHorizon = Math.abs(sunY - horizonY);
      const moonDistanceFromHorizon = Math.abs(moonY - horizonY);

      // Calculate intensity based on proximity to horizon (0 when far, max when at horizon)
      let sunHorizonFactor = 0;
      if (sunDistanceFromHorizon < fortyDegreesDistance) {
        // Intensity increases as we get closer to horizon (inverse relationship)
        sunHorizonFactor = 1 - (sunDistanceFromHorizon / fortyDegreesDistance);
      }

      let moonHorizonFactor = 0;
      if (moonDistanceFromHorizon < fortyDegreesDistance) {
        moonHorizonFactor = 1 - (moonDistanceFromHorizon / fortyDegreesDistance);
      }

      // Use whichever is closer to horizon (sun or moon)
      const horizonFactor = Math.max(sunHorizonFactor, moonHorizonFactor);

      // Set intensity (0 when far from horizon, up to 8.0 at horizon)
      horizonLightRef.current.intensity = horizonFactor * 8.0;
    }

    // Update hemisphere light for ambient lighting transition
    if (hemisphereRef.current) {
      // Day: bright sky, night: dark sky
      const dayFactor = Math.max(0, Math.sin(angle));

      // Sky color transitions from day blue to night dark blue
      const skyColor = new THREE.Color().lerpColors(
        new THREE.Color(0x1a1a2e), // Night sky (dark blue)
        new THREE.Color(0x87CEEB), // Day sky (sky blue)
        dayFactor
      );

      // Ground color transitions from dark to light
      const groundColor = new THREE.Color().lerpColors(
        new THREE.Color(0x0f0f1a), // Night ground (very dark)
        new THREE.Color(0x222233), // Day ground (lighter)
        dayFactor
      );

      hemisphereRef.current.color = skyColor;
      hemisphereRef.current.groundColor = groundColor;
      hemisphereRef.current.intensity = lightingSettings.ambientLight + (dayFactor * (lightingSettings.ambientLight * 0.75)); // Dynamic based on ambient setting

      // Set background to null to allow skybox to show through
      scene.background = null;
    }
  });

  // Create sun material - bright yellow glow
  const sunMaterial = useMemo(() => {
    return new THREE.MeshBasicMaterial({
      color: 0xFFFF00, // Bright yellow
      transparent: true,
      opacity: 1.0,
    });
  }, []);

  // Create moon material - baby blue glow
  const moonMaterial = useMemo(() => {
    return new THREE.MeshBasicMaterial({
      color: 0x89CFF0, // Baby blue
      transparent: true,
      opacity: 1.0,
    });
  }, []);

  return (
    <>
      {/* Hemisphere light for ambient day/night transition - HIDDEN */}
      {/* <hemisphereLight
        ref={hemisphereRef}
        args={[0x87CEEB, 0x222233, 0.8]}
      /> */}

      {/* Sun directional light */}
      <directionalLight
        ref={sunRef}
        position={[50, 50, 30]}
        intensity={2.5}
        color={0xFFFAF0}
        castShadow={false}
      />

      {/* Moon directional light */}
      <directionalLight
        ref={moonRef}
        position={[-50, -50, 30]}
        intensity={0.0}
        color={0xB0C4DE}
        castShadow={false}
      />

      {/* Visual sun sphere - bright yellow */}
      <mesh ref={sunMeshRef} position={[250, 100, 0]}>
        <sphereGeometry args={[16, 32, 32]} />
        <primitive object={sunMaterial} attach="material" />
      </mesh>

      {/* Sun multi-layered glow effect - simulating neon glow */}
      {/* Inner soft glow */}
      <mesh ref={sunGlowRef} position={[250, 100, 0]}>
        <sphereGeometry args={[18, 32, 32]} />
        <meshBasicMaterial
          color={0xFFFF00}
          transparent
          opacity={0.9}
        />
      </mesh>

      {/* Medium intensity glow */}
      <mesh ref={sunGlow2Ref} position={[250, 100, 0]}>
        <sphereGeometry args={[22, 32, 32]} />
        <meshBasicMaterial
          color={0xFFFF00}
          transparent
          opacity={0.6}
        />
      </mesh>

      {/* Outer soft, wider glow */}
      <mesh ref={sunGlow3Ref} position={[250, 100, 0]}>
        <sphereGeometry args={[28, 32, 32]} />
        <meshBasicMaterial
          color={0xFFFF00}
          transparent
          opacity={0.4}
        />
      </mesh>

      {/* Broadest, softest layer (atmospheric light) */}
      <mesh ref={sunGlow4Ref} position={[250, 100, 0]}>
        <sphereGeometry args={[36, 32, 32]} />
        <meshBasicMaterial
          color={0xFFFF00}
          transparent
          opacity={0.2}
        />
      </mesh>

      {/* Sun point light - emits yellow light like a lightbulb */}
      <pointLight ref={sunLightRef} position={[250, 100, 0]} intensity={20} color={0xFFFF00} distance={300} decay={1} />

      {/* Visual moon sphere - baby blue */}
      <mesh ref={moonMeshRef} position={[-250, 100, 0]}>
        <sphereGeometry args={[12, 32, 32]} />
        <primitive object={moonMaterial} attach="material" />
      </mesh>

      {/* Moon multi-layered glow effect - simulating neon glow */}
      {/* Inner soft glow */}
      <mesh ref={moonGlowRef} position={[-250, 100, 0]}>
        <sphereGeometry args={[14, 32, 32]} />
        <meshBasicMaterial
          color={0x96FFFF}
          transparent
          opacity={0.9}
        />
      </mesh>

      {/* Medium intensity glow */}
      <mesh ref={moonGlow2Ref} position={[-250, 100, 0]}>
        <sphereGeometry args={[18, 32, 32]} />
        <meshBasicMaterial
          color={0x96FFFF}
          transparent
          opacity={0.6}
        />
      </mesh>

      {/* Outer soft, wider glow */}
      <mesh ref={moonGlow3Ref} position={[-250, 100, 0]}>
        <sphereGeometry args={[24, 32, 32]} />
        <meshBasicMaterial
          color={0x96FFFF}
          transparent
          opacity={0.4}
        />
      </mesh>

      {/* Broadest, softest layer (atmospheric light) */}
      <mesh ref={moonGlow4Ref} position={[-250, 100, 0]}>
        <sphereGeometry args={[32, 32, 32]} />
        <meshBasicMaterial
          color={0x96FFFF}
          transparent
          opacity={0.2}
        />
      </mesh>

      {/* Moon point light - emits baby blue light like a lightbulb */}
      <pointLight ref={moonLightRef} position={[-250, 100, 0]} intensity={20} color={0x89CFF0} distance={300} decay={1} />

      {/* Horizon light - increases intensity as sun/moon near horizon */}
      <pointLight ref={horizonLightRef} position={[0, 20, 0]} intensity={0} color={0xffd9b3} distance={250} decay={1} />

      {/* Ambient point light at center for minimal base lighting - HIDDEN */}
      {/* <pointLight position={[0, 0, 20]} intensity={5.0} color={0xffffee} distance={150} /> */}

      {/* Additional fill lights to prevent complete darkness - HIDDEN */}
      {/* <pointLight position={[50, 0, 40]} intensity={3.0} color={0xffffff} distance={200} />
      <pointLight position={[-50, 0, 40]} intensity={3.0} color={0xffffff} distance={200} /> */}
    </>
  );
}
