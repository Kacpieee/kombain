import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { uploadToR2 } from "../services/media.js";

/** Pliki defaultowe per kategoria (klucz w R2 = `defaults/{slug}.webp`). */
export const DEFAULT_MEDIA_FILES = [
  { category: "AI i Automatyzacja", slug: "ai-i-automatyzacja" },
  { category: "Rolnictwo Precyzyjne", slug: "rolnictwo-precyzyjne" },
  { category: "Inteligentne Maszyny i Drony", slug: "inteligentne-maszyny-i-drony" },
  { category: "Biotechnologia i Nauka", slug: "biotechnologia-i-nauka" },
  { category: "Agroenergetyka", slug: "agroenergetyka" },
  { category: "Biznes AgTech i Prawo", slug: "biznes-agtech-i-prawo" },
] as const;

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../assets/defaults");

export function defaultMediaPath(slug: string): string {
  return join(ASSETS_DIR, `${slug}.webp`);
}

export interface UploadDefaultsDeps {
  readFile?: (path: string) => Promise<Buffer>;
  upload?: (key: string, body: Buffer, contentType: string) => Promise<string>;
  log?: (line: string) => void;
}

/** Wgrywa 6 defaultów na R2. Wymaga R2_* w env; nie robi nic poza uploadem. */
export async function uploadDefaults(deps: UploadDefaultsDeps = {}): Promise<string[]> {
  const read = deps.readFile ?? ((path: string) => readFile(path));
  const upload = deps.upload ?? uploadToR2;
  const log = deps.log ?? ((line: string) => console.log(line));
  const urls: string[] = [];
  const prepared: Array<{ category: string; slug: string; body: Buffer }> = [];

  for (const { category, slug } of DEFAULT_MEDIA_FILES) {
    const body = await read(defaultMediaPath(slug));
    const meta = await sharp(body).metadata();
    if (meta.format !== "webp" || meta.width !== 1200 || meta.height !== 675) {
      throw new Error(`${slug}.webp: oczekiwano webp 1200x675, jest ${meta.format} ${meta.width}x${meta.height}`);
    }
    prepared.push({ category, slug, body });
  }

  for (const { category, slug, body } of prepared) {
    const url = await upload(`defaults/${slug}.webp`, body, "image/webp");
    urls.push(url);
    log(`OK ${category}: ${url}`);
  }

  return urls;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  uploadDefaults().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
