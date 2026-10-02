/**
 * Game audio (Web Audio): curated one-shots plus a music and an ambience loop from
 * public/audio/ (made by scripts/process-audio.ts), mixed on separate buses into a gentle
 * compressor. Audio starts on the first tap or key press (browser autoplay rules). Any sound
 * whose file is missing falls back to a small synthesized tone.
 */
const MUTE_KEY = "jungle-games:muted";

type Sound = "peg" | "loss" | "drop" | "click" | "win-small" | "win" | "win-big" | "coins" | "bigwin";
type Loop = "music" | "ambience";
const SOUNDS: Sound[] = ["peg", "loss", "drop", "click", "win-small", "win", "win-big", "coins", "bigwin"];
const LOOPS: Loop[] = ["music", "ambience"];

const MIX = { sfx: 0.9, music: 0.3, ambience: 0.22 };
/** Pentatonic steps (semitones) the peg note climbs through as the ball descends: it plays a tune. */
const PEG_SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
/** Most voices of one sound at once, so autobet showers never pile up. */
const MAX_VOICES: Partial<Record<Sound, number>> = { peg: 10, drop: 4, loss: 4, "win-small": 3, win: 3, click: 2 };

let ctx: AudioContext | undefined;
let master: GainNode | undefined;
let buses: Record<"sfx" | Loop, GainNode> | undefined;
const buffers = new Map<Sound | Loop, AudioBuffer>();
/** Sounds with no usable file: these fall back to synthesized tones. */
const missing = new Set<Sound | Loop>();
const voices = new Map<Sound, number>();
let loopsStarted = false;
let muted = readMuted();

// Download everything right away; decoding waits for the AudioContext (first gesture).
const files = new Map(
  [...SOUNDS, ...LOOPS].map((name) => [name, fetch(`/audio/${name}.mp3`).then((r) => (r.ok ? r.arrayBuffer() : undefined)).catch(() => undefined)] as const),
);

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Creates the context and decodes the sounds; called on the first user gesture. */
function unlock() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    // Gentle compression keeps dozens of overlapping peg notes from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    master.connect(comp).connect(ctx.destination);
    buses = { sfx: ctx.createGain(), music: ctx.createGain(), ambience: ctx.createGain() };
    for (const [name, bus] of Object.entries(buses)) {
      bus.gain.value = MIX[name as keyof typeof MIX];
      bus.connect(master);
    }
    const audio = ctx;
    for (const [name, file] of files) {
      void file.then(async (data) => {
        try {
          if (!data) throw new Error("missing");
          buffers.set(name, await audio.decodeAudioData(data));
          if (LOOPS.includes(name as Loop) && loopsStarted) startLoop(name as Loop);
        } catch {
          missing.add(name); // the synth fallback covers it
        }
      });
    }
  }
  if (muted) {
    void ctx.suspend();
    return;
  }
  if (ctx.state === "suspended") void ctx.resume();
  if (!loopsStarted) {
    loopsStarted = true;
    for (const loop of LOOPS) startLoop(loop);
  }
}
for (const event of ["pointerdown", "keydown"]) window.addEventListener(event, unlock, { passive: true });
// Silence the loops while the tab is hidden (and on phones, when the app is backgrounded).
document.addEventListener("visibilitychange", () => {
  if (!ctx || muted) return;
  void (document.hidden ? ctx.suspend() : ctx.resume());
});

const startedLoops = new Set<Loop>();
function startLoop(loop: Loop) {
  const buffer = buffers.get(loop);
  if (!ctx || !buses || !buffer || startedLoops.has(loop)) return;
  startedLoops.add(loop);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  // MP3 encoders pad the start and end with silence: loop only the audible part.
  const [start, end] = audibleRange(buffer);
  src.loopStart = start;
  src.loopEnd = end;
  const fadeIn = ctx.createGain();
  fadeIn.gain.setValueAtTime(0, ctx.currentTime);
  fadeIn.gain.linearRampToValueAtTime(1, ctx.currentTime + 3);
  src.connect(fadeIn).connect(buses[loop]);
  src.start(ctx.currentTime, start);
}

function audibleRange(buffer: AudioBuffer): [number, number] {
  const data = buffer.getChannelData(0);
  let first = 0;
  let last = data.length - 1;
  while (first < last && Math.abs(data[first]) < 1e-4) first++;
  while (last > first && Math.abs(data[last]) < 1e-4) last--;
  return [first / buffer.sampleRate, (last + 1) / buffer.sampleRate];
}

/**
 * Plays a one-shot. Returns false only when its file is missing, so the caller plays a tone
 * instead; while muted, locked or still decoding, nothing plays at all.
 */
function play(sound: Sound, { gain = 1, rate = 1, pan = 0, delay = 0 } = {}): boolean {
  if (muted || !ctx || !buses) return true;
  const buffer = buffers.get(sound);
  if (!buffer) return !missing.has(sound);
  const active = voices.get(sound) ?? 0;
  if (active >= (MAX_VOICES[sound] ?? 6)) return true;
  voices.set(sound, active + 1);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = gain;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  src.connect(g).connect(p).connect(buses.sfx);
  src.onended = () => voices.set(sound, (voices.get(sound) ?? 1) - 1);
  src.start(ctx.currentTime + delay);
  return true;
}

/** Fallback synthesized tone, used when a sound file is missing. */
function tone(freq: number, duration: number, type: OscillatorType, gain: number, delay = 0, pan = 0, slideTo?: number) {
  if (muted || !ctx || !buses) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  const p = ctx.createStereoPanner();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
  p.pan.value = pan;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g).connect(p).connect(buses.sfx);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

/** Lowers the music and ambience for a moment (big-win fanfare). */
function duck(hold: number) {
  if (!ctx || !buses) return;
  const t = ctx.currentTime;
  for (const loop of LOOPS) {
    const g = buses[loop].gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(MIX[loop] * 0.25, t + 0.25);
    g.setValueAtTime(MIX[loop] * 0.25, t + hold);
    g.linearRampToValueAtTime(MIX[loop], t + hold + 1.5);
  }
}

export const sfx = {
  setMuted(value: boolean) {
    muted = value;
    try {
      localStorage.setItem(MUTE_KEY, value ? "1" : "0");
    } catch {
      /* storage blocked: preference lasts for this page only */
    }
    if (!ctx) return;
    if (muted) void ctx.suspend();
    else unlock();
  },
  get muted() {
    return muted;
  },
  /** Kalimba note that climbs a pentatonic scale as the ball descends, panned to where it hit. */
  peg(row: number, pan = 0) {
    const step = PEG_SCALE[Math.min(Math.round((row / 15) * (PEG_SCALE.length - 1)), PEG_SCALE.length - 1)];
    const rate = 2 ** (step / 12) * 2 ** ((Math.random() - 0.5) * 0.02);
    if (!play("peg", { gain: 0.32, rate, pan: pan * 0.7 })) tone(520 + row * 38 + Math.random() * 20, 0.07, "triangle", 0.05, 0, pan * 0.7);
  },
  drop() {
    if (!play("drop", { gain: 0.55, rate: 0.95 + Math.random() * 0.1 })) tone(380, 0.16, "sine", 0.06, 0, 0, 240);
  },
  /** A loss gets a soft, neutral "tok" — never a jingle that celebrates or mocks it. */
  land(multiplier: number) {
    if (multiplier >= 10) {
      if (!play("win-big", { gain: 0.8 })) [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, "sine", 0.08, i * 0.07));
      play("coins", { gain: 0.5, delay: 0.25 });
    } else if (multiplier >= 2) {
      if (!play("win", { gain: 0.7 })) [523, 659, 784].forEach((f, i) => tone(f, 0.35, "sine", 0.08, i * 0.07));
    } else if (multiplier >= 1) {
      if (!play("win-small", { gain: 0.45 })) tone(660, 0.2, "sine", 0.07);
    } else if (!play("loss", { gain: 0.35, rate: 0.75 })) {
      tone(240, 0.2, "triangle", 0.05, 0, 0, 180);
    }
  },
  /** Fanfare for the big-win banner; the music steps back while it plays. */
  bigWin() {
    duck(5.5);
    if (!play("bigwin", { gain: 0.85 })) {
      [392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.5, "triangle", 0.07, i * 0.09));
    }
  },
  /** Soft tap for buttons and toggles. */
  click() {
    play("click", { gain: 0.4 });
  },
  /** What is loaded and playing (for debugging from the console). */
  status() {
    return { context: ctx?.state ?? "locked", decoded: [...buffers.keys()], missing: [...missing], loops: [...startedLoops] };
  },
};
