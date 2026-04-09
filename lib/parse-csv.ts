import Papa from "papaparse";

export interface CSVSchema {
  columns: { name: string; type: "number" | "string" }[];
  rowCount: number;
  preview: Record<string, string>[];
}

export function parseCSV(csvText: string): CSVSchema {
  const result = Papa.parse(csvText, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
  });

  const rows = result.data as Record<string, unknown>[];
  const columns = result.meta.fields!.map((name) => {
    const sample = rows.slice(0, 10).map((r) => r[name]);
    const type = inferType(sample);
    return { name, type };
  });

  return {
    columns,
    rowCount: rows.length,
    preview: rows.slice(0, 3) as Record<string, string>[],
  };
}

function inferType(samples: unknown[]): "number" | "string" {
  const nonNull = samples.filter(
    (s) => s !== null && s !== undefined && s !== "",
  );
  if (nonNull.every((s) => typeof s === "number")) return "number";
  return "string";
}

export function schemaToDescription(schema: CSVSchema): string {
  const cols = schema.columns
    .map((c) => `  - ${c.name} (${c.type})`)
    .join("\n");
  return `${schema.rowCount} rows, ${schema.columns.length} columns\n${cols}`;
}
