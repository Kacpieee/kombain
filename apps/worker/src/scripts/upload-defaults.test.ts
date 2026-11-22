import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { DEFAULT_CATEGORY_IMAGES } from "../services/media.js";
import { DEFAULT_MEDIA_FILES, defaultMediaPath, uploadDefaults } from "./upload-defaults.js";

describe("defaulty kategorii", () => {
  it("każda kategoria ma URL defaultu wskazujący na defaults/{slug}.webp", () => {
    expect(DEFAULT_MEDIA_FILES).toHaveLength(6);

    for (const { category, slug } of DEFAULT_MEDIA_FILES) {
      expect(DEFAULT_CATEGORY_IMAGES[category]).toBe(`https://media.kombain.pl/defaults/${slug}.webp`);
    }
  });

  it("pliki istnieją i są webp 1200x675", async () => {
    for (const { slug } of DEFAULT_MEDIA_FILES) {
      const body = await readFile(defaultMediaPath(slug));
      const meta = await sharp(body).metadata();
      expect(meta.format, slug).toBe("webp");
      expect(meta.width, slug).toBe(1200);
      expect(meta.height, slug).toBe(675);
    }
  });

  it("waliduje wszystkie pliki przed pierwszym uploadem", async () => {
    let uploads = 0;
    const bad = DEFAULT_MEDIA_FILES[4]!;

    await expect(
      uploadDefaults({
        readFile: async (path) =>
          path.endsWith(`${bad.slug}.webp`) ? Buffer.from("to nie jest obraz") : readFile(path),
        upload: async () => {
          uploads += 1;
          return "https://media.kombain.pl/x.webp";
        },
        log: () => {},
      })
    ).rejects.toThrow();

    expect(uploads).toBe(0);
  });

  it("uploadDefaults wysyła 6 kluczy defaults/*.webp", async () => {
    const uploaded: string[] = [];
    const urls = await uploadDefaults({
      upload: async (key) => {
        uploaded.push(key);
        return `https://media.kombain.pl/${key}`;
      },
      log: () => {},
    });

    expect(uploaded).toEqual(DEFAULT_MEDIA_FILES.map(({ slug }) => `defaults/${slug}.webp`));
    expect(urls).toHaveLength(6);
    expect(urls[0]).toMatch(/^https:\/\/media\.kombain\.pl\/defaults\/.+\.webp$/);
  });
});
