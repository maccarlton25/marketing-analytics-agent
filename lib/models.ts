/** Shared model allowlist — used by the route for server-side validation and the UI for the selector. */
export const ALLOWED_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-nano",
] as const;

export type ModelId = (typeof ALLOWED_MODELS)[number];

export function isAllowedModel(model: string): model is ModelId {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}
