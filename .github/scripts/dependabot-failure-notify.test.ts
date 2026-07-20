import { describe, expect, test } from "bun:test";

import {
  composeFailureMessage,
  escapeSlack,
  parseWorkflowNames,
  runNotifier,
  shouldPostForRuns,
  type NotifyDependencies,
  type NotifyEnvironment,
} from "../scripts/dependabot-failure-notify.ts";

const baseEnv: NotifyEnvironment = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GH_TOKEN: "fake-github-token",
  REPO: "RunAtlas-is/example",
  SLACK_BOT_TOKEN: "fake-slack-token",
  SLACK_CHANNEL_ID: "C123",
};

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
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
    "<!channel> Dependabot PR checks failed in RunAtlas-is/example: <https://github.com/RunAtlas-is/example/pull/42|#42 Bump one &amp; &lt;two&gt;> \u2014 <https://github.com/RunAtlas-is/example/actions/runs/1|CI &lt;required&gt;> (failed jobs: lint &amp; test)",
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

test("resolves a missing PR number and failed jobs before posting", async () => {
  const requests: string[] = [];
  const dependencies: NotifyDependencies = {
    fetch: (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/actions/runs?")) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 100,
              name: "CI",
              conclusion: "failure",
              updated_at: "2026-07-10T12:00:00Z",
            },
          ],
        });
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
            { name: "test", conclusion: "failure" },
            { name: "lint", conclusion: "success" },
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
  };

  await runNotifier(
    {
      ...baseEnv,
      GITHUB_EVENT_NAME: "workflow_run",
      CI_WORKFLOWS: "CI",
      RUN_ID: "100",
      HEAD_SHA: "abc123",
      HEAD_BRANCH: "dependabot/npm/a",
      WORKFLOW_NAME: "CI",
      RUN_URL: "https://github.com/RunAtlas-is/example/actions/runs/100",
    },
    dependencies,
  );

  expect(requests).toHaveLength(5);
  expect(requests.at(-1)).toBe("https://slack.com/api/chat.postMessage");
});

test("does not post when an earlier matching failure exists", async () => {
  const requests: string[] = [];
  const dependencies: NotifyDependencies = {
    fetch: (async (input) => {
      const url = String(input);
      requests.push(url);
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
  };

  await runNotifier(
    {
      ...baseEnv,
      GITHUB_EVENT_NAME: "workflow_run",
      CI_WORKFLOWS: "CI",
      RUN_ID: "100",
      HEAD_SHA: "abc123",
    },
    dependencies,
  );

  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("/actions/runs?");
});

test("fails loudly when Slack returns ok false", async () => {
  const dependencies: NotifyDependencies = {
    fetch: (async () => jsonResponse({ ok: false, error: "not_authed" })) as typeof fetch,
    log: () => {},
    warn: () => {},
  };

  expect(runNotifier(baseEnv, dependencies)).rejects.toThrow(
    "Slack chat.postMessage failed: not_authed",
  );
});
