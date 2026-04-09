import { tool } from "ai";
import { z } from "zod";
import { executeAnalysis } from "@/lib/sandbox";
import { chartStore } from "@/lib/chart-store";

/**
 * Creates the agent's tool set. Shared between the chat route and eval harness.
 *
 * @param csvText - The CSV data to analyze
 * @param schemaDescription - Human-readable schema description
 * @param model - Code generation model string for metadata tracking
 * @param options.requireApproval - Whether planAnalysis requires HITL approval (true in prod, false in eval)
 * @param options.analyzeModel - Model used for plan generation (defaults to model)
 */
export function createTools(
  csvText: string,
  schemaDescription: string,
  model: string,
  options: { requireApproval?: boolean; analyzeModel?: string } = {},
) {
  const analyzeModel = options.analyzeModel ?? model;
  return {
    planAnalysis: tool({
      description:
        "Analyze the dataset schema and user question to produce a structured analysis plan. " +
        "Only call this for NEW analyses — skip it when refining an existing report.",
      inputSchema: z.object({
        analysisType: z.string().describe(
          "The type of analysis to perform, e.g. 'channel efficiency', 'trend decomposition', 'anomaly detection'",
        ),
        computations: z.array(z.string()).describe(
          "List of specific computations to run, e.g. 'ROAS by channel', 'month-over-month growth rate'",
        ),
        charts: z.array(z.object({
          id: z.string().describe("Chart identifier, e.g. 'chart_1'"),
          description: z.string().describe("What this chart shows"),
        })).describe("2-3 charts to produce"),
        reportOutline: z.array(z.string()).describe(
          "Section headings for the markdown report",
        ),
      }),
      needsApproval: options.requireApproval ?? false,
      execute: async (plan) => {
        console.log("[planAnalysis] type:", plan.analysisType, "charts:", plan.charts.length);
        return {
          plan,
          schemaDescription,
          _meta: { model: analyzeModel },
        };
      },
    }),

    executeAnalysis: tool({
      description:
        "Execute a Python analysis script in an isolated Vercel Sandbox. " +
        "The script should compute findings, generate charts (chart_1.png, chart_2.png, etc.), " +
        "and print a JSON findings object to stdout.",
      inputSchema: z.object({
        code: z.string().describe(
          "Python code that performs the analysis. df is pre-loaded. " +
          "Save charts as chart_1.png, chart_2.png etc. " +
          "Print findings as JSON to stdout at the end: print(json.dumps(findings)). " +
          "Do not call plt.show().",
        ),
        analysisDescription: z.string().describe(
          "One sentence describing what this analysis computes",
        ),
      }),
      execute: async ({ code }, { abortSignal }) => {
        console.log("[executeAnalysis] code length:", code?.length, "model:", model);
        const result = await executeAnalysis(csvText, code, abortSignal);
        if (!result.success) {
          console.log("[executeAnalysis] FAILED:", result.error);
          return {
            success: false,
            error: result.error,
            stdout: result.stdout,
            hint: "Read the error, fix the code, and call executeAnalysis again.",
            _meta: { model, durationMs: result.durationMs },
          };
        }
        console.log(
          "[executeAnalysis] SUCCESS in", result.durationMs, "ms,",
          result.charts.length, "charts",
        );
        // Store full chart images in memory — the UI fetches them via /api/charts/[id].
        // Only return chart IDs in the tool result to keep model context small.
        chartStore.setAll(result.charts);
        return {
          success: true,
          chartIds: result.charts.map((c) => c.id),
          findings: result.findings,
          _meta: { model, durationMs: result.durationMs },
        };
      },
    }),

    composeReport: tool({
      description:
        "Write a structured markdown report based on the analysis findings and charts. " +
        "Include Summary, Findings, Charts, and Recommended Actions sections.",
      inputSchema: z.object({
        markdown: z.string().describe(
          "The full markdown report. Use ## for section headings. " +
          "Reference charts by their id (e.g. chart_1) with descriptions. " +
          "Include an executive summary, per-computation findings with key metrics, " +
          "and 2-3 actionable recommendations.",
        ),
      }),
      execute: async ({ markdown }) => {
        console.log("[composeReport] report length:", markdown?.length);
        return {
          markdown,
          _meta: { model },
        };
      },
    }),
  };
}
