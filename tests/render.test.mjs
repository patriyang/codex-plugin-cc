import test from "node:test";
import assert from "node:assert/strict";

import {
  renderCancelReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult places model and effort attribution after the target", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine.",
        findings: [],
        next_steps: []
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine.",
        findings: [],
        next_steps: []
      }),
      parseError: null
    },
    {
      reviewLabel: "Deep Review",
      targetLabel: "working tree diff",
      model: "gpt-5.6-sol",
      effort: "medium"
    }
  );

  assert.match(output, /Target: working tree diff\nModel: gpt-5\.6-sol\nEffort: medium\nVerdict: approve/);
});

test("renderReviewResult omits attribution when model and effort are not supplied", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine.",
        findings: [],
        next_steps: []
      },
      rawOutput: null,
      parseError: null
    },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff"
    }
  );

  assert.doesNotMatch(output, /^Model:/m);
  assert.doesNotMatch(output, /^Effort:/m);
});

test("renderNativeReviewResult includes model attribution without effort", () => {
  const output = renderNativeReviewResult(
    {
      stdout: "Reviewed uncommitted changes.",
      stderr: "",
      status: 0
    },
    {
      reviewLabel: "Review",
      targetLabel: "working tree diff",
      model: "gpt-5.5"
    }
  );

  assert.match(output, /^Model: gpt-5\.5$/m);
  assert.doesNotMatch(output, /^Effort:/m);
});

test("renderStatusReport explains why a reaped job failed", () => {
  const errorMessage =
    "Worker process 1234 is no longer running; the job ended without recording a result.";
  const output = renderStatusReport({
    sessionRuntime: { label: "direct startup" },
    config: { stopReviewGate: false },
    running: [],
    latestFinished: {
      id: "task-dead",
      status: "failed",
      kindLabel: "rescue",
      title: "Codex Task",
      phase: "failed",
      duration: "5s",
      errorMessage,
      reaped: true
    },
    recent: [],
    needsReview: false
  });

  assert.match(output, /Latest finished:/);
  assert.match(output, new RegExp(`Error: ${errorMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("renderCancelReport explains an explicit cancel that reaped a failed job", () => {
  const output = renderCancelReport({
    id: "task-dead",
    status: "failed",
    title: "Codex Task",
    reaped: true
  });

  assert.match(output, /already ended/);
  assert.match(output, /reaped and marked failed/);
  assert.doesNotMatch(output, /No job found|Cancelled/);
});

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderReviewResult still reports attribution when Codex returns unparseable output", () => {
  const output = renderReviewResult(
    {
      parsed: null,
      rawOutput: "not json at all",
      parseError: "Unexpected token 'n'"
    },
    {
      reviewLabel: "Deep Review",
      targetLabel: "working tree diff",
      model: "gpt-5.6-sol",
      effort: "medium"
    }
  );

  assert.match(output, /^Model: gpt-5\.6-sol$/m);
  assert.match(output, /^Effort: medium$/m);
  assert.match(output, /Codex did not return valid structured JSON\./);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});

test("renderTaskResult leads with the failure reason instead of the partial message (#88)", () => {
  const output = renderTaskResult(
    {
      rawOutput: "",
      partialOutput: "I'm applying only the requested edits now, then I'll report back.",
      failureMessage: "Codex turn stalled (idle): no activity for 900s. Interrupting and aborting the turn.",
      touchedFiles: ["/repo/a.py", "/repo/b.py"]
    },
    { title: "Codex Task", write: true }
  );

  assert.match(output, /Codex turn stalled \(idle\)/);
  // The partial text must never be presented as if it were the report.
  assert.doesNotMatch(output, /^I'm applying only the requested edits/);
  assert.match(output, /partial/i);
  assert.match(output, /a\.py/);
  assert.match(output, /b\.py/);
});

test("renderTaskResult returns the final message unchanged on a completed turn", () => {
  const output = renderTaskResult(
    {
      rawOutput: "## Status\nDONE\n",
      partialOutput: "",
      failureMessage: "",
      touchedFiles: ["/repo/a.py"]
    },
    { title: "Codex Task", write: true }
  );

  assert.equal(output, "## Status\nDONE\n");
});
