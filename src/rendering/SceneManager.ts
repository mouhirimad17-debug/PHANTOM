import {
  AmbientLight,
  DirectionalLight,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  Timer,
  WebGLRenderer,
} from 'three';

export type FrameListener = (deltaTimeSeconds: number, elapsedSeconds: number) => void;

const MAX_DEVICE_PIXEL_RATIO = 2;
const CAMERA_FOV_DEGREES = 60;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 50;
const FLOOR_SIZE = 40;
const FLOOR_Y = -1.4;

/**
 * Owns the Three.js scene, camera, renderer, lighting, and the render/animation
 * loop. Rendered on a transparent canvas so it can be composited on top of the
 * live camera <video> element by the page layout.
 */
export class SceneManager {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly floor: Mesh;

  private readonly timer = new Timer();
  private readonly listeners = new Set<FrameListener>();
  private readonly afterRenderListeners = new Set<FrameListener>();
  private rafHandle: number | null = null;
  private container: HTMLElement | null = null;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.scene = new Scene();

    this.camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 0, 0);

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch (err) {
      throw new Error('WebGL is unavailable in this browser.', { cause: err });
    }
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer = renderer;

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.stop();
    });

    const ambient = new AmbientLight(0xffffff, 0.6);
    const key = new DirectionalLight(0xffffff, 1.2);
    key.position.set(2, 4, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(ambient, key);

    this.floor = new Mesh(
      new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new ShadowMaterial({ opacity: 0.35 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = FLOOR_Y;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.timer.connect(document);
  }

  /** Attaches to a container element and sizes the renderer to fill it. */
  attach(container: HTMLElement): void {
    this.container = container;
    this.resizeObserver.observe(container);
    this.handleResize();
  }

  private handleResize(): void {
    if (!this.container) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, true);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Like `onFrame`, but fires immediately AFTER `renderer.render()` for
   * that tick rather than before it. `onFrame` listeners run first
   * specifically so effects can update the scene graph in time for that
   * same frame's render call — reordering that would make every effect
   * lag a frame behind. Anything that needs to read the just-rendered
   * canvas pixels (e.g. RecordingManager compositing it with the camera
   * feed) needs this hook instead, or it would capture the previous
   * frame's content.
   */
  onAfterRender(listener: FrameListener): () => void {
    this.afterRenderListeners.add(listener);
    return () => this.afterRenderListeners.delete(listener);
  }

  start(): void {
    if (this.rafHandle !== null) return;
    this.timer.reset();
    const tick = (timestamp: number): void => {
      this.timer.update(timestamp);
      const delta = this.timer.getDelta();
      const elapsed = this.timer.getElapsed();
      for (const listener of this.listeners) {
        listener(delta, elapsed);
      }
      this.renderer.render(this.scene, this.camera);
      for (const listener of this.afterRenderListeners) {
        listener(delta, elapsed);
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  dispose(): void {
    this.stop();
    this.timer.dispose();
    this.resizeObserver.disconnect();
    this.listeners.clear();
    this.afterRenderListeners.clear();
    this.renderer.dispose();
  }
}
