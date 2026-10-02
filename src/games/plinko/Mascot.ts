/**
 * The jungle mascot (AI-generated GLB) sitting beside the board and reacting to
 * every play. It has no skeleton yet, so all acting is whole-body "puppet"
 * animation — but driven by damped SPRINGS rather than raw tweens:
 *
 *   reactions / idle fidgets / gaze  →  set TARGETS for each pose channel
 *   springs                          →  chase the targets with lag, overshoot and settle
 *
 * That lag-and-overshoot is what gives follow-through and overlapping action
 * (a hop's landing keeps squashing after the feet touch, a turn swings past and
 * comes back), so the body never snaps from pose to pose.
 */
import * as THREE from "three";
import gsap from "gsap";
import type { Stage } from "../../engine/stage";
import { springMaterial, springify } from "../../engine/materials";
import { ParticleBurst } from "../../engine/particles";

const HEIGHT = 2.6; // world units (the board is 12 tall)
const BASE_YAW = 0.5; // sits left of the board, turned three-quarters towards it
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

type Channel = "hop" | "squash" | "yaw" | "lean" | "tilt" | "lidTop" | "lidLow";

/**
 * Eyes of mascot.glb in model space (height-normalised, glTF Y-up). Found by ray-casting
 * the iris centres from a front view of the model in Blender. Re-measure if the model changes.
 */
const EYES = [
  { center: [-0.0486, 0.659, 0.5693], normal: [-0.4782, 0.2648, 0.8374], radius: 0.07 },
  { center: [0.1998, 0.6914, 0.5838], normal: [0.2068, 0.4001, 0.8928], radius: 0.071 },
] as const;
/** Lid colour: the dark brown mask painted around the eyes. */
const LID_COLOR = "#4a2618";

/** A damped spring per channel: stiffness k and damping c tuned per body part "weight". */
class Spring {
  value = 0;
  velocity = 0;
  target = 0;
  constructor(
    private k: number,
    private c: number,
  ) {}
  step(dt: number) {
    // Semi-implicit Euler with sub-steps: stable at low frame rates too.
    const n = Math.ceil(dt / (1 / 120));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.velocity += (this.k * (this.target - this.value) - this.c * this.velocity) * h;
      this.value += this.velocity * h;
    }
  }
  kick(v: number) {
    this.velocity += v;
  }
}

export class Mascot {
  readonly root = new THREE.Group();
  private pivot = new THREE.Group(); // feet-anchored: squash happens around the ground
  private springs: Record<Channel, Spring> = {
    hop: new Spring(140, 14), // heavy-ish body: bouncy landing
    squash: new Spring(260, 9), // jelly: lots of overshoot (follow-through)
    yaw: new Spring(60, 9), // turning the whole body lags behind the intent
    lean: new Spring(90, 10),
    tilt: new Spring(70, 7),
    lidTop: new Spring(900, 45), // eyelids are light and quick, barely any overshoot
    lidLow: new Spring(500, 34),
  };
  /** Targets authored by reactions (timelines tween these, springs follow them). */
  private intent: Record<Channel, number> = { hop: 0, squash: 0, yaw: 0, lean: 0, tilt: 0, lidTop: 0, lidLow: 0 };
  private lids: { top: THREE.Mesh; low: THREE.Mesh }[] = [];
  private blink = 0; // extra upper-lid closure from blinking, 0..1
  private nextBlink = 1.5;
  private spin = 0; // full pirouettes (tweened directly: a spring would fight a 2π turn)
  private tremble = 0;
  private reaction?: gsap.core.Timeline;
  private lookTarget: number | null = null;
  private tense = false;
  private time = 0;
  private nextFidget = 2.5;
  private particles = new ParticleBurst(240, 0.3, -6);

  constructor(
    private stage: Stage,
    model: THREE.Object3D,
  ) {
    // Spring-style backlit fur: strong warm rim around the silhouette.
    springify(model, { rimColor: "#ffd59a", rimStrength: 1.15, rimPower: 2.2 });
    model.scale.setScalar(HEIGHT);
    this.buildEyelids(model);
    stage.scene.add(this.particles.points);
    this.pivot.add(model);
    this.root.add(this.pivot);
    stage.scene.add(this.root);
    stage.onUpdate((dt) => this.update(dt));
  }

  /** Where the mascot sits; called whenever the board is rebuilt. */
  place(boardHalfWidth: number, groundY: number, topY: number) {
    this.root.userData.boardHalfWidth = boardHalfWidth;
    this.root.userData.groundY = groundY;
    this.root.userData.topY = topY;
    // In front of the tilted board's bottom edge, which leans towards the camera.
    this.root.position.z = 2.4;
  }

  /** World X of the ball the mascot should watch (null = none in flight). */
  watch(x: number | null) {
    this.lookTarget = x;
  }

  /** Each peg hit while watching: a tiny sympathetic flinch. */
  onPegHit() {
    if (this.reaction?.isActive()) return;
    this.springs.squash.kick(0.35);
  }

  /** A ball was released: crouch, then a little bob of anticipation. */
  onDrop() {
    if (this.reaction?.isActive() && this.reaction.data !== "drop" && this.reaction.data !== "fidget") return;
    this.play("drop", (tl) =>
      tl.to(this.intent, { squash: 0.12, duration: 0.1 })
        .to(this.intent, { squash: -0.04, hop: 0.18, duration: 0.12 })
        .to(this.intent, { squash: 0, hop: 0, duration: 0.15 }),
    );
  }

  /** A ball is about to land in a high-paying bucket: lean in and hold breath. */
  onTension() {
    if (this.tense) return;
    this.tense = true;
    this.play("tension", (tl) =>
      tl.to(this.intent, { lean: 0.26, squash: 0.08, lidTop: 0, lidLow: 0, duration: 0.2 }).call(() => (this.tremble = 0.014)),
    );
  }

  /** The ball landed: react to the multiplier. */
  onLand(multiplier: number) {
    this.tense = false;
    this.tremble = 0;
    if (multiplier >= 10) return this.bigWin();
    if (multiplier >= 2) return this.happy();
    if (multiplier >= 1) return this.nod();
    return this.disappointed();
  }

  private happy() {
    this.play("happy", (tl) =>
      tl.to(this.intent, { lean: -0.05, squash: 0.2, lidLow: 0.55, duration: 0.09 }) // anticipation crouch, eyes start to smile
        .to(this.intent, { squash: -0.18, hop: 0.9, duration: 0.16 }) // stretch on take-off
        .to(this.intent, { squash: 0, tilt: 0.12, duration: 0.14 })
        .to(this.intent, { hop: 0, tilt: -0.08, duration: 0.16 })
        .call(() => this.springs.squash.kick(3.5)) // landing impact → jelly follow-through
        .to(this.intent, { tilt: 0, lean: 0, duration: 0.3 })
        .to(this.intent, { lidLow: 0, duration: 0.3 }, "+=0.5"),
    );
  }

  private bigWin() {
    this.burst(48);
    this.play("bigWin", (tl) => {
      tl.to(this.intent, { lean: 0, squash: 0.26, yaw: -0.4, lidLow: 0.7, duration: 0.14 }); // wind up, turn to the camera, beaming
      for (let i = 0; i < 2; i++) {
        tl.to(this.intent, { squash: -0.24, hop: 1.7 - i * 0.55, duration: 0.2 })
          .to(this, { spin: `+=${Math.PI * 2}`, duration: 0.6, ease: "power2.inOut" }, "<")
          .to(this.intent, { squash: 0, duration: 0.12 })
          .to(this.intent, { hop: 0, duration: 0.24 })
          .call(() => {
            this.springs.squash.kick(4.5);
            this.burst(16);
          });
      }
      // Victory wiggle facing the camera, then settle back towards the board.
      tl.to(this.intent, { tilt: 0.16, duration: 0.12 })
        .to(this.intent, { tilt: -0.16, duration: 0.12 })
        .to(this.intent, { tilt: 0.1, duration: 0.12 })
        .to(this.intent, { tilt: 0, yaw: 0, duration: 0.35 })
        .to(this.intent, { lidLow: 0, duration: 0.4 }, "+=0.4")
        .call(() => (this.spin %= Math.PI * 2));
    });
  }

  private nod() {
    this.play("nod", (tl) =>
      tl.call(() => this.doBlink())
        .to(this.intent, { lean: 0.18, squash: 0.06, duration: 0.12 })
        .to(this.intent, { lean: 0, squash: 0, duration: 0.2 }),
    );
  }

  private disappointed() {
    this.play("sad", (tl) =>
      tl.to(this.intent, { lean: 0.3, squash: 0.12, tilt: -0.14, yaw: 0.15, lidTop: 0.5, duration: 0.3 }) // slump, droopy eyes
        .to({}, { duration: 0.6 }) // hold the beat
        .to(this.intent, { lean: 0, squash: -0.03, tilt: 0, yaw: 0, lidTop: 0, duration: 0.5 }) // shake it off
        .to(this.intent, { squash: 0, duration: 0.2 }),
    );
  }

  /** Quick close-and-open of the upper lids (ease in fast, hold a frame, ease out). */
  private doBlink() {
    gsap.timeline()
      .to(this, { blink: 1, duration: 0.07, ease: "power2.in" })
      .to(this, { blink: 0, duration: 0.12, ease: "power2.out" }, "+=0.04");
  }

  /**
   * Eyelids: curved caps hugging each eye, in the colour of the painted mask around it.
   * The upper lid grows down from its top edge, the lower lid up from its bottom edge,
   * so partial values read as droopy (sad) or smiling (happy) eyes.
   */
  private buildEyelids(model: THREE.Object3D) {
    const material = springMaterial({ color: LID_COLOR, rimColor: "#ffd59a", rimStrength: 0.6 });
    const up = new THREE.Vector3(0, 1, 0);
    for (const eye of EYES) {
      const n = new THREE.Vector3(...eye.normal).normalize();
      const y = up.clone().addScaledVector(n, -up.dot(n)).normalize();
      const x = new THREE.Vector3().crossVectors(y, n);
      const frame = new THREE.Group();
      frame.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
      frame.position.fromArray(eye.center).addScaledVector(n, 0.016).addScaledVector(y, -0.008); // just above the painted eye
      const R = eye.radius * 1.6; // the painted iris + its dark rim is wider than the measured iris
      const lid = (pivotSide: 1 | -1) => {
        const g = new THREE.CircleGeometry(R, 28);
        // Curve the cap back so it hugs the round head instead of reading as a flat sticker.
        const pos = g.getAttribute("position");
        for (let i = 0; i < pos.count; i++) {
          const px = pos.getX(i);
          const py = pos.getY(i);
          pos.setZ(i, -(px * px + py * py) / (2 * 0.22));
        }
        g.translate(0, -R * pivotSide, 0); // pivot on the top (upper lid) or bottom (lower lid) edge
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, material);
        mesh.position.y = R * pivotSide;
        mesh.visible = false;
        frame.add(mesh);
        return mesh;
      };
      this.lids.push({ top: lid(1), low: lid(-1) });
      model.add(frame);
    }
  }

  private updateEyelids(top: number, low: number) {
    const t = THREE.MathUtils.clamp(top, 0, 1);
    const l = THREE.MathUtils.clamp(low, 0, 0.8);
    for (const lid of this.lids) {
      lid.top.visible = t > 0.02;
      lid.top.scale.y = t;
      lid.low.visible = l > 0.02;
      lid.low.scale.y = l;
    }
  }

  /** Small idle bits of business so the mascot is never frozen between plays. */
  private fidget() {
    const pick = Math.random();
    if (pick < 0.3) {
      // Curious head tilt and back.
      const side = Math.random() < 0.5 ? -1 : 1;
      this.play("fidget", (tl) => tl.to(this.intent, { tilt: 0.16 * side, duration: 0.25 }).to({}, { duration: 0.6 }).to(this.intent, { tilt: 0, duration: 0.3 }));
    } else if (pick < 0.55) {
      // Look at the player (towards the camera), then back to the board.
      this.play("fidget", (tl) => tl.to(this.intent, { yaw: -0.45, duration: 0.3 }).to({}, { duration: 0.9 }).to(this.intent, { yaw: 0, duration: 0.4 }));
    } else if (pick < 0.75) {
      // Little restless hop.
      this.play("fidget", (tl) =>
        tl.to(this.intent, { squash: 0.1, duration: 0.08 })
          .to(this.intent, { squash: -0.06, hop: 0.3, duration: 0.12 })
          .to(this.intent, { squash: 0, hop: 0, duration: 0.14 })
          .call(() => this.springs.squash.kick(2)),
      );
    } else {
      // Big stretch: tall and thin, then settle.
      this.play("fidget", (tl) => tl.to(this.intent, { squash: -0.14, lean: -0.08, duration: 0.45 }).to(this.intent, { squash: 0, lean: 0, duration: 0.4 }));
    }
  }

  private play(name: string, build: (tl: gsap.core.Timeline) => void) {
    this.reaction?.kill();
    const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
    tl.data = name;
    build(tl);
    this.reaction = tl;
  }

  private burst(count: number) {
    const p = this.root.position.clone();
    p.y += HEIGHT * 0.6 * this.root.scale.y;
    this.particles.emit(p, count, "#ffd27a", 5, Math.PI * 1.2, 1.3);
  }

  private update(dt: number) {
    this.time += dt;
    this.particles.update(dt);
    this.fitToView();

    // Idle fidgets when nothing else is going on.
    const busy = (this.reaction?.isActive() && this.reaction.data !== "fidget") || this.lookTarget !== null;
    if (busy) {
      this.nextFidget = Math.max(this.nextFidget, this.time + 2);
    } else if (!reducedMotion && this.time > this.nextFidget) {
      this.fidget();
      this.nextFidget = this.time + 3 + Math.random() * 4;
    }

    // Gaze: turn towards the watched ball, lean in a touch while following it.
    const gaze = this.lookTarget === null ? 0 : THREE.MathUtils.clamp((this.lookTarget - this.root.position.x - 6) * 0.06, -0.35, 0.4);
    const watching = this.lookTarget === null ? 0 : 0.06;

    // Blinks: every few seconds, sometimes a double blink.
    if (!reducedMotion && this.time > this.nextBlink) {
      this.doBlink();
      if (Math.random() < 0.25) gsap.delayedCall(0.22, () => this.doBlink());
      this.nextBlink = this.time + 2.2 + Math.random() * 3.5;
    }

    const s = this.springs;
    s.lidTop.target = Math.min(1, this.intent.lidTop + this.blink);
    s.lidLow.target = this.intent.lidLow;
    s.hop.target = this.intent.hop;
    s.squash.target = this.intent.squash;
    s.yaw.target = this.intent.yaw + gaze;
    s.lean.target = this.intent.lean + watching;
    s.tilt.target = this.intent.tilt;
    for (const spring of Object.values(s)) spring.step(dt);

    const motion = reducedMotion ? 0 : 1;
    const t = this.time;
    // Overlapping idle layers at unrelated frequencies so the loop never reads as mechanical.
    const breathe = (Math.sin(t * 2.1) * 0.03 + Math.sin(t * 0.7) * 0.012) * motion;
    const weightShift = Math.sin(t * 0.8) * 0.04 * motion;
    const bob = Math.max(0, Math.sin(t * 2.1)) * 0.02 * motion;
    const shake = this.tremble * Math.sin(t * 55) * motion;

    // Volume-preserving squash & stretch around the feet.
    const sy = THREE.MathUtils.clamp(1 - s.squash.value + breathe, 0.55, 1.5);
    const sxz = 1 / Math.sqrt(sy);
    this.pivot.scale.set(sxz, sy, sxz);
    this.pivot.position.y = (Math.max(s.hop.value, -0.05) + bob) * motion;
    this.updateEyelids(s.lidTop.value, s.lidLow.value);
    this.pivot.rotation.set(
      s.lean.value * motion,
      BASE_YAW + (s.yaw.value + this.spin) * motion,
      (s.tilt.value + weightShift + shake) * motion,
      "YXZ",
    );
  }

  /**
   * Keep the mascot beside the board on wide screens. On narrow (portrait) screens the frame
   * crops at the sides and the mascot would cover the outer (jackpot) buckets, so it perches
   * in the empty top-left corner of the playfield instead.
   */
  private fitToView() {
    const { halfW } = this.stage.viewHalfSize(this.root.position.z);
    const { boardHalfWidth = 6, groundY = -6, topY = 6 } = this.root.userData as Record<string, number>;
    const portrait = this.stage.camera.aspect < 1;
    const scale = portrait ? 0.7 : 1;
    if (portrait) {
      this.root.position.x = -(halfW - HEIGHT * 0.85 * scale);
      this.root.position.y = topY - 2.7 - HEIGHT * scale;
    } else {
      // Beside the frame when there is room; otherwise overlapping its lower-left corner.
      this.root.position.x = -Math.min(boardHalfWidth + HEIGHT * 0.5, halfW - HEIGHT * 0.42);
      this.root.position.y = groundY + 1.1;
    }
    this.root.scale.setScalar(scale);
  }
}
