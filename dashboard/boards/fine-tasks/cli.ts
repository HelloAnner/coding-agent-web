import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function meegle(command: string[], params: Record<string, unknown> = {}): Promise<unknown> {
  const { stdout } = await execute(process.env.MEEGLE_BIN || "meegle", [
    ...command, "--params", JSON.stringify(params), "--envelope",
  ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const response = JSON.parse(stdout);
  if (response.error) throw new Error("Meegle 返回错误，请检查 CLI 登录状态和权限");
  return response.data;
}
