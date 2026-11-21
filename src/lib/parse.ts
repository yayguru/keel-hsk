export type Intent =
  | { type: "help" }
  | { type: "status" }
  | { type: "positions" }
  | { type: "risk" }
  | { type: "check" }
  | { type: "example" }
  | { type: "reset" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "approve" }
  | { type: "reject" }
  | { type: "tighten"; maxQuote?: string; dailyLoss?: string; slippagePct?: string; cooldownSec?: number }
  | { type: "order"; side: "buy" | "sell"; amount: string }
  | { type: "auto"; action: "on" | "off" | "status" | "demo" | "standard"; intervalSec?: number }
  | { type: "unknown"; text: string };

export function parseIntent(raw: string): Intent {
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return { type: "help" };
  if (/^(help|\?|what can you do)$/.test(text)) return { type: "help" };
  if (/^(status|how are we|where are we)$/.test(text)) return { type: "status" };
  if (/^(positions?|pnl|p&l|book)$/.test(text)) return { type: "positions" };
  if (/^(risk|limits)$/.test(text)) return { type: "risk" };
  if (/^(check|check the pool|look at the pool|should we trade|what should we do)$/.test(text)) return { type: "check" };
  if (/^(example|worked example|demo trade)$/.test(text)) return { type: "example" };
  if (/^(reset|reset paper|reset the book)$/.test(text)) return { type: "reset" };
  if (/^(pause|kill|stop trading|kill switch)$/.test(text)) return { type: "pause" };
  if (/^(resume|unpause|start)$/.test(text)) return { type: "resume" };
  if (/^(approve|yes|do it|confirm)$/.test(text)) return { type: "approve" };

  const auto = text.match(/^(?:auto|autopilot)(?: (on|off|status|demo|standard))?(?: (?:every )?([0-9]+)s?)?$/);
  if (auto) {
    const action = (auto[1] ?? (auto[2] ? "on" : "status")) as "on" | "off" | "status" | "demo" | "standard";
    return auto[2] ? { type: "auto", action, intervalSec: Number(auto[2]) } : { type: "auto", action };
  }
  if (/^(reject|no|skip|cancel)$/.test(text)) return { type: "reject" };

  const buy = text.match(/^buy ([0-9]*\.?[0-9]+)(?: usdt)?$/);
  if (buy) return { type: "order", side: "buy", amount: buy[1] };
  const sell = text.match(/^sell ([0-9]*\.?[0-9]+)(?: whsk)?$/);
  if (sell) return { type: "order", side: "sell", amount: sell[1] };

  const tighten: Extract<Intent, { type: "tighten" }> = { type: "tighten" };
  const maxTrade = text.match(/max trade ([0-9]*\.?[0-9]+)/);
  const daily = text.match(/daily loss ([0-9]*\.?[0-9]+)/);
  const slippage = text.match(/slippage ([0-9]*\.?[0-9]+)\s*%?/);
  const cooldown = text.match(/cooldown ([0-9]+)/);
  if (maxTrade) tighten.maxQuote = maxTrade[1];
  if (daily) tighten.dailyLoss = daily[1];
  if (slippage) tighten.slippagePct = slippage[1];
  if (cooldown) tighten.cooldownSec = Number(cooldown[1]);
  if (maxTrade || daily || slippage || cooldown) return tighten;

  return { type: "unknown", text: raw.trim() };
}
