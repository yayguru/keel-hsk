import { explorerTx } from "./chains";
import { MIN_AGENT_GAS, scheduleAfter, type Outcome } from "./autopilot";
import { buildProposal, holdingsText, money, nextId, recordPrice, say, strategyInput, syncFromVault, type ChainActions, type Desk, type MarketReader } from "./desk";
import { narrate as defaultNarrate, type Narration } from "./llm";
import type { Market } from "./market";
import { applySwap } from "./paper";
import { decide, type Decision } from "./strategy";
import { formatRaw } from "./units";

export type TickDeps = {
  market: MarketReader;
  chain: ChainActions;
  narrate?: (decision: Decision) => Promise<Narration>;
  /** Seconds now. The schedule is set from the end of the tick, after a swap has been mined. */
  clock?: () => number;
};

/**
 * One autonomous decision. Reads the vault and the pool, applies the rule, and either holds
 * or sends the swap with no approve step. Every path writes one line to the transcript and
 * moves the schedule through `scheduleAfter`, which owns backoff and stopping.
 */
export async function autoTick(desk: Desk, deps: TickDeps, now: number): Promise<void> {
  if (!desk.auto.enabled) return;
  desk.auto = { ...desk.auto, ticks: desk.auto.ticks + 1 };
  const outcome = await runTick(desk, deps, now);
  const wasOn = desk.auto.enabled;
  desk.auto = scheduleAfter(desk.auto, outcome, deps.clock ? Math.max(now, deps.clock()) : now, desk.policy.cooldownSec);
  if (wasOn && !desk.auto.enabled) say(desk, `Auto stopped: ${desk.auto.stoppedReason}`, now);
}

/** Logs a hold. If the last line was the same hold, it is updated in place so a quiet pool does not flood the transcript. */
function logHold(desk: Desk, n: number, body: string, now: number): void {
  const last = desk.messages.at(-1);
  const match = last?.role === "agent" ? last.text.match(/^Auto #(\d+)(?:–#\d+)? · HOLD\n([\s\S]*)$/) : null;
  if (last && match && match[2] === body) {
    last.text = `Auto #${match[1]}–#${n} · HOLD\n${body}`;
    last.at = now;
    return;
  }
  say(desk, `Auto #${n} · HOLD\n${body}`, now);
}

async function runTick(desk: Desk, deps: TickDeps, now: number): Promise<Outcome> {
  const n = desk.auto.ticks;
  const head = (label: string) => `Auto #${n} · ${label}`;
  const live = Boolean(deps.chain.vault && deps.chain.execute);

  if (desk.mode !== "paper" && !live) return { kind: "stop", reason: "No vault key is configured." };

  if (deps.chain.vault) {
    try {
      syncFromVault(desk, await deps.chain.vault());
    } catch (error) {
      const message = `Vault read failed: ${error instanceof Error ? error.message : "unknown error"}`;
      say(desk, `${head("error")}\n${message}`, now);
      return { kind: "error", message };
    }
    const vault = desk.vault;
    if (vault && vault.agentGas < MIN_AGENT_GAS) {
      return { kind: "stop", reason: `agent gas is ${formatRaw(vault.agentGas, 18)} HSK, under the ${formatRaw(MIN_AGENT_GAS, 18)} HSK floor. Top up the agent address.` };
    }
    if (vault?.paused) return { kind: "stop", reason: "The vault is paused on chain." };
  } else if (desk.policy.paused) {
    return { kind: "stop", reason: "The paper book is paused." };
  }

  if (!deps.market) return { kind: "stop", reason: "No market reader." };
  let market: Market;
  try {
    market = await deps.market();
  } catch (error) {
    const message = `Pool read failed: ${error instanceof Error ? error.message : "unknown error"}`;
    say(desk, `${head("error")}\n${message}`, now);
    return { kind: "error", message };
  }
  const history = recordPrice(desk, market.price);

  const cooldownLeft = desk.vault
    ? desk.vault.cooldownRemaining
    : desk.book.lastSwapAt === 0
      ? 0
      : Math.max(0, desk.book.lastSwapAt + desk.policy.cooldownSec - now);
  if (cooldownLeft > 0) {
    say(desk, `${head("HOLD")}\nThe vault cooldown has ${cooldownLeft}s left. Pool ${market.price.toFixed(5)}. Next look when it clears.`, now);
    return { kind: "wait", until: now + cooldownLeft + 2 };
  }

  const decision = decide(strategyInput(desk, market, history));
  if (decision.action === "hold") {
    logHold(desk, n, `${decision.reason}\n${holdingsText(desk)}`, now);
    return { kind: "hold" };
  }

  let note = decision.reason;
  let amountIn = decision.amountIn;
  if (!decision.stop) {
    const narration = await (deps.narrate ?? defaultNarrate)(decision);
    if (narration.act === "skip") {
      say(desk, `${head("HOLD")}\n${decision.reason}\nThe model skipped it: ${narration.note}\n${holdingsText(desk)}`, now);
      return { kind: "hold" };
    }
    if (narration.act === "shrink") amountIn /= 2n;
    note = narration.note;
  }

  const sizeSide = decision.action === "buy" ? "quote" : "base";
  const label = `${decision.action.toUpperCase()} ${money(desk, amountIn, sizeSide)}${decision.stop ? " (stop)" : ""}`;
  const proposal = amountIn > 0n ? buildProposal(desk, decision.action, decision.stop, amountIn, market, "pool", `auto: ${note}`, now) : null;
  if (!proposal) {
    say(desk, `${head("HOLD")}\n${decision.reason}\nThe quote rounds to zero at this size.`, now);
    return { kind: "hold" };
  }
  const outSide = decision.action === "buy" ? "base" : "quote";

  if (live && deps.chain.execute) {
    const result = await deps.chain.execute(proposal);
    if ("error" in result) {
      say(desk, `${head(`${label} refused`)}\n${note}\n${result.error}`, now);
      return { kind: "refused", rule: result.rule ?? null, message: result.error };
    }
    desk.fills.push({ id: nextId(desk), side: proposal.side, amountIn, amountOut: result.amountOut, reason: note, txHash: result.txHash, at: now, source: `auto · ${desk.mode}` });
    if (deps.chain.vault) {
      try {
        syncFromVault(desk, await deps.chain.vault());
      } catch {
        // the next tick reads it again
      }
    }
    say(desk, `${head(label)}\n${note}\nSent through the vault, no approve step. Received ${money(desk, result.amountOut, outSide)}.\n${explorerTx(desk.chain, result.txHash)}\n${holdingsText(desk)}`, now);
    return { kind: "traded" };
  }

  const filled = applySwap(desk.book, desk.policy, {
    side: proposal.side,
    amountIn,
    sqrtPriceX96: proposal.sqrtPriceX96,
    zeroForOne: proposal.zeroForOne,
    fee: proposal.fee,
    now,
    price: market.price,
  });
  if (!filled.ok) {
    say(desk, `${head(`${label} refused`)}\n${note}\n${filled.error}`, now);
    return { kind: "refused", rule: null, message: filled.error };
  }
  desk.book = filled.book;
  desk.fills.push({ id: nextId(desk), side: proposal.side, amountIn, amountOut: filled.amountOut, reason: note, txHash: null, at: now, source: "auto · paper" });
  say(desk, `${head(label)}\n${note}\nPaper fill at spot after the fee: received ${money(desk, filled.amountOut, outSide)}. Realized change ${money(desk, filled.realizedDelta, "quote")}.\n${holdingsText(desk)}`, now);
  return { kind: "traded" };
}
