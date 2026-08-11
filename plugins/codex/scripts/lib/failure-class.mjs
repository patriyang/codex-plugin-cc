export const CAPACITY = "capacity";
export const STATE_DRIFT = "state-drift";

export function classifyFailureMessage(message) {
  if (typeof message !== "string") {
    return { failureClass: null, retryable: false };
  }

  if (
    /\bat capacity\b/i.test(message) ||
    /\bis (currently )?overloaded\b/i.test(message) ||
    /\btry a different model\b/i.test(message)
  ) {
    return { failureClass: CAPACITY, retryable: true };
  }

  return { failureClass: null, retryable: false };
}
