import { Sandbox } from "@vercel/sandbox";

export interface AnalysisResult {
  success: boolean;
  charts: { id: string; base64: string }[];
  findings: Record<string, unknown>;
  stdout: string;
  error?: string;
  durationMs: number;
}

/**
 * Execute a multi-chart analysis script in a sandbox.
 * The script should save charts as chart_1.png, chart_2.png, etc.
 * and print a JSON findings object to stdout.
 */
export async function executeAnalysis(
  csvText: string,
  pythonCode: string,
  abortSignal?: AbortSignal,
): Promise<AnalysisResult> {
  const start = Date.now();

  // Firecracker microVM — 3 min timeout covers pip install (~20s) + analysis execution
  const sandbox = await Sandbox.create({
    runtime: "python3.13",
    timeout: 3 * 60 * 1000,
  });
  console.log(`  [sandbox] VM created in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  // Stop the sandbox if the client disconnects
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      console.log("  [sandbox] Abort signal received, stopping VM");
      sandbox.stop();
    }, { once: true });
  }

  try {
    await sandbox.writeFiles([{ path: "data.csv", content: csvText }]);

    // Phase 1: Install dependencies with network access
    const installStart = Date.now();
    const installResult = await sandbox.runCommand(
      "pip",
      ["install", "matplotlib", "pandas", "scipy", "statsmodels", "scikit-learn", "--quiet"],
    );

    if (installResult.exitCode !== 0) {
      const stderr = await installResult.stderr();
      console.log(`  [sandbox] pip install FAILED in ${((Date.now() - installStart) / 1000).toFixed(1)}s`);
      return {
        success: false,
        charts: [],
        findings: {},
        stdout: "",
        error: `Failed to install dependencies: ${stderr}`,
        durationMs: Date.now() - start,
      };
    }
    console.log(`  [sandbox] pip install: ${((Date.now() - installStart) / 1000).toFixed(1)}s`);

    // Phase 2: Lock down network before running LLM-generated code
    await sandbox.updateNetworkPolicy("deny-all");

    // Write the wrapped analysis code
    const wrappedCode = wrapAnalysisCode(pythonCode);
    await sandbox.writeFiles([{ path: "analysis.py", content: wrappedCode }]);

    // Execute
    const execStart = Date.now();
    const runResult = await sandbox.runCommand("python3", ["analysis.py"]);
    const stdout = await runResult.stdout();
    const stderr = await runResult.stderr();
    const execMs = Date.now() - execStart;

    if (runResult.exitCode !== 0) {
      const errorPreview = (stderr || "Analysis script failed").split("\n").slice(-3).join(" | ");
      console.log(`  [sandbox] exec FAILED in ${(execMs / 1000).toFixed(1)}s: ${errorPreview.slice(0, 120)}`);
      return {
        success: false,
        charts: [],
        findings: {},
        stdout,
        error: stderr || "Analysis script failed",
        durationMs: Date.now() - start,
      };
    }

    // Find all chart files
    const lsResult = await sandbox.runCommand("sh", [
      "-c",
      "ls chart_*.png 2>/dev/null || true",
    ]);
    const lsOut = await lsResult.stdout();
    const chartFiles = lsOut
      .trim()
      .split("\n")
      .filter((f) => f.endsWith(".png"));

    // Read each chart
    const charts: { id: string; base64: string }[] = [];
    for (const file of chartFiles) {
      const buf = await sandbox.readFileToBuffer({ path: file });
      if (buf) {
        const id = file.replace(".png", "");
        charts.push({ id, base64: buf.toString("base64") });
      }
    }

    // Parse findings from stdout — last line should be JSON
    let findings: Record<string, unknown> = {};
    const lines = stdout.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        findings = JSON.parse(lines[i]);
        break;
      } catch {
        // not JSON, keep searching
      }
    }

    const totalMs = Date.now() - start;
    console.log(`  [sandbox] exec: ${(execMs / 1000).toFixed(1)}s | ${charts.length} charts | ${Object.keys(findings).length} findings | total: ${(totalMs / 1000).toFixed(1)}s`);

    return {
      success: true,
      charts,
      findings,
      stdout,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      charts: [],
      findings: {},
      stdout: "",
      error: err instanceof Error ? err.message : "Unknown error",
      durationMs: Date.now() - start,
    };
  } finally {
    await sandbox.stop();
  }
}

function wrapAnalysisCode(code: string): string {
  return `
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import pandas as pd
import json
import sys

df = pd.read_csv('data.csv')

${code}
`;
}

