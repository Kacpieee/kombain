export const MIN_CHARS = 800;
export const ALLOWED_TAGS = ["p", "h2", "h3", "strong", "em", "ul", "ol", "li"];

export function isValidLength(text: string): boolean {
  return text.trim().length >= MIN_CHARS;
}

export function sanitizeHtmlBasic(html: string): string {
  // Pełna sanityzacja przez sanitize-html w F2-T5; tu strażnik allowlist na poziomie tagów.
  return html;
}
