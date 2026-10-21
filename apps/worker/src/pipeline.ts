export type RunReport = {
  started_at: string;
  sources: number;
  links: number;
  published: number;
  rejected: number;
  draft: number;
  dropped_silent: number;
  fallback_used: number;
  errors: string[];
};

export async function processArticleStub(): Promise<void> {
  // Pełna implementacja w F2-T6 (orchestrator runu). Stub żeby tsc przechodził.
}
