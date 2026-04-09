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

The agent chooses which tools to call based on the request. It is not a fixed pipeline — the model picks the right path each time.

```
                        User question
                             │
                             ▼
                    ┌─────────────────┐
                    │  Agent decides  │
                    │  which tools    │
                    │  to call        │
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
   New analysis?      Chart change?     Text edit?
            │                │                │
            ▼                │                │
   ┌────────────────┐        │                │
   │ planAnalysis   │        │                │
   │                │        │                │
   │ User sees plan │        │                │
   │ in UI:         │        │                │
   │ [Approve][Deny]│        │                │
   └───────┬────────┘        │                │
           │ ✓ approved      │                │
           ▼                 ▼                │
   ┌────────────────────────────┐             │
   │     executeAnalysis        │             │
   │     (Python in Sandbox)    │             │
   └─────────────┬──────────────┘             │
                 │                            │
                 ▼                            ▼
          ┌──────────────────────────────────────┐
          │           composeReport              │
          │         (markdown report)            │
          └──────────────────────────────────────┘
```

**HITL approval** — `planAnalysis` uses the AI SDK's `needsApproval` primitive. The plan streams to the client, the user reviews and clicks Approve or Deny in the UI, and `addToolApprovalResponse` sends the decision back. Only approved plans proceed to execution.

**Refinement** — Follow-up questions skip `planAnalysis` entirely. The model calls only the tools it needs — `composeReport` alone for text edits, or `executeAnalysis` + `composeReport` for chart changes.

## Sandbox

Each `executeAnalysis` call spins up a fresh [Vercel Sandbox](https://vercel.com/docs/sandbox) — a Firecracker microVM running Python 3.13 with a 3-minute timeout.

**Lifecycle:**

1. VM created, CSV data written as `data.csv`
2. **Network open** — `pip install` runs with internet access to fetch dependencies: `matplotlib`, `pandas`, `scipy`, `statsmodels`, `scikit-learn`
3. **Network locked** — `updateNetworkPolicy("deny-all")` cuts all network access before any LLM-generated code executes
4. Analysis runs, charts saved as `chart_*.png`, findings printed as JSON to stdout
5. Host reads chart files and stdout, VM is destroyed

**No sandbox reuse.** Every tool call — including retries on code errors — creates a fresh VM. This means zero state leakage between executions, at the cost of ~20s for dependency installation each time.

**What the LLM-generated code can access:** the pre-loaded `df` DataFrame, the installed Python packages, and the local filesystem. It cannot make network requests, access environment variables, or reach any external service.

## Key Design Decisions

**Human-in-the-loop approval** — New analyses require explicit user approval via the AI SDK's `needsApproval` + `addToolApprovalResponse`. This prevents wasted compute on unwanted analyses and demonstrates the SDK's tool approval primitive.

**Two-phase sandbox networking** — Dependencies install with network access, then `updateNetworkPolicy("deny-all")` locks the sandbox before executing LLM-generated Python. The code never has network access.

**Self-healing code execution** — `streamText` runs with `stopWhen: stepCountIs(6)`. A normal flow takes 3 steps (plan → execute → compose), leaving 3 spare steps for retries. When Python code errors, the sandbox returns the error and stdout to the model, which fixes the code and calls `executeAnalysis` again. Each retry gets a fresh Sandbox — no state is shared between attempts. The tradeoff, of course, being ~30s to re-initialize the sandbox and execute the code.

**Per-tool model routing** — Plan/analysis uses a fast/cheap model (Haiku), code generation uses a capable model (Sonnet). Both are configurable from the UI via Vercel AI Gateway model strings.

**Inline chart embedding** — The report panel parses chart references from markdown and renders base64 images inline where they're discussed, rather than appending them at the bottom.

**Model fallback** — If the primary code generation model errors, the route falls back to an alternate provider automatically.

## Eval

End-to-end evaluation that runs the real agent code. The harness imports the same `createTools` and `SYSTEM_PROMPT` used in production — no duplicated tool definitions. It runs with `requireApproval: false` to skip HITL, but otherwise exercises the identical agent pipeline.

Each test case runs the full scenario (plan → execute → compose), then an **LLM-as-judge** evaluates the complete output — report quality, chart appropriateness, code correctness, and whether the agent handled edge cases (e.g. requests for non-existent columns) — scoring 1-5 with written reasoning.

7 test cases covering: ROAS analysis, scatter plots, trend lines, funnel charts, regional comparisons, hallucination guarding, and cost-per-conversion highlighting.

```
npm run eval                  # run all 7 cases
npm run eval -- --count 2     # run first 2 only
```

Outputs JSON + an HTML report to `eval/results/`. The HTML report includes summary stats (pass rate, average score, duration), per-case detail with judge reasoning, expandable generated code, and tool call sequences. A `latest.html` is always kept for quick access.

## Tech Stack

| Layer     | Technology                                            |
| --------- | ----------------------------------------------------- |
| Framework | Next.js 16 (App Router, Fluid Compute)                |
| AI SDK    | Vercel AI SDK v6 (`streamText`, `tool`, `useChat`)    |
| Sandbox   | `@vercel/sandbox` (Firecracker microVMs, Python 3.13) |
| Gateway   | Vercel AI Gateway (multi-provider model routing)      |
| Frontend  | React 19, Tailwind CSS 4, react-markdown              |
| Eval      | Custom harness with `generateText` + LLM-as-judge     |
