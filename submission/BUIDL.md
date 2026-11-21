# BUIDL text

Copy each block into the DoraHacks BUIDL form. This file does not submit anything.

## BUIDL name

Keel

## One-liner (Vision)

An autonomous HSKSwap trading agent that reads the pool and the APRO oracle, trades WHSK/USDT by itself, explains every decision in chat, and can only trade through a verified mainnet vault that enforces the trade cap, slippage floor, cooldown and daily loss stop.

## Track

AI Agent Trading

## Links

- GitHub: https://github.com/yayguru/keel-hsk
- Mainnet vault (HSK Chain, chain id 177): https://hsk.blockscout.com/address/0x8980296BAe193A359937ac873f8E6759C289646d
- Contract address: `0x8980296BAe193A359937ac873f8E6759C289646d`
- Deploy transaction: https://hsk.blockscout.com/tx/0x386afa2dba142422438d44f847c61c74a926812e4e67c8df19688736a7ca05f4
- Sourcify exact match: https://sourcify.dev/server/v2/contract/177/0x8980296BAe193A359937ac873f8E6759C289646d
- Autonomous mainnet swaps, decided and sent by the loop with no approve step:
  - 5 WHSK for 0.404297 USDT: https://hsk.blockscout.com/tx/0xb45adddf2c93bc020a27c65bb6d039102e8d77234d2283ba96a726f24449aa4a
  - 1.6879 WHSK for 0.136483 USDT: https://hsk.blockscout.com/tx/0x28cf10c5ad83b81a0a23d3263c24453d5b225969dd18fd4a077093de09c9f9ca
  - 1.2 WHSK for 0.097031 USDT, shown in the demo video: https://hsk.blockscout.com/tx/0x7dbf7c2b78cb1e723e56a7cd0c63ac7e0302efd633a43979da6dac7eb6474d72
- Owner kill switch from the chat, pause then resume: https://hsk.blockscout.com/tx/0x2a0356f85d513e58eb98e8295d176076223efc68bb40c5c33e3f132dfea027e6 and https://hsk.blockscout.com/tx/0xa009caa8ef8d68b59c26a2df9ddae00917f6b0f37780605b80441dc7c1ce1838
- Earlier manual sell from the chat (propose, then approve), 5 WHSK for 0.404297 USDT: https://hsk.blockscout.com/tx/0x3be3acda6b866ea83bb81c8cc533a45646af2fbaa737cbc704f9fd2667b9f702
- Earlier manual buy from the chat, 0.3 USDT for 3.6879 WHSK: https://hsk.blockscout.com/tx/0x2d86b4e5a9f5e6090fc1a08827c33a965cf045208dab8b70ced2d84af3b3d26b
- Testnet rehearsal vault (chain id 133): https://testnet-explorer.hskchain.net/address/0x8414702dD9bd6C0938Be758E96cF1C6Ec7bF32B5
- Demo video: paste the YouTube or Loom link

## Description

Paste everything between the lines into the description field. It is Markdown.

---

### Keel

Keel is an autonomous trading agent for one HSKSwap pool, WHSK/USDT at 0.30%, on HSK Chain mainnet. Turn it on with `auto on`. On a timer it reads the pool and the APRO HSK/USD oracle, decides buy, sell or hold, and sends the swap itself. Nobody approves each trade. Every decision, holds included, goes into the chat with the numbers it used, and every trade gets a Blockscout link.

The agent cannot break the risk limits, because they are not in the prompt. They are checks in KeelVault, a verified contract that holds the inventory and is the only thing that can call the router. The agent key can call `swap` and nothing else. People keep the stop button: `auto off`, `pause` (an on-chain kill switch), and limits that can only be tightened.

### The strategy

Mean reversion against the oracle, with position and loss awareness. The code is `src/lib/strategy.ts`.

- Reference: APRO HSK/USD while its last print is inside the feed's 24 hour heartbeat, otherwise the mean of recent pool reads.
- Premium = (pool − reference) / reference.
- Pool 60 bps or more over the reference: sell WHSK. 60 bps or more under: buy WHSK. 60 bps is the round-trip pool fee, 2 × 0.30%, so smaller gaps are not worth trading.
- Stop: if the vault holds a position and the pool is 150 bps under its average cost, sell. Stops never go to the language model.
- Size: the vault's per-trade cap, clipped to the balance. Half size once half of the daily loss budget is used, no buys once it is spent, and buys sized down to fit the inventory cap.
- Otherwise hold, and say why.

If an LLM key is set, the model writes the rationale and may skip or halve a non-stop trade. It cannot raise the size, flip the side or cancel a stop. Without a key the agent runs fully on the rule.

### The loop and its guards

- Each tick reads `KeelVault.risk()` and replaces the desk's view of balances, cost basis, day loss and limits with what is on chain.
- It waits out the vault cooldown instead of sending into it.
- It simulates every swap with `eth_call` before signing, so a refusal costs no gas.
- Refusals come back by name: `Cap`, `Slippage`, `Cooldown`, `DailyLoss`, `Inventory`, `PausedError`. Cooldown and daily loss only move the schedule. Anything else backs off, doubling each time, and the third failure in a row turns the loop off.
- The loop stops by itself when the agent has under 0.15 HSK for gas, or when the vault is paused. After a restart it stays off until a person turns it on.

### What the vault enforces

- Per-trade cap: 5 WHSK on a sell, 2 USDT on a buy.
- Slippage floor: the vault computes spot from the pool after the fee and rejects any minimum more than 1% under it.
- 60 second cooldown. 50 WHSK inventory cap.
- Daily realized-loss stop of 5 USDT. After it, buys revert and sells still work, so a stop is never trapped.
- The vault builds the `exactInputSingle` call itself, so the agent cannot pick another router, pool or recipient.
- Owner only: pause, withdraw, tighten. From the chat, `max trade 1` goes on chain and `max trade 3` is refused.
- Every swap emits a `Decision` event with the sizes, the floor, the running loss and the agent's reason.

### On HSK Chain mainnet

- KeelVault `0x8980296BAe193A359937ac873f8E6759C289646d`, verified on Blockscout (full match) and Sourcify (exact match).
- Three swaps decided and sent by the loop, with no approve step. Each `Decision` event's reason starts `auto:` and records the pool, the APRO print, its age and the band. At the time the pool was 85 bps over APRO, past the 60 bps band, so the rule sold.
- The loop logged holds between trades: the cooldown, then "rich, but no WHSK left to sell".
- The owner kill switch was used from the chat, and `auto on` was refused while the vault was paused.
- Sizes are deliberately tiny. HSK is about 0.081 USDT, so 5 WHSK is about 0.40 USDT.

### HSK products used

- HSK Chain mainnet RPC and the Blockscout explorer.
- HSKSwap SwapRouter02, factory and the WHSK/USDT 0.30% pool, with addresses from `@hskswap/sdk-core@1.0.3` checked on chain.
- APRO HSK/USD price feed as the reference price, never as the execution price.
- Official WHSK and USDT contracts from the HSK Chain token page.

### Stack

Solidity 0.8.26 and Foundry: 18 contract tests covering caps, the slippage floor, cooldown, inventory, pause, withdraw, the owner/agent split, replay, the daily loss stop and reset, and tighten. Next.js, TypeScript and viem for the desk and the loop: 34 unit tests for the strategy, the loop guards and full ticks against a fake vault, with no network. Optional OpenAI-compatible model for the rationale.

### Limits we know about

Spot comes from `slot0`, not a TWAP, so a price pushed inside one block can move the floor. That is one reason the caps are a few dollars. APRO is a heartbeat-and-deviation feed, so between prints it can trail the market by up to its deviation threshold, and the band has to be read with that in mind. The desk has no login, so mainnet mode belongs on a private machine, not a public URL.

---

## Form fields to fill

| Field | Value |
| --- | --- |
| BUIDL name | Keel |
| Logo | optional. Any square image |
| Vision / one-liner | the One-liner block above |
| Category / tags | DeFi, AI, HSK Chain |
| Track / bounty | AI Agent Trading |
| Is this BUIDL open source | Yes |
| GitHub | https://github.com/yayguru/keel-hsk |
| Project website | leave empty, or the GitHub link |
| Demo video | YouTube or Loom link to `demo/keel-demo.mp4` |
| Description | the Description block above |
| Smart contract / deployment | `0x8980296BAe193A359937ac873f8E6759C289646d` on HSK Chain mainnet, chain id 177 |
| Team | your name, contact email, Telegram |
| Can pitch in Seoul on 5 Dec | your answer. In-person teams get priority for demo selection |
