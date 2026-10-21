import { describe, expect, test } from "bun:test";

import {
  composeFailureMessage,
  escapeSlack,
  parseWorkflowNames,
  rejectionReason,
  runNotifier,
  shouldPostForRuns,
  type NotifyDependencies,
  type NotifyEnvironment,
} from "../scripts/dependabot-failure-notify.ts";

const baseEnv: NotifyEnvironment = {
  NOTIFY_TEST: "true",
  GH_TOKEN: "fake-github-token",
  REPO: "RunAtlas-is/example",
  SLACK_BOT_TOKEN: "fake-slack-token",
  SLACK_CHANNEL_ID: "C123",
};

const runEnv: NotifyEnvironment = {
  ...baseEnv,
  NOTIFY_TEST: "false",
  CI_WORKFLOWS: "CI",
  RUN_ID: "100",
};

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function dependabotRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    name: "CI",
    status: "completed",
    conclusion: "failure",
    updated_at: "2026-07-10T12:00:00Z",
    event: "pull_request",
    head_sha: "abc123",
    head_branch: "dependabot/npm/a",
    html_url: "https://github.com/RunAtlas-is/example/actions/runs/100",
    actor: { login: "dependabot[bot]" },
    repository: { full_name: "RunAtlas-is/example" },
    head_repository: { full_name: "RunAtlas-is/example" },
    pull_requests: [],
    ...overrides,
  };
}

describe("duplicate suppression", () => {
  test("trims the configured workflow list and removes empty names", () => {
    expect(parseWorkflowNames(" Testing, Quality checks, , ")).toEqual([
      "Testing",
      "Quality checks",
    ]);
  });

  test("selects only the earliest completed matching failure", () => {
    const runs = [
      {
        id: 20,
        name: "Testing",
        conclusion: "failure",
        updated_at: "2026-07-10T12:00:00Z",
      },
      {
        id: 10,
        name: "Quality checks",
        conclusion: "failure",
        updated_at: "2026-07-10T12:00:00Z",
      },
      {
        id: 5,
        name: "Advisory",
        conclusion: "failure",
        updated_at: "2026-07-10T11:00:00Z",
      },
    ];
    expect(shouldPostForRuns(runs, ["Testing", "Quality checks"], 10)).toBe(
      true,
    );
    expect(shouldPostForRuns(runs, ["Testing", "Quality checks"], 20)).toBe(
      false,
    );
    expect(shouldPostForRuns(runs, ["Testing", "Quality checks"], 99)).toBe(
      true,
    );
  });
});

describe("escapeSlack", () => {
  test("escapes all three special characters in a single pass", () => {
    expect(escapeSlack("<a & b>")).toBe("&lt;a &amp; b&gt;");
  });

  test("does not double-escape an ampersand introduced by escaping", () => {
    // The single-pass replace must not re-process the & in &lt;/&gt;; the only
    // &amp; in the output is the one escaping the literal input ampersand.
    expect(escapeSlack("<&>")).toBe("&lt;&amp;&gt;");
    expect(escapeSlack("&lt;")).toBe("&amp;lt;");
  });

  test("leaves ordinary text untouched", () => {
    expect(escapeSlack("plain text 123")).toBe("plain text 123");
  });
});

test("composes the real notification with escaped PR and job text", () => {
  expect(
    composeFailureMessage({
      repo: "RunAtlas-is/example",
      prNumber: "42",
      prTitle: "Bump one & <two>",
      branch: "dependabot/npm/a",
      workflowName: "CI <required>",
      failedJobs: "lint & test",
      runUrl: "https://github.com/RunAtlas-is/example/actions/runs/1",
    }),
  ).toBe(
    "Dependabot PR checks failed in RunAtlas-is/example: <https://github.com/RunAtlas-is/example/pull/42|#42 Bump one &amp; &lt;two&gt;> \u2014 <https://github.com/RunAtlas-is/example/actions/runs/1|CI &lt;required&gt;> (failed jobs: lint &amp; test)",
  );
});

test("manual test mode posts without a channel mention or GitHub requests", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const dependencies: NotifyDependencies = {
    fetch: (async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse({ ok: true, ts: "123.456" });
    }) as typeof fetch,
    log: () => {},
    warn: () => {},
    sleep: async () => {},
  };

  await runNotifier(baseEnv, dependencies);

  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe("https://slack.com/api/chat.postMessage");
  const body = JSON.parse(String(requests[0].init?.body));
  expect(body.text).toBe(
    "[test] Dependabot failure notifier dry run from RunAtlas-is/example: posting mechanics verified, no CI actually failed. Ignore this message.",
  );
  expect(body.text).not.toContain("<!channel>");
  expect(requests[0].init?.headers).toEqual({
    Authorization: "Bearer fake-slack-token",
    "Content-Type": "application/json; charset=utf-8",
  });
});

describe("run eligibility", () => {
  test("accepts a failed Dependabot pull request run of a CI workflow", () => {
    expect(
      rejectionReason(dependabotRun(), "RunAtlas-is/example", ["CI"]),
    ).toBeUndefined();
  });

  test.each([
    [
      "a run from a fork",
      { head_repository: { full_name: "attacker/example" } },
      "run head is not a branch of this repository",
    ],
    [
      "a run with no head repository",
      { head_repository: null },
      "run head is not a branch of this repository",
    ],
    [
      "a run of another repository",
      { repository: { full_name: "RunAtlas-is/other" } },
      "run belongs to RunAtlas-is/other",
    ],
    [
      "a run started by a person",
      { actor: { login: "octocat" } },
      "run actor is not Dependabot",
    ],
    ["a push run", { event: "push" }, "run event is push"],
    [
      "a run of another workflow",
      { name: "Release" },
      "workflow Release is not a CI workflow",
    ],
    [
      "a successful run",
      { conclusion: "success" },
      "run concluded success",
    ],
  ])("rejects %s", (_label, overrides, reason) => {
    expect(
      rejectionReason(dependabotRun(overrides), "RunAtlas-is/example", ["CI"]),
    ).toBe(reason);
  });
});

test("waits for the run, resolves the PR and failed jobs, then posts", async () => {
  const requests: string[] = [];
  const runReplies = [
    dependabotRun({ status: "in_progress", conclusion: null }),
    dependabotRun(),
  ];
  let sleeps = 0;
  const dependencies: NotifyDependencies = {
    fetch: (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/actions/runs/100")) {
        return jsonResponse(runReplies.shift());
      }
      if (url.includes("/actions/runs?")) {
        return jsonResponse({ workflow_runs: [dependabotRun()] });
      }
      if (url.includes("/pulls?")) {
        return jsonResponse([{ number: 42 }]);
      }
      if (url.endsWith("/pulls/42")) {
        return jsonResponse({ number: 42, title: "Bump dependency" });
      }
      if (url.includes("/actions/runs/100/jobs")) {
        return jsonResponse({
          jobs: [
            { name: "validate", conclusion: "failure" },
            { name: "Notify Dependabot failure", conclusion: "success" },
          ],
        });
      }
      if (url === "https://slack.com/api/chat.postMessage") {
        return jsonResponse({ ok: true, ts: "123.456" });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as typeof fetch,
    log: () => {},
    warn: () => {},
    sleep: async () => {
      sleeps += 1;
    },
  };

  await runNotifier(runEnv, dependencies);

  expect(sleeps).toBe(1);
  expect(requests).toHaveLength(7);
  expect(requests.at(-1)).toBe("https://slack.com/api/chat.postMessage");
});

test("does not post for a run that fails the eligibility check", async () => {
  const requests: string[] = [];
  const warnings: string[] = [];
  const dependencies: NotifyDependencies = {
    fetch: (async (input) => {
      requests.push(String(input));
      return jsonResponse(
        dependabotRun({ head_repository: { full_name: "attacker/example" } }),
      );
    }) as typeof fetch,
    log: () => {},
    warn: (message) => warnings.push(message),
    sleep: async () => {},
  };

  await runNotifier(runEnv, dependencies);

  expect(requests).toEqual([
    "https://api.github.com/repos/RunAtlas-is/example/actions/runs/100",
  ]);
  expect(warnings).toEqual([
    "::warning::Not notifying for run 100: run head is not a branch of this repository.",
  ]);
});

test("refuses a run ID that is not a number", async () => {
  const dependencies: NotifyDependencies = {
    fetch: (async () => {
      throw new Error("no request expected");
    }) as typeof fetch,
    log: () => {},
    warn: () => {},
    sleep: async () => {},
  };

  expect(
    runNotifier({ ...runEnv, RUN_ID: "100/../../pulls" }, dependencies),
  ).rejects.toThrow("RUN_ID must be a workflow run ID");
});

test("gives up on a run that never completes", async () => {
  const dependencies: NotifyDependencies = {
    fetch: (async () =>
      jsonResponse(
        dependabotRun({ status: "in_progress", conclusion: null }),
      )) as typeof fetch,
    log: () => {},
    warn: () => {},
    sleep: async () => {},
  };

  expect(runNotifier(runEnv, dependencies)).rejects.toThrow(
    "Run 100 did not complete; status in_progress",
  );
});

test("does not post when an earlier matching failure exists", async () => {
  const requests: string[] = [];
  const dependencies: NotifyDependencies = {
    fetch: (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/actions/runs/100")) {
        return jsonResponse(dependabotRun());
      }
      return jsonResponse({
        workflow_runs: [
          {
            id: 99,
            name: "CI",
            conclusion: "failure",
            updated_at: "2026-07-10T11:59:00Z",
          },
          {
            id: 100,
            name: "CI",
            conclusion: "failure",
            updated_at: "2026-07-10T12:00:00Z",
          },
        ],
      });
    }) as typeof fetch,
    log: () => {},
    warn: () => {},
    sleep: async () => {},
  };

  await runNotifier(runEnv, dependencies);

  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("/actions/runs?");
});

test("fails loudly when Slack returns ok false", async () => {
  const dependencies: NotifyDependencies = {
    fetch: (async () => jsonResponse({ ok: false, error: "not_authed" })) as typeof fetch,
    log: () => {},
    warn: () => {},
    sleep: async () => {},
  };

  expect(runNotifier(baseEnv, dependencies)).rejects.toThrow(
    "Slack chat.postMessage failed: not_authed",
  );
});

test("joins the channel and retries when the bot is not a member", async () => {
  const replies = [
    { ok: false, error: "not_in_channel" },
    { ok: true },
    { ok: true, ts: "123.456" },
  ];
  const requests: { url: string; body: unknown }[] = [];
  const dependencies: NotifyDependencies = {
    fetch: (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse(replies.shift());
    }) as typeof fetch,
    log: () => {},
    warn: () => {},
    sleep: async () => {},
  };

  await runNotifier(baseEnv, dependencies);

  expect(requests.map((request) => request.url)).toEqual([
    "https://slack.com/api/chat.postMessage",
    "https://slack.com/api/conversations.join",
    "https://slack.com/api/chat.postMessage",
  ]);
  expect(requests[1].body).toEqual({ channel: "C123" });
});
