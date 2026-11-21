# Demo script

About 2 minutes 15 seconds. The recorded video, `demo/keel-demo.mp4`, was made this way on 21 Nov 2026 against HSK Chain mainnet. It is not committed. Upload it to YouTube or Loom and paste the link into the BUIDL.

Mainnet mode needs the vault keys in the environment, not in a file in the repo:

```bash
npm run build
MODE=mainnet VAULT_ADDRESS=0x8980296BAe193A359937ac873f8E6759C289646d \
  AGENT_PRIVATE_KEY=... OWNER_PRIVATE_KEY=... npm start
```

Without keys, `MODE=paper npm run dev` runs the same loop against live mainnet prices and fills a paper book. The paper book starts with USDT only, so while the pool is rich it holds, and says why.

## Shot list

1. **Desk, 10s.** The header reads Mainnet, Chain 177, Open, Auto off. Say: "Keel is an autonomous trading agent for HSKSwap. It trades through KeelVault, and the vault checks every swap."
2. **Status, 8s.** Type `status`. The transcript shows the vault's real balances, the day loss, the limits and the agent's gas, all read from `KeelVault.risk()`.
3. **Loosening refused, 6s.** Type `max trade 3`. It is refused and nothing is sent. Say: "The chat can tighten a limit. It cannot loosen one."
4. **Auto on, 15s.** Type `auto on 20`. The badge turns to Auto on with a countdown. The first decision lands within seconds: `Auto #1 · SELL 1.2 WHSK`, with the pool, the APRO print, its age, the 60 bps band, the amount received and the Blockscout link. Say: "No approve button. The rule decided, the vault checked it, and the swap is on mainnet."
5. **Cooldown, about 10s at 5x.** The next decision waits out the 60 second vault cooldown.
6. **Hold, 14s.** The next decision is a HOLD: the pool is still rich, but there is no WHSK left to sell. Say: "Every decision is logged, trade or not."
7. **Kill switch, 15s.** Type `pause`. That is an owner transaction. The vault refuses every swap and the badge reads Auto stopped. Type `auto on`: refused while paused. Type `resume`: auto stays off.
8. **Blockscout, 35s.** Open the vault: verified KeelVault. Open the autonomous swap: called by the agent key, method `swap`, on KeelVault. Open its Logs tab and scroll to `Decision`. The reason starts with `auto:`. Then the earlier autonomous swap.
9. **Close, 7s.** Back to the desk. Say: "The agent decides and trades. The contract keeps it inside the limits."

The buttons under the message box are `auto on`, `auto off`, `status`, `check the pool`, `pause`, `resume` and `max trade 1`. They send as soon as you click them.

## Narration, if you read it straight

Keel trades the WHSK/USDT pool on HSKSwap by itself. Every 20 to 90 seconds it reads the pool and the APRO HSK/USD oracle. If the pool is at least 60 basis points over the oracle, it sells. If it is 60 under, it buys. That band is the round-trip pool fee. If the vault holds a position that falls 150 basis points under cost, it stops out.

It does not ask for approval. It also cannot go around the limits, because they live in KeelVault on HSK Chain mainnet. The vault caps every trade, rejects a bad minimum, enforces a cooldown, and stops buys after the daily loss limit. The agent key can only call swap. Before signing, the agent simulates the swap. If the vault would refuse, it reads the rule by name and backs off. Three failures in a row, or low gas, turn it off.

People keep control. Auto off stops the loop. Pause freezes the vault on chain. Limits can be tightened from the chat and never loosened.
