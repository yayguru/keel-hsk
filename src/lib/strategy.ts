import type { Policy } from "./paper";

/**
 * Keel's trading rule. One pair, one reference, three exits from HOLD.
 *
 * Reference: APRO HSK/USD while its last print is inside the feed heartbeat
 * (APRO re-prints on a price move or every 24 hours, so 25 hours is the cutoff).
 * When APRO is older than that, the mean of the earlier pool reads.
 *
 * premium = (pool - reference) / reference, in bps. Positive means the pool is rich.
 *
 *   1. Stop: the vault holds a tracked position and the pool is STOP bps under its average cost. Sell.
 *   2. Rich: premium >= band. Sell WHSK into the pool.
 *   3. Cheap: premium <= -band. Buy WHSK with USDT.
 *   Otherwise hold.
 *
 * The standard band is 60 bps: the pool fee is 0.30% each way, so a gap under 2 x 30 bps
 * would not pay for the round trip. Sizes come from the vault caps and balances, halved
 * once half of the daily loss budget is used, and no buy once the budget is spent.
 */

export type Profile = "standard" | "demo";

export type Thresholds = {
  profile: Profile;
  bandBps: number;
  stopBps: number;
  oracleMaxAgeSec: number;
  minSamples: number;
};

export const STANDARD: Thresholds = {
  profile: "standard",
  bandBps: 60,
  stopBps: 150,
  oracleMaxAgeSec: 25 * 60 * 60,
  minSamples: 4,
};

/** Same rule with a 10 bps band, so a quiet pool still shows trades. Documented as a demo setting. */
export const DEMO: Thresholds = { ...STANDARD, profile: "demo", bandBps: 10 };

export function thresholdsFor(profile: Profile): Thresholds {
  return profile === "demo" ? DEMO : STANDARD;
}

export type Side = "buy" | "sell";

export type Decision =
  | { action: "hold"; reason: string; reference: number | null; premiumBps: number | null }
  | {
      action: Side;
      stop: boolean;
      reason: string;
      reference: number;
      premiumBps: number;
      amountIn: bigint;
    };

export type StrategyInput = {
  /** Pool price now, quote per base. */
  price: number;
  /** Earlier pool reads, oldest first, not including `price`. */
  history: number[];
  oraclePrice: number | null;
  oracleAgeSec: number | null;
  /** Spendable balances. On chain these are the vault balances. */
  baseBalance: bigint;
  quoteBalance: bigint;
  /** Cost-basis position, as the vault tracks it. */
  trackedBase: bigint;
  trackedCost: bigint;
  dayLoss: bigint;
  policy: Policy;
  baseDecimals: number;
  quoteDecimals: number;
  thresholds: Thresholds;
};

export type Reference = { value: number; name: string; detail: string };

export function pickReference(input: Pick<StrategyInput, "history" | "oraclePrice" | "oracleAgeSec" | "thresholds">): Reference | null {
  const { oraclePrice, oracleAgeSec, thresholds } = input;
  if (oraclePrice !== null && oracleAgeSec !== null && oraclePrice > 0 && oracleAgeSec >= 0 && oracleAgeSec <= thresholds.oracleMaxAgeSec) {
    return { value: oraclePrice, name: "APRO HSK/USD", detail: `printed ${formatAge(oracleAgeSec)} ago` };
  }
  if (input.history.length >= thresholds.minSamples - 1) {
    const window = input.history.slice(-12);
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
    const why = oraclePrice === null ? "APRO did not answer" : `APRO is ${formatAge(oracleAgeSec ?? 0)} old`;
    return { value: mean, name: "the pool mean", detail: `${window.length} reads, because ${why}` };
  }
  return null;
}

export function premiumBps(price: number, reference: number): number {
  return Math.round(((price - reference) / reference) * 10_000);
}

export function decide(input: StrategyInput): Decision {
  const { price, policy, thresholds } = input;
  if (!Number.isFinite(price) || price <= 0) {
    return { action: "hold", reason: "No pool price.", reference: null, premiumBps: null };
  }
  if (policy.paused) {
    return { action: "hold", reason: "The vault is paused.", reference: null, premiumBps: null };
  }

  const minBase = 10n ** BigInt(Math.max(input.baseDecimals - 2, 0));
  const minQuote = 10n ** BigInt(Math.max(input.quoteDecimals - 2, 0));
  const sellSize = min(policy.maxBaseIn, input.baseBalance);

  if (input.trackedBase > 0n && input.trackedCost > 0n) {
    const avgCost = human(input.trackedCost, input.quoteDecimals) / human(input.trackedBase, input.baseDecimals);
    const drop = Math.round(((avgCost - price) / avgCost) * 10_000);
    if (drop >= thresholds.stopBps && sellSize >= minBase) {
      return {
        action: "sell",
        stop: true,
        reference: avgCost,
        premiumBps: -drop,
        amountIn: sellSize,
        reason: `Stop. Pool ${price.toFixed(5)} is ${drop} bps under the average cost ${avgCost.toFixed(5)}. The stop is ${thresholds.stopBps} bps.`,
      };
    }
  }

  const reference = pickReference(input);
  if (!reference) {
    return {
      action: "hold",
      reference: null,
      premiumBps: null,
      reason: `Warming up. APRO is stale and the pool mean needs ${thresholds.minSamples} reads. This read is ${price.toFixed(5)}.`,
    };
  }

  const premium = premiumBps(price, reference.value);
  const where = `Pool ${price.toFixed(5)} is ${describe(premium)} ${reference.name} ${reference.value.toFixed(5)} (${reference.detail}). Band ${thresholds.bandBps} bps.`;

  if (premium >= thresholds.bandBps) {
    if (sellSize < minBase) {
      return { action: "hold", reference: reference.value, premiumBps: premium, reason: `${where} The pool is rich, but there is no WHSK to sell.` };
    }
    return {
      action: "sell",
      stop: false,
      reference: reference.value,
      premiumBps: premium,
      amountIn: sellSize,
      reason: `${where} The pool is rich, so sell WHSK into it.`,
    };
  }

  if (premium <= -thresholds.bandBps) {
    if (input.dayLoss >= policy.dailyLoss) {
      return { action: "hold", reference: reference.value, premiumBps: premium, reason: `${where} The pool is cheap, but the daily loss budget is spent, so no buys today.` };
    }
    let size = min(policy.maxQuoteIn, input.quoteBalance);
    let note = "";
    if (input.dayLoss * 2n >= policy.dailyLoss) {
      size /= 2n;
      note = " Half size, because half of the daily loss budget is used.";
    }
    const room = policy.maxBase > input.trackedBase ? policy.maxBase - input.trackedBase : 0n;
    const roomQuote = BigInt(Math.floor(human(room, input.baseDecimals) * price * 0.98 * 10 ** input.quoteDecimals));
    if (roomQuote < size) {
      size = roomQuote;
      note += " Sized down to stay under the inventory cap.";
    }
    if (size < minQuote) {
      return { action: "hold", reference: reference.value, premiumBps: premium, reason: `${where} The pool is cheap, but there is not enough USDT or inventory room for a buy.` };
    }
    return {
      action: "buy",
      stop: false,
      reference: reference.value,
      premiumBps: premium,
      amountIn: size,
      reason: `${where} The pool is cheap, so buy WHSK.${note}`,
    };
  }

  return { action: "hold", reference: reference.value, premiumBps: premium, reason: `${where} Inside the band, so hold.` };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function human(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

function describe(bps: number): string {
  if (bps === 0) return "flat to";
  return bps > 0 ? `${bps} bps over` : `${-bps} bps under`;
}

export function formatAge(sec: number): string {
  if (sec < 120) return `${Math.round(sec)}s`;
  if (sec < 2 * 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
