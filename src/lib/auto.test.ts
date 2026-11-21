import assert from "node:assert/strict";
import test from "node:test";
import { autoTick } from "./auto";
import { freshAuto, MAX_FAILURES, MIN_AGENT_GAS, scheduleAfter } from "./autopilot";
import { CHAINS } from "./chains";
import { freshDesk, handleMessage, type ChainActions, type Desk, type Proposal } from "./desk";
import type { Market } from "./market";
import type { Policy } from "./paper";
import { DEMO, decide, STANDARD, type StrategyInput } from "./strategy";
import type { ExecResult, VaultSnapshot } from "./vault";

const now = 1_795_260_000;
const WHSK = 10n ** 18n;
const USDT = 1_000_000n;

const policy: Policy = {
  maxQuoteIn: 2n * USDT,
  maxBaseIn: 5n * WHSK,
  slippageBps: 100,
  dailyLoss: 5n * USDT,
  cooldownSec: 60,
  maxBase: 50n * WHSK,
  paused: false,
};

function input(over: Partial<StrategyInput> = {}): StrategyInput {
  return {
    price: 0.081,
    history: [],
    oraclePrice: 0.0804,
    oracleAgeSec: 3_600,
    baseBalance: 6n * WHSK,
    quoteBalance: 1n * USDT,
    trackedBase: 0n,
    trackedCost: 0n,
    dayLoss: 0n,
    policy,
    baseDecimals: 18,
    quoteDecimals: 6,
    thresholds: STANDARD,
    ...over,
  };
}

// sqrtPriceX96 for 0.081 USDT per WHSK with WHSK as token0 (18) and USDT as token1 (6).
const SQRT_0081 = BigInt(Math.round(Math.sqrt(0.081 / 1e12) * 2 ** 96));

function market(over: Partial<Market> = {}): Market {
  return { price: 0.081, sqrtPriceX96: SQRT_0081, liquidity: 1n, oraclePrice: 0.0804, oracleAgeSec: 3_600, blockTime: now, ...over };
}

function vault(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  const { paused: _paused, ...limits } = policy;
  void _paused;
  return {
    paused: false,
    dayLoss: 0n,
    trackedBase: 0n,
    trackedCost: 0n,
    cooldownRemaining: 0,
    quoteBalance: 100_000n,
    baseBalance: 6n * WHSK,
    policy: limits,
    agentGas: WHSK,
    ...over,
  };
}

function liveDesk(): Desk {
  const desk = freshDesk(CHAINS.mainnet, now, "mainnet");
  desk.auto = { ...freshAuto(), enabled: true, intervalSec: 60 };
  return desk;
}

function fakeChain(snap: VaultSnapshot, results: ExecResult[]): ChainActions & { sent: Proposal[] } {
  const sent: Proposal[] = [];
  return {
    sent,
    vault: async () => snap,
    execute: async (proposal) => {
      sent.push(proposal);
      return results.shift() ?? { error: "no result queued" };
    },
  };
}

const take = async () => ({ act: "take" as const, note: "rule note" });

// Strategy

test("pool rich against fresh APRO sells the capped size", () => {
  const d = decide(input());
  assert.equal(d.action, "sell");
  if (d.action !== "sell") return;
  assert.equal(d.amountIn, 5n * WHSK);
  assert.equal(d.premiumBps, 75);
  assert.match(d.reason, /APRO HSK\/USD/);
});

test("pool cheap buys, capped by the per-trade limit and the balance", () => {
  const d = decide(input({ price: 0.0795, quoteBalance: 10n * USDT }));
  assert.equal(d.action, "buy");
  if (d.action === "buy") assert.equal(d.amountIn, 2n * USDT);
  const small = decide(input({ price: 0.0795, quoteBalance: 300_000n }));
  if (small.action === "buy") assert.equal(small.amountIn, 300_000n);
});

test("inside the band holds and says so with the numbers", () => {
  const d = decide(input({ price: 0.0806 }));
  assert.equal(d.action, "hold");
  assert.match(d.reason, /Inside the band/);
  assert.match(d.reason, /0\.08060/);
});

test("the demo profile trades a gap the standard band holds", () => {
  assert.equal(decide(input({ price: 0.0806 })).action, "hold");
  assert.equal(decide(input({ price: 0.0806, thresholds: DEMO })).action, "sell");
});

test("stale APRO falls back to the pool mean, and warms up first", () => {
  const stale = { oracleAgeSec: 26 * 3_600 };
  assert.match(decide(input({ ...stale, history: [0.081] })).reason, /Warming up/);
  const d = decide(input({ ...stale, history: [0.08, 0.08, 0.08], price: 0.0806 }));
  assert.equal(d.action, "sell");
  assert.match(d.reason, /pool mean/);
});

test("stop sells below cost even when the pool looks cheap", () => {
  const d = decide(input({ price: 0.078, trackedBase: 3n * WHSK, trackedCost: 243_000n }));
  assert.equal(d.action, "sell");
  if (d.action === "sell") assert.equal(d.stop, true);
});

test("daily loss: half size after half the budget, no buys once spent", () => {
  const half = decide(input({ price: 0.0795, quoteBalance: 10n * USDT, dayLoss: 3n * USDT }));
  if (half.action === "buy") assert.equal(half.amountIn, USDT);
  else assert.fail("expected a half-size buy");
  const spent = decide(input({ price: 0.0795, quoteBalance: 10n * USDT, dayLoss: 5n * USDT }));
  assert.equal(spent.action, "hold");
  assert.equal(decide(input({ dayLoss: 5n * USDT })).action, "sell");
});

test("inventory cap shrinks or blocks a buy", () => {
  const d = decide(input({ price: 0.0795, quoteBalance: 10n * USDT, trackedBase: 49n * WHSK, trackedCost: USDT }));
  assert.equal(d.action, "buy");
  if (d.action === "buy") assert.ok(d.amountIn < 80_000n);
  assert.equal(decide(input({ price: 0.0795, quoteBalance: 10n * USDT, trackedBase: 50n * WHSK, trackedCost: 4n * USDT })).action, "hold");
});

test("nothing to sell and paused both hold", () => {
  assert.equal(decide(input({ baseBalance: 0n })).action, "hold");
  assert.equal(decide(input({ policy: { ...policy, paused: true } })).action, "hold");
});

// Loop guard

test("three failures in a row stop the loop, with doubling waits before that", () => {
  let s = { ...freshAuto(), enabled: true, intervalSec: 60 };
  s = scheduleAfter(s, { kind: "error", message: "rpc" }, now, 60);
  assert.equal(s.nextTickAt, now + 120);
  s = scheduleAfter(s, { kind: "refused", rule: "Slippage", message: "x" }, now, 60);
  assert.equal(s.nextTickAt, now + 240);
  assert.equal(s.enabled, true);
  s = scheduleAfter(s, { kind: "error", message: "rpc" }, now, 60);
  assert.equal(s.failures, MAX_FAILURES);
  assert.equal(s.enabled, false);
  assert.match(s.stoppedReason ?? "", /3 failures/);
});

test("cooldown and daily-loss refusals are not failures; a hold resets the count", () => {
  let s = { ...freshAuto(), enabled: true, intervalSec: 30, failures: 2 };
  s = scheduleAfter(s, { kind: "refused", rule: "Cooldown", message: "x" }, now, 60);
  assert.equal(s.failures, 2);
  assert.equal(s.nextTickAt, now + 62);
  s = scheduleAfter(s, { kind: "refused", rule: "DailyLoss", message: "x" }, now, 60);
  assert.equal(s.failures, 2);
  s = scheduleAfter(s, { kind: "hold" }, now, 60);
  assert.equal(s.failures, 0);
});

test("after a trade the next decision waits out the vault cooldown", () => {
  const s = scheduleAfter({ ...freshAuto(), enabled: true, intervalSec: 20 }, { kind: "traded" }, now, 60);
  assert.equal(s.nextTickAt, now + 62);
  assert.equal(s.trades, 1);
});

test("a PausedError refusal turns the loop off", () => {
  const s = scheduleAfter({ ...freshAuto(), enabled: true }, { kind: "refused", rule: "PausedError", message: "x" }, now, 60);
  assert.equal(s.enabled, false);
});

// Ticks with fake chain and market

test("a rich pool trades with no approve and logs the tx link", async () => {
  const desk = liveDesk();
  const chain = fakeChain(vault(), [{ txHash: "0xabc", amountOut: 400_000n }]);
  await autoTick(desk, { market: async () => market(), chain, narrate: take }, now);
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0].side, "sell");
  assert.ok(chain.sent[0].amountIn <= policy.maxBaseIn);
  assert.equal(desk.proposal, null);
  assert.equal(desk.auto.trades, 1);
  const last = desk.messages.at(-1)?.text ?? "";
  assert.match(last, /Auto #1 · SELL 5 WHSK/);
  assert.match(last, /hsk\.blockscout\.com\/tx\/0xabc/);
});

test("a hold is logged with its reason and nothing is sent", async () => {
  const desk = liveDesk();
  const chain = fakeChain(vault(), []);
  await autoTick(desk, { market: async () => market({ price: 0.0805 }), chain, narrate: take }, now);
  assert.equal(chain.sent.length, 0);
  assert.match(desk.messages.at(-1)?.text ?? "", /HOLD[\s\S]*Inside the band/);
  assert.equal(desk.auto.nextTickAt, now + 60);
});

test("vault cooldown holds and reschedules for when it clears", async () => {
  const desk = liveDesk();
  const chain = fakeChain(vault({ cooldownRemaining: 40 }), []);
  await autoTick(desk, { market: async () => market(), chain }, now);
  assert.equal(chain.sent.length, 0);
  assert.equal(desk.auto.nextTickAt, now + 42);
});

test("low agent gas stops the loop before sending", async () => {
  const desk = liveDesk();
  const chain = fakeChain(vault({ agentGas: MIN_AGENT_GAS - 1n }), []);
  await autoTick(desk, { market: async () => market(), chain }, now);
  assert.equal(chain.sent.length, 0);
  assert.equal(desk.auto.enabled, false);
  assert.match(desk.messages.at(-1)?.text ?? "", /Auto stopped: agent gas/);
});

test("a vault paused by the owner stops the loop", async () => {
  const desk = liveDesk();
  const chain = fakeChain(vault({ paused: true }), []);
  await autoTick(desk, { market: async () => market(), chain }, now);
  assert.equal(desk.auto.enabled, false);
  assert.equal(chain.sent.length, 0);
});

test("repeated named refusals back off and then stop the loop", async () => {
  const desk = liveDesk();
  const refusal = { error: "The vault refused it: Slippage(1, 2). Nothing was sent.", rule: "Slippage" };
  const chain = fakeChain(vault(), [refusal, refusal, refusal]);
  for (let i = 0; i < 3; i += 1) {
    await autoTick(desk, { market: async () => market(), chain, narrate: take }, now + i * 1_000);
  }
  assert.equal(chain.sent.length, 3);
  assert.equal(desk.auto.enabled, false);
  assert.match(desk.messages.map((m) => m.text).join("\n"), /Slippage\(1, 2\)/);
});

test("the vault limits read on chain replace the local mirror", async () => {
  const desk = liveDesk();
  const tight = vault();
  tight.policy = { ...tight.policy, maxBaseIn: WHSK };
  const chain = fakeChain(tight, [{ txHash: "0x1", amountOut: 80_000n }]);
  await autoTick(desk, { market: async () => market(), chain, narrate: take }, now);
  assert.equal(chain.sent[0].amountIn, WHSK);
});

test("paper auto fills the paper book with live prices and no chain", async () => {
  const desk = freshDesk(CHAINS.mainnet, now, "paper");
  await handleMessage(desk, "auto on 20", now, null, {});
  assert.equal(desk.auto.enabled, true);
  assert.equal(desk.auto.intervalSec, 20);
  await autoTick(desk, { market: async () => market({ price: 0.0795, sqrtPriceX96: BigInt(Math.round(Math.sqrt(0.0795 / 1e12) * 2 ** 96)) }), chain: {}, narrate: take }, now);
  assert.ok(desk.book.base > 0n);
  assert.equal(desk.fills[0]?.source, "auto · paper");
});

test("chat controls: auto off, pause stops auto, loosening is refused", async () => {
  const desk = freshDesk(CHAINS.mainnet, now, "paper");
  await handleMessage(desk, "auto on", now, null, {});
  await handleMessage(desk, "max trade 3", now, null, {});
  assert.match(desk.messages.at(-1)?.text ?? "", /only be tightened/);
  assert.equal(desk.policy.maxQuoteIn, 2n * USDT);
  await handleMessage(desk, "pause", now, null, {});
  assert.equal(desk.auto.enabled, false);
  assert.equal(desk.policy.paused, true);
  await handleMessage(desk, "auto on", now, null, {});
  assert.equal(desk.auto.enabled, false);
  await handleMessage(desk, "resume", now, null, {});
  await handleMessage(desk, "auto on", now, null, {});
  await handleMessage(desk, "auto off", now, null, {});
  assert.equal(desk.auto.enabled, false);
});

test("auto refuses to start on mainnet without vault keys", async () => {
  const desk = freshDesk(CHAINS.mainnet, now, "mainnet");
  await handleMessage(desk, "auto on", now, null, {});
  assert.equal(desk.auto.enabled, false);
  assert.match(desk.messages.at(-1)?.text ?? "", /VAULT_ADDRESS/);
});

test("auto off means a tick does nothing", async () => {
  const desk = liveDesk();
  desk.auto.enabled = false;
  const chain = fakeChain(vault(), []);
  const before = desk.messages.length;
  await autoTick(desk, { market: async () => market(), chain }, now);
  assert.equal(desk.messages.length, before);
  assert.equal(chain.sent.length, 0);
});

test("the same hold twice is one line with a range", async () => {
  const desk = liveDesk();
  const chain = fakeChain(vault(), []);
  await autoTick(desk, { market: async () => market({ price: 0.0805 }), chain }, now);
  const count = desk.messages.length;
  desk.auto.nextTickAt = now;
  await autoTick(desk, { market: async () => market({ price: 0.0805 }), chain }, now + 60);
  assert.equal(desk.messages.length, count);
  assert.match(desk.messages.at(-1)?.text ?? "", /^Auto #1–#2 · HOLD/);
});

test("after a mined swap the cooldown is counted from when the tick ends", async () => {
  const desk = liveDesk();
  const chain = fakeChain(vault(), [{ txHash: "0x2", amountOut: 400_000n }]);
  await autoTick(desk, { market: async () => market(), chain, narrate: take, clock: () => now + 7 }, now);
  assert.equal(desk.auto.nextTickAt, now + 7 + 62);
});
