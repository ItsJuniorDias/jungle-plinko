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

const SESSION_KEY = "jungle-games:session";

export class ApiError extends Error {}

async function post<T>(url: string, body: object): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `http_${res.status}`);
  return data as T;
}

function storedSessionId(): string | undefined {
  try {
    return localStorage.getItem(SESSION_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export const api = {
  sessionId: "",

  async session(): Promise<SessionState> {
    const state = await post<SessionState>("/api/session", { sessionId: storedSessionId() });
    this.sessionId = state.sessionId;
    try {
      localStorage.setItem(SESSION_KEY, state.sessionId);
    } catch {
      /* private mode: session lasts for this tab only */
    }
    return state;
  },

  bet(amount: number, rows: number, risk: Risk) {
    return post<PlinkoBetResult>("/api/plinko/bet", { sessionId: this.sessionId, amount, rows, risk });
  },

  rotateSeeds(clientSeed?: string) {
    return post<{ revealed: RevealedSeed; state: SessionState }>("/api/seeds/rotate", {
      sessionId: this.sessionId,
      clientSeed,
    });
  },

  refill() {
    return post<SessionState>("/api/wallet/refill", { sessionId: this.sessionId });
  },
};
