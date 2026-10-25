import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE = { DIRECT_DATABASE_URL: "postgres://u:p@localhost/db", GEMINI_API_KEY: "key" };

describe("loadConfig", () => {
  it("ustawia domyślne limity i modele", () => {
    const config = loadConfig(BASE as NodeJS.ProcessEnv);

    expect(config.MAX_PUBLISHED_PER_RUN).toBe(2);
    expect(config.MAX_LINKS_PER_SOURCE).toBe(15);
    expect(config.FETCH_CONCURRENCY).toBe(5);
    expect(config.GEMINI_LITE_MODEL).toBe("gemini-3.1-flash-lite");
    expect(config.GEMINI_PRO_MODEL).toBe("gemini-3.8-flash");
    expect(config.R2_BUCKET).toBe("articles");
  });

  it("koercuje liczby z env", () => {
    const config = loadConfig({ ...BASE, MAX_PUBLISHED_PER_RUN: "1", FETCH_CONCURRENCY: "2" } as NodeJS.ProcessEnv);
    expect(config.MAX_PUBLISHED_PER_RUN).toBe(1);
    expect(config.FETCH_CONCURRENCY).toBe(2);
  });

  it("brak wymaganego klucza = błąd", () => {
    expect(() => loadConfig({ GEMINI_API_KEY: "key" } as NodeJS.ProcessEnv)).toThrow();
    expect(() => loadConfig({ DIRECT_DATABASE_URL: "postgres://x" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("odrzuca limit publikacji > 10", () => {
    expect(() => loadConfig({ ...BASE, MAX_PUBLISHED_PER_RUN: "11" } as NodeJS.ProcessEnv)).toThrow();
  });
});
