import { NextResponse } from "next/server";
import { taskSnapshot } from "./sync";

export async function getTasks() {
  return NextResponse.json(taskSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
