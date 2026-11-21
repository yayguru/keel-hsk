import { explorerAddress, explorerTx } from "./chains";
import { autoText } from "./desk";
import { thresholdsFor } from "./strategy";
import type { Desk } from "./desk";
import { formatRaw } from "./units";

export type DeskView = {
  mode: "paper" | "testnet" | "mainnet";
  chainLabel: string;
  chainId: number;
  pair: string;
  poolUrl: string;
  routerUrl: string;
  paused: boolean;
  auto: {
    enabled: boolean;
    stopped: boolean;
    label: string;
    detail: string;
    profile: string;
    bandBps: number;
    intervalSec: number;
    nextInSec: number | null;
    ticks: number;
    trades: number;
  };
  agentGas: string | null;
  quote: string;
  base: string;
  realized: string;
  unrealized: string;
  price: string;
  dayLoss: string;
  dayLimit: string;
  maxTrade: string;
  slippage: string;
  cooldown: string;
  inventory: string;
  proposal: { id: string; text: string } | null;
  fills: { id: string; text: string; href: string | null }[];
  messages: { id: string; role: "user" | "agent"; text: string }[];
};

export function toView(desk: Desk, now: number): DeskView {
  const chain = desk.chain;
  const price = desk.book.prices.at(-1) ?? null;
  const baseHuman = Number(formatRaw(desk.book.base, chain.baseDecimals, 8));
  const costHuman = Number(formatRaw(desk.book.cost, chain.quoteDecimals, 8));
  const mark = price === null ? null : baseHuman * price - costHuman;
  return {
    mode: desk.mode,
    chainLabel: chain.label,
    chainId: chain.id,
    pair: `${chain.baseSymbol}/${chain.quoteSymbol} 0.30%`,
    poolUrl: explorerAddress(chain, chain.pool),
    routerUrl: explorerAddress(chain, chain.router),
    paused: desk.policy.paused,
    auto: {
      enabled: desk.auto.enabled,
      stopped: !desk.auto.enabled && desk.auto.stoppedReason !== null,
      label: desk.auto.enabled ? "Auto on" : desk.auto.stoppedReason ? "Auto stopped" : "Auto off",
      detail: autoText(desk, now),
      profile: desk.auto.profile,
      bandBps: thresholdsFor(desk.auto.profile).bandBps,
      intervalSec: desk.auto.intervalSec,
      nextInSec: desk.auto.enabled ? Math.max(0, desk.auto.nextTickAt - now) : null,
      ticks: desk.auto.ticks,
      trades: desk.auto.trades,
    },
    agentGas: desk.vault ? `${formatRaw(desk.vault.agentGas, 18)} HSK` : null,
    quote: raw(desk.book.quote, chain.quoteDecimals, chain.quoteSymbol),
    base: raw(desk.book.base, chain.baseDecimals, chain.baseSymbol),
    realized: raw(desk.book.realized, chain.quoteDecimals, chain.quoteSymbol),
    unrealized: mark === null ? "—" : `${mark.toFixed(4)} ${chain.quoteSymbol}`,
    price: price === null ? "—" : `${price.toFixed(5)} ${chain.quoteSymbol}`,
    dayLoss: `${raw(desk.book.dayLoss, chain.quoteDecimals, chain.quoteSymbol)} / ${raw(desk.policy.dailyLoss, chain.quoteDecimals, chain.quoteSymbol)}`,
    dayLimit: raw(desk.policy.dailyLoss, chain.quoteDecimals, chain.quoteSymbol),
    maxTrade: raw(desk.policy.maxQuoteIn, chain.quoteDecimals, chain.quoteSymbol),
    slippage: `${(desk.policy.slippageBps / 100).toFixed(2)}%`,
    cooldown: `${desk.policy.cooldownSec}s`,
    inventory: raw(desk.policy.maxBase, chain.baseDecimals, chain.baseSymbol),
    proposal: desk.proposal
      ? {
          id: desk.proposal.id,
          text: `${desk.proposal.side} ${desk.proposal.source === "example" ? "worked example" : "pool"} · ${desk.proposal.id}`,
        }
      : null,
    fills: desk.fills.slice().reverse().map((fill) => ({
      id: fill.id,
      text: `${fill.side} · ${fill.source}${fill.txHash ? "" : " · no chain tx"}`,
      href: fill.txHash ? explorerTx(chain, fill.txHash) : null,
    })),
    messages: desk.messages.map((message) => ({ id: message.id, role: message.role, text: message.text })),
  };
}

function raw(amount: bigint, decimals: number, symbol: string): string {
  return `${formatRaw(amount, decimals)} ${symbol}`;
}
