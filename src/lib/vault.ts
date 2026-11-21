import type { Policy } from "./paper";

/** What the desk reads from KeelVault.risk() plus the agent's gas balance. */
export type VaultSnapshot = {
  paused: boolean;
  dayLoss: bigint;
  trackedBase: bigint;
  trackedCost: bigint;
  cooldownRemaining: number;
  quoteBalance: bigint;
  baseBalance: bigint;
  policy: Omit<Policy, "paused">;
  agentGas: bigint;
};

export type ExecResult = { txHash: string; amountOut: bigint } | { error: string; rule?: string };
