// Vercel Function for POST /api/plinko/bet (the logic lives in server/game.ts).
import { serve } from "../../server/game.js";

export const POST = (request: Request) => serve(request, "/api/plinko/bet");
