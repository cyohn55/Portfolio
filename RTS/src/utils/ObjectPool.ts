import * as THREE from 'three';

// Object pooling for temporary vectors and matrices to reduce garbage collection
class ObjectPool<T> {
  private pool: T[] = [];
  private createFn: () => T;

  constructor(createFn: () => T, initialSize: number = 10) {
    this.createFn = createFn;
    // Pre-populate pool
    for (let i = 0; i < initialSize; i++) {
      this.pool.push(createFn());
    }
  }

  acquire(): T {
    return this.pool.pop() || this.createFn();
  }

  release(obj: T): void {
    this.pool.push(obj);
  }

  size(): number {
    return this.pool.length;
  }
}

// Pre-created pools for common objects
export const vector3Pool = new ObjectPool(() => new THREE.Vector3(), 50);
export const matrix4Pool = new ObjectPool(() => new THREE.Matrix4(), 20);
export const frustumPool = new ObjectPool(() => new THREE.Frustum(), 5);

// Utility functions for safe pool usage
export function withPooledVector3<T>(fn: (vec: THREE.Vector3) => T): T {
  const vec = vector3Pool.acquire();
  try {
    return fn(vec);
  } finally {
    vector3Pool.release(vec);
  }
}

export function withPooledMatrix4<T>(fn: (mat: THREE.Matrix4) => T): T {
  const mat = matrix4Pool.acquire();
  try {
    return fn(mat);
  } finally {
    matrix4Pool.release(mat);
  }
}

// Performance monitoring
export function getPoolStats() {
  return {
    vector3Available: vector3Pool.size(),
    matrix4Available: matrix4Pool.size(),
    frustumAvailable: frustumPool.size()
  };
}