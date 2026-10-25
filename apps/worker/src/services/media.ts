import sharp from "sharp";
import type { Category } from "../prompts.js";

export const IMAGE_WIDTH = 1200;
export const IMAGE_HEIGHT = 675;
export const WEBP_QUALITY = 80;

const MEDIA_BASE = "https://media.kombain.pl";

/** Grafiki domyślne per kategoria (pliki do wgrania na R2 w F3-T2). */
export const DEFAULT_CATEGORY_IMAGES: Record<Category, string> = {
  "AI i Automatyzacja": `${MEDIA_BASE}/defaults/ai-i-automatyzacja.webp`,
  "Rolnictwo Precyzyjne": `${MEDIA_BASE}/defaults/rolnictwo-precyzyjne.webp`,
  "Inteligentne Maszyny i Drony": `${MEDIA_BASE}/defaults/inteligentne-maszyny-i-drony.webp`,
  "Biotechnologia i Nauka": `${MEDIA_BASE}/defaults/biotechnologia-i-nauka.webp`,
  Agroenergetyka: `${MEDIA_BASE}/defaults/agroenergetyka.webp`,
  "Biznes AgTech i Prawo": `${MEDIA_BASE}/defaults/biznes-agtech-i-prawo.webp`,
};

export interface MediaDeps {
  /** Wstrzykiwane w testach; domyślnie fetch z timeoutem 15 s. */
  fetchImage?: (url: string) => Promise<Buffer>;
  /** Wstrzykiwane w testach; domyślnie S3 SDK → Cloudflare R2. */
  upload?: (key: string, body: Buffer, contentType: string) => Promise<string>;
}

export interface ProcessedImage {
  url: string;
  via: "r2" | "default";
}

export function defaultImageFor(category: Category): string {
  return DEFAULT_CATEGORY_IMAGES[category];
}

/**
 * Media artykułu (Dokumentacja §4 KROK 5): og:image → sharp 1200×675 webp q80 → R2
 * `articles/{slug}.webp`; każdy błąd (pobranie, konwersja, upload) → grafika domyślna kategorii.
 */
export async function processArticleImage(input: {
  slug: string;
  ogImage: string | null;
  category: Category;
  deps?: MediaDeps;
}): Promise<ProcessedImage> {
  const fallbackUrl = defaultImageFor(input.category);
  if (!input.ogImage) return { url: fallbackUrl, via: "default" };

  const fetchImage = input.deps?.fetchImage ?? defaultFetchImage;
  const upload = input.deps?.upload ?? defaultUpload;

  try {
    const raw = await fetchImage(input.ogImage);
    const webp = await renderWebp(raw);
    const key = `articles/${input.slug}.webp`;
    const url = await upload(key, webp, "image/webp");
    return { url, via: "r2" };
  } catch {
    return { url: fallbackUrl, via: "default" };
  }
}

/** Konwersja do 1200×675 webp q80 (cover, attention) — bez zapisu na dysk. */
export async function renderWebp(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: "cover", position: "attention" })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

async function defaultFetchImage(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} dla obrazu`);
  return Buffer.from(await response.arrayBuffer());
}

async function defaultUpload(key: string, body: Buffer, contentType: string): Promise<string> {
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("Brak konfiguracji R2 (R2_ENDPOINT/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)");
  }

  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const base = (process.env.R2_PUBLIC_BASE_URL ?? MEDIA_BASE).replace(/\/$/, "");
  return `${base}/${key}`;
}
