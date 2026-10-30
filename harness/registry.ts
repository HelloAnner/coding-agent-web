import { claudeCodeHarness } from "./claude-code";
import { dshHarness } from "./dsh";
import { grokHarness } from "./grok";
import { piHarness } from "./pi";
import { ompHarness } from "./omp";
import type { HarnessDescriptor } from "./types";

const HARNESSES: HarnessDescriptor[] = [piHarness, ompHarness, dshHarness, grokHarness, claudeCodeHarness];

export function listHarnesses(): HarnessDescriptor[] {
  return HARNESSES;
}

export function findHarness(id: string): HarnessDescriptor | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}
