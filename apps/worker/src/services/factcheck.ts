// R3 search-grounding (3.8 Flash) — implementacja w F2-T4. Ten plik trzyma kontrakt.
export type FactResult = { claim: string; verdict: "confirmed" | "refuted" | "uncertain"; evidenceUrl?: string };
export async function verifyClaimsWithGrounding(_claims: string[]): Promise<FactResult[]> {
  throw new Error("not implemented (F2-T4) — wymaga GEMINI_API_KEY na VPS");
}
