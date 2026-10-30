import { getHealth } from "@/dashboard/boards/father-health/api";

export async function GET() {
  return getHealth();
}
