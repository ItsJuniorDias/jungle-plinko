/**
 * Tiny synthesized sound kit (Web Audio), so the prototype has feedback
 * without audio assets. Replace with licensed/recorded sounds later.
 */
const MUTE_KEY = "jungle-games:muted";

let ctx: AudioContext | undefined;
let master: GainNode | undefined;
let muted = readMuted();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

function audio(): { a: AudioContext; out: GainNode } | undefined {
  if (muted) return undefined;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.9;
    // Gentle compression keeps dozens of overlapping peg ticks from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return { a: ctx, out: master! };
}

function tone(freq: number, duration: number, type: OscillatorType, gain: number, delay = 0, pan = 0, slideTo?: number) {
  const au = audio();
  if (!au) return;
  const { a, out } = au;
  const t = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  const p = a.createStereoPanner();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
  p.pan.value = pan;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(g).connect(p).connect(out);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

export const sfx = {
  setMuted(value: boolean) {
    muted = value;
    try {
      localStorage.setItem(MUTE_KEY, value ? "1" : "0");
    } catch {
      /* storage blocked: preference lasts for this page only */
    }
  },
  get muted() {
    return muted;
  },
  /** Wooden "tok" that climbs in pitch as the ball descends, panned to where it hit. */
  peg(row: number, pan = 0) {
    tone(520 + row * 38 + Math.random() * 20, 0.07, "triangle", 0.05, 0, pan * 0.7);
  },
  drop() {
    tone(380, 0.16, "sine", 0.06, 0, 0, 240);
  },
  land(multiplier: number) {
    if (multiplier >= 2) {
      [523, 659, 784, multiplier >= 10 ? 1046 : 0].forEach((f, i) => f && tone(f, 0.35, "sine", 0.08, i * 0.07));
    } else if (multiplier >= 1) {
      tone(660, 0.2, "sine", 0.07);
    } else {
      tone(240, 0.2, "triangle", 0.05, 0, 0, 180);
    }
  },
  /** Rising arpeggio + shimmer for the big-win banner. */
  bigWin() {
    [392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.5, "triangle", 0.07, i * 0.09));
    for (let i = 0; i < 10; i++) tone(2000 + Math.random() * 1500, 0.12, "sine", 0.02, 0.5 + i * 0.05, Math.random() * 2 - 1);
  },
};
