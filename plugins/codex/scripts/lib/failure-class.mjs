export const CAPACITY = "capacity";
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

export function classifyFailureMessage(message) {
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

  if (/requires a newer version of codex/i.test(message)) {
    return { failureClass: OUTDATED_CLIENT, retryable: false, retryAfterMs: null };
  }

  return { failureClass: null, retryable: false, retryAfterMs: null };
}
