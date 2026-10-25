import { describe, expect, it } from "vitest";
import {
  MAX_LINKS_PER_SOURCE,
  UnknownSourceTypeError,
  buildScrapingAntUrl,
  extractLinks,
  ingestSource,
  normalizeUrl,
  routeSource,
  type SourceForIngestion,
} from "./ingestion.js";

const SOURCE: SourceForIngestion = {
  id: "src-1",
  name: "AgFunderNews",
  url: "https://agfundernews.com/feed",
  type: "rss",
  link_selector: null,
};

const SCRAPER_SOURCE: SourceForIngestion = {
  id: "src-2",
  name: "Future Farming",
  url: "https://www.futurefarming.com/news/",
  type: "scraper",
  link_selector: null,
};

function rssXml(items: Array<{ title: string; link: string }>): string {
  const entries = items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link></item>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title>${entries}</channel></rss>`;
}

describe("routeSource", () => {
  it("kieruje rss i scraper zgodnie z typem źródła", () => {
    expect(routeSource({ type: "rss" })).toBe("rss");
    expect(routeSource({ type: "scraper" })).toBe("scraper");
  });

  it("rzuca UnknownSourceTypeError dla nieznanego typu", () => {
    expect(() => routeSource({ type: "sitemap" })).toThrow(UnknownSourceTypeError);
  });
});

describe("normalizeUrl", () => {
  it("zamienia link względny na bezwzględny", () => {
    expect(normalizeUrl("/news/123", "https://example.com/feed")).toBe("https://example.com/news/123");
  });

  it("usuwa utm_*, fbclid i gclid (niezależnie od wielkości liter)", () => {
    expect(normalizeUrl("/a?x=1&utm_source=rss&utm_medium=feed&fbclid=abc&gclid=xyz", "https://example.com")).toBe(
      "https://example.com/a?x=1"
    );
    expect(normalizeUrl("/b?FBclid=abc", "https://example.com")).toBe("https://example.com/b");
  });

  it("rozkodowuje &amp; i zachowuje pozostałe parametry", () => {
    expect(normalizeUrl("/a?id=7&amp;utm_campaign=news&lang=pl", "https://example.com")).toBe(
      "https://example.com/a?id=7&lang=pl"
    );
  });

  it("usuwa fragment (#)", () => {
    expect(normalizeUrl("https://example.com/a#section", "https://example.com")).toBe("https://example.com/a");
  });

  it("normalizuje wielkość hosta", () => {
    expect(normalizeUrl("HTTPS://Example.COM/Path", "https://example.com")).toBe("https://example.com/Path");
  });

  it("odrzuca javascript:, mailto: i śmieci", () => {
    expect(normalizeUrl("javascript:void(0)", "https://example.com")).toBeNull();
    expect(normalizeUrl("mailto:redakcja@example.com", "https://example.com")).toBeNull();
    expect(normalizeUrl("", "https://example.com")).toBeNull();
  });
});

describe("extractLinks", () => {
  const html = `
    <html><body>
      <nav><a href="/">Start</a></nav>
      <article>
        <a class="post-link" href="/news/1?utm_source=home">Pierwszy artykuł o dronach</a>
        <a class="post-link" href="/news/2">Drugi artykuł o RTK</a>
        <a class="post-link" href="https://www.futurefarming.com/news/1?utm_source=home">Duplikat pierwszego</a>
        <a class="post-link" href="#top">Do góry</a>
        <a class="post-link" href="javascript:void(0)">JS</a>
        <a class="post-link" href="/news/3"></a>
      </article>
    </body></html>`;

  it("bierze linki po selektorze, rozwiązuje względne i deduplikuje", () => {
    const links = extractLinks(html, { ...SCRAPER_SOURCE, link_selector: "article a.post-link" });

    expect(links.map((l) => l.sourceUrl)).toEqual([
      "https://www.futurefarming.com/news/1",
      "https://www.futurefarming.com/news/2",
    ]);
    expect(links[0]).toMatchObject({ sourceId: "src-2", originalTitle: "Pierwszy artykuł o dronach" });
  });

  it("bez selektora używa a[href]", () => {
    const links = extractLinks(html, SCRAPER_SOURCE);
    expect(links.map((l) => l.sourceUrl)).toContain("https://www.futurefarming.com/");
  });

  it("obcina do 15 pozycji na źródło", () => {
    const many = Array.from({ length: 20 }, (_, i) => `<a href="/n/${i}">Artykuł numer ${i}</a>`).join("");
    const links = extractLinks(`<div>${many}</div>`, SCRAPER_SOURCE);
    expect(links).toHaveLength(MAX_LINKS_PER_SOURCE);
    expect(links[0]?.sourceUrl).toBe("https://www.futurefarming.com/n/0");
  });
});

describe("ingestSource — RSS", () => {
  it("parsuje feed, normalizuje linki i deduplikuje", async () => {
    const xml = rssXml([
      { title: "Drony w sadownictwie", link: "https://example.com/a?utm_source=rss" },
      { title: "Ten sam artykuł", link: "https://example.com/a" },
      { title: "Agri-PV", link: "/b" },
    ]);

    const result = await ingestSource(SOURCE, { fetchText: async () => xml });

    expect(result.error).toBeNull();
    expect(result.type).toBe("rss");
    expect(result.candidates).toEqual([
      { sourceId: "src-1", originalTitle: "Drony w sadownictwie", sourceUrl: "https://example.com/a" },
      { sourceId: "src-1", originalTitle: "Agri-PV", sourceUrl: "https://agfundernews.com/b" },
    ]);
  });

  it("limit 15 obowiązuje też dla RSS", async () => {
    const xml = rssXml(Array.from({ length: 20 }, (_, i) => ({ title: `Temat ${i}`, link: `https://example.com/${i}` })));

    const result = await ingestSource(SOURCE, { fetchText: async () => xml });
    expect(result.candidates).toHaveLength(MAX_LINKS_PER_SOURCE);
  });

  it("błąd sieci nie wywala runu — zwraca error i zero kandydatów", async () => {
    const result = await ingestSource(SOURCE, {
      fetchText: async () => {
        throw new Error("ECONNRESET");
      },
    });

    expect(result.error).toContain("ECONNRESET");
    expect(result.candidates).toEqual([]);
  });

  it("zepsuty XML to error, nie wyjątek", async () => {
    const result = await ingestSource(SOURCE, { fetchText: async () => "<rss><channel><item>" });
    expect(result.error).toBeTruthy();
    expect(result.candidates).toEqual([]);
  });
});

describe("ingestSource — scraper", () => {
  const html = `<article><a class="post-link" href="/a">Artykuł A</a><a class="post-link" href="/b">Artykuł B</a></article>`;

  it("woła ScrapingAnt z kluczem i celem, potem czyści linki", async () => {
    let requested = "";
    const result = await ingestSource(
      { ...SCRAPER_SOURCE, link_selector: "article a.post-link" },
      {
        scrapingAntKey: "test-key",
        fetchText: async (url) => {
          requested = url;
          return html;
        },
      }
    );

    expect(result.error).toBeNull();
    expect(requested).toContain("api.scrapingant.com");
    expect(requested).toContain("x-api-key=test-key");
    expect(requested).toContain(encodeURIComponent(SCRAPER_SOURCE.url));
    expect(result.candidates.map((c) => c.sourceUrl)).toEqual([
      "https://www.futurefarming.com/a",
      "https://www.futurefarming.com/b",
    ]);
  });

  it("bez klucza ScrapingAnt zwraca error bez sieci", async () => {
    let called = false;
    const result = await ingestSource(SCRAPER_SOURCE, {
      scrapingAntKey: "",
      fetchText: async () => {
        called = true;
        return html;
      },
    });

    expect(called).toBe(false);
    expect(result.error).toContain("SCRAPINGANT_API_KEY");
    expect(result.candidates).toEqual([]);
  });

  it("błąd ScrapingAnt nie wycieka klucza do error (log JSONL)", async () => {
    const key = "secret-key-123";
    const result = await ingestSource(SCRAPER_SOURCE, {
      scrapingAntKey: key,
      fetchText: async () => {
        throw new Error(`HTTP 401 dla https://api.scrapingant.com/v2/general?x-api-key=${key}`);
      },
    });

    expect(result.error).toContain("HTTP 401");
    expect(result.error).not.toContain(key);
    expect(result.error).toContain("[redacted]");
  });

  it("nieznany typ źródła to error w wyniku, nie wyjątek", async () => {
    const result = await ingestSource({ ...SOURCE, type: "sitemap" }, { fetchText: async () => "" });

    expect(result.error).toContain("Nieznany typ źródła");
    expect(result.candidates).toEqual([]);
  });
});

describe("buildScrapingAntUrl", () => {
  it("koduje docelowy URL i dokłada klucz", () => {
    const url = buildScrapingAntUrl("https://example.com/a?b=1&c=2", "key-123");
    expect(url.startsWith("https://api.scrapingant.com/v2/general?")).toBe(true);
    expect(url).toContain(`url=${encodeURIComponent("https://example.com/a?b=1&c=2")}`);
    expect(url).toContain("x-api-key=key-123");
  });
});
