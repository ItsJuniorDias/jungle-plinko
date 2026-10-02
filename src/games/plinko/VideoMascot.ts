/**
 * The mascot as AI-generated video clips with alpha (public/mascot/, made by
 * `npm run mascot`): an idle loop plus one clip per reaction. Each reaction fades in over the
 * idle and fades back into it just before it ends, so the clips never need to match
 * frame-perfectly. Same hooks as the 3D Mascot, which stays as the fallback.
 */
import * as THREE from "three";
import gsap from "gsap";
import type { Stage } from "../../engine/stage";

type Clip = "idle" | "drop" | "tension" | "happy" | "bigWin" | "sad";
const CLIPS: Clip[] = ["idle", "drop", "tension", "happy", "bigWin", "sad"];
/** A reaction never interrupts a more important one. */
const PRIORITY: Record<Clip, number> = { idle: 0, drop: 1, tension: 2, sad: 3, happy: 3, bigWin: 4 };
const HEIGHT = 2.6; // character height in world units, like the 3D mascot
const FRAME = HEIGHT / 0.72; // the character fills ~72% of the square clip
const FEET = 0.36; // its feet sit this far (in frames) below the clip's centre
const FADE = 0.2;

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

interface Layer {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  clip?: Clip;
}

export class VideoMascot {
  readonly root = new THREE.Group();
  private videos = new Map<Clip, HTMLVideoElement>();
  private textures = new Map<Clip, THREE.VideoTexture>();
  /** Two stacked planes: the incoming clip fades in on top of the outgoing one. */
  private layers: Layer[];
  private top = 0;
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
    const geo = new THREE.PlaneGeometry(FRAME, FRAME).translate(0, FEET * FRAME, 0);
    this.layers = [0, 1].map(() => {
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, fog: false }));
      mesh.visible = false;
      this.root.add(mesh);
      return { mesh };
    });
    stage.scene.add(this.root);
    this.show("idle");
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

    const incoming = this.layers[1 - this.top];
    const outgoing = this.layers[this.top];
    this.top = 1 - this.top;
    incoming.clip = clip;
    incoming.mesh.material.map = this.textures.get(clip)!;
    incoming.mesh.material.needsUpdate = true;
    incoming.mesh.visible = true;
    incoming.mesh.renderOrder = 21;
    outgoing.mesh.renderOrder = 20;
    // The outgoing clip stays opaque underneath, so the mascot never turns see-through mid-fade.
    gsap.killTweensOf(incoming.mesh.material);
    gsap.fromTo(incoming.mesh.material, { opacity: outgoing.mesh.visible ? 0 : 1 }, {
      opacity: 1,
      duration: FADE,
      ease: "power1.out",
      onComplete: () => {
        outgoing.mesh.visible = false;
        if (outgoing.clip && outgoing.clip !== clip) this.videos.get(outgoing.clip)!.pause();
      },
    });
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
