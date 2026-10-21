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
