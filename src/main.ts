import "./style.css";
import gsap from "gsap";
import { Stage } from "./engine/stage";
import { createSpringEnvironment } from "./engine/environment";
import { loadArt } from "./engine/art";
import { sfx } from "./engine/sfx";
import { PlinkoBoard, bucketColor, formatMultiplier } from "./games/plinko/PlinkoBoard";
import { setupFairness } from "./ui/fairness";
import { api, ApiError, type PlinkoBetResult } from "./api";
import { tableRtp, type Risk } from "../shared/plinko";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MIN_BET = 0.1;
const MAX_BET = 100;
/** Multipliers at or above this open the big-win banner. */
const BIG_WIN = 10;
const OFFLINE = "Can't reach the server";

function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return OFFLINE;
  // The Vite proxy answers 5xx when the game server is down.
  if (err.message.startsWith("http_5")) return OFFLINE;
  return ERRORS[err.message] ?? "Something went wrong — please try again";
}
const ERRORS: Record<string, string> = {
  insufficient_balance: "Insufficient balance",
  invalid_amount: `Bet must be between ${money.format(MIN_BET)} and ${money.format(MAX_BET)}`,
  invalid_rows: "Rows must be between 8 and 16",
  invalid_risk: "Pick a risk level",
  session_not_found: "Session expired — please reload the page",
};

async function boot() {
  // Labels on the buckets are drawn to canvases, so the font must be ready first.
  await document.fonts.load('800 40px "Nunito"').catch(() => undefined);

  const art = await loadArt();
  const logo = art.url("logo");
  if (logo) {
    const title = document.querySelector(".brand h1")!;
    title.innerHTML = `<img class="logo" src="${logo}" alt="Jungle Plinko" />`;
  }

  const stage = new Stage($("viewport"));
  createSpringEnvironment(stage, art);
  const board = new PlinkoBoard(stage, art);

  let rows = Number($<HTMLInputElement>("rows").value);
  let risk: Risk = "medium";
  let displayBalance = 0;
  let autoTimer: number | undefined;

  const balanceEl = $("balance");
  const amountEl = $<HTMLInputElement>("amount");
  const rowsEl = $<HTMLInputElement>("rows");
  const historyEl = $("history");
  const toastEl = $("toast");
  const autoBtn = $<HTMLButtonElement>("auto");

  // The shown balance counts towards `displayBalance` instead of jumping.
  const shownBalance = { v: 0 };
  function renderBalance(animate = true) {
    const delta = displayBalance - shownBalance.v;
    if (delta > 0 && animate) {
      balanceEl.classList.remove("up");
      void balanceEl.offsetWidth; // restart the CSS animation
      balanceEl.classList.add("up");
    }
    gsap.to(shownBalance, {
      v: displayBalance,
      duration: animate ? 0.45 : 0,
      ease: "power2.out",
      overwrite: true,
      onUpdate: () => (balanceEl.textContent = money.format(shownBalance.v / 100)),
    });
    updateDropState();
  }
  function updateDropState() {
    const tooMuch = amountCents() > displayBalance;
    $("drop").classList.toggle("insufficient", tooMuch);
    $("drop").title = tooMuch ? "Insufficient balance" : "Drop (Space)";
  }
  const renderRtp = () => ($("rtp").textContent = `RTP ${(tableRtp(rows, risk) * 100).toFixed(2)}%`);
  const updateRowsLock = () => (rowsEl.disabled = board.activeBalls > 0);

  let toastTimer: number | undefined;
  function toast(message: string) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  const fairness = setupFairness();

  function pushHistory(bet: PlinkoBetResult) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = formatMultiplier(bet.multiplier);
    chip.style.background = `#${bucketColor(bet.bucket, bet.rows).getHexString()}`;
    chip.title = `Nonce ${bet.nonce} — click to verify`;
    chip.addEventListener("click", () => fairness.openVerify(bet));
    historyEl.prepend(chip);
    while (historyEl.children.length > 6) historyEl.lastElementChild!.remove();
  }

  /** Text input (not type=number) so it always shows "1.00", whatever the browser locale. */
  function amountCents(): number {
    return Math.round(Number(amountEl.value.trim()) * 100);
  }

  function normalizeAmount() {
    const v = amountEl.value.trim() === "" ? NaN : Number(amountEl.value.trim());
    amountEl.value = (Number.isFinite(v) ? Math.min(MAX_BET, Math.max(MIN_BET, v)) : 1).toFixed(2);
    updateDropState();
  }

  // --- Big win banner ---------------------------------------------------------
  const bigWinEl = $("big-win");
  let bigWinTimer: number | undefined;
  function hideBigWin() {
    clearTimeout(bigWinTimer);
    bigWinEl.classList.remove("show");
  }
  bigWinEl.addEventListener("click", hideBigWin);
  function showBigWin(bet: PlinkoBetResult) {
    if (bigWinEl.classList.contains("show")) return; // don't stack banners during Auto
    $("big-win-title").textContent = bet.multiplier >= 100 ? "Epic win!" : bet.multiplier >= 30 ? "Mega win!" : "Big win!";
    $("big-win-mult").textContent = formatMultiplier(bet.multiplier);
    const counter = { v: 0 };
    const amountEl2 = $("big-win-amount");
    gsap.to(counter, {
      v: bet.payout,
      duration: 1.4,
      ease: "power3.out",
      onUpdate: () => (amountEl2.textContent = money.format(counter.v / 100)),
    });
    bigWinEl.classList.add("show");
    sfx.bigWin();
    clearTimeout(bigWinTimer);
    bigWinTimer = window.setTimeout(hideBigWin, 2800);
  }

  async function dropOne(): Promise<boolean> {
    const amount = amountCents();
    try {
      const bet = await api.bet(amount, rows, risk);
      displayBalance -= bet.amount;
      renderBalance();
      fairness.setNonce(bet.nonce + 1);
      const landing = board.drop(bet.path, bet.multiplier);
      updateRowsLock();
      void landing.then(() => {
        displayBalance += bet.payout;
        renderBalance();
        pushHistory(bet);
        updateRowsLock();
        if (bet.multiplier >= BIG_WIN) showBigWin(bet);
      });
      return true;
    } catch (err) {
      toast(errorMessage(err));
      return false;
    }
  }

  function stopAuto() {
    clearInterval(autoTimer);
    autoTimer = undefined;
    autoBtn.setAttribute("aria-pressed", "false");
    autoBtn.textContent = "Auto";
  }

  if (import.meta.env.DEV) Object.assign(window, { __game: { stage, board, showBigWin } });

  // --- Controls -------------------------------------------------------------
  $("drop").addEventListener("click", () => void dropOne());
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || $<HTMLDialogElement>("fair-dialog").open) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!e.repeat) void dropOne();
    } else if (e.code === "KeyM") {
      toggleMute();
    } else if (e.code === "Escape") {
      hideBigWin();
    }
  });

  autoBtn.addEventListener("click", () => {
    if (autoTimer) return stopAuto();
    autoBtn.setAttribute("aria-pressed", "true");
    autoBtn.textContent = "Stop";
    autoTimer = window.setInterval(async () => {
      if (!(await dropOne())) stopAuto();
    }, 380);
  });

  document.querySelectorAll<HTMLButtonElement>("[data-amount]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const factor = btn.dataset.amount === "half" ? 0.5 : 2;
      amountEl.value = String((amountCents() / 100) * factor);
      normalizeAmount();
    }),
  );
  amountEl.addEventListener("change", normalizeAmount);
  amountEl.addEventListener("input", updateDropState);
  // Auto-play stops when the tab is hidden, so it never keeps betting unseen.
  document.addEventListener("visibilitychange", () => document.hidden && autoTimer && stopAuto());

  document.querySelectorAll<HTMLButtonElement>("[data-risk]").forEach((btn) =>
    btn.addEventListener("click", () => {
      risk = btn.dataset.risk as Risk;
      document.querySelectorAll("[data-risk]").forEach((b) => b.setAttribute("aria-checked", String(b === btn)));
      board.setRisk(risk);
      renderRtp();
    }),
  );

  rowsEl.addEventListener("input", () => {
    rows = Number(rowsEl.value);
    $("rows-value").textContent = String(rows);
    board.build(rows, risk);
    renderRtp();
  });

  $("refill").addEventListener("click", async () => {
    if (board.activeBalls > 0) return toast("Wait for the balls to land");
    const state = await api.refill();
    displayBalance = state.balance;
    renderBalance();
  });

  const muteBtn = $("mute");
  const renderMute = () => {
    muteBtn.textContent = sfx.muted ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-pressed", String(sfx.muted));
    muteBtn.title = sfx.muted ? "Unmute (M)" : "Mute (M)";
  };
  function toggleMute() {
    sfx.setMuted(!sfx.muted);
    renderMute();
  }
  muteBtn.addEventListener("click", toggleMute);
  renderMute();

  // --- Start ----------------------------------------------------------------
  board.build(rows, risk);
  renderRtp();
  try {
    const state = await api.session();
    displayBalance = state.balance;
    renderBalance(false);
    fairness.setState(state);
  } catch {
    toast(OFFLINE);
  }
}

void boot().finally(() => document.getElementById("splash")?.classList.add("done"));
