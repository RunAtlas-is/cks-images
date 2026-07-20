interface WorkflowRun {
  id: number;
  name: string;
  conclusion: string | null;
  updated_at: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
}

interface PullRequest {
  number: number;
  title: string;
}

interface JobsResponse {
  jobs: Array<{ name: string; conclusion: string | null }>;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  ts?: string;
}

export interface NotifyEnvironment {
  GITHUB_EVENT_NAME: string;
  GH_TOKEN: string;
  REPO: string;
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string;
  CI_WORKFLOWS?: string;
  RUN_ID?: string;
  HEAD_SHA?: string;
  WORKFLOW_NAME?: string;
  RUN_URL?: string;
  HEAD_BRANCH?: string;
  PR_NUMBER?: string;
  GITHUB_API_URL?: string;
}

export interface NotifyDependencies {
  fetch: typeof fetch;
  log: (message: string) => void;
  warn: (message: string) => void;
}

const defaultDependencies: NotifyDependencies = {
  fetch,
  log: console.log,
  warn: console.warn,
};

export function parseWorkflowNames(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export function shouldPostForRuns(
  runs: WorkflowRun[],
  workflowNames: string[],
  runId: number,
): boolean {
  const allowed = new Set(workflowNames);
  const failed = runs.filter(
    (run) => run.conclusion === "failure" && allowed.has(run.name),
  );
  const current = failed.find((run) => run.id === runId);
  if (!current) {
    return true;
  }
  return !failed.some(
    (run) =>
      run.id !== runId &&
      (run.updated_at < current.updated_at ||
        (run.updated_at === current.updated_at && run.id < current.id)),
  );
}

const SLACK_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeSlack(value: string): string {
  return value.replace(/[&<>]/g, (char) => SLACK_ESCAPE_MAP[char]);
}

export function composeFailureMessage(context: {
  repo: string;
  prNumber: string;
  prTitle: string;
  branch: string;
  workflowName: string;
  failedJobs: string;
  runUrl: string;
}): string {
  const pr = context.prNumber
    ? `<https://github.com/${context.repo}/pull/${context.prNumber}|#${context.prNumber} ${escapeSlack(context.prTitle)}>`
    : `branch ${escapeSlack(context.branch)} (no PR found)`;
  const jobsNote = context.failedJobs
    ? ` (failed jobs: ${escapeSlack(context.failedJobs)})`
    : "";
  return `<!channel> Dependabot PR checks failed in ${context.repo}: ${pr} \u2014 <${context.runUrl}|${escapeSlack(context.workflowName)}>${jobsNote}`;
}

function requireValue(
  env: Partial<NotifyEnvironment>,
  key: keyof NotifyEnvironment,
): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

async function responseJson<T>(
  response: Response,
  operation: string,
): Promise<T> {
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubJson<T>(
  path: string,
  env: NotifyEnvironment,
  dependencies: NotifyDependencies,
): Promise<T> {
  const baseUrl = env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await dependencies.fetch(`${baseUrl}${path}`, {
    headers: githubHeaders(env.GH_TOKEN),
  });
  return responseJson<T>(response, `GitHub API request ${path}`);
}

async function suppressDuplicate(
  env: NotifyEnvironment,
  dependencies: NotifyDependencies,
): Promise<boolean> {
  const workflowNames = parseWorkflowNames(env.CI_WORKFLOWS ?? "");
  if (workflowNames.length === 0) {
    dependencies.log("No ci-workflows list; suppression disabled.");
    return false;
  }

  const runId = Number(requireValue(env, "RUN_ID"));
  const headSha = requireValue(env, "HEAD_SHA");
  try {
    const query = new URLSearchParams({
      head_sha: headSha,
      status: "completed",
      per_page: "100",
    });
    const response = await githubJson<WorkflowRunsResponse>(
      `/repos/${env.REPO}/actions/runs?${query}`,
      env,
      dependencies,
    );
    const post = shouldPostForRuns(response.workflow_runs, workflowNames, runId);
    if (!post) {
      dependencies.log(
        `An earlier-completed CI failure for ${headSha} already notified; skipping.`,
      );
    }
    return !post;
  } catch (error) {
    dependencies.warn(
      `::warning::Could not list runs for duplicate suppression; posting anyway. ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function optionalGithubJson<T>(
  path: string,
  env: NotifyEnvironment,
  dependencies: NotifyDependencies,
): Promise<T | undefined> {
  try {
    return await githubJson<T>(path, env, dependencies);
  } catch {
    return undefined;
  }
}

async function composeMessage(
  env: NotifyEnvironment,
  dependencies: NotifyDependencies,
): Promise<string> {
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    return `[test] Dependabot failure notifier dry run from ${env.REPO}: posting mechanics verified, no CI actually failed. Ignore this message.`;
  }

  let prNumber = env.PR_NUMBER ?? "";
  if (!prNumber) {
    const owner = env.REPO.split("/", 1)[0];
    const query = new URLSearchParams({
      head: `${owner}:${env.HEAD_BRANCH ?? ""}`,
      state: "all",
      per_page: "1",
    });
    const pulls = await optionalGithubJson<PullRequest[]>(
      `/repos/${env.REPO}/pulls?${query}`,
      env,
      dependencies,
    );
    prNumber = pulls?.[0]?.number ? String(pulls[0].number) : "";
  }

  let prTitle = "";
  if (prNumber) {
    const pull = await optionalGithubJson<PullRequest>(
      `/repos/${env.REPO}/pulls/${prNumber}`,
      env,
      dependencies,
    );
    prTitle = pull?.title ?? "";
  }

  const jobs = await optionalGithubJson<JobsResponse>(
    `/repos/${env.REPO}/actions/runs/${requireValue(env, "RUN_ID")}/jobs?per_page=100`,
    env,
    dependencies,
  );
  const failedJobs =
    jobs?.jobs
      .filter((job) => job.conclusion === "failure")
      .map((job) => job.name)
      .join(", ") ?? "";

  return composeFailureMessage({
    repo: env.REPO,
    prNumber,
    prTitle,
    branch: env.HEAD_BRANCH ?? "",
    workflowName: env.WORKFLOW_NAME ?? "",
    failedJobs,
    runUrl: env.RUN_URL ?? "",
  });
}

async function postToSlack(
  text: string,
  env: NotifyEnvironment,
  dependencies: NotifyDependencies,
): Promise<void> {
  const response = await dependencies.fetch(
    "https://slack.com/api/chat.postMessage",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: env.SLACK_CHANNEL_ID,
        text,
        unfurl_links: false,
        unfurl_media: false,
      }),
    },
  );
  const result = await responseJson<SlackResponse>(
    response,
    "Slack chat.postMessage",
  );
  if (result.ok !== true) {
    throw new Error(
      `Slack chat.postMessage failed: ${result.error ?? "unknown error"}`,
    );
  }
  dependencies.log(`Posted to ${env.SLACK_CHANNEL_ID} ts=${result.ts ?? ""}`);
}

export async function runNotifier(
  sourceEnv: Partial<NotifyEnvironment>,
  dependencies: NotifyDependencies = defaultDependencies,
): Promise<void> {
  const env: NotifyEnvironment = {
    ...sourceEnv,
    GITHUB_EVENT_NAME: requireValue(sourceEnv, "GITHUB_EVENT_NAME"),
    GH_TOKEN: requireValue(sourceEnv, "GH_TOKEN"),
    REPO: requireValue(sourceEnv, "REPO"),
    SLACK_BOT_TOKEN: requireValue(sourceEnv, "SLACK_BOT_TOKEN"),
    SLACK_CHANNEL_ID: requireValue(sourceEnv, "SLACK_CHANNEL_ID"),
  };

  if (
    env.GITHUB_EVENT_NAME === "workflow_run" &&
    (await suppressDuplicate(env, dependencies))
  ) {
    return;
  }
  const text = await composeMessage(env, dependencies);
  await postToSlack(text, env, dependencies);
}

if (import.meta.main) {
  try {
    await runNotifier(process.env);
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
