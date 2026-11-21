import { explorerTx, type ChainConfig, type DeskMode } from "./chains";
import { DEFAULT_INTERVAL_SEC, freshAuto, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC, type AutoState } from "./autopilot";
import { narrate, type Narration } from "./llm";
import type { Market } from "./market";
import { applySwap, tightenPolicy, type Book, type Policy } from "./paper";
import { parseIntent, type Intent } from "./parse";
import { decide, thresholdsFor, type Decision, type StrategyInput } from "./strategy";
import { formatRaw, parseDecimal, spotOut, slippageFloor } from "./units";
import type { ExecResult, VaultSnapshot } from "./vault";

export type Proposal = {
  id: string;
  side: "buy" | "sell";
  stop: boolean;
  amountIn: bigint;
  sqrtPriceX96: bigint;
  zeroForOne: boolean;
  fee: number;
  slippageBps: number;
  price: number;
  reason: string;
  source: "pool" | "example";
  expiresAt: number;
};

export type Fill = {
  id: string;
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  reason: string;
  txHash: string | null;
  at: number;
  source: string;
};

export type ChatMessage = { id: string; role: "user" | "agent"; text: string; at: number };

export type Desk = {
  mode: DeskMode;
  book: Book;
  policy: Policy;
  messages: ChatMessage[];
  proposal: Proposal | null;
  fills: Fill[];
  nextId: number;
  chain: ChainConfig;
  auto: AutoState;
  /** Last on-chain read of the vault. Null in paper mode. */
  vault: VaultSnapshot | null;
};

export type ChainActions = {
  execute?: (proposal: Proposal) => Promise<ExecResult>;
  tighten?: (policy: Policy) => Promise<{ txHash: string } | { error: string }>;
  setPaused?: (paused: boolean) => Promise<{ txHash: string } | { error: string }>;
  vault?: () => Promise<VaultSnapshot>;
};

export type MarketReader = (() => Promise<Market>) | null;

const MAX_MESSAGES = 300;

const HELP = [
  "Keel trades the WHSK/USDT 0.30% pool on HSKSwap through a vault that enforces the limits.",
  "auto on            the agent decides and trades by itself, every 90s",
  "auto on 30         same, every 30s",
  "auto off           stop the loop",
  "auto demo          10 bps band instead of 60, for a quiet pool",
  "pause / resume     owner kill switch. Pause also turns auto off",
  "max trade 1        tighten a limit. Loosening is refused",
  "daily loss 3 · slippage 0.5% · cooldown 120",
  "check the pool     one decision, proposed for approve",
  "buy 2 · sell 0.5   manual order, proposed for approve",
  "approve · reject · status · worked example · reset",
].join("\n");

export function freshDesk(chain: ChainConfig, now: number, mode: DeskMode = "paper"): Desk {
  const sixDecimalQuote = chain.name === "mainnet";
  const quote = sixDecimalQuote ? 100_000_000n : 1_000_000_000_000_000_000n;
  const intro =
    mode === "mainnet"
      ? "Mainnet mode. Swaps go through the vault, inside its caps. Type auto on to let the agent trade by itself, or check the pool to decide one trade at a time. Do not point this at a public host."
      : mode === "testnet"
        ? "Testnet mode. Swaps go through the testnet vault when VAULT_ADDRESS and AGENT_PRIVATE_KEY are set."
        : "Paper book is open with 100 USDT. Prices are live from mainnet. Nothing is sent to a chain. Type auto on to watch the agent trade the paper book by itself.";
  return {
    mode,
    chain,
    nextId: 1,
    proposal: null,
    fills: [],
    auto: freshAuto(),
    vault: null,
    messages: [{ id: "m0", role: "agent", at: now, text: intro }],
    policy: sixDecimalQuote
      ? {
          maxQuoteIn: 2_000_000n,
          maxBaseIn: 5n * 10n ** 18n,
          slippageBps: 100,
          dailyLoss: 5_000_000n,
          cooldownSec: 60,
          maxBase: 50n * 10n ** 18n,
          paused: false,
        }
      : {
          maxQuoteIn: 50_000_000_000_000_000n,
          maxBaseIn: 2_000_000_000_000_000n,
          slippageBps: 100,
          dailyLoss: 200_000_000_000_000_000n,
          cooldownSec: 30,
          maxBase: 20_000_000_000_000_000n,
          paused: false,
        },
    book: {
      quote,
      base: 0n,
      cost: 0n,
      realized: 0n,
      dayId: Math.floor(now / 86_400),
      dayLoss: 0n,
      lastSwapAt: 0,
      entryPrice: null,
      entryAt: null,
      prices: [],
    },
  };
}

export function nextId(desk: Desk): string {
  const value = `k${desk.nextId}`;
  desk.nextId += 1;
  return value;
}

export function say(desk: Desk, text: string, now: number): void {
  desk.messages.push({ id: nextId(desk), role: "agent", text, at: now });
  if (desk.messages.length > MAX_MESSAGES) desk.messages = desk.messages.slice(-MAX_MESSAGES);
}

function zeroForOne(side: "buy" | "sell", token0IsBase: boolean): boolean {
  return side === "sell" ? token0IsBase : !token0IsBase;
}

export function money(desk: Desk, amount: bigint, side: "quote" | "base"): string {
  const decimals = side === "quote" ? desk.chain.quoteDecimals : desk.chain.baseDecimals;
  const symbol = side === "quote" ? desk.chain.quoteSymbol : desk.chain.baseSymbol;
  return `${formatRaw(amount, decimals)} ${symbol}`;
}

/** Copy the vault read into the book and the limits, so the desk never trades on a stale mirror. */
export function syncFromVault(desk: Desk, snap: VaultSnapshot): void {
  desk.vault = snap;
  desk.policy = { ...snap.policy, paused: snap.paused };
  const base = Number(formatRaw(snap.trackedBase, desk.chain.baseDecimals, 8));
  const cost = Number(formatRaw(snap.trackedCost, desk.chain.quoteDecimals, 8));
  desk.book = {
    ...desk.book,
    quote: snap.quoteBalance,
    base: snap.baseBalance,
    cost: snap.trackedCost,
    dayLoss: snap.dayLoss,
    entryPrice: base > 0 && cost > 0 ? cost / base : null,
  };
}

export function holdingsText(desk: Desk): string {
  const where = desk.vault ? "Vault" : "Book";
  const gas = desk.vault ? ` Agent gas ${formatRaw(desk.vault.agentGas, 18)} HSK.` : "";
  return `${where}: ${money(desk, desk.book.base, "base")} and ${money(desk, desk.book.quote, "quote")}. Day loss ${money(desk, desk.book.dayLoss, "quote")} of ${money(desk, desk.policy.dailyLoss, "quote")}.${gas}`;
}

export function autoText(desk: Desk, now: number): string {
  const a = desk.auto;
  const band = thresholdsFor(a.profile).bandBps;
  if (a.enabled) {
    const wait = Math.max(0, a.nextTickAt - now);
    return `Auto is on, every ${a.intervalSec}s, ${a.profile} profile (${band} bps band). Next decision in ${wait}s. ${a.ticks} decisions, ${a.trades} trades.`;
  }
  if (a.stoppedReason) return `Auto stopped: ${a.stoppedReason}`;
  return "Auto is off. Trades wait for approve.";
}

function statusText(desk: Desk, now: number): string {
  const { book, policy, chain } = desk;
  const price = book.prices[book.prices.length - 1];
  return [
    `${chain.label}, chain ${chain.id}. ${policy.paused ? "Paused." : "Trading is allowed."}`,
    autoText(desk, now),
    holdingsText(desk),
    `Limits: ${money(desk, policy.maxBaseIn, "base")} or ${money(desk, policy.maxQuoteIn, "quote")} per trade, ${(policy.slippageBps / 100).toFixed(2)}% slippage, ${policy.cooldownSec}s cooldown.`,
    `Realized ${money(desk, book.realized, "quote")}.`,
    price ? `Last pool read ${price.toFixed(5)} ${chain.quoteSymbol} per ${chain.baseSymbol}.` : "No pool read yet.",
    desk.proposal ? `A ${desk.proposal.side} is waiting for approve or reject.` : "No proposal waiting.",
  ].join("\n");
}

/** Inputs to the rule, from the vault when there is one and from the paper book otherwise. */
export function strategyInput(desk: Desk, market: Market, history: number[]): StrategyInput {
  const v = desk.vault;
  const today = Math.floor(market.blockTime / 86_400);
  return {
    price: market.price,
    history,
    oraclePrice: market.oraclePrice,
    oracleAgeSec: market.oracleAgeSec,
    baseBalance: v ? v.baseBalance : desk.book.base,
    quoteBalance: v ? v.quoteBalance : desk.book.quote,
    trackedBase: v ? v.trackedBase : desk.book.base,
    trackedCost: v ? v.trackedCost : desk.book.cost,
    dayLoss: v ? v.dayLoss : desk.book.dayId === today ? desk.book.dayLoss : 0n,
    policy: desk.policy,
    baseDecimals: desk.chain.baseDecimals,
    quoteDecimals: desk.chain.quoteDecimals,
    thresholds: thresholdsFor(desk.auto.profile),
  };
}

/** Records a pool read and returns the earlier reads, oldest first. */
export function recordPrice(desk: Desk, price: number): number[] {
  const history = desk.book.prices.slice();
  desk.book.prices = [...history, price].slice(-24);
  return history;
}

export function buildProposal(desk: Desk, side: "buy" | "sell", stop: boolean, amountIn: bigint, market: { price: number; sqrtPriceX96: bigint }, source: Proposal["source"], reason: string, now: number): Proposal | null {
  const direction = zeroForOne(side, desk.chain.token0IsBase);
  const spot = spotOut(amountIn, direction, market.sqrtPriceX96, desk.chain.fee);
  if (slippageFloor(spot, desk.policy.slippageBps) === 0n) return null;
  return {
    id: nextId(desk),
    side,
    stop,
    amountIn,
    sqrtPriceX96: market.sqrtPriceX96,
    zeroForOne: direction,
    fee: desk.chain.fee,
    slippageBps: desk.policy.slippageBps,
    price: market.price,
    reason,
    source,
    expiresAt: now + 120,
  };
}

export function quoteText(desk: Desk, proposal: Proposal): string {
  const spot = spotOut(proposal.amountIn, proposal.zeroForOne, proposal.sqrtPriceX96, proposal.fee);
  const floor = slippageFloor(spot, proposal.slippageBps);
  const outSide = proposal.side === "buy" ? "base" : "quote";
  return `Spot after the 0.30% fee is about ${money(desk, spot, outSide)}. The vault rejects a minimum under ${money(desk, floor, outSide)}.`;
}

async function openProposal(desk: Desk, decision: Decision, market: { price: number; sqrtPriceX96: bigint }, source: Proposal["source"], now: number): Promise<void> {
  if (decision.action === "hold") {
    say(desk, decision.reason, now);
    return;
  }
  const narration: Narration = decision.stop ? { act: "take", note: decision.reason } : await narrate(decision);
  if (!decision.stop && narration.act === "skip") {
    desk.proposal = null;
    say(desk, `${narration.note} Skipped. No proposal.`, now);
    return;
  }
  const sized = !decision.stop && narration.act === "shrink" ? decision.amountIn / 2n : decision.amountIn;
  const proposal = sized > 0n ? buildProposal(desk, decision.action, decision.stop, sized, market, source, narration.note, now) : null;
  if (!proposal) {
    say(desk, "The spot quote rounds to zero at this size, so I did not propose it.", now);
    return;
  }
  desk.proposal = proposal;
  say(
    desk,
    [
      narration.note,
      `Proposal ${proposal.id}: ${decision.action} ${money(desk, sized, decision.action === "buy" ? "quote" : "base")}.`,
      quoteText(desk, proposal),
      source === "example" ? "This print is synthetic. It is not the live pool." : `Pool read at ${market.price.toFixed(5)}.`,
      "Reply approve or reject. It expires in 2 minutes.",
    ].join("\n"),
    now,
  );
}

export async function handleMessage(desk: Desk, text: string, now: number, market: MarketReader, chain: ChainActions): Promise<Desk> {
  const intent = parseIntent(text);
  desk.messages.push({ id: nextId(desk), role: "user", text: text.trim(), at: now });
  await applyIntent(desk, intent, now, market, chain);
  return desk;
}

async function readLive(desk: Desk, chain: ChainActions, now: number): Promise<boolean> {
  if (!chain.vault) return true;
  try {
    syncFromVault(desk, await chain.vault());
    return true;
  } catch (error) {
    say(desk, `Vault read failed: ${error instanceof Error ? error.message : "unknown error"}`, now);
    return false;
  }
}

async function applyIntent(desk: Desk, intent: Intent, now: number, market: MarketReader, chain: ChainActions): Promise<void> {
  if (intent.type === "help" || intent.type === "unknown") {
    say(desk, intent.type === "unknown" ? `I only act on the desk commands.\n${HELP}` : HELP, now);
    return;
  }
  if (intent.type === "status" || intent.type === "positions" || intent.type === "risk") {
    await readLive(desk, chain, now);
    say(desk, statusText(desk, now), now);
    return;
  }
  if (intent.type === "auto") {
    await setAuto(desk, intent, now, chain);
    return;
  }
  if (intent.type === "reset") {
    const fresh = freshDesk(desk.chain, now, desk.mode);
    desk.book = fresh.book;
    desk.proposal = null;
    desk.fills = [];
    if (desk.vault) syncFromVault(desk, desk.vault);
    say(desk, "Book reset. Limits were left as they are.", now);
    return;
  }
  if (intent.type === "pause" || intent.type === "resume") {
    const paused = intent.type === "pause";
    const wasAuto = desk.auto.enabled;
    if (paused) desk.auto = { ...desk.auto, enabled: false, stoppedReason: "Paused by you." };
    const autoNote = paused && wasAuto ? " Auto is off." : !paused ? " Auto stays off until you type auto on." : "";
    if (chain.setPaused) {
      const result = await chain.setPaused(paused);
      if ("error" in result) {
        say(desk, `${result.error}${autoNote}`, now);
        return;
      }
      desk.policy = { ...desk.policy, paused };
      say(desk, `${paused ? "Paused" : "Resumed"} on chain: the vault ${paused ? "refuses every swap" : "accepts swaps again"}.${autoNote} ${explorerTx(desk.chain, result.txHash)}`, now);
      return;
    }
    desk.policy = { ...desk.policy, paused };
    say(desk, `${paused ? "Paused in the paper book. Nothing will fill while this is on." : "Resumed in the paper book."}${autoNote}`, now);
    return;
  }
  if (intent.type === "tighten") {
    const patch: Parameters<typeof tightenPolicy>[1] = {};
    if (intent.maxQuote) {
      const parsed = parseDecimal(intent.maxQuote, desk.chain.quoteDecimals);
      if (parsed === null) {
        say(desk, "I could not read that max trade.", now);
        return;
      }
      patch.maxQuoteIn = parsed;
    }
    if (intent.dailyLoss) {
      const parsed = parseDecimal(intent.dailyLoss, desk.chain.quoteDecimals);
      if (parsed === null) {
        say(desk, "I could not read that daily loss.", now);
        return;
      }
      patch.dailyLoss = parsed;
    }
    if (intent.slippagePct) {
      const pct = Number(intent.slippagePct);
      if (!Number.isFinite(pct)) {
        say(desk, "I could not read that slippage.", now);
        return;
      }
      patch.slippageBps = Math.round(pct * 100);
    }
    if (intent.cooldownSec !== undefined) patch.cooldownSec = intent.cooldownSec;
    const tightened = tightenPolicy(desk.policy, patch);
    if (!tightened.ok) {
      say(desk, `${tightened.error} Nothing was sent.`, now);
      return;
    }
    if (chain.tighten) {
      const result = await chain.tighten(tightened.policy);
      if ("error" in result) {
        say(desk, result.error, now);
        return;
      }
      desk.policy = tightened.policy;
      say(desk, `Limits tightened on chain. ${explorerTx(desk.chain, result.txHash)}\n${statusText(desk, now)}`, now);
      return;
    }
    desk.policy = tightened.policy;
    say(desk, `Limits tightened in the paper book.\n${statusText(desk, now)}`, now);
    return;
  }
  if (intent.type === "reject") {
    if (!desk.proposal) {
      say(desk, "Nothing is waiting.", now);
      return;
    }
    const rejected = desk.proposal.id;
    desk.proposal = null;
    say(desk, `Rejected ${rejected}.`, now);
    return;
  }
  if (intent.type === "approve") {
    await approve(desk, now, chain);
    return;
  }
  if (intent.type === "example") {
    await runExample(desk, now);
    return;
  }
  if (intent.type === "check" || intent.type === "order") {
    if (!market) {
      say(desk, "No market reader is configured.", now);
      return;
    }
    if (!(await readLive(desk, chain, now))) return;
    let snap: Market;
    try {
      snap = await market();
    } catch (error) {
      say(desk, `Pool read failed: ${error instanceof Error ? error.message : "unknown error"}`, now);
      return;
    }
    const history = recordPrice(desk, snap.price);
    if (intent.type === "check") {
      await openProposal(desk, decide(strategyInput(desk, snap, history)), snap, "pool", now);
      return;
    }
    const decimals = intent.side === "buy" ? desk.chain.quoteDecimals : desk.chain.baseDecimals;
    const amount = parseDecimal(intent.amount, decimals);
    if (amount === null || amount === 0n) {
      say(desk, "I could not read that size.", now);
      return;
    }
    const decision: Decision = {
      action: intent.side,
      stop: false,
      reference: snap.price,
      premiumBps: 0,
      amountIn: amount,
      reason: `You asked to ${intent.side} ${intent.amount}. The vault still enforces the cap, the slippage floor, and the daily loss limit.`,
    };
    await openProposal(desk, decision, snap, "pool", now);
  }
}

async function setAuto(desk: Desk, intent: Extract<Intent, { type: "auto" }>, now: number, chain: ChainActions): Promise<void> {
  if (intent.action === "status") {
    say(desk, autoText(desk, now), now);
    return;
  }
  if (intent.action === "off") {
    desk.auto = { ...desk.auto, enabled: false, stoppedReason: null };
    say(desk, "Auto is off. Nothing trades until you approve a proposal or type auto on.", now);
    return;
  }
  if (intent.action === "demo" || intent.action === "standard") {
    desk.auto = { ...desk.auto, profile: intent.action };
    const band = thresholdsFor(intent.action).bandBps;
    say(desk, `Profile ${intent.action}: the band is ${band} bps. ${intent.action === "demo" ? "This is a demo setting for a quiet pool. It does not pay for the 0.60% round-trip fee." : "60 bps covers the 0.30% pool fee each way."} The vault limits are unchanged.`, now);
    return;
  }
  if (desk.mode !== "paper" && (!chain.execute || !chain.vault)) {
    say(desk, "Auto needs VAULT_ADDRESS and AGENT_PRIVATE_KEY in this mode.", now);
    return;
  }
  if (desk.policy.paused) {
    say(desk, "The vault is paused. Type resume first.", now);
    return;
  }
  const requested = intent.intervalSec ?? desk.auto.intervalSec ?? DEFAULT_INTERVAL_SEC;
  const intervalSec = Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, requested));
  desk.proposal = null;
  desk.auto = { ...desk.auto, enabled: true, intervalSec, failures: 0, stoppedReason: null, nextTickAt: now };
  const band = thresholdsFor(desk.auto.profile).bandBps;
  say(
    desk,
    [
      `Auto is on. Every ${intervalSec}s I read the HSKSwap pool and APRO HSK/USD, decide buy, sell or hold, and ${desk.mode === "paper" ? "fill the paper book" : "send the swap through the vault"} without asking.`,
      `Rule: sell when the pool is ${band} bps or more over the reference, buy when it is ${band} bps or more under, stop out ${thresholdsFor(desk.auto.profile).stopBps} bps under cost. Sizes come from the vault caps.`,
      "The vault still checks every trade. Type auto off to stop, or pause to stop and freeze the vault.",
    ].join("\n"),
    now,
  );
}

async function runExample(desk: Desk, now: number): Promise<void> {
  const history = [0.083, 0.0825, 0.0828, 0.0831];
  const price = 0.08;
  desk.book.prices = [...history, price];
  desk.book.base = 0n;
  desk.book.cost = 0n;
  desk.book.quote = desk.chain.name === "mainnet" ? 100_000_000n : desk.book.quote;
  desk.book.entryPrice = null;
  desk.fills = [];
  const sqrt = sqrtForHuman(price, desk.chain.token0IsBase, desk.chain.baseDecimals, desk.chain.quoteDecimals);
  const input: StrategyInput = {
    ...strategyInput(desk, { price, sqrtPriceX96: sqrt, liquidity: 0n, oraclePrice: null, oracleAgeSec: null, blockTime: now }, history),
    baseBalance: 0n,
    quoteBalance: desk.book.quote,
    trackedBase: 0n,
    trackedCost: 0n,
    dayLoss: 0n,
  };
  await openProposal(desk, decide(input), { price, sqrtPriceX96: sqrt }, "example", now);
}

async function approve(desk: Desk, now: number, chain: ChainActions): Promise<void> {
  const proposal = desk.proposal;
  if (!proposal) {
    say(desk, "Nothing is waiting.", now);
    return;
  }
  if (now > proposal.expiresAt) {
    desk.proposal = null;
    say(desk, "That proposal expired. Check the pool again.", now);
    return;
  }
  if (chain.execute && proposal.source === "pool") {
    const result = await chain.execute(proposal);
    if ("error" in result) {
      say(desk, result.error, now);
      return;
    }
    desk.fills.push({
      id: nextId(desk),
      side: proposal.side,
      amountIn: proposal.amountIn,
      amountOut: result.amountOut,
      reason: proposal.reason,
      txHash: result.txHash,
      at: now,
      source: `approved · ${desk.mode}`,
    });
    desk.proposal = null;
    const outSide = proposal.side === "buy" ? "base" : "quote";
    say(desk, `${desk.mode === "mainnet" ? "Mainnet" : "Testnet"} swap sent through the vault. Received ${money(desk, result.amountOut, outSide)}. ${explorerTx(desk.chain, result.txHash)}`, now);
    await readLive(desk, chain, now);
    return;
  }
  const filled = applySwap(desk.book, desk.policy, {
    side: proposal.side,
    amountIn: proposal.amountIn,
    sqrtPriceX96: proposal.sqrtPriceX96,
    zeroForOne: proposal.zeroForOne,
    fee: proposal.fee,
    now,
    price: proposal.price,
  });
  if (!filled.ok) {
    say(desk, filled.error, now);
    return;
  }
  desk.book = filled.book;
  desk.fills.push({
    id: nextId(desk),
    side: proposal.side,
    amountIn: proposal.amountIn,
    amountOut: filled.amountOut,
    reason: proposal.reason,
    txHash: null,
    at: now,
    source: proposal.source,
  });
  desk.proposal = null;
  const outSide = proposal.side === "buy" ? "base" : "quote";
  say(
    desk,
    `Paper fill. Received ${money(desk, filled.amountOut, outSide)}. Realized change ${money(desk, filled.realizedDelta, "quote")}. ${proposal.source === "example" ? "The price was the worked example, not the live pool." : "Filled at spot after the pool fee."}`,
    now,
  );
}

function sqrtForHuman(price: number, token0IsBase: boolean, baseDecimals: number, quoteDecimals: number): bigint {
  const scale = 10 ** (baseDecimals - quoteDecimals);
  const token1PerToken0 = token0IsBase ? price / scale : scale / price;
  return BigInt(Math.round(Math.sqrt(token1PerToken0) * 2 ** 96));
}

export function exampleSqrt(chain: ChainConfig): bigint {
  return sqrtForHuman(0.08, chain.token0IsBase, chain.baseDecimals, chain.quoteDecimals);
}
