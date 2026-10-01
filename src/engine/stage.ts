/**
 * Stage: renderer + camera + post-processing + frame loop, shared by every game.
 * A game adds objects to `stage.scene`, registers an updater with `onUpdate`,
 * and calls `frame()` with the size of the area that must stay visible.
 */
import * as THREE from "three";
import {
  BloomEffect,
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  BlendFunction,
  Effect,
} from "postprocessing";

export type Updater = (dt: number, time: number) => void;

const isMobile = matchMedia("(pointer: coarse)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * three.js always creates an alpha canvas, and translucent meshes lower the
 * framebuffer alpha. The browser then treats those pixels as invalid
 * premultiplied colour and washes them out, so force the final alpha to 1.
 */
class OpaqueEffect extends Effect {
  constructor() {
    super(
      "OpaqueEffect",
      "void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(inputColor.rgb, 1.0); }",
      { blendFunction: BlendFunction.SET },
    );
  }
}

export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private updaters = new Set<Updater>();
  private timer = new THREE.Timer();
  private frameSize = new THREE.Vector2(10, 10);
  private narrowFrameWidth?: number;
  private frameCenter = new THREE.Vector3();
  private baseCameraPos = new THREE.Vector3();
  private pointer = new THREE.Vector2();
  private shake = 0;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA is done by the composer
      powerPreference: "high-performance",
      stencil: false,
      depth: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.75 : 2));
    this.renderer.toneMapping = THREE.NoToneMapping; // tone mapping happens in post
    container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer, {
      multisampling: isMobile ? 0 : 4,
      frameBufferType: THREE.HalfFloatType,
    });
    // Subtle film grain.
    const grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    grain.blendMode.opacity.value = 0.06;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(
      new EffectPass(
        this.camera,
        new BloomEffect({ mipmapBlur: true, luminanceThreshold: 0.72, luminanceSmoothing: 0.25, intensity: 1.15, radius: 0.7 }),
        new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
        // Light colour grade: AgX flattens saturation, so push it back towards Spring's rich palette.
        new HueSaturationEffect({ saturation: 0.18, hue: -0.02 }),
        new BrightnessContrastEffect({ brightness: 0, contrast: 0.12 }),
        new VignetteEffect({ offset: 0.3, darkness: 0.55 }),
        grain,
        new OpaqueEffect(),
      ),
    );

    new ResizeObserver(() => this.resize()).observe(container);
    addEventListener("pointermove", (e) => {
      this.pointer.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    });
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  onUpdate(fn: Updater): () => void {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  /**
   * Positions the camera so a `width × height` rectangle centred on `center` fills the view.
   * `narrowWidth` is the minimum width that must stay visible on portrait screens, letting
   * decorative edges (e.g. a board frame) crop instead of shrinking the gameplay.
   */
  frame(width: number, height: number, center = new THREE.Vector3(), narrowWidth?: number) {
    this.frameSize.set(width, height);
    this.narrowFrameWidth = narrowWidth;
    this.frameCenter.copy(center);
    this.fitCamera();
  }

  /** Small camera kick for impacts (big wins, landings). */
  addShake(amount: number) {
    if (reducedMotion) return;
    this.shake = Math.min(this.shake + amount, 0.6);
  }

  private fitCamera() {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const distForHeight = this.frameSize.y / 2 / Math.tan(vFov / 2);
    const width = this.camera.aspect < 0.9 && this.narrowFrameWidth ? this.narrowFrameWidth : this.frameSize.x;
    const distForWidth = width / 2 / (Math.tan(vFov / 2) * this.camera.aspect);
    const dist = Math.max(distForHeight, distForWidth) * 1.06;
    this.baseCameraPos.set(this.frameCenter.x, this.frameCenter.y, this.frameCenter.z + dist);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h, false);
    this.fitCamera();
  }

  private tick() {
    this.timer.update();
    // Clamp only real hitches (tab switches); slow devices still play in real time.
    const dt = Math.min(this.timer.getDelta(), 1 / 8);
    const time = this.timer.getElapsed();
    for (const fn of this.updaters) fn(dt, time);

    // Gentle hand-held drift + pointer parallax, like a slow dolly in a painted set.
    const p = this.baseCameraPos;
    const sway = reducedMotion ? 0 : 0.12;
    const shakeX = (Math.random() - 0.5) * this.shake;
    const shakeY = (Math.random() - 0.5) * this.shake;
    this.shake *= Math.pow(0.002, dt);
    this.camera.position.set(
      p.x + Math.sin(time * 0.31) * sway + this.pointer.x * 0.35 * (reducedMotion ? 0 : 1) + shakeX,
      p.y + Math.sin(time * 0.23) * sway * 0.6 - this.pointer.y * 0.25 * (reducedMotion ? 0 : 1) + shakeY,
      p.z,
    );
    this.camera.lookAt(this.frameCenter.x + shakeX * 0.5, this.frameCenter.y + shakeY * 0.5, this.frameCenter.z);
    this.composer.render(dt);
  }
}
