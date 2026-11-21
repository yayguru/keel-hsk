import { runtimeMode } from "@/lib/chains";
import { handleMessage, type Desk } from "@/lib/desk";
import { executeProposal, pauseVault, tightenVault, vaultAddress } from "@/lib/live";
import { readMarket } from "@/lib/market";
import { loadDesk, saveDesk } from "@/lib/store";
import { toView } from "@/lib/view";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function clone(desk: Desk): Desk {
  return structuredClone(desk);
}

function actions(desk: Desk) {
  if (runtimeMode() === "paper" || !vaultAddress()) return {};
  return {
    execute: (proposal: Parameters<typeof executeProposal>[1]) => executeProposal(desk.chain, proposal),
    tighten: (next: Desk["policy"]) => tightenVault(desk.chain, desk.policy, next),
    setPaused: (paused: boolean) => pauseVault(desk.chain, paused),
  };
}

export async function GET() {
  const desk = loadDesk();
  return NextResponse.json(toView(desk));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message?.trim();
  if (!message) return NextResponse.json({ error: "Message is empty." }, { status: 400 });
  const desk = clone(loadDesk());
  const now = Math.floor(Date.now() / 1000);
  await handleMessage(
    desk,
    message,
    now,
    async () => readMarket(desk.chain),
    actions(desk),
  );
  saveDesk(desk);
  return NextResponse.json(toView(desk));
}
