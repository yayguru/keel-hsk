export function parseDecimal(input: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(input)) return null;
  const [whole, frac = ""] = input.split(".");
  if (frac.length > decimals) return null;
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function formatRaw(amount: bigint, decimals: number, digits = 4): string {
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  const text = fraction ? `${whole.toString()}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

const Q96 = 2n ** 96n;

/** Spot output after the pool fee, rounded down. Matches KeelVault.spotOut. */
export function spotOut(amountIn: bigint, zeroForOne: boolean, sqrtPriceX96: bigint, fee: number): bigint {
  if (amountIn === 0n || sqrtPriceX96 === 0n) return 0n;
  const afterFee = (amountIn * BigInt(1_000_000 - fee)) / 1_000_000n;
  if (zeroForOne) {
    const step = (afterFee * sqrtPriceX96) / Q96;
    return (step * sqrtPriceX96) / Q96;
  }
  const step = (afterFee * Q96) / sqrtPriceX96;
  return (step * Q96) / sqrtPriceX96;
}

export function slippageFloor(spot: bigint, slippageBps: number): bigint {
  return (spot * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Quote tokens per one base token, for display. Not used as an execution price. */
export function humanQuotePerBase(sqrtPriceX96: bigint, token0IsBase: boolean, baseDecimals: number, quoteDecimals: number): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  const token1PerToken0 = ratio * ratio;
  const scale = 10 ** (baseDecimals - quoteDecimals);
  if (token0IsBase) return token1PerToken0 * scale;
  return (1 / token1PerToken0) * scale;
}
