/**
 * Plinko board view. Purely presentational: it receives a server-decided path
 * (0 = left, 1 = right per row) and choreographs the ball along it with
 * anticipation, squash & stretch and arcs. No randomness here affects results.
 */
import * as THREE from "three";
import gsap from "gsap";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Stage } from "../../engine/stage";
import { addSpringRim, springMaterial, springify } from "../../engine/materials";
import { boardAuraTextures, cleanBoardPainting, labelTexture, lightShaftTexture, plaqueLabelTexture, softDotTexture } from "../../engine/painted";
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
/** Board leans back so the camera sees the depth of the 3D props. */
const BOARD_TILT = THREE.MathUtils.degToRad(-12);
/** Light comes from the upper right, so the ball's shadow falls down-left on the slab. */
const SHADOW_OFFSET = new THREE.Vector2(-0.07, -0.13);

/**
 * Bucket colours follow the payout, not the position, so value reads at a glance: losses sit
 * in Spring's cool jade shade, break-even is sand, and wins heat up from amber to coral to rose.
 * Stops are on log10(multiplier).
 */
const VALUE_STOPS: [number, THREE.Color][] = [
  [Math.log10(0.5), new THREE.Color("#6f9a8f")],
  [0, new THREE.Color("#d8c08c")],
  [Math.log10(3), new THREE.Color("#f2a03e")],
  [Math.log10(15), new THREE.Color("#ee5a3f")],
  [2, new THREE.Color("#e2336f")],
];
const PEG_IDLE = new THREE.Color(1, 1, 1);
/** Outermost pegs of each row: the ball never touches them, so they step back. */
const PEG_GUARD = new THREE.Color(0.72, 0.72, 0.76);
const PEG_FLASH = new THREE.Color(3.2, 2.5, 1.6);
/** A hit peg cools down through a warm ember, so the ball's path stays readable for a moment. */
const PEG_TRAIL = new THREE.Color(1.5, 1.22, 0.9);
const PEG_TRAIL_TIME = 1.2;
const INTRO_ROW_DELAY = 0.035; // pegs pop in row by row when a board is built
const INTRO_POP = 0.38;
const WOBBLE_TIME = 0.8;
/** Multipliers at or above this get a floating "+N×" popup. */
const POPUP_MIN = 2;

const easeOutBack = (t: number) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

/** Bucket colour for a multiplier (also used by the history chips). */
export function multiplierColor(m: number): THREE.Color {
  const x = Math.log10(Math.max(m, 0.01));
  if (x <= VALUE_STOPS[0][0]) return VALUE_STOPS[0][1].clone();
  for (let i = 1; i < VALUE_STOPS.length; i++) {
    const [x1, c1] = VALUE_STOPS[i];
    const [x0, c0] = VALUE_STOPS[i - 1];
    if (x <= x1) return c0.clone().lerp(c1, (x - x0) / (x1 - x0));
  }
  return VALUE_STOPS[VALUE_STOPS.length - 1][1].clone();
}

/** 0 for losses up to 1 for 100× and above: drives plaque glow, rim and idle breathing. */
function valueHeat(m: number) {
  return THREE.MathUtils.clamp(Math.log10(Math.max(m, 0.01)) / 2, 0, 1);
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

/** Losing landing: the plaque dims for a moment instead of flashing. */
function dim(mat: THREE.Material) {
  const color = mat.userData.color as THREE.Color | undefined;
  if (!color || !("color" in mat)) return;
  const target = (mat as THREE.MeshToonMaterial).color;
  const state = { v: 0.62 };
  (mat.userData.tween as gsap.core.Tween | undefined)?.kill();
  mat.userData.tween = gsap.to(state, {
    v: 1,
    duration: 0.5,
    delay: 0.15,
    ease: "power2.inOut",
    onStart: () => target.copy(color).multiplyScalar(state.v),
    onUpdate: () => target.copy(color).multiplyScalar(state.v),
  });
  target.copy(color).multiplyScalar(state.v);
}

/** Uniforms shared by every frame material (and every rebuild's clone of the board). */
interface FrameUniforms {
  uFrameTime: { value: number };
  /** Size of the slab in board units, to turn the model's unit square into board space. */
  uSlabSize: { value: THREE.Vector2 };
  /** Half size of the recessed playfield ("well") inside the carved frame. */
  uPanelHalf: { value: THREE.Vector2 };
  /** UV step towards the light, to find vines that overhang (and shade) the well. */
  uVineShadowUv: { value: THREE.Vector2 };
  /** Win bounce light: the struck plaque lights the floor above it. */
  uWinPos: { value: THREE.Vector2 };
  uWinColor: { value: THREE.Color };
  uWinBoost: { value: number };
}

/**
 * Spring look for the carved, painted frame, chained after addSpringRim's shader patch:
 * - golden-hour grade: warm backlit top, teal shade at the base, olive moss that catches the
 *   sun, and teal cavities in the carving;
 * - a recessed playfield: a rounded well of cool teal shade inside the frame, shaded by the
 *   frame's inner walls and by painted vines that overhang it;
 * - a band of light travelling along the vines, and the bounce light of a winning plaque.
 */
function addFrameLook(mat: THREE.MeshStandardMaterial, u: FrameUniforms) {
  const previous = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    previous.call(mat, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec2 uSlabSize;\nvarying vec2 vSlabP;\nvarying float vFrameY;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vSlabP = position.xy * uSlabSize;
        vFrameY = position.y + 0.5;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uFrameTime;
        uniform vec2 uPanelHalf;
        uniform vec2 uVineShadowUv;
        uniform vec2 uWinPos;
        uniform vec3 uWinColor;
        uniform float uWinBoost;
        varying vec2 vSlabP;
        varying float vFrameY;
        float sdRoundBox(vec2 p, vec2 b, float r) {
          vec2 q = abs(p) - b + r;
          return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 paint = diffuseColor.rgb;
        float paintLuma = dot(paint, vec3(0.3, 0.5, 0.2));
        diffuseColor.rgb *= mix(vec3(0.62, 0.80, 0.88), vec3(1.10, 0.97, 0.82), smoothstep(0.1, 0.95, vFrameY));
        float moss = smoothstep(0.15, 0.45, (paint.g - max(paint.r, paint.b)) / (paint.g + 0.01));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 0.9, 0.55) + vec3(0.03, 0.02, 0.0), moss * 0.55);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        #ifdef USE_NORMALMAP_TANGENTSPACE
        diffuseColor.rgb *= mix(vec3(0.50, 0.66, 0.72), vec3(1.0), smoothstep(0.55, 0.95, normalize(mapN).z));
        #endif
        float well = sdRoundBox(vSlabP, uPanelHalf, 0.7);
        float inside = (1.0 - smoothstep(-0.3, 0.05, well)) * (1.0 - smoothstep(0.05, 0.12, paintLuma));
        vec2 wp = vSlabP / uPanelHalf;
        vec3 floorCol = paint * vec3(0.36, 0.9, 0.92) * mix(0.45, 0.8, smoothstep(-1.0, 1.0, wp.y));
        floorCol += vec3(1.0, 0.70, 0.42) * 0.012 * exp(-dot(wp - vec2(0.0, 0.55), wp - vec2(0.0, 0.55)) * 2.5);
        float lit = smoothstep(-0.1, 0.6, -sdRoundBox(vSlabP + vec2(0.18, 0.34), uPanelHalf, 0.7));
        float overhang = smoothstep(0.05, 0.14, dot(texture2D(map, vMapUv + uVineShadowUv).rgb, vec3(0.3, 0.5, 0.2)));
        floorCol *= mix(0.45, 1.0, lit) * (1.0 - 0.5 * overhang);
        diffuseColor.rgb = mix(diffuseColor.rgb, floorCol, inside);
        normal = normalize(mix(normal, nonPerturbedNormal, inside * 0.8));
        roughnessFactor = mix(roughnessFactor, 1.0, inside);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        float band = pow(0.5 + 0.5 * sin(vMapUv.x * 7.0 + vMapUv.y * 5.0 - uFrameTime * 1.6), 10.0);
        totalEmissiveRadiance *= (0.6 + 2.2 * band) * mix(1.0, 0.25, inside);
        totalEmissiveRadiance += vec3(1.0, 0.72, 0.40) * 0.22 * smoothstep(0.82, 1.0, vFrameY) * moss;
        vec2 winD = (vSlabP - uWinPos) * vec2(0.35, 0.6);
        totalEmissiveRadiance += uWinColor * uWinBoost * 0.18 * exp(-dot(winD, winD)) * inside;`,
      );
  };
  mat.customProgramCacheKey = () => "spring-rim-frame-look";
}

/** Idle shimmer: each spore peg breathes its glow on its own phase, entirely on the GPU. */
function addPegShimmer(mat: THREE.MeshToonMaterial, time: { value: number }) {
  const previous = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    previous.call(mat, shader, renderer);
    shader.uniforms.uPegTime = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vPegPhase;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
        vPegPhase = float(gl_InstanceID) * 2.39;
        #else
        vPegPhase = 0.0;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uPegTime;\nvarying float vPegPhase;")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance *= 0.75 + 0.6 * pow(0.5 + 0.5 * sin(uPegTime * 1.3 + vPegPhase), 4.0);`,
      );
  };
  mat.customProgramCacheKey = () => "spring-rim-peg-shimmer";
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
  private pegShadows?: THREE.InstancedMesh;
  private pegShadowGeo = new THREE.PlaneGeometry(PEG_R * 3.6, PEG_R * 2.6);
  private pegShadowMat: THREE.MeshBasicMaterial;
  /** Soft additive glow behind each spore, so the field glows without blowing out the orbs. */
  private pegHalos?: THREE.InstancedMesh;
  private pegHaloGeo = new THREE.PlaneGeometry(PEG_R * 5.5, PEG_R * 5.5);
  private pegHaloMat: THREE.MeshBasicMaterial;
  private pegGuard: boolean[] = [];
  private buckets: {
    mesh: THREE.Object3D;
    /** What swings on landing: the plaque only, so the label stays upright and readable. */
    swing: THREE.Object3D;
    label: THREE.Mesh;
    baseY: number;
    mat: THREE.Material;
    multiplier: number;
  }[] = [];
  /** Light pillars rising from winning plaques (pooled). */
  private pillars: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private nextPillar = 0;
  /** Golden backlight and drop shadow around the frame's silhouette. */
  private aura?: { backlight: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; shadow: THREE.Mesh };
  /** Drifting golden mist the frame's base sinks into, and a light shaft crossing in front. */
  private mist?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private frontShafts: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private slabCenterY = 0;
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
  private boardModel?: THREE.Object3D;
  /** Frame materials (shared by every rebuild's clone) driven by the board glow animations. */
  private frameMats: THREE.MeshStandardMaterial[] = [];
  private frameGlow = { boost: 0, color: new THREE.Color("#ffc890") };
  private glowTl?: gsap.core.Timeline;
  private winTween?: gsap.core.Timeline;
  /** World-space extent of the board frame, for placing things around it (the mascot). */
  readonly bounds = { halfWidth: 6, bottom: -6, top: 6 };
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
  /** Time uniform for the travelling light wave along the carved frame and the peg shimmer. */
  private frameWave = { value: 0 };
  private frameU: FrameUniforms = {
    uFrameTime: this.frameWave,
    uSlabSize: { value: new THREE.Vector2(1, 1) },
    uPanelHalf: { value: new THREE.Vector2(0.5, 0.5) },
    uVineShadowUv: { value: new THREE.Vector2() },
    uWinPos: { value: new THREE.Vector2() },
    uWinColor: { value: new THREE.Color() },
    uWinBoost: { value: 0 },
  };
  /** Part of board.webp shown by the 3D board (its second UV set), in UV. */
  private paintCrop = { u0: 0, v0: 0, u1: 1, v1: 1 };
  /** board.webp with its cut-out edge cleaned and inked (see cleanBoardPainting). */
  private cleanPaint?: HTMLCanvasElement;
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
    this.pegShadowMat = this.shadowMat.clone();
    this.pegShadowMat.opacity = 0.3;
    this.keep.add(this.pegShadowGeo).add(this.pegShadowMat);
    this.pegHaloMat = new THREE.MeshBasicMaterial({ map: this.glowTex, color: "#ffb46a", transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending });
    this.keep.add(this.pegHaloGeo).add(this.pegHaloMat);

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
      // Lit orbs with form (toon ramp, warm rim, cool shadow side) that only cross the bloom
      // threshold when hit; a slow per-peg shimmer keeps the field alive like drifting spores.
      const mat = springMaterial({ color: "#ffe9c8", map: src.map, emissive: "#ffc48a", emissiveIntensity: 0.6, rimColor: "#ffe2b0", rimStrength: 0.75, rimPower: 2.2 });
      addPegShimmer(mat, this.frameWave);
      this.keep.add(geo).add(mat);
      this.pegModel = { geo, mat };
      this.pegContactR = PEG_R * 1.25;
    }
    const boardModel = art?.model("board");
    if (boardModel) {
      // Carved stone frame: PBR (not toon) so the raking key light and the normal map bring
      // out the carving's relief, plus Spring's warm rim glow and a golden-hour colour tint.
      boardModel.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!mat?.isMeshStandardMaterial) return;
        mat.roughness = 0.9;
        mat.metalness = 0;
        mat.color.setRGB(1, 1, 1); // the golden-hour grade is done in the shader (addFrameLook)
        if (mat.normalMap) mat.normalScale.multiplyScalar(1.6); // keep glTF's flipped Y
        // Organic silhouette: swap in the painting WITH its alpha and cut along the carved,
        // rounded frame instead of showing the model's rectangular slab edges.
        const paint = art?.texture("board");
        if (paint && mat.map) {
          this.cleanPaint ??= cleanBoardPainting(paint.image as HTMLImageElement);
          const tex = new THREE.CanvasTexture(this.cleanPaint);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          tex.flipY = mat.map.flipY;
          tex.channel = mat.map.channel;
          tex.needsUpdate = true;
          mat.map = tex;
          // Cut above the painting's pale glow halo (the edge itself is inked by cleanBoardPainting).
          mat.alphaTest = 0.5;
          // With MSAA (desktop) the cut-out edge is antialiased instead of stair-stepped.
          mat.alphaToCoverage = true;
          this.keep.add(tex);
          const uv = (o as THREE.Mesh).geometry.getAttribute(`uv${tex.channel || ""}`) as THREE.BufferAttribute | undefined;
          if (uv) {
            const c = { u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity };
            for (let i = 0; i < uv.count; i++) {
              c.u0 = Math.min(c.u0, uv.getX(i));
              c.u1 = Math.max(c.u1, uv.getX(i));
              c.v0 = Math.min(c.v0, uv.getY(i));
              c.v1 = Math.max(c.v1, uv.getY(i));
            }
            this.paintCrop = c;
          }
        }
        // The painting doubles as an emissive map: the carved vines can "breathe" and flash.
        mat.emissiveMap = mat.map;
        mat.emissive.set("#ffc890");
        mat.emissiveIntensity = 0.06;
        addSpringRim(mat, "#ffcf8a", 0.55, 2.4);
        addFrameLook(mat, this.frameU);
        this.frameMats.push(mat);
      });
      this.protect(boardModel);
      this.boardModel = boardModel;
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
    const shaft = lightShaftTexture();
    const pillarGeo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0); // grows up from its base
    const uv = pillarGeo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); // brightest at the plaque
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: shaft, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const pillar = new THREE.Mesh(pillarGeo, mat);
      pillar.renderOrder = 3;
      pillar.visible = false;
      this.keep.add(mat);
      this.pillars.push(pillar);
    }
    this.keep.add(shaft).add(pillarGeo);
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
    // the painted stone board when available, otherwise a soft dark panel.
    const boardTex = this.art?.texture("board");
    // The painted/3D board has a thick carved frame: grow it so pegs sit on the smooth inner area.
    const framePad = this.boardModel || boardTex ? 1.24 : 1;
    const slab: THREE.Object3D = this.boardModel
      ? this.boardModel.clone(true)
      : boardTex
      ? new THREE.Mesh(
          new THREE.PlaneGeometry(boardWidth * framePad, boardHeight * framePad),
          new THREE.MeshBasicMaterial({ map: boardTex, transparent: true, opacity: 0.94, depthWrite: false }),
        )
      : new THREE.Mesh(
          new RoundedBoxGeometry(boardWidth, boardHeight, 0.1, 4, 0.5),
          new THREE.MeshBasicMaterial({ color: "#1a1028", transparent: true, opacity: this.art?.texture("background") ? 0.72 : 0.38, depthWrite: false }),
        );
    if (this.boardModel) {
      // Normalised model (≈1×1, depth ≈0.15): stretch to the board, carved face just behind the pegs.
      const depth = 3.2;
      slab.scale.set(boardWidth * framePad, boardHeight * framePad, depth);
      slab.position.set(0, (top + bottom) / 2, -0.45 - 0.074 * depth);
      // The recessed playfield is shaded inside the frame material (addFrameLook): size it here.
      const slabW = boardWidth * framePad;
      const slabH = boardHeight * framePad;
      this.slabCenterY = (top + bottom) / 2;
      this.frameU.uSlabSize.value.set(slabW, slabH);
      this.frameU.uPanelHalf.value.set(boardWidth / 2 + 0.05, boardHeight / 2 + 0.12);
      const crop = this.paintCrop;
      // Vines up and to the right of a point (towards the key light) shade it.
      this.frameU.uVineShadowUv.value.set((0.12 / slabW) * (crop.u1 - crop.u0), (-0.2 / slabH) * (crop.v1 - crop.v0));
      this.addAura(slabW, slabH, slab.position.y, slab.position.z - 0.074 * depth);
    } else {
      slab.position.set(0, (top + bottom) / 2, -0.4);
      slab.renderOrder = -2;
    }
    this.board.add(slab);

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
    this.pegGuard = [];
    for (let r = 0; r < rows; r++) {
      for (let j = 0; j < r + 3; j++) {
        const guard = j === 0 || j === r + 2;
        this.pegs.setColorAt(this.pegPositions.length, guard ? PEG_GUARD : PEG_IDLE);
        this.pegPositions.push(new THREE.Vector3(this.pegX(r, j), this.rowY(r), 0));
        this.pegRows.push(r);
        this.pegGuard.push(guard);
      }
    }
    this.pegHits = new Array(pegCount).fill(-10);
    this.pegHitDir = new Array(pegCount).fill(1);
    // Soft contact shadows tie the floating spores to the floor, like the ball's.
    this.pegShadows = this.pegModel ? new THREE.InstancedMesh(this.pegShadowGeo, this.pegShadowMat, pegCount) : undefined;
    this.pegHalos = this.pegModel ? new THREE.InstancedMesh(this.pegHaloGeo, this.pegHaloMat, pegCount) : undefined;
    if (this.pegShadows && this.pegHalos) {
      this.pegShadows.renderOrder = -1;
      this.pegGuard.forEach((guard, i) => this.pegHalos!.setColorAt(i, guard ? PEG_GUARD : PEG_IDLE));
      this.board.add(this.pegShadows, this.pegHalos);
    }
    this.introStart = this.time;
    this.updatePegMatrices(true);
    this.board.add(this.pegs);
    for (const pillar of this.pillars) {
      pillar.visible = false;
      this.board.add(pillar);
    }

    // Buckets.
    const bucketTex = this.art?.texture("bucket");
    const bucketGeo = bucketTex
      ? new THREE.PlaneGeometry(S * 0.96, Math.min((S * 0.96) / this.art!.aspect("bucket"), 0.75))
      : new RoundedBoxGeometry(S * 0.88, 0.5, 0.45, 3, 0.12);
    const labelGeo = new THREE.PlaneGeometry(S * 0.9, S * 0.9 * (224 / 384));
    for (let k = 0; k <= rows; k++) {
      // Colour and glow are set from the payout in setRisk().
      const color = new THREE.Color();
      let mesh: THREE.Object3D;
      let swing: THREE.Object3D;
      let material: THREE.Material;
      let labelZ: number;
      if (this.bucketModel) {
        // 3D carved plaque: its painted texture tinted by the bucket colour (toon colour × map).
        const pivot = new THREE.Group();
        const plaque = this.bucketModel.clone(true);
        springify(plaque, { color, emissive: color, emissiveIntensity: 0, rimColor: "#fff3d6", rimStrength: 0.55 });
        pivot.add(plaque);
        mesh = pivot;
        swing = plaque;
        material = firstMesh(plaque)!.material as THREE.Material;
        labelZ = 0.28;
      } else {
        material = bucketTex
          ? new THREE.MeshBasicMaterial({ map: bucketTex, color, transparent: true, depthWrite: false })
          : springMaterial({ color, emissive: color, emissiveIntensity: 0, rimColor: "#fff3d6", rimStrength: 0.5 });
        mesh = new THREE.Mesh(bucketGeo, material);
        swing = mesh;
        labelZ = bucketTex ? 0.02 : 0.24;
      }
      const baseY = this.bucketY();
      mesh.position.set(this.bucketX(k), baseY, 0);
      const label = new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      label.position.z = labelZ;
      mesh.add(label);
      this.board.add(mesh);
      this.buckets.push({ mesh, swing, label, baseY, mat: material, multiplier: 1 });
    }
    this.setRisk(risk);

    // Scale every board to the same world height and centre it.
    const scale = BOARD_WORLD_HEIGHT / boardHeight;
    this.board.scale.setScalar(scale);
    this.board.position.y = (-(top + bottom) / 2) * scale;
    this.board.rotation.x = BOARD_TILT;
    this.bounds.halfWidth = (boardWidth * framePad * scale) / 2;
    this.bounds.bottom = this.board.position.y + (bottom - (boardHeight * (framePad - 1)) / 2) * scale;
    this.bounds.top = this.board.position.y + (top + (boardHeight * (framePad - 1)) / 2) * scale;
    if (this.boardModel) {
      // The tilt brings the frame's base well towards the camera: find where it really is.
      this.board.updateMatrix();
      const base = new THREE.Vector3(0, bottom - (boardHeight * (framePad - 1)) / 2, -0.4).applyMatrix4(this.board.matrix);
      this.addAtmosphere(base);
    }
    // The tilt brings the bottom edge towards the camera (and the 3D frame has depth),
    // so leave extra vertical room and aim slightly low.
    const tiltRoom = this.boardModel ? 1.1 : 1.04;
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
    this.buckets.forEach((bucket, k) => {
      const m = table[k];
      bucket.multiplier = m;
      const label = bucket.label.material as THREE.MeshBasicMaterial;
      label.map?.dispose();
      label.map = plaqueLabelTexture(formatMultiplier(m).replace(/×$/, ""));
      label.needsUpdate = true;
      // Plaques are tinted by value; idle glow stays under the bloom threshold so only a
      // landing makes a plaque bloom. Jackpots get a gold rim.
      const color = multiplierColor(m);
      const heat = valueHeat(m);
      const mat = bucket.mat;
      (mat.userData.tween as gsap.core.Tween | undefined)?.kill();
      if (mat instanceof THREE.MeshToonMaterial) {
        mat.color.copy(color);
        mat.emissive.copy(color);
        mat.userData.base = 0.03 + heat * 0.14;
        mat.emissiveIntensity = mat.userData.base;
        const rim = mat.userData.rim as { rimColor: { value: THREE.Color }; rimStrength: { value: number } } | undefined;
        rim?.rimColor.value.set(heat >= 0.9 ? "#ffd36b" : "#fff3d6");
        if (rim) rim.rimStrength.value = 0.45 + heat * 0.6;
      } else if (mat instanceof THREE.MeshBasicMaterial) {
        mat.color.copy(color);
        mat.userData.base = color.clone();
      }
      mat.userData.color = color;
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
    this.frameWave.value = this.time;
    if (this.frameMats.length) {
      const breathe = 0.06 + 0.035 * (0.5 + 0.5 * Math.sin(this.time * 1.3));
      for (const m of this.frameMats) {
        m.emissiveIntensity = breathe + this.frameGlow.boost;
        m.emissive.copy(this.frameGlow.color);
      }
      if (this.aura) this.aura.backlight.material.opacity = 0.3 + breathe * 1.5 + this.frameGlow.boost * 0.2;
    }
    this.frontShafts.forEach((m, i) => (m.material.opacity = 0.03 + 0.04 * (0.5 + 0.5 * Math.sin(this.time * 0.4 + i * 1.7))));

    // High-paying plaques breathe a slow ember glow while idle (kept under the bloom threshold).
    this.buckets.forEach((b, k) => {
      if (b.multiplier < 10 || !(b.mat instanceof THREE.MeshToonMaterial)) return;
      if ((b.mat.userData.tween as gsap.core.Tween | undefined)?.isActive()) return;
      b.mat.emissiveIntensity = (b.mat.userData.base as number) + 0.1 * (0.5 + 0.5 * Math.sin(this.time * 2.2 + k * 0.7));
    });

    // Peg flash decay.
    if (this.pegs) {
      const c = new THREE.Color();
      let dirty = false;
      this.pegHits.forEach((hitAt, i) => {
        const age = this.time - hitAt;
        if (age > PEG_TRAIL_TIME + 0.15) return;
        if (age < 0.2) c.copy(PEG_FLASH).lerp(PEG_TRAIL, age / 0.2);
        else c.copy(PEG_TRAIL).lerp(PEG_IDLE, Math.min((age - 0.2) / (PEG_TRAIL_TIME - 0.2), 1));
        this.pegs!.setColorAt(i, c);
        this.pegHalos?.setColorAt(i, c);
        dirty = true;
      });
      if (dirty && this.pegs.instanceColor) this.pegs.instanceColor.needsUpdate = true;
      if (dirty && this.pegHalos?.instanceColor) this.pegHalos.instanceColor.needsUpdate = true;
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
    const shadowPos = new THREE.Vector3();
    const noTurn = new THREE.Quaternion();
    this.pegPositions.forEach((pos, i) => {
      const intro = Math.min(Math.max((this.time - this.introStart - this.pegRows[i] * INTRO_ROW_DELAY) / INTRO_POP, 0), 1);
      const hitAge = this.time - this.pegHits[i];
      const pulse = hitAge < 0.3 ? 0.45 * Math.exp(-hitAge * 14) : 0;
      // Damped spring: the peg sways away from the ball, overshoots and settles.
      const wobble = hitAge < WOBBLE_TIME ? 0.55 * Math.exp(-hitAge * 6) * Math.sin(hitAge * 26) : 0;
      q.setFromEuler(euler.set(wobble * 0.5, 0, -wobble * this.pegHitDir[i]));
      const size = Math.max(easeOutBack(intro), 0) * (this.pegGuard[i] ? 0.85 : 1);
      scale.setScalar(size * (1 + pulse));
      this.pegs!.setMatrixAt(i, m.compose(pos, q, scale));
      if (this.pegShadows && this.pegHalos) {
        shadowPos.set(pos.x, pos.y, -0.05);
        this.pegHalos.setMatrixAt(i, m.compose(shadowPos, noTurn, scale));
        shadowPos.set(pos.x + SHADOW_OFFSET.x * 1.2, pos.y + SHADOW_OFFSET.y * 1.2, -0.4);
        this.pegShadows.setMatrixAt(i, m.compose(shadowPos, noTurn, scale.setScalar(size)));
      }
    });
    this.pegs.instanceMatrix.needsUpdate = true;
    if (this.pegShadows && this.pegHalos) {
      this.pegShadows.instanceMatrix.needsUpdate = true;
      this.pegHalos.instanceMatrix.needsUpdate = true;
    }
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
    const color = multiplierColor(ball.multiplier);
    const win = ball.multiplier >= 1;
    const big = ball.multiplier >= 10;

    // Bucket gets "pushed" down and bounces back.
    gsap.fromTo(bucket.mesh.position, { y: bucket.baseY - 0.22 }, { y: bucket.baseY, duration: 0.5, ease: "elastic.out(1.2, 0.35)", overwrite: true });
    gsap.fromTo(bucket.mesh.scale, { x: 1.15, y: 0.8 }, { x: 1, y: 1, duration: 0.45, ease: "elastic.out(1.2, 0.4)", overwrite: true });
    // The plaque swings like a struck gong while the label stays upright and punches out,
    // so the payout is readable at the payoff moment.
    const swing = (win ? 0.55 : 0.3) * ball.dir * (big ? 1.35 : 1);
    gsap.fromTo(bucket.swing.rotation, { y: swing, z: -0.12 * ball.dir }, { y: 0, z: 0, duration: 0.9, ease: "elastic.out(1.1, 0.3)", overwrite: true });
    if (win) {
      const punch = big ? 1.5 : 1.3;
      gsap.fromTo(bucket.label.scale, { x: punch, y: punch }, { x: 1, y: 1, duration: 0.45, ease: "back.out(3)", overwrite: true });
    }
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
    // Kept moderate so the bloom never swallows the payout printed on the plaque.
    if (win) flash(bucket.mat, big ? 0.9 : 0.6);
    else dim(bucket.mat);
    if (ball.multiplier >= POPUP_MIN) this.lightPillar(bucket.mesh.position.x, bucket.baseY, color, big);
    this.bounceLight(bucket.mesh.position.x, bucket.baseY, color, big ? 2.2 : win ? multiplier2boost(ball.multiplier) : 0);

    const origin = new THREE.Vector3(bucket.mesh.position.x, bucket.baseY + 0.3, 0.2);
    this.particles.emit(origin, win ? (big ? 70 : 28) : 6, win ? color : "#9cbfb3", big ? 7 : win ? 4 : 2, Math.PI * 0.9, 1.4);
    if (big) this.stage.addShake(0.35);
    if (win) this.glowFrame(color, big ? 2.6 : multiplier2boost(ball.multiplier), big ? 3 : 1);
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

  /** A column of light rises from a winning plaque (twice, and wider, for big wins). */
  private lightPillar(x: number, y: number, color: THREE.Color, big: boolean) {
    const pillar = this.pillars[this.nextPillar++ % this.pillars.length];
    const mat = pillar.material;
    gsap.killTweensOf([mat, pillar.scale]);
    mat.color.copy(color).lerp(new THREE.Color("#fff1d0"), 0.3).multiplyScalar(2.2); // over 1 → bloom
    pillar.position.set(x, y, 0.15);
    pillar.visible = true;
    const width = S * (big ? 1.6 : 1.1);
    const height = big ? 5.2 : 3.6;
    const tl = gsap.timeline({ onComplete: () => void (pillar.visible = false) });
    for (let i = 0; i < (big ? 2 : 1); i++) {
      tl.fromTo(pillar.scale, { x: width * 0.45, y: height * 0.6 }, { x: width, y: height, duration: 0.6, ease: "power2.out" }, i * 0.45)
        .fromTo(mat, { opacity: 0 }, { opacity: 0.9, duration: 0.12, ease: "power1.out" }, i * 0.45)
        .to(mat, { opacity: 0, duration: 0.48, ease: "power2.in" }, i * 0.45 + 0.12);
    }
  }

  /** Warm bounce light from the struck plaque, rising up the recessed floor. */
  private bounceLight(x: number, y: number, color: THREE.Color, boost: number) {
    if (!this.frameMats.length || boost <= 0) return;
    const u = this.frameU;
    this.winTween?.kill();
    u.uWinColor.value.copy(color).lerp(new THREE.Color("#fff1d0"), 0.3);
    u.uWinPos.value.set(x, y - this.slabCenterY);
    u.uWinBoost.value = 0;
    this.winTween = gsap
      .timeline()
      .to(u.uWinBoost, { value: boost, duration: 0.1, ease: "power2.out" })
      .to(u.uWinBoost, { value: 0, duration: 0.8, ease: "power2.in" })
      .to(u.uWinPos.value, { y: y - this.slabCenterY + 1.8, duration: 0.9, ease: "power1.out" }, 0);
  }

  /** Golden backlight wrapping the frame's top silhouette, and a cool drop shadow behind it. */
  private addAura(slabW: number, slabH: number, y: number, backZ: number) {
    const image = this.cleanPaint;
    if (!image) return;
    const margin = 0.1;
    if (!this.aura) {
      const tex = boardAuraTextures(image, this.paintCrop, margin);
      const plane = new THREE.PlaneGeometry(1, 1);
      const backlight = new THREE.Mesh(
        plane,
        new THREE.MeshBasicMaterial({ map: tex.backlight, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
      );
      const shadow = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: tex.shadow, transparent: true, opacity: 0.55, depthWrite: false, fog: false }));
      backlight.renderOrder = shadow.renderOrder = -5;
      this.keep.add(plane).add(tex.backlight).add(tex.shadow).add(backlight.material).add(shadow.material);
      this.aura = { backlight, shadow };
    }
    const grow = 1 / (1 - 2 * margin);
    this.aura.backlight.scale.set(slabW * grow * 1.04, slabH * grow * 1.06, 1);
    this.aura.backlight.position.set(0, y + 0.25, backZ - 0.05);
    this.aura.shadow.scale.set(slabW * grow, slabH * grow, 1);
    this.aura.shadow.position.set(-0.3, y - 0.5, backZ - 0.1);
    this.board.add(this.aura.shadow, this.aura.backlight);
  }

  /** Golden mist the frame's base sinks into, and two faint light shafts crossing in front. */
  private addAtmosphere(base: THREE.Vector3) {
    if (!this.mist) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: this.frameWave, uColor: { value: new THREE.Color("#ffc58a") }, uOpacity: { value: 0.26 } },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uColor;
          uniform float uOpacity;
          varying vec2 vUv;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
          }
          void main() {
            float n = noise(vec2(vUv.x * 6.0 + uTime * 0.06, vUv.y * 2.0 - uTime * 0.02)) * 0.65
              + noise(vec2(vUv.x * 13.0 - uTime * 0.1, vUv.y * 5.0)) * 0.35;
            float profile = smoothstep(0.05, 0.45, vUv.y) * (1.0 - smoothstep(0.52, 0.85, vUv.y));
            float sides = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(0.82, 1.0, vUv.x));
            gl_FragColor = vec4(uColor, profile * sides * (0.45 + 0.55 * n) * uOpacity);
          }`,
        transparent: true,
        depthWrite: false,
      });
      this.mist = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      this.mist.renderOrder = 5;
      this.root.add(this.mist);

      const shaft = lightShaftTexture();
      const geo = new THREE.PlaneGeometry(3.5, 22);
      for (let i = 0; i < 2; i++) {
        const m = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ map: shaft, color: "#ffd8a8", transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
        );
        m.rotation.z = 0.32;
        m.renderOrder = 5;
        this.frontShafts.push(m);
        this.root.add(m);
      }
    }
    const { halfWidth, top } = this.bounds;
    this.mist.scale.set(halfWidth * 2.6, 2.6, 1);
    this.mist.position.set(0, base.y, base.z + 0.5);
    this.frontShafts.forEach((m, i) => m.position.set(halfWidth * (0.55 + i * 0.4), top + 3, base.z + 0.5));
  }

  /** Flash the carved frame in the bucket's colour; `pulses` > 1 throbs for big wins. */
  private glowFrame(color: THREE.Color, strength: number, pulses: number) {
    if (!this.frameMats.length) return;
    // Kill the previous flash timeline itself (not just its tweens): an emptied timeline would
    // still complete next tick and its onComplete would reset this flash's colour.
    this.glowTl?.kill();
    this.frameGlow.color.copy(color).lerp(new THREE.Color("#fff1d0"), 0.35);
    const tl = gsap.timeline({ onComplete: () => this.frameGlow.color.set("#ffc890") });
    this.glowTl = tl;
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
          if (mat.map instanceof THREE.CanvasTexture && !this.keep.has(mat.map)) mat.map.dispose();
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
    this.pegShadows = undefined;
    this.pegHalos = undefined;
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
