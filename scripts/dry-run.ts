import { CHAINS } from "../src/lib/chains";
import { freshDesk, handleMessage } from "../src/lib/desk";
import { readMarket } from "../src/lib/market";

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const desk = freshDesk(CHAINS.mainnet, now);
  await handleMessage(desk, "worked example", now, null, {});
  await handleMessage(desk, "approve", now + 1, null, {});

  for (const message of desk.messages) {
    console.log(`\n[${message.role}]`);
    console.log(message.text);
  }

  if (!desk.fills.length || desk.book.base === 0n) {
    console.error("\nDry run did not fill.");
    process.exit(1);
  }

  try {
    const market = await readMarket(CHAINS.mainnet);
    console.log(
      `\nLive mainnet read: ${market.price.toFixed(5)} USDT/WHSK. APRO ${market.oraclePrice ?? "none"} age ${market.oracleAgeSec ?? "n/a"}s. Liquidity ${market.liquidity}.`,
    );
  } catch (error) {
    console.log(`\nLive mainnet read failed: ${error instanceof Error ? error.message : "unknown"}`);
  }

  console.log("\nDry run filled in the paper book. No transaction was sent.");
}

main();
