const PL_MAP: Record<string, string> = {
  ą: "a",
  ć: "c",
  ę: "e",
  ł: "l",
  ń: "n",
  ó: "o",
  ś: "s",
  ź: "z",
  ż: "z",
};

/**
 * Slugify PL: małe litery, bez polskich znaków, myślniki zamiast separatorów.
 * Gwarancje: wynik ASCII [a-z0-9-], bez wiodących/końcowych myślników, <= maxLength.
 */
export function slugify(input: string, maxLength = 80): string {
  const ascii = input
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (char) => PL_MAP[char] ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return ascii.slice(0, maxLength).replace(/-+$/g, "");
}
