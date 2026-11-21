import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS } from "../src/lib/chains";
import { executeProposal } from "../src/lib/live";
import { readMarket } from "../src/lib/market";

const chain = CHAINS.testnet;
const vaultAbi = parseAbi([
  "function baseToken() view returns (address)",
  "function wrap() payable",
  "function risk() view returns (bool paused, uint32 dayId, uint256 dayRealizedLoss, uint256 baseQty, uint256 quoteCost, uint256 cooldownRemaining, uint256 quoteBalance, uint256 baseBalance, (uint256,uint256,uint16,uint32,uint256,uint256) policy)",
]);

async function main() {
  const vault = process.env.VAULT_ADDRESS as `0x${string}` | undefined;
  const agentKey = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
  const ownerKey = process.env.OWNER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!vault || !agentKey || !ownerKey) {
    console.log("Skipped. Set VAULT_ADDRESS, OWNER_PRIVATE_KEY, and AGENT_PRIVATE_KEY to send a testnet swap.");
    return;
  }

  const publicClient = createPublicClient({ transport: http(chain.rpc) });
  const id = await publicClient.getChainId();
  if (id !== chain.id) throw new Error(`RPC chain id ${id}, expected ${chain.id}.`);

  const hsk = defineChain({
    id: chain.id,
    name: chain.label,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [chain.rpc] } },
  });
  const owner = privateKeyToAccount(ownerKey);
  const ownerWallet = createWalletClient({ account: owner, chain: hsk, transport: http(chain.rpc) });
  const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  let base = await publicClient.readContract({ address: chain.base, abi: erc20, functionName: "balanceOf", args: [vault] });
  const sellAmount = 1_000_000_000_000_000n;
  if (base < sellAmount) {
    const hash = await ownerWallet.writeContract({ address: vault, abi: vaultAbi, functionName: "wrap", value: sellAmount });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`wrap failed ${hash}`);
    base = await publicClient.readContract({ address: chain.base, abi: erc20, functionName: "balanceOf", args: [vault] });
    console.log(`Wrapped ${sellAmount} wei of HSK. Vault WHSK ${base}. Tx ${hash}`);
  }

  const market = await readMarket(chain);
  const result = await executeProposal(chain, {
    id: `testnet-${Date.now()}`,
    side: "sell",
    stop: true,
    amountIn: sellAmount,
    sqrtPriceX96: market.sqrtPriceX96,
    zeroForOne: false,
    fee: chain.fee,
    slippageBps: 100,
    price: market.price,
    reason: "Testnet proof: sell 0.001 WHSK through the vault.",
    source: "pool",
    expiresAt: Math.floor(Date.now() / 1000) + 180,
  });
  if ("error" in result) throw new Error(result.error);
  console.log(`Guarded swap tx ${result.txHash}`);
  console.log(`${chain.explorer}/tx/${result.txHash}`);
  console.log(`amountOut raw ${result.amountOut}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
