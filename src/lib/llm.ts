import type { Decision } from "./strategy";

export type Narration = { act: "take" | "skip" | "shrink"; note: string };

export function fallbackNarration(decision: Decision): Narration {
  if (decision.action === "hold") return { act: "take", note: decision.reason };
  if (decision.stop) return { act: "take", note: `${decision.reason} The model is not asked about a stop.` };
  return { act: "take", note: `${decision.reason} No model key is set, so this note is the rule itself.` };
}

export async function narrate(decision: Decision): Promise<Narration> {
  if (decision.action === "hold" || decision.stop) return fallbackNarration(decision);
  const key = process.env.LLM_API_KEY;
  if (!key) return fallbackNarration(decision);

  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You explain one WHSK/USDT decision. Reply with JSON only: {\"act\":\"take\"|\"skip\"|\"shrink\",\"note\":\"one or two sentences\"}. You cannot change the side, raise the size, or block a stop. skip means do not send the proposal. shrink means use half the size.",
          },
          { role: "user", content: decision.reason },
        ],
      }),
    });
    if (!response.ok) return fallbackNarration(decision);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return fallbackNarration(decision);
    const parsed = JSON.parse(match[0]) as { act?: string; note?: string };
    const act = parsed.act === "skip" || parsed.act === "shrink" ? parsed.act : "take";
    const note = typeof parsed.note === "string" && parsed.note.trim() ? parsed.note.trim() : decision.reason;
    return { act, note };
  } catch {
    return fallbackNarration(decision);
  } finally {
    clearTimeout(timer);
  }
}
