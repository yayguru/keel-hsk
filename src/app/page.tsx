"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { DeskView } from "@/lib/view";
import { useEffect, useRef, useState } from "react";

const PROMPTS = ["check the pool", "worked example", "status", "risk", "max trade 1"];

export default function HomePage() {
  const [desk, setDesk] = useState<DeskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/desk")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Desk returned ${response.status}`);
        return (await response.json()) as DeskView;
      })
      .then((view) => {
        if (!cancelled) setDesk(view);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the desk.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [desk?.messages.length, desk?.proposal?.id]);

  async function send(message: string) {
    const text = message.trim();
    if (!text || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/desk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const body = (await response.json()) as DeskView & { error?: string };
      if (!response.ok) throw new Error(body.error || `Desk returned ${response.status}`);
      setDesk(body);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message did not go through.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <a className="skip-link" href="#transcript">
        Skip to the transcript
      </a>
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="mr-auto">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">HSK Chain · HSKSwap</p>
            <h1 className="text-lg font-semibold">Keel</h1>
          </div>
          {desk ? (
            <>
              <Badge variant="outline">{desk.mode === "paper" ? "Paper" : desk.mode === "testnet" ? "Testnet" : "Mainnet"}</Badge>
              <Badge variant="outline">Chain {desk.chainId}</Badge>
              <Badge variant={desk.paused ? "destructive" : "secondary"}>{desk.paused ? "Paused" : "Open"}</Badge>
            </>
          ) : null}
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex h-[70vh] flex-col px-4 py-4 lg:h-[calc(100dvh-4.5rem)]" aria-labelledby="talk-heading">
          <h2 id="talk-heading" className="text-sm font-medium">
            Talk to the agent
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            It reads the {desk?.pair ?? "WHSK/USDT 0.30%"} pool, explains the rule, and waits for approve. The vault is the only thing that can swap.
          </p>
          {error ? (
            <Alert variant="destructive" className="mt-3">
              <AlertTitle>Desk error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div id="transcript" ref={logRef} tabIndex={-1} role="log" aria-live="polite" aria-relevant="additions" className="mt-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {!desk ? <p className="text-sm text-muted-foreground">Loading the book.</p> : null}
            {desk?.messages.map((message) => (
              <article key={message.id} className="max-w-prose">
                <p className="text-xs text-muted-foreground">{message.role === "agent" ? "Keel" : "You"}</p>
                <p className="whitespace-pre-wrap text-sm">{message.text}</p>
              </article>
            ))}
          </div>
          {desk?.proposal ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
              <p className="mr-auto text-sm">{desk.proposal.text}</p>
              <Button type="button" disabled={pending} onClick={() => send("approve")}>
                Approve
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => send("reject")}>
                Reject
              </Button>
            </div>
          ) : null}
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <label htmlFor="message" className="text-sm font-medium">
              Message
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="message"
                name="message"
                value={draft}
                placeholder="check the pool"
                autoComplete="off"
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button type="submit" disabled={pending || draft.trim() === ""}>
                {pending ? "Sending" : "Send"}
              </Button>
            </div>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {PROMPTS.map((prompt) => (
              <Button key={prompt} type="button" variant="outline" size="sm" disabled={pending} onClick={() => void send(prompt)}>
                {prompt}
              </Button>
            ))}
          </div>
        </section>
        <aside className="border-t px-4 py-4 lg:h-[calc(100dvh-4.5rem)] lg:overflow-y-auto lg:border-t-0 lg:border-l" aria-label="Book">
          <h2 className="text-sm font-medium">Book</h2>
          {desk ? (
            <dl className="mt-3 grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2 text-sm tabular-nums">
              <Row label="Pool" value={desk.price} />
              <Row label="Quote" value={desk.quote} />
              <Row label="Base" value={desk.base} />
              <Row label="Realized" value={desk.realized} />
              <Row label="Unrealized" value={desk.unrealized} />
              <Row label="Day loss" value={desk.dayLoss} />
              <Row label="Max trade" value={desk.maxTrade} />
              <Row label="Slippage" value={desk.slippage} />
              <Row label="Cooldown" value={desk.cooldown} />
              <Row label="Inventory cap" value={desk.inventory} />
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Waiting for the book.</p>
          )}
          <Separator className="my-4" />
          <h2 className="text-sm font-medium">Fills</h2>
          {desk && desk.fills.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No fills yet.</p> : null}
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {desk?.fills.map((fill) => (
              <li key={fill.id}>
                {fill.href ? (
                  <a className="underline" href={fill.href}>
                    {fill.text}
                  </a>
                ) : (
                  fill.text
                )}
              </li>
            ))}
          </ul>
          {desk ? (
            <p className="mt-4 text-xs text-muted-foreground">
              <a className="underline" href={desk.poolUrl}>
                Pool
              </a>
              {" · "}
              <a className="underline" href={desk.routerUrl}>
                Router
              </a>
            </p>
          ) : null}
        </aside>
      </main>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
