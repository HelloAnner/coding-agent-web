import { dshHarness } from "./dsh";
import { piHarness } from "./pi";
import type { HarnessDescriptor } from "./types";

const HARNESSES: HarnessDescriptor[] = [piHarness, dshHarness];

export function listHarnesses(): HarnessDescriptor[] {
  return HARNESSES;
}

export function findHarness(id: string): HarnessDescriptor | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}
