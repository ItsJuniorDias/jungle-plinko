/**
 * Monte Carlo check: plays N bets through the real provably fair pipeline and
 * compares the empirical RTP with the theoretical one for every rows/risk.
 *   npm run simulate -- 200000
 */
import { randomSeed } from "../shared/fair";
import { MAX_ROWS, MIN_ROWS, RISKS, plinkoOutcome, tableRtp } from "../shared/plinko";

const N = Number(process.argv[2] ?? 50_000);
const serverSeed = randomSeed();
const clientSeed = randomSeed(8);

for (let rows = MIN_ROWS; rows <= MAX_ROWS; rows += 4) {
  for (const risk of RISKS) {
    let paid = 0;
    for (let nonce = 0; nonce < N; nonce++) {
      paid += (await plinkoOutcome(serverSeed, clientSeed, nonce, rows, risk)).multiplier;
    }
    const empirical = (paid / N) * 100;
    console.log(
      `${String(rows).padStart(2)} linhas ${risk.padEnd(6)}  teórico ${(tableRtp(rows, risk) * 100).toFixed(2)}%  simulado ${empirical.toFixed(2)}%`,
    );
  }
}
