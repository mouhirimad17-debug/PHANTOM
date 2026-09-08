/** Rolling average FPS from per-frame delta times, updated once per second. */
export class FpsCounter {
  private accumulatedTime = 0;
  private frameCount = 0;
  private fps = 0;

  update(deltaTimeSeconds: number): void {
    this.accumulatedTime += deltaTimeSeconds;
    this.frameCount++;
    if (this.accumulatedTime >= 1) {
      this.fps = this.frameCount / this.accumulatedTime;
      this.accumulatedTime = 0;
      this.frameCount = 0;
    }
  }

  getFps(): number {
    return this.fps;
  }
}
