import { tool } from "ai";
import { z } from "zod";
import { createSandboxSession, runAnalysis, type SandboxSession } from "@/lib/sandbox";

/**
 * Creates the agent's tool set. Shared between the chat route and eval harness.
 *
 * The sandbox is lazily initialized on the first `executeAnalysis` call and reused
 * across retries within the same tool set. Callers are responsible for stopping it
 * via the returned `stopSession` when the request/eval case ends.
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

  // Lazy sandbox session — created on first executeAnalysis call, reused on retries.
  // Scoped to this createTools() call, so a new POST (= new createTools) gets a fresh VM.
  let sessionPromise: Promise<SandboxSession> | null = null;
  let runCount = 0;

  const getSession = (): Promise<SandboxSession> => {
    if (!sessionPromise) {
      console.log(`  [executeAnalysis] initializing new sandbox session`);
      sessionPromise = createSandboxSession(csvText).catch((err) => {
        // Null out so a subsequent call can retry init from scratch
        sessionPromise = null;
        throw err;
      });
    } else {
      console.log(`  [executeAnalysis] reusing existing sandbox session`);
    }
    return sessionPromise;
  };

  const stopSession = async () => {
    if (!sessionPromise) return;
    try {
      const session = await sessionPromise;
      await session.stop();
    } catch {
      // init failed or already stopped — nothing to do
    }
  };
  const tools = {
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
      /*
        Above defines the JSON we expect for the tool. If model output doesn't match, AI SDK rejects the tool call.
        {
          "analysisType": "channel efficiency",
          "computations": ["ROAS by channel", "spend vs revenue ratio"],
          "charts": [
            { "id": "chart_1", "description": "Bar chart of ROAS by channel" }
          ],
          "reportOutline": ["Summary", "ROAS Rankings", "Recommendations"]
        }
      */
      execute: async (plan) => {
        console.log(`  [planAnalysis] ${plan.analysisType} | ${plan.computations.length} computations | ${plan.charts.length} charts`);
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
          "Python code that performs the analysis. Rules:\n" +
          "- df is pre-loaded from data.csv; matplotlib.use('Agg') is already set\n" +
          "- Save charts as chart_1.png, chart_2.png etc. in the current directory\n" +
          "- Print findings as a single JSON object to stdout at the end: print(json.dumps(findings, default=str)) — always use default=str for numpy/pandas types\n" +
          "- Available packages: pandas, matplotlib, scipy, statsmodels, scikit-learn, numpy (all pre-installed)\n" +
          "- Do NOT use seaborn — it is not installed and cannot be installed\n" +
          "- You cannot pip install anything — the sandbox has no network access\n" +
          "- Do not call plt.show()\n" +
          "- Keep charts clean and labeled — title, axis labels, legend where needed",
        ),
        analysisDescription: z.string().describe(
          "One sentence describing what this analysis computes",
        ),
      }),
      execute: async ({ code }) => {
        runCount++;
        console.log(`  [executeAnalysis] call #${runCount} — ${code?.length ?? 0} chars of Python`);
        const session = await getSession();
        const result = await runAnalysis(session.sandbox, code, runCount);
        if (!result.success) {
          return {
            success: false,
            error: result.error,
            stdout: result.stdout,
            hint: "Read the error, fix the code, and call executeAnalysis again.",
            _meta: { model, durationMs: result.durationMs },
          };
        }
        console.log(`  [executeAnalysis] ✓ ${result.charts.length} charts in ${(result.durationMs / 1000).toFixed(1)}s`);
        // Charts with base64 go to the client via the stream.
        // toModelOutput below strips them so the model only sees IDs.
        return {
          success: true,
          charts: result.charts,
          chartIds: result.charts.map((c) => c.id),
          findings: result.findings,
          _meta: { model, durationMs: result.durationMs },
        };
      },
      // Control what the model sees — strip base64 chart data to keep context small.
      // The full execute result (with charts) still streams to the client.
      toModelOutput({ output }) {
        if (!output.success) {
          return { type: "content" as const, value: [{ type: "text" as const, text: JSON.stringify(output) }] };
        }
        const { charts: _charts, ...rest } = output; // destructure out charts (base64), keep everything else
        return { type: "content" as const, value: [{ type: "text" as const, text: JSON.stringify(rest) }] };
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
        console.log(`  [composeReport] ${markdown?.length ?? 0} chars`);
        return {
          markdown,
          _meta: { model },
        };
      },
    }),
  };

  return { tools, stopSession };
}
