/**
 * gamepadInput — a tiny module-level singleton that carries the controller's
 * *camera* intent from the gamepad poller (GamepadController) to the sole owner
 * of the camera (CameraController).
 *
 * CameraController already mutates the camera target/distance every frame from
 * keyboard + mouse input. Rather than give the gamepad poller a second, racing
 * writer to those refs, the poller only publishes its intent here and
 * CameraController folds it into its existing per-frame update. This keeps a
 * single camera writer (low coupling) while letting an out-of-canvas concern
 * stay out of CameraController.
 *
 * Mirrors the pattern of utils/keyboardCoordination.ts (a shared input mediator
 * implemented as a module singleton).
 */
export interface GamepadCameraIntent {
  /** Strafe intent on the camera-right axis, -1 (left) .. 1 (right). */
  panX: number;
  /** Strafe intent on the camera-forward axis, -1 (back) .. 1 (forward). */
  panZ: number;
  /** Zoom intent, -1 (zoom in) .. 1 (zoom out); applied per-frame as a rate. */
  zoom: number;
}

const cameraIntent: GamepadCameraIntent = { panX: 0, panZ: 0, zoom: 0 };

export const gamepadInput = {
  /** Called by the poller each frame with the resolved analog camera intent. */
  setCameraIntent(panX: number, panZ: number, zoom: number): void {
    cameraIntent.panX = panX;
    cameraIntent.panZ = panZ;
    cameraIntent.zoom = zoom;
  },

  /** Read by CameraController each frame; returns the live intent object. */
  getCameraIntent(): Readonly<GamepadCameraIntent> {
    return cameraIntent;
  },

  /** Zero the intent when the poller unmounts so the camera doesn't drift. */
  reset(): void {
    cameraIntent.panX = 0;
    cameraIntent.panZ = 0;
    cameraIntent.zoom = 0;
  },
};
