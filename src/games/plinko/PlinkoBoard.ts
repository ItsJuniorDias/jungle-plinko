/**
 * Plinko board view. Purely presentational: it receives a server-decided path
 * (0 = left, 1 = right per row) and choreographs the ball along it with
 * anticipation, squash & stretch and arcs. No randomness here affects results.
 */
import * as THREE from "three";
import gsap from "gsap";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Stage } from "../../engine/stage";
import { springMaterial, springify } from "../../engine/materials";
import { labelTexture, softDotTexture } from "../../engine/painted";
import { ParticleBurst } from "../../engine/particles";
import { createMossLayers, type MossLayers } from "../../engine/moss";
import type { Art } from "../../engine/art";
import { sfx } from "../../engine/sfx";
import { multiplierTable, type Risk } from "../../../shared/plinko";

const S = 1; // horizontal peg spacing
const ROW_H = 0.88; // vertical row spacing
const PEG_R = 0.1;
const BALL_R = 0.2;
const SPAWN_H = 1.3;
const BOARD_WORLD_HEIGHT = 12; // every row count is scaled to this height
/** Board leans back so the camera sees the depth of the 3D props. */
const BOARD_TILT = THREE.MathUtils.degToRad(-12);
/** Light comes from the upper right, so the ball's shadow falls down-left on the slab. */
const SHADOW_OFFSET = new THREE.Vector2(-0.07, -0.13);

const CENTRE_COLOR = new THREE.Color("#f6d36b");
const MID_COLOR = new THREE.Color("#f39a52");
const EDGE_COLOR = new THREE.Color("#e2475a");
const PEG_IDLE = new THREE.Color(1, 1, 1);
const PEG_FLASH = new THREE.Color(3.2, 2.5, 1.6);
const INTRO_ROW_DELAY = 0.035; // pegs pop in row by row when a board is built
const INTRO_POP = 0.38;
const WOBBLE_TIME = 0.8;
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

/** Part of board.webp drawn as the board: the whole painted frame, soft edge included (UV, y down). */
const PAINT_CROP = { u0: 0.05, v0: 0.025, u1: 0.95, v1: 0.985 };
/**
 * The painted board is larger than the playfield so the pegs and buckets sit inside the
 * painting's dark interior (u 0.20–0.80, v 0.17–0.83 of board.webp); nudged down so the
 * buckets clear the bottom carving and the ball drops in over the top one.
 */
const PAINT_PAD = 1.4;
const PAINT_SHIFT = -0.35;

interface FrameGlow {
  uFrameTime: { value: number };
  /** Idle "breathing" of the vines and carvings. */
  uBreathe: { value: number };
  /** Landing flash, in the bucket's colour. */
  uGlowBoost: { value: number };
  uGlowColor: { value: THREE.Color };
}

/**
 * Light on the painted frame: the painting brightens by its own colour (so the lit vines and
 * carvings glint while the dark stone stays dark) under a slow breathing, a band of light
 * travelling diagonally across it, and the landing flash.
 */
function addPaintedGlow(mat: THREE.MeshBasicMaterial, u: FrameGlow) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uFrameTime;\nuniform float uBreathe;\nuniform float uGlowBoost;\nuniform vec3 uGlowColor;")
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float band = pow(0.5 + 0.5 * sin(vMapUv.x * 7.0 + vMapUv.y * 5.0 - uFrameTime * 1.6), 10.0);
        diffuseColor.rgb += diffuseColor.rgb * uGlowColor * (uBreathe * (0.6 + 2.2 * band) + uGlowBoost);`,
      );
  };
  mat.customProgramCacheKey = () => "painted-frame-glow";
}

/** Frame flash strength for ordinary wins: grows with the multiplier, capped. */
function multiplier2boost(m: number) {
  return Math.min(0.35 + (m - 1) * 0.12, 1.4);
}

function firstMesh(root: THREE.Object3D): THREE.Mesh | undefined {
  let found: THREE.Mesh | undefined;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh;
  });
  return found;
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
  /** Squash & stretch pivot: aligned with the velocity, never spins (so squash reads correctly). */
  body: THREE.Object3D;
  /** Rolls inside `body`; counter-rotated so the roll is independent of the stretch axis. */
  spinner: THREE.Object3D;
  roll: number;
  fx: { size: number; squash: number };
  prev: THREE.Vector2;
  shadow: THREE.Mesh;
  segments: Segment[];
  index: number;
  time: number;
  dir: number;
  resolve: () => void;
  bucket: number;
  multiplier: number;
  tensionSent?: boolean;
}

export class PlinkoBoard {
  readonly root = new THREE.Group();
  private board = new THREE.Group();
  private pegs?: THREE.InstancedMesh;
  private pegHits: number[] = [];
  private buckets: { mesh: THREE.Object3D; label: THREE.Mesh; baseY: number; mat: THREE.Material }[] = [];
  private balls = new Set<Ball>();
  private popups: Popup[] = [];
  private pegPositions: THREE.Vector3[] = [];
  private pegRows: number[] = [];
  private pegHitDir: number[] = [];
  private introStart = -10;
  private glowTex = softDotTexture();
  private particles = new ParticleBurst(700, 0.22);
  private ballGeo = new THREE.SphereGeometry(BALL_R, 28, 20);
  private ballMat = springMaterial({ color: "#ffb340", emissive: "#ff7a2a", emissiveIntensity: 0.45, rimColor: "#fff1c4", rimStrength: 0.9 });
  private leafGeo = new THREE.SphereGeometry(0.09, 10, 8).scale(1.6, 0.45, 0.8);
  private leafMat = springMaterial({ color: "#7cc46a", rimColor: "#e8ffc0", rimStrength: 0.5 });
  /** Painted sprite version of the ball, when only 2D art is available. */
  private ballSprite?: { geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial };
  /** AI-generated 3D props (public/models), preferred over sprites when present. */
  private ballModel?: THREE.Object3D;
  private pegModel?: { geo: THREE.BufferGeometry; mat: THREE.Material };
  private bucketModel?: THREE.Object3D;
  /** The painted board (board.webp), shared by every rebuild. */
  private paint?: { geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial };
  /** Volumetric moss grown over the moss painted on the frame. */
  private moss?: MossLayers;
  private frameGlow = { boost: 0, color: new THREE.Color("#ffc890") };
  /** World-space extent of the board frame, for placing things around it (the mascot). */
  readonly bounds = { halfWidth: 6, bottom: -6 };
  /** Game-feel hooks (the mascot listens to these). */
  onDrop?: () => void;
  onLand?: (multiplier: number) => void;
  onTension?: () => void;
  onPegHit?: () => void;
  private shadowGeo = new THREE.PlaneGeometry(BALL_R * 3.2, BALL_R * 2.2);
  private shadowMat: THREE.MeshBasicMaterial;
  /** Contact radii used by the choreography: match the drawn size of the 3D props. */
  private pegContactR = PEG_R;
  private ballContactR = BALL_R;
  private bucketTop = 0.25;
  /** Light on the painted frame: travelling wave, breathing and landing flash. */
  private frameU: FrameGlow = {
    uFrameTime: { value: 0 },
    uBreathe: { value: 0 },
    uGlowBoost: { value: 0 },
    uGlowColor: { value: new THREE.Color("#ffc890") },
  };
  /** Geometries/materials shared across rebuilds: never disposed by clearBoard(). */
  private keep = new Set<unknown>();
  private rows = 0;
  private time = 0;

  constructor(
    private stage: Stage,
    private art?: Art,
  ) {
    this.shadowMat = new THREE.MeshBasicMaterial({ map: this.glowTex, color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false });
    this.keep.add(this.shadowGeo).add(this.shadowMat);

    const ballModel = art?.model("ball");
    if (ballModel) {
      springify(ballModel, { rimColor: "#fff1c4", rimStrength: 0.85, emissive: "#ff7a2a", emissiveIntensity: 0.22 });
      ballModel.scale.setScalar(BALL_R * 2.3); // models are normalised to 1 unit
      this.ballContactR = BALL_R * 1.1;
      this.protect(ballModel);
      this.ballModel = ballModel;
    }
    const pegModel = art?.model("peg");
    const pegMesh = pegModel && firstMesh(pegModel);
    if (pegMesh) {
      const geo = pegMesh.geometry.clone().scale(PEG_R * 2.5, PEG_R * 2.5, PEG_R * 2.5);
      const src = pegMesh.material as THREE.MeshStandardMaterial;
      // Strong warm emissive so the orbs cross the bloom threshold and glow like spores.
      const mat = springMaterial({ color: "#fff6ea", map: src.map, emissive: "#ffc48a", emissiveIntensity: 1.05, rimColor: "#ffffff", rimStrength: 1 });
      this.keep.add(geo).add(mat);
      this.pegModel = { geo, mat };
      this.pegContactR = PEG_R * 1.25;
    }
    const boardTex = art?.texture("board");
    if (boardTex) {
      // The painted board: drawn flat and unlit, exactly as painted, cropped to the frame.
      const geo = new THREE.PlaneGeometry(1, 1);
      const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
      const { u0, v0, u1, v1 } = PAINT_CROP;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), 1 - v1 + uv.getY(i) * (v1 - v0));
      const mat = new THREE.MeshBasicMaterial({ map: boardTex, transparent: true, depthWrite: false });
      addPaintedGlow(mat, this.frameU);
      this.paint = { geo, mat };
      this.keep.add(geo).add(mat);
      // No moss over the playfield (the inner 1 / PAINT_PAD of the board).
      const inner = 0.5 / PAINT_PAD;
      this.moss = createMossLayers(boardTex, {
        crop: PAINT_CROP,
        exclude: { halfX: inner, halfY: inner },
        layers: matchMedia("(pointer: coarse)").matches ? 8 : 12,
      });
      this.keep.add(this.moss.mesh.geometry).add(this.moss.mesh.material);
    }
    const bucketModel = art?.model("bucket");
    if (bucketModel) {
      bucketModel.scale.setScalar(S * 0.92);
      this.bucketTop = (S * 0.92 * 0.966) / 2; // plaque is ~0.97 as tall as wide
      this.protect(bucketModel, false); // each bucket gets its own tinted material
      this.bucketModel = bucketModel;
    }

    const ballTex = art?.texture("ball");
    if (ballTex && !ballModel) {
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

  private protect(root: THREE.Object3D, materials = true) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.keep.add(mesh.geometry);
      if (materials) this.keep.add(mesh.material);
    });
  }

  /** World X of the ball furthest down the board (what the mascot watches), or null. */
  watchX(): number | null {
    let best: Ball | undefined;
    for (const b of this.balls) if (!best || b.index > best.index) best = b;
    return best ? best.group.getWorldPosition(new THREE.Vector3()).x : null;
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
    // the painted board when available, otherwise a soft dark panel.
    const framePad = this.paint ? PAINT_PAD : 1;
    const centreY = (top + bottom) / 2 + (this.paint ? PAINT_SHIFT : 0);
    const slab = this.paint
      ? new THREE.Mesh(this.paint.geo, this.paint.mat)
      : new THREE.Mesh(
          new RoundedBoxGeometry(boardWidth, boardHeight, 0.1, 4, 0.5),
          new THREE.MeshBasicMaterial({ color: "#1a1028", transparent: true, opacity: this.art?.texture("background") ? 0.72 : 0.38, depthWrite: false }),
        );
    if (this.paint) slab.scale.set(boardWidth * framePad, boardHeight * framePad, 1);
    slab.position.set(0, centreY, -0.4);
    slab.renderOrder = -2;
    this.board.add(slab);
    if (this.moss) {
      this.moss.fit(boardWidth * framePad, boardHeight * framePad, 0.14);
      this.moss.mesh.position.set(0, centreY, -0.395);
      this.board.add(this.moss.mesh);
    }

    // Pegs: one instanced draw call. Row r has r + 3 pegs.
    const pegCount = Array.from({ length: rows }, (_, r) => r + 3).reduce((a, b) => a + b, 0);
    const pegTex = this.art?.texture("peg");
    this.pegs = this.pegModel
      ? new THREE.InstancedMesh(this.pegModel.geo, this.pegModel.mat, pegCount)
      : pegTex
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
    this.pegHitDir = new Array(pegCount).fill(1);
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
      const glow = 0.15 + edge * 0.35;
      let mesh: THREE.Object3D;
      let material: THREE.Material;
      let labelZ: number;
      if (this.bucketModel) {
        // 3D carved plaque: its painted texture tinted by the bucket colour (toon colour × map).
        const pivot = new THREE.Group();
        const plaque = this.bucketModel.clone(true);
        springify(plaque, { color, emissive: color, emissiveIntensity: glow, rimColor: "#fff3d6", rimStrength: 0.55 });
        pivot.add(plaque);
        mesh = pivot;
        material = firstMesh(plaque)!.material as THREE.Material;
        labelZ = 0.26;
      } else {
        material = bucketTex
          ? new THREE.MeshBasicMaterial({ map: bucketTex, color, transparent: true, depthWrite: false })
          : springMaterial({ color, emissive: color, emissiveIntensity: glow, rimColor: "#fff3d6", rimStrength: 0.5 });
        mesh = new THREE.Mesh(bucketGeo, material);
        labelZ = bucketTex ? 0.02 : 0.24;
      }
      material.userData.base = material instanceof THREE.MeshBasicMaterial ? color.clone() : glow;
      const baseY = this.bucketY();
      mesh.position.set(this.bucketX(k), baseY, 0);
      const label = new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      label.position.z = labelZ;
      mesh.add(label);
      this.board.add(mesh);
      this.buckets.push({ mesh, label, baseY, mat: material });
    }
    this.setRisk(risk);

    // Scale every board to the same world height and centre it.
    const scale = BOARD_WORLD_HEIGHT / boardHeight;
    this.board.scale.setScalar(scale);
    this.board.position.y = (-(top + bottom) / 2) * scale;
    this.board.rotation.x = BOARD_TILT;
    this.bounds.halfWidth = (boardWidth * framePad * scale) / 2;
    this.bounds.bottom = this.board.position.y + (centreY - (boardHeight * framePad) / 2) * scale;
    // The tilt brings the bottom edge towards the camera (and the 3D frame has depth),
    // so leave extra vertical room and aim slightly low.
    const tiltRoom = 1.04;
    this.stage.frame(
      Math.max(boardWidth * framePad * scale, 9),
      BOARD_WORLD_HEIGHT * framePad * tiltRoom + 0.4,
      new THREE.Vector3(0, -0.35, 0),
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
    const body = new THREE.Group();
    const spinner = new THREE.Group();
    body.add(spinner);
    if (this.ballModel) {
      const seed = this.ballModel.clone(true);
      seed.rotation.y = Math.random() * Math.PI * 2;
      spinner.add(seed);
    } else if (this.ballSprite) {
      spinner.add(new THREE.Mesh(this.ballSprite.geo, this.ballSprite.mat));
    } else {
      spinner.add(new THREE.Mesh(this.ballGeo, this.ballMat));
      const leaf = new THREE.Mesh(this.leafGeo, this.leafMat);
      leaf.position.set(0.05, BALL_R * 0.95, 0);
      leaf.rotation.z = -0.5;
      spinner.add(leaf);
    }
    group.add(body);
    // Soft contact shadow on the slab, under everything else on the board.
    const shadow = new THREE.Mesh(this.shadowGeo, this.shadowMat);
    shadow.position.z = -0.37;
    shadow.renderOrder = -1;
    this.board.add(shadow);
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
      const contact = new THREE.Vector2(this.pegX(r, pegJ) + dir * 0.17 * S, this.rowY(r) + this.pegContactR + this.ballContactR * 0.85);
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
    // Land on the plaque's top edge (the 3D plaque is taller than the old flat bucket).
    const landing = new THREE.Vector2(this.bucketX(rights), this.bucketY() + this.bucketTop + this.ballContactR * 0.5);
    segments.push({ from: prev, to: landing, duration: 0.24, arc: ROW_H * 0.2, hitRow: -1, hitPeg: -1 });

    group.position.set(segments[0].from.x, segments[0].from.y, 0.05);
    const fx = { size: 0, squash: 0 };
    gsap.to(fx, { size: 1, duration: 0.25, ease: "back.out(3)" });
    sfx.drop();
    this.onDrop?.();
    // Tiny nudge: the board "feels" the ball being released.
    gsap.fromTo(this.root.rotation, { x: -0.012 }, { x: 0, duration: 0.5, ease: "elastic.out(1.2, 0.4)", overwrite: true });

    return new Promise((resolve) => {
      this.balls.add({
        group,
        body,
        spinner,
        roll: 0,
        fx,
        prev: segments[0].from.clone(),
        shadow,
        segments,
        index: 0,
        time: 0,
        dir: path[0] ? 1 : -1,
        resolve,
        bucket: rights,
        multiplier,
      });
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
      // Two rows from the bottom and heading for a big bucket: let the mascot hold its breath.
      if (!ball.tensionSent && ball.multiplier >= 5 && ball.index >= this.rows - 2) {
        ball.tensionSent = true;
        this.onTension?.();
      }

      const t = ball.time / seg.duration;
      const x = THREE.MathUtils.lerp(seg.from.x, seg.to.x, t);
      const y = seg.from.y + (seg.to.y - seg.from.y) * t * t + seg.arc * 4 * t * (1 - t);
      ball.group.position.x = x;
      ball.group.position.y = y;
      this.applyBallMotion(ball, x, y, dt);
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

    // Frame glow: slow idle "breathing", a travelling light wave, plus any landing flash.
    this.frameU.uFrameTime.value = this.time;
    this.frameU.uBreathe.value = 0.06 + 0.035 * (0.5 + 0.5 * Math.sin(this.time * 1.3));
    this.frameU.uGlowBoost.value = this.frameGlow.boost;
    this.frameU.uGlowColor.value.copy(this.frameGlow.color);

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

  /** Peg transform: row-by-row intro pop, a quick pulse and a springy wobble when hit. Skips work when idle. */
  private updatePegMatrices(force: boolean) {
    if (!this.pegs) return;
    const introEnd = this.introStart + this.rows * INTRO_ROW_DELAY + INTRO_POP;
    const introActive = this.time < introEnd;
    const anyHit = this.pegHits.some((h) => this.time - h < WOBBLE_TIME);
    if (!force && !introActive && !anyHit && !this.pegs.userData.dirty) return;
    this.pegs.userData.dirty = introActive || anyHit; // one more pass after activity settles

    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const euler = new THREE.Euler();
    this.pegPositions.forEach((pos, i) => {
      const intro = Math.min(Math.max((this.time - this.introStart - this.pegRows[i] * INTRO_ROW_DELAY) / INTRO_POP, 0), 1);
      const hitAge = this.time - this.pegHits[i];
      const pulse = hitAge < 0.3 ? 0.45 * Math.exp(-hitAge * 14) : 0;
      // Damped spring: the peg sways away from the ball, overshoots and settles.
      const wobble = hitAge < WOBBLE_TIME ? 0.55 * Math.exp(-hitAge * 6) * Math.sin(hitAge * 26) : 0;
      q.setFromEuler(euler.set(wobble * 0.5, 0, -wobble * this.pegHitDir[i]));
      scale.setScalar(Math.max(easeOutBack(intro), 0) * (1 + pulse));
      this.pegs!.setMatrixAt(i, m.compose(pos, q, scale));
    });
    this.pegs.instanceMatrix.needsUpdate = true;
  }

  private onSegmentEnd(ball: Ball, seg: Segment) {
    if (seg.hitRow >= 0) {
      this.pegHits[seg.hitPeg] = this.time;
      this.pegHitDir[seg.hitPeg] = ball.dir;
      sfx.peg(seg.hitRow, THREE.MathUtils.clamp(ball.group.position.x / (this.rows / 2 + 1), -1, 1));
      this.particles.emit(new THREE.Vector3(seg.to.x, seg.to.y - BALL_R * 0.6, 0.1), 3, "#fff0c4", 1.6, Math.PI * 1.4, 0.8);
      // Squash on impact (along the incoming velocity), then spring back with overshoot.
      gsap.fromTo(ball.fx, { squash: 0.3 }, { squash: 0, duration: 0.34, ease: "elastic.out(1.1, 0.45)", overwrite: "auto" });
      this.onPegHit?.();
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
    // 3D plaque swings round on its axis like a struck gong, harder for bigger wins.
    const swing = (win ? 0.9 : 0.4) * ball.dir * (big ? 1.6 : 1);
    gsap.fromTo(bucket.mesh.rotation, { y: swing }, { y: 0, duration: 0.9, ease: "elastic.out(1.1, 0.3)", overwrite: true });
    // Ripple: neighbours bob in turn, fading with distance.
    for (let d = 1; d <= 2; d++) {
      for (const side of [-1, 1]) {
        const nb = this.buckets[ball.bucket + side * d];
        if (!nb) continue;
        gsap.fromTo(
          nb.mesh.position,
          { y: nb.baseY - 0.14 / d },
          { y: nb.baseY, duration: 0.5, delay: 0.05 * d, ease: "elastic.out(1.2, 0.4)", overwrite: true },
        );
      }
    }
    flash(bucket.mat, win ? 1 : 0.35);

    const origin = new THREE.Vector3(bucket.mesh.position.x, bucket.baseY + 0.3, 0.2);
    this.particles.emit(origin, win ? (big ? 70 : 28) : 8, win ? color : "#b9a6d8", big ? 7 : 4, Math.PI * 0.9, 1.4);
    if (big) this.stage.addShake(0.35);
    if (win) this.glowFrame(color, big ? 3.2 : multiplier2boost(ball.multiplier), big ? 3 : 1);
    if (big) {
      gsap.fromTo(this.root.scale, { x: 1.035, y: 1.035, z: 1.035 }, { x: 1, y: 1, z: 1, duration: 0.7, ease: "elastic.out(1.3, 0.35)", overwrite: true });
    }
    sfx.land(ball.multiplier);
    this.onLand?.(ball.multiplier);
    if (ball.multiplier >= POPUP_MIN) this.popup(ball.multiplier, bucket.mesh.position.x, bucket.baseY + 0.45, color);

    // Ball dissolves into the bucket (its shadow shrinks with it).
    gsap.to(ball.fx, {
      size: 0,
      squash: 0,
      duration: 0.18,
      onUpdate: () => this.applyBallMotion(ball, ball.group.position.x, ball.group.position.y, 0),
      ease: "back.in(2)",
      onComplete: () => {
        this.board.remove(ball.group);
        this.board.remove(ball.shadow);
      },
    });
    this.balls.delete(ball);
    ball.resolve();
  }

  /**
   * Velocity-aligned squash & stretch: the pivot points along the motion, stretches with
   * speed and squashes on impact; the spinner inside is counter-rotated so the seed keeps
   * rolling naturally whatever the stretch axis.
   */
  private applyBallMotion(ball: Ball, x: number, y: number, dt: number) {
    if (dt > 0) {
      const vx = (x - ball.prev.x) / dt;
      const vy = (y - ball.prev.y) / dt;
      const speed = Math.hypot(vx, vy);
      if (speed > 0.5) ball.body.rotation.z = Math.atan2(vy, vx) - Math.PI / 2;
      ball.body.userData.stretch = Math.min(speed * 0.014, 0.18);
      ball.roll -= ball.dir * dt * (this.ballModel ? 6 : 9);
      if (this.ballModel) ball.spinner.rotation.y += dt * 2.2;
      ball.prev.set(x, y);
    }
    const stretch = (ball.body.userData.stretch as number | undefined) ?? 0;
    const { size, squash } = ball.fx;
    const along = 1 + stretch - squash;
    const across = 1 / Math.sqrt(Math.max(along, 0.4)); // keep the volume
    ball.body.scale.set(size * across, size * along, size * across);
    ball.spinner.rotation.z = ball.roll - ball.body.rotation.z;
    ball.shadow.position.set(x + SHADOW_OFFSET.x, y + SHADOW_OFFSET.y, ball.shadow.position.z);
    ball.shadow.scale.setScalar(size);
  }

  /** Flash the carved frame in the bucket's colour; `pulses` > 1 throbs for big wins. */
  private glowFrame(color: THREE.Color, strength: number, pulses: number) {
    if (!this.paint) return;
    gsap.killTweensOf(this.frameGlow);
    this.frameGlow.color.copy(color).lerp(new THREE.Color("#fff1d0"), 0.35);
    const tl = gsap.timeline({ onComplete: () => this.frameGlow.color.set("#ffc890") });
    for (let i = 0; i < pulses; i++) {
      tl.to(this.frameGlow, { boost: strength * (1 - i * 0.2), duration: 0.08, ease: "power2.out" })
        .to(this.frameGlow, { boost: 0, duration: pulses > 1 ? 0.35 : 0.7, ease: "power2.in" });
    }
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
        if (!shared.includes(mesh.geometry) && !this.keep.has(mesh.geometry)) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material & { map?: THREE.Texture | null };
        if (!shared.includes(mat) && !this.keep.has(mat)) {
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
