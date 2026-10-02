/**
 * Procedurally "painted" textures drawn on 2D canvases: sky, misty ridge
 * silhouettes and soft sprites. Placeholders in the Spring palette until real
 * hand-painted art (Blender bakes / painted PNGs) replaces them.
 */
import * as THREE from "three";

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d")! };
}

function texture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Deterministic PRNG so the scenery is identical on every load. */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Warm dusk sky with a sun glow and brushy cloud dabs. */
export function skyTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(512, 1024);
  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, "#1d3557");
  g.addColorStop(0.3, "#3f6c8f");
  g.addColorStop(0.55, "#d9a46c");
  g.addColorStop(0.72, "#ffcf7a");
  g.addColorStop(1, "#ffe7b0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);

  const sun = ctx.createRadialGradient(330, 640, 10, 330, 640, 380);
  sun.addColorStop(0, "rgba(255,240,200,0.95)");
  sun.addColorStop(0.25, "rgba(255,205,150,0.45)");
  sun.addColorStop(1, "rgba(255,180,130,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, c.width, c.height);

  const rand = mulberry32(7);
  for (let i = 0; i < 140; i++) {
    const y = 160 + rand() * 520;
    const x = rand() * c.width;
    const r = 18 + rand() * 50;
    ctx.fillStyle = `rgba(255,${200 + rand() * 40},${170 + rand() * 50},${0.04 + rand() * 0.07})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 2.4, r * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return texture(c);
}

/** A misty mountain/forest ridge, coloured for its distance (atmospheric perspective). */
export function ridgeTexture(seed: number, top: string, bottom: string, roughness: number, trees: boolean) {
  const { c, ctx } = canvas(1024, 512);
  const rand = mulberry32(seed);
  const pts: number[] = [];
  let y = 180 + rand() * 80;
  for (let x = 0; x <= c.width; x += 8) {
    y += (rand() - 0.5) * roughness;
    y = Math.min(Math.max(y, 60), 320);
    pts.push(y);
  }

  const g = ctx.createLinearGradient(0, 60, 0, c.height);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, c.height);
  pts.forEach((py, i) => ctx.lineTo(i * 8, py));
  ctx.lineTo(c.width, c.height);
  ctx.fill();

  if (trees) {
    for (let i = 0; i < 70; i++) {
      const idx = Math.floor(rand() * pts.length);
      const tx = idx * 8;
      const ty = pts[idx] + 6;
      const h = 30 + rand() * 60;
      ctx.beginPath();
      ctx.moveTo(tx - h * 0.22, ty);
      ctx.lineTo(tx, ty - h);
      ctx.lineTo(tx + h * 0.22, ty);
      ctx.fill();
    }
  }

  // Mist pooling at the base of the ridge.
  const mist = ctx.createLinearGradient(0, 260, 0, c.height);
  mist.addColorStop(0, "rgba(255,230,200,0)");
  mist.addColorStop(1, "rgba(255,214,160,0.35)");
  ctx.fillStyle = mist;
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillRect(0, 0, c.width, c.height);
  return texture(c);
}

/** Soft round sprite for pollen, sparks and glows. */
export function softDotTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return texture(c);
}

/** Vertical light shaft: bright at the top, fading out to the bottom and the sides. */
export function lightShaftTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(128, 512);
  const v = ctx.createLinearGradient(0, 0, 0, c.height);
  v.addColorStop(0, "rgba(255,236,190,0.9)");
  v.addColorStop(1, "rgba(255,236,190,0)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, c.width, c.height);
  const h = ctx.createLinearGradient(0, 0, c.width, 0);
  h.addColorStop(0, "rgba(0,0,0,1)");
  h.addColorStop(0.5, "rgba(0,0,0,0)");
  h.addColorStop(1, "rgba(0,0,0,1)");
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, c.width, c.height);
  return texture(c);
}

/**
 * Bucket plaque label: dark ink numerals with a pale outline so they read on any plaque tint,
 * and a smaller "×" so the digits get most of the width.
 */
export function plaqueLabelTexture(value: string, width = 384, height = 224): THREE.CanvasTexture {
  const { c, ctx } = canvas(width, height);
  const unit = "×";
  let size = Math.round(height * 0.66);
  const font = (px: number) => `900 ${px}px "Nunito", "Trebuchet MS", sans-serif`;
  const measure = () => {
    ctx.font = font(size);
    const digits = ctx.measureText(value).width;
    ctx.font = font(size * 0.68);
    return { digits, unit: ctx.measureText(unit).width, gap: size * 0.03 };
  };
  let m = measure();
  while (size > 12 && m.digits + m.gap + m.unit > width * 0.94) {
    size -= 2;
    m = measure();
  }
  const x0 = (width - (m.digits + m.gap + m.unit)) / 2;
  const baseline = height / 2 + size * 0.36;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  const draw = (text: string, x: number, px: number) => {
    ctx.font = font(px);
    ctx.lineWidth = height * 0.075;
    ctx.strokeStyle = "rgba(255,244,222,0.92)";
    ctx.strokeText(text, x, baseline);
    ctx.fillStyle = "#2a150b";
    ctx.fillText(text, x, baseline);
  };
  draw(value, x0, size);
  draw(unit, x0 + m.digits + m.gap, size * 0.68);
  const t = texture(c);
  t.anisotropy = 4;
  return t;
}

/** Separable box blur of a single channel (running sums, so it is O(pixels) for any radius). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const pass = (from: Float32Array, to: Float32Array, len: number, lines: number, step: number, stride: number) => {
    for (let l = 0; l < lines; l++) {
      const base = l * stride;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += from[base + Math.min(Math.max(i, 0), len - 1) * step];
      for (let i = 0; i < len; i++) {
        to[base + i * step] = sum / (2 * r + 1);
        sum += from[base + Math.min(i + r + 1, len - 1) * step] - from[base + Math.max(i - r, 0) * step];
      }
    }
  };
  pass(src, tmp, w, h, 1, w);
  pass(tmp, out, h, w, w, 1);
  return out;
}

/**
 * Cleans the AI-painted board's cut-out edge once at load: drops thin slivers and floating
 * specks of the painted glow halo, and inks the remaining silhouette with a dark painterly
 * contour (Spring's line work) instead of a pale, torn fringe.
 */
export function cleanBoardPainting(image: HTMLImageElement | HTMLCanvasElement | ImageBitmap): HTMLCanvasElement {
  const { width: w, height: h } = image;
  const { c, ctx } = canvas(w, h);
  ctx.drawImage(image, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3] / 255;
  const near = boxBlur(alpha, w, h, Math.round(w / 170));
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < alpha.length; i++) {
    if (!px[i * 4 + 3]) continue;
    const ink = (1 - smooth(0.55, 0.95, near[i])) * 0.85;
    px[i * 4] += (22 - px[i * 4]) * ink;
    px[i * 4 + 1] += (17 - px[i * 4 + 1]) * ink;
    px[i * 4 + 2] += (18 - px[i * 4 + 2]) * ink;
    px[i * 4 + 3] = Math.round(px[i * 4 + 3] * smooth(0.4, 0.62, near[i]));
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Soft light and shadow around the board's organic silhouette, from the painting's alpha:
 * a golden backlight wrapping the top edge (the sun sits right behind it) and a cool drop
 * shadow. `crop` is the part of the image the 3D board shows, in UV (0–1, y down); the
 * silhouette fills the middle `1 - 2 * margin` of each texture.
 */
export function boardAuraTextures(
  image: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  crop: { u0: number; v0: number; u1: number; v1: number },
  margin: number,
): { backlight: THREE.CanvasTexture; shadow: THREE.CanvasTexture } {
  const S = 256;
  const { width: w, height: h } = image;
  // Blur by downsampling: smooth scaling works everywhere, unlike ctx.filter on older Safari.
  const blurred = (steps: number) => {
    const small = canvas(steps, steps);
    small.ctx.drawImage(
      image,
      crop.u0 * w, crop.v0 * h, (crop.u1 - crop.u0) * w, (crop.v1 - crop.v0) * h,
      steps * margin, steps * margin, steps * (1 - 2 * margin), steps * (1 - 2 * margin),
    );
    const out = canvas(S, S);
    out.ctx.imageSmoothingQuality = "high";
    out.ctx.drawImage(small.c, 0, 0, S, S);
    return out;
  };

  const glow = blurred(56);
  glow.ctx.globalCompositeOperation = "source-in";
  const warm = glow.ctx.createLinearGradient(0, 0, 0, S);
  warm.addColorStop(0, "rgba(255,196,120,1)");
  warm.addColorStop(0.3, "rgba(255,170,100,0.5)");
  warm.addColorStop(0.6, "rgba(255,160,90,0)");
  glow.ctx.fillStyle = warm;
  glow.ctx.fillRect(0, 0, S, S);

  const shade = blurred(40);
  shade.ctx.globalCompositeOperation = "source-in";
  shade.ctx.fillStyle = "#14232c";
  shade.ctx.fillRect(0, 0, S, S);

  return { backlight: texture(glow.c), shadow: texture(shade.c) };
}

/** Text label texture (multipliers on the buckets). */
export function labelTexture(text: string, color: string, width = 256, height = 128): THREE.CanvasTexture {
  const { c, ctx } = canvas(width, height);
  let size = Math.round(height * 0.56);
  const font = () => `800 ${size}px "Nunito", "Trebuchet MS", sans-serif`;
  ctx.font = font();
  while (size > 10 && ctx.measureText(text).width > width * 0.86) {
    size -= 2;
    ctx.font = font();
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = height * 0.1;
  ctx.strokeStyle = "rgba(40,24,30,0.85)";
  ctx.strokeText(text, width / 2, height / 2 + 4);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2 + 4);
  const t = texture(c);
  t.anisotropy = 4;
  return t;
}
