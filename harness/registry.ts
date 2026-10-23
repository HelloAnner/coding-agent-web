import { dshHarness } from "./dsh";
import { grokHarness } from "./grok";
import { piHarness } from "./pi";
import type { HarnessDescriptor } from "./types";

const HARNESSES: HarnessDescriptor[] = [piHarness, dshHarness, grokHarness];

export function listHarnesses(): HarnessDescriptor[] {
  return HARNESSES;
}

export function findHarness(id: string): HarnessDescriptor | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}
