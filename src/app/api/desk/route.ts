import { handleMessage } from "@/lib/desk";
import { readMarket } from "@/lib/market";
import { chainActions, ensureLoop, serialize } from "@/lib/runner";
import { loadDesk, saveDesk } from "@/lib/store";
import { toView } from "@/lib/view";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureLoop();
  return NextResponse.json(toView(loadDesk(), Math.floor(Date.now() / 1000)));
}

export async function POST(request: Request) {
  ensureLoop();
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim();
  if (!message) return NextResponse.json({ error: "Message is empty." }, { status: 400 });
  const desk = await serialize(async () => {
    const working = structuredClone(loadDesk());
    const now = Math.floor(Date.now() / 1000);
    await handleMessage(working, message, now, () => readMarket(working.chain), chainActions(working));
    saveDesk(working);
    return working;
  });
  return NextResponse.json(toView(desk, Math.floor(Date.now() / 1000)));
}
