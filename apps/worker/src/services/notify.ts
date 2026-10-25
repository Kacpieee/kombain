export interface SummaryReport {
  sources: number;
  processed: number;
  published: number;
  draft: number;
  rejected: number;
  dry_run: number;
  dropped_silent: number;
  errors: string[];
  source_errors: number;
  fallback_used: number;
  image_fallback_used: number;
}

export interface NotifyDeps {
  token?: string;
  chatId?: string;
  send?: (text: string) => Promise<void>;
  now?: () => number;
  secrets?: string[];
}

let lastSentAt = 0;
const MIN_INTERVAL_MS = 60_000;

export function resetNotifyRateLimit(): void {
  lastSentAt = 0;
}

export function formatRunSummary(report: SummaryReport, durationMs: number, dryRun = false): string {
  const seconds = Math.round(durationMs / 1000);
  const lines = [
    `${dryRun ? "DRY-RUN" : "Worker"} zakończony w ${seconds}s`,
    `źródła: ${report.sources} (błędy: ${report.source_errors})`,
    `przetworzone: ${report.processed}`,
    `published: ${report.published} | draft: ${report.draft} | rejected: ${report.rejected}`,
    `pominięte: ${report.dropped_silent}${report.dry_run > 0 ? ` | dry-run: ${report.dry_run}` : ""}`,
    `fallback scrape: ${report.fallback_used} | fallback obraz: ${report.image_fallback_used}`,
  ];
  if (report.errors.length > 0) lines.push(`błędy: ${report.errors.slice(0, 3).join("; ")}`);
  return lines.join("\n");
}

export function shouldAlert(report: SummaryReport): boolean {
  if (report.errors.length >= 3) return true;
  if (report.sources > 0 && report.source_errors === report.sources) return true;
  return false;
}

/** Telegram; bez tokenu/chat_id = no-op. Rate-limit 1 wiadomość/min. */
export async function notify(text: string, deps: NotifyDeps = {}): Promise<boolean> {
  const token = deps.token ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = deps.chatId ?? process.env.TELEGRAM_CHAT_ID ?? "";
  if (!token || !chatId) return false;

  const now = (deps.now ?? Date.now)();
  if (now - lastSentAt < MIN_INTERVAL_MS) return false;
  lastSentAt = now;

  const safe = redact(text, deps.secrets ?? envSecrets());

  try {
    if (deps.send) {
      await deps.send(safe);
      return true;
    }
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: safe, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface HealthcheckDeps {
  url?: string;
  fetchImpl?: typeof fetch;
}

/** healthchecks.io: start/success/fail; bez URL = no-op. Błędy połykane. */
export async function pingHealthcheck(state: "start" | "success" | "fail", deps: HealthcheckDeps = {}): Promise<boolean> {
  const base = deps.url ?? process.env.HEALTHCHECKS_PING_URL ?? "";
  if (!base) return false;

  const target = state === "start" ? `${base.replace(/\/$/, "")}/start` : state === "fail" ? `${base.replace(/\/$/, "")}/fail` : base;
  try {
    const response = await (deps.fetchImpl ?? fetch)(target, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

function envSecrets(): string[] {
  return [
    process.env.GEMINI_API_KEY,
    process.env.SCRAPINGANT_API_KEY,
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.R2_ACCESS_KEY_ID,
    process.env.R2_SECRET_ACCESS_KEY,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => acc.split(secret).join("[redacted]"), text);
}
