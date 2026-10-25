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
  external_refs: z
    .array(
      z.object({
        claim: z.string(),
        type: z.enum(["external", "supported"]).default("external"),
        source: z.string().default(""),
      })
    )
    .default([]),
});
export type EditorOut = z.infer<typeof EditorSchema>;

export const R1Schema = z.object({
  pass: z.boolean(),
  issues: z.array(z.string()).default([]),
});
export type R1Decision = z.infer<typeof R1Schema>;

export const AtomType = z.enum(["supported", "external", "inference"]);
export const R2AtomSchema = z.object({
  text: z.string(),
  type: AtomType,
  evidence: z.string().default(""),
});
export const R2Schema = z.object({ atoms: z.array(R2AtomSchema) });
export type R2Atom = z.infer<typeof R2AtomSchema>;

export const R3Schema = z.object({
  results: z.array(
    z.object({
      claim: z.string(),
      verdict: z.enum(["confirmed", "refuted", "uncertain"]),
      evidence_url: z.string().default(""),
    })
  ),
});
export type R3Result = z.infer<typeof R3Schema>;

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

export type Category = (typeof CATEGORIES)[number];

export interface EditorPromptInput {
  category: Category;
  originalTitle: string;
  articleText: string;
}

/** Redaktor: 1 szablon × persona działu (Dokumentacja §4.2). Link źródła dokleja kod, nie model. */
export function buildEditorPrompt(input: EditorPromptInput): string {
  const persona = CATEGORY_PERSONAS[input.category];

  return `Działasz jako Redaktor Działu "${input.category}" na portalu AgTech kombain.pl. Jesteś ekspertem od: ${persona.expertise}

Twoim zadaniem jest napisanie pełnowymiarowego, autorskiego artykułu eksperckiego w języku polskim, bazującego na poniższych materiałach źródłowych. Kategorycznie zabraniam streszczania tekstu i tłumaczenia go słowo w słowo. Masz stworzyć niezależną, wyczerpującą publikację opartą na faktach ze źródła, dostosowaną do świadomego technologicznie rolnika i przedsiębiorcy.

DANE ŹRÓDŁOWE:
Tytuł oryginału: ${input.originalTitle}
Treść źródłowa: ${input.articleText}

WYTYCZNE TREŚCIOWE (klucz 'content_html'):
1. Wstęp z hookiem: 3-5 zdań otwierających z mocnym haczykiem (statystyka, problem biznesowy, zaskoczenie). Od razu pokaż wartość wdrożeniową.
2. Struktura HTML: używaj wyłącznie tagów <p>, <h2>, <h3>, <strong>, <em>, <ul>, <ol>, <li>. Samodzielnie zbuduj logiczną architekturę nagłówków.
3. Rozwinięcie: pełny, merytoryczny artykuł. Każdy nagłówek H2/H3 zaczyna się angażującym zdaniem. Uzupełniaj treść o tło technologiczne z zakresu: ${persona.tech}, analizując surowe fakty z tekstu.
4. Styl: ekspercki, technologiczny, analityczny. Bez języka sprzedażowego i lania wody.
5. Zakończenie: konkretne wnioski o wdrożeniu technologii lub wpływie na rynek.

WYTYCZNE METADANYCH:
1. 'title': maks. 60 znaków, chwytliwy tytuł po polsku pod SEO.
2. 'slug': małe litery, myślniki, bez polskich znaków, tylko [a-z0-9-].
3. 'tldr': dokładnie 3-5 krótkich wniosków technicznych (tablica stringów).
4. 'tags': maks. 4 tagi, małymi literami.
5. 'tech_summary': obiekt z kluczami "podmiot", "technologia", "cel_wdrozenia".
6. 'external_refs': **tylko weryfikowalne** fakty spoza tekstu źródłowego — konkretna liczba, data, nazwa firmy/osoby, regulacja albo badanie z nazwą i rokiem. Nie umieszczaj tu ogólnych twierdzeń przyczynowych, ocen ani przewidywań („przestój oznacza kary umowne") — te należą do treści jako opinia i nie są weryfikowane w sieci. Format: {claim, type, source}, gdzie type = "external" tylko dla faktów spoza źródła, "supported" gdy źródło wprost je potwierdza. Nie wymyślaj źródeł.

Nie dodawaj linku "Źródło:" ani URL-i — kod dokleja je deterministycznie z source_url.
Zwróć wyłącznie JSON z kluczami: title, content_html, tldr, tags, tech_summary, slug, external_refs.`;
}

/** R1 technical: HTML/meta/struktura, bez wyszukiwania w sieci. */
export function buildR1Prompt(article: EditorOut): string {
  return `Jesteś recenzentem technicznym portalu kombain.pl. Oceń artykuł bez wyszukiwania w sieci.

Tytuł: ${article.title}
Slug: ${article.slug}
TL;DR: ${JSON.stringify(article.tldr)}
Tagi: ${JSON.stringify(article.tags)}
Tech summary: ${JSON.stringify(article.tech_summary)}
External refs: ${JSON.stringify(article.external_refs)}

HTML:
${article.content_html}

Sprawdź: (1) tylko tagi p, h2, h3, strong, em, ul, ol, li; (2) tytuł <= 60 znaków; (3) tldr 3-5 pozycji; (4) tagi <= 4, małe litery; (5) tech_summary kompletne; (6) struktura ma wstęp, co najmniej dwa nagłówki i zakończenie; (7) brak linku "Źródło:" i URL-i w treści; (8) brak treści sprzedażowej.
Zwróć JSON: {"pass": boolean, "issues": string[]}.`;
}

/** R2 extract: atomy supported-by-source / external / inference, bez wyszukiwania. */
export function buildR2Prompt(article: EditorOut, sourceText: string): string {
  return `Jesteś recenzentem faktograficznym. Rozbij artykuł na atomy twierdzeń i oznacz każde bez wyszukiwania w sieci.

ARTYKUŁ (HTML):
${article.content_html}

TEKST ŹRÓDŁOWY:
${sourceText}

Dla każdego atomu (tylko twierdzenia faktograficzne i opinie, nie każde zdanie) wskaż:
- "text" — **DOSŁOWNY fragment artykułu skopiowany znak w znak** (bez parafrazy, bez zmiany kolejności słów, bez skracania w środku zdania). **Bez tagów HTML** — tylko widoczny tekst; jeśli w zdaniu są <strong>/<em>, pomiń znaczniki, zachowaj słowa.
- "supported" — wprost wynika z tekstu źródłowego (evidence: krótki cytat ze źródła),
- "external" — **weryfikowalny** fakt spoza źródła: konkretna liczba, data, nazwa firmy/osoby/technologii, regulacja lub badanie. NIE oznaczaj jako external ogólnych twierdzeń przyczynowych, ocen, przewidywań ani skutków biznesowych („przestój oznacza kary umowne") — to jest inference.
- "inference" — wniosek/opinia/przewidywanie autora bez dowodu (evidence puste).

Zasady zgłaszania: maks. 20 atomów typu supported/external (priorytet: external, potem supported). Atomy typu inference zgłaszaj **zawsze**, nawet jeśli limit został wyczerpany — muszą być wycięte z artykułu przed publikacją.
Zwróć JSON: {"atoms": [{"text": "...", "type": "supported|external|inference", "evidence": "..."}]}.`;
}

/** R3 verify: wyłącznie atomy external, z search grounding. */
export function buildR3Prompt(atoms: R2Atom[]): string {
  const claims = atoms.map((atom, index) => `${index + 1}. ${atom.text}`).join("\n");
  return `Zweryfikuj w internecie poniższe twierdzenia. Dla każdego podaj verdict i URL dowodu.

${claims}

Zasady: "confirmed" tylko przy jednoznacznym potwierdzeniu w wiarygodnym źródle; "refuted" gdy źródła przeczą; "uncertain" gdy brak rozstrzygającego dowodu. Nie zgaduj.
Zwróć JSON: {"results": [{"claim": "...", "verdict": "confirmed|refuted|uncertain", "evidence_url": "https://..."}]}.`;
}
