import { NextRequest } from "next/server";
import { chartStore } from "@/lib/chart-store";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

  const base64 = chartStore.get(id);
  if (!base64) return Response.json({ error: "Chart not found" }, { status: 404 });

  return Response.json({ id, base64 });
}
