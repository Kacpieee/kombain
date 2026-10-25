import { z } from "zod";

export const CATEGORIES = [
  "AI i Automatyzacja",
  "Rolnictwo Precyzyjne",
  "Inteligentne Maszyny i Drony",
  "Biotechnologia i Nauka",
  "Agroenergetyka",
  "Biznes AgTech i Prawo",
] as const;

export const GatekeeperSchema = z.object({
  is_duplicate: z.boolean(),
  is_relevant: z.boolean(),
  reason: z.string(),
  category: z.enum(CATEGORIES),
});
export type GatekeeperDecision = z.infer<typeof GatekeeperSchema>;

export const EditorSchema = z.object({
  title: z.string().max(60),
  content_html: z.string(),
  tldr: z.array(z.string()).min(3).max(5),
  tags: z.array(z.string()).max(4),
  tech_summary: z.object({ podmiot: z.string(), technologia: z.string(), cel_wdrozenia: z.string() }),
  slug: z.string(),
  external_refs: z.array(z.object({ claim: z.string(), type: z.string(), source: z.string() })).default([]),
});
export type EditorOut = z.infer<typeof EditorSchema>;

export const CATEGORY_PERSONAS: Record<(typeof CATEGORIES)[number], { expertise: string; tech: string }> = {
  "AI i Automatyzacja": { expertise: "ML, głębokie sieci neuronowe, Computer Vision, automatyzacja decyzji.", tech: "AI, predykcja, automatyzacja systemowa." },
  "Rolnictwo Precyzyjne": { expertise: "GIS, teledetekcja, VRA, IoT.", tech: "Agronomia cyfrowa, Big Data, telemetria." },
  "Inteligentne Maszyny i Drony": { expertise: "Mechatronika, RTK/GNSS, LiDAR, robotyka polowa, UAV.", tech: "Mechatronika, nawigacja, sensoryka, drony." },
  "Biotechnologia i Nauka": { expertise: "Inżynieria genetyczna, CRISPR-Cas, mikrobiologia gleby, in-vitro.", tech: "Genetyka, biochemia, badania." },
  "Agroenergetyka": { expertise: "OZE, Agri-PV, biogaz/biometan, magazyny, mikrosieci.", tech: "Energetyka, wodór, efektywność OZE." },
  "Biznes AgTech i Prawo": { expertise: "SaaS/AgTech finance, M&A, VC, compliance dronów/AI.", tech: "Strategie rynkowe, skalowanie, prawo nowych technologii." },
};

export interface GatekeeperPromptInput {
  title: string;
  text: string;
  sourceUrl: string;
  history: Array<{ title: string; tech_summary: unknown }>;
}

/** Prompt Bramkarza (Dokumentacja §4 KROK 3): dedup 30 dni + hard filter + kategoria z enuma. */
export function buildGatekeeperPrompt(input: GatekeeperPromptInput): string {
  const history = input.history.length
    ? input.history.map((item) => `- ${item.title} | ${summarizeTechSummary(item.tech_summary)}`).join("\n")
    : "(brak opublikowanych artykułów w ostatnich 30 dniach)";

  return `Oceń, czy nowy artykuł to duplikat informacyjny (tzw. news echo) na podstawie bazy opublikowanych już technologii, oraz czy spełnia rygorystyczne kryteria tematyczne portalu kombain.pl.

BAZA WIEDZY (opublikowane wpisy z ostatnich 30 dni):
${history}

NOWY ARTYKUŁ:
Tytuł: ${input.title}
URL źródła: ${input.sourceUrl}
Treść: ${input.text}

Reguły decyzyjne:
1. DEDUPLIKACJA: jeśli podmiot i technologia w nowym artykule pokrywają się z jakimkolwiek wpisem w bazie wiedzy, ustaw "is_duplicate" na true.
2. ADEKWATNOŚĆ (HARD FILTER): portal kombain.pl skupia się wyłącznie na zaawansowanym AgTech. Odrzuć artykuł (is_relevant = false), jeśli dotyczy: raportów rynkowych, cen płodów rolnych, giełdy, strajków, standardowych dopłat, zwykłych maszyn rolniczych bez komponentu "Smart" (nowy pług, heder, tradycyjny traktor bez autonomii). Zaakceptuj (true) tylko AI, IoT, autonomię, drony, robotykę, biotechnologię, agroenergetykę, oprogramowanie dla rolnictwa, finansowanie VC/M&A w AgTech lub prawo nowych technologii.
3. KATEGORYZACJA: przypisz dokładnie jedną kategorię z listy: ${CATEGORIES.map((category) => `"${category}"`).join(", ")}. Do "Biznes AgTech i Prawo" przypisuj wyłącznie finansowanie startupów, przejęcia w AgTech lub regulacje dla nowych technologii (prawo dronowe, AI); zwykłe prawo rolne odrzucaj (is_relevant = false).

Zwróć wyłącznie JSON z polami: is_duplicate (boolean), is_relevant (boolean), reason (krótkie uzasadnienie), category (dokładna nazwa z listy).`;
}

function summarizeTechSummary(techSummary: unknown): string {
  const text = typeof techSummary === "string" ? techSummary : JSON.stringify(techSummary ?? {});
  return text.slice(0, 300);
}
