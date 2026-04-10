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
 * A reusable sandbox session — VM + uploaded CSV + installed deps + locked-down network.
 * Create once per request; call `runAnalysis(session.sandbox, ...)` as many times as needed;
 * always call `stop()` when the request ends.
 */
export interface SandboxSession {
  sandbox: Sandbox;
  stop: () => Promise<void>;
}

/**
 * Create a sandbox session: spin up the VM, upload the CSV, pip install, and deny network.
 * This is the expensive part (~20s for pip). Reuse the returned session across retries
 * within a single request — but DO NOT share across requests.
 */
export async function createSandboxSession(csvText: string): Promise<SandboxSession> {
  const start = Date.now();

  // 3 min VM timeout matches the Vercel Function maxDuration
  const sandbox = await Sandbox.create({
    runtime: "python3.13",
    timeout: 3 * 60 * 1000,
  });
  console.log(`  [sandbox] VM created in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await sandbox.stop();
      console.log(`  [sandbox] VM stopped`);
    } catch (err) {
      console.error(`  [sandbox] stop failed:`, err);
    }
  };

  try {
    await sandbox.writeFiles([{ path: "data.csv", content: csvText }]);

    // Phase 1: install deps with network access
    const installStart = Date.now();
    const installResult = await sandbox.runCommand(
      "pip",
      ["install", "matplotlib", "pandas", "scipy", "statsmodels", "scikit-learn", "--quiet"],
    );

    if (installResult.exitCode !== 0) {
      const stderr = await installResult.stderr();
      console.log(`  [sandbox] pip install FAILED in ${((Date.now() - installStart) / 1000).toFixed(1)}s`);
      await stop();
      throw new Error(`Failed to install dependencies: ${stderr}`);
    }
    console.log(`  [sandbox] pip install: ${((Date.now() - installStart) / 1000).toFixed(1)}s`);

    // Phase 2: lock down network before running any LLM-generated code
    await sandbox.updateNetworkPolicy("deny-all");
    console.log(`  [sandbox] session ready in ${((Date.now() - start) / 1000).toFixed(1)}s (network denied)`);

    return { sandbox, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * Run one analysis in an existing sandbox session.
 * Clears any prior chart files so stale outputs from an earlier run don't leak through.
 * The Python process itself is fresh each call, so there are no globals to worry about.
 */
export async function runAnalysis(
  sandbox: Sandbox,
  pythonCode: string,
  runIndex: number,
): Promise<AnalysisResult> {
  const start = Date.now();
  console.log(`  [sandbox] run #${runIndex} starting (${pythonCode.length} chars)`);

  try {
    // Wipe chart files from any prior run in this session
    await sandbox.runCommand("sh", ["-c", "rm -f chart_*.png"]);

    const wrappedCode = wrapAnalysisCode(pythonCode);
    await sandbox.writeFiles([{ path: "analysis.py", content: wrappedCode }]);

    const execStart = Date.now();
    const runResult = await sandbox.runCommand("python3", ["analysis.py"]);
    const stdout = await runResult.stdout();
    const stderr = await runResult.stderr();
    const execMs = Date.now() - execStart;

    if (runResult.exitCode !== 0) {
      const errorPreview = (stderr || "Analysis script failed").split("\n").slice(-3).join(" | ");
      console.log(`  [sandbox] run #${runIndex} FAILED in ${(execMs / 1000).toFixed(1)}s: ${errorPreview.slice(0, 120)}`);
      return {
        success: false,
        charts: [],
        findings: {},
        stdout,
        error: stderr || "Analysis script failed",
        durationMs: Date.now() - start,
      };
    }

    // Find chart files written by this run
    const lsResult = await sandbox.runCommand("sh", [
      "-c",
      "ls chart_*.png 2>/dev/null || true",
    ]);
    const lsOut = await lsResult.stdout();
    const chartFiles = lsOut
      .trim()
      .split("\n")
      .filter((f) => f.endsWith(".png"));

    const charts: { id: string; base64: string }[] = [];
    for (const file of chartFiles) {
      const buf = await sandbox.readFileToBuffer({ path: file });
      if (buf) {
        const id = file.replace(".png", "");
        charts.push({ id, base64: buf.toString("base64") });
      }
    }

    // Parse findings from stdout — last JSON-parseable line wins
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
    console.log(`  [sandbox] run #${runIndex} ✓ exec: ${(execMs / 1000).toFixed(1)}s | ${charts.length} charts | ${Object.keys(findings).length} findings | total: ${(totalMs / 1000).toFixed(1)}s`);

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
