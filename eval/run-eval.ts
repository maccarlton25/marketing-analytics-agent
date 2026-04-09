import { generateText, stepCountIs } from "ai";
import { createTools } from "@/lib/tools";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { TEST_CASES, DEMO_CSV, VALID_COLUMNS, type EvalCase } from "./test-cases";
import * as fs from "fs";

const EVAL_MODEL = "anthropic/claude-sonnet-4.6";
const JUDGE_MODEL = "anthropic/claude-sonnet-4.6";

const SCHEMA_DESCRIPTION = `Marketing campaign dataset with ${VALID_COLUMNS.length} columns: ${VALID_COLUMNS.join(", ")}. Contains monthly performance data across channels (Google Ads, Meta, Email, LinkedIn), campaigns, and regions (North America, Europe).`;

// ── Types ───────────────────────────────────────────────────────────────

interface EvalResult {
  id: string;
  prompt: string;
  rubric: string;
  passed: boolean;
  score: number;
  judgeReason: string;
  chartCount: number;
  hasReport: boolean;
  toolSequence: string[];
  error?: string;
  reportMarkdown?: string;
  generatedCode?: string;
  durationMs: number;
}

// ── Run a single case ───────────────────────────────────────────────────

async function runCase(testCase: EvalCase): Promise<EvalResult> {
  const start = Date.now();

  const tools = createTools(DEMO_CSV, SCHEMA_DESCRIPTION, EVAL_MODEL, {
    requireApproval: false,
  });

  // Run the full agent pipeline — same code path as production
  const result = await generateText({
    model: EVAL_MODEL,
    system: SYSTEM_PROMPT,
    prompt: testCase.prompt,
    tools,
    stopWhen: stepCountIs(6),
  });

  // Walk ALL steps to extract outputs
  let reportMarkdown: string | undefined;
  let generatedCode: string | undefined;
  let chartCount = 0;
  const toolSequence: string[] = [];

  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      toolSequence.push(tc.toolName);

      if (tc.toolName === "executeAnalysis") {
        generatedCode = (tc as unknown as { input: { code: string } }).input.code;
      }
    }
    for (const tr of step.toolResults) {
      if (tr.toolName === "executeAnalysis") {
        const output = (tr as unknown as { output: { success: boolean; chartIds?: string[] } }).output;
        if (output?.success && Array.isArray(output.chartIds)) {
          chartCount = output.chartIds.length;
        }
      }
      if (tr.toolName === "composeReport") {
        const output = (tr as unknown as { output: { markdown: string } }).output;
        if (output?.markdown) {
          reportMarkdown = output.markdown;
        }
      }
    }
  }

  // Build a summary of what the agent produced for the judge
  const agentOutput = buildAgentSummary({
    text: result.text,
    reportMarkdown,
    generatedCode,
    chartCount,
    toolSequence,
  });

  // LLM-as-judge
  const { score, reason } = await judge(testCase.prompt, testCase.rubric, agentOutput);

  return {
    id: testCase.id,
    prompt: testCase.prompt,
    rubric: testCase.rubric,
    passed: score >= 3,
    score,
    judgeReason: reason,
    chartCount,
    hasReport: !!reportMarkdown,
    toolSequence,
    reportMarkdown,
    generatedCode,
    durationMs: Date.now() - start,
  };
}

// ── Judge ───────────────────────────────────────────────────────────────

function buildAgentSummary(data: {
  text: string;
  reportMarkdown?: string;
  generatedCode?: string;
  chartCount: number;
  toolSequence: string[];
}): string {
  const parts: string[] = [];

  parts.push(`Tool sequence: ${data.toolSequence.join(" → ") || "none"}`);
  parts.push(`Charts generated: ${data.chartCount}`);

  if (data.reportMarkdown) {
    parts.push(`\n--- Report ---\n${data.reportMarkdown}`);
  }

  if (data.generatedCode) {
    parts.push(`\n--- Python Code ---\n${data.generatedCode}`);
  }

  if (data.text) {
    parts.push(`\n--- Agent Text Response ---\n${data.text.slice(0, 500)}`);
  }

  return parts.join("\n");
}

async function judge(
  prompt: string,
  rubric: string,
  agentOutput: string,
): Promise<{ score: number; reason: string }> {
  const { text } = await generateText({
    model: JUDGE_MODEL,
    system: `You are evaluating an AI marketing analytics agent. Given a user prompt, a rubric, and the agent's full output (tool sequence, generated code, report, and charts), score the output quality.

Score from 1-5:
1 = Failed to address the request, wrong analysis, or fabricated data
2 = Partially addressed but significant issues (wrong chart type, missing key insights, hallucinated columns)
3 = Acceptable — correct approach, reasonable output, minor issues
4 = Good — meets all rubric criteria, clear insights, well-structured report
5 = Excellent — exceeds expectations with strong insights, good styling, actionable recommendations

Consider:
- Did the agent use the right tools in a logical sequence?
- Is the Python code correct and does it use real columns from the dataset?
- Does the report contain meaningful insights (not just restating numbers)?
- Are charts appropriate for the analysis requested?
- For requests about non-existent data: did the agent handle it gracefully?

Respond with ONLY a JSON object: {"score": N, "reason": "..."}`,
    prompt: `User request: "${prompt}"

Rubric: ${rubric}

Agent output:
${agentOutput}`,
  });

  try {
    // Handle cases where the model wraps JSON in markdown code blocks
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return { score: parsed.score, reason: parsed.reason };
  } catch {
    return { score: 3, reason: "Failed to parse judge response: " + text.slice(0, 200) };
  }
}

// ── HTML report ─────────────────────────────────────────────────────────

function generateHtmlReport(results: EvalResult[], durationMs: number): string {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const avgDuration = results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const scoreColor = (s: number) => s >= 4 ? "#059669" : s >= 3 ? "#d97706" : "#dc2626";

  const caseRows = results
    .map((r) => {
      const statusColor = r.passed ? "#059669" : "#dc2626";
      const statusBg = r.passed ? "#ecfdf5" : "#fef2f2";
      const statusLabel = r.passed ? "PASS" : "FAIL";

      const scoreBar = `<div style="display:flex;align-items:center;gap:8px;">
        <div style="width:80px;height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;">
          <div style="width:${(r.score / 5) * 100}%;height:100%;background:${scoreColor(r.score)};border-radius:4px;"></div>
        </div>
        <span style="font-weight:600;">${r.score}/5</span>
      </div>`;

      const codeBlock = r.generatedCode
        ? `<details><summary style="cursor:pointer;color:#6366f1;font-size:13px;">Generated Python (${r.generatedCode.split("\n").length} lines)</summary>
           <pre style="background:#1e1e2e;color:#cdd6f4;padding:16px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.5;margin-top:8px;">${esc(r.generatedCode)}</pre></details>`
        : "";

      const reportBlock = r.reportMarkdown
        ? `<details><summary style="cursor:pointer;color:#6366f1;font-size:13px;">Report (${r.reportMarkdown.length} chars)</summary>
           <pre style="background:#f8fafc;color:#334155;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.5;margin-top:8px;white-space:pre-wrap;">${esc(r.reportMarkdown)}</pre></details>`
        : "";

      return `
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-bottom:16px;background:white;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
          <div>
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px;">
              <span style="background:${statusBg};color:${statusColor};font-weight:700;font-size:12px;padding:2px 10px;border-radius:999px;letter-spacing:0.05em;">${statusLabel}</span>
              <h3 style="margin:0;font-size:16px;font-weight:600;color:#111827;">${esc(r.id)}</h3>
            </div>
            <p style="margin:4px 0 0;color:#6b7280;font-size:14px;">"${esc(r.prompt)}"</p>
          </div>
          <span style="color:#9ca3af;font-size:13px;white-space:nowrap;">${(r.durationMs / 1000).toFixed(1)}s</span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:16px;">
          <div style="background:#f9fafb;padding:12px;border-radius:8px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Quality Score</div>
            ${scoreBar}
          </div>
          <div style="background:#f9fafb;padding:12px;border-radius:8px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Charts</div>
            <div style="font-weight:600;color:#111827;">${r.chartCount} generated</div>
          </div>
          <div style="background:#f9fafb;padding:12px;border-radius:8px;">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Report</div>
            <div style="font-weight:600;color:${r.hasReport ? "#059669" : "#dc2626"};">${r.hasReport ? "Yes" : "No"}</div>
          </div>
        </div>

        <div style="background:#fffbeb;border-left:3px solid #d97706;padding:10px 14px;border-radius:0 8px 8px 0;margin-bottom:12px;font-size:13px;color:#92400e;">
          <strong>Judge:</strong> ${esc(r.judgeReason)}
        </div>

        <div style="font-size:13px;color:#6b7280;margin-bottom:8px;">
          <strong>Rubric:</strong> ${esc(r.rubric)}
        </div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:12px;">
          <strong>Tools:</strong> ${r.toolSequence.map((t) => `<code style="background:#f1f5f9;padding:1px 6px;border-radius:4px;">${esc(t)}</code>`).join(" → ") || "<em>none</em>"}
        </div>

        ${codeBlock}
        ${reportBlock}
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eval Report — Marketing Analytics Agent</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #111827; line-height: 1.6; }
    code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 0.9em; }
  </style>
</head>
<body>
  <div style="max-width:960px;margin:0 auto;padding:40px 24px;">
    <div style="margin-bottom:32px;">
      <h1 style="font-size:28px;font-weight:700;margin-bottom:4px;">Eval Report</h1>
      <p style="color:#6b7280;font-size:14px;">Marketing Analytics Agent — ${new Date().toLocaleString()}</p>
      <p style="color:#6b7280;font-size:13px;">Model: <code>${esc(EVAL_MODEL)}</code> · Judge: <code>${esc(JUDGE_MODEL)}</code> · Runtime: ${(durationMs / 1000).toFixed(1)}s</p>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px;">
      <div style="background:white;border-radius:12px;padding:20px;border:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Pass Rate</div>
        <div style="font-size:28px;font-weight:700;color:${passed === results.length ? "#059669" : "#d97706"};">${passed}/${results.length}</div>
      </div>
      <div style="background:white;border-radius:12px;padding:20px;border:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Failed</div>
        <div style="font-size:28px;font-weight:700;color:${failed > 0 ? "#dc2626" : "#059669"};">${failed}</div>
      </div>
      <div style="background:white;border-radius:12px;padding:20px;border:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Avg Score</div>
        <div style="font-size:28px;font-weight:700;color:${scoreColor(avgScore)};">${avgScore.toFixed(1)}<span style="font-size:14px;color:#9ca3af;">/5</span></div>
      </div>
      <div style="background:white;border-radius:12px;padding:20px;border:1px solid #e5e7eb;">
        <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Avg Duration</div>
        <div style="font-size:28px;font-weight:700;color:#111827;">${(avgDuration / 1000).toFixed(1)}<span style="font-size:14px;color:#9ca3af;">s</span></div>
      </div>
    </div>

    <h2 style="font-size:18px;font-weight:600;margin-bottom:16px;">Test Cases</h2>
    ${caseRows}

    <div style="text-align:center;color:#9ca3af;font-size:12px;margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;">
      Generated by <code>npm run eval</code> — Marketing Analytics Agent
    </div>
  </div>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  // Parse --count N argument
  const countIdx = process.argv.indexOf("--count");
  const maxCases = countIdx !== -1 && process.argv[countIdx + 1]
    ? parseInt(process.argv[countIdx + 1], 10)
    : TEST_CASES.length;

  const casesToRun = TEST_CASES.slice(0, maxCases);

  const totalStart = Date.now();
  console.log(`Running ${casesToRun.length}/${TEST_CASES.length} eval cases in parallel...\n`);
  const settled = await Promise.allSettled(
    casesToRun.map((testCase) => runCase(testCase)),
  );

  const results: EvalResult[] = settled.map((outcome, i) => {
    const testCase = casesToRun[i];
    if (outcome.status === "fulfilled") {
      const result = outcome.value;
      const status = result.passed ? "PASS" : "FAIL";
      console.log(
        `[${result.id}] ${status} | score: ${result.score}/5 | charts: ${result.chartCount} | report: ${result.hasReport} | ${(result.durationMs / 1000).toFixed(1)}s`,
      );
      console.log(`  Judge: ${result.judgeReason}\n`);
      return result;
    } else {
      console.error(`[${testCase.id}] ERROR: ${outcome.reason}\n`);
      return {
        id: testCase.id,
        prompt: testCase.prompt,
        rubric: testCase.rubric,
        passed: false,
        score: 0,
        judgeReason: `Eval crashed: ${outcome.reason}`,
        chartCount: 0,
        hasReport: false,
        toolSequence: [],
        error: String(outcome.reason),
        durationMs: Date.now() - totalStart,
      };
    }
  });

  const totalDuration = Date.now() - totalStart;
  const passed = results.filter((r) => r.passed).length;
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
  console.log(`${passed}/${results.length} passed | avg score: ${avgScore.toFixed(1)}/5 | ${(totalDuration / 1000).toFixed(1)}s total`);

  // Write reports
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync("eval/results", { recursive: true });

  const jsonPath = `eval/results/${timestamp}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nJSON:   ${jsonPath}`);

  const htmlPath = `eval/results/${timestamp}.html`;
  fs.writeFileSync(htmlPath, generateHtmlReport(results, totalDuration));
  console.log(`HTML:   ${htmlPath}`);

  const latestPath = "eval/results/latest.html";
  try { fs.unlinkSync(latestPath); } catch { /* ignore */ }
  fs.copyFileSync(htmlPath, latestPath);
  console.log(`Latest: ${latestPath}`);
}

main().catch(console.error);
