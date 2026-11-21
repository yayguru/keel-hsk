export const ENTRY_BPS = 50;
export const EXIT_BPS = 10;
export const STOP_BPS = 150;
export const MAX_HOLD_SEC = 6 * 60 * 60;
export const ORACLE_MAX_AGE_SEC = 6 * 60 * 60;
export const MIN_SAMPLES = 4;

export type Side = "buy" | "sell";

export type Decision =
  | { action: "hold"; reason: string; reference: number | null; gapBps: number | null }
  | {
      action: Side;
      stop: boolean;
      reason: string;
      reference: number;
      gapBps: number;
    };

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function gapBps(reference: number, price: number): number {
  if (reference <= 0) return 0;
  return Math.round(((reference - price) / reference) * 10_000);
}

/**
 * One pair, one rule.
 * Buy when WHSK is at least 50 bps under the reference (APRO if it is under 6 hours old,
 * otherwise the mean of the earlier samples).
 * Sell when the gap has closed, the price is 150 bps under the entry, or the position is 6 hours old.
 * A stop or a time exit is marked `stop` so the language model cannot cancel it.
 */
export function decide(input: {
  prices: number[];
  oraclePrice: number | null;
  oracleAgeSec: number | null;
  base: bigint;
  entryPrice: number | null;
  entryAt: number | null;
  now: number;
}): Decision {
  const price = input.prices[input.prices.length - 1];
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    return { action: "hold", reason: "No pool price yet.", reference: null, gapBps: null };
  }

  const oracleFresh =
    input.oraclePrice !== null &&
    input.oracleAgeSec !== null &&
    input.oracleAgeSec >= 0 &&
    input.oracleAgeSec <= ORACLE_MAX_AGE_SEC &&
    input.oraclePrice > 0;

  const history = input.prices.slice(0, -1);
  const meanReady = history.length >= MIN_SAMPLES - 1;
  const reference = oracleFresh ? input.oraclePrice : meanReady ? mean(history) : null;
  const referenceName = oracleFresh ? "APRO HSK/USD" : "the recent pool mean";

  if (input.base > 0n && input.entryPrice && input.entryPrice > 0) {
    const dropBps = Math.round(((input.entryPrice - price) / input.entryPrice) * 10_000);
    const held = input.entryAt === null ? 0 : input.now - input.entryAt;
    if (dropBps >= STOP_BPS) {
      return {
        action: "sell",
        stop: true,
        reference: input.entryPrice,
        gapBps: dropBps,
        reason: `Stop. Pool is ${formatGap(dropBps)} the entry at ${input.entryPrice.toFixed(5)}.`,
      };
    }
    if (held >= MAX_HOLD_SEC) {
      return {
        action: "sell",
        stop: true,
        reference: input.entryPrice,
        gapBps: dropBps,
        reason: `Time exit. The position is ${Math.round(held / 60)} minutes old.`,
      };
    }
  }

  if (reference === null) {
    return {
      action: "hold",
      reference: null,
      gapBps: null,
      reason: `Holding. Need ${MIN_SAMPLES} pool reads or a fresh APRO print before the first entry. This read is ${price.toFixed(5)}.`,
    };
  }

  const gap = gapBps(reference, price);
  if (input.base > 0n && gap <= EXIT_BPS) {
    return {
      action: "sell",
      stop: false,
      reference,
      gapBps: gap,
      reason: `Gap closed. Pool is ${formatGap(gap)} ${referenceName} at ${reference.toFixed(5)}.`,
    };
  }

  if (input.base === 0n && gap >= ENTRY_BPS) {
    return {
      action: "buy",
      stop: false,
      reference,
      gapBps: gap,
      reason: `Pool is ${formatGap(gap)} ${referenceName} at ${reference.toFixed(5)}. The entry rule is ${ENTRY_BPS} bps.`,
    };
  }

  return {
    action: "hold",
    reference,
    gapBps: gap,
    reason: `No trade. Pool is ${price.toFixed(5)}, ${formatGap(gap)} ${referenceName} at ${reference.toFixed(5)}. Entry needs ${ENTRY_BPS} bps under, and only when the book holds no WHSK.`,
  };
}

function formatGap(bps: number): string {
  if (bps === 0) return "flat to";
  if (bps > 0) return `${bps} bps under`;
  return `${Math.abs(bps)} bps over`;
}
