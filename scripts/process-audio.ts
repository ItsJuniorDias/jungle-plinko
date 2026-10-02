/**
 * Turns the curated source sounds in art/audio/ (Pixabay downloads, git-ignored) into the
 * game's audio in public/audio/: one-shots cut to the useful part, faded, peak-normalised and
 * mostly mono (the game pans them); the music normalised and kept whole (it is made to loop);
 * the ambience baked into a seamless loop with a crossfade at the seam.
 *
 *   npm run audio
 *
 * Sources (Pixabay Content License): see public/audio/CREDITS.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const SRC = "art/audio";
const OUT = "public/audio";

interface OneShot {
  /** Keep only this part of the source, in seconds. */
  from?: number;
  to?: number;
  fadeOut: number;
  mono?: boolean;
}

const ONE_SHOTS: Record<string, OneShot> = {
  peg: { from: 0.185, to: 0.43, fadeOut: 0.06, mono: true }, // one kalimba strike (~F4) of a repeated note
  loss: { to: 0.4, fadeOut: 0.08, mono: true }, // soft wood block, played low: a neutral "tok", never a mocking jingle
  drop: { from: 0.05, fadeOut: 0.08, mono: true },
  click: { to: 0.15, fadeOut: 0.03, mono: true },
  "win-small": { to: 1.65, fadeOut: 0.2 },
  win: { to: 2.7, fadeOut: 0.4 },
  "win-big": { from: 0.05, to: 5.4, fadeOut: 0.6 },
  coins: { to: 5.3, fadeOut: 0.3 },
  bigwin: { to: 6.75, fadeOut: 0.3 },
};

const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** Loudest sample level in dBFS after a filter chain (ffmpeg reports it on stderr). */
function peakDb(input: string, filters: string): number {
  const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", input, "-af", `${filters},volumedetect`, "-f", "null", "-"], { encoding: "utf8" });
  const match = stderr.match(/max_volume: (-?[\d.]+) dB/);
  return match ? Number(match[1]) : 0;
}

function oneShot(name: string, o: OneShot) {
  const input = `${SRC}/${name}.mp3`;
  const trim = `atrim=${o.from ?? 0}${o.to ? `:${o.to}` : ""},asetpts=PTS-STARTPTS`;
  const length = (o.to ?? Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input]))) - (o.from ?? 0);
  const chain = `${trim},afade=t=in:d=0.003,afade=t=out:st=${Math.max(length - o.fadeOut, 0).toFixed(3)}:d=${o.fadeOut}${o.mono ? ",pan=mono|c0=0.5*c0+0.5*c1" : ""}`;
  const gain = -1 - peakDb(input, chain); // peak at -1 dBFS; the game sets the mix
  ffmpeg(["-i", input, "-af", `${chain},volume=${gain.toFixed(2)}dB,aresample=44100`, "-c:a", "libmp3lame", "-q:a", "4", `${OUT}/${name}.mp3`]);
}

function music() {
  ffmpeg(["-i", `${SRC}/music.mp3`, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100", "-c:a", "libmp3lame", "-q:a", "5", `${OUT}/music.mp3`]);
}

/** A seamless loop of `length` s from `start` s: the last `xfade` s blend into the first ones. */
function ambienceLoop(start = 10, length = 60, xfade = 2) {
  const SR = 44100;
  const raw = execFileSync(
    "ffmpeg",
    ["-loglevel", "error", "-ss", String(start), "-t", String(length + xfade), "-i", `${SRC}/ambience.mp3`, "-ac", "2", "-ar", String(SR), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 },
  );
  const src = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const frames = Math.round(length * SR);
  const fade = Math.round(xfade * SR);
  const out = new Float32Array(frames * 2);
  for (let n = 0; n < frames; n++) {
    for (let c = 0; c < 2; c++) {
      const body = src[(n + fade) * 2 + c];
      const k = n - (frames - fade);
      // Equal-power crossfade of the tail into the head the loop restarts on.
      out[n * 2 + c] = k < 0 ? body : body * Math.cos((k / fade) * (Math.PI / 2)) + src[k * 2 + c] * Math.sin((k / fade) * (Math.PI / 2));
    }
  }
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", "-", "-af", "loudnorm=I=-22:TP=-2,aresample=44100", "-c:a", "libmp3lame", "-q:a", "6", `${OUT}/ambience.mp3`],
    { input: Buffer.from(out.buffer) },
  );
}

mkdirSync(OUT, { recursive: true });
for (const [name, o] of Object.entries(ONE_SHOTS)) {
  oneShot(name, o);
  console.log(`  ${name}`);
}
music();
console.log("  music");
ambienceLoop();
console.log("  ambience");
