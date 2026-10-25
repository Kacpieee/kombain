import { z } from "zod";

const envSchema = z.object({
  DIRECT_DATABASE_URL: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_LITE_MODEL: z.string().default("gemini-3.1-flash-lite"),
  GEMINI_PRO_MODEL: z.string().default("gemini-3.8-flash"),
  SCRAPINGANT_API_KEY: z.string().optional(),
  MAX_PUBLISHED_PER_RUN: z.coerce.number().int().min(1).max(2).default(2),
  MAX_LINKS_PER_SOURCE: z.coerce.number().int().min(1).max(15).default(15),
  FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(5),
  R2_ENDPOINT: z.string().optional(),
  R2_BUCKET: z.string().default("articles"),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().default("https://media.kombain.pl"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
