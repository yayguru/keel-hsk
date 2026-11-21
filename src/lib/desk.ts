import type { ChainConfig, DeskMode } from "./chains";
import { narrate, type Narration } from "./llm";
import { applySwap, tightenPolicy, type Book, type Policy } from "./paper";
import { parseIntent, type Intent } from "./parse";
import { decide, type Decision } from "./strategy";
import { formatRaw, parseDecimal, spotOut, slippageFloor } from "./units";

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
};

export type ChainActions = {
  execute?: (proposal: Proposal) => Promise<{ txHash: string; amountOut: bigint } | { error: string }>;
  tighten?: (policy: Policy) => Promise<{ txHash: string } | { error: string }>;
  setPaused?: (paused: boolean) => Promise<{ txHash: string } | { error: string }>;
};

const HELP = [
  "Keel watches the WHSK/USDT 0.30% pool on HSKSwap. The rule is fixed. You can tighten the limits and approve a trade.",
  "check the pool",
  "worked example",
  "status",
  "positions",
  "risk",
  "max trade 1",
  "daily loss 3",
  "slippage 0.5%",
  "cooldown 120",
  "buy 2",
  "sell 0.01",
  "pause",
  "resume",
  "approve",
  "reject",
  "reset",
].join("\n");

export function freshDesk(chain: ChainConfig, now: number, mode: DeskMode = "paper"): Desk {
  const paper = chain.name === "mainnet";
  const quote = paper ? 100_000_000n : 1_000_000_000_000_000_000n;
  const intro =
    mode === "mainnet"
      ? "Mainnet mode. Approve sends a real swap through the vault, inside the caps. Do not point this at a public host."
      : mode === "testnet"
        ? "Testnet mode. Approve sends a swap through the vault when VAULT_ADDRESS and AGENT_PRIVATE_KEY are set."
        : "Paper book is open with 100 USDT. Nothing is sent to a chain. Ask me to check the pool, or run the worked example.";
  return {
    mode,
    chain,
    nextId: 1,
    proposal: null,
    fills: [],
    messages: [
      {
        id: "m0",
        role: "agent",
        at: now,
        text: intro,
      },
    ],
    policy: paper
      ? {
          maxQuoteIn: 2_000_000n,
          maxBaseIn: 25n * 10n ** 18n,
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

function id(desk: Desk): string {
  const value = `k${desk.nextId}`;
  desk.nextId += 1;
  return value;
}

function say(desk: Desk, text: string, now: number): void {
  desk.messages.push({ id: id(desk), role: "agent", text, at: now });
}

function zeroForOne(side: "buy" | "sell", token0IsBase: boolean): boolean {
  return side === "sell" ? token0IsBase : !token0IsBase;
}

function money(desk: Desk, amount: bigint, side: "quote" | "base"): string {
  const decimals = side === "quote" ? desk.chain.quoteDecimals : desk.chain.baseDecimals;
  const symbol = side === "quote" ? desk.chain.quoteSymbol : desk.chain.baseSymbol;
  return `${formatRaw(amount, decimals)} ${symbol}`;
}

function statusText(desk: Desk): string {
  const { book, policy, chain } = desk;
  const price = book.prices[book.prices.length - 1];
  const lines = [
    `${chain.label}, chain ${chain.id}. ${policy.paused ? "Paused." : "Trading is allowed."}`,
    `Book: ${money(desk, book.quote, "quote")} and ${money(desk, book.base, "base")}.`,
    `Realized ${money(desk, book.realized, "quote")}. Day loss ${money(desk, book.dayLoss, "quote")} of ${money(desk, policy.dailyLoss, "quote")}.`,
    price ? `Last pool read ${price.toFixed(5)} ${chain.quoteSymbol} per ${chain.baseSymbol}.` : "No pool read yet.",
    desk.proposal ? `A ${desk.proposal.side} is waiting for approve or reject.` : "No proposal waiting.",
  ];
  return lines.join("\n");
}

function propose(desk: Desk, decision: Extract<Decision, { action: "buy" | "sell" }>, market: { price: number; sqrtPriceX96: bigint; blockTime: number }, source: Proposal["source"], amountIn: bigint, note: string, now: number): void {
  const direction = zeroForOne(decision.action, desk.chain.token0IsBase);
  const spot = spotOut(amountIn, direction, market.sqrtPriceX96, desk.chain.fee);
  const floor = slippageFloor(spot, desk.policy.slippageBps);
  if (floor === 0n) {
    say(desk, "The spot quote rounded to zero at this size, so I did not propose it.", now);
    return;
  }
  const outSymbol = decision.action === "buy" ? desk.chain.baseSymbol : desk.chain.quoteSymbol;
  const outDecimals = decision.action === "buy" ? desk.chain.baseDecimals : desk.chain.quoteDecimals;
  desk.proposal = {
    id: id(desk),
    side: decision.action,
    stop: decision.stop,
    amountIn,
    sqrtPriceX96: market.sqrtPriceX96,
    zeroForOne: direction,
    fee: desk.chain.fee,
    slippageBps: desk.policy.slippageBps,
    price: market.price,
    reason: note,
    source,
    expiresAt: now + 120,
  };
  say(
    desk,
    [
      note,
      `Proposal ${desk.proposal.id}: ${decision.action} ${money(desk, amountIn, decision.action === "buy" ? "quote" : "base")}.`,
      `Spot after the 0.30% fee is about ${formatRaw(spot, outDecimals)} ${outSymbol}. The vault will reject a minimum under ${formatRaw(floor, outDecimals)}.`,
      source === "example" ? "This print is synthetic. It is not the live pool." : `Pool read at ${market.price.toFixed(5)}.`,
      "Reply approve or reject. It expires in 2 minutes.",
    ].join("\n"),
    now,
  );
}

async function openProposal(desk: Desk, decision: Decision, market: { price: number; sqrtPriceX96: bigint; blockTime: number }, source: Proposal["source"], amountIn: bigint, now: number): Promise<void> {
  if (decision.action === "hold") {
    say(desk, decision.reason, now);
    return;
  }
  if (amountIn <= 0n) {
    say(desk, `${decision.reason} Nothing to ${decision.action} at the current cap and balance.`, now);
    return;
  }
  const narration: Narration = decision.stop ? { act: "take", note: decision.reason } : await narrate(decision);
  if (!decision.stop && narration.act === "skip") {
    desk.proposal = null;
    say(desk, `${narration.note} Skipped. No proposal.`, now);
    return;
  }
  const sized = !decision.stop && narration.act === "shrink" ? amountIn / 2n : amountIn;
  if (sized === 0n) {
    say(desk, "The shrink rounded the order to zero.", now);
    return;
  }
  const note = decision.stop ? decision.reason : narration.note;
  propose(desk, decision, market, source, sized, note, now);
}

export async function handleMessage(desk: Desk, text: string, now: number, market: (() => Promise<{ price: number; sqrtPriceX96: bigint; liquidity: bigint; oraclePrice: number | null; oracleAgeSec: number | null; blockTime: number }>) | null, chain: ChainActions): Promise<Desk> {
  const intent = parseIntent(text);
  desk.messages.push({ id: id(desk), role: "user", text: text.trim(), at: now });
  await applyIntent(desk, intent, now, market, chain);
  return desk;
}

async function applyIntent(desk: Desk, intent: Intent, now: number, market: (() => Promise<{ price: number; sqrtPriceX96: bigint; liquidity: bigint; oraclePrice: number | null; oracleAgeSec: number | null; blockTime: number }>) | null, chain: ChainActions): Promise<void> {
  if (intent.type === "help" || intent.type === "unknown") {
    say(desk, intent.type === "unknown" ? `I only act on the desk commands.\n${HELP}` : HELP, now);
    return;
  }
  if (intent.type === "status" || intent.type === "positions" || intent.type === "risk") {
    say(desk, statusText(desk), now);
    return;
  }
  if (intent.type === "reset") {
    const fresh = freshDesk(desk.chain, now, desk.mode);
    desk.book = fresh.book;
    desk.proposal = null;
    desk.fills = [];
    say(desk, "Book reset. Limits were left as they are.", now);
    return;
  }
  if (intent.type === "pause" || intent.type === "resume") {
    const paused = intent.type === "pause";
    if (chain.setPaused) {
      const result = await chain.setPaused(paused);
      if ("error" in result) {
        say(desk, result.error, now);
        return;
      }
      desk.policy = { ...desk.policy, paused };
      say(desk, `${paused ? "Paused" : "Resumed"} on chain. Tx ${result.txHash}.`, now);
      return;
    }
    desk.policy = { ...desk.policy, paused };
    say(desk, paused ? "Paused in the paper book. The agent will not propose a fill while this is on." : "Resumed in the paper book.", now);
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
      say(desk, tightened.error, now);
      return;
    }
    if (chain.tighten) {
      const result = await chain.tighten(tightened.policy);
      if ("error" in result) {
        say(desk, result.error, now);
        return;
      }
      desk.policy = tightened.policy;
      say(desk, `Limits tightened on chain. Tx ${result.txHash}. ${statusText(desk)}`, now);
      return;
    }
    desk.policy = tightened.policy;
    say(desk, `Limits tightened in the paper book.\n${statusText(desk)}`, now);
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
  if (intent.type === "check") {
    if (!market) {
      say(desk, "No market reader is configured.", now);
      return;
    }
    let snap;
    try {
      snap = await market();
    } catch (error) {
      say(desk, `Pool read failed: ${error instanceof Error ? error.message : "unknown error"}`, now);
      return;
    }
    desk.book.prices = [...desk.book.prices, snap.price].slice(-24);
    const decision = decide({
      prices: desk.book.prices,
      oraclePrice: snap.oraclePrice,
      oracleAgeSec: snap.oracleAgeSec,
      base: desk.book.base,
      entryPrice: desk.book.entryPrice,
      entryAt: desk.book.entryAt,
      now: snap.blockTime,
    });
    const amountIn = decision.action === "buy" ? min(desk.policy.maxQuoteIn, desk.book.quote) : decision.action === "sell" ? min(desk.policy.maxBaseIn, desk.book.base) : 0n;
    await openProposal(desk, decision, snap, "pool", amountIn, now);
    return;
  }
  if (intent.type === "order") {
    const decimals = intent.side === "buy" ? desk.chain.quoteDecimals : desk.chain.baseDecimals;
    const amount = parseDecimal(intent.amount, decimals);
    if (amount === null || amount === 0n) {
      say(desk, "I could not read that size.", now);
      return;
    }
    if (!market) {
      say(desk, "A manual order still needs a pool read for the slippage floor.", now);
      return;
    }
    let snap;
    try {
      snap = await market();
    } catch (error) {
      say(desk, `Pool read failed: ${error instanceof Error ? error.message : "unknown error"}`, now);
      return;
    }
    const decision: Decision = {
      action: intent.side,
      stop: false,
      reference: snap.price,
      gapBps: 0,
      reason: `You asked to ${intent.side} ${intent.amount}. The vault still enforces the cap, the slippage floor, and the daily loss limit.`,
    };
    await openProposal(desk, decision, snap, "pool", amount, now);
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

async function runExample(desk: Desk, now: number): Promise<void> {
  const prices = [0.083, 0.0825, 0.0828, 0.0831, 0.08];
  desk.book.prices = prices;
  desk.book.base = 0n;
  desk.book.cost = 0n;
  desk.book.quote = desk.chain.name === "mainnet" ? 100_000_000n : desk.book.quote;
  desk.book.entryPrice = null;
  desk.fills = [];
  const decision = decide({
    prices,
    oraclePrice: null,
    oracleAgeSec: null,
    base: 0n,
    entryPrice: null,
    entryAt: null,
    now,
  });
  const sqrt = sqrtForHuman(0.08, desk.chain.token0IsBase, desk.chain.baseDecimals, desk.chain.quoteDecimals);
  const amountIn = min(desk.policy.maxQuoteIn, desk.book.quote);
  await openProposal(desk, decision, { price: 0.08, sqrtPriceX96: sqrt, blockTime: now }, "example", amountIn, now);
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
      id: id(desk),
      side: proposal.side,
      amountIn: proposal.amountIn,
      amountOut: result.amountOut,
      reason: proposal.reason,
      txHash: result.txHash,
      at: now,
      source: "testnet",
    });
    desk.proposal = null;
    say(desk, `Testnet swap sent. Tx ${result.txHash}. Output ${result.amountOut.toString()} raw units.`, now);
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
    id: id(desk),
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
  const ratio = Math.sqrt(token1PerToken0);
  return BigInt(Math.round(ratio * 2 ** 96));
}

export function exampleSqrt(chain: ChainConfig): bigint {
  return sqrtForHuman(0.08, chain.token0IsBase, chain.baseDecimals, chain.quoteDecimals);
}
