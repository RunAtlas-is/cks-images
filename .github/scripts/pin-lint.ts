// Copy of .github/actions/pin-lint/scripts/pin-lint.ts from the RunAtlas-is
// organization's shared .github repository, commit
// 736623560c48bd45d97a4f5bd3f858f91aa485ab. This repository is public and
// cannot run that private repository's action, so it runs this copy. Update
// it by copying a newer revision whole and changing the commit above.

// Fails on references that let a build or deployment change without a commit:
// container images without a digest, `-latest` runner labels, toolchain setup
// steps without an exact version, `curl | sh` installers, and downloads with no
// checksum. Exemptions live in the scanned repository's `.github/pin-lint.yml`,
// each with a reason; an exemption that matches nothing is itself an error, so
// the list cannot outlive the reference it excuses.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type RuleId =
  | "image-digest"
  | "runner-label"
  | "toolchain-version"
  | "curl-pipe-shell"
  | "download-checksum";

export const RULES: readonly RuleId[] = [
  "image-digest",
  "runner-label",
  "toolchain-version",
  "curl-pipe-shell",
  "download-checksum",
];

export interface Finding {
  rule: RuleId;
  path: string;
  line: number;
  text: string;
  message: string;
}

export interface Exemption {
  rule: RuleId;
  path: string;
  match?: string;
  reason: string;
}

export const EXEMPTION_FILE = ".github/pin-lint.yml";

const DIGEST = /@sha256:[0-9a-f]{64}(?![0-9a-f])/;
const MAX_FILE_BYTES = 1_000_000;

// Version inputs each setup action reads; any one of them satisfies the rule.
const SETUP_VERSION_INPUTS: Record<string, string[]> = {
  "actions/setup-node": ["node-version", "node-version-file"],
  "actions/setup-python": ["python-version", "python-version-file"],
  "actions/setup-go": ["go-version", "go-version-file"],
  "actions/setup-java": ["java-version", "java-version-file"],
  "actions/setup-dotnet": ["dotnet-version", "global-json-file"],
  "oven-sh/setup-bun": ["bun-version", "bun-version-file"],
  "hashicorp/setup-terraform": ["terraform_version"],
  "opentofu/setup-opentofu": ["tofu_version"],
  "astral-sh/setup-uv": ["version", "version-file"],
  "denoland/setup-deno": ["deno-version", "deno-version-file"],
  "azure/setup-helm": ["version"],
  "azure/setup-kubectl": ["version"],
};

const FLOATING_VERSION = /^(latest|stable|lts|lts\/\*|node|current|\*|x|[0-9]+\.x|[0-9]+\.[0-9]+\.x)$/i;

export type FileKind = "workflow" | "action" | "yaml" | "dockerfile" | "shell";

export function classify(path: string): FileKind[] {
  const name = basename(path);
  const kinds: FileKind[] = [];
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) kinds.push("workflow");
  if (/^action\.ya?ml$/.test(name)) kinds.push("action");
  if (/\.ya?ml(\.j2)?$/.test(name)) kinds.push("yaml");
  if (/^(Dockerfile|Containerfile)(\..+)?$/.test(name) || /\.(Dockerfile|Containerfile)$/.test(name)) {
    kinds.push("dockerfile");
  }
  if (/\.(sh|bash)(\.j2)?$/.test(name)) kinds.push("shell");
  return kinds;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}

// Removes a trailing YAML comment and surrounding quotes from a scalar.
export function scalar(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("#")) return "";
  const quoted = /^(["'])(.*?)\1/.exec(value);
  if (quoted) return quoted[2];
  value = value.replace(/\s+#.*$/, "");
  return value.trim();
}

function templated(value: string): boolean {
  return /\{\{|\$\{|\$\(|^\$|^[*&!]/.test(value);
}

// The lines nested under the key on `start`: every following line indented
// deeper than the key, stopping at the first line that is not.
function block(lines: string[], start: number, keyIndent: number): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || isComment(line)) continue;
    if (indentOf(line) <= keyIndent) break;
    out.push([i, line]);
  }
  return out;
}

function keyIndentOf(line: string): number {
  const match = /^(\s*)(-\s+)?/.exec(line);
  return match ? match[1].length + (match[2]?.length ?? 0) : 0;
}

function imageNeedsDigest(value: string): boolean {
  let ref = value.replace(/^docker:\/\//, "");
  if (ref === "" || templated(ref)) return false;
  if (/(^|\/)(Dockerfile|Containerfile)$/.test(ref) || ref.startsWith("./")) return false;
  ref = ref.split(/\s+/)[0];
  return !DIGEST.test(ref);
}

function scanImages(path: string, lines: string[], kinds: FileKind[], findings: Finding[]): void {
  lines.forEach((line, index) => {
    if (isComment(line)) return;
    const image = /^\s*(?:-\s+)?image:(.*)$/.exec(line);
    if (image) {
      const value = scalar(image[1]);
      if (value === "" || value === "|" || value === ">") {
        return;
      } else if (value.startsWith("{")) {
        if (!templated(value) && !DIGEST.test(value) && !/digest:\s*["']?sha256:[0-9a-f]{64}/.test(value)) {
          findings.push(imageFinding(path, index, line, value));
        }
      } else if (imageNeedsDigest(value)) {
        // Beside `build:` (Compose) or `context:`/`dockerfile:` (a build matrix) the value
        // names an image this repository builds, not one it pulls.
        const { fields } = siblings(lines, index);
        if (!["build", "context", "dockerfile"].some((key) => fields.has(key))) findings.push(imageFinding(path, index, line, value));
      }
      return;
    }
    if (/^\s*(?:-\s+)?repository:/.test(line)) {
      checkImageMapping(path, lines, index, findings);
      return;
    }
    if (kinds.includes("workflow")) {
      const container = /^\s*container:\s*(\S.*)$/.exec(line);
      if (container) {
        const value = scalar(container[1]);
        if (value !== "" && imageNeedsDigest(value)) findings.push(imageFinding(path, index, line, value));
        return;
      }
    }
    if (kinds.includes("workflow") || kinds.includes("action")) {
      const dockerUse = /^\s*(?:-\s+)?uses:\s*(["']?docker:\/\/\S+)/.exec(line);
      if (dockerUse) {
        const value = scalar(dockerUse[1]);
        if (imageNeedsDigest(value)) findings.push(imageFinding(path, index, line, value));
      }
    }
  });
}

function imageFinding(path: string, index: number, line: string, value: string): Finding {
  return {
    rule: "image-digest",
    path,
    line: index + 1,
    text: line.trim(),
    message: `image ${value} has no @sha256 digest`,
  };
}

// A Helm-style image mapping (`repository` with a `tag`, or under a key
// named like `image`): pinned when the repository or tag carries a digest or a
// sibling digest key holds one. Other `repository:` keys (chart sources,
// package repositories) have neither and are left alone.
// The keys of the mapping that holds the key on `index`, with scalar values,
// and the key of the mapping's parent.
function siblings(lines: string[], index: number): { fields: Map<string, string>; parent: string } {
  const own = keyIndentOf(lines[index]);
  const fields = new Map<string, string>();
  let parent = "";
  const collect = (line: string): void => {
    const field = /^\s*(?:-\s+)?([A-Za-z_]+):(.*)$/.exec(line);
    if (field && keyIndentOf(line) === own) fields.set(field[1], scalar(field[2]));
  };
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "" || isComment(line)) continue;
    if (indentOf(line) < own && !/^\s*-\s+/.test(line)) {
      parent = /^\s*(?:-\s+)?([A-Za-z_]+):/.exec(line)?.[1] ?? "";
      break;
    }
    collect(line);
    if (keyIndentOf(line) === own && /^\s*-\s+/.test(line)) break;
  }
  collect(lines[index]);
  for (const [, line] of block(lines, index, own - 1)) {
    if (keyIndentOf(line) === own && /^\s*-\s+/.test(line)) break;
    collect(line);
  }
  return { fields, parent };
}

function checkImageMapping(path: string, lines: string[], index: number, findings: Finding[]): void {
  const { fields, parent } = siblings(lines, index);
  const repository = fields.get("repository") ?? "";
  if (!fields.has("tag") && !/image/i.test(parent)) return;
  const tag = fields.get("tag") ?? "";
  const digest = fields.get("digest") ?? "";
  const sha = fields.get("sha") ?? "";
  if (repository === "" || [repository, tag, digest].some(templated)) return;
  if (DIGEST.test(repository) || DIGEST.test(tag)) return;
  if (/@sha256$/.test(repository) && /^[0-9a-f]{64}$/.test(tag)) return;
  if (/^sha256:[0-9a-f]{64}$/.test(digest) || /^(sha256:)?[0-9a-f]{64}$/.test(sha)) return;
  findings.push({
    rule: "image-digest",
    path,
    line: index + 1,
    text: `${repository}${tag ? `:${tag}` : ""}`,
    message: `image ${repository}${tag ? `:${tag}` : ""} has no @sha256 digest`,
  });
}

function scanDockerfile(path: string, lines: string[], findings: Finding[]): void {
  const stages = new Set<string>();
  lines.forEach((line, index) => {
    if (isComment(line)) return;
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      const ref = from[1];
      if (from[2]) stages.add(from[2].toLowerCase());
      if (ref === "scratch" || stages.has(ref.toLowerCase()) || ref.includes("$")) return;
      if (!DIGEST.test(ref)) {
        findings.push({ rule: "image-digest", path, line: index + 1, text: line.trim(), message: `FROM ${ref} has no @sha256 digest` });
      }
      return;
    }
    const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/.exec(line);
    if (arg && /IMAGE/i.test(arg[1])) {
      const value = scalar(arg[2]);
      if (!templated(value) && /[:/]/.test(value) && !DIGEST.test(value)) {
        findings.push({ rule: "image-digest", path, line: index + 1, text: line.trim(), message: `ARG ${arg[1]} default ${value} has no @sha256 digest` });
      }
      return;
    }
    const add = /^\s*ADD\s+(.*)$/i.exec(line);
    if (add && /https?:\/\//.test(add[1]) && !/--checksum=/.test(add[1])) {
      findings.push({ rule: "download-checksum", path, line: index + 1, text: line.trim(), message: "ADD of a URL without --checksum" });
    }
  });
}

function scanRunnerLabels(path: string, lines: string[], findings: Finding[]): void {
  lines.forEach((line, index) => {
    if (isComment(line)) return;
    const label = /\b(ubuntu|windows|macos)-latest\b/.exec(line.replace(/\s+#.*$/, ""));
    if (label) {
      findings.push({
        rule: "runner-label",
        path,
        line: index + 1,
        text: line.trim(),
        message: `runner label ${label[0]} moves to a new OS image without a commit; name the version`,
      });
    }
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

// Default of a `workflow_call` or composite-action input, if declared in the file.
function inputDefault(lines: string[], name: string): string | undefined {
  const pattern = new RegExp(`^(\\s*)${escapeRegExp(name)}:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    for (const [, line] of block(lines, i, match[1].length)) {
      const field = /^\s*default:(.*)$/.exec(line);
      if (field) return scalar(field[1]);
    }
    return "";
  }
  return undefined;
}

function scanSetupSteps(path: string, lines: string[], findings: Finding[]): void {
  lines.forEach((line, index) => {
    if (isComment(line)) return;
    const uses = /^(\s*)(-\s+)?uses:\s*["']?([^@\s"']+)@/.exec(line);
    if (!uses) return;
    const action = uses[3].toLowerCase();
    const inputs = SETUP_VERSION_INPUTS[action];
    if (!inputs) return;
    // The step is the list item that holds `uses:`: from its dash to the
    // next line indented no deeper than the dash.
    let dash = index;
    if (!uses[2]) {
      for (let i = index - 1; i >= 0; i--) {
        if (lines[i].trim() === "" || isComment(lines[i])) continue;
        if (indentOf(lines[i]) < uses[1].length - 2) break;
        if (/^\s*-\s+/.test(lines[i]) && indentOf(lines[i]) < uses[1].length) {
          dash = i;
          break;
        }
      }
    }
    const step: string[] = [lines[dash], ...block(lines, dash, indentOf(lines[dash])).map(([, l]) => l)];
    const values = new Map<string, string>();
    for (const current of step) {
      const field = /^\s*(?:-\s+)?([A-Za-z0-9_-]+):(.*)$/.exec(current);
      if (field && inputs.includes(field[1])) values.set(field[1], scalar(field[2]));
    }
    let problem: string | undefined;
    if (values.size === 0) {
      problem = `${action} has no ${inputs.join(" or ")}; it installs whatever is newest`;
    } else {
      for (const [key, raw] of values) {
        let value = raw;
        const input = /^\$\{\{\s*inputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(value);
        if (input) {
          const fallback = inputDefault(lines, input[1]);
          if (fallback === undefined) continue;
          value = fallback;
          if (value === "") {
            problem = `${action} ${key} comes from input ${input[1]}, which has no default`;
            break;
          }
        }
        if (templated(value) || key.endsWith("-file")) continue;
        if (value === "" || FLOATING_VERSION.test(value)) {
          problem = `${action} ${key} "${value}" floats; name an exact version`;
          break;
        }
      }
    }
    if (problem) findings.push({ rule: "toolchain-version", path, line: index + 1, text: line.trim(), message: problem });
  });
}

const CURL_PIPE_SHELL = /\b(curl|wget)\b[^\n|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+(?:[^\s=]+=\S*\s+)*)?(?:ba|z|da|k)?sh\b/;
const ARTIFACT_URL = /https?:\/\/\S*(\/releases\/download\/|\.(tar\.gz|tgz|tar\.xz|tar\.zst|tar\.bz2|zip|deb|rpm|apk|AppImage|bin|exe|msi|jar|whl)\b)/;
const LATEST_URL = /https?:\/\/\S*\/releases\/latest\b/;
// Commands that verify a download. An image digest nearby is not one.
const VERIFY = /sha(1|224|256|384|512)sum|shasum|\bchecksum|gpg\s+--verify|gpgv\b|cosign\s+verify|minisign|slsa-verifier|--hash\b/i;

// A shell command continued with trailing backslashes, as one line.
function logicalLine(lines: string[], index: number): string {
  let text = lines[index];
  for (let i = index + 1; i < lines.length && /\\\s*$/.test(lines[i - 1]) && i <= index + 8; i++) {
    text = `${text.replace(/\\\s*$/, "")} ${lines[i].trim()}`;
  }
  return text;
}

function scanDownloads(path: string, lines: string[], findings: Finding[]): void {
  lines.forEach((physical, index) => {
    if (isComment(physical)) return;
    if (index > 0 && /\\\s*$/.test(lines[index - 1])) return;
    const line = logicalLine(lines, index);
    if (CURL_PIPE_SHELL.test(line)) {
      findings.push({
        rule: "curl-pipe-shell",
        path,
        line: index + 1,
        text: line.trim(),
        message: "downloaded script piped into a shell; fetch a versioned installer and check its checksum, or use a package",
      });
      return;
    }
    if (LATEST_URL.test(line)) {
      findings.push({ rule: "download-checksum", path, line: index + 1, text: line.trim(), message: "releases/latest URL; name the release and check its checksum" });
      return;
    }
    if (/\b(curl|wget)\b/.test(line) && ARTIFACT_URL.test(line)) {
      const window = lines.slice(Math.max(0, index - 3), index + 24).join("\n");
      if (!VERIFY.test(window)) {
        findings.push({ rule: "download-checksum", path, line: index + 1, text: line.trim(), message: "download with no checksum verification nearby" });
      }
      return;
    }
    const getUrl = /^(\s*)(-\s+)?(ansible\.builtin\.)?get_url:\s*$/.exec(line);
    if (getUrl) {
      const keyIndent = getUrl[1].length + (getUrl[2]?.length ?? 0);
      const body = block(lines, index, keyIndent).map(([, l]) => l);
      if (!body.some((l) => /^\s*checksum:/.test(l))) {
        findings.push({ rule: "download-checksum", path, line: index + 1, text: line.trim(), message: "get_url without checksum" });
      }
    }
  });
}

export function scanFile(path: string, content: string): Finding[] {
  const kinds = classify(path);
  if (kinds.length === 0) return [];
  const lines = content.split(/\r?\n/);
  const findings: Finding[] = [];
  if (kinds.includes("dockerfile")) {
    scanDockerfile(path, lines, findings);
  }
  if (kinds.includes("yaml")) scanImages(path, lines, kinds, findings);
  if (kinds.includes("workflow")) scanRunnerLabels(path, lines, findings);
  if (kinds.includes("workflow") || kinds.includes("action")) scanSetupSteps(path, lines, findings);
  scanDownloads(path, lines, findings);
  return findings;
}

export interface ExemptionResult {
  exemptions: Exemption[];
  errors: string[];
}

export function parseExemptions(text: string | undefined): ExemptionResult {
  const errors: string[] = [];
  if (text === undefined) return { exemptions: [], errors };
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    return { exemptions: [], errors: [`${EXEMPTION_FILE}: ${(error as Error).message}`] };
  }
  const list = (parsed as { exemptions?: unknown } | null)?.exemptions ?? [];
  if (!Array.isArray(list)) return { exemptions: [], errors: [`${EXEMPTION_FILE}: exemptions must be a list`] };
  const exemptions: Exemption[] = [];
  list.forEach((entry, position) => {
    const where = `${EXEMPTION_FILE} entry ${position + 1}`;
    const e = entry as Partial<Exemption>;
    if (!e || typeof e !== "object") return errors.push(`${where}: not a mapping`);
    if (!RULES.includes(e.rule as RuleId)) return errors.push(`${where}: rule must be one of ${RULES.join(", ")}`);
    if (typeof e.path !== "string" || e.path === "") return errors.push(`${where}: path is required`);
    if (typeof e.reason !== "string" || e.reason.trim().length < 10) {
      return errors.push(`${where}: reason is required and must say why the reference stays unpinned`);
    }
    if (e.match !== undefined && (typeof e.match !== "string" || e.match === "")) {
      return errors.push(`${where}: match must be a non-empty string when present`);
    }
    exemptions.push({ rule: e.rule as RuleId, path: e.path, match: e.match, reason: e.reason });
  });
  return { exemptions, errors };
}

function exempts(exemption: Exemption, finding: Finding): boolean {
  if (exemption.rule !== finding.rule) return false;
  const pathMatches = exemption.path === finding.path || new Bun.Glob(exemption.path).match(finding.path);
  if (!pathMatches) return false;
  return exemption.match === undefined || finding.text.includes(exemption.match);
}

export interface LintResult {
  findings: Finding[];
  errors: string[];
}

export function lint(files: Array<{ path: string; content: string }>, exemptionText: string | undefined): LintResult {
  const { exemptions, errors } = parseExemptions(exemptionText);
  const used = new Set<number>();
  const findings: Finding[] = [];
  for (const file of files) {
    for (const finding of scanFile(file.path, file.content)) {
      const index = exemptions.findIndex((e) => exempts(e, finding));
      if (index >= 0) used.add(index);
      else findings.push(finding);
    }
  }
  exemptions.forEach((e, index) => {
    if (!used.has(index)) {
      errors.push(`${EXEMPTION_FILE}: exemption ${e.rule} ${e.path}${e.match ? ` (${e.match})` : ""} matches nothing; remove it`);
    }
  });
  return { findings, errors };
}

function trackedFiles(root: string): string[] {
  const result = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter((p) => p !== "");
}

function escapeAnnotation(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function main(root: string, annotate: boolean): number {
  const files: Array<{ path: string; content: string }> = [];
  let exemptionText: string | undefined;
  for (const path of trackedFiles(root)) {
    const full = join(root, path);
    let size: number;
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (path === EXEMPTION_FILE) exemptionText = readFileSync(full, "utf8");
    if (size > MAX_FILE_BYTES || classify(path).length === 0) continue;
    files.push({ path, content: readFileSync(full, "utf8") });
  }
  const { findings, errors } = lint(files, exemptionText);
  for (const f of findings) {
    if (annotate) {
      console.log(`::error file=${f.path},line=${f.line},title=pin-lint ${f.rule}::${escapeAnnotation(f.message)}`);
    } else {
      console.log(`${f.path}:${f.line}: [${f.rule}] ${f.message}`);
    }
  }
  for (const error of errors) console.log(annotate ? `::error title=pin-lint::${escapeAnnotation(error)}` : error);
  const total = findings.length + errors.length;
  console.log(total === 0 ? `pin-lint: ${files.length} files clean` : `pin-lint: ${findings.length} findings, ${errors.length} exemption errors`);
  return total === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main(process.argv[2] ?? ".", process.env.GITHUB_ACTIONS === "true"));
}
