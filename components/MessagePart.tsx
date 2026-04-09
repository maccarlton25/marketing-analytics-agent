"use client";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessagePartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  part: any;
  onApproval?: (id: string, approved: boolean) => void;
}

// Renders a single message part from the AI SDK UIMessage.parts array
export default function MessagePart({ part, onApproval }: MessagePartProps) {
  if (part.type === "text") {
    return <TextPart text={part.text} />;
  }

  if (part.type === "dynamic-tool" || part.type?.startsWith("tool-")) {
    return <ToolPart part={part} onApproval={onApproval} />;
  }

  if (part.type === "step-start") {
    return null;
  }

  return null;
}

function TextPart({ text }: { text: string }) {
  if (!text.trim()) return null;

  return (
    <div className="text-sm text-gray-800 leading-relaxed prose prose-sm prose-gray max-w-none">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ToolPart({
  part,
  onApproval,
}: {
  part: any;
  onApproval?: (id: string, approved: boolean) => void;
}) {
  // Static tools have type "tool-NAME", dynamic tools have toolName property
  const toolName: string =
    part.toolName ??
    (typeof part.type === "string" && part.type.startsWith("tool-")
      ? part.type.slice(5)
      : "unknown");

  if (toolName === "planAnalysis") {
    return <PlanAnalysisPart part={part} onApproval={onApproval} />;
  }

  if (toolName === "executeAnalysis") {
    return <ExecuteAnalysisPart part={part} />;
  }

  if (toolName === "composeReport") {
    return <ComposeReportPart part={part} />;
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PlanAnalysisPart({
  part,
  onApproval,
}: {
  part: any;
  onApproval?: (id: string, approved: boolean) => void;
}) {
  const state: string = part.state;
  const input = part.input as
    | {
        analysisType?: string;
        computations?: string[];
        charts?: { id: string; description: string }[];
        reportOutline?: string[];
      }
    | undefined;

  // Render the plan details (shared between approval-requested and output-available)
  const planDetails = input && (
    <div className="text-xs text-gray-500 space-y-1">
      {input.analysisType && (
        <p>
          <span className="font-medium text-gray-600">Type:</span>{" "}
          {input.analysisType}
        </p>
      )}
      {input.computations && input.computations.length > 0 && (
        <div>
          <span className="font-medium text-gray-600">Computations:</span>
          <ul className="list-disc list-inside ml-2 mt-0.5">
            {input.computations.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {input.charts && input.charts.length > 0 && (
        <p>
          <span className="font-medium text-gray-600">Charts:</span>{" "}
          {input.charts.map((c) => c.description).join(", ")}
        </p>
      )}
    </div>
  );

  if (state === "input-streaming") {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
        <Spinner />
        <span>Planning analysis...</span>
      </div>
    );
  }

  // Waiting for user approval
  if (state === "input-available" || state === "approval-requested") {
    const approvalId = part.approval?.id;

    return (
      <div className="border border-amber-200 rounded-lg p-3 my-2 bg-amber-50">
        <div className="flex items-center gap-2 text-xs font-medium text-amber-700 mb-2">
          <PauseIcon />
          <span>New analysis proposed — approve to proceed</span>
        </div>
        {planDetails}
        {approvalId && onApproval && (
          <div className="flex items-center gap-2 mt-3 pt-2 border-t border-amber-200">
            <button
              onClick={() => onApproval(approvalId, true)}
              className="text-xs px-3 py-1.5 rounded-lg bg-black text-white hover:bg-gray-800 transition-colors"
            >
              Approve & Run
            </button>
            <button
              onClick={() => onApproval(approvalId, false)}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Deny — refine instead
            </button>
          </div>
        )}
      </div>
    );
  }

  // User responded to approval
  if (state === "approval-responded") {
    const approved = part.approval?.approved;
    if (!approved) {
      return (
        <div className="border border-gray-200 rounded-lg p-3 my-2 bg-gray-50">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
            <XIcon />
            <span>New analysis denied, tell me what to do differently. </span>
          </div>
        </div>
      );
    }
    // If approved, show as in-progress (waiting for execute to return)
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
        <Spinner />
        <span>Analysis approved, executing...</span>
      </div>
    );
  }

  if (state === "output-available") {
    const meta = part.output?._meta as { model?: string } | undefined;

    return (
      <div className="border border-gray-100 rounded-lg p-3 my-2 bg-gray-50">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-600">
            <CheckIcon />
            <span>Analysis planned</span>
          </div>
          {meta?.model && <ModelBadge model={meta.model} />}
        </div>
        {planDetails}
      </div>
    );
  }

  if (state === "output-error") {
    return <ErrorBadge text={part.errorText ?? "Failed to plan analysis"} />;
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ExecuteAnalysisPart({ part }: { part: any }) {
  const state: string = part.state;
  const input = part.input as
    | { code?: string; analysisDescription?: string }
    | undefined;

  if (state === "input-streaming") {
    return (
      <div className="my-2">
        <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
          <Spinner />
          <span>Writing analysis code...</span>
        </div>
        {input?.code && <CodeBlock code={input.code} label="Generating..." />}
      </div>
    );
  }

  if (state === "input-available") {
    return (
      <div className="my-2">
        <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
          <Spinner />
          <span>Running analysis in sandbox...</span>
        </div>
        {input?.code && <CodeBlock code={input.code} label="Executing" />}
      </div>
    );
  }

  if (state === "output-available") {
    const output = part.output as
      | {
          success?: boolean;
          chartIds?: string[];
          error?: string;
          hint?: string;
          _meta?: { model?: string; durationMs?: number };
        }
      | undefined;

    const meta = output?._meta;
    const chartCount = output?.chartIds?.length ?? 0;

    return (
      <div className="my-2">
        {input?.analysisDescription && (
          <p className="text-xs text-gray-500 mb-2 italic">
            {input.analysisDescription}
          </p>
        )}
        {input?.code && (
          <CodeBlock
            code={input.code}
            label={
              output?.success
                ? `${chartCount} chart${chartCount !== 1 ? "s" : ""} in ${((meta?.durationMs ?? 0) / 1000).toFixed(1)}s`
                : "Failed"
            }
            success={output?.success}
          />
        )}
        {meta && (
          <div className="flex items-center gap-2 mt-1.5">
            {meta.model && <ModelBadge model={meta.model} />}
            {meta.durationMs != null && (
              <span className="text-[10px] text-gray-400 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5">
                {(meta.durationMs / 1000).toFixed(1)}s sandbox
              </span>
            )}
          </div>
        )}
        {output?.error && <ErrorBadge text={output.error} />}
      </div>
    );
  }

  if (state === "output-error") {
    return (
      <div className="my-2">
        {input?.code && (
          <CodeBlock code={input.code} label="Failed" success={false} />
        )}
        <ErrorBadge text={part.errorText ?? "Analysis execution failed"} />
      </div>
    );
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ComposeReportPart({ part }: { part: any }) {
  const state: string = part.state;

  if (state === "input-streaming" || state === "input-available") {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
        <Spinner />
        <span>Writing report...</span>
      </div>
    );
  }

  if (state === "output-available") {
    const meta = part.output?._meta as { model?: string } | undefined;
    return (
      <div className="border border-gray-100 rounded-lg p-3 my-2 bg-gray-50">
        <div className="flex items-center gap-2 text-xs font-medium text-gray-600">
          <CheckIcon />
          <span>Report ready</span>
          {meta?.model && <ModelBadge model={meta.model} />}
        </div>
      </div>
    );
  }

  if (state === "output-error") {
    return <ErrorBadge text={part.errorText ?? "Failed to compose report"} />;
  }

  return null;
}

function CodeBlock({
  code,
  label,
  success,
}: {
  code: string;
  label: string;
  success?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const statusColor =
    success === true
      ? "text-green-600 bg-green-50 border-green-200"
      : success === false
        ? "text-red-600 bg-red-50 border-red-200"
        : "text-gray-500 bg-gray-50 border-gray-200";

  return (
    <div
      className={`border rounded-lg overflow-hidden ${success === false ? "border-red-200" : "border-gray-200"}`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono ${statusColor} hover:opacity-80 transition-opacity`}
      >
        <span className="flex items-center gap-1.5">
          {success === true && <CheckIcon />}
          {success === false && <XIcon />}
          {success === undefined && <Spinner />}
          Python
        </span>
        <span className="flex items-center gap-2">
          <span className="font-sans">{label}</span>
          <span>{expanded ? "▾" : "▸"}</span>
        </span>
      </button>
      {expanded && (
        <pre className="p-3 text-xs font-mono text-gray-700 bg-white overflow-x-auto max-h-80 overflow-y-auto">
          {code}
        </pre>
      )}
    </div>
  );
}

function ErrorBadge({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 100 ? text.slice(0, 100) + "..." : text;

  return (
    <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left"
      >
        {expanded ? text : preview}
      </button>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-3 w-3 text-gray-400"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg
      className="h-3 w-3 text-amber-600"
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="h-3 w-3 text-green-600"
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      className="h-3 w-3 text-red-600"
      viewBox="0 0 20 20"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ModelBadge({ model }: { model: string }) {
  const shortName = model.split("/").pop() ?? model;
  return (
    <span className="text-[10px] text-gray-400 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5 font-mono">
      {shortName}
    </span>
  );
}
