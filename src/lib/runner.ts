import { autoTick } from "./auto";
import { scheduleAfter } from "./autopilot";
import { runtimeMode } from "./chains";
import { say, type ChainActions, type Desk } from "./desk";
import { executeProposal, pauseVault, readVault, tightenVault, vaultAddress } from "./live";
import { readMarket } from "./market";
import { loadDesk, saveDesk } from "./store";

type LoopGlobals = typeof globalThis & {
  __keelQueue?: Promise<unknown>;
  __keelTimer?: ReturnType<typeof setInterval>;
};

const g = globalThis as LoopGlobals;
const HEARTBEAT_MS = 2_000;

/** Chat messages and loop ticks touch the same desk. They run one at a time, in arrival order. */
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = (g.__keelQueue ?? Promise.resolve()).then(fn, fn);
  g.__keelQueue = run.catch(() => undefined);
  return run;
}

export function chainActions(desk: Desk): ChainActions {
  if (runtimeMode() === "paper" || !vaultAddress()) return {};
  return {
    execute: (proposal) => executeProposal(desk.chain, proposal),
    tighten: (next) => tightenVault(desk.chain, desk.policy, next),
    setPaused: (paused) => pauseVault(desk.chain, paused),
    vault: process.env.AGENT_PRIVATE_KEY ? () => readVault(desk.chain) : undefined,
  };
}

/** A two-second heartbeat. It only does network work when auto is on and a decision is due. */
export function ensureLoop(): void {
  if (g.__keelTimer) return;
  g.__keelTimer = setInterval(() => {
    const desk = loadDesk();
    const now = Math.floor(Date.now() / 1000);
    if (!desk.auto.enabled || now < desk.auto.nextTickAt) return;
    // Push the due time out first, so the next heartbeat does not queue a second tick.
    desk.auto = { ...desk.auto, nextTickAt: now + 3_600 };
    void serialize(async () => {
      const working = structuredClone(loadDesk());
      const tickAt = Math.floor(Date.now() / 1000);
      try {
        await autoTick(working, { market: () => readMarket(working.chain), chain: chainActions(working), clock: () => Math.floor(Date.now() / 1000) }, tickAt);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        working.auto = scheduleAfter(working.auto, { kind: "error", message }, tickAt, working.policy.cooldownSec);
        say(working, `Auto #${working.auto.ticks} · error\n${message}`, tickAt);
      }
      saveDesk(working);
    }).catch((error: unknown) => {
      console.error("auto tick failed", error instanceof Error ? error.message : error);
    });
  }, HEARTBEAT_MS);
}
