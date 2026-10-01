/**
 * Plinko board view. Purely presentational: it receives a server-decided path
 * (0 = left, 1 = right per row) and choreographs the ball along it with
 * anticipation, squash & stretch and arcs. No randomness here affects results.
 */
import * as THREE from "three";
import gsap from "gsap";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Stage } from "../../engine/stage";
import { springMaterial } from "../../engine/materials";
import { labelTexture, softDotTexture } from "../../engine/painted";
import { ParticleBurst } from "../../engine/particles";
import type { Art } from "../../engine/art";
import { sfx } from "../../engine/sfx";
import { multiplierTable, type Risk } from "../../../shared/plinko";

const S = 1; // horizontal peg spacing
const ROW_H = 0.88; // vertical row spacing
const PEG_R = 0.1;
const BALL_R = 0.2;
const SPAWN_H = 1.3;
const BOARD_WORLD_HEIGHT = 12; // every row count is scaled to this height

const CENTRE_COLOR = new THREE.Color("#f6d36b");
const MID_COLOR = new THREE.Color("#f39a52");
const EDGE_COLOR = new THREE.Color("#e2475a");
const PEG_IDLE = new THREE.Color(1, 1, 1);
const PEG_FLASH = new THREE.Color(3.2, 2.5, 1.6);
const INTRO_ROW_DELAY = 0.035; // pegs pop in row by row when a board is built
const INTRO_POP = 0.38;
/** Multipliers at or above this get a floating "+N×" popup. */
const POPUP_MIN = 2;

const easeOutBack = (t: number) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

export function bucketColor(k: number, rows: number): THREE.Color {
  const d = Math.abs(k - rows / 2) / (rows / 2);
  return d < 0.5
    ? CENTRE_COLOR.clone().lerp(MID_COLOR, d / 0.5)
    : MID_COLOR.clone().lerp(EDGE_COLOR, (d - 0.5) / 0.5);
}

/** Landing glow: emissive boost on toon buckets, colour boost (→ bloom) on painted ones. */
function flash(mat: THREE.Material, strength: number) {
  const state = { v: strength };
  const base = mat.userData.base;
  const apply = () => {
    if (mat instanceof THREE.MeshToonMaterial) mat.emissiveIntensity = base + state.v * 2.2;
    else if (mat instanceof THREE.MeshBasicMaterial) mat.color.copy(base).multiplyScalar(1 + state.v * 1.6);
  };
  (mat.userData.tween as gsap.core.Tween | undefined)?.kill();
  mat.userData.tween = gsap.to(state, { v: 0, duration: 0.8, ease: "power2.out", onUpdate: apply });
  apply();
}

export function formatMultiplier(m: number): string {
  return `${m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1).replace(/\.0$/, "") : String(m)}×`;
}

interface Segment {
  from: THREE.Vector2;
  to: THREE.Vector2;
  duration: number;
  arc: number;
  /** Peg hit at the end of this segment (row index), or -1 for the bucket landing. */
  hitRow: number;
  hitPeg: number;
}

interface Popup {
  sprite: THREE.Sprite;
  age: number;
  startY: number;
}

interface Ball {
  group: THREE.Group;
  body: THREE.Mesh;
  segments: Segment[];
  index: number;
  time: number;
  dir: number;
  resolve: () => void;
  bucket: number;
  multiplier: number;
}

export class PlinkoBoard {
  readonly root = new THREE.Group();
  private board = new THREE.Group();
  private pegs?: THREE.InstancedMesh;
  private pegHits: number[] = [];
  private buckets: { mesh: THREE.Mesh; label: THREE.Mesh; baseY: number }[] = [];
  private balls = new Set<Ball>();
  private popups: Popup[] = [];
  private pegPositions: THREE.Vector3[] = [];
  private pegRows: number[] = [];
  private introStart = -10;
  private glowTex = softDotTexture();
  private particles = new ParticleBurst(700, 0.22);
  private ballGeo = new THREE.SphereGeometry(BALL_R, 28, 20);
  private ballMat = springMaterial({ color: "#ffb340", emissive: "#ff7a2a", emissiveIntensity: 0.45, rimColor: "#fff1c4", rimStrength: 0.9 });
  private leafGeo = new THREE.SphereGeometry(0.09, 10, 8).scale(1.6, 0.45, 0.8);
  private leafMat = springMaterial({ color: "#7cc46a", rimColor: "#e8ffc0", rimStrength: 0.5 });
  /** Painted sprite version of the ball, when AI art is available. */
  private ballSprite?: { geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial };
  private rows = 0;
  private time = 0;

  constructor(
    private stage: Stage,
    private art?: Art,
  ) {
    const ballTex = art?.texture("ball");
    if (ballTex) {
      const h = BALL_R * 2.8;
      this.ballSprite = {
        geo: new THREE.PlaneGeometry(h * art!.aspect("ball"), h),
        mat: new THREE.MeshBasicMaterial({ map: ballTex, transparent: true, depthWrite: false, color: new THREE.Color(1.25, 1.2, 1.1) }),
      };
    }
    stage.scene.add(this.root);
    this.root.add(this.board);
    this.board.add(this.particles.points);
    stage.onUpdate((dt) => this.update(dt));
  }

  get activeBalls() {
    return this.balls.size;
  }

  build(rows: number, risk: Risk) {
    this.clearBoard();
    this.rows = rows;

    const top = SPAWN_H + 0.3;
    const bottom = this.bucketY() - 0.45;
    const boardHeight = top - bottom;
    const boardWidth = (rows + 1) * S + 1.4;

    // Backing slab so the pegs read against the busy painted background:
    // the painted stone board when available, otherwise a soft dark panel.
    const boardTex = this.art?.texture("board");
    // The painted board has a thick carved frame: grow it so pegs sit on the smooth inner area.
    const framePad = boardTex ? 1.24 : 1;
    const slab = boardTex
      ? new THREE.Mesh(
          new THREE.PlaneGeometry(boardWidth * framePad, boardHeight * framePad),
          new THREE.MeshBasicMaterial({ map: boardTex, transparent: true, opacity: 0.94, depthWrite: false }),
        )
      : new THREE.Mesh(
          new RoundedBoxGeometry(boardWidth, boardHeight, 0.1, 4, 0.5),
          new THREE.MeshBasicMaterial({ color: "#1a1028", transparent: true, opacity: this.art?.texture("background") ? 0.72 : 0.38, depthWrite: false }),
        );
    slab.position.set(0, (top + bottom) / 2, -0.4);
    this.board.add(slab);

    // Pegs: one instanced draw call. Row r has r + 3 pegs.
    const pegCount = Array.from({ length: rows }, (_, r) => r + 3).reduce((a, b) => a + b, 0);
    const pegTex = this.art?.texture("peg");
    this.pegs = pegTex
      ? new THREE.InstancedMesh(
          new THREE.PlaneGeometry(PEG_R * 2.8, PEG_R * 2.8),
          new THREE.MeshBasicMaterial({ map: pegTex, transparent: true, depthWrite: false, color: new THREE.Color(1.4, 1.3, 1.2) }),
          pegCount,
        )
      : new THREE.InstancedMesh(
          new THREE.SphereGeometry(PEG_R, 14, 10),
          springMaterial({ color: "#fff2dc", emissive: "#ffb27a", emissiveIntensity: 0.35, rimColor: "#ffffff", rimStrength: 0.8 }),
          pegCount,
        );
    this.pegPositions = [];
    this.pegRows = [];
    for (let r = 0; r < rows; r++) {
      for (let j = 0; j < r + 3; j++) {
        this.pegs.setColorAt(this.pegPositions.length, PEG_IDLE);
        this.pegPositions.push(new THREE.Vector3(this.pegX(r, j), this.rowY(r), 0));
        this.pegRows.push(r);
      }
    }
    this.pegHits = new Array(pegCount).fill(-10);
    this.introStart = this.time;
    this.updatePegMatrices(true);
    this.board.add(this.pegs);

    // Buckets.
    const bucketTex = this.art?.texture("bucket");
    const bucketGeo = bucketTex
      ? new THREE.PlaneGeometry(S * 0.96, Math.min((S * 0.96) / this.art!.aspect("bucket"), 0.75))
      : new RoundedBoxGeometry(S * 0.88, 0.5, 0.45, 3, 0.12);
    const labelGeo = new THREE.PlaneGeometry(S * 0.94, 0.5);
    for (let k = 0; k <= rows; k++) {
      const color = bucketColor(k, rows);
      const edge = Math.abs(k - rows / 2) / (rows / 2);
      const material = bucketTex
        ? new THREE.MeshBasicMaterial({ map: bucketTex, color, transparent: true, depthWrite: false })
        : springMaterial({ color, emissive: color, emissiveIntensity: 0.15 + edge * 0.35, rimColor: "#fff3d6", rimStrength: 0.5 });
      material.userData.base = bucketTex ? color.clone() : (material as THREE.MeshToonMaterial).emissiveIntensity;
      const mesh = new THREE.Mesh(bucketGeo, material);
      const baseY = this.bucketY();
      mesh.position.set(this.bucketX(k), baseY, 0);
      const label = new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      label.position.z = bucketTex ? 0.02 : 0.24;
      mesh.add(label);
      this.board.add(mesh);
      this.buckets.push({ mesh, label, baseY });
    }
    this.setRisk(risk);

    // Scale every board to the same world height and centre it.
    const scale = BOARD_WORLD_HEIGHT / boardHeight;
    this.board.scale.setScalar(scale);
    this.board.position.y = (-(top + bottom) / 2) * scale;
    this.stage.frame(
      Math.max(boardWidth * framePad * scale, 9),
      BOARD_WORLD_HEIGHT * framePad + 0.4,
      undefined,
      boardWidth * 1.04 * scale, // portrait: keep pegs + buckets, let the frame crop
    );

    // Buckets rise in after the pegs (the pegs' row-by-row pop runs in update()).
    this.buckets.forEach(({ mesh, baseY }, k) => {
      gsap.fromTo(
        mesh.position,
        { y: baseY - 0.6 },
        { y: baseY, duration: 0.5, delay: rows * INTRO_ROW_DELAY + Math.abs(k - rows / 2) * 0.03, ease: "back.out(2.2)" },
      );
    });
  }

  setRisk(risk: Risk) {
    const table = multiplierTable(this.rows, risk);
    this.buckets.forEach(({ label }, k) => {
      const mat = label.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.map = labelTexture(formatMultiplier(table[k]), "#fffaf0");
      mat.needsUpdate = true;
    });
  }

  /** Animates a ball along a server-decided path; resolves when it lands. */
  drop(path: number[], multiplier: number): Promise<void> {
    if (path.length !== this.rows) throw new Error("path does not match board rows");
    const group = new THREE.Group();
    let body: THREE.Mesh;
    if (this.ballSprite) {
      body = new THREE.Mesh(this.ballSprite.geo, this.ballSprite.mat);
    } else {
      body = new THREE.Mesh(this.ballGeo, this.ballMat);
      const leaf = new THREE.Mesh(this.leafGeo, this.leafMat);
      leaf.position.set(0.05, BALL_R * 0.95, 0);
      leaf.rotation.z = -0.5;
      body.add(leaf);
    }
    group.add(body);
    // Warm halo behind the ball; additive so bloom turns it into a soft glow.
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.glowTex, color: "#ffb04a", transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    halo.scale.setScalar(BALL_R * 5);
    halo.position.z = -0.01;
    group.add(halo);
    this.board.add(group);

    const segments: Segment[] = [];
    let rights = 0;
    let prev = new THREE.Vector2();
    for (let r = 0; r < this.rows; r++) {
      const dir = path[r] === 1 ? 1 : -1;
      const pegJ = rights + 1;
      // Contact slightly off the peg's crown, on the side the ball will roll off.
      const contact = new THREE.Vector2(this.pegX(r, pegJ) + dir * 0.17 * S, this.rowY(r) + PEG_R + BALL_R * 0.85);
      if (r === 0) {
        prev = new THREE.Vector2(contact.x, this.rowY(0) + SPAWN_H);
        segments.push({ from: prev, to: contact, duration: 0.34, arc: 0, hitRow: 0, hitPeg: this.pegIndex(0, pegJ) });
      } else {
        segments.push({
          from: prev,
          to: contact,
          duration: 0.19 - Math.min(r, 8) * 0.006,
          arc: ROW_H * (0.22 + Math.random() * 0.12),
          hitRow: r,
          hitPeg: this.pegIndex(r, pegJ),
        });
      }
      prev = contact;
      rights += path[r];
    }
    const landing = new THREE.Vector2(this.bucketX(rights), this.bucketY() + 0.32);
    segments.push({ from: prev, to: landing, duration: 0.24, arc: ROW_H * 0.2, hitRow: -1, hitPeg: -1 });

    group.position.set(segments[0].from.x, segments[0].from.y, 0.05);
    gsap.from(body.scale, { x: 0, y: 0, z: 0, duration: 0.25, ease: "back.out(3)" });
    sfx.drop();

    return new Promise((resolve) => {
      this.balls.add({ group, body, segments, index: 0, time: 0, dir: path[0] ? 1 : -1, resolve, bucket: rights, multiplier });
    });
  }

  private update(dt: number) {
    this.time += dt;
    this.particles.update(dt);

    for (const ball of this.balls) {
      ball.time += dt;
      let seg = ball.segments[ball.index];
      while (ball.time >= seg.duration) {
        ball.time -= seg.duration;
        this.onSegmentEnd(ball, seg);
        ball.index++;
        if (ball.index >= ball.segments.length) break;
        seg = ball.segments[ball.index];
        ball.dir = Math.sign(seg.to.x - seg.from.x) || ball.dir;
      }
      if (ball.index >= ball.segments.length) continue;

      const t = ball.time / seg.duration;
      const x = THREE.MathUtils.lerp(seg.from.x, seg.to.x, t);
      const y = seg.from.y + (seg.to.y - seg.from.y) * t * t + seg.arc * 4 * t * (1 - t);
      ball.group.position.x = x;
      ball.group.position.y = y;
      ball.body.rotation.z -= ball.dir * dt * 9;
      if (Math.random() < 0.6) this.particles.emit(ball.group.position, 1, "#ffc46b", 0.4, Math.PI * 2, 0.5);
    }

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.age += dt;
      const t = p.age / 1.1;
      p.sprite.position.y = p.startY + easeOutBack(Math.min(t * 2.2, 1)) * 1.1 + t * 0.35;
      (p.sprite.material as THREE.SpriteMaterial).opacity = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
      if (t >= 1) {
        this.board.remove(p.sprite);
        (p.sprite.material as THREE.SpriteMaterial).map?.dispose();
        p.sprite.material.dispose();
        this.popups.splice(i, 1);
      }
    }

    this.updatePegMatrices(false);

    // Peg flash decay.
    if (this.pegs) {
      const c = new THREE.Color();
      let dirty = false;
      this.pegHits.forEach((hitAt, i) => {
        const age = this.time - hitAt;
        if (age > 0.6) return;
        c.copy(PEG_FLASH).lerp(PEG_IDLE, Math.min(age / 0.45, 1));
        this.pegs!.setColorAt(i, c);
        dirty = true;
      });
      if (dirty && this.pegs.instanceColor) this.pegs.instanceColor.needsUpdate = true;
    }
  }

  /** Peg scale: row-by-row intro pop + a quick pulse when hit. Skips work when idle. */
  private updatePegMatrices(force: boolean) {
    if (!this.pegs) return;
    const introEnd = this.introStart + this.rows * INTRO_ROW_DELAY + INTRO_POP;
    const introActive = this.time < introEnd;
    const anyHit = this.pegHits.some((h) => this.time - h < 0.3);
    if (!force && !introActive && !anyHit && !this.pegs.userData.dirty) return;
    this.pegs.userData.dirty = introActive || anyHit; // one more pass after activity settles

    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const q = new THREE.Quaternion();
    this.pegPositions.forEach((pos, i) => {
      const intro = Math.min(Math.max((this.time - this.introStart - this.pegRows[i] * INTRO_ROW_DELAY) / INTRO_POP, 0), 1);
      const hitAge = this.time - this.pegHits[i];
      const pulse = hitAge < 0.3 ? 0.45 * Math.exp(-hitAge * 14) : 0;
      scale.setScalar(Math.max(easeOutBack(intro), 0) * (1 + pulse));
      this.pegs!.setMatrixAt(i, m.compose(pos, q, scale));
    });
    this.pegs.instanceMatrix.needsUpdate = true;
  }

  private onSegmentEnd(ball: Ball, seg: Segment) {
    if (seg.hitRow >= 0) {
      this.pegHits[seg.hitPeg] = this.time;
      sfx.peg(seg.hitRow, THREE.MathUtils.clamp(ball.group.position.x / (this.rows / 2 + 1), -1, 1));
      this.particles.emit(new THREE.Vector3(seg.to.x, seg.to.y - BALL_R * 0.6, 0.1), 3, "#fff0c4", 1.6, Math.PI * 1.4, 0.8);
      // Squash on impact, then spring back with overshoot (follow-through).
      gsap.fromTo(
        ball.body.scale,
        { x: 1.28, y: 0.72, z: 1.1 },
        { x: 1, y: 1, z: 1, duration: 0.32, ease: "elastic.out(1.1, 0.45)", overwrite: true },
      );
      return;
    }
    this.land(ball);
  }

  private land(ball: Ball) {
    const bucket = this.buckets[ball.bucket];
    const color = bucketColor(ball.bucket, this.rows);
    const win = ball.multiplier >= 1;
    const big = ball.multiplier >= 10;

    // Bucket gets "pushed" down and bounces back; label pops.
    gsap.fromTo(bucket.mesh.position, { y: bucket.baseY - 0.22 }, { y: bucket.baseY, duration: 0.5, ease: "elastic.out(1.2, 0.35)", overwrite: true });
    gsap.fromTo(bucket.mesh.scale, { x: 1.15, y: 0.8 }, { x: 1, y: 1, duration: 0.45, ease: "elastic.out(1.2, 0.4)", overwrite: true });
    flash(bucket.mesh.material as THREE.Material, win ? 1 : 0.35);

    const origin = new THREE.Vector3(bucket.mesh.position.x, bucket.baseY + 0.3, 0.2);
    this.particles.emit(origin, win ? (big ? 70 : 28) : 8, win ? color : "#b9a6d8", big ? 7 : 4, Math.PI * 0.9, 1.4);
    if (big) this.stage.addShake(0.35);
    sfx.land(ball.multiplier);
    if (ball.multiplier >= POPUP_MIN) this.popup(ball.multiplier, bucket.mesh.position.x, bucket.baseY + 0.45, color);

    // Ball dissolves into the bucket.
    gsap.to(ball.body.scale, {
      x: 0,
      y: 0,
      z: 0,
      duration: 0.18,
      ease: "back.in(2)",
      onComplete: () => this.board.remove(ball.group),
    });
    this.balls.delete(ball);
    ball.resolve();
  }

  private popup(multiplier: number, x: number, y: number, color: THREE.Color) {
    const tex = labelTexture(formatMultiplier(multiplier), `#${color.clone().lerp(new THREE.Color("#fff6dc"), 0.45).getHexString()}`);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    sprite.scale.set(2.4, 1.2, 1);
    sprite.position.set(x, y, 0.6);
    sprite.renderOrder = 10;
    this.board.add(sprite);
    this.popups.push({ sprite, age: 0, startY: y });
  }

  private clearBoard() {
    for (const child of [...this.board.children]) {
      if (child === this.particles.points) continue;
      this.board.remove(child);
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const shared: unknown[] = [this.ballGeo, this.leafGeo, this.ballSprite?.geo, this.ballMat, this.leafMat, this.ballSprite?.mat];
        if (!shared.includes(mesh.geometry)) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material & { map?: THREE.Texture | null };
        if (!shared.includes(mat)) {
          // Painted art textures are shared across rebuilds; only canvas labels are per-board.
          if (mat.map instanceof THREE.CanvasTexture) mat.map.dispose();
          mat.dispose();
        }
      });
    }
    for (const p of this.popups) {
      (p.sprite.material as THREE.SpriteMaterial).map?.dispose();
      p.sprite.material.dispose();
    }
    this.popups = [];
    this.buckets = [];
    this.pegs = undefined;
  }

  private rowY(r: number) {
    return -r * ROW_H;
  }

  private pegX(r: number, j: number) {
    return (j - (r + 2) / 2) * S;
  }

  private pegIndex(r: number, j: number) {
    return (r * (r + 5)) / 2 + j; // Σ_{q<r} (q + 3) + j
  }

  private bucketX(k: number) {
    return (k - this.rows / 2) * S;
  }

  private bucketY() {
    return this.rowY(this.rows - 1) - ROW_H * 0.95;
  }
}
