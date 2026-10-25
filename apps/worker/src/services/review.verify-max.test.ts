import { describe, expect, it, vi } from "vitest";
import type { EditorOut, R2Atom } from "../prompts.js";

const { verifySpy } = vi.hoisted(() => ({ verifySpy: vi.fn() }));

vi.mock("./factcheck.js", () => ({ verifyExternalAtoms: verifySpy }));

import { reviewArticle } from "./review.js";

const ARTICLE: EditorOut = {
  title: "Drony RTK w sadownictwie",
  content_html: "<h2>Wstęp</h2><p>Akapit o dronach.</p><p>Akapit o RTK.</p><h2>Wdrożenie</h2><p>Wnioski.</p>",
  tldr: ["Drony skracają czas oprysku", "RTK daje dokładność", "Mniej środków"],
  tags: ["drony", "rtk"],
  tech_summary: { podmiot: "Firma X", technologia: "drony RTK", cel_wdrozenia: "mniej oprysków" },
  slug: "drony-rtk-w-sadownictwie",
  external_refs: [],
};

const ATOM: R2Atom = { text: "Firma X ma 40% rynku.", type: "external", evidence: "" };

describe("reviewArticle — verifyMaxAtoms", () => {
  it("przekazuje limit atomów z ReviewDeps do FactcheckDeps", async () => {
    verifySpy.mockResolvedValue({
      status: "ok",
      result: {
        results: [
          { claim: ATOM.text, verdict: "confirmed", evidence_url: "https://e.com", reason: "confirmed" },
        ],
      },
      stats: { searches: 1, serp: 0, fetches: 0, confirmed: 1, refuted: 0, uncertain: 0 },
    });

    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [ATOM],
      verifyMaxAtoms: 3,
    });

    expect(result.status).toBe("published");
    expect(verifySpy).toHaveBeenCalledWith([ATOM], expect.objectContaining({ maxAtoms: 3 }));
  });
});
