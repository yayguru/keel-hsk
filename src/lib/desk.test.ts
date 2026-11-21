import assert from "node:assert/strict";
import test from "node:test";
import { CHAINS } from "./chains";
import { freshDesk, handleMessage } from "./desk";
import { applySwap } from "./paper";
import { parseIntent } from "./parse";
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

test("decision ids differ across desk restarts that reuse a proposal id", async () => {
  const { decisionIdFor } = await import("./live");
  const vault = "0x8980296BAe193A359937ac873f8E6759C289646d";
  assert.notEqual(decisionIdFor(vault, { id: "k5", expiresAt: 1 }), decisionIdFor(vault, { id: "k5", expiresAt: 2 }));
  assert.equal(decisionIdFor(vault, { id: "k5", expiresAt: 1 }), decisionIdFor(vault.toLowerCase() as `0x${string}`, { id: "k5", expiresAt: 1 }));
});

test("the on-chain reason keeps whole sentences under the vault limit", async () => {
  const { onChainReason } = await import("./live");
  const long = "auto: Pool 0.08110 is 85 bps over APRO HSK/USD 0.08042 (printed 13.0h ago). Band 60 bps. The pool is rich, so sell WHSK into it. No model key is set, so this note is the rule itself.";
  const out = onChainReason(long);
  assert.ok(out.length <= 170);
  assert.ok(out.endsWith("sell WHSK into it."));
});
