export type ReviewVerdict = "pass" | "needs_fix" | "draft";

export function reviewTechnical(article: { title: string; content_html: string; tldr: string[] }): { verdict: ReviewVerdict; notes: string[] } {
  const notes: string[] = [];
  if (article.title.length > 60) notes.push("title>60");
  if (article.tldr.length < 3 || article.tldr.length > 5) notes.push("tldr!=3-5");
  if (/<(div|span|img|a)[\s>]/i.test(article.content_html)) notes.push("niedozwolony tag HTML");
  return { verdict: notes.length === 0 ? "pass" : "needs_fix", notes };
}

export type ClaimVerdict = "confirmed" | "refuted" | "uncertain";

export function reviewFacts(_claims: { claim: string }[]): { verdict: ReviewVerdict; results: ClaimVerdict[] } {
  // R3 właściwe (3.8 + search grounding) w F2-T4; tu stub pod mocki.
  return { verdict: "pass", results: [] };
}
