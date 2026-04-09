import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  UIMessage,
} from "ai";
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

  console.log("[chat] POST received", {
    messageCount: messages?.length,
    hasCsvText: !!csvText,
    analyzeModel,
    codeGenModel,
  });

  // Strip denied tool approvals (avoids orphaned tool_use blocks that Anthropic rejects)
  const cleanedMessages = stripDeniedToolParts(messages);
  const modelMessages = await convertToModelMessages(cleanedMessages);

  try {
    const result = createStreamResult(
      codeGenModel, analyzeModel, modelMessages, csvText, schemaDescription,
    );
    return result.toUIMessageStreamResponse();
  } catch (err) {
    console.error("[chat] Primary model failed, trying fallback:", err);
    const result = createStreamResult(
      MODEL_CONFIG.codeGenFallback, analyzeModel, modelMessages, csvText, schemaDescription,
    );
    return result.toUIMessageStreamResponse();
  }
}

function createStreamResult(
  model: string,
  analyzeModel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  csvText: string,
  schemaDescription: string,
) {
  const tools = createTools(csvText, schemaDescription, model, {
    requireApproval: true,
    analyzeModel,
  });

  let stepCount = 0;

  return streamText({
    model,
    system: SYSTEM_PROMPT,
    messages,
    tools,
    // 8 steps: plan(1) + execute(2) + compose(3) + up to 2 retries (execute+compose each)
    stopWhen: stepCountIs(8),
    prepareStep: ({ stepNumber }) => {
      // Route step 0 (planAnalysis) to the cheaper/faster analyze model
      if (stepNumber === 0) return { model: analyzeModel };
      return {};
    },
    onStepFinish: ({ finishReason, usage, toolCalls }) => {
      stepCount++;
      const toolNames = toolCalls.map((tc) => tc.toolName);
      const label = toolNames.length > 0 ? toolNames.join(", ") : "text";
      console.log(
        `[step ${stepCount}/8] ${label} | ${finishReason} | in: ${usage?.inputTokens ?? "?"} out: ${usage?.outputTokens ?? "?"} tokens`,
      );
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
