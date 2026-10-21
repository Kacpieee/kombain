export function slugify(input: string): string {
  const map: Record<string, string> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
  return input
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (c) => map[c] ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function parseSynthesisJson(raw: string): unknown {
  let s = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a === -1 || b <= a) throw new Error("Nie odnaleziono klamer w odpowiedzi LLM");
    return JSON.parse(s.slice(a, b + 1));
  }
}

export function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid"].forEach((p) => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return null;
  }
}
