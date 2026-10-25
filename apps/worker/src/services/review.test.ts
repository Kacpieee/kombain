import { describe, expect, it } from "vitest";
import { CATEGORIES, buildEditorPrompt, type EditorOut, type R2Atom } from "../prompts.js";
import { synthesizeArticle, type GenerateFn } from "./llm.js";
import {
  buildSourceLink,
  reviewArticle,
  sanitizeEditorHtml,
  stripInferences,
  validateTechnical,
} from "./review.js";

const ARTICLE: EditorOut = {
  title: "Drony RTK w sadownictwie",
  content_html:
    "<h2>Wstęp</h2><p>Akapit pierwszy o dronach.</p><p>Akapit drugi o RTK.</p><h2>Wdrożenie</h2><p>Wnioski dla sadowników.</p>",
  tldr: ["Drony skracają czas oprysku", "RTK daje centymetrową dokładność", "Mniej środków na hektar"],
  tags: ["drony", "rtk"],
  tech_summary: { podmiot: "Firma X", technologia: "drony RTK", cel_wdrozenia: "mniej oprysków" },
  slug: "drony-rtk-w-sadownictwie",
  external_refs: [],
};

const editorJson = (overrides: Partial<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    title: "Drony RTK w sadownictwie",
    content_html: "<h2>Wstęp</h2><p>Treść.</p><h2>Wdrożenie</h2><p>Wnioski.</p>",
    tldr: ["a", "b", "c"],
    tags: ["Drony", "DRONY", "rtk"],
    tech_summary: { podmiot: "Firma X", technologia: "drony", cel_wdrozenia: "mniej oprysków" },
    slug: "Drony RTK",
    external_refs: [],
    ...overrides,
  });

function generator(raw: string): { fn: GenerateFn; calls: Array<{ prompt: string; search?: boolean }> } {
  const calls: Array<{ prompt: string; search?: boolean }> = [];
  const fn: GenerateFn = async ({ prompt, search }) => {
    calls.push({ prompt, search });
    return raw;
  };
  return { fn, calls };
}

describe("buildEditorPrompt", () => {
  it("wstrzykuje personę wybranego działu i tylko jego technologię", () => {
    const prompt = buildEditorPrompt({ category: "Agroenergetyka", originalTitle: "T", articleText: "Treść" });

    expect(prompt).toContain("Agroenergetyka");
    expect(prompt).toContain("Agri-PV");
    expect(prompt).not.toMatch(/pocketbase/i);
    expect(prompt).not.toContain("[WPISZ");
    expect(prompt).toContain('Nie dodawaj linku "Źródło:"');
  });

  it("każdy z 6 działów dostaje własną personę", () => {
    for (const category of CATEGORIES) {
      const prompt = buildEditorPrompt({ category, originalTitle: "T", articleText: "Treść" });
      expect(prompt).toContain(`Redaktor Działu "${category}"`);
      expect(prompt).not.toContain("[WPISZ");
    }
  });
});

describe("synthesizeArticle", () => {
  it("normalizuje tagi (lowercase, dedupe) i slug do ASCII", async () => {
    const { fn } = generator(editorJson());
    const result = await synthesizeArticle(
      { category: "Inteligentne Maszyny i Drony", originalTitle: "Oryginał", articleText: "Źródło" },
      { generate: fn }
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.article.tags).toEqual(["drony", "rtk"]);
    expect(result.article.slug).toBe("drony-rtk-w-sadownictwie");
  });

  it("brak external_refs nie wywala walidacji (domyślna pusta tablica)", async () => {
    const payload = JSON.parse(editorJson()) as Record<string, unknown>;
    delete payload.external_refs;
    const { fn } = generator(JSON.stringify(payload));
    const result = await synthesizeArticle(
      { category: "Agroenergetyka", originalTitle: "T", articleText: "S" },
      { generate: fn }
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.external_refs).toEqual([]);
  });

  it("tytuł > 60 znaków → error (nie publikacja)", async () => {
    const { fn } = generator(editorJson({ title: "X".repeat(61) }));
    const result = await synthesizeArticle(
      { category: "Agroenergetyka", originalTitle: "T", articleText: "S" },
      { generate: fn }
    );

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toMatch(/title|walidac/i);
  });

  it("tldr krótszy niż 3 → error", async () => {
    const { fn } = generator(editorJson({ tldr: ["a", "b"] }));
    const result = await synthesizeArticle(
      { category: "Agroenergetyka", originalTitle: "T", articleText: "S" },
      { generate: fn }
    );

    expect(result.status).toBe("error");
  });
});

describe("sanitizeEditorHtml / validateTechnical", () => {
  it("usuwa script, img, linki i atrybuty, zostawia allowlistę", () => {
    const html = '<p onclick="x()">A<script>alert(1)</script><img src="x"><a href="/y">link</a></p><h2>H</h2>';
    expect(sanitizeEditorHtml(html)).toBe("<p>A link</p><h2>H</h2>");
  });

  it("wykrywa niedozwolony tag i URL w treści", () => {
    const result = validateTechnical({
      ...ARTICLE,
      content_html: '<p>Treść <a href="https://example.com">link</a></p><div>blok</div>',
    });

    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toMatch(/Niedozwolone tagi/);
    expect(result.issues.join(" ")).toMatch(/URL/);
  });

  it("poprawny artykuł przechodzi R1 lokalny", () => {
    expect(validateTechnical(ARTICLE)).toEqual({ pass: true, issues: [] });
  });

  it("wykrywa link źródła wygenerowany przez model", () => {
    const result = validateTechnical({ ...ARTICLE, content_html: "<p>Źródło: https://x</p>" });
    expect(result.pass).toBe(false);
  });
});

describe("stripInferences", () => {
  it("wycina zdanie-wniosek z akapitu", () => {
    const html = "<p>Fakt ze źródła. Rynek wzrośnie o 40% w 2027.</p>";
    const atoms: R2Atom[] = [{ text: "Rynek wzrośnie o 40% w 2027.", type: "inference", evidence: "" }];

    const result = stripInferences(html, atoms);
    expect(result.removed).toEqual(["Rynek wzrośnie o 40% w 2027."]);
    expect(result.html).toBe("<p>Fakt ze źródła.</p>");
    expect(result.missed).toEqual([]);
  });

  it("zdanie przecięte tagiem = missed", () => {
    const html = "<p>Rynek <strong>wzrośnie</strong> o 40%.</p>";
    const atoms: R2Atom[] = [{ text: "Rynek wzrośnie o 40%.", type: "inference", evidence: "" }];

    expect(stripInferences(html, atoms).missed).toHaveLength(1);
  });
});

describe("buildSourceLink", () => {
  it("dokleja link w kodzie i escapuje cudzysłowy", () => {
    const html = buildSourceLink('https://example.com/a?x="1"&y=2');
    expect(html).toContain("Źródło:");
    expect(html).toContain("&quot;");
    expect(html).not.toContain('x="1"');
  });
});

describe("reviewArticle — R1/R2/R3", () => {
  const supported: R2Atom[] = [{ text: "Akapit pierwszy o dronach.", type: "supported", evidence: "cytat" }];

  it("lokalny fail R1 kończy się draftem bez wołania modelu", async () => {
    let called = false;
    const result = await reviewArticle(
      { ...ARTICLE, title: "X".repeat(61) },
      "źródło",
      { runR1: async () => ((called = true), { pass: true, issues: [] }) }
    );

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R1");
    expect(called).toBe(false);
  });

  it("fail R1 → draft z issues", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: false, issues: ["Zbyt sprzedażowy ton"] }),
      runR2: async () => supported,
    });

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R1");
    expect(result.issues).toContain("Zbyt sprzedażowy ton");
  });

  it("fail R1 + udany retry Redaktora → przechodzi dalej", async () => {
    let attempt = 0;
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => (++attempt === 1 ? { pass: false, issues: ["popraw"] } : { pass: true, issues: [] }),
      regenerate: async () => ({ ...ARTICLE, title: "Poprawiony tytuł" }),
      runR2: async () => supported,
    });

    expect(attempt).toBe(2);
    expect(result.status).toBe("published");
    expect(result.article.title).toBe("Poprawiony tytuł");
  });

  it("R2: inference bez dowodu jest wycinany, artykuł publikowany", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [
        ...supported,
        { text: "Akapit drugi o RTK.", type: "inference", evidence: "" },
      ],
      verifyExternal: async () => ({ status: "ok", result: { results: [] } }),
    });

    expect(result.status).toBe("published");
    expect(result.removedInferences).toHaveLength(1);
    expect(result.cleanedHtml).not.toContain("Akapit drugi");
  });

  it("R3: refuted → draft (bez needs_human_check)", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [{ text: "Firma X ma 40% rynku.", type: "external", evidence: "" }],
      verifyExternal: async () => ({
        status: "ok",
        result: { results: [{ claim: "Firma X ma 40% rynku.", verdict: "refuted", evidence_url: "https://e.com" }] },
      }),
    });

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R3");
    expect(result.needsHumanCheck).toBe(false);
  });

  it("R3: uncertain → draft + needs_human_check", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [{ text: "Firma X ma 40% rynku.", type: "external", evidence: "" }],
      verifyExternal: async () => ({
        status: "ok",
        result: { results: [{ claim: "Firma X ma 40% rynku.", verdict: "uncertain", evidence_url: "" }] },
      }),
    });

    expect(result.status).toBe("draft");
    expect(result.needsHumanCheck).toBe(true);
  });

  it("R3: confirmed → published z dowodem", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [{ text: "Firma X ma 40% rynku.", type: "external", evidence: "" }],
      verifyExternal: async () => ({
        status: "ok",
        result: { results: [{ claim: "Firma X ma 40% rynku.", verdict: "confirmed", evidence_url: "https://e.com" }] },
      }),
    });

    expect(result.status).toBe("published");
    expect(result.external[0]?.verdict).toBe("confirmed");
  });

  it("brak atomów external → R3 nie jest wołane", async () => {
    let called = false;
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => supported,
      verifyExternal: async () => {
        called = true;
        return { status: "ok", result: { results: [] } };
      },
    });

    expect(called).toBe(false);
    expect(result.status).toBe("published");
  });

  it("błąd R2 → draft R2, nie rejected", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => {
        throw new Error("timeout");
      },
    });

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R2");
  });

  it("błąd R3 → draft R3", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [{ text: "Fakt zewnętrzny.", type: "external", evidence: "" }],
      verifyExternal: async () => ({ status: "error", error: "429 quota" }),
    });

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R3");
  });

  it("lokalny fail R1 + regenerate naprawia → published (retry obowiązuje też dla meta)", async () => {
    let regenerated = 0;
    const result = await reviewArticle(
      { ...ARTICLE, title: "X".repeat(61) },
      "źródło",
      {
        runR1: async () => ({ pass: true, issues: [] }),
        regenerate: async () => {
          regenerated += 1;
          return ARTICLE;
        },
        runR2: async () => supported,
      }
    );

    expect(result.status).toBe("published");
    expect(regenerated).toBe(1);
    expect(result.article.title).toBe(ARTICLE.title);
  });

  it("retry nieudany → draft R1, R2/R3 niewołane, regenerate dokładnie raz", async () => {
    let regenerated = 0;
    let r2Called = false;
    const result = await reviewArticle(
      ARTICLE,
      "źródło",
      {
        runR1: async () => ({ pass: false, issues: ["nadal źle"] }),
        regenerate: async () => {
          regenerated += 1;
          return ARTICLE;
        },
        runR2: async () => {
          r2Called = true;
          return supported;
        },
      }
    );

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R1");
    expect(regenerated).toBe(1);
    expect(r2Called).toBe(false);
  });

  it("R2 bez atomów → draft (model failure, nie publish)", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [],
    });

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R2");
    expect(result.issues.join(" ")).toMatch(/atom/i);
  });

  it("R3 niekompletny (brak werdyktu dla atomu) → draft + needs_human_check", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [{ text: "Fakt bez werdyktu.", type: "external", evidence: "" }],
      verifyExternal: async () => ({ status: "ok", result: { results: [] } }),
    });

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R3");
    expect(result.needsHumanCheck).toBe(true);
  });

  it("R3: confirmed bez URL dowodu nie publikuje", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [{ text: "Fakt z URL.", type: "external", evidence: "" }],
      verifyExternal: async () => ({
        status: "ok",
        result: { results: [{ claim: "Fakt z URL.", verdict: "confirmed", evidence_url: "" }] },
      }),
    });

    expect(result.status).toBe("draft");
    expect(result.needsHumanCheck).toBe(true);
  });

  it("external_refs Redaktora wchodzą do R3, nawet gdy R2 dał tylko supported", async () => {
    const seen: string[] = [];
    const result = await reviewArticle(
      {
        ...ARTICLE,
        external_refs: [{ claim: "Firma X ma 40% rynku.", type: "external", source: "raport" }],
      },
      "źródło",
      {
        runR1: async () => ({ pass: true, issues: [] }),
        runR2: async () => supported,
        verifyExternal: async (atoms) => {
          seen.push(...atoms.map((atom) => atom.text));
          return {
            status: "ok",
            result: {
              results: [{ claim: "Firma X ma 40% rynku.", verdict: "confirmed", evidence_url: "https://e.com" }],
            },
          };
        },
      }
    );

    expect(seen).toEqual(["Firma X ma 40% rynku."]);
    expect(result.status).toBe("published");
    expect(result.external[0]?.verdict).toBe("confirmed");
  });

  it("inference z fałszywym dowodem (nie ma go w źródle) jest wycinany", async () => {
    const result = await reviewArticle(ARTICLE, "tekst źródłowy bez cytatu", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [
        ...supported,
        { text: "Akapit drugi o RTK.", type: "inference", evidence: "cytat, którego nie ma" },
      ],
      verifyExternal: async () => ({ status: "ok", result: { results: [] } }),
    });

    expect(result.status).toBe("published");
    expect(result.removedInferences).toHaveLength(1);
  });

  it("pojedyncze słowo jako dowód inference nie wystarcza", async () => {
    const result = await reviewArticle(ARTICLE, "drony RTK sadownictwo", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [
        ...supported,
        { text: "Akapit drugi o RTK.", type: "inference", evidence: "drony" },
      ],
      verifyExternal: async () => ({ status: "ok", result: { results: [] } }),
    });

    expect(result.status).toBe("published");
    expect(result.removedInferences).toHaveLength(1);
  });

  it("sprzeczne werdykty R3 dla tego samego claimu → wygrywa refuted (draft)", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [{ text: "Fakt X.", type: "external", evidence: "" }],
      verifyExternal: async () => ({
        status: "ok",
        result: {
          results: [
            { claim: "Fakt X.", verdict: "confirmed", evidence_url: "https://a.example/x" },
            { claim: "Fakt X.", verdict: "refuted", evidence_url: "https://b.example/x" },
          ],
        },
      }),
    });

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R3");
  });

  it("retry: lokalny fail → regenerate → LLM fail → draft, dokładnie jeden retry", async () => {
    let regenerated = 0;
    let r2Called = false;
    const result = await reviewArticle(
      { ...ARTICLE, title: "X".repeat(61) },
      "źródło",
      {
        runR1: async () => ({ pass: false, issues: ["nadal źle"] }),
        regenerate: async () => {
          regenerated += 1;
          return ARTICLE;
        },
        runR2: async () => {
          r2Called = true;
          return supported;
        },
      }
    );

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R1");
    expect(regenerated).toBe(1);
    expect(r2Called).toBe(false);
  });

  it("draft po R3 zachowuje werdykty do audytu", async () => {
    const result = await reviewArticle(ARTICLE, "źródło", {
      runR1: async () => ({ pass: true, issues: [] }),
      runR2: async () => [{ text: "Fakt X.", type: "external", evidence: "" }],
      verifyExternal: async () => ({
        status: "ok",
        result: { results: [{ claim: "Fakt X.", verdict: "refuted", evidence_url: "https://e.com" }] },
      }),
    });

    expect(result.status).toBe("draft");
    expect(result.external).toHaveLength(1);
    expect(result.external[0]?.verdict).toBe("refuted");
  });

  it("draft po R2 zachowuje listę wyciętych wniosków", async () => {
    const result = await reviewArticle(
      {
        ...ARTICLE,
        content_html: "<p>Akapit pierwszy o dronach.</p><p>Wniosek <strong>rynek</strong> wzrośnie.</p>",
      },
      "źródło",
      {
        runR1: async () => ({ pass: true, issues: [] }),
        runR2: async () => [
          { text: "Akapit pierwszy o dronach.", type: "inference", evidence: "" },
          { text: "Wniosek rynek wzrośnie.", type: "inference", evidence: "" },
        ],
      }
    );

    expect(result.status).toBe("draft");
    expect(result.stage).toBe("R2");
    expect(result.removedInferences).toHaveLength(1);
  });
});
