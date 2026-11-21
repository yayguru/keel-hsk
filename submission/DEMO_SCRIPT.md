# Demo script

About 2 minutes 30 seconds. Start the desk in paper mode so nothing is sent:

```bash
MODE=paper npm run dev
```

Open the desk. The header badges should read Paper, Chain 177, and Open.

## Shot list

1. **Desk, 15s.** Show the whole window. Say: "This is Keel. It watches the HSKSwap WHSK/USDT pool. It does not swap until I approve."
2. **Worked example, 20s.** Click the button `worked example`. The transcript states the recent mean, the 50 bps rule, and a buy of 2 USDT, and it says the print is synthetic. A row appears: `buy worked example` with Approve and Reject.
3. **Reject, then approve, 25s.** Click Reject. The row goes away. Click `worked example` again, then Approve. The book on the right shows WHSK. Realized stays 0 USDT. The fill line reads `buy · example · no chain tx`.
4. **Limit, 20s.** Type `max trade 50` in the message box and press Send. Keel refuses. Type `max trade 1` and send. The book’s max trade becomes 1 USDT. Say: "The chat can tighten a limit. It cannot loosen one."
5. **Live pool, 25s.** Type `reset` if a WHSK position is still open, so the live check is not an exit. Click `check the pool`. Read the price and the APRO line. On 20 Nov 2026 the pool was about 0.08276 and APRO about 0.08208, so with no position the rule holds. If it holds, say so. Do not force a trade.
6. **Pause, 15s.** Type `pause`. The badge switches to Paused. Type `resume`. It switches back to Open.
7. **Verified contract, 20s.** Open the testnet vault `0x8414702dD9bd6C0938Be758E96cF1C6Ec7bF32B5` on the testnet explorer. The page should show the source as verified. Open the Decision sell `0x5594f3666fb5c9ee98a7e1c5a58dedb110d0f94dc2a6cab9603e0cd84162a419` and point at the `Decision` event. Say: "The agent can call swap. Withdraw and pause stay with the owner."
8. **Close, 10s.** Back to the desk. Say: "Paper mode is the default. Mainnet is a separate deploy, with the same verify script, and the caps stay at a few dollars."

The buttons under the message box are `check the pool`, `worked example`, `status`, `risk`, and `max trade 1`. They send as soon as you click them. Approve and Reject only appear when a proposal is waiting.

## Narration, if you read it straight

Keel is a trading desk for the WHSK/USDT pool on HSKSwap. The agent reads the pool and states the rule. A buy needs the pool to be at least 50 basis points under APRO, or under its own recent mean when APRO is stale. A stop sells without asking the model.

The worked example uses a synthetic price, so the rule is visible when the live pool is not cheap. Approving it fills a paper book. It does not send a transaction. Raising the trade size is refused. Tightening it is kept.

The live check uses the HSK Chain RPC. If the rule says hold, that is what we show.

On chain, the agent can only swap through the vault. The verified testnet vault is on the explorer. The vault builds the router call, checks the size, the slippage floor, the cooldown, and the daily realized loss, and writes a Decision event. The owner can pause and withdraw. The agent cannot.
