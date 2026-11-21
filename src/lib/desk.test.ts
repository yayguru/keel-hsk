import assert from "node:assert/strict";
import test from "node:test";
import { CHAINS } from "./chains";
import { freshDesk, handleMessage } from "./desk";
import { applySwap } from "./paper";
import { parseIntent } from "./parse";
import { decide } from "./strategy";
import { humanQuotePerBase, spotOut } from "./units";

const now = 1_700_000_000;

test("pool price matches the mainnet slot0 read", () => {
  const price = humanQuotePerBase(22792935898071939407571n, true, 18, 6);
  assert.ok(Math.abs(price - 0.08276398) < 0.00002);
});

test("spot out at price 1 with the 0.30% fee", () => {
  const sqrt = 2n ** 96n;
  assert.equal(spotOut(1_000_000_000_000_000_000n, true, sqrt, 3000), 997_000_000_000_000_000n);
});

test("parser keeps the desk commands and ignores prose", () => {
  assert.equal(parseIntent("check the pool").type, "check");
  assert.equal(parseIntent("max trade 1").type, "tighten");
  assert.deepEqual(parseIntent("buy 2"), { type: "order", side: "buy", amount: "2" });
  assert.equal(parseIntent("please be profitable").type, "unknown");
});

test("entry fires 50 bps under the recent mean and a stop does not wait", () => {
  const buy = decide({
    prices: [0.083, 0.0825, 0.0828, 0.0831, 0.08],
    oraclePrice: null,
    oracleAgeSec: null,
    base: 0n,
    entryPrice: null,
    entryAt: null,
    now,
  });
  assert.equal(buy.action, "buy");
  const stop = decide({
    prices: [0.08, 0.08, 0.08, 0.08, 0.0785],
    oraclePrice: null,
    oracleAgeSec: null,
    base: 1n,
    entryPrice: 0.08,
    entryAt: now,
    now,
  });
  assert.equal(stop.action, "sell");
  if (stop.action === "sell") assert.equal(stop.stop, true);
});

test("a losing sell blocks the next buy and still allows the sell", () => {
  const sqrt = 2n ** 96n;
  const policy = freshDesk(CHAINS.mainnet, now).policy;
  policy.dailyLoss = 100n;
  policy.maxQuoteIn = 1_000n;
  policy.maxBaseIn = 1_000n;
  policy.cooldownSec = 0;
  let book = { ...freshDesk(CHAINS.mainnet, now).book, quote: 1_000n, base: 0n };
  const buy = applySwap(book, policy, { side: "buy", amountIn: 1_000n, sqrtPriceX96: sqrt, zeroForOne: false, fee: 0, now, price: 1 });
  assert.equal(buy.ok, true);
  if (!buy.ok) return;
  book = buy.book;
  const sell = applySwap(book, policy, {
    side: "sell",
    amountIn: book.base,
    sqrtPriceX96: 2n ** 95n,
    zeroForOne: true,
    fee: 0,
    now: now + 1,
    price: 0.25,
  });
  assert.equal(sell.ok, true);
  if (!sell.ok) return;
  assert.ok(sell.book.dayLoss > policy.dailyLoss);
  const again = applySwap(sell.book, policy, { side: "buy", amountIn: 10n, sqrtPriceX96: sqrt, zeroForOne: false, fee: 0, now: now + 2, price: 1 });
  assert.equal(again.ok, false);
});

test("worked example proposes and a paper approve fills", async () => {
  const desk = freshDesk(CHAINS.mainnet, now);
  await handleMessage(desk, "worked example", now, null, {});
  assert.ok(desk.proposal);
  assert.equal(desk.proposal?.side, "buy");
  await handleMessage(desk, "approve", now + 1, null, {});
  assert.equal(desk.proposal, null);
  assert.ok(desk.book.base > 0n);
  assert.equal(desk.fills[0]?.txHash, null);
});

test("tighten cannot raise the max trade", async () => {
  const desk = freshDesk(CHAINS.mainnet, now);
  await handleMessage(desk, "max trade 50", now, null, {});
  assert.match(desk.messages.at(-1)?.text ?? "", /only be tightened/);
});
