import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getSessionUiStateRevision } from "@/lib/session-ui-state";
import { catalogListVersion } from "@/lib/catalog-db";
import { dshRunningIds } from "@/harness/dsh/runtime";
import { claudeAwaitingInputIds, claudeRunningIds } from "@/harness/claude-code/runtime";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
function readCatalogListVersion(): number {
  try {
    return catalogListVersion();
  } catch {
    return 0;
  }
}

export async function GET() {
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      catalogListVersion: readCatalogListVersion(),
      runningSessionIds: [...getRunningRpcSessionIds(), ...claudeRunningIds(), ...dshRunningIds()],
      awaitingInputSessionIds: [...getAwaitingInputRpcSessionIds(), ...claudeAwaitingInputIds()],
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      sessionUiStateRevision: getSessionUiStateRevision(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
