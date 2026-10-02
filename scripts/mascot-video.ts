/**
 * AI mascot animation pipeline (OpenRouter):
 *  1. `ref`: a clean, neutral full-body pose of the mascot on a flat green screen (Nano Banana),
 *     redrawn from the cover-art crop in art/ref/mascot.png.
 *  2. One clip per reaction that starts on that pose, and also ends on it when the video model
 *     takes a last frame, so clips chain without a jump. With a first-frame-only model, the
 *     idle is made seamless as a ping-pong (forward, then reversed) and the game crossfades
 *     reactions back to the idle.
 *  3. Local green-screen key (free) → one H.264 .mp4 per clip in public/mascot/, with the alpha
 *     stacked under the colour (iOS drops the alpha of HEVC video uploaded to WebGL).
 *
 *   npm run mascot -- ref              # the reference pose (needed once)
 *   npm run mascot -- idle happy       # these clips (skips steps whose output exists)
 *   npm run mascot -- idle --force     # regenerate (spends credits again)
 *
 * Needs OPENROUTER_API_KEY in .env. MASCOT_VIDEO_MODEL picks the video model (default HeyGen
 * Video 1; "kwaivgi/kling-v3.0-std" takes a last frame too). Raw outputs stay in art/mascot-video/ (git-ignored), so re-running a clip
 * whose raw video exists only re-keys and re-encodes it.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env */
}

const API_KEY = process.env.OPENROUTER_API_KEY;
const IMAGE_MODEL = process.env.IMAGE_MODEL || "google/gemini-2.5-flash-image";
const VIDEO_MODEL = process.env.MASCOT_VIDEO_MODEL || "heygen/heygen-video-1";
const RAW = "art/mascot-video";
const OUT = "public/mascot";
const REF_SOURCE = "art/ref/mascot.png";
const REF = `${RAW}/ref.png`;
const SIZE = 512; // game encode, square
const CLIP_GAP = 16; // black rows between the colour and alpha halves

const STATIC =
  " Static locked-off camera: no camera movement, no zoom, no cuts. The flat green-screen background stays perfectly uniform and " +
  "unchanged; no ground, no shadows, no particles, no new objects. Hand-painted Spring (Blender Studio) style, soft painterly fur, " +
  "warm golden rim light. The whole character stays fully inside the frame.";

const CLIPS: Record<string, { duration: number; prompt: string; loop?: boolean }> = {
  idle: {
    duration: 5,
    loop: true,
    prompt:
      "The little jungle creature stays seated in place and idles: it breathes gently, blinks slowly, one ear twitches, its tail sways " +
      "softly and it glances around curiously, then settles back into exactly its starting pose.",
  },
  drop: {
    duration: 3,
    prompt:
      "The creature perks up its ears and leans forward eagerly, watching something fall from above, with a small excited bounce, " +
      "then settles back into exactly its starting pose.",
  },
  tension: {
    duration: 4,
    prompt:
      "The creature holds its breath: it leans in, eyes wide, both paws pressed over its mouth, ears tense and trembling slightly, " +
      "then relaxes back into exactly its starting pose.",
  },
  happy: {
    duration: 4,
    prompt:
      "The creature hops up with joy, a big happy smile with its eyes squeezed shut, claps its paws, lands softly and settles back " +
      "into exactly its starting pose.",
  },
  bigWin: {
    duration: 6,
    prompt:
      "The creature leaps high in celebration, spins around once in the air with both arms raised and its tail swirling, lands, " +
      "cheers with a huge smile, then settles back into exactly its starting pose.",
  },
  sad: {
    duration: 4,
    prompt:
      "The creature is disappointed: its ears droop, its shoulders slump, it sighs and looks down, then perks back up and settles " +
      "back into exactly its starting pose.",
  },
};

// --- OpenRouter --------------------------------------------------------------------

function headers() {
  if (!API_KEY) throw new Error("OPENROUTER_API_KEY is missing from .env");
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", "X-Title": "jungle-games mascot video" };
}

async function check(res: Response, what: string): Promise<any> {
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${what}: ${res.status} ${data?.error?.message ?? JSON.stringify(data)}`);
  return data;
}

const dataUri = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;

async function makeReference() {
  console.log(`ref: neutral pose (${IMAGE_MODEL})`);
  const prompt =
    "Use the attached image only as the character reference. Redraw this exact same character — a small fluffy bush-baby jungle creature " +
    "with big round amber eyes, dark brown eye patches, huge ears with cream fur tufts, a brown body, cream chest fur and a long, ringed, " +
    "curly tail — as a full-body game character in a neutral, relaxed idle pose: sitting upright on its haunches, facing three-quarters " +
    "towards the viewer, front paws resting in front of it, mouth closed in a gentle smile, tail curled up beside it. The whole character, " +
    "ears and tail included, is visible with generous empty space around it: it fills about half of the image height, centred " +
    "horizontally, sitting in the lower middle, so there is room above it for jumps. Hand-painted style of Blender Studio's 'Spring' " +
    "(2019): soft painterly fur, warm golden rim light on the fur edges. Background: a perfectly flat, uniform, pure chroma-key green " +
    "(#00FF00) screen filling every empty area, with no floor, no shadow, no gradient, no scenery, no props, no text. The character " +
    "itself contains no green.";
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: IMAGE_MODEL,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUri(REF_SOURCE) } }] }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: "1:1" },
    }),
  });
  const data = await check(res, "ref");
  const url: string | undefined = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`ref: no image returned: ${data.choices?.[0]?.message?.content ?? "empty"}`);
  writeFileSync(REF, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
  console.log(`  → ${REF}`);
}

interface VideoModel {
  supported_durations: number[] | null;
  supported_resolutions: string[] | null;
  supported_frame_images: string[] | null;
  /** Whether audio can be switched off (some models always render it; it is dropped anyway). */
  generate_audio: boolean;
}

/** What the video model accepts (durations, resolutions, first/last frame), from OpenRouter. */
async function videoModel(): Promise<VideoModel> {
  const list = await check(await fetch("https://openrouter.ai/api/v1/videos/models", { headers: headers() }), "models");
  const model = (list.data as ({ id: string } & VideoModel)[]).find((m) => m.id === VIDEO_MODEL);
  if (!model) throw new Error(`unknown video model ${VIDEO_MODEL}`);
  return model;
}

/** Generates the raw clip; returns whether it was pinned to end on the reference pose. */
async function animate(name: string, path: string, model: VideoModel): Promise<boolean> {
  const clip = CLIPS[name];
  const durations = model.supported_durations ?? [clip.duration];
  const duration = durations.find((d) => d >= clip.duration) ?? durations[durations.length - 1];
  const resolutions = model.supported_resolutions ?? ["720p"];
  const resolution = ["768p", "720p"].find((r) => resolutions.includes(r)) ?? resolutions[resolutions.length - 1];
  const endsOnRef = model.supported_frame_images?.includes("last_frame") ?? false;
  console.log(`${name}: animating (${VIDEO_MODEL}, ${duration}s, ${resolution}${endsOnRef ? ", ends on the reference pose" : ""})`);
  const frame = (frame_type: string) => ({ type: "image_url", image_url: { url: dataUri(REF) }, frame_type });
  const job = await check(
    await fetch("https://openrouter.ai/api/v1/videos", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: VIDEO_MODEL,
        prompt: clip.prompt + STATIC,
        frame_images: endsOnRef ? [frame("first_frame"), frame("last_frame")] : [frame("first_frame")],
        duration,
        aspect_ratio: "1:1",
        resolution,
        ...(model.generate_audio && { generate_audio: false }),
      }),
    }),
    `${name} submit`,
  );
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await check(await fetch(`https://openrouter.ai/api/v1/videos/${job.id}`, { headers: headers() }), `${name} poll`);
    process.stdout.write(`\r  ${status.status} ${Math.round((Date.now() - started) / 1000)}s   `);
    if (status.status === "completed") break;
    if (status.status === "failed") throw new Error(`${name}: generation failed ${JSON.stringify(status.error ?? status)}`);
    if (Date.now() - started > 20 * 60_000) throw new Error(`${name}: timed out`);
  }
  process.stdout.write("\n");
  const video = await fetch(`https://openrouter.ai/api/v1/videos/${job.id}/content?index=0`, { headers: headers() });
  if (!video.ok) throw new Error(`${name} download: ${video.status}`);
  writeFileSync(path, Buffer.from(await video.arrayBuffer()));
  writeFileSync(path.replace(/\.mp4$/, ".json"), JSON.stringify({ model: VIDEO_MODEL, duration, resolution, endsOnRef }));
  return endsOnRef;
}

// --- Green-screen key + encode -------------------------------------------------------

/** The green the model actually painted (often a dull one): median of the first frame's border. */
async function screenColour(video: string): Promise<[number, number, number]> {
  const png = execFileSync("ffmpeg", ["-loglevel", "error", "-i", video, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"]);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const samples: number[][] = [];
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  };
  for (let x = 0; x < info.width; x += 8) (at(x, 2), at(x, info.height - 3));
  for (let y = 0; y < info.height; y += 8) (at(2, y), at(info.width - 3, y));
  const median = (k: number) => samples.map((s) => s[k]).sort((a, b) => a - b)[samples.length >> 1];
  return [median(0), median(1), median(2)];
}

function videoSize(path: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", path]);
  const [width, height, rate] = out.toString().trim().split(",");
  return { width: Number(width), height: Number(height), rate };
}

/**
 * Keys out the green screen by how much green dominates red and blue — the mascot has none, so
 * even a dull, low-saturation screen (which a chroma-distance key confuses with brown fur) comes
 * off cleanly. Edge pixels are un-mixed from the screen colour and the remaining green spill on
 * the fur is clamped. Writes a lossless RGBA intermediate.
 */
async function greenKey(raw: string, keyed: string) {
  const [br, bg, bb] = await screenColour(raw);
  const screen = bg - Math.max(br, bb); // how green the screen is
  if (screen < 12) throw new Error(`the background is not green enough to key (#${[br, bg, bb].map((c) => c.toString(16).padStart(2, "0")).join("")})`);
  const lo = screen * 0.22; // fully opaque below
  const hi = screen * 0.7; // fully transparent above
  const { width, height, rate } = videoSize(raw);
  const decode = spawn("ffmpeg", ["-loglevel", "error", "-i", raw, "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const encode = spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", rate, "-i", "-",
    "-c:v", "png", keyed,
  ]);
  const done = new Promise<void>((resolve, reject) => {
    encode.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`key encode failed (${code})`))));
    decode.on("error", reject);
  });
  const frameBytes = width * height * 3;
  let pending = Buffer.alloc(0);
  for await (const chunk of decode.stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= frameBytes) {
      const rgb = pending.subarray(0, frameBytes);
      pending = pending.subarray(frameBytes);
      const out = Buffer.alloc(width * height * 4);
      const alpha = new Float32Array(width * height);
      for (let p = 0, i = 0; p < frameBytes; p += 3, i++) {
        const t = Math.min(Math.max((rgb[p + 1] - Math.max(rgb[p], rgb[p + 2]) - lo) / (hi - lo), 0), 1);
        alpha[i] = 1 - t * t * (3 - 2 * t);
      }
      for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
          let a = alpha[i];
          const q = i * 4;
          if (a === 0) continue;
          let r = rgb[i * 3];
          let g = rgb[i * 3 + 1];
          let b = rgb[i * 3 + 2];
          if (a < 1) {
            // Un-mix the screen colour from soft edge pixels.
            r = (r - (1 - a) * br) / a;
            g = (g - (1 - a) * bg) / a;
            b = (b - (1 - a) * bb) / a;
          }
          // The fur's outline (next to a see-through pixel) picks up the screen's green: despill it
          // harder and thin it slightly. Inside, only clamp any green cast (keeps the amber eyes).
          let edge = false;
          for (let dy = -1; dy <= 1 && !edge; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < width && yy < height && alpha[yy * width + xx] < 0.6) {
                edge = true;
                break;
              }
            }
          }
          if (edge) {
            g = Math.min(g, (r + b) / 2 + 4);
            a *= 0.85;
          } else {
            g = Math.min(g, Math.max(r, b) + 6);
          }
          out[q] = Math.min(Math.max(r, 0), 255);
          out[q + 1] = Math.min(Math.max(g, 0), 255);
          out[q + 2] = Math.min(Math.max(b, 0), 255);
          out[q + 3] = Math.round(a * 255);
        }
      }
      if (!encode.stdin.write(out)) await new Promise((r) => encode.stdin.once("drain", r));
    }
  }
  encode.stdin.end();
  await done;
}

async function keyAndEncode(name: string, raw: string, pingPong: boolean) {
  mkdirSync(OUT, { recursive: true });
  const keyed = `${RAW}/${name}.keyed.mov`;
  console.log(`${name}: keying the green screen, encoding${pingPong ? " as a ping-pong loop" : ""}`);
  await greenKey(raw, keyed);
  // A loop that cannot end on its first frame plays forward then backwards, so it still meets itself.
  const loop = pingPong ? "split[f][r];[r]reverse[b];[f][b]concat=n=2:v=1:a=0," : "";
  const fit =
    loop +
    `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  // Stacked alpha (src/games/plinko/VideoMascot.ts reads it): colour on top, alpha as grey
  // CLIP_GAP rows below it, in plain H.264 that every browser can upload to WebGL.
  const stack =
    `[0]${fit},format=rgba,split[c][a];[a]alphaextract,format=rgb24[al];` +
    `[c]format=rgb24,pad=${SIZE}:${SIZE * 2 + CLIP_GAP}:0:0:black[top];[top][al]overlay=0:${SIZE + CLIP_GAP},` +
    "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p";
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", keyed, "-filter_complex", stack,
    "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-profile:v", "high",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", "-an", `${OUT}/${name}.mp4`,
  ]);
  console.log(`  → ${OUT}/${name}.mp4`);
}

async function main() {
  mkdirSync(RAW, { recursive: true });
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const names = args.filter((a) => !a.startsWith("--"));
  const unknown = names.filter((n) => n !== "ref" && !CLIPS[n]);
  if (unknown.length) throw new Error(`unknown: ${unknown.join(", ")} (known: ref, ${Object.keys(CLIPS).join(", ")})`);

  if (names.includes("ref") && (force || !existsSync(REF))) await makeReference();
  if (!existsSync(REF)) throw new Error(`run "npm run mascot -- ref" first (${REF} is missing)`);
  let model: VideoModel | undefined;
  for (const name of names.filter((n) => n !== "ref")) {
    const raw = `${RAW}/${name}.mp4`;
    if (force || !existsSync(raw)) await animate(name, raw, (model ??= await videoModel()));
    const meta = JSON.parse(readFileSync(raw.replace(/\.mp4$/, ".json"), "utf8")) as { endsOnRef: boolean };
    await keyAndEncode(name, raw, Boolean(CLIPS[name].loop) && !meta.endsOnRef);
  }
}

main().catch((err) => {
  console.error(`\n${err.message ?? err}`);
  process.exit(1);
});
