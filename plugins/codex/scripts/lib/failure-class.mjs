export const CAPACITY = "capacity";
export const STATE_DRIFT = "state-drift";

export function classifyFailureMessage(message) {
  if (typeof message !== "string") {
    return { failureClass: null, retryable: false };
  }

  // Match capacity wording only. "Try a different model" is advice the server
  // also appends to unrelated model-compatibility errors, so on its own it says
  // nothing about capacity — the real capacity message carries "at capacity"
  // alongside it.
  if (/\bat capacity\b/i.test(message) || /\bis (currently )?overloaded\b/i.test(message)) {
    return { failureClass: CAPACITY, retryable: true };
  }

  return { failureClass: null, retryable: false };
}
