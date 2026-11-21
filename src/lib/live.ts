import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, parseAbi, stringToHex, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "./chains";
import type { Proposal } from "./desk";
import type { Policy } from "./paper";
import { slippageFloor, spotOut } from "./units";

const vaultAbi = parseAbi([
  "function swap(address tokenIn, uint256 amountIn, uint256 amountOutMin, uint256 deadline, bytes32 decisionId, bool stopOut, bytes reason) returns (uint256 amountOut)",
  "function setPaused(bool next)",
  "function tighten((bool hasMax0, uint256 maxAmountIn0, bool hasMax1, uint256 maxAmountIn1, bool hasSlippage, uint16 slippageBps, bool hasCooldown, uint32 cooldown, bool hasDaily, uint256 dailyLossLimit, bool hasMaxBase, uint256 maxBase) patch)",
  "function token0() view returns (address)",
  "event Decision(bytes32 indexed decisionId, address indexed tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 amountOut, uint256 dayRealizedLoss, uint256 baseQty, uint256 quoteCost, bool stopOut, bytes reason)",
]);

function accountFrom(name: "AGENT_PRIVATE_KEY" | "OWNER_PRIVATE_KEY") {
  const key = process.env[name];
  if (!key) return null;
  return privateKeyToAccount(key as `0x${string}`);
}

function chainOf(config: ChainConfig) {
  return {
    id: config.id,
    name: config.label,
    nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
    rpcUrls: { default: { http: [config.rpc] } },
  } as const;
}

export function vaultAddress(): `0x${string}` | null {
  const value = process.env.VAULT_ADDRESS;
  return value ? (value as `0x${string}`) : null;
}

export async function executeProposal(config: ChainConfig, proposal: Proposal): Promise<{ txHash: `0x${string}`; amountOut: bigint } | { error: string }> {
  const vault = vaultAddress();
  const account = accountFrom("AGENT_PRIVATE_KEY");
  if (!vault || !account) return { error: "Testnet execution needs VAULT_ADDRESS and AGENT_PRIVATE_KEY." };
  const tokenIn = proposal.side === "buy" ? config.quote : config.base;
  const spot = spotOut(proposal.amountIn, proposal.zeroForOne, proposal.sqrtPriceX96, proposal.fee);
  const amountOutMin = slippageFloor(spot, proposal.slippageBps);
  if (amountOutMin === 0n) return { error: "Spot floor rounded to zero." };
  const reason = stringToHex(proposal.reason.slice(0, 160));
  const decisionId = keccak256(toBytes(proposal.id));
  try {
    const wallet = createWalletClient({ account, chain: chainOf(config), transport: http(config.rpc) });
    const publicClient = createPublicClient({ chain: chainOf(config), transport: http(config.rpc) });
    const hash = await wallet.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "swap",
      args: [tokenIn, proposal.amountIn, amountOutMin, BigInt(proposal.expiresAt), decisionId, proposal.stop, reason],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return { error: `Swap reverted. Tx ${hash}.` };
    let amountOut = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: vaultAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === "Decision") amountOut = decoded.args.amountOut;
      } catch {
        // not our event
      }
    }
    return { txHash: hash, amountOut };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Swap failed." };
  }
}

export async function tightenVault(config: ChainConfig, before: Policy, after: Policy): Promise<{ txHash: `0x${string}` } | { error: string }> {
  const vault = vaultAddress();
  const account = accountFrom("OWNER_PRIVATE_KEY");
  if (!vault || !account) return { error: "Tightening on chain needs VAULT_ADDRESS and OWNER_PRIVATE_KEY." };
  const quoteOn0 = !config.token0IsBase;
  const patch = {
    hasMax0: false,
    maxAmountIn0: 0n,
    hasMax1: false,
    maxAmountIn1: 0n,
    hasSlippage: after.slippageBps !== before.slippageBps,
    slippageBps: after.slippageBps,
    hasCooldown: after.cooldownSec !== before.cooldownSec,
    cooldown: after.cooldownSec,
    hasDaily: after.dailyLoss !== before.dailyLoss,
    dailyLossLimit: after.dailyLoss,
    hasMaxBase: after.maxBase !== before.maxBase,
    maxBase: after.maxBase,
  };
  if (after.maxQuoteIn !== before.maxQuoteIn) {
    if (quoteOn0) {
      patch.hasMax0 = true;
      patch.maxAmountIn0 = after.maxQuoteIn;
    } else {
      patch.hasMax1 = true;
      patch.maxAmountIn1 = after.maxQuoteIn;
    }
  }
  if (after.maxBaseIn !== before.maxBaseIn) {
    if (quoteOn0) {
      patch.hasMax1 = true;
      patch.maxAmountIn1 = after.maxBaseIn;
    } else {
      patch.hasMax0 = true;
      patch.maxAmountIn0 = after.maxBaseIn;
    }
  }
  try {
    const wallet = createWalletClient({ account, chain: chainOf(config), transport: http(config.rpc) });
    const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "tighten", args: [patch] });
    const publicClient = createPublicClient({ chain: chainOf(config), transport: http(config.rpc) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return { error: `Tighten reverted. Tx ${hash}.` };
    return { txHash: hash };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Tighten failed." };
  }
}

export async function pauseVault(config: ChainConfig, paused: boolean): Promise<{ txHash: `0x${string}` } | { error: string }> {
  const vault = vaultAddress();
  const account = accountFrom("OWNER_PRIVATE_KEY");
  if (!vault || !account) return { error: "Pause on chain needs VAULT_ADDRESS and OWNER_PRIVATE_KEY." };
  try {
    const wallet = createWalletClient({ account, chain: chainOf(config), transport: http(config.rpc) });
    const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "setPaused", args: [paused] });
    const publicClient = createPublicClient({ chain: chainOf(config), transport: http(config.rpc) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return { error: `Pause reverted. Tx ${hash}.` };
    return { txHash: hash };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Pause failed." };
  }
}
