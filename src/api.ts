import type { Risk } from "../shared/plinko";

export interface SessionState {
  sessionId: string;
  balance: number; // cents
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface PlinkoBetResult {
  path: number[];
  bucket: number;
  multiplier: number;
  amount: number;
  payout: number;
  rows: number;
  risk: Risk;
  nonce: number;
  clientSeed: string;
  serverSeedHash: string;
  balance: number;
}

export interface RevealedSeed {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  betsPlayed: number;
}

export class ApiError extends Error {}

/**
 * The session lives in an encrypted HttpOnly cookie that every response renews, so calls go
 * out one at a time: two overlapping bets would both start from the same nonce and balance.
 */
let queue: Promise<unknown> = Promise.resolve();

function post<T>(url: string, body: object): Promise<T> {
  const call = queue.then(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error ?? `http_${res.status}`);
    return data as T;
  });
  queue = call.catch(() => undefined);
  return call;
}

export const api = {
  session: () => post<SessionState>("/api/session", {}),
  bet: (amount: number, rows: number, risk: Risk) => post<PlinkoBetResult>("/api/plinko/bet", { amount, rows, risk }),
  rotateSeeds: (clientSeed?: string) => post<{ revealed: RevealedSeed; state: SessionState }>("/api/seeds/rotate", { clientSeed }),
  refill: () => post<SessionState>("/api/wallet/refill", {}),
};
