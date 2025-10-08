// Simple global state to coordinate between keyboard shortcuts and camera controller
class KeyboardCoordinator {
  private cameraInputBlocked = false;
  private blockTimeout: NodeJS.Timeout | null = null;

  // Block camera input for specified duration (in milliseconds)
  blockCameraInput(duration: number = 1000) {
    this.cameraInputBlocked = true;

    // Clear existing timeout if any
    if (this.blockTimeout) {
      clearTimeout(this.blockTimeout);
    }

    // Set new timeout to unblock input
    this.blockTimeout = setTimeout(() => {
      this.cameraInputBlocked = false;
      this.blockTimeout = null;
    }, duration);


  }

  // Check if camera input should be ignored
  isCameraInputBlocked(): boolean {
    return this.cameraInputBlocked;
  }

  // Cleanup method
  cleanup() {
    if (this.blockTimeout) {
      clearTimeout(this.blockTimeout);
      this.blockTimeout = null;
    }
    this.cameraInputBlocked = false;
  }
}

// Export singleton instance
export const keyboardCoordinator = new KeyboardCoordinator();