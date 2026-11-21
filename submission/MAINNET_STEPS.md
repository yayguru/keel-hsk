# Mainnet steps

Done on 21 Nov 2026. The mainnet vault is [`0x8980296BAe193A359937ac873f8E6759C289646d`](https://hsk.blockscout.com/address/0x8980296BAe193A359937ac873f8E6759C289646d), verified, with two Decision swaps. Every hash is in `contracts/deployments/177.json` and in the README. The steps below are how it was done, and how to repeat it with your own wallets.

KeelVault has to be on HSK Chain mainnet, chain id 177, or the entry is out of demo selection. Testnet is for the rehearsal. These steps deploy the same contract with the caps in `contracts/deploy/mainnet.sh`: 5 WHSK per trade, 2 USDT per trade, 1% slippage, 60 second cooldown, 5 USDT daily realized loss, 50 WHSK inventory.

## 1. Make two wallets

Use OKX Wallet. The network parameters are the ones in the [HashKey wallet page](https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Tools/Wallet):

| Field | Value |
| --- | --- |
| Network name | HSKChain |
| RPC | `https://mainnet.hsk.xyz` |
| Chain ID | 177 |
| Symbol | HSK |
| Explorer | `https://hsk.blockscout.com` |

Create two addresses. One is the owner. One is the agent. Write both addresses down. Export the private keys into a local `.env` that is not committed:

```bash
OWNER=0xYourOwnerAddress
AGENT=0xYourAgentAddress
PRIVATE_KEY=0xownerkey
AGENT_PRIVATE_KEY=0xagentkey
```

`PRIVATE_KEY` in the deploy script is the owner key. Keep the agent key only for `npm run dev` later.

A few dollars of HSK is enough. On 20 Nov 2026 the RPC minimum gas price was about 500 gwei, and a deploy of this contract is a couple million gas. Send the owner enough HSK for gas plus the inventory you will wrap. Confirm the withdrawal network is HSK Chain, chain id 177, before you send it from an exchange. HashKey's own wallet docs name OKX Wallet. They do not name a buy button. Use an exchange you already trust that lists HSK and shows chain id 177 on the withdrawal screen.

## 2. Deploy

From a checkout of this repo, with Foundry installed:

```bash
cd contracts
export PRIVATE_KEY=0xownerkey
export AGENT=0xYourAgentAddress
export CONFIRM_MAINNET=yes
./deploy/mainnet.sh
```

The script prints `vault 0x...`. Put that address in `.env` as `VAULT_ADDRESS` and in the BUIDL.

Check it:

```bash
cast call $VAULT_ADDRESS "owner()(address)" --rpc-url https://mainnet.hsk.xyz
cast call $VAULT_ADDRESS "agent()(address)" --rpc-url https://mainnet.hsk.xyz
```

Owner and agent must match the two addresses above.

Verify with the same script that verified the testnet vault. From `contracts/`:

```bash
export CHAIN_ID=177
export ADDRESS=$VAULT_ADDRESS
export EXPLORER=https://hsk.blockscout.com
export CREATION_TX=0xTheDeployTxPrintedAbove
export OWNER=0xYourOwnerAddress
export AGENT=0xYourAgentAddress
export ROUTER=0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3
export POOL=0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC
export QUOTE=0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029
export MAX_IN_0=5000000000000000000
export MAX_IN_1=2000000
export SLIPPAGE_BPS=100
export COOLDOWN=60
export DAILY_LOSS=5000000
export MAX_BASE=50000000000000000000
./deploy/verify.sh
```

The script sends the standard JSON to Sourcify and to `POST /api/v2/smart-contracts/$ADDRESS/verification/via/standard-input`. The file field must be `files[0]`. Sourcify must print `exact_match`. Reload `https://hsk.blockscout.com/address/$ADDRESS`. The contract should say verified, and not partially verified.

The explorer gateway returns HTTP 413 above about 100KB. This build is about 19KB. Do not add the OpenZeppelin sources back into the vault, or the upload will be rejected the way the first testnet deploy was. For testnet the same script uses `CHAIN_ID=133` and `EXPLORER=https://testnet-explorer.hskchain.net`. Mainnet’s explorer also lists `standard-input` and compiler 0.8.26.

## 3. Fund the vault

The pool spends WHSK and USDT, not raw HSK. Wrap a small amount, then send both tokens to the vault. Five WHSK and a few USDT is enough for the caps above.

WHSK is `0xB210D2120d57b758EE163cFfb43e73728c471Cf1`. It has `deposit()`. USDT is `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` (6 decimals). You can also call the vault as the owner:

```bash
cast send $VAULT_ADDRESS "wrap()" --value 5ether --private-key $PRIVATE_KEY --rpc-url https://mainnet.hsk.xyz
```

That wraps 5 HSK into WHSK held by the vault. Get USDT from the same pool or from your exchange, then:

```bash
cast send 0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029 \
  "transfer(address,uint256)" $VAULT_ADDRESS 5000000 \
  --private-key $PRIVATE_KEY --rpc-url https://mainnet.hsk.xyz
```

`5000000` is 5 USDT. The agent still cannot move more than 2 USDT in one trade, and a realized loss of 5 USDT stops further buys for the day.

## 4. Run the desk

Paper mode reads mainnet prices and does not spend. Use it for the recording.

```bash
MODE=paper npm run dev
```

When you are ready to send capped mainnet swaps from the same desk, stop the server, set the keys, and start again. Delete `data/desk.json` first so the book matches the new mode.

```bash
rm -f data/desk.json
```

`.env`:

```bash
MODE=mainnet
VAULT_ADDRESS=0xYourVault
AGENT_PRIVATE_KEY=0xagentkey
OWNER_PRIVATE_KEY=0xownerkey
LLM_API_KEY=
```

```bash
npm run dev
```

In the chat: `sell 5`, then `approve`. That is how the vault got its first USDT on 21 Nov 2026, with no exchange: 5 WHSK came back as 0.404297 USDT. After the 60 second cooldown, `buy 0.3`, then `approve`. A buy of up to 2 USDT is inside the cap once the vault holds that much USDT. The vault computes the minimum from spot and reverts if the quote is worse than 1%. The transcript prints the transaction hash. Open it on `https://hsk.blockscout.com/tx/<hash>` and confirm a `Decision` event.

`pause` and `max trade 1` in this mode are owner transactions. `max trade 3` is refused because 3 is looser than 2.

## 4b. Autonomous mode

With the same `.env`, type `auto on 60` in the chat. Every minute the agent reads the pool, the vault and APRO, decides, and sends the swap itself through the vault. `auto off` stops it. `pause` stops it and freezes the vault on chain. The loop turns itself off under 0.15 HSK of agent gas and after three failures in a row. Keep the agent topped up with about 1 HSK. Each swap costs about 0.09 HSK at 500 gwei.

The run on 21 Nov 2026 used `auto on 20` and made three autonomous sells. They are listed in the README and in `contracts/deployments/177.json`.

## 5. Paste into the BUIDL

- Title, one-liner, description, track, and stack: `submission/BUIDL.md`
- Mainnet vault address: `0x8980296BAe193A359937ac873f8E6759C289646d`, https://hsk.blockscout.com/address/0x8980296BAe193A359937ac873f8E6759C289646d
- The deploy transaction: https://hsk.blockscout.com/tx/0x386afa2dba142422438d44f847c61c74a926812e4e67c8df19688736a7ca05f4
- The autonomous swaps: https://hsk.blockscout.com/tx/0xb45adddf2c93bc020a27c65bb6d039102e8d77234d2283ba96a726f24449aa4a, https://hsk.blockscout.com/tx/0x28cf10c5ad83b81a0a23d3263c24453d5b225969dd18fd4a077093de09c9f9ca, https://hsk.blockscout.com/tx/0x7dbf7c2b78cb1e723e56a7cd0c63ac7e0302efd633a43979da6dac7eb6474d72
- The manual Decision swaps: https://hsk.blockscout.com/tx/0x3be3acda6b866ea83bb81c8cc533a45646af2fbaa737cbc704f9fd2667b9f702 and https://hsk.blockscout.com/tx/0x2d86b4e5a9f5e6090fc1a08827c33a965cf045208dab8b70ced2d84af3b3d26b
- Repository URL: https://github.com/yayguru/keel-hsk
- Demo video, using `submission/DEMO_SCRIPT.md`

Kill switch, if you need it:

```bash
cast send $VAULT_ADDRESS "setPaused(bool)" true \
  --private-key $PRIVATE_KEY --rpc-url https://mainnet.hsk.xyz
cast send $VAULT_ADDRESS "withdraw(address,address,uint256)" \
  0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029 $OWNER 5000000 \
  --private-key $PRIVATE_KEY --rpc-url https://mainnet.hsk.xyz
```

Adjust the withdraw amount to the real balance. The agent key cannot call either function.
