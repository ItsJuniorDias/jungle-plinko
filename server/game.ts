/**
 * Demo game server logic, shared by the local dev server (server/index.ts) and the Vercel
 * Functions (api/). Authoritative for every outcome: the client only animates what this
 * decides.
 *
 * Stateless: the whole session (balance, seeds, nonce) travels in an encrypted, HttpOnly
 * cookie (AES-256-GCM), so it runs on serverless functions with no database. The player can
 * neither read the active server seed nor edit the balance. The trade-off is that an old
 * cookie can be replayed to roll a session back. That is acceptable for demo credits; a
 * real-money port needs a server-side store (PostgreSQL + an operator wallet API).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { randomSeed, sha256Hex } from "../shared/fair.js";
import { isValidRisk, isValidRows, plinkoOutcome } from "../shared/plinko.js";

const START_BALANCE = 1_000_00; // cents
const MIN_BET = 10; // cents
const MAX_BET = 100_00;
const COOKIE = "jp_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

interface Session {
  v: 1;
  id: string;
  balance: number; // cents
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- Sealed session cookie ---------------------------------------------------

let key: Buffer | undefined;

/** AES key from SESSION_SECRET. Production refuses to run without one. */
function sessionKey(): Buffer {
  if (key) return key;
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      console.error("SESSION_SECRET is not set: refusing to issue sessions");
      throw new HttpError(500, "server_misconfigured");
    }
    // Local dev: a fresh key per process (sessions reset on restart, as before).
    key = randomBytes(32);
    return key;
  }
  key = createHash("sha256").update(secret).digest();
  return key;
}

function seal(session: Session): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function unseal(token: string | undefined): Session | undefined {
  if (!token) return undefined;
  try {
    const raw = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", sessionKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const session = JSON.parse(json) as Session;
    return session.v === 1 ? session : undefined;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return undefined; // tampered, expired key or garbage
  }
}

function readCookie(header: string | null | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return value.join("=");
  }
  return undefined;
}

function sessionCookie(session: Session, secure: boolean): string {
  return `${COOKIE}=${seal(session)}; Path=/api; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

// --- Game ----------------------------------------------------------------------

async function newSeedPair() {
  const serverSeed = randomSeed();
  return { serverSeed, serverSeedHash: await sha256Hex(serverSeed) };
}

async function createSession(): Promise<Session> {
  return { v: 1, id: randomSeed(16), balance: START_BALANCE, ...(await newSeedPair()), clientSeed: randomSeed(8), nonce: 0 };
}

/** Never leaks the active serverSeed. */
function publicState(s: Session) {
  return { sessionId: s.id, balance: s.balance, serverSeedHash: s.serverSeedHash, clientSeed: s.clientSeed, nonce: s.nonce };
}

function requireSession(session: Session | undefined): Session {
  if (!session) throw new HttpError(401, "session_not_found");
  return session;
}

/** Each route returns its response body and the session to store (if it changed). */
type Route = (body: any, session: Session | undefined) => Promise<{ data: unknown; session?: Session }>;

const routes: Record<string, Route> = {
  async "/api/session"(_body, existing) {
    const session = existing ?? (await createSession());
    return { data: publicState(session), session };
  },

  async "/api/plinko/bet"(body, current) {
    const session = requireSession(current);
    const { amount, rows, risk } = body;
    if (!Number.isInteger(amount) || amount < MIN_BET || amount > MAX_BET) throw new HttpError(400, "invalid_amount");
    if (!isValidRows(rows)) throw new HttpError(400, "invalid_rows");
    if (!isValidRisk(risk)) throw new HttpError(400, "invalid_risk");
    if (amount > session.balance) throw new HttpError(400, "insufficient_balance");

    const nonce = session.nonce++;
    const outcome = await plinkoOutcome(session.serverSeed, session.clientSeed, nonce, rows, risk);
    const payout = Math.floor((amount * Math.round(outcome.multiplier * 100)) / 100);
    session.balance += payout - amount;
    return {
      data: {
        ...outcome,
        amount,
        payout,
        rows,
        risk,
        nonce,
        clientSeed: session.clientSeed,
        serverSeedHash: session.serverSeedHash,
        balance: session.balance,
      },
      session,
    };
  },

  async "/api/seeds/rotate"(body, current) {
    const session = requireSession(current);
    const revealed = {
      serverSeed: session.serverSeed,
      serverSeedHash: session.serverSeedHash,
      clientSeed: session.clientSeed,
      betsPlayed: session.nonce,
    };
    Object.assign(session, await newSeedPair(), { nonce: 0 });
    if (typeof body.clientSeed === "string" && body.clientSeed.trim()) {
      session.clientSeed = body.clientSeed.trim().slice(0, 64);
    }
    return { data: { revealed, state: publicState(session) }, session };
  },

  async "/api/wallet/refill"(_body, current) {
    const session = requireSession(current);
    session.balance = START_BALANCE;
    return { data: publicState(session), session };
  },
};

export interface GameResponse {
  status: number;
  data: unknown;
  setCookie?: string;
}

/** Runs one API call. `secure` marks the cookie Secure (HTTPS deployments). */
export async function handle(route: string, body: unknown, cookieHeader: string | null | undefined, secure: boolean): Promise<GameResponse> {
  const handler = routes[route];
  if (!handler) return { status: 404, data: { error: "not_found" } };
  try {
    const params = body && typeof body === "object" ? body : {};
    const result = await handler(params, unseal(readCookie(cookieHeader)));
    return { status: 200, data: result.data, setCookie: result.session && sessionCookie(result.session, secure) };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, data: { error: err.message } };
    console.error(err);
    return { status: 500, data: { error: "internal_error" } };
  }
}

/** Web-standard adapter (Vercel Functions): `export const POST = (req: Request) => serve(req, route)`. */
export async function serve(request: Request, route: string): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (body === null) return Response.json({ error: "invalid_json" }, { status: 400 });
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const res = await handle(route, body, request.headers.get("cookie"), secure);
  const headers = new Headers({ "cache-control": "no-store" });
  if (res.setCookie) headers.set("set-cookie", res.setCookie);
  return Response.json(res.data, { status: res.status, headers });
}
