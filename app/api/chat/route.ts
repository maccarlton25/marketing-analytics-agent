import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  UIMessage,
} from "ai";
import { after } from "next/server";
import { createTools } from "@/lib/tools";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { isAllowedModel } from "@/lib/models";

// Vercel Fluid compute — allow up to 3 minutes for multi-step analysis
export const maxDuration = 180;

// Default models via Vercel AI Gateway (overridable from the UI)
const MODEL_CONFIG = {
  analyze: "anthropic/claude-haiku-4-5",      // Fast/cheap for plan generation
  codeGen: "anthropic/claude-sonnet-4.6",     // Capable for Python code generation
  codeGenFallback: "openai/gpt-5.4",           // Fallback if primary model errors
} as const;

/** e.g. "anthropic/claude-sonnet-4.6" → "sonnet-4.6" */
function shortModel(model: string): string {
  return model.split("/").pop() ?? model;
}

function fmtTokens(n: number | undefined): string {
  if (n == null) return "?";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export async function POST(req: Request) {
  const body = await req.json();
  const {
    messages,
    csvText,
    schemaDescription,
    analyzeModel: clientAnalyzeModel,
    codeGenModel: clientCodeGenModel,
  } = body as {
    messages: UIMessage[];
    csvText: string;
    schemaDescription: string;
    analyzeModel?: string;
    codeGenModel?: string;
  };

  const analyzeModel = clientAnalyzeModel || MODEL_CONFIG.analyze;
  const codeGenModel = clientCodeGenModel || MODEL_CONFIG.codeGen;

  if (!isAllowedModel(analyzeModel) || !isAllowedModel(codeGenModel)) {
    return Response.json({ error: "Invalid model selection" }, { status: 400 });
  }

  const requestStart = Date.now();
  console.log(`\n[chat] ${"─".repeat(50)}`);
  console.log(`[chat] Turn ${messages?.length ?? 0} | planner: ${shortModel(analyzeModel)} | codeGen: ${shortModel(codeGenModel)}`);
  console.log(`[chat] Messages: ${messages?.length ?? 0} | CSV: ${csvText ? `${csvText.length} chars` : "none"}`);

  // Strip denied tool approvals (avoids orphaned tool_use blocks that Anthropic rejects)
  const cleanedMessages = stripDeniedToolParts(messages);

  // Create tools first so convertToModelMessages can use toModelOutput
  // to strip chart base64 from previous turns
  const { tools, stopSession } = createTools(csvText, schemaDescription, codeGenModel, {
    requireApproval: true,
    analyzeModel,
  });
  const modelMessages = await convertToModelMessages(cleanedMessages, { tools });

  // Ensure the sandbox VM is torn down if the client disconnects mid-request
  req.signal.addEventListener("abort", () => {
    console.log(`[chat] request aborted — stopping sandbox session`);
    void stopSession();
  }, { once: true });

  try {
    const result = createStreamResult(
      codeGenModel, analyzeModel, modelMessages, tools, stopSession, requestStart,
    );
    return result.toUIMessageStreamResponse();
  } catch (err) {
    console.error(`[chat] Primary model failed (${shortModel(codeGenModel)}), falling back to ${shortModel(MODEL_CONFIG.codeGenFallback)}:`, err);
    // Primary failed before streaming started — tear down any session it may have created
    void stopSession();
    const { tools: fallbackTools, stopSession: stopFallbackSession } = createTools(
      csvText, schemaDescription, MODEL_CONFIG.codeGenFallback, {
        requireApproval: true,
        analyzeModel,
      },
    );
    req.signal.addEventListener("abort", () => {
      console.log(`[chat] request aborted — stopping fallback sandbox session`);
      void stopFallbackSession();
    }, { once: true });
    const result = createStreamResult(
      MODEL_CONFIG.codeGenFallback, analyzeModel, modelMessages, fallbackTools, stopFallbackSession, requestStart,
    );
    return result.toUIMessageStreamResponse();
  }
}

function createStreamResult(
  model: string,
  analyzeModel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  tools: ReturnType<typeof createTools>["tools"],
  stopSession: () => Promise<void>,
  requestStart: number,
) {
  let stepNumber = 0;

  return streamText({
    model,
    system: SYSTEM_PROMPT,
    messages,
    tools,
    // 8 steps: plan(1) + execute(2) + compose(3) + up to 2 retries (execute+compose each)
    stopWhen: stepCountIs(8),
    prepareStep: ({ stepNumber: n }) => {
      // Route step 0 (planAnalysis) to the cheaper/faster analyze model
      if (n === 0) return { model: analyzeModel };
      return {};
    },
    onStepFinish: ({ finishReason, usage, toolCalls, toolResults, response }) => {
      const step = stepNumber++;
      const stepModel = response?.modelId ? shortModel(response.modelId) : shortModel(model);
      const toolNames = toolCalls.map((tc) => tc.toolName);
      const label = toolNames.length > 0 ? toolNames.join(", ") : "text";

      const cached = usage?.inputTokenDetails?.cacheReadTokens;
      const cacheStr = cached ? ` (${fmtTokens(cached)} cached)` : "";

      // Show tool result summaries inline
      const resultSummaries = toolResults.map((tr) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = (tr as any).output;
        if (!out) return null;
        if (tr.toolName === "executeAnalysis") {
          if (out.success) return `✓ ${out.chartIds?.length ?? 0} charts`;
          return `✗ ${(out.error as string)?.slice(0, 80)}`;
        }
        if (tr.toolName === "composeReport") return `${(out.markdown as string)?.length ?? 0} chars`;
        if (tr.toolName === "planAnalysis") return `${out.plan?.charts?.length ?? 0} charts planned`;
        return null;
      }).filter(Boolean);

      console.log(
        `[step] ${label} → ${stepModel} | ${fmtTokens(usage?.inputTokens)} in${cacheStr} → ${fmtTokens(usage?.outputTokens)} out | ${finishReason}` +
        (resultSummaries.length > 0 ? ` | ${resultSummaries.join("; ")}` : ""),
      );
    },
    onFinish: ({ steps, totalUsage }) => {
      const elapsed = ((Date.now() - requestStart) / 1000).toFixed(1);
      const cached = totalUsage?.inputTokenDetails?.cacheReadTokens;
      const cacheStr = cached ? ` (${fmtTokens(cached)} cached)` : "";
      console.log(
        `[chat] Done in ${steps.length} steps | ${fmtTokens(totalUsage?.totalTokens)} total tokens${cacheStr} | ${elapsed}s`,
      );
      console.log(`[chat] ${"─".repeat(50)}\n`);
      // Stream finished normally — tear down the sandbox VM after response flushes
      after(stopSession());
    },
    onError: ({ error }) => {
      console.error(`[chat] stream error — stopping sandbox session:`, error);
      after(stopSession());
    },
    onAbort: () => {
      console.log(`[chat] stream aborted — stopping sandbox session`);
      after(stopSession());
    },
  });
}

/**
 * Remove assistant tool-call parts that were denied via HITL approval.
 * Without this, convertToModelMessages produces tool_use blocks with no
 * matching tool_result, which Anthropic rejects with a 400.
 */
function stripDeniedToolParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const filtered = msg.parts.filter((part) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = part as any;
      // Keep everything that isn't a denied tool call (v6 uses tool-<name> part types)
      const isToolPart = typeof p.type === "string" && p.type.startsWith("tool-");
      if (isToolPart && p.approval?.approved === false) return false;
      return true;
    });

    // If all parts were stripped, drop the message entirely
    if (filtered.length === 0) return null;

    return { ...msg, parts: filtered };
  }).filter((msg): msg is UIMessage => msg !== null);
}
