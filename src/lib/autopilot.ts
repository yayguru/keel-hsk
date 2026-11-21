import type { Profile } from "./strategy";

/** Autonomous loop state. Pure data, so the guard rules below can be tested without a chain. */
export type AutoState = {
  enabled: boolean;
  profile: Profile;
  intervalSec: number;
  nextTickAt: number;
  lastTickAt: number;
  ticks: number;
  trades: number;
  failures: number;
  stoppedReason: string | null;
};

export const DEFAULT_INTERVAL_SEC = 90;
export const MIN_INTERVAL_SEC = 15;
export const MAX_INTERVAL_SEC = 3600;
export const MAX_FAILURES = 3;
export const MAX_BACKOFF_SEC = 900;
/** About one swap of gas at 500 gwei, plus margin. Under this the loop stops instead of stranding a tx. */
export const MIN_AGENT_GAS = 150_000_000_000_000_000n;

/** Vault errors that mean "not now" rather than "something is wrong". */
const EXPECTED_REFUSALS = new Set(["Cooldown", "DailyLoss"]);

export function freshAuto(): AutoState {
  return {
    enabled: false,
    profile: "standard",
    intervalSec: DEFAULT_INTERVAL_SEC,
    nextTickAt: 0,
    lastTickAt: 0,
    ticks: 0,
    trades: 0,
    failures: 0,
    stoppedReason: null,
  };
}

export type Outcome =
  | { kind: "hold" }
  | { kind: "wait"; until: number }
  | { kind: "traded" }
  | { kind: "refused"; rule: string | null; message: string }
  | { kind: "error"; message: string }
  | { kind: "stop"; reason: string };

/**
 * Next state after one tick.
 * - A hold or a trade clears the failure count. After a trade the next tick waits out the vault cooldown.
 * - Cooldown and DailyLoss refusals are expected and do not count as failures.
 * - Any other refusal or error counts. The wait doubles each time, capped at 15 minutes.
 *   The third failure in a row turns the loop off.
 * - PausedError turns the loop off: the owner pulled the kill switch.
 */
export function scheduleAfter(state: AutoState, outcome: Outcome, now: number, cooldownSec: number): AutoState {
  const next = { ...state, lastTickAt: now };
  switch (outcome.kind) {
    case "hold":
      return { ...next, failures: 0, nextTickAt: now + state.intervalSec };
    case "wait":
      return { ...next, nextTickAt: Math.max(outcome.until, now + 1) };
    case "traded":
      return { ...next, failures: 0, trades: state.trades + 1, nextTickAt: now + Math.max(state.intervalSec, cooldownSec + 2) };
    case "stop":
      return { ...next, enabled: false, stoppedReason: outcome.reason };
    case "refused":
      if (outcome.rule === "PausedError") return { ...next, enabled: false, stoppedReason: "The vault is paused on chain." };
      if (outcome.rule === "Cooldown") return { ...next, nextTickAt: now + cooldownSec + 2 };
      if (outcome.rule && EXPECTED_REFUSALS.has(outcome.rule)) return { ...next, nextTickAt: now + state.intervalSec };
      return fail(next, `${outcome.rule ?? "Swap"} refused: ${outcome.message}`, now);
    case "error":
      return fail(next, outcome.message, now);
  }
}

function fail(state: AutoState, message: string, now: number): AutoState {
  const failures = state.failures + 1;
  if (failures >= MAX_FAILURES) {
    return { ...state, failures, enabled: false, stoppedReason: `${failures} failures in a row. Last: ${message}` };
  }
  const wait = Math.min(MAX_BACKOFF_SEC, state.intervalSec * 2 ** failures);
  return { ...state, failures, nextTickAt: now + wait };
}
