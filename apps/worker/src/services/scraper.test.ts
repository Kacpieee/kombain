import { describe, expect, it } from "vitest";
import {
  MIN_TEXT_LENGTH,
  REJECTION_REASON_SHORT,
  isBlockedResponse,
  scrapeArticle,
  type HttpResponse,
} from "./scraper.js";

const LONG_TEXT = "Zaawansowana technologia AgTech zmienia rolnictwo. ".repeat(25); // > 800 znaków

function articleHtml(options: { title?: string; paragraphs?: string; og?: string | null; img?: string | null } = {}): string {
  const title = options.title ?? "Drony RTK w sadownictwie";
  const paragraphs = options.paragraphs ?? Array.from({ length: 10 }, () => `<p>${LONG_TEXT}</p>`).join("");
  const og = options.og === null ? "" : `<meta property="og:image" content="${options.og ?? "https://cdn.example.com/a.jpg"}">`;
  const img = options.img ? `<img src="${options.img}" alt="foto">` : "";
  return `<html><head><title>${title}</title>${og}</head><body><nav>menu strony</nav><article><h1>${title}</h1>${paragraphs}${img}</article><footer>stopka</footer></body></html>`;
}

const ok = (html: string): HttpResponse => ({ status: 200, html });

describe("isBlockedResponse", () => {
  it("blokuje 403/429/503", () => {
    expect(isBlockedResponse(403, "")).toBe(true);
    expect(isBlockedResponse(429, "")).toBe(true);
    expect(isBlockedResponse(503, "")).toBe(true);
  });

  it("blokuje sygnatury Cloudflare niezależnie od statusu i wielkości liter", () => {
    expect(isBlockedResponse(200, "<title>Just a moment...</title>")).toBe(true);
    expect(isBlockedResponse(200, "<div class='cf-browser-verification'>")).toBe(true);
    expect(isBlockedResponse(200, "<p>Normalna strona</p>")).toBe(false);
  });
});

describe("scrapeArticle — smart fetch", () => {
  it("przy 200 nie woła ScrapingAnt", async () => {
    let fallbackCalled = false;
    const result = await scrapeArticle("https://example.com/a", {
      scrapingAntKey: "key",
      fetchDirect: async () => ok(articleHtml()),
      fetchScrapingAnt: async () => {
        fallbackCalled = true;
        return ok(articleHtml());
      },
    });

    expect(fallbackCalled).toBe(false);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.fetchedVia).toBe("direct");
  });

  it("przy 403 robi fallback na ScrapingAnt", async () => {
    let fallbackCalled = false;
    const result = await scrapeArticle("https://example.com/a", {
      scrapingAntKey: "key",
      fetchDirect: async () => ({ status: 403, html: "Forbidden" }),
      fetchScrapingAnt: async () => {
        fallbackCalled = true;
        return ok(articleHtml());
      },
    });

    expect(fallbackCalled).toBe(true);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.fetchedVia).toBe("scrapingant");
  });

  it("przy 200 z sygnaturą Cloudflare też robi fallback", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      scrapingAntKey: "key",
      fetchDirect: async () => ok("<html><body>Just a moment...</body></html>"),
      fetchScrapingAnt: async () => ok(articleHtml()),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.fetchedVia).toBe("scrapingant");
  });

  it("503 również uruchamia fallback", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      scrapingAntKey: "key",
      fetchDirect: async () => ({ status: 503, html: "Service Unavailable" }),
      fetchScrapingAnt: async () => ok(articleHtml()),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.fetchedVia).toBe("scrapingant");
  });

  it("404 z długim body to error, nie śmieciowy artykuł", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      fetchDirect: async () => ({ status: 404, html: articleHtml({ title: "Nie znaleziono" }) }),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("404");
      expect(result.fetchedVia).toBe("direct");
    }
  });

  it("500 z długim body to error, nie śmieciowy artykuł", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      fetchDirect: async () => ({ status: 500, html: articleHtml({ title: "Błąd serwera" }) }),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("500");
  });

  it("fallback, który sam zwraca ścianę CF, to error — nigdy rejected", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      scrapingAntKey: "key",
      fetchDirect: async () => ({ status: 403, html: "Forbidden" }),
      fetchScrapingAnt: async () => ok("<html><head><title>Just a moment...</title></head><body>czekaj</body></html>"),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("zablokowana");
  });

  it("szersze markery ściany (Enable JavaScript) też kierują do fallbacku", async () => {
    let fallbackCalled = false;
    const result = await scrapeArticle("https://example.com/a", {
      scrapingAntKey: "key",
      fetchDirect: async () => ok("<html><body>Enable JavaScript and cookies to continue</body></html>"),
      fetchScrapingAnt: async () => {
        fallbackCalled = true;
        return ok(articleHtml());
      },
    });

    expect(fallbackCalled).toBe(true);
    expect(result.status).toBe("ok");
  });

  it("brak klucza przy blokadzie = error (nie cichy publish)", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      scrapingAntKey: "",
      fetchDirect: async () => ({ status: 429, html: "Too Many Requests" }),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("SCRAPINGANT_API_KEY");
  });

  it("błąd ScrapingAnt = error, nie wyjątek", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      scrapingAntKey: "key",
      fetchDirect: async () => ({ status: 403, html: "Forbidden" }),
      fetchScrapingAnt: async () => ({ status: 502, html: "Bad gateway" }),
    });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("502");
  });

  it("błąd sieci = error z komunikatem", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      fetchDirect: async () => {
        throw new Error("ECONNRESET");
      },
    });

    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("ECONNRESET");
  });
});

describe("scrapeArticle — ekstrakcja", () => {
  it("wyciąga tekst, tytuł i og:image", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      fetchDirect: async () => ok(articleHtml({ title: "Agri-PV 2026", og: "https://cdn.example.com/pv.jpg" })),
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(result.article.title).toBe("Agri-PV 2026");
    expect(result.article.charCount).toBeGreaterThanOrEqual(MIN_TEXT_LENGTH);
    expect(result.article.text).not.toContain("menu strony");
    expect(result.article.ogImage).toBe("https://cdn.example.com/pv.jpg");
    expect(result.article.contentHtml).toContain("<p>");
  });

  it("brak og:image → pierwszy obraz z treści artykułu", async () => {
    const html = articleHtml({ og: null, img: "/media/foto.webp" });
    const result = await scrapeArticle("https://example.com/a", { fetchDirect: async () => ok(html) });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.ogImage).toBe("https://example.com/media/foto.webp");
  });

  it("obsługuje lazy-loading (data-src) w obrazie artykułu", async () => {
    const html = articleHtml({ og: null, img: "https://cdn.example.com/placeholder.gif" }).replace(
      'src="https://cdn.example.com/placeholder.gif"',
      'data-src="https://cdn.example.com/lazy.webp"'
    );
    const result = await scrapeArticle("https://example.com/a", { fetchDirect: async () => ok(html) });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.ogImage).toBe("https://cdn.example.com/lazy.webp");
  });

  it("nie bierze logo spoza artykułu jako og:image", async () => {
    const html = articleHtml({ og: null }).replace("<body>", '<body><header><img src="/logo.png"></header>');
    const result = await scrapeArticle("https://example.com/a", { fetchDirect: async () => ok(html) });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.ogImage).toBeNull();
  });

  it("względny og:image jest rozwiązywany do absolutnego", async () => {
    const result = await scrapeArticle("https://example.com/news/a", {
      fetchDirect: async () => ok(articleHtml({ og: "/img/a.jpg" })),
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.article.ogImage).toBe("https://example.com/img/a.jpg");
  });

  it("tekst < 800 znaków = rejected z dokładnym powodem", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      fetchDirect: async () => ok(articleHtml({ paragraphs: "<p>Za krótko.</p>" })),
    });

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toBe(REJECTION_REASON_SHORT);
      expect(result.reason).toContain("<800");
      expect(result.charCount).toBeLessThan(MIN_TEXT_LENGTH);
    }
  });

  it("pusta strona bez treści = error (nie rejected)", async () => {
    const result = await scrapeArticle("https://example.com/a", {
      fetchDirect: async () => ok("<html><head><title>Puste</title></head><body></body></html>"),
    });

    expect(result.status).toBe("error");
  });
});
