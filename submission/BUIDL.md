# BUIDL text

Paste this into the DoraHacks submission. Do not submit it from this workspace.

## Title

Keel

## One-liner

An HSKSwap agent that can explain a WHSK/USDT trade, and can only swap through a vault that enforces the cap, the slippage floor, and the daily loss.

## Track

AI Agent Trading

## Description

Keel is a desk for one HSKSwap pool, WHSK/USDT at 0.30%. You talk to it. It reads the pool and, when APRO HSK/USD is fresh, compares the pool with that print. Otherwise it uses the recent pool mean. It buys only when the pool is at least 50 bps cheap, and it sells when the gap closes, when the price is 150 bps under the entry, or when the position is six hours old.

The language model writes the note and may skip or halve an entry. It cannot raise the size, change the side, or cancel a stop. With no API key the note is the rule itself, so the demo runs with no account.

Nothing is sent until you approve. In paper mode the fill stays in a local book. On HSK Chain testnet the fill is `KeelVault.swap`. The vault builds the SwapRouter02 call. The agent key cannot withdraw, cannot point at another router, and cannot set a minimum under the spot floor. The owner can pause, withdraw, and only tighten the limits from the chat. Every swap emits a `Decision` event with the reason.

Default sizes are a few dollars on mainnet and fractions of a token on testnet. The contract is tested in Foundry. Mainnet deployment is a documented step for the owner and is not done in this workspace.

## Tech stack

- Solidity 0.8.26 and Foundry. The vault is a few local files, so the explorer can verify the standard JSON.
- HSK Chain RPC and Blockscout
- HSKSwap SwapRouter02, from `@hskswap/sdk-core@1.0.3`, checked on chain
- APRO HSK/USD as a reference, not as the execution price
- Next.js, TypeScript, viem
- OpenAI-compatible chat completions, optional

## Links

- Verified testnet vault: https://testnet-explorer.hskchain.net/address/0x8414702dD9bd6C0938Be758E96cF1C6Ec7bF32B5
- Deploy tx: https://testnet-explorer.hskchain.net/tx/0x9370b5a0f293cba0cd6157120d5a9b997a8cbd008dddfac9112520aa9d725f48
- Decision sell on that vault: https://testnet-explorer.hskchain.net/tx/0x5594f3666fb5c9ee98a7e1c5a58dedb110d0f94dc2a6cab9603e0cd84162a419
- Sourcify exact match: https://sourcify.dev/server/v2/contract/133/0x8414702dD9bd6C0938Be758E96cF1C6Ec7bF32B5
- Earlier vault, also a Sourcify exact match, with the first two desk and script sells: https://testnet-explorer.hskchain.net/address/0x8C4c3769BC08425730d95A84F4709bbf34e44EC9
- Mainnet vault: paste after `contracts/deploy/mainnet.sh`, then `contracts/deploy/verify.sh`
- Demo: `MODE=paper npm run dev`, or a Vercel paper deploy

The testnet explorer shows KeelVault as verified, not a partial match. The gateway rejects verification bodies over about 100KB, which is why the vault no longer imports OpenZeppelin.
