import { z } from "zod";

const envSchema = z.object({
  DIRECT_DATABASE_URL: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_LITE_MODEL: z.string().default("gemini-3.1-flash-lite"),
  GEMINI_PRO_MODEL: z.string().default("gemini-3.8-flash"),
  SCRAPINGANT_API_KEY: z.string().optional(),
  MAX_PUBLISHED_PER_RUN: z.coerce.number().default(2),
});

export type AppConfig = z.infer<typeof envSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
