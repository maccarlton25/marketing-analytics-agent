"use client";
import { useState, useCallback, useEffect, useRef, useMemo, FormEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import FileUpload from "@/components/FileUpload";
import ReportPanel from "@/components/ReportPanel";
import MessagePart from "@/components/MessagePart";

const MODELS = [
  { id: "anthropic/claude-sonnet-4.6", label: "Sonnet 4.6", tier: "Balanced" },
  { id: "anthropic/claude-haiku-4-5", label: "Haiku 4.5", tier: "Fast" },
  { id: "openai/gpt-5.4", label: "GPT-5.4", tier: "Balanced" },
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano", tier: "Fast" },
  { id: "google/gemini-3-flash", label: "Gemini 3 Flash", tier: "Fast" },
];

const SUGGESTED_PROMPTS = [
  { label: "Channel ROAS", prompt: "Which channels have the best ROAS? Rank them and identify underperformers." },
  { label: "MoM Trends", prompt: "Show me month-over-month revenue trends by channel with growth rates." },
  { label: "Campaign Efficiency", prompt: "Compare campaign efficiency — which campaigns have the best cost per conversion?" },
  { label: "Regional Breakdown", prompt: "Break down performance by region. Where should we invest more?" },
];

export default function Home() {
  const [csvText, setCsvText] = useState<string | null>(null);
  const [schemaDescription, setSchemaDescription] = useState<string | null>(null);
  const [datasetName, setDatasetName] = useState<string>("Marketing Campaigns");
  const [isUploading, setIsUploading] = useState(false);
  const [input, setInput] = useState("");
  const [analyzeModel, setSchemaModel] = useState(MODELS[1].id);
  const [codeGenModel, setCodeGenModel] = useState(MODELS[0].id);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const csvRef = useRef(csvText);
  const schemaRef = useRef(schemaDescription);
  const analyzeModelRef = useRef(analyzeModel);
  const codeGenModelRef = useRef(codeGenModel);
  csvRef.current = csvText;
  schemaRef.current = schemaDescription;
  analyzeModelRef.current = analyzeModel;
  codeGenModelRef.current = codeGenModel;

  // Auto-load demo CSV on mount via the upload API for proper schema detection
  useEffect(() => {
    if (csvRef.current) return;
    fetch("/demo.csv")
      .then((res) => {
        if (!res.ok) throw new Error("not found");
        return res.blob();
      })
      .then((blob) => {
        const formData = new FormData();
        formData.append("file", blob, "demo.csv");
        return fetch("/api/upload", { method: "POST", body: formData });
      })
      .then((res) => res.json())
      .then((data) => {
        if (!csvRef.current) {
          setCsvText(data.csvText);
          setSchemaDescription(data.schemaDescription);
          setDatasetName(data.datasetName ?? "Marketing Campaigns");
        }
      })
      .catch(() => {
        // demo.csv not available, user must upload manually
      });
  }, []);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: () => ({
          csvText: csvRef.current,
          schemaDescription: schemaRef.current,
          analyzeModel: analyzeModelRef.current,
          codeGenModel: codeGenModelRef.current,
        }),
      }),
    [],
  );

  const { messages, setMessages, sendMessage, status, error, clearError, addToolApprovalResponse } = useChat({
    transport,
    sendAutomaticallyWhen: ({ messages: msgs }) => {
      const last = msgs[msgs.length - 1];
      if (last?.role !== "assistant") return false;
      return last.parts.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p: any) => p.state === "approval-responded" && p.approval?.approved === true,
      );
    },
  });

  const isLoading = status === "submitted" || status === "streaming";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getToolName = (part: any): string | null => {
    if (part.toolName) return part.toolName;
    if (typeof part.type === "string" && part.type.startsWith("tool-"))
      return part.type.slice(5);
    return null;
  };

  // Extract report markdown and charts, but suppress stale data when a new analysis is running
  const { reportMarkdown, reportCharts } = useMemo(() => {
    let markdown: string | null = null;
    let charts: { id: string; base64: string }[] = [];
    let hasInFlightAnalysis = false;

    for (const msg of messages) {
      if (msg.role !== "assistant") continue;

      for (const part of msg.parts) {
        const toolName = getToolName(part);
        if (!toolName) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = part as any;

        // Detect if a new executeAnalysis is currently running (not yet finished)
        if (
          toolName === "executeAnalysis" &&
          (p.state === "input-streaming" || p.state === "input-available")
        ) {
          hasInFlightAnalysis = true;
          // Clear previous results — new ones are coming
          markdown = null;
          charts = [];
        }

        if (
          toolName === "composeReport" &&
          p.state === "output-available" &&
          p.output?.markdown
        ) {
          markdown = p.output.markdown as string;
        }

        if (
          toolName === "executeAnalysis" &&
          p.state === "output-available" &&
          Array.isArray(p.output?.charts)
        ) {
          charts = p.output.charts as { id: string; base64: string }[];
        }
      }
    }

    // If an analysis is in-flight but hasn't produced output yet, show nothing
    if (hasInFlightAnalysis && !markdown && charts.length === 0) {
      return { reportMarkdown: null, reportCharts: [] };
    }

    return { reportMarkdown: markdown, reportCharts: charts };
  }, [messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleApproval = useCallback(
    (id: string, approved: boolean) => {
      addToolApprovalResponse({
        id,
        approved,
        reason: approved ? undefined : "User chose to refine the existing report instead.",
      });
    },
    [addToolApprovalResponse],
  );

  const handleFileUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    setCsvText(data.csvText);
    setSchemaDescription(data.schemaDescription);
    setDatasetName(data.datasetName ?? file.name.replace(/\.csv$/i, ""));
    setIsUploading(false);
  }, []);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!input.trim() || isLoading) return;
      sendMessage({ text: input });
      setInput("");
    },
    [input, isLoading, sendMessage],
  );

  const handleSuggestedPrompt = useCallback(
    (prompt: string) => {
      if (isLoading) return;
      sendMessage({ text: prompt });
    },
    [isLoading, sendMessage],
  );

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-8">
        {/* Header */}
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Marketing Analytics Agent</h1>
            <p className="text-gray-500 text-sm mt-1">
              AI-powered campaign analysis — ask questions, get reports with charts
            </p>
          </div>
          <div className="flex items-center gap-4">
            {csvText && messages.length === 0 && (
              <>
                <ModelSelect
                  label="Planner"
                  value={analyzeModel}
                  onChange={setSchemaModel}
                  disabled={isLoading}
                />
                <ModelSelect
                  label="Model"
                  value={codeGenModel}
                  onChange={setCodeGenModel}
                  disabled={isLoading}
                />
              </>
            )}
          </div>
        </div>

        {!csvText ? (
          /* Landing / loading state while demo CSV auto-loads */
          <div className="flex flex-col items-center justify-center py-24 text-center max-w-lg mx-auto">
            <div className="w-12 h-12 rounded-xl bg-black flex items-center justify-center mb-6">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" /><path d="M7 16l4-8 4 5 2-3 4 6" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Loading dataset...</h2>
            <p className="text-sm text-gray-500 mb-6">
              A sample marketing dataset is loading automatically.
            </p>
            <div className="pt-4 border-t border-gray-200 w-full">
              <p className="text-xs text-gray-400 mb-3">Or bring your own data</p>
              <FileUpload onUpload={handleFileUpload} isLoading={isUploading} />
            </div>
          </div>
        ) : messages.length === 0 ? (
          /* Zero state — introduce the agent before first message */
          <div className="max-w-2xl mx-auto py-12">
            <div className="text-center mb-10">
              <div className="w-14 h-14 rounded-xl bg-black flex items-center justify-center mx-auto mb-5">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" /><path d="M7 16l4-8 4 5 2-3 4 6" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold text-gray-900 mb-2">
                What would you like to analyze?
              </h2>
              <p className="text-gray-500 text-sm leading-relaxed max-w-md mx-auto">
                Ask a question about your marketing data. The agent will propose an analysis plan,
                execute Python code in a sandbox, and deliver a report with charts.
              </p>
            </div>

            {/* Suggested prompts */}
            <div className="grid grid-cols-2 gap-3 mb-8">
              {SUGGESTED_PROMPTS.map((sp) => (
                <button
                  key={sp.label}
                  onClick={() => handleSuggestedPrompt(sp.prompt)}
                  className="text-left p-4 rounded-xl border border-gray-200 bg-white
                             hover:border-gray-400 hover:shadow-sm transition-all group"
                >
                  <span className="text-sm font-medium text-gray-800 group-hover:text-black">
                    {sp.label}
                  </span>
                  <span className="block text-xs text-gray-400 mt-1 leading-relaxed">
                    {sp.prompt}
                  </span>
                </button>
              ))}
            </div>

            {/* Input bar */}
            <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about your marketing data..."
                className="flex-1 text-sm text-gray-900 px-4 py-3 border border-gray-200 rounded-xl bg-white
                           placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
              />
              <button
                type="submit"
                disabled={isLoading || !input.trim()}
                className="bg-black text-white px-5 py-3 rounded-xl text-sm
                           disabled:opacity-40 hover:bg-gray-800 transition-colors"
              >
                Send
              </button>
            </form>

            {/* Dataset info + upload */}
            <div className="border border-gray-200 rounded-xl overflow-hidden mb-4">
              <SchemaPreview
                schemaDescription={schemaDescription}
                datasetName={datasetName}
              />
            </div>
            <div className="flex items-center justify-end text-xs text-gray-400">
              <label className="cursor-pointer hover:text-gray-600 transition-colors">
                <span className="underline">Upload different CSV</span>
                <input
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileUpload(file);
                  }}
                />
              </label>
            </div>

            {/* Capabilities */}
            <div className="mt-8 grid grid-cols-3 gap-4 text-center">
              {[
                { title: "Channel Analysis", desc: "ROAS, CAC, spend efficiency across channels and campaigns" },
                { title: "Trend Detection", desc: "Month-over-month growth, seasonality, and anomaly identification" },
                { title: "Segmentation", desc: "Regional breakdowns, funnel analysis, and cohort comparisons" },
              ].map((cap) => (
                <div key={cap.title} className="p-4 rounded-xl bg-gray-50">
                  <p className="text-xs font-medium text-gray-700 mb-1">{cap.title}</p>
                  <p className="text-xs text-gray-400 leading-relaxed">{cap.desc}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-6 h-[calc(100vh-160px)]">
            {/* Left: Chat */}
            <div className="flex flex-col bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
                <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Chat</span>
                <button
                  onClick={() => setMessages([])}
                  className="text-xs text-gray-400 hover:text-gray-700 transition-colors px-2 py-1 rounded hover:bg-gray-50"
                >
                  New chat
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="flex justify-end">
                      <div className="bg-black text-white px-4 py-2 rounded-2xl rounded-br-md text-sm max-w-[80%]">
                        {m.parts
                          .filter((p) => p.type === "text")
                          .map((p, i) => (
                            <span key={i}>{"text" in p ? p.text : ""}</span>
                          ))}
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="space-y-1">
                      {m.parts.map((part, i) => (
                        <MessagePart key={i} part={part} onApproval={handleApproval} />
                      ))}
                    </div>
                  ),
                )}
                {isLoading && messages[messages.length - 1]?.role === "user" && (
                  <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
                    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>Thinking...</span>
                  </div>
                )}
                {error && (
                  <div className="mx-1 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          {error.message?.includes("Insufficient funds")
                            ? "AI Gateway credits exhausted"
                            : "Something went wrong"}
                        </p>
                        <p className="text-xs text-red-500 mt-1">
                          {error.message?.includes("Insufficient funds")
                            ? "Top up your Vercel AI credits to continue."
                            : error.message || "An unexpected error occurred."}
                        </p>
                      </div>
                      <button
                        onClick={clearError}
                        className="text-red-400 hover:text-red-600 text-xs shrink-0"
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Schema + Input */}
              <SchemaPreview
                schemaDescription={schemaDescription}
                datasetName={datasetName}
              />
              <form
                onSubmit={handleSubmit}
                className="border-t border-gray-100 p-3 flex gap-2"
              >
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask about your marketing data..."
                  className="flex-1 text-sm text-gray-900 px-3 py-2 border border-gray-200 rounded-lg bg-white
                             placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
                />
                <button
                  type="submit"
                  disabled={isLoading || !input.trim()}
                  className="bg-black text-white px-4 py-2 rounded-lg text-sm
                             disabled:opacity-40 hover:bg-gray-800 transition-colors"
                >
                  Send
                </button>
              </form>
            </div>

            {/* Right: Report Panel */}
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col">
              <ReportPanel
                markdown={reportMarkdown}
                charts={reportCharts}
                isLoading={isLoading}
              />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function SchemaPreview({
  schemaDescription,
  datasetName,
}: {
  schemaDescription: string | null;
  datasetName: string;
}) {
  const [open, setOpen] = useState(false);
  if (!schemaDescription) return null;

  const lines = schemaDescription.split("\n");
  const summary = lines[0]; // e.g. "21 rows, 9 columns"
  const columns = lines.slice(1); // e.g. "  - month (string)"

  return (
    <div className="border-t border-gray-100">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-gray-400
                   hover:text-gray-600 hover:bg-gray-50 transition-colors"
      >
        <span>
          <span className="font-medium text-gray-500">{datasetName}</span>
          {" — "}{summary}
        </span>
        <span>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-3 pb-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
          {columns.map((col, i) => {
            const match = col.match(/- (.+) \((.+)\)/);
            if (!match) return null;
            return (
              <div key={i} className="flex items-center gap-1.5 text-[11px]">
                <span className="font-mono text-gray-700">{match[1]}</span>
                <span className="text-gray-300">{match[2]}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModelSelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="text-xs text-gray-900 border border-gray-200 rounded-lg px-2 py-1.5 bg-white
                   focus:outline-none focus:ring-2 focus:ring-black disabled:opacity-50"
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} ({m.tier})
          </option>
        ))}
      </select>
    </div>
  );
}
