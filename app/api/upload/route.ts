import { NextRequest } from "next/server";
import { parseCSV, schemaToDescription } from "@/lib/parse-csv";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File;
  if (!file) return Response.json({ error: "No file" }, { status: 400 });

  if (file.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is 10 MB.` },
      { status: 413 },
    );
  }

  if (!file.name.endsWith(".csv")) {
    return Response.json({ error: "Only CSV files are supported." }, { status: 400 });
  }

  const csvText = await file.text();
  console.log("[upload] File received:", file.name, "size:", csvText.length);
  const schema = parseCSV(csvText);
  const schemaDescription = schemaToDescription(schema);
  console.log("[upload] Parsed schema:", schemaDescription);

  const fileName = file.name.replace(/\.csv$/i, "");

  return Response.json({
    csvText,
    schemaDescription,
    datasetName: fileName,
    schema,
  });
}
