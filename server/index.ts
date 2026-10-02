/**
 * Local dev server for the game API (Vite proxies /api here). Production runs the same
 * logic as Vercel Functions (api/); both call server/game.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handle } from "./game.js";

try {
  process.loadEnvFile(".env"); // optional SESSION_SECRET (dev falls back to a per-process key)
} catch {
  /* no .env */
}

// Not PORT: tools that start `npm run dev` set PORT for Vite, which would take its port.
const PORT = Number(process.env.API_PORT ?? 8787);

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

function send(res: ServerResponse, status: number, data: unknown, setCookie?: string) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(setCookie && { "set-cookie": setCookie }) });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
  const body = await readJson(req);
  if (body === null) return send(res, 400, { error: "invalid_json" });
  const out = await handle(req.url ?? "", body, req.headers.cookie, false);
  send(res, out.status, out.data, out.setCookie);
}).listen(PORT, () => console.log(`game server on http://localhost:${PORT}`));
