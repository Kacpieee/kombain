const MAX_QUERY_LENGTH = 128;

const STOPWORDS = new Set([
  "oraz",
  "przez",
  "które",
  "który",
  "która",
  "dla",
  "jest",
  "jako",
  "nie",
  "się",
  "ale",
  "także",
  "ponadto",
  "that",
  "with",
  "from",
  "this",
  "have",
  "were",
  "will",
  "their",
  "about",
  "into",
  "more",
  "than",
]);

/** ALL-CAPS rzeczowniki pospolite, które nie są nazwami własnymi/akronimami. */
const ALL_CAPS_STOPLIST = new Set([
  "WZROST",
  "SPADEK",
  "DOTACJE",
  "RAPORT",
  "RYNEK",
  "ROLNICY",
  "DANE",
  "FIRMA",
  "SYSTEM",
  "TECHNOLOGIA",
  "PRODUKCJA",
  "KOSZTY",
  "ZYSK",
]);

/** Spójniki/przysłówki, które nie są encjami nawet gdy stoją na początku zdania. */
const INITIAL_STOPWORDS = new Set([
  "ponadto",
  "jednak",
  "według",
  "dlatego",
  "obecnie",
  "wówczas",
  "natomiast",
  "dodatkowo",
  "następnie",
  "z",
  "kolei",
]);

export interface ClaimEntities {
  quoted: string[];
  numeric: string[];
  proper: string[];
}

export interface ExtractClaimEntitiesOptions {
  /** Guardy bezpieczeństwa potrzebują nazw własnych także na początku zdania. */
  includeSentenceStart?: boolean;
}

/** Akronim/organizacja (NOAA, USDA, EDA, NIFA) — pojedyncza nazwa wystarcza za trafność. */
export function isAcronym(value: string): boolean {
  const letters = value.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters.length <= 6 && letters === letters.toUpperCase();
}

/** Encje claimu: cytaty, liczby/lata i nazwy własne (domyślnie bez wyrazów na początku zdania). */
export function extractClaimEntities(
  claim: string,
  options: ExtractClaimEntitiesOptions = {}
): ClaimEntities {
  const quoted = [...claim.matchAll(/[„"]([^”"]{3,80})[”"]/g)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  const quotedLower = quoted.map((item) => item.toLowerCase());

  const numeric = (
    claim.match(/\b(?:19|20)\d{2}\b|\b\d+(?:[.,]\d+)?\s?(?:%|mln|mld|USD|EUR|ha|tys\.?)?/gi) ?? []
  ).filter((value) => !quotedLower.some((item) => item.includes(value.toLowerCase())));

  const proper: string[] = [];
  for (const match of claim.matchAll(/\b[A-ZĄĆĘŁŃÓŚŹŻ][\p{L}\p{N}-]{2,}\b/gu)) {
    const value = match[0];
    if (ALL_CAPS_STOPLIST.has(value.toUpperCase())) continue;
    if (options.includeSentenceStart && INITIAL_STOPWORDS.has(value.toLowerCase())) continue;

    const before = claim.slice(0, match.index ?? 0);
    const sentenceStart = (match.index ?? 0) === 0 || /[.!?]\s*$|\n\s*$/.test(before);
    if (sentenceStart && !options.includeSentenceStart && !isAcronym(value)) continue;

    const lower = value.toLowerCase();
    if (quotedLower.some((item) => item.includes(lower))) continue;
    proper.push(value);
  }

  return {
    quoted,
    numeric: uniqueValues(numeric),
    proper: uniqueValues(proper),
  };
}

/** Zapytanie do wyszukiwania: encje/liczby/lata/nazwy własne + słowa kluczowe, cięte na granicy słowa. */
export function buildClaimQuery(claim: string): string {
  const entities = extractClaimEntities(claim);
  const quoted = entities.quoted[0];
  const quotedLower = quoted ? quoted.toLowerCase() : "";
  const words = claim
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}%]/gu, ""))
    .filter((word) => word.length > 4 && !STOPWORDS.has(word.toLowerCase()) && !quotedLower.includes(word.toLowerCase()));

  const parts = [...(quoted ? [`"${quoted}"`] : []), ...entities.numeric, ...entities.proper, ...words];
  const seen = new Set<string>();
  let query = "";

  for (const part of parts) {
    const key = part.toLowerCase();
    if (!part || seen.has(key)) continue;
    const candidate = query ? `${query} ${part}` : part;
    if (candidate.length > MAX_QUERY_LENGTH) continue;
    seen.add(key);
    query = candidate;
  }

  if (!query) query = claim.replace(/\s+/g, " ").slice(0, MAX_QUERY_LENGTH).trim();
  return query;
}

export function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 4 && !STOPWORDS.has(word));
}

/** Rdzeń do porównania odmiany: pierwsze 6 znaków (akwakultury ≈ akwakulturze). */
export function stem(word: string): string {
  return word.slice(0, 6);
}

function uniqueValues(values: string[]): string[] {
  const map = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) map.set(trimmed.toLowerCase(), trimmed);
  }
  return [...map.values()];
}
