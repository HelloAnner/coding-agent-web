import { getHealthAttachment } from "@/dashboard/boards/father-health/api";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return getHealthAttachment((await params).id);
}
