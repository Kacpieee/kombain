import type { Pool } from "pg";
import { withTransaction } from "./index.js";
import { getCategoryId, insertArticle, insertRejected, linkArticleTags, syncTags } from "./queries.js";
import { slugify } from "./slug.js";

export const SLUG_SUFFIX_LENGTH = 4;
const MAX_SLUG_ATTEMPTS = 5;

export interface PersistInput {
  status: "published" | "draft";
  sourceId: string | null;
  sourceUrl: string;
  categoryName: string;
  title: string;
  contentHtml: string | null;
  tldr?: unknown;
  techSummary?: unknown;
  imageUrl?: string | null;
  tags?: string[];
  rejectionReason?: string | null;
  needsHumanCheck?: boolean;
}

export type PersistOutcome =
  | { status: "published" | "draft"; articleId: string; slug: string }
  | { status: "blocked"; reason: string }
  | { status: "dropped"; reason: string };

/**
 * Zapis artykułu w jednej transakcji: kategoria z enuma → slug (+4-znakowy suffix przy kolizji)
 * → insert/upsert po source_url → tagi (ON CONFLICT slug) → linki (ON CONFLICT para).
 * `rejected` w bazie blokuje retry (wynik `dropped`), błędna kategoria → `blocked`.
 */
export async function saveArticle(pool: Pool, input: PersistInput): Promise<PersistOutcome> {
  return withTransaction(pool, async (client) => {
    const categoryId = await getCategoryId(client, input.categoryName);
    if (!categoryId) return { status: "blocked", reason: `Kategoria spoza enuma: ${input.categoryName}` };

    const base = slugify(input.title) || `artykul-${Date.now()}`;

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      await client.query("SAVEPOINT slug_attempt");

      try {
        const articleId = await insertArticle(client, {
          status: input.status,
          sourceId: input.sourceId,
          categoryId,
          title: input.title,
          slug,
          sourceUrl: input.sourceUrl,
          imageUrl: input.imageUrl ?? null,
          textHtml: input.contentHtml,
          tldr: input.tldr,
          techSummary: input.techSummary,
          rejectionReason: input.rejectionReason ?? null,
          needsHumanCheck: input.needsHumanCheck ?? false,
        });

        if (!articleId) return { status: "dropped", reason: "source_url istnieje jako rejected" };

        const tagRows = await syncTags(
          client,
          (input.tags ?? []).map((tag) => ({ name: tag.slice(0, 100), slug: slugify(tag) }))
        );
        for (const tag of tagRows) await linkArticleTags(client, articleId, tag.id);

        await client.query("RELEASE SAVEPOINT slug_attempt");
        return { status: input.status, articleId, slug };
      } catch (error) {
        if (isSlugConflict(error)) {
          if (attempt < MAX_SLUG_ATTEMPTS - 1) {
            await client.query("ROLLBACK TO SAVEPOINT slug_attempt");
            continue;
          }
          await client.query("ROLLBACK TO SAVEPOINT slug_attempt");
          return { status: "blocked", reason: "Nie udało się dobrać unikalnego slug" };
        }
        throw error;
      }
    }

    return { status: "blocked", reason: "Nie udało się dobrać unikalnego slug" };
  });
}

/** Odrzut permanentny: tylko za krótki tekst albo decyzja Bramkarza. Duplikat URL = `dropped`. */
export async function rejectArticle(
  pool: Pool,
  input: { title: string; sourceUrl: string; reason: string; sourceId: string | null }
): Promise<{ status: "rejected"; articleId: string | null; dropped: boolean }> {
  const articleId = await insertRejected(pool, input);
  return { status: "rejected", articleId, dropped: articleId === null };
}

function randomSuffix(): string {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, "").padEnd(SLUG_SUFFIX_LENGTH, "0").slice(0, SLUG_SUFFIX_LENGTH);
}

function isSlugConflict(error: unknown): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError.code === "23505" && typeof pgError.constraint === "string" && pgError.constraint.includes("slug");
}
