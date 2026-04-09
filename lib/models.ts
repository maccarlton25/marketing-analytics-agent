export const MODELS = [
  { id: "anthropic/claude-sonnet-4.6", label: "Sonnet 4.6", tier: "Balanced" },
  { id: "anthropic/claude-haiku-4-5", label: "Haiku 4.5", tier: "Fast" },
  { id: "openai/gpt-5.4", label: "GPT-5.4", tier: "Balanced" },
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano", tier: "Fast" },
  { id: "google/gemini-3-flash", label: "Gemini 3 Flash", tier: "Fast" },
];

const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

export function resolveModel(value: string | undefined, fallback: string): string {
  if (value && ALLOWED_MODEL_IDS.has(value)) return value;
  return fallback;
}
