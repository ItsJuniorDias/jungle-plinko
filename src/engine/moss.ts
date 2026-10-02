/**
 * Volumetric moss ("fur shells") grown over the moss painted on a flat AI texture.
 *
 * The moss areas are found in the painting itself (green, and its sunlit yellow tips — not
 * teal vines or stone), then a stack of thin layers is drawn over them. Each layer keeps only
 * the strands long enough to reach it, so the pile reads as soft, fuzzy fibres: dark and
 * self-shadowed at the root, catching the golden backlight at the tips. The colour always
 * comes from the painting, so the moss keeps its painted palette.
 */
import * as THREE from "three";
import { mulberry32 } from "./painted";

export interface MossOptions {
  /** Part of the painting the surface shows, in UV (0–1, y down). */
  crop: { u0: number; v0: number; u1: number; v1: number };
  /** Area (in the surface's normalised −0.5…0.5 space) where no moss may grow. */
  exclude?: { halfX: number; halfY: number };
  layers: number;
}

export interface MossLayers {
  mesh: THREE.InstancedMesh;
  /** Positions and sizes the shells over a surface of `width × height`, `thickness` deep. */
  fit(width: number, height: number, thickness: number): void;
  dispose(): void;
}

const MASK = 256;
const CELLS = 24;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** R: cushion height (thick in the middle of a clump, thin at its edges). G: coverage. */
function mossMask(image: HTMLImageElement, opts: MossOptions): { tex: THREE.DataTexture; height: Float32Array } {
  const c = document.createElement("canvas");
  c.width = c.height = MASK;
  const ctx = c.getContext("2d")!;
  const { u0, v0, u1, v1 } = opts.crop;
  ctx.drawImage(image, u0 * image.width, v0 * image.height, (u1 - u0) * image.width, (v1 - v0) * image.height, 0, 0, MASK, MASK);
  const px = ctx.getImageData(0, 0, MASK, MASK).data;
  const cover = new Float32Array(MASK * MASK);
  for (let i = 0; i < cover.length; i++) {
    const [r, g, b, a] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3]];
    const green = g - Math.max(r * 0.9, b);
    let m = smooth(6, 34, green) * smooth(110, 200, a);
    if (opts.exclude) {
      const x = (i % MASK) / MASK - 0.5;
      const y = 0.5 - Math.floor(i / MASK) / MASK;
      const inside = Math.max(Math.abs(x) - opts.exclude.halfX, Math.abs(y) - opts.exclude.halfY);
      m *= smooth(-0.01, 0.015, inside);
    }
    cover[i] = m;
  }
  // Cushion height: blur the coverage so clumps bulge in the middle and thin out at the rim.
  const height = new Float32Array(cover.length);
  const R = 3;
  for (let y = 0; y < MASK; y++) {
    for (let x = 0; x < MASK; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const xx = Math.min(Math.max(x + dx, 0), MASK - 1);
          const yy = Math.min(Math.max(y + dy, 0), MASK - 1);
          sum += cover[yy * MASK + xx];
          n++;
        }
      }
      height[y * MASK + x] = smooth(0.15, 0.85, sum / n) * cover[y * MASK + x];
    }
  }
  const data = new Uint8Array(MASK * MASK * 4);
  for (let i = 0; i < cover.length; i++) {
    data[i * 4] = Math.round(height[i] * 255);
    data[i * 4 + 1] = Math.round(cover[i] * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, MASK, MASK, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, height };
}

/** Strand lengths: random per fibre, grouped in small tufts so the moss reads as clumps. */
function strandTexture(): THREE.DataTexture {
  const N = 128;
  const T = 16; // tuft grid
  const rand = mulberry32(77);
  const tufts = Array.from({ length: T * T }, () => 0.45 + 0.55 * rand());
  const tuft = (x: number, y: number) => {
    const fx = (x / N) * T;
    const fy = (y / N) * T;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = smooth(0, 1, fx - ix);
    const ty = smooth(0, 1, fy - iy);
    const at = (i: number, j: number) => tufts[((j + T) % T) * T + ((i + T) % T)];
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
    return top + (bottom - top) * ty;
  };
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      data[i * 4] = Math.round(Math.pow(rand(), 0.6) * tuft(x, y) * 255);
      data[i * 4 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds the moss shells for a flat surface whose painting is `map` (sampled on `crop` through
 * the second UV set, like the 3D board). Centre the mesh on the surface's front face.
 */
export function createMossLayers(map: THREE.Texture, opts: MossOptions): MossLayers {
  const image = map.image as HTMLImageElement;
  const { tex: maskTex, height } = mossMask(image, opts);
  const strands = strandTexture();
  const { u0, v0, u1, v1 } = opts.crop;

  // Only cells that contain moss get a quad, so the layers cost nothing over bare stone.
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const step = MASK / CELLS;
  for (let cy = 0; cy < CELLS; cy++) {
    for (let cx = 0; cx < CELLS; cx++) {
      let max = 0;
      for (let y = Math.max(cy * step - 2, 0); y < Math.min((cy + 1) * step + 2, MASK); y++) {
        for (let x = Math.max(cx * step - 2, 0); x < Math.min((cx + 1) * step + 2, MASK); x++) max = Math.max(max, height[y * MASK + x]);
      }
      if (max < 0.02) continue;
      const base = positions.length / 3;
      for (const [qx, qy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const mx = (cx + qx) / CELLS;
        const my = (cy + qy) / CELLS;
        positions.push(mx - 0.5, 0.5 - my, 0);
        uvs.push(u0 + mx * (u1 - u0), v0 + my * (v1 - v0));
      }
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv1", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(positions.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  geo.setIndex(indices);

  const uniforms = {
    uMossMask: { value: maskTex },
    uStrands: { value: strands },
    uCrop: { value: new THREE.Vector4(u0, v0, u1 - u0, v1 - v0) },
    uStrandScale: { value: new THREE.Vector2(1, 1) },
    uLayers: { value: opts.layers },
  };
  const material = new THREE.MeshLambertMaterial({ map, color: new THREE.Color(1.0, 0.94, 0.84) });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec2 uStrandScale;\nuniform float uLayers;\nvarying float vLayer;\nvarying vec2 vStrandUv;\nvarying float vTop;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vLayer = float(gl_InstanceID) / max(uLayers - 1.0, 1.0);
        vStrandUv = position.xy * uStrandScale;
        vTop = position.y + 0.5;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform sampler2D uMossMask;\nuniform sampler2D uStrands;\nuniform vec4 uCrop;\nvarying float vLayer;\nvarying vec2 vStrandUv;\nvarying float vTop;",
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        vec2 cushion = texture2D(uMossMask, (vMapUv - uCrop.xy) / uCrop.zw).rg;
        float strand = texture2D(uStrands, vStrandUv).r;
        // The root layer is a dense mat; higher layers keep only strands that reach them.
        if (vLayer < 0.001 ? cushion.g < 0.45 : strand * cushion.r < vLayer) discard;
        // Self-shadowing down in the pile, light catching the tips.
        diffuseColor.rgb *= mix(0.55, 1.3, vLayer);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        // Golden backlight shining through the fibre tips, strongest along the top of the board.
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.86, 0.45) * 0.8 * vLayer * vLayer * mix(0.35, 1.0, smoothstep(0.6, 1.0, vTop));`,
      );
  };
  material.customProgramCacheKey = () => "moss-shells";

  const mesh = new THREE.InstancedMesh(geo, material, opts.layers);
  mesh.name = "moss";
  return {
    mesh,
    fit(width, height, thickness) {
      mesh.scale.set(width, height, 1);
      // One strand texture repeat every 3.5 units of the surface, whatever its size.
      uniforms.uStrandScale.value.set(width / 3.5, height / 3.5);
      const m = new THREE.Matrix4();
      for (let i = 0; i < opts.layers; i++) mesh.setMatrixAt(i, m.makeTranslation(0, 0, (i / (opts.layers - 1)) * thickness));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    },
    dispose() {
      geo.dispose();
      material.dispose();
      maskTex.dispose();
      strands.dispose();
    },
  };
}
