import { describe, expect, it, vi } from "vitest";
import { formatRunSummary, notify, pingHealthcheck, resetNotifyRateLimit, shouldAlert } from "./notify.js";

const REPORT = {
  sources: 2,
  processed: 3,
  published: 1,
  draft: 1,
  rejected: 2,
  dry_run: 0,
  dropped_silent: 4,
  errors: ["gate: 429"],
  source_errors: 1,
  fallback_used: 2,
  image_fallback_used: 1,
};

describe("formatRunSummary", () => {
  it("zawiera liczniki i czas", () => {
    const text = formatRunSummary(REPORT, 125_000);
    expect(text).toContain("Worker zakończony w 125s");
    expect(text).toContain("published: 1");
    expect(text).toContain("draft: 1");
    expect(text).toContain("rejected: 2");
    expect(text).toContain("fallback scrape: 2");
    expect(text).toContain("gate: 429");
  });

  it("dry-run ma własny nagłówek", () => {
    expect(formatRunSummary(REPORT, 1000, true)).toContain("DRY-RUN");
  });
});

describe("shouldAlert", () => {
  it("alert przy 3+ błędach", () => {
    expect(shouldAlert(REPORT)).toBe(false);
    expect(shouldAlert({ ...REPORT, errors: ["a", "b", "c"] })).toBe(true);
  });

  it("alert gdy padły wszystkie źródła", () => {
    expect(shouldAlert({ ...REPORT, sources: 2, source_errors: 2 })).toBe(true);
    expect(shouldAlert({ ...REPORT, sources: 2, source_errors: 1 })).toBe(false);
  });
});

describe("notify (Telegram)", () => {
  it("bez tokenu/chat_id = no-op (bez sieci)", async () => {
    const send = vi.fn(async () => {});
    await expect(notify("test", { token: "", chatId: "", send })).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("wysyła przez wstrzyknięty send i redaguje sekrety", async () => {
    resetNotifyRateLimit();
    let sent = "";
    const ok = await notify("klucz=SECRET-123", {
      token: "t",
      chatId: "c",
      now: () => 1_000_000,
      secrets: ["SECRET-123"],
      send: async (text) => {
        sent = text;
      },
    });

    expect(ok).toBe(true);
    expect(sent).toBe("klucz=[redacted]");
  });

  it("rate-limit: druga wiadomość w minucie jest pomijana", async () => {
    resetNotifyRateLimit();
    const send = vi.fn(async () => {});
    const deps = { token: "t", chatId: "c", now: () => 5_000_000, send };

    await expect(notify("1", deps)).resolves.toBe(true);
    await expect(notify("2", deps)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("błąd wysyłki nie rzuca", async () => {
    resetNotifyRateLimit();
    const ok = await notify("x", {
      token: "t",
      chatId: "c",
      now: () => 9_000_000,
      send: async () => {
        throw new Error("network");
      },
    });
    expect(ok).toBe(false);
  });
});

describe("pingHealthcheck", () => {
  it("bez URL = no-op", async () => {
    await expect(pingHealthcheck("start", { url: "" })).resolves.toBe(false);
  });

  it("woła /start, base i /fail", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    await pingHealthcheck("start", { url: "https://hc-ping.com/uuid", fetchImpl });
    await pingHealthcheck("success", { url: "https://hc-ping.com/uuid", fetchImpl });
    await pingHealthcheck("fail", { url: "https://hc-ping.com/uuid", fetchImpl });

    expect(urls).toEqual(["https://hc-ping.com/uuid/start", "https://hc-ping.com/uuid", "https://hc-ping.com/uuid/fail"]);
  });

  it("błąd sieci nie rzuca", async () => {
    const fetchImpl = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    await expect(pingHealthcheck("fail", { url: "https://hc/x", fetchImpl })).resolves.toBe(false);
  });
});
