# Marketing Analytics Agent

Enterprise marketing teams rely on analysts to turn raw campaign data into actionable reports. ROAS breakdowns, trend analysis, anomaly detection, and more. The turnaround is slow: marketers export data from their martech stack, file a request, and wait days for a notebook or slide deck to come back.

This agent eliminates that bottleneck. Marketers upload a CSV, ask a question in plain English, and get a computed analysis report with charts in minutes. No code, no SQL, no notebooks. Reports can be refined conversationally and exported as PDFs for internal distribution.

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
┌──────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│                                                              │
│  ┌──────────────┐          ┌───────────────────────────────┐ │
│  │   Chat UI    │◄────────►│  Report Panel                 │ │
│  │  useChat()   │          │  Markdown + charts + PDF      │ │
│  └──────┬───────┘          └───────────────────────────────┘ │
│         │ messages[] + csvText (full state each request)     │
└─────────┼────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  Vercel Function (Fluid)        │
│                                 │
│  /api/chat — streamText()       │
│  maxDuration: 180s              │
│  up to 8 steps (w/ retries)     │
│                                 │
└──────┬──────────────┬───────────┘
       │              │
       ▼              ▼
┌──────────────┐    ┌─────────────────────────────────┐
│  AI Gateway  │    │  Vercel Sandbox (per-request)   │
│              │    │  Firecracker microVM (Hive)     │
│  Model       │    │  Python 3.13, 3-min timeout     │
│  routing     │    │                                 │
└──────┬───────┘    │  1. Init on firs call:          │
       │            │     pip install (network open)  │
       ▼            │  2. deny-all network policy     │
┌──────────────┐    │  3. Run LLM-generated code      │
│ LLM Provider │    │  4. Reuse VM across retries     │
│ Anthropic /  │    │  5. Stop on stream end/abort    │
│ OpenAI       │    └─────────────────────────────────┘
└──────────────┘
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

Each POST to `/api/chat` gets one [Vercel Sandbox](https://vercel.com/docs/sandbox) session running Python 3.13 with a 3-minute timeout that matches the Vercel Function's `maxDuration`. The session is scoped to the request, created on first use, reused across retries within the same `streamText` loop (agent turn), and torn down when the response finishes.

**Lifecycle:**

1. **Lazy init on first `executeAnalysis` call.** The VM is created, `data.csv` is written, and `pip install` runs with network access to fetch dependencies: `matplotlib`, `pandas`, `scipy`, `statsmodels`, `scikit-learn`. This is the expensive step (~20s) and happens at most once per request. If the plan is denied or the turn doesn't need code execution, no VM is ever spun up.
2. **Network locked** — `updateNetworkPolicy("deny-all")` cuts all network access before any LLM-generated code executes.
3. **Reused across retries.** If the model's first script errors and it calls `executeAnalysis` again, the same warm VM runs the fixed code — skipping the ~20s pip install tax. Stale `chart_*.png` files are wiped before each run so outputs don't leak between attempts. Each run is still a fresh `python3` process, so there are no in-memory globals to worry about either.
4. **Stopped when the request ends.** `stopSession()` is wired to `streamText`'s `onFinish`, `onError`, and `onAbort` callbacks via Next.js 16's `after()`, plus a `req.signal` abort listener for client disconnects. Whichever fires first wins — the `stop()` function is idempotent, so extra calls are no-ops. `after()` is important here: without it, the fire-and-forget teardown promise gets dropped when the response closes and the VM leaks until its 3-minute self-timeout kicks in. `after()` keeps the promise alive past response completion without blocking the client.
5. **No cross-turn reuse.** The session handle lives inside the per-request `createTools()` closure — a new POST (= new user message) always gets a fresh VM. This is a deliberate choice: sandbox lifetime doesn't line up with conversation lifetime, cross-request state would need an external store, and leaked VMs are worse than a ~20s init cost on the first `executeAnalysis` of each turn.

**Safety net:** the `timeout: 3 * 60 * 1000` passed to `Sandbox.create()` auto-terminates the VM at the 3-minute mark even if our cleanup code somehow misses it. The Vercel Function's `maxDuration: 180` is aligned to the same ceiling.

**What the LLM-generated code can access:** the pre-loaded `df` DataFrame, the installed Python packages, and the local filesystem. It cannot make network requests, access environment variables, or reach any external service.

## Key Design Decisions

**General-purpose tool design** — `executeAnalysis` exposes a Python sandbox as a primitive, not a procedure. Rather than encoding specific analysis types as separate tools, the model decides what to compute and how to visualize it. This makes the agent flexible without adding new tools, but shifts correctness to code generation — which is why the retry loop, stdout contract, and sandboxing exist. Generality at the tool level is only viable because execution is locked down at the infrastructure level.

**Human-in-the-loop approval** — New analyses require explicit user approval via the AI SDK's `needsApproval` + `addToolApprovalResponse`. This prevents wasted compute on unwanted analyses and demonstrates the SDK's tool approval primitive.

**Two-phase sandbox networking** — Dependencies install with network access, then `updateNetworkPolicy("deny-all")` locks the sandbox before executing LLM-generated Python. The code never has network access.

**Self-healing code execution** — `streamText` runs with `stopWhen: stepCountIs(8)`. A normal flow takes 3 steps (plan → execute → compose), leaving 5 spare steps for retries. When Python code errors, the sandbox returns the error and stdout to the model, which fixes the code and calls `executeAnalysis` again. Retries reuse the same sandbox VM within a request, so a retry only pays the Python execution cost (~1-2s) rather than the full init cost (~20s pip install). Chart files from the failed run are wiped before each attempt, and the Python process is fresh each call, so there's no in-memory state leakage between retries. The VM is still torn down at the end of every request.

**Per-tool model routing** — Plan/analysis uses a fast/cheap model (Haiku), code generation uses a capable model (Sonnet). Both are configurable from the UI via Vercel AI Gateway model strings. Available models include Anthropic (Sonnet 4.6, Haiku 4.5) and OpenAI (GPT-5.4, GPT-5.4 Nano).

**Context-safe chart delivery** — Chart base64 PNGs (100KB+ each) are returned in the `executeAnalysis` tool result so they stream to the client, but `toModelOutput` strips them before the model sees them — the model only gets chart IDs and findings. On subsequent turns, `convertToModelMessages` applies the same `toModelOutput` transform to previous tool results, so base64 never enters the context window. Without this, a single 3-chart analysis can add 200K+ tokens to context.

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

## Vercel Platform Usage

**Fluid Compute** — The chat route sets `maxDuration: 180` for long-running multi-step agent calls..

**Vercel AI SDK v6** — Core primitives used throughout:

- `streamText` + `toUIMessageStreamResponse` for streaming tool-call results to the client
- `tool` with `inputSchema` (Zod) for structured tool definitions shared between prod and eval
- `needsApproval` + `addToolApprovalResponse` for human-in-the-loop plan approval
- `useChat` + `DefaultChatTransport` on the client with `sendAutomaticallyWhen` to auto-resume after approval
- `stopWhen: stepCountIs(8)` to bound agent loops while allowing retries
- `prepareStep` to route step 0 (plan generation) to a cheaper/faster model
- `convertToModelMessages` for server-side message format conversion
- `generateText` in the eval harness (same tools, no streaming needed)

**Vercel AI Gateway** — Model strings like `anthropic/claude-sonnet-4.6` and `openai/gpt-5.4` route through the gateway, providing a single API key for multiple providers. Models are configurable from the UI — "Model" controls the primary model, "Planner" controls the plan generation step.

**Vercel Sandbox** — Each chat request creates one Vercel Sandbox session (`@vercel/sandbox`, Python 3.13, 3-min timeout) on the first `executeAnalysis` call and reuses it across retries within the same `streamText` loop. Dependencies install with network access, then `updateNetworkPolicy("deny-all")` locks the VM before any LLM-generated code runs. The session is scoped to the request lifetime. Nothing is shared across conversation turns.
