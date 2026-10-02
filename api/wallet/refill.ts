// Vercel Function for POST /api/wallet/refill (the logic lives in server/game.ts).
import { serve } from "../../server/game.js";

export const POST = (request: Request) => serve(request, "/api/wallet/refill");
