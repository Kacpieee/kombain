export { slugify } from "@kombain/db/slug";

/** Wyciąga pierwszy poprawny obiekt/tablicę JSON, odpornie na fence i prozę wokół. */
export function parseSynthesisJson(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, "")
    .replace(/```\s*$/, "")
    .trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const found = extractFirstJson(trimmed);
    if (found === undefined) throw new Error("Nie odnaleziono JSON w odpowiedzi LLM");
    return found;
  }
}

function extractFirstJson(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    const char = text[start];
    if (char !== "{" && char !== "[") continue;
    const candidate = sliceBalanced(text, start);
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // to była klamra z prozy — szukaj dalej
    }
  }
  return undefined;
}

/** Zwraca domknięty fragment od `start` albo null, gdy klamra nigdy się nie zamyka. */
function sliceBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth++;
    } else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid"].forEach((p) =>
      u.searchParams.delete(p)
    );
    return u.toString();
  } catch {
    return null;
  }
}
