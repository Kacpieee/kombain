import { describe, expect, it, vi } from "vitest";
import { handleFatal } from "./index.js";

describe("handleFatal", () => {
  it("loguje, alertuje Telegram i pinguje /fail, zwraca 1", async () => {
    const notifySpy = vi.fn(async (_text: string) => true);
    const hcSpy = vi.fn(async (_state: "start" | "success" | "fail") => true);
    const logs: string[] = [];

    const code = await handleFatal(new Error("boom"), {
      notify: notifySpy,
      healthcheck: hcSpy,
      error: (line) => logs.push(line),
    });

    expect(code).toBe(1);
    expect(logs[0]).toContain('"event":"worker_fatal"');
    expect(logs[0]).toContain("boom");
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]?.[0]).toContain("worker_fatal: boom");
    expect(hcSpy).toHaveBeenCalledWith("fail");
  });
});
