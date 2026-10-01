/**
 * Provably fair dialog: shows the committed server-seed hash, lets the player
 * set their client seed / rotate seeds, and re-computes any bet locally with
 * the exact same code the server uses (shared/plinko.ts).
 */
import { api, type PlinkoBetResult, type RevealedSeed, type SessionState } from "../api";
import { sha256Hex } from "../../shared/fair";
import { isValidRisk, plinkoOutcome } from "../../shared/plinko";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setupFairness() {
  const dialog = $<HTMLDialogElement>("fair-dialog");
  const hashEl = $<HTMLInputElement>("fair-hash");
  const clientEl = $<HTMLInputElement>("fair-client");
  const nonceEl = $<HTMLInputElement>("fair-nonce");
  const revealedEl = $("revealed");
  const resultEl = $("v-result");
  /** serverSeedHash → revealed seed, so old bets can be verified in one click. */
  const revealed = new Map<string, RevealedSeed>();

  function showTab(tab: "seeds" | "verify") {
    dialog.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    dialog.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
  }

  function setState(state: SessionState) {
    hashEl.value = state.serverSeedHash;
    clientEl.value = state.clientSeed;
    nonceEl.value = String(state.nonce);
  }

  dialog.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => showTab(b.dataset.tab as "seeds" | "verify")),
  );
  $("open-fair").addEventListener("click", () => {
    showTab("seeds");
    dialog.showModal();
  });

  $("rotate").addEventListener("click", async () => {
    const { revealed: old, state } = await api.rotateSeeds(clientEl.value);
    revealed.set(old.serverSeedHash, old);
    setState(state);
    revealedEl.hidden = false;
    revealedEl.textContent =
      `Revealed server seed (used for ${old.betsPlayed} ${old.betsPlayed === 1 ? "bet" : "bets"}):\n${old.serverSeed}\n\n` +
      `Server seed hash: ${old.serverSeedHash}\nClient seed: ${old.clientSeed}`;
  });

  $("verify").addEventListener("click", async () => {
    const serverSeed = $<HTMLInputElement>("v-server").value.trim();
    const clientSeed = $<HTMLInputElement>("v-client").value.trim();
    const nonce = Number($<HTMLInputElement>("v-nonce").value);
    const rows = Number($<HTMLInputElement>("v-rows").value);
    const risk = $<HTMLSelectElement>("v-risk").value;
    if (!serverSeed || !clientSeed || !isValidRisk(risk) || rows < 8 || rows > 16) {
      resultEl.textContent = "Fill in server seed, client seed, nonce, rows (8–16) and risk.";
      return;
    }
    const outcome = await plinkoOutcome(serverSeed, clientSeed, nonce, rows, risk);
    resultEl.textContent =
      `SHA-256(server seed) = ${await sha256Hex(serverSeed)}\n` +
      `Path: ${outcome.path.map((d) => (d ? "R" : "L")).join(" ")}\n` +
      `Bucket: ${outcome.bucket + 1} of ${rows + 1} (from the left)\nMultiplier: ${outcome.multiplier}×`;
  });

  return {
    setState,
    setNonce(nonce: number) {
      nonceEl.value = String(nonce);
    },
    /** Opens the verifier pre-filled with a past bet. */
    openVerify(bet: PlinkoBetResult) {
      const seed = revealed.get(bet.serverSeedHash);
      $<HTMLInputElement>("v-server").value = seed?.serverSeed ?? "";
      $<HTMLInputElement>("v-client").value = bet.clientSeed;
      $<HTMLInputElement>("v-nonce").value = String(bet.nonce);
      $<HTMLInputElement>("v-rows").value = String(bet.rows);
      $<HTMLSelectElement>("v-risk").value = bet.risk;
      resultEl.textContent = seed
        ? ""
        : `This bet used the server seed with hash\n${bet.serverSeedHash}\nwhich is still active. Rotate seeds on the Seeds tab to reveal it.`;
      showTab("verify");
      dialog.showModal();
    },
  };
}
