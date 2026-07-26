import test from "node:test";
import assert from "node:assert/strict";

import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStatusReport,
  renderStoredJobResult
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
