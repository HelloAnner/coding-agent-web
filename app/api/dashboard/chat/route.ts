import { mkdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { DASHBOARD_BOARDS, dashboardBoardForId } from "@/dashboard/boards";
import { allowFileRoot } from "@/lib/file-access";

export const dynamic = "force-dynamic";

/**
 * The folder a board's right-hand chat runs in: the board's `dataDir` under the
 * project root. The folder is created on first use, so a new board's chat works
 * before anyone writes data by hand.
 */
export async function GET(req: Request) {
  const board = dashboardBoardForId(new URL(req.url).searchParams.get("board"));
  const cwd = path.join(process.cwd(), board.dataDir);
  try {
    await mkdir(cwd, { recursive: true });
    // The chat's folder preference and file reads go through /api/files.
    allowFileRoot(cwd);
  } catch (error) {
    return NextResponse.json({
      error: `看板数据目录不可用：${error instanceof Error ? error.message : String(error)}`,
    }, { status: 500 });
  }
  return NextResponse.json({
    board: board.id,
    label: board.label,
    cwd,
    boards: DASHBOARD_BOARDS.map((item) => item.id),
  }, { headers: { "Cache-Control": "no-store" } });
}
