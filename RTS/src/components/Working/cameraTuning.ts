// Bridge between the F5 camera admin panel and the live CameraController frame
// loop for the one value that can't live in the settings store: the current zoom
// distance. The mouse wheel mutates that distance every frame, so storing it in
// Zustand would thrash the store (and every subscriber) on each scroll tick. It
// therefore stays a ref inside CameraController; this singleton lets the panel
// read it (to show the live value) and nudge it (a "set zoom" slider) without
// forcing a React re-render of the render loop.
//
// Mirrors the existing imperative-singleton pattern used for pilotInput,
// edgePanIndicator, and gamepadInput. Null accessors mean no CameraController is
// currently mounted (e.g. on the menu), so calls are safely ignored.

type DistanceGetter = () => number;
type DistanceSetter = (distance: number) => void;

class CameraRuntime {
  private getDistanceFn: DistanceGetter | null = null;
  private setDistanceFn: DistanceSetter | null = null;

  /**
   * Called by CameraController on mount to expose its live zoom-distance ref.
   * Pass matching getter/setter closures over the same ref.
   */
  bind(getDistance: DistanceGetter, setDistance: DistanceSetter): void {
    this.getDistanceFn = getDistance;
    this.setDistanceFn = setDistance;
  }

  /** Called on CameraController unmount so stale closures aren't retained. */
  unbind(): void {
    this.getDistanceFn = null;
    this.setDistanceFn = null;
  }

  /** Current orbit distance, or null when no camera is mounted. */
  getDistance(): number | null {
    return this.getDistanceFn ? this.getDistanceFn() : null;
  }

  /** Set the live orbit distance; ignored when no camera is mounted. */
  setDistance(distance: number): void {
    if (this.setDistanceFn) {
      this.setDistanceFn(distance);
    }
  }

  /** Whether a CameraController is currently mounted and accepting input. */
  isActive(): boolean {
    return this.getDistanceFn !== null;
  }
}

export const cameraRuntime = new CameraRuntime();
