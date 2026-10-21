import { loadConfig } from "./config.js";

export async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(JSON.stringify({ ok: true, lite: cfg.GEMINI_LITE_MODEL, pro: cfg.GEMINI_PRO_MODEL, max: cfg.MAX_PUBLISHED_PER_RUN }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
