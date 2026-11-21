import { slippageFloor, spotOut } from "./units";

export type Policy = {
  maxQuoteIn: bigint;
  maxBaseIn: bigint;
  slippageBps: number;
  dailyLoss: bigint;
  cooldownSec: number;
  maxBase: bigint;
  paused: boolean;
};

export type Book = {
  quote: bigint;
  base: bigint;
  cost: bigint;
  realized: bigint;
  dayId: number;
  dayLoss: bigint;
  lastSwapAt: number;
  entryPrice: number | null;
  entryAt: number | null;
  prices: number[];
};

export type SwapRequest = {
  side: "buy" | "sell";
  amountIn: bigint;
  sqrtPriceX96: bigint;
  zeroForOne: boolean;
  fee: number;
  now: number;
  price: number;
};

export type SwapResult =
  | { ok: true; book: Book; amountOut: bigint; realizedDelta: bigint }
  | { ok: false; error: string };

function roll(book: Book, now: number): Book {
  const dayId = Math.floor(now / 86_400);
  if (dayId === book.dayId) return book;
  return { ...book, dayId, dayLoss: 0n };
}

/** Paper copy of the vault gates and the cost-basis ledger. */
export function applySwap(book: Book, policy: Policy, request: SwapRequest): SwapResult {
  if (policy.paused) return { ok: false, error: "The vault is paused." };
  if (request.amountIn <= 0n) return { ok: false, error: "Amount is zero." };

  const cap = request.side === "buy" ? policy.maxQuoteIn : policy.maxBaseIn;
  if (request.amountIn > cap) return { ok: false, error: "That size is above the per-trade cap." };

  if (book.lastSwapAt !== 0 && request.now < book.lastSwapAt + policy.cooldownSec) {
    const wait = book.lastSwapAt + policy.cooldownSec - request.now;
    return { ok: false, error: `Cooldown has ${wait}s left.` };
  }

  const rolled = roll(book, request.now);
  if (request.side === "buy" && rolled.dayLoss >= policy.dailyLoss) {
    return { ok: false, error: "Daily loss limit is already used. Buys are blocked until the next day." };
  }

  const spot = spotOut(request.amountIn, request.zeroForOne, request.sqrtPriceX96, request.fee);
  const floor = slippageFloor(spot, policy.slippageBps);
  if (floor === 0n) return { ok: false, error: "The spot quote rounded to zero." };
  const balance = request.side === "buy" ? rolled.quote : rolled.base;
  if (request.amountIn > balance) return { ok: false, error: "The book does not have that much." };

  if (request.side === "buy") {
    const nextBase = rolled.base + spot;
    if (nextBase > policy.maxBase) return { ok: false, error: "That buy would pass the inventory cap." };
    return {
      ok: true,
      amountOut: spot,
      realizedDelta: 0n,
      book: {
        ...rolled,
        quote: rolled.quote - request.amountIn,
        base: nextBase,
        cost: rolled.cost + request.amountIn,
        lastSwapAt: request.now,
        entryPrice: rolled.entryPrice ?? request.price,
        entryAt: rolled.entryAt ?? request.now,
      },
    };
  }

  const fromTracked = request.amountIn > rolled.base ? rolled.base : request.amountIn;
  const costRemoved = rolled.base === 0n ? 0n : (rolled.cost * fromTracked) / rolled.base;
  const loss = spot < costRemoved ? costRemoved - spot : 0n;
  const profit = spot > costRemoved ? spot - costRemoved : 0n;
  return {
    ok: true,
    amountOut: spot,
    realizedDelta: profit - loss,
    book: {
      ...rolled,
      base: rolled.base - fromTracked,
      quote: rolled.quote + spot,
      cost: rolled.cost - costRemoved,
      realized: rolled.realized + profit - loss,
      dayLoss: rolled.dayLoss + loss,
      lastSwapAt: request.now,
      entryPrice: rolled.base - fromTracked === 0n ? null : rolled.entryPrice,
      entryAt: rolled.base - fromTracked === 0n ? null : rolled.entryAt,
    },
  };
}

export function tightenPolicy(policy: Policy, patch: Partial<Pick<Policy, "maxQuoteIn" | "maxBaseIn" | "slippageBps" | "dailyLoss" | "cooldownSec" | "maxBase">>): { ok: true; policy: Policy } | { ok: false; error: string } {
  const next = { ...policy };
  if (patch.maxQuoteIn !== undefined) {
    if (patch.maxQuoteIn > policy.maxQuoteIn) return { ok: false, error: "Max trade can only be tightened here." };
    next.maxQuoteIn = patch.maxQuoteIn;
  }
  if (patch.maxBaseIn !== undefined) {
    if (patch.maxBaseIn > policy.maxBaseIn) return { ok: false, error: "Max sell can only be tightened here." };
    next.maxBaseIn = patch.maxBaseIn;
  }
  if (patch.slippageBps !== undefined) {
    if (patch.slippageBps > policy.slippageBps || patch.slippageBps > 500) return { ok: false, error: "Slippage can only be tightened, and not above 5%." };
    next.slippageBps = patch.slippageBps;
  }
  if (patch.dailyLoss !== undefined) {
    if (patch.dailyLoss > policy.dailyLoss) return { ok: false, error: "The daily loss limit can only be tightened here." };
    next.dailyLoss = patch.dailyLoss;
  }
  if (patch.cooldownSec !== undefined) {
    if (patch.cooldownSec < policy.cooldownSec || patch.cooldownSec > 7 * 24 * 60 * 60) {
      return { ok: false, error: "Cooldown can only be lengthened, up to 7 days." };
    }
    next.cooldownSec = patch.cooldownSec;
  }
  if (patch.maxBase !== undefined) {
    if (patch.maxBase > policy.maxBase) return { ok: false, error: "Inventory cap can only be tightened here." };
    next.maxBase = patch.maxBase;
  }
  return { ok: true, policy: next };
}
