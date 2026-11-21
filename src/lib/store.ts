import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activeChain, runtimeMode } from "./chains";
import { freshDesk, type Desk, type Fill, type Proposal } from "./desk";
import type { Book, Policy } from "./paper";

const file = path.join(process.cwd(), "data", "desk.json");

type JsonDesk = Omit<Desk, "book" | "policy" | "proposal" | "fills"> & {
  book: BookJson;
  policy: PolicyJson;
  proposal: ProposalJson | null;
  fills: FillJson[];
};

type BookJson = Omit<Book, "quote" | "base" | "cost" | "realized" | "dayLoss"> & {
  quote: string;
  base: string;
  cost: string;
  realized: string;
  dayLoss: string;
};
type PolicyJson = Omit<Policy, "maxQuoteIn" | "maxBaseIn" | "dailyLoss" | "maxBase"> & {
  maxQuoteIn: string;
  maxBaseIn: string;
  dailyLoss: string;
  maxBase: string;
};
type ProposalJson = Omit<Proposal, "amountIn" | "sqrtPriceX96"> & { amountIn: string; sqrtPriceX96: string };
type FillJson = Omit<Fill, "amountIn" | "amountOut"> & { amountIn: string; amountOut: string };

let memory: Desk | null = null;

export function loadDesk(): Desk {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as JsonDesk;
    memory = parsed.mode === runtimeMode() ? hydrate(parsed) : freshDesk(activeChain(), Math.floor(Date.now() / 1000), runtimeMode());
  } catch {
    memory = freshDesk(activeChain(), Math.floor(Date.now() / 1000), runtimeMode());
    saveDesk(memory);
  }
  return memory;
}

export function saveDesk(desk: Desk): void {
  memory = desk;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(dehydrate(desk), null, 2));
}

export function resetMemory(): void {
  memory = null;
}

function dehydrate(desk: Desk): JsonDesk {
  return {
    ...desk,
    book: {
      ...desk.book,
      quote: desk.book.quote.toString(),
      base: desk.book.base.toString(),
      cost: desk.book.cost.toString(),
      realized: desk.book.realized.toString(),
      dayLoss: desk.book.dayLoss.toString(),
    },
    policy: {
      ...desk.policy,
      maxQuoteIn: desk.policy.maxQuoteIn.toString(),
      maxBaseIn: desk.policy.maxBaseIn.toString(),
      dailyLoss: desk.policy.dailyLoss.toString(),
      maxBase: desk.policy.maxBase.toString(),
    },
    proposal: desk.proposal
      ? { ...desk.proposal, amountIn: desk.proposal.amountIn.toString(), sqrtPriceX96: desk.proposal.sqrtPriceX96.toString() }
      : null,
    fills: desk.fills.map((fill) => ({ ...fill, amountIn: fill.amountIn.toString(), amountOut: fill.amountOut.toString() })),
  };
}

function hydrate(value: JsonDesk): Desk {
  return {
    ...value,
    book: {
      ...value.book,
      quote: BigInt(value.book.quote),
      base: BigInt(value.book.base),
      cost: BigInt(value.book.cost),
      realized: BigInt(value.book.realized),
      dayLoss: BigInt(value.book.dayLoss),
    },
    policy: {
      ...value.policy,
      maxQuoteIn: BigInt(value.policy.maxQuoteIn),
      maxBaseIn: BigInt(value.policy.maxBaseIn),
      dailyLoss: BigInt(value.policy.dailyLoss),
      maxBase: BigInt(value.policy.maxBase),
    },
    proposal: value.proposal
      ? { ...value.proposal, amountIn: BigInt(value.proposal.amountIn), sqrtPriceX96: BigInt(value.proposal.sqrtPriceX96) }
      : null,
    fills: value.fills.map((fill) => ({ ...fill, amountIn: BigInt(fill.amountIn), amountOut: BigInt(fill.amountOut) })),
  };
}
