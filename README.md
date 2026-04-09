# Marketing Analytics Agent

An AI agent that turns natural-language questions into computed marketing reports with charts. Upload a CSV of campaign data, ask a question, and get a structured analysis — ROAS breakdowns, trend decomposition, anomaly detection — with inline visualizations.

Built with the Vercel AI SDK, Vercel Sandbox, and Next.js 16.

## Getting Started

**Prerequisites:** Node.js 20+, a Vercel AI Gateway API key

```
cp .env.example .env.local
# Add your AI_GATEWAY_API_KEY
npm install
npm run dev
```

The app loads a bundled marketing dataset on startup. Upload a different CSV at any time.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Next.js App Router                  │
│                                                         │
│  ┌──────────────┐          ┌──────────────────────────┐ │
│  │   Chat UI    │◄────────►│  Report Panel            │ │
│  │              │          │  - Markdown (remark-gfm) │ │
│  │  useChat()   │          │  - Inline charts (base64)│ │
│  │  Transport   │          │  - Fullscreen zoom       │ │
│  └──────┬───────┘          └──────────────────────────┘ │
│         │                                               │
│  ┌──────▼───────────────────────────────────────────┐   │
│  │              /api/chat (POST)                    │   │
│  │                                                  │   │
│  │  streamText() with 3 tools:                      │   │
│  │                                                  │   │
│  │  1. planAnalysis  ──► structured plan            │   │
│  │     (needsApproval)   user approves/denies via UI│   │
│  │                                                  │   │
│  │  2. executeAnalysis ──► Python in Sandbox        │   │
│  │     - writes data.csv                            │   │
│  │     - pip install (network open)                 │   │
│  │     - runs analysis (network denied)             │   │
│  │     - reads chart_*.png + JSON findings          │   │
│  │                                                  │   │
│  │  3. composeReport ──► markdown report            │   │
│  │                                                  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Vercel AI Gateway                      │   │
│  │  Routes model strings to providers:              │   │
│  │  anthropic/claude-sonnet-4.6, openai/gpt-4o, etc │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Agent Flow

```
User question
     │
     ▼
┌─────────────-┐    approve    ┌──────────────────┐
│ planAnalysis │──────────────►│ executeAnalysis  │
│ (HITL gate)  │               │ (Python sandbox) │
└──────┬───────┘               └────────┬─────────┘
       │ deny                           │
       ▼                                ▼
  "Refine existing              ┌─────────────-─┐
   report instead"              │ composeReport │
                                │ (markdown)    │
                                └────────────-──┘
```

**Refinement flow:** Follow-up questions skip `planAnalysis` entirely. The model calls only the tools it needs — `composeReport` alone for text edits, or `executeAnalysis` + `composeReport` for chart changes.

## Key Design Decisions

**Human-in-the-loop approval** — New analyses require explicit user approval via the AI SDK's `needsApproval` + `addToolApprovalResponse`. This prevents wasted compute on unwanted analyses and demonstrates the SDK's tool approval primitive.

**Two-phase sandbox networking** — Dependencies install with network access, then `updateNetworkPolicy("deny-all")` locks the sandbox before executing LLM-generated Python. The code never has network access.

**Per-tool model routing** — Plan/analysis uses a fast/cheap model (Haiku), code generation uses a capable model (Sonnet). Both are configurable from the UI via Vercel AI Gateway model strings.

**Inline chart embedding** — The report panel parses chart references from markdown and renders base64 images inline where they're discussed, rather than appending them at the bottom.

**Model fallback** — If the primary code generation model errors, the route falls back to an alternate provider automatically.

## Eval

The eval harness imports the same `createTools` and `SYSTEM_PROMPT` used in production — no duplicated tool definitions. It runs with `requireApproval: false` to skip HITL, but otherwise exercises the identical agent code path.

Three evaluation layers across 7 test cases:

1. **Structural** — Asserts execution succeeds and generated code contains expected substrings (e.g. `bar`, `revenue`, `spend` for a ROAS chart)
2. **Hallucination guard** — Parses column references from generated code and verifies none reference columns absent from the dataset
3. **LLM-as-judge** — Scores code quality, chart appropriateness, and rubric adherence on a 1-5 scale, with written reasoning

```
npm run eval
```

Outputs both a JSON file and an HTML report to `eval/results/`. The HTML report includes summary stats, per-case pass/fail detail with judge reasoning, expandable generated code, and tool call sequences. A `latest.html` copy is always kept for quick access.

## Tech Stack

| Layer     | Technology                                            |
| --------- | ----------------------------------------------------- |
| Framework | Next.js 16 (App Router, Fluid Compute)                |
| AI SDK    | Vercel AI SDK v6 (`streamText`, `tool`, `useChat`)    |
| Sandbox   | `@vercel/sandbox` (Firecracker microVMs, Python 3.13) |
| Gateway   | Vercel AI Gateway (multi-provider model routing)      |
| Frontend  | React 19, Tailwind CSS 4, react-markdown              |
| Eval      | Custom harness with `generateText` + LLM-as-judge     |
