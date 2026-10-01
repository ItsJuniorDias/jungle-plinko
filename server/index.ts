/**
 * Demo game server. Authoritative for every outcome: the client only animates
 * what this server decides. Sessions/wallets live in memory — swap for
 * PostgreSQL + a real wallet API (debit/credit/rollback) when porting to NestJS.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomSeed, sha256Hex } from "../shared/fair";
import { isValidRisk, isValidRows, plinkoOutcome } from "../shared/plinko";

const PORT = Number(process.env.PORT ?? 8787);
const START_BALANCE = 1_000_00; // cents
const MIN_BET = 10; // cents
const MAX_BET = 100_00;

interface Session {
  id: string;
  balance: number; // cents
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

const sessions = new Map<string, Session>();

async function newSeedPair() {
  const serverSeed = randomSeed();
  return { serverSeed, serverSeedHash: await sha256Hex(serverSeed) };
}

async function createSession(): Promise<Session> {
  const session: Session = {
    id: randomSeed(16),
    balance: START_BALANCE,
    ...(await newSeedPair()),
    clientSeed: randomSeed(8),
    nonce: 0,
  };
  sessions.set(session.id, session);
  return session;
}

/** Never leaks the active serverSeed. */
function publicState(s: Session) {
  return {
    sessionId: s.id,
    balance: s.balance,
    serverSeedHash: s.serverSeedHash,
    clientSeed: s.clientSeed,
    nonce: s.nonce,
  };
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function getSession(id: unknown): Session {
  const session = typeof id === "string" ? sessions.get(id) : undefined;
  if (!session) throw new HttpError(404, "session_not_found");
  return session;
}

const routes: Record<string, (body: any) => Promise<unknown>> = {
  async "/api/session"(body) {
    const existing = typeof body.sessionId === "string" ? sessions.get(body.sessionId) : undefined;
    return publicState(existing ?? (await createSession()));
  },

  async "/api/plinko/bet"(body) {
    const session = getSession(body.sessionId);
    const { amount, rows, risk } = body;
    if (!Number.isInteger(amount) || amount < MIN_BET || amount > MAX_BET) throw new HttpError(400, "invalid_amount");
    if (!isValidRows(rows)) throw new HttpError(400, "invalid_rows");
    if (!isValidRisk(risk)) throw new HttpError(400, "invalid_risk");
    if (amount > session.balance) throw new HttpError(400, "insufficient_balance");

    // Reserve the nonce and debit synchronously (before the await), so concurrent
    // bets never reuse a nonce or overdraw the wallet.
    const nonce = session.nonce++;
    session.balance -= amount;
    const outcome = await plinkoOutcome(session.serverSeed, session.clientSeed, nonce, rows, risk);
    const payout = Math.floor((amount * Math.round(outcome.multiplier * 100)) / 100);
    session.balance += payout;

    return {
      ...outcome,
      amount,
      payout,
      rows,
      risk,
      nonce,
      clientSeed: session.clientSeed,
      serverSeedHash: session.serverSeedHash,
      balance: session.balance,
    };
  },

  async "/api/seeds/rotate"(body) {
    const session = getSession(body.sessionId);
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
    return { revealed, state: publicState(session) };
  },

  async "/api/wallet/refill"(body) {
    const session = getSession(body.sessionId);
    session.balance = START_BALANCE;
    return publicState(session);
  },
};

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) reject(new HttpError(413, "payload_too_large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, "invalid_json"));
      }
    });
  });
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  const handler = req.method === "POST" ? routes[req.url ?? ""] : undefined;
  if (!handler) return send(res, 404, { error: "not_found" });
  try {
    send(res, 200, await handler(await readJson(req)));
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: "internal_error" });
  }
}).listen(PORT, () => console.log(`game server on http://localhost:${PORT}`));
