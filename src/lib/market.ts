import { createPublicClient, http, parseAbi } from "viem";
import type { ChainConfig } from "./chains";
import { humanQuotePerBase } from "./units";

const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);

const oracleAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

export type Market = {
  price: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  oraclePrice: number | null;
  oracleAgeSec: number | null;
  blockTime: number;
};

export function clientFor(chain: ChainConfig) {
  return createPublicClient({ transport: http(chain.rpc) });
}

export async function readMarket(chain: ChainConfig): Promise<Market> {
  const client = clientFor(chain);
  const [slot, liquidity, block] = await Promise.all([
    client.readContract({ address: chain.pool, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: chain.pool, abi: poolAbi, functionName: "liquidity" }),
    client.getBlock(),
  ]);
  const sqrtPriceX96 = slot[0];
  const price = humanQuotePerBase(sqrtPriceX96, chain.token0IsBase, chain.baseDecimals, chain.quoteDecimals);
  let oraclePrice: number | null = null;
  let oracleAgeSec: number | null = null;
  if (chain.oracle) {
    try {
      const [round, decimals] = await Promise.all([
        client.readContract({ address: chain.oracle, abi: oracleAbi, functionName: "latestRoundData" }),
        client.readContract({ address: chain.oracle, abi: oracleAbi, functionName: "decimals" }),
      ]);
      const updatedAt = Number(round[3]);
      oraclePrice = Number(round[1]) / 10 ** Number(decimals);
      oracleAgeSec = Number(block.timestamp) - updatedAt;
    } catch {
      oraclePrice = null;
      oracleAgeSec = null;
    }
  }
  return {
    price,
    sqrtPriceX96,
    liquidity,
    oraclePrice,
    oracleAgeSec,
    blockTime: Number(block.timestamp),
  };
}
