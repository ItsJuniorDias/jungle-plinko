<div align="center">

<img src="public/art/logo.webp" alt="Jungle Plinko" width="460" />

**A provably fair 3D Plinko game for the browser, built with Three.js and painted in the style of Blender Studio's _Spring_.**

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-r186-000000?logo=threedotjs&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

<img src="docs/gameplay.jpg" alt="Jungle Plinko gameplay" width="820" />

</div>

> [!NOTE]
> This is a prototype that uses **demo credits only**. No real money is involved.

## Features

- **Provably fair.** Every result comes from `HMAC-SHA256(serverSeed, clientSeed:nonce:round)`. Players can rotate seeds and re-verify any bet in the browser, using the same code the server runs.
- **Server-authoritative.** The server decides each outcome. The client only animates the path it receives.
- **Pay tables generated from a target RTP.** Multipliers are solved numerically for a 99% target RTP, then rounded down. The real RTP lands between 98.1% and 98.9%, depending on rows and risk. A Monte Carlo script checks it.
- **3 risk levels × 8–16 rows**, with payouts from 0.2× up to 1000×.
- **Painterly "Spring" look.** AI-painted sprites and backdrop, bloom, AgX tone mapping, a colour grade, vignette and film grain. Without art, the game falls back to soft toon shading with a rim light. Misty parallax layers, light shafts, drifting pollen and falling leaves.
- **Game feel.**
  - Pegs pop in row by row.
  - The ball squashes and stretches on every peg, throwing sparks and making the peg pulse.
  - A multiplier floats up from the bucket on every hit of 2× or more, and big hits (10× and up) open a Big / Mega / Epic win banner.
  - Stereo-panned synth sound effects.
- **AI art pipeline.** One command generates every image with Nano Banana via OpenRouter, keeps a consistent style and keys out the backgrounds. Most missing images fall back to a procedural placeholder.
- **Responsive and accessible.** Works on phones, has keyboard shortcuts and ARIA labels, and respects `prefers-reduced-motion`.

## Quick start

```bash
git clone git@github.com:ItsJuniorDias/jungle-plinko.git
cd jungle-plinko
npm install
npm run dev
```

Open **http://localhost:5173**. `npm run dev` starts both the game server (`:8787`) and the Vite dev server (`:5173`). Vite proxies `/api` to the game server.

| Shortcut | Action |
| --- | --- |
| <kbd>Space</kbd> | Drop a ball |
| <kbd>M</kbd> | Mute / unmute |
| <kbd>Esc</kbd> | Close the big-win banner |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Game server and Vite with hot reload |
| `npm run build` | Type-check and production build to `dist/` |
| `npm run typecheck` | TypeScript only |
| `npm run simulate -- 200000` | Monte Carlo RTP check: simulated vs theoretical for 8, 12 and 16 rows at every risk level (default 50,000 bets each) |
| `npm run art` | Generate any missing AI art (see [Art pipeline](#art-pipeline)) |

## How it works

### Provably fair

1. The server creates a random `serverSeed` and shows the player only `sha256(serverSeed)`.
2. Each bet derives floats from `HMAC_SHA256(key = serverSeed, msg = "clientSeed:nonce:round")`. Every 4 bytes become one float in `[0, 1)`.
3. Plinko reads one float per row: below `0.5` the ball goes left, otherwise right. The landing bucket is the number of rights.
4. **Rotate seeds** reveals the old `serverSeed`. Players can check that its hash matches the one shown earlier, then recompute any bet. Clicking a result in the history opens the verifier pre-filled with that bet.

The same `shared/` code runs on the server and in the browser through Web Crypto, so verification uses exactly the algorithm that produced the result.

### Pay tables

Bucket `k` on an `n`-row board has binomial probability `C(n,k) / 2ⁿ`. Instead of hand-written tables, each risk level fixes a **centre** payout and an **edge** payout for 8 and 16 rows, interpolated geometrically for the row counts in between. The exponent of the curve between them is then bisected until `Σ p(k)·m(k) = 0.99`, and every multiplier is rounded **down**. This guarantees the RTP never goes above the target.

| Rows | Risk | Min | Max | RTP |
| --- | --- | --- | --- | --- |
| 8 | low / medium / high | 0.5× / 0.4× / 0.2× | 5.6× / 13× / 29× | 98.80% / 98.53% / 98.50% |
| 12 | low / medium / high | 0.5× / 0.4× / 0.2× | 9.46× / 37.8× / 170× | 98.82% / 98.73% / 98.75% |
| 16 | low / medium / high | 0.5× / 0.4× / 0.2× | 16× / 110× / 1000× | 98.62% / 98.72% / 98.61% |

### Rendering

`src/engine/` is a small reusable layer that future games can share:

- **Stage** — renderer, camera framing, and the post-processing chain from [`postprocessing`](https://github.com/pmndrs/postprocessing): Bloom → AgX → hue/saturation → contrast → vignette → grain.
- **Environment** — painted backdrop, parallax layers, light shafts, pollen and leaves.
- **Materials** — `springMaterial()`, a toon ramp plus fresnel rim. `springify()` restyles any imported GLB.

The Plinko board draws all pegs in a single `InstancedMesh`. Ball motion is a choreographed path of parabolic arcs, so it plays the same at any frame rate.

## Project structure

```
shared/                 runs on the server and in the browser
  fair.ts               provably fair core (Web Crypto HMAC-SHA256 → floats)
  plinko.ts             board math, RTP-solved pay tables, outcome from seeds
server/index.ts         authoritative game server: session, demo wallet, bets, seed rotation
src/
  main.ts               app wiring: controls, balance, history, big-win banner
  api.ts                typed client for the game server
  engine/               reusable 3D layer
    stage.ts            renderer, camera framing, post-processing
    environment.ts      Spring-style backdrop, parallax, light shafts, particles
    materials.ts        toon + rim-light materials, springify() for GLBs
    particles.ts        pooled additive particle bursts (one draw call)
    painted.ts          procedural placeholder textures and canvas labels
    art.ts              loads public/art/manifest.json (all entries optional)
    sfx.ts              Web Audio synth sound kit
  games/plinko/         board, pegs, buckets, ball choreography, win popups
  ui/fairness.ts        provably fair dialog (seeds + verifier)
scripts/
  simulate.ts           Monte Carlo RTP check
  generate-art.ts       AI art generation + chroma keying
public/art/             game-ready art (WebP) + manifest.json
```

### Game server API

All endpoints are `POST` with a JSON body. State is kept in memory, since this is a demo.

| Endpoint | Body | Returns |
| --- | --- | --- |
| `/api/session` | `{ sessionId? }` | `sessionId`, `balance`, `serverSeedHash`, `clientSeed`, `nonce` |
| `/api/plinko/bet` | `{ sessionId, amount (cents), rows, risk }` | `path`, `bucket`, `multiplier`, `payout`, `balance`, `nonce` |
| `/api/seeds/rotate` | `{ sessionId, clientSeed? }` | the revealed previous seed + new public state |
| `/api/wallet/refill` | `{ sessionId }` | public state with the demo balance reset |

## Art pipeline

Every image is generated with **Nano Banana** (`google/gemini-2.5-flash-image`) through [OpenRouter](https://openrouter.ai).

```bash
cp .env.example .env                    # then set OPENROUTER_API_KEY
npm run art                             # generate images that don't exist yet
npm run art -- board leaf --force       # regenerate specific assets
```

- **Style consistency.** The `background` image is generated first and acts as the **style anchor**: it is sent as a reference for the scene assets (forest layer, cover). Isolated objects use the shared style prompt only, because a reference image makes the model paste the whole landscape behind them.
- **Transparency.** Sprites are painted on flat magenta and chroma-keyed with `sharp`. The script detects the shade the model actually used from the border pixels, and also keys gradients by hue. It then un-mixes edge pixels so no magenta fringe remains.
- **No accidental spend.** An image counts as missing only when neither its raw output (`art/raw/`, git-ignored) nor its game-ready file (`public/art/`) exists. A fresh clone therefore makes no API calls until you pass `--force`.
- **Free re-processing.** Raw outputs are saved to `art/raw/`. With raw files present, re-running without `--force` only re-keys and re-crops, with no API calls.
- **Graceful fallback.** The game uses every entry in `public/art/manifest.json`. A missing background, forest layer, board, ball, peg or bucket gets a procedural placeholder. A missing foliage layer or leaf sprite is skipped, and a missing logo falls back to the text title.

Set `IMAGE_MODEL` in `.env` to try another model, for example `google/gemini-3.1-flash-image` (Nano Banana 2).

## Roadmap

- [x] Plinko: provably fair, RTP-solved tables, Spring-style art and polish
- [ ] Chicken Road with an animated 3D character (GLB + `springify()`)
- [ ] Crash: real-time multiplayer over WebSocket
- [ ] Port the server to NestJS + PostgreSQL with an operator wallet API (debit / credit / rollback, idempotent)
- [ ] Recorded, licensed sound design

## License

[MIT](LICENSE) © 2026 Alexandre Junior
