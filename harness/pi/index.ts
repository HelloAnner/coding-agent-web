import { homedir } from "node:os";
import path from "node:path";
import type { HarnessDescriptor } from "../types";

/** pi keeps models, auth and sessions under this directory. */
export function piConfigDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return path.join(homedir(), configured.slice(2));
  return configured;
}

export const piHarness: HarnessDescriptor = {
  id: "pi",
  label: "pi",
  configDir: piConfigDir,
};
