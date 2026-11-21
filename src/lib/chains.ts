export type ChainName = "mainnet" | "testnet";

export type ChainConfig = {
  name: ChainName;
  label: string;
  id: number;
  rpc: string;
  explorer: string;
  base: `0x${string}`;
  quote: `0x${string}`;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  token0IsBase: boolean;
  router: `0x${string}`;
  quoter: `0x${string}`;
  factory: `0x${string}`;
  pool: `0x${string}`;
  fee: number;
  oracle: `0x${string}` | null;
};

/**
 * Sources, all re-read on 20 Nov 2026:
 * - Network, chain id, RPC, explorer: https://docs.hskchain.net/docs/Build-on-HashKey-Chain/network-info
 * - Mainnet WHSK and USDT: https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Token-Contracts
 * - HSKSwap router, quoter, factory: @hskswap/sdk-core@1.0.3 HASHKEY_*_ADDRESSES
 * - Pools: factory.getPool on the official RPC
 * - APRO HSK/USD: docs list a 38-hex string. The 40-hex address below answers description() = "HSK/USD".
 *   Testnet has no HSK/USD feed in the docs.
 * - Testnet USDT is the token0 of the HSKSwap 0.3% pool with WHSK. It is not on the docs token page.
 */
export const CHAINS: Record<ChainName, ChainConfig> = {
  mainnet: {
    name: "mainnet",
    label: "HSK Chain",
    id: 177,
    rpc: "https://mainnet.hsk.xyz",
    explorer: "https://hsk.blockscout.com",
    base: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
    quote: "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029",
    baseSymbol: "WHSK",
    quoteSymbol: "USDT",
    baseDecimals: 18,
    quoteDecimals: 6,
    token0IsBase: true,
    router: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
    quoter: "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD",
    factory: "0x972cA9D1662F5e029cD18327D29026532E84c742",
    pool: "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC",
    fee: 3000,
    oracle: "0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b",
  },
  testnet: {
    name: "testnet",
    label: "HSK Chain testnet",
    id: 133,
    rpc: "https://testnet.hsk.xyz",
    explorer: "https://testnet-explorer.hskchain.net",
    base: "0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6",
    quote: "0x98B6173A8B7DFc52ce8bc88f1184a918A1CCaa4F",
    baseSymbol: "WHSK",
    quoteSymbol: "USDT",
    baseDecimals: 18,
    quoteDecimals: 18,
    token0IsBase: false,
    router: "0xa6914E66690c6794244B5f66a09eAEbf66254237",
    quoter: "0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC",
    factory: "0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0",
    pool: "0xc076FB478b77633736738579c7f48D2539604a50",
    fee: 3000,
    oracle: null,
  },
};

export function explorerAddress(chain: ChainConfig, address: string): string {
  return `${chain.explorer}/address/${address}`;
}

export function explorerTx(chain: ChainConfig, hash: string): string {
  return `${chain.explorer}/tx/${hash}`;
}

export type DeskMode = "paper" | "testnet" | "mainnet";

export function runtimeMode(): DeskMode {
  if (process.env.MODE === "testnet") return "testnet";
  if (process.env.MODE === "mainnet") return "mainnet";
  return "paper";
}

export function activeChain(): ChainConfig {
  return runtimeMode() === "testnet" ? CHAINS.testnet : CHAINS.mainnet;
}
