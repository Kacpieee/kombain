import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { CATEGORIES } from "../prompts.js";
import {
  DEFAULT_CATEGORY_IMAGES,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  WEBP_QUALITY,
  defaultImageFor,
  processArticleImage,
  renderWebp,
} from "./media.js";

async function png(width = 1600, height = 900): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 60 } } })
    .png()
    .toBuffer();
}

describe("media — grafiki domyślne", () => {
  it("każda z 6 kategorii ma https-owy default", () => {
    expect(Object.keys(DEFAULT_CATEGORY_IMAGES).sort()).toEqual([...CATEGORIES].sort());
    for (const category of CATEGORIES) {
      expect(defaultImageFor(category)).toMatch(/^https:\/\/media\.kombain\.pl\/defaults\/.+\.webp$/);
    }
  });
});

describe("renderWebp", () => {
  it("skaluje do 1200×675 webp q80 (cover)", async () => {
    expect(IMAGE_WIDTH).toBe(1200);
    expect(IMAGE_HEIGHT).toBe(675);
    expect(WEBP_QUALITY).toBe(80);

    const output = await renderWebp(await png());
    const meta = await sharp(output).metadata();

    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(675);
  });
});

describe("processArticleImage", () => {
  it("brak og:image → default kategorii, bez pobierania i uploadu", async () => {
    let called = false;
    const result = await processArticleImage({
      slug: "test",
      ogImage: null,
      category: "Agroenergetyka",
      deps: {
        fetchImage: async () => {
          called = true;
          return png();
        },
        upload: async () => {
          called = true;
          return "https://x";
        },
      },
    });

    expect(called).toBe(false);
    expect(result).toEqual({ url: defaultImageFor("Agroenergetyka"), via: "default" });
  });

  it("konwertuje i wgrywa na R2 pod articles/{slug}.webp", async () => {
    let uploaded: { key: string; size: number; type: string } | null = null;
    const result = await processArticleImage({
      slug: "drony-rtk",
      ogImage: "https://cdn.example.com/a.jpg",
      category: "Inteligentne Maszyny i Drony",
      deps: {
        fetchImage: async () => png(),
        upload: async (key, body, type) => {
          uploaded = { key, size: body.length, type };
          return `https://media.kombain.pl/${key}`;
        },
      },
    });

    expect(result).toEqual({ url: "https://media.kombain.pl/articles/drony-rtk.webp", via: "r2" });
    expect(uploaded).toMatchObject({ key: "articles/drony-rtk.webp", type: "image/webp" });
    expect(uploaded!.size).toBeGreaterThan(0);
  });

  it("błąd pobrania obrazu → default kategorii", async () => {
    const result = await processArticleImage({
      slug: "test",
      ogImage: "https://cdn.example.com/broken.jpg",
      category: "Biotechnologia i Nauka",
      deps: {
        fetchImage: async () => {
          throw new Error("403");
        },
        upload: async () => "https://x",
      },
    });

    expect(result.via).toBe("default");
    expect(result.url).toBe(defaultImageFor("Biotechnologia i Nauka"));
  });

  it("błąd uploadu (brak R2) → default kategorii", async () => {
    const result = await processArticleImage({
      slug: "test",
      ogImage: "https://cdn.example.com/a.jpg",
      category: "AI i Automatyzacja",
      deps: {
        fetchImage: async () => png(),
        upload: async () => {
          throw new Error("Brak konfiguracji R2");
        },
      },
    });

    expect(result.via).toBe("default");
  });

  it("nieprawidłowy obraz (nie-obraz) → default", async () => {
    const result = await processArticleImage({
      slug: "test",
      ogImage: "https://cdn.example.com/a.jpg",
      category: "Rolnictwo Precyzyjne",
      deps: {
        fetchImage: async () => Buffer.from("to nie jest obraz"),
        upload: async () => "https://x",
      },
    });

    expect(result.via).toBe("default");
  });

  it("brak konfiguracji R2 (domyślny upload) → default, bez wyjątku", async () => {
    const saved = {
      endpoint: process.env.R2_ENDPOINT,
      bucket: process.env.R2_BUCKET,
      key: process.env.R2_ACCESS_KEY_ID,
      secret: process.env.R2_SECRET_ACCESS_KEY,
    };
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_BUCKET;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;

    try {
      const result = await processArticleImage({
        slug: "test",
        ogImage: "https://cdn.example.com/a.jpg",
        category: "Agroenergetyka",
        deps: { fetchImage: async () => png() },
      });

      expect(result.via).toBe("default");
      expect(result.url).toBe(defaultImageFor("Agroenergetyka"));
    } finally {
      if (saved.endpoint !== undefined) process.env.R2_ENDPOINT = saved.endpoint;
      if (saved.bucket !== undefined) process.env.R2_BUCKET = saved.bucket;
      if (saved.key !== undefined) process.env.R2_ACCESS_KEY_ID = saved.key;
      if (saved.secret !== undefined) process.env.R2_SECRET_ACCESS_KEY = saved.secret;
    }
  });
});
