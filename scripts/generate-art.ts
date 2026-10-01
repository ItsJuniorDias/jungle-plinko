/**
 * Generates every game image with Nano Banana (Gemini 2.5 Flash Image) via OpenRouter,
 * all in the same "Spring" (Blender Studio) look.
 *
 *   npm run art                 # generate whatever is missing
 *   npm run art -- ball peg     # only these assets
 *   npm run art -- --force      # regenerate everything (the anchor too)
 *
 * Consistency: the `background` asset is generated first and becomes the STYLE ANCHOR —
 * it is sent as a reference image with every other prompt.
 * Transparency: sprites/layers are painted on flat magenta and chroma-keyed here with sharp.
 *
 * Raw model outputs go to art/raw/ (kept so keying can be re-tuned without paying again);
 * game-ready files go to public/art/ plus public/art/manifest.json.
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env — rely on the real environment */
}

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.IMAGE_MODEL || "google/gemini-2.5-flash-image";
const RAW_DIR = "art/raw";
const OUT_DIR = "public/art";

const STYLE =
  "Hand-painted stylized fantasy illustration in the style of Blender Studio's open movie 'Spring' (2019): " +
  "painterly brush textures, soft volumetric mist and atmosphere, warm golden-hour backlight with cool teal-blue shadows, " +
  "rich saturated yet harmonious palette (amber, peach, teal, deep indigo), soft glowing rim light on edges, " +
  "cinematic and magical, clean high-quality game art.";
const NO_TEXT = " No text, no letters, no watermark, no signature, no UI, no frame.";
const KEYED =
  " Isolated on a perfectly flat, uniform, pure magenta (#FF00FF) background that fills every empty area; " +
  "no shadow, glow, gradient or texture on the magenta background; the subject must not contain magenta or pink.";

interface Asset {
  name: string;
  prompt: string;
  /** Must be one OpenRouter accepts: 1:1 1:4 1:8 2:3 3:2 3:4 4:1 4:3 4:5 5:4 8:1 9:16 16:9 21:9. */
  aspect: "1:1" | "16:9" | "21:9" | "3:4" | "3:2";
  /** Chroma-key the magenta background to transparency. */
  keyed?: boolean;
  /** Key out whatever plain colour surrounds the subject, without asking for magenta in the prompt. */
  keyBorder?: boolean;
  /**
   * Keep only the top fraction of the trimmed image. Used for the logo: Nano Banana
   * tends to paint a whole scene under the lettering, which itself comes out well.
   */
  keepTop?: number;
  /** Crop to the opaque content after keying (sprites). */
  trim?: boolean;
  /** Longest side of the final file. */
  size: number;
  text?: boolean;
  /**
   * Send the style anchor as a reference image. Off for isolated objects whose
   * framing differs a lot from a landscape: the model tends to paste the
   * reference scene behind them instead of just borrowing its style.
   */
  anchor?: boolean;
}

const ASSETS: Asset[] = [
  {
    name: "background",
    aspect: "16:9",
    size: 2048,
    prompt:
      "Wide establishing shot used as a casual game background: a magical misty valley at golden hour seen from a high mountain meadow; " +
      "layered silhouettes of tall pine forests and distant snowy peaks fading into warm mist; a large glowing sun low behind the mountains " +
      "with soft god rays; floating pollen specks. The central area is calm, slightly darker and low-detail so game elements stay readable on top.",
  },
  {
    name: "layer-forest",
    anchor: true,
    aspect: "21:9",
    size: 2048,
    keyed: true,
    prompt:
      "A single horizontal ridge of tall dark teal pine trees and rocks occupying ONLY the bottom 40% of the image, side to side, " +
      "with warm golden backlight catching the tree tips and mist pooling between trunks. Everything above the treeline is empty magenta.",
  },
  {
    name: "layer-foliage",
    aspect: "21:9",
    size: 2048,
    keyed: true,
    prompt:
      "Foreground framing elements: dark, slightly out-of-focus ferns, broad leaves and grass clumps rising from the bottom edge and " +
      "the bottom-left and bottom-right corners only, with warm rim light on the leaf edges. The whole upper and central area is empty magenta.",
  },
  {
    name: "board",
    aspect: "1:1",
    keyBorder: true,
    size: 1024,
    prompt:
      "Flat texture, front orthographic view, filling the whole image edge to edge with no scenery around it: a game board panel — a slab of weathered, moss-covered dark stone " +
      "with carved organic swirl ornaments and thin vines along its border; the large inner surface is smooth, evenly lit, dark deep indigo, " +
      "completely empty (no pegs, no objects), so bright game pieces read clearly on it.",
  },
  {
    name: "ball",
    aspect: "1:1",
    size: 512,
    keyed: true,
    trim: true,
    prompt:
      "Game sprite, front view, centered: one magical golden seed — a round glowing amber berry with a soft inner light and painterly highlights — " +
      "with one small fresh green leaf sprouting from its top.",
  },
  {
    name: "peg",
    aspect: "1:1",
    size: 256,
    keyed: true,
    trim: true,
    prompt:
      "Game sprite, front view, centered: one small round luminous spore orb, creamy white pearl with a warm peach glow and a soft highlight. Simple and readable at tiny sizes.",
  },
  {
    name: "bucket",
    aspect: "1:1",
    size: 512,
    keyed: true,
    trim: true,
    prompt:
      "Game sprite, front view, centered: one small wide rounded carved stone tile, like a smooth pebble plaque, in a pale neutral cream-white color " +
      "(it will be tinted in game), soft painted shading and a few carved leaf ornaments on its rim, empty face.",
  },
  {
    name: "leaf",
    aspect: "1:1",
    keepTop: 0.82, // drop the cast shadow the model paints under the leaf
    size: 128,
    keyed: true,
    trim: true,
    prompt: "Game particle sprite, centered: one small single leaf, warm orange and gold with painted veins and a bright rim light.",
  },
  {
    name: "logo",
    aspect: "16:9",
    keepTop: 0.14,
    size: 1024,
    keyed: true,
    trim: true,
    text: true,
    prompt:
      "Game logo lettering that reads exactly \"JUNGLE PLINKO\" (two words, correct spelling): chunky rounded hand-painted golden letters " +
      "with warm rim light, wrapped by small leafy vines, a tiny glowing golden seed dotting the design. Centered, front view, no other text.",
  },
  {
    name: "cover",
    anchor: true,
    aspect: "16:9",
    size: 1920,
    prompt:
      "Promotional key art for a Plinko casino game: glowing golden seeds bouncing down through a triangular grid of luminous spore orbs " +
      "floating in a magical misty pine forest at sunset; at the side, a small fluffy big-eared forest creature (like a mix of a lemur and a fox) " +
      "watches with wide excited eyes; dramatic warm backlight, bloom and pollen.",
  },
];

// --- OpenRouter -------------------------------------------------------------

async function generate(asset: Asset, anchor?: Buffer): Promise<Buffer> {
  const text =
    `${STYLE} ${asset.prompt}${asset.keyed ? KEYED : ""}${asset.text ? "" : NO_TEXT}` +
    (anchor ? " Match the exact painting style, brushwork, palette and lighting of the reference image, but do not copy its composition." : "");
  const content: object[] = [{ type: "text", text }];
  if (anchor) content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${anchor.toString("base64")}` } });

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "X-Title": "jungle-games art pipeline",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content }],
          modalities: ["image", "text"],
          image_config: { aspect_ratio: asset.aspect },
        }),
      });
      const data: any = await res.json();
      if (!res.ok) throw new Error(`${res.status} ${data?.error?.message ?? JSON.stringify(data)}`);
      const url: string | undefined = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!url) throw new Error(`no image returned: ${data.choices?.[0]?.message?.content ?? "empty"}`);
      return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`  ↻ ${asset.name}: ${(err as Error).message} — retrying`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// --- Chroma key -------------------------------------------------------------

/**
 * Keys out the background by colour distance from the median border colour
 * (models rarely paint exact #FF00FF), then "un-mixes" semi-transparent edge
 * pixels from that colour so no magenta fringe remains.
 */
async function chromaKey(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const border: number[][] = [];
  for (let x = 0; x < width; x += 4) border.push(px(x, 0), px(x, height - 1));
  for (let y = 0; y < height; y += 4) border.push(px(0, y), px(width - 1, y));
  // Median of the magenta-looking border pixels, not #FF00FF: the model paints its own
  // shade (e.g. #CD2F80). Layers have subject on some borders, hence the filter.
  const magentaBorder = border.filter((p) => magentaness(p[0], p[1], p[2]) > 50);
  const bg = [0, 1, 2].map((c) => median((magentaBorder.length ? magentaBorder : border).map((p) => p[c])));

  const INNER = 45; // ≤ this colour distance from bg: fully background
  const OUTER = 110; // ≥ this distance: fully subject
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
    const byDistance = smooth((d - INNER) / (OUTER - INNER));
    // Catches background gradients (e.g. a sky fading from magenta to pink at the horizon).
    const byHue = 1 - smooth((magentaness(data[i], data[i + 1], data[i + 2]) - 35) / 45);
    const a = Math.min(byDistance, byHue);
    if (a < 1 && a > 0) {
      for (let c = 0; c < 3; c++) data[i + c] = clamp((data[i + c] - bg[c] * (1 - a)) / a);
    }
    data[i + 3] = Math.round(a * 255);
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();

  function px(x: number, y: number) {
    const o = (y * width + x) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  }
}

/** How much a colour leans magenta: red and blue both well above green. */
const magentaness = (r: number, g: number, b: number) => Math.min(r, b) - g;
const smooth = (t: number) => Math.min(Math.max(t, 0), 1);
const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
function median(values: number[]) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// --- Pipeline ---------------------------------------------------------------

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function finalize(asset: Asset, raw: Buffer) {
  let img = asset.keyed || asset.keyBorder ? await chromaKey(raw) : raw;
  let pipeline = sharp(img);
  if (asset.trim) {
    img = await pipeline.trim({ threshold: 1 }).toBuffer();
    // Small transparent margin so bilinear filtering never clips the edge.
    if (asset.keepTop) {
      const meta = await sharp(img).metadata();
      img = await sharp(img)
        .extract({ left: 0, top: 0, width: meta.width!, height: Math.round(meta.height! * asset.keepTop) })
        .png()
        .toBuffer();
      img = await sharp(img).trim({ threshold: 1 }).toBuffer();
    }
    pipeline = sharp(img).extend({ top: 8, bottom: 8, left: 8, right: 8, background: { r: 0, g: 0, b: 0, alpha: 0 } });
    img = await pipeline.png().toBuffer();
    pipeline = sharp(img);
  }
  const out = await pipeline
    .resize({ width: asset.size, height: asset.size, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 88, alphaQuality: 95 })
    .toBuffer({ resolveWithObject: true });
  const file = `${asset.name}.webp`;
  await writeFile(join(OUT_DIR, file), out.data);
  return { file, width: out.info.width, height: out.info.height };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const only = args.filter((a) => !a.startsWith("--"));
  const unknown = only.filter((n) => !ASSETS.some((a) => a.name === n));
  if (unknown.length) throw new Error(`unknown asset(s): ${unknown.join(", ")}. Available: ${ASSETS.map((a) => a.name).join(", ")}`);

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  const manifestPath = join(OUT_DIR, "manifest.json");
  const manifest: Record<string, { file: string; width: number; height: number }> = (await exists(manifestPath))
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : {};

  const wanted = ASSETS.filter((a) => !only.length || only.includes(a.name));
  // "Missing" = no raw output AND no game-ready file. art/raw/ is git-ignored, so a fresh
  // clone (which ships public/art/) must not silently pay to regenerate everything.
  const todo = [];
  for (const a of wanted) {
    const hasRaw = await exists(join(RAW_DIR, `${a.name}.png`));
    if (force || (!hasRaw && !manifest[a.name])) todo.push(a);
  }
  console.log(`model: ${MODEL}\nto generate: ${todo.map((a) => a.name).join(", ") || "nothing"}`);
  if (todo.length && !API_KEY) throw new Error("OPENROUTER_API_KEY is missing — add it to .env (see .env.example)");

  // 1) Style anchor first (or reuse the existing one).
  const anchorAsset = ASSETS[0];
  const anchorPath = join(RAW_DIR, `${anchorAsset.name}.png`);
  if (todo.includes(anchorAsset)) {
    console.log(`• ${anchorAsset.name} (style anchor)…`);
    await writeFile(anchorPath, await sharp(await generate(anchorAsset)).png().toBuffer());
  }
  const anchor = (await exists(anchorPath)) ? await readFile(anchorPath) : undefined;

  // 2) Everything else, 3 at a time, referencing the anchor.
  const queue = todo.filter((a) => a !== anchorAsset);
  const failures: string[] = [];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        console.log(`• ${a.name}…`);
        try {
          await writeFile(join(RAW_DIR, `${a.name}.png`), await sharp(await generate(a, a.anchor ? anchor : undefined)).png().toBuffer());
        } catch (err) {
          failures.push(a.name);
          console.error(`  ✗ ${a.name}: ${(err as Error).message}`);
        }
      }
    }),
  );

  // 3) Post-process every wanted asset that has a raw image (re-keys old ones too).
  for (const a of wanted) {
    const rawPath = join(RAW_DIR, `${a.name}.png`);
    if (!(await exists(rawPath))) continue;
    manifest[a.name] = await finalize(a, await readFile(rawPath));
    console.log(`  ✓ public/art/${manifest[a.name].file} (${manifest[a.name].width}×${manifest[a.name].height})`);
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (failures.length) {
    console.error(`\nfailed: ${failures.join(", ")} — run again to retry only those`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
