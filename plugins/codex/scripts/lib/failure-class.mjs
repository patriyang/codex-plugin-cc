export const CAPACITY = "capacity";
export const USAGE_LIMIT = "usage-limit";
export const STALLED = "stalled";
export const STATE_DRIFT = "state-drift";
export const OUTDATED_CLIENT = "outdated-client";
export const CAPACITY_RETRY_AFTER_MS = 60_000;
const OUTDATED_CLIENT_GUIDANCE =
  "Update Codex with `npm install -g @openai/codex@latest`, or pass --model to pick a model this Codex version supports.";

export function formatFailureMessage(message, failureClass) {
  if (failureClass !== OUTDATED_CLIENT || typeof message !== "string" || !message.trim()) {
    return message;
  }
  return `${message}\n\n${OUTDATED_CLIENT_GUIDANCE}`;
}

function parseUsageLimitRetryAfterMs(message, now) {
  const clockMatch = /\btry again at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(message);
  if (clockMatch) {
    const hour = Number(clockMatch[1]);
    const minute = Number(clockMatch[2]);
    if (hour < 1 || hour > 12 || minute > 59) {
      return null;
    }
    const target = new Date(now);
    const localHour = hour % 12 + (clockMatch[3].toUpperCase() === "PM" ? 12 : 0);
    target.setHours(localHour, minute, 0, 0);
    if (target.getTime() <= now) {
      target.setDate(target.getDate() + 1);
    }
    const retryAfterMs = target.getTime() - now;
    return retryAfterMs > 0 ? retryAfterMs : null;
  }

  const hoursMatch = /\btry again in\s+(\d+)\s+hours?(?:\s+(\d+)\s+minutes?)?\b/i.exec(message);
  if (hoursMatch) {
    const retryAfterMs = (Number(hoursMatch[1]) * 60 + Number(hoursMatch[2] ?? 0)) * 60_000;
    return retryAfterMs > 0 ? retryAfterMs : null;
  }

  const minutesMatch = /\btry again in\s+(\d+)\s+minutes?\b/i.exec(message);
  if (minutesMatch) {
    const retryAfterMs = Number(minutesMatch[1]) * 60_000;
    return retryAfterMs > 0 ? retryAfterMs : null;
  }

  return null;
}

export function classifyFailureMessage(message, now = Date.now()) {
  if (typeof message !== "string") {
    return { failureClass: null, retryable: false, retryAfterMs: null };
  }

  // Match capacity wording only. "Try a different model" is advice the server
  // also appends to unrelated model-compatibility errors, so on its own it says
  // nothing about capacity — the real capacity message carries "at capacity"
  // alongside it.
  if (/\bat capacity\b/i.test(message) || /\bis (currently )?overloaded\b/i.test(message)) {
    return { failureClass: CAPACITY, retryable: true, retryAfterMs: CAPACITY_RETRY_AFTER_MS };
  }

  if (/\busage limit\b/i.test(message)) {
    return {
      failureClass: USAGE_LIMIT,
      retryable: true,
      retryAfterMs: parseUsageLimitRetryAfterMs(message, now)
    };
  }

  if (/requires a newer version of codex/i.test(message)) {
    return { failureClass: OUTDATED_CLIENT, retryable: false, retryAfterMs: null };
  }

  return { failureClass: null, retryable: false, retryAfterMs: null };
}
