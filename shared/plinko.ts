/**
 * Plinko game math — shared by server and client.
 *
 * Each row the ball goes left (float < 0.5) or right. The landing bucket is the
 * number of "rights", so bucket k has binomial probability C(n,k) / 2^n.
 *
 * Instead of hard-coding pay tables, they are DERIVED from a target RTP: a
 * risk-shaped curve is scaled so that Σ p(k)·m(k) = TARGET_RTP, then every
 * multiplier is rounded DOWN (so the real RTP never exceeds the target).
 */
import { generateFloats } from "./fair.js";

export const TARGET_RTP = 0.99;
export const MIN_ROWS = 8;
export const MAX_ROWS = 16;
export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

/**
 * Curve shape per risk: `centre` = payout in the middle bucket, `edge8`/`edge16` = edge payout
 * on 8 and 16 rows (interpolated geometrically in between). The curve exponent between them is
 * solved numerically so the table hits TARGET_RTP exactly before rounding.
 */
const SHAPE: Record<Risk, { centre: number; edge8: number; edge16: number }> = {
  low: { centre: 0.5, edge8: 5.6, edge16: 16 },
  medium: { centre: 0.4, edge8: 13, edge16: 110 },
  high: { centre: 0.2, edge8: 29, edge16: 1000 },
};

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function bucketProbabilities(rows: number): number[] {
  const total = 2 ** rows;
  return Array.from({ length: rows + 1 }, (_, k) => binomial(rows, k) / total);
}

function roundDown(m: number): number {
  if (m >= 100) return Math.floor(m);
  if (m >= 10) return Math.floor(m * 10) / 10;
  return Math.floor(m * 100) / 100;
}

const tableCache = new Map<string, number[]>();

export function multiplierTable(rows: number, risk: Risk): number[] {
  const key = `${rows}:${risk}`;
  const cached = tableCache.get(key);
  if (cached) return cached;

  const { centre, edge8, edge16 } = SHAPE[risk];
  const half = rows / 2;
  const probs = bucketProbabilities(rows);
  const edge = edge8 * (edge16 / edge8) ** ((rows - MIN_ROWS) / (MAX_ROWS - MIN_ROWS));
  const curve = (power: number) =>
    probs.map((_, k) => centre + (edge - centre) * (Math.abs(k - half) / half) ** power);
  const ev = (power: number) => curve(power).reduce((s, m, k) => s + m * probs[k], 0);

  // EV falls as the exponent grows (inner buckets drop towards `centre`), so bisect for the target.
  let lo = 0.1;
  let hi = 30;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ev(mid) > TARGET_RTP) lo = mid;
    else hi = mid;
  }
  const table = curve(hi).map(roundDown);

  tableCache.set(key, table);
  return table;
}

export function tableRtp(rows: number, risk: Risk): number {
  const probs = bucketProbabilities(rows);
  return multiplierTable(rows, risk).reduce((s, m, k) => s + m * probs[k], 0);
}

export interface PlinkoOutcome {
  /** 0 = left, 1 = right, one entry per row. */
  path: number[];
  bucket: number;
  multiplier: number;
}

export async function plinkoOutcome(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  rows: number,
  risk: Risk,
): Promise<PlinkoOutcome> {
  const floats = await generateFloats(serverSeed, clientSeed, nonce, rows);
  const path = floats.map((f) => (f < 0.5 ? 0 : 1));
  const bucket = path.reduce<number>((s, d) => s + d, 0);
  return { path, bucket, multiplier: multiplierTable(rows, risk)[bucket] };
}

export function isValidRows(rows: unknown): rows is number {
  return Number.isInteger(rows) && (rows as number) >= MIN_ROWS && (rows as number) <= MAX_ROWS;
}

export function isValidRisk(risk: unknown): risk is Risk {
  return RISKS.includes(risk as Risk);
}
