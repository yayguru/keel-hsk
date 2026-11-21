# BUIDL text

Copy each block into the DoraHacks BUIDL form. This file does not submit anything.

## BUIDL name

Keel

## One-liner (Vision)

An AI trading desk for HSKSwap that explains each WHSK/USDT trade in chat, and can only trade through a verified mainnet vault that enforces the trade cap, slippage floor, cooldown and daily loss stop.

## Track

AI Agent Trading

## Links

- GitHub: https://github.com/yayguru/keel-hsk
- Mainnet vault (HSK Chain, chain id 177): https://hsk.blockscout.com/address/0x8980296BAe193A359937ac873f8E6759C289646d
- Contract address: `0x8980296BAe193A359937ac873f8E6759C289646d`
- Deploy transaction: https://hsk.blockscout.com/tx/0x386afa2dba142422438d44f847c61c74a926812e4e67c8df19688736a7ca05f4
- Sourcify exact match: https://sourcify.dev/server/v2/contract/177/0x8980296BAe193A359937ac873f8E6759C289646d
- Mainnet sell from the chat, 5 WHSK for 0.404297 USDT: https://hsk.blockscout.com/tx/0x3be3acda6b866ea83bb81c8cc533a45646af2fbaa737cbc704f9fd2667b9f702
- Mainnet buy from the chat, 0.3 USDT for 3.6879 WHSK: https://hsk.blockscout.com/tx/0x2d86b4e5a9f5e6090fc1a08827c33a965cf045208dab8b70ced2d84af3b3d26b
- Testnet rehearsal vault (chain id 133): https://testnet-explorer.hskchain.net/address/0x8414702dD9bd6C0938Be758E96cF1C6Ec7bF32B5
- Demo video: paste the YouTube or Loom link

## Description

Paste everything between the lines into the description field. It is Markdown.

---

### Keel

Keel is a trading desk for one HSKSwap pool, WHSK/USDT at 0.30%, on HSK Chain mainnet. You talk to it in a chat. The agent reads the pool, compares it with the APRO HSK/USD oracle, explains what it would do and why, and waits for `approve`. The trade then goes through KeelVault, a contract that holds the inventory and is the only thing that can touch the router.

The point is that the risk limits are not a promise in the prompt. They are checks in a verified contract. The agent key can call `swap` and nothing else.

### What the vault enforces

- Per-trade cap: 5 WHSK on a sell, 2 USDT on a buy.
- Slippage floor: the vault computes spot from the pool after the fee and rejects any `amountOutMin` more than 1% below it. The agent cannot pass a loose minimum.
- Cooldown: 60 seconds between swaps.
- Inventory cap: 50 WHSK.
- Daily realized-loss stop: 5 USDT. After it, buys revert and sells still work, so a stop-loss is never trapped.
- The vault builds the `exactInputSingle` call itself. The agent cannot choose another router, pool or recipient.
- The owner can pause, withdraw and tighten limits. From the chat, limits can only get tighter: `max trade 1` is sent on chain, `max trade 3` is refused.
- Every swap emits a `Decision` event with the sizes, the floor, the running loss and the reason text, so the explorer shows why each trade happened.

### The agent

A buy is proposed only when the pool is at least 50 bps under a reference: APRO HSK/USD when the print is under six hours old, otherwise the mean of recent pool reads. A sell is proposed when the gap closes, when the price is 150 bps under the entry, or when the position is six hours old. Stops never go to the language model.

If an LLM key is set, the model writes the note and may skip or halve a non-stop entry. It cannot raise the size, flip the side or cancel a stop. Without a key the note is the rule itself, so the desk runs with no account.

The chat shows the book, P&L, day loss and limits. Commands include `check the pool`, `buy 2`, `sell 0.5`, `approve`, `reject`, `status`, `max trade 1`, `daily loss 3`, `slippage 0.5%`, `cooldown 120`, `pause` and `resume`. Paper mode reads live mainnet prices and sends nothing. Mainnet mode sends real swaps through the vault.

### On HSK Chain mainnet

- KeelVault `0x8980296BAe193A359937ac873f8E6759C289646d`, verified on Blockscout (full match) and Sourcify (exact match).
- Two swaps sent from the chat in mainnet mode, each with a `Decision` event: a sell of 5 WHSK and a buy of 0.3 USDT. Links are above.
- In the same session the vault refused `sell 6` with `Cap(6e18, 5e18)` and a buy during the cooldown with `Cooldown`. A refusal shows at gas estimation, so nothing was broadcast.
- Sizes are deliberately tiny. HSK was about 0.081 USDT in the pool, so 5 WHSK is about 0.40 USDT.

### HSK products used

- HSK Chain mainnet RPC and Blockscout explorer.
- HSKSwap SwapRouter02, factory and the WHSK/USDT 0.30% pool, with addresses from `@hskswap/sdk-core@1.0.3` and checked on chain.
- APRO HSK/USD price feed as the reference price, never as the execution price.
- Official WHSK and USDT contracts from the HSK Chain token page.

### Stack

Solidity 0.8.26 and Foundry (18 tests: caps, slippage floor, cooldown, inventory, pause, withdraw, owner/agent split, replay, daily loss stop and reset, tighten). Next.js, TypeScript and viem for the desk. Optional OpenAI-compatible model for the notes.

### Limits we know about

Spot comes from `slot0`, not a TWAP, so a price pushed inside one block can move the floor. That is one reason the caps are a few dollars. The agent proposes and a human approves; it does not trade unattended.

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
