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
import type { BoardBounds } from "./PlinkoBoard";

type Clip = "idle" | "drop" | "tension" | "happy" | "bigWin" | "sad";
const CLIPS: Clip[] = ["idle", "drop", "tension", "happy", "bigWin", "sad"];
/** A reaction never interrupts a more important one. */
const PRIORITY: Record<Clip, number> = { idle: 0, drop: 1, tension: 2, sad: 3, happy: 3, bigWin: 4 };
const HEIGHT = 3.2; // character height in world units (the 3D mascot is 2.6)
const FRAME = HEIGHT / 0.72; // the character fills ~72% of the square clip
const FEET = 0.36; // its feet sit this far (in frames) below the clip's centre
const FADE = 0.4;
/** The idle pose's ear tip, right of the clip's centre (in frames). */
const IDLE_RIGHT = 0.31;
/** On a small screen the mascot grows to at least this many CSS pixels tall, room permitting. */
const MIN_SCREEN_HEIGHT = 110;
/** World units kept between the mascot's ear and the leftmost bucket. */
const BUCKET_GAP = 0.15;

/**
 * The clips are "stacked alpha" H.264: the colour frame on top, its alpha as grey below, with a
 * black gap so filtering never bleeds one into the other (layout set by scripts/mascot-video.ts).
 * Video with a real alpha channel can't be used: iOS drops HEVC's alpha when it uploads a frame
 * to WebGL (the mascot showed on a black square), and plain H.264 plays in every browser.
 */
const CLIP_SIZE = 512;
const CLIP_GAP = 16;

function loadVideo(clip: Clip): HTMLVideoElement {
  const video = document.createElement("video");
  // Attributes as well as properties: iOS checks them for muted inline autoplay.
  video.muted = true;
  video.setAttribute("muted", "");
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.preload = "auto";
  video.loop = clip === "idle";
  video.src = `/mascot/${clip}.mp4`;
  return video;
}

/**
 * iOS ignores `preload`: only playing loads a clip. Load its first frames, then park it at 0
 * (unless a reaction started using it meanwhile).
 */
function warmUp(video: HTMLVideoElement, inUse: () => boolean) {
  video
    .play()
    .then(() => {
      if (inUse()) return;
      video.pause();
      video.currentTime = 0;
    })
    .catch(() => undefined);
}

/**
 * Dissolve between two clips in one draw: colour is blended premultiplied by alpha, so where
 * both frames show the mascot it stays opaque (two faded planes would turn see-through).
 */
function addDissolve(mat: THREE.MeshBasicMaterial, u: { uTo: { value: THREE.Texture | null }; uMix: { value: number } }) {
  // Texture v of each half (flipY: v = 1 is the video's top row).
  const height = CLIP_SIZE * 2 + CLIP_GAP;
  const colourV0 = ((CLIP_SIZE + CLIP_GAP) / height).toFixed(6);
  const alphaV1 = (CLIP_SIZE / height).toFixed(6);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uTo;
        uniform float uMix;
        vec4 stackedAlpha(sampler2D tex, vec2 uv) {
          vec4 colour = vec4(texture2D(tex, vec2(uv.x, ${colourV0} + uv.y * (1.0 - ${colourV0}))).rgb, 1.0);
          #ifdef DECODE_VIDEO_TEXTURE
          // Video frames are sRGB-decoded in the shader (three's map_fragment does the same).
          colour = sRGBTransferEOTF(colour);
          #endif
          // Alpha is stored as is, so it skips the sRGB decode.
          return vec4(colour.rgb, texture2D(tex, vec2(uv.x, uv.y * ${alphaV1})).g);
        }`,
      )
      .replace(
        "#include <map_fragment>",
        `vec4 fromC = stackedAlpha(map, vMapUv);
        vec4 toC = stackedAlpha(uTo, vMapUv);
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
  private bounds?: BoardBounds;

  /**
   * Resolves once the idle can play, or undefined when the clips are missing. When the browser
   * blocks even muted autoplay (iOS Low Power Mode), it still resolves and the clips start on
   * the player's first tap.
   */
  static async load(stage: Stage): Promise<VideoMascot | undefined> {
    const videos = new Map(CLIPS.map((clip) => [clip, loadVideo(clip)] as const));
    const idle = videos.get("idle")!;
    let blocked = false;
    const ok = await new Promise<boolean>((resolve) => {
      for (const event of ["loadeddata", "playing"]) idle.addEventListener(event, () => resolve(true), { once: true });
      idle.addEventListener("error", () => resolve(false), { once: true });
      idle.play().catch((err: DOMException) => {
        if (err.name !== "NotAllowedError") return;
        blocked = true;
        resolve(true);
      });
      setTimeout(() => resolve(false), 10_000);
    });
    if (!ok) return undefined;
    return new VideoMascot(stage, videos, blocked);
  }

  private constructor(
    private stage: Stage,
    videos: Map<Clip, HTMLVideoElement>,
    autoplayBlocked: boolean,
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
    const start = () => {
      void this.videos.get(this.current)!.play().catch(() => undefined);
      for (const [clip, video] of this.videos) {
        if (clip !== this.current && video.readyState < 2) warmUp(video, () => clip === this.from || clip === this.to);
      }
    };
    if (autoplayBlocked) {
      this.mesh.visible = false;
      const unlock = () => {
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
        this.mesh.visible = true;
        start();
      };
      window.addEventListener("pointerdown", unlock);
      window.addEventListener("keydown", unlock);
    } else {
      start();
    }
    stage.onUpdate(() => this.update());
  }

  /** Where the mascot sits; called whenever the board is rebuilt. */
  place(bounds: BoardBounds) {
    this.bounds = bounds;
    // Perch on the frame's lower corner, in front of the tilted board's bottom edge.
    this.root.position.y = bounds.bottom + 1.5;
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
    // Checked before rewinding: the seek itself briefly drops a loaded clip's readyState.
    const loaded = video.readyState >= 2;
    if (clip !== "idle" || this.current !== "idle") video.currentTime = 0;
    void video.play().catch(() => undefined);
    this.current = clip;

    // A clip that has not loaded yet (iOS) joins the blend once it can play.
    if (!loaded) {
      const join = () => {
        video.removeEventListener("canplay", join);
        video.removeEventListener("playing", join);
        if (this.current === clip) this.blendTo(clip);
      };
      video.addEventListener("canplay", join);
      video.addEventListener("playing", join);
      return;
    }
    this.blendTo(clip);
  }

  private blendTo(clip: Clip) {
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

  /**
   * Beside the frame when there is room; otherwise over its lower-left corner. On a small screen
   * (a phone) it grows to stay readable, as far as it can without covering the leftmost bucket.
   */
  private fitToView() {
    const z = this.root.position.z;
    const { halfW, halfH } = this.stage.viewHalfSize(z);
    const boardHalf = this.bounds?.halfWidth ?? 6;
    if (this.stage.camera.aspect < 1) {
      this.root.position.x = -Math.min(boardHalf + HEIGHT * 0.5, halfW - HEIGHT * 0.42);
      this.root.scale.setScalar(0.8);
      return;
    }
    let scale = Math.max(1, MIN_SCREEN_HEIGHT / ((HEIGHT * this.stage.renderer.domElement.clientHeight) / (2 * halfH)));
    if (scale > 1 && this.bounds) {
      // The bucket edge seen at the mascot's depth (the resting camera looks along x = 0).
      const edge = this.bounds.bucketEdge;
      const clearX = (edge.x * halfW) / this.stage.viewHalfSize(edge.z).halfW - BUCKET_GAP;
      scale = Math.max(1, Math.min(scale, (clearX + halfW) / (HEIGHT * 0.42 + IDLE_RIGHT * FRAME)));
    }
    this.root.position.x = -Math.min(boardHalf + HEIGHT * 0.5 * scale, halfW - HEIGHT * 0.42 * scale);
    this.root.scale.setScalar(scale);
  }
}
