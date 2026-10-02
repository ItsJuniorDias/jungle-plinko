/**
 * The mascot as AI-generated video clips with alpha (public/mascot/, made by
 * `npm run mascot`): an idle loop plus one clip per reaction. Clips dissolve into each other
 * (both playing during the blend), and a reaction dissolves back into the idle just before it
 * ends, so the clips never need to match frame-perfectly. Same hooks as the 3D Mascot, which
 * stays as the fallback.
 */
import * as THREE from "three";
import gsap from "gsap";
import type { Stage } from "../../engine/stage";

type Clip = "idle" | "drop" | "tension" | "happy" | "bigWin" | "sad";
const CLIPS: Clip[] = ["idle", "drop", "tension", "happy", "bigWin", "sad"];
/** A reaction never interrupts a more important one. */
const PRIORITY: Record<Clip, number> = { idle: 0, drop: 1, tension: 2, sad: 3, happy: 3, bigWin: 4 };
const HEIGHT = 3.2; // character height in world units (the 3D mascot is 2.6)
const FRAME = HEIGHT / 0.72; // the character fills ~72% of the square clip
const FEET = 0.36; // its feet sit this far (in frames) below the clip's centre
const FADE = 0.4;

/** Safari plays HEVC with alpha (.mov); the other browsers VP9 with alpha (.webm). */
const EXT = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent) ? "mov" : "webm";

function loadVideo(clip: Clip): HTMLVideoElement {
  const video = document.createElement("video");
  video.src = `/mascot/${clip}.${EXT}`;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.loop = clip === "idle";
  return video;
}

/**
 * Dissolve between two clips in one draw: colour is blended premultiplied by alpha, so where
 * both frames show the mascot it stays opaque (two faded planes would turn see-through).
 */
function addDissolve(mat: THREE.MeshBasicMaterial, u: { uTo: { value: THREE.Texture | null }; uMix: { value: number } }) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uTo;\nuniform float uMix;")
      .replace(
        "#include <map_fragment>",
        `vec4 fromC = texture2D(map, vMapUv);
        vec4 toC = texture2D(uTo, vMapUv);
        #ifdef DECODE_VIDEO_TEXTURE
        // Video frames are sRGB-decoded in the shader (three's map_fragment does the same).
        fromC = sRGBTransferEOTF(fromC);
        toC = sRGBTransferEOTF(toC);
        #endif
        float mixA = mix(fromC.a, toC.a, uMix);
        diffuseColor *= vec4(mix(fromC.rgb * fromC.a, toC.rgb * toC.a, uMix) / max(mixA, 1e-4), mixA);`,
      );
  };
  mat.customProgramCacheKey = () => "mascot-dissolve";
}

export class VideoMascot {
  readonly root = new THREE.Group();
  private videos = new Map<Clip, HTMLVideoElement>();
  private textures = new Map<Clip, THREE.VideoTexture>();
  private mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private blend = { uTo: { value: null as THREE.Texture | null }, uMix: { value: 0 } };
  /** Clip on screen (`from`) and the one dissolving in (`to`, equal when no blend runs). */
  private from: Clip = "idle";
  private to: Clip = "idle";
  private current: Clip = "idle";

  /** Resolves once the idle can play, or undefined when the clips are missing. */
  static async load(stage: Stage): Promise<VideoMascot | undefined> {
    const videos = new Map(CLIPS.map((clip) => [clip, loadVideo(clip)] as const));
    const idle = videos.get("idle")!;
    const ok = await new Promise<boolean>((resolve) => {
      idle.addEventListener("loadeddata", () => resolve(true), { once: true });
      idle.addEventListener("error", () => resolve(false), { once: true });
      setTimeout(() => resolve(false), 10_000);
    });
    return ok ? new VideoMascot(stage, videos) : undefined;
  }

  private constructor(
    private stage: Stage,
    videos: Map<Clip, HTMLVideoElement>,
  ) {
    this.videos = videos;
    for (const [clip, video] of videos) {
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(clip, tex);
    }
    const material = new THREE.MeshBasicMaterial({ map: this.textures.get("idle")!, transparent: true, depthWrite: false, fog: false });
    addDissolve(material, this.blend);
    this.blend.uTo.value = material.map;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(FRAME, FRAME).translate(0, FEET * FRAME, 0), material);
    this.mesh.renderOrder = 20;
    this.root.add(this.mesh);
    stage.scene.add(this.root);
    void this.videos.get("idle")!.play().catch(() => undefined);
    stage.onUpdate(() => this.update());
  }

  /** Where the mascot sits; called whenever the board is rebuilt. */
  place(boardHalfWidth: number, groundY: number) {
    this.root.userData.boardHalfWidth = boardHalfWidth;
    // Perch on the frame's lower corner, in front of the tilted board's bottom edge.
    this.root.position.y = groundY + 1.5;
    this.root.position.z = 2.4;
  }

  /** The clips face the board on their own: nothing to aim. */
  watch(_x: number | null) {}

  onPegHit() {}

  onDrop() {
    this.react("drop");
  }

  onTension() {
    this.react("tension");
  }

  onLand(multiplier: number) {
    if (multiplier >= 10) this.react("bigWin");
    else if (multiplier >= 2) this.react("happy");
    else if (multiplier < 1) this.react("sad");
  }

  private react(clip: Clip) {
    if (this.current !== "idle" && PRIORITY[this.current] >= PRIORITY[clip]) return;
    this.show(clip);
  }

  private show(clip: Clip) {
    const video = this.videos.get(clip)!;
    if (clip !== "idle" || this.current !== "idle") video.currentTime = 0;
    void video.play().catch(() => undefined);
    this.current = clip;

    // A blend still running ends where it is headed; the new one starts from there.
    gsap.killTweensOf(this.blend.uMix);
    this.settle();
    if (clip === this.from) return;
    this.to = clip;
    this.blend.uTo.value = this.textures.get(clip)!;
    this.blend.uMix.value = 0;
    gsap.to(this.blend.uMix, { value: 1, duration: FADE, ease: "sine.inOut", onComplete: () => this.settle() });
  }

  /** Makes the incoming clip the one on screen and stops the outgoing one. */
  private settle() {
    if (this.from === this.to) return;
    const mat = this.mesh.material;
    if (this.from !== this.current) this.videos.get(this.from)!.pause();
    this.from = this.to;
    mat.map = this.textures.get(this.from)!;
    this.blend.uMix.value = 0;
  }

  private update() {
    this.fitToView();
    // Fade back into the idle just before a reaction ends (its last frame need not match).
    if (this.current !== "idle") {
      const video = this.videos.get(this.current)!;
      if (video.ended || (video.duration && video.currentTime >= video.duration - FADE)) this.show("idle");
    }
  }

  /** Beside the frame when there is room; otherwise over its lower-left corner, a bit smaller. */
  private fitToView() {
    const { halfW } = this.stage.viewHalfSize(this.root.position.z);
    const boardHalf: number = this.root.userData.boardHalfWidth ?? 6;
    const portrait = this.stage.camera.aspect < 1;
    this.root.position.x = -Math.min(boardHalf + HEIGHT * 0.5, halfW - HEIGHT * 0.42);
    this.root.scale.setScalar(portrait ? 0.8 : 1);
  }
}
