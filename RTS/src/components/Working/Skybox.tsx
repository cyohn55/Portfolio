import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

export function Skybox() {
  console.log('🌌 SKYBOX GLTF VERSION LOADING');
  const { scene } = useGLTF('/models/nebula_skybox/scene.gltf');
  const groupRef = useRef<THREE.Group>(null);

  // Create quaternions for rotation (avoids gimbal lock)
  const worldZAxis = useRef(new THREE.Vector3(0, 0, 1)); // World-space Z axis

  // Create initial quaternion in useMemo so it updates when component remounts
  const initialQuaternion = useMemo(() => {
    // Create quaternions for X and Y rotations
    const quatX = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2 // 90 degrees X
    );
    const quatY = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2 + Math.PI / 2 // 180 degrees Y (90 + 90)
    );

    // Combine rotations: first X, then Y
    return quatX.multiply(quatY);
  }, []);

  // Process the scene to make materials visible from inside
  const processedScene = useMemo(() => {
    const clonedScene = scene.clone();

    console.log('🔍 Skybox GLTF structure:', clonedScene);

    let meshCount = 0;
    clonedScene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        meshCount++;
        console.log(`📦 Found mesh #${meshCount} in skybox:`, {
          name: child.name,
          geometry: child.geometry.type,
          vertexCount: child.geometry.attributes.position?.count,
          material: child.material,
          materialType: child.material?.type,
          position: child.position,
          scale: child.scale,
          visible: child.visible
        });

        // Make material render on both sides so we can see from inside and outside
        if (child.material) {
          const mat = child.material as THREE.Material;
          mat.side = THREE.DoubleSide; // Render both inside and outside faces
          mat.depthWrite = false; // Don't interfere with other objects
          console.log(`🎨 Set material to DoubleSide for mesh #${meshCount}:`, child.name);
        }
      }
    });

    console.log(`✅ Total meshes found in skybox: ${meshCount}`);

    console.log('🔍 Skybox scene processed, children:', clonedScene.children.length);
    return clonedScene;
  }, [scene]);

  // Apply initial rotation with quaternions and continuous Z rotation
  useFrame((state, delta) => {
    if (groupRef.current) {
      // Set initial rotation using quaternions only once (on first frame)
      if (groupRef.current.userData.initialRotationSet !== true) {
        groupRef.current.quaternion.copy(initialQuaternion);
        groupRef.current.userData.initialRotationSet = true;
        console.log('🔄 Skybox GLTF: Initial rotation applied via quaternions - X=90°, Y=180°');
      }

      // Continuous rotation around world-space Z-axis using quaternions
      // This avoids gimbal lock by rotating around a fixed world axis
      const rotationSpeed = 0.1 * delta; // Slower for testing visibility
      const zRotationQuat = new THREE.Quaternion().setFromAxisAngle(
        worldZAxis.current,
        rotationSpeed
      );

      // Apply Z rotation to existing quaternion (pre-multiply for world-space rotation)
      groupRef.current.quaternion.premultiply(zRotationQuat);

      // Log every 2 seconds with rotation info
      if (Math.floor(state.clock.elapsedTime) % 2 === 0 && state.clock.elapsedTime % 2 < delta) {
        // Convert quaternion back to Euler for logging
        const euler = new THREE.Euler().setFromQuaternion(groupRef.current.quaternion);
        console.log('🌀 Skybox rotation:', {
          z: (euler.z * 180 / Math.PI).toFixed(1) + '°',
          time: state.clock.elapsedTime.toFixed(1)
        });
      }
    }
  });

  // Battle map dimensions: X=[-77, 76.5], Z=[-248, 252], Y≈0.25
  // Camera range: 75-200 units above map
  // Camera far plane: 200000 units
  // Original model: 79,775 units radius (159,550 diameter)

  // The skybox should be massive - scaled down 30% from original
  const scale = 0.70; // 70% of original size (55,842 unit radius)

  // Center the skybox at the battle map center
  // Map center: X≈0, Y≈0, Z≈2 (midpoint between -248 and 252)
  const skyboxCenter = { x: 0, y: 0, z: 2 };

  return (
    <group ref={groupRef} scale={[scale, scale, scale]} position={[skyboxCenter.x, skyboxCenter.y, skyboxCenter.z]}>
      <primitive object={processedScene} />
    </group>
  );
}

// Preload the skybox model
useGLTF.preload('/models/nebula_skybox/scene.gltf');
