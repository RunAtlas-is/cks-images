#!/usr/bin/env bun
// Build the static explorer page (plus its branding assets) into ./dist.
// Reads the bucket contents to enumerate ISOs, fetches Kubernetes support
// dates from endoflife.date, emits dist/index.html. Does not write to S3.
//
// Env:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL, BUCKET_NAME
//     required (read-only)
//   DOCS_URL                  link shown in the header + footer
//   ARTIFACT_BASE_URL         public base URL for objects in BUCKET_NAME
//   SITE_BASE_URL             public base URL for this GitHub Pages site
//   KEY_URL                   public URL for the artifact signing key
//   SIGNING_FINGERPRINT       Atlas artifact key fingerprint (display only)

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing required env: ${k}`);
  return v;
};

const AWS_ACCESS_KEY_ID = need("AWS_ACCESS_KEY_ID");
const AWS_SECRET_ACCESS_KEY = need("AWS_SECRET_ACCESS_KEY");
const AWS_ENDPOINT_URL = need("AWS_ENDPOINT_URL");
const BUCKET = need("BUCKET_NAME");
const DOCS_URL =
  process.env.DOCS_URL ??
  "https://github.com/RunAtlas-is/cks-images/blob/main/docs/cloudstack-integration.md";
const ARTIFACT_BASE_URL =
  process.env.ARTIFACT_BASE_URL ?? "https://s3.runatlas.is/atlas-static-assets";
const SITE_BASE_URL =
  process.env.SITE_BASE_URL ?? "https://runatlas-is.github.io/cks-images";
const KEY_PATH = "keys/atlas-cloud-artifact-signing.asc";
const SIGNING_FINGERPRINT =
  process.env.SIGNING_FINGERPRINT ?? "4C2D72FDDEF77A5CC4A7D2C421CA4588DCB6991E";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = process.env.DIST_DIR ?? join(HERE, "dist");
const BRANDING = join(HERE, "assets");
const KEY_SOURCE = join(HERE, "..", KEY_PATH);

const s3 = new S3Client({
  region: "us-east-1",
  endpoint: AWS_ENDPOINT_URL,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

type Entry = { key: string; size: number; modified: Date };
type SupportEntry = { maintenance?: string; eol?: string };
type SupportMap = Record<string, SupportEntry>;

async function listCks(): Promise<Entry[]> {
  const entries: Entry[] = [];
  let token: string | undefined;
  do {
    let page;
    try {
      page = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: "cks/",
          ContinuationToken: token,
        }),
      );
    } catch (err) {
      throw new Error(`[build] list-objects-v2 failed on cks/${token ? ` (token=${token})` : ""}: ${err}`);
    }
    for (const o of page.Contents ?? []) {
      if (!o.Key || o.Size == null || !o.LastModified) continue;
      entries.push({ key: o.Key, size: o.Size, modified: o.LastModified });
    }
    if (page.IsTruncated) {
      if (!page.NextContinuationToken) {
        throw new Error("S3 listing is truncated but missing NextContinuationToken");
      }
      token = page.NextContinuationToken;
    } else {
      token = undefined;
    }
  } while (token);
  return entries;
}

async function fetchSha(key: string): Promise<string | null> {
  let r;
  try {
    r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    throw new Error(`[build] get-object failed on ${key}: ${err}`);
  }
  const body = await r.Body?.transformToString();
  const digest = body?.trim().split(/\s+/, 1)[0];
  return digest && /^[0-9a-f]{64}$/i.test(digest) ? digest : null;
}

async function fetchSupportMap(): Promise<SupportMap> {
  try {
    const r = await fetch("https://endoflife.date/api/kubernetes.json", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const arr = (await r.json()) as Array<{ cycle?: string; support?: string; eol?: string }>;
    const out: SupportMap = {};
    for (const e of arr) {
      if (!e.cycle) continue;
      out[e.cycle] = { maintenance: e.support, eol: e.eol };
    }
    return out;
  } catch (err) {
    console.error(`[build] endoflife.date fetch failed: ${err}`);
    return {};
  }
}

function humanBytes(n: number): string {
  const G = 1073741824, M = 1048576, K = 1024;
  if (n >= G) return `${(n / G).toFixed(1)}G`;
  if (n >= M) return `${(n / M).toFixed(1)}M`;
  if (n >= K) return `${(n / K).toFixed(1)}K`;
  return `${n}`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const encodedPath = path
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return encodedPath ? `${trimmedBase}/${encodedPath}` : `${trimmedBase}/`;
}

function artifactHref(key: string): string {
  return joinUrl(ARTIFACT_BASE_URL, key);
}

const KEY_URL = process.env.KEY_URL ?? joinUrl(SITE_BASE_URL, KEY_PATH);

function formatTimestamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

const isoNameRe = /^setup-v(\d+)\.(\d+)\.(\d+)-[^-]+-(amd64|arm64)(?:-[^.]+)?\.iso$/;
function parseIso(name: string):
  | { major: number; minor: number; patch: number; minorKey: string; arch: string; sortKey: number }
  | null {
  const m = isoNameRe.exec(name);
  if (!m || !m[1] || !m[2] || !m[3] || !m[4]) return null;
  const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3]);
  return {
    major, minor, patch,
    minorKey: `${major}.${minor}`,
    arch: m[4],
    sortKey: major * 1_000_000 + minor * 1_000 + patch,
  };
}

function daysFromNow(iso: string): number {
  const ms = new Date(iso + "T00:00:00Z").getTime() - Date.now();
  return Math.round(ms / 86400000);
}

function dateCell(iso: string | undefined): { display: string; sortKey: string } {
  if (!iso) return { display: "&mdash;", sortKey: "9999-99-99" };
  const days = daysFromNow(iso);
  let color = "#666";
  if (days < 0) color = "#a33";
  else if (days < 60) color = "#a60";
  const sign = days > 0 ? "+" : "";
  const note = ` <span style="color:${color}">(${sign}${days}d)</span>`;
  return { display: iso + note, sortKey: iso };
}

function formatFingerprint(fpr: string): string {
  const groups = (fpr.match(/.{1,4}/g) ?? []).map((g) => g.toUpperCase());
  const first = groups.slice(0, 5).join(" ");
  const second = groups.slice(5).join(" ");
  return `${escape(first)}<br>${escape(second)}`;
}

function renderHtml(args: {
  entries: Entry[];
  support: SupportMap;
  shaByIso: Map<string, string>;
  ascNames: Set<string>;
  minorsWithChecksum: string[];
}): string {
  const { entries, support, shaByIso, ascNames, minorsWithChecksum } = args;
  const hidden = new Set(["index.html", "favicon.svg", "logo.svg"]);
  const isChecksum = (n: string) => n.startsWith("CHECKSUM-") && !n.endsWith(".asc");

  const display = entries
    .map((e) => ({ ...e, name: e.key.replace(/^cks\//, "") }))
    .filter((e) => !hidden.has(e.name))
    .filter((e) => !e.name.endsWith(".sha256") && !e.name.endsWith(".asc") && !isChecksum(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rows: string[] = [];
  for (const e of display) {
    const iso = parseIso(e.name);
    const sizeH = humanBytes(e.size);
    const modH = formatTimestamp(e.modified);
    const modSort = String(e.modified.getTime());

    if (iso) {
      const supInfo = support[iso.minorKey];
      const maint = dateCell(supInfo?.maintenance);
      const deadline = dateCell(supInfo?.eol);
      const sha = shaByIso.get(e.name);
      const hasAsc = ascNames.has(`${e.name}.asc`);
      const subLinks: string[] = [];
      if (sha) {
        subLinks.push(
          `<a class="sub" href="${escape(artifactHref(`cks/${e.name}.sha256`))}" title="${escape(sha)}">sha</a>`,
        );
      }
      if (hasAsc) {
        subLinks.push(`<a class="sub" href="${escape(artifactHref(`cks/${e.name}.asc`))}">.asc</a>`);
      }
      const subBlock = subLinks.length ? ` <span class="sub">(${subLinks.join(", ")})</span>` : "";
      rows.push(
        `<tr>` +
          `<td>&#x1F4BE;</td>` +
          `<td data-sort="${iso.sortKey}"><a href="${escape(artifactHref(`cks/${e.name}`))}">${escape(e.name)}</a>${subBlock}</td>` +
          `<td data-sort="${escape(iso.arch)}">${escape(iso.arch)}</td>` +
          `<td data-sort="${modSort}" align="right">${escape(modH)}</td>` +
          `<td data-sort="${e.size}" align="right"><tt>${sizeH}</tt></td>` +
          `<td data-sort="${maint.sortKey}">${maint.display}</td>` +
          `<td data-sort="${deadline.sortKey}">${deadline.display}</td>` +
          `</tr>`,
      );
    } else {
      rows.push(
        `<tr>` +
          `<td>&#x1F4C4;</td>` +
          `<td data-sort="${escape(e.name)}"><a href="${escape(artifactHref(`cks/${e.name}`))}">${escape(e.name)}</a></td>` +
          `<td data-sort="">&mdash;</td>` +
          `<td data-sort="${modSort}" align="right">${escape(modH)}</td>` +
          `<td data-sort="${e.size}" align="right"><tt>${sizeH}</tt></td>` +
          `<td data-sort="9999-99-99">&mdash;</td>` +
          `<td data-sort="9999-99-99">&mdash;</td>` +
          `</tr>`,
      );
    }
  }

  const now = new Date().toISOString().slice(0, 19) + "Z";

  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">
<html>
 <head>
  <title>Index of /cks</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 1.5rem; }
    header { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 0.6rem; }
    header img { height: 2rem; }
    header a { text-decoration: none; color: inherit; }
    h1 { font-size: 1.2rem; margin: 0; }
    /* The table itself keeps its intrinsic width; the surrounding wrapper
       scrolls horizontally when the viewport can't fit it. */
    .table-wrap { overflow-x: auto; margin: 0.5rem 0; }
    table { border-collapse: collapse; }
    th, td { padding: 0.2rem 0.6rem; white-space: nowrap; }
    th { cursor: pointer; user-select: none; text-align: left; }
    th .arrow { color: #999; margin-left: 0.3rem; }
    .sub, .sub a { color: #888; font-size: 0.85em; text-decoration: none; }
    .sub a:hover { text-decoration: underline; }
    .meta { display: flex; flex-wrap: wrap; gap: 1rem; background: #f6f6f6; border: 1px solid #eee; padding: 0.6rem 0.9rem; margin: 1rem 0; border-radius: 4px; }
    /* min-width: 0 lets the flex item shrink so its <pre> child can scroll instead of forcing the container wider than the viewport. */
    .meta .body { flex: 1 1 20rem; min-width: 0; }
    .meta .fpr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; white-space: nowrap; color: #555; text-align: right; }
    .meta pre { background: #fff; padding: 0.5rem 0.7rem; border: 1px solid #eee; border-radius: 3px; overflow-x: auto; margin: 0.5rem 0 0; max-width: 100%; }
    address { color: #666; margin-top: 1rem; font-style: normal; font-size: 0.85rem; }
    code, tt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
 </head>
 <body>
<header>
  <a href="https://runatlas.is"><img src="logo.svg" alt="Atlas Cloud"></a>
  <h1>Index of /cks</h1>
</header>
<p>CloudStack Kubernetes Service binary ISOs for Atlas Cloud. Each <code>.iso</code> has a sibling SHA-256 and a GPG detached signature (collapsed into the filename as <code>(sha, .asc)</code>). Per-minor <code>CHECKSUM-&lt;minor&gt;</code> files are clearsigned with the Atlas signing key. See the <a href="${escape(DOCS_URL)}">deploy tutorial</a>; support dates follow the official <a href="https://kubernetes.io/releases/patch-releases/">Kubernetes policy</a>.</p>
<div class="meta">
  <div class="body">
    <strong>Verify the set:</strong>
    ${minorsWithChecksum.length
      ? minorsWithChecksum
          .map(
            (m) =>
              `<a href="${escape(artifactHref(`cks/CHECKSUM-${m}`))}">CHECKSUM-${escape(m)}</a> <span class="sub">(<a href="${escape(artifactHref(`cks/CHECKSUM-${m}.asc`))}">.asc</a>)</span>`,
          )
          .join(" &middot; ")
      : "<em>no checksum files yet</em>"}
<pre>curl -sO ${escape(KEY_URL)} && gpg --import atlas-cloud-artifact-signing.asc
curl -sO ${escape(artifactHref("cks/CHECKSUM-1.33"))}
curl -sO ${escape(artifactHref("cks/CHECKSUM-1.33.asc"))}
gpg --verify CHECKSUM-1.33.asc CHECKSUM-1.33
sha256sum --check --ignore-missing CHECKSUM-1.33</pre>
  </div>
  <div class="fpr">
    <a href="${escape(KEY_URL)}">KEY.asc</a><br>
    Atlas Cloud signing<br>
    ${formatFingerprint(SIGNING_FINGERPRINT)}
  </div>
</div>
<div class="table-wrap">
<table id="idx">
<thead>
<tr>
<th data-col="0">&nbsp;<span class="arrow"></span></th>
<th data-col="1">Name<span class="arrow"></span></th>
<th data-col="2">Arch<span class="arrow"></span></th>
<th data-col="3">Last modified<span class="arrow"></span></th>
<th data-col="4">Size<span class="arrow"></span></th>
<th data-col="5">Maintenance<span class="arrow"></span></th>
<th data-col="6">EOL<span class="arrow"></span></th>
</tr>
<tr><th colspan="7"><hr></th></tr>
</thead>
<tbody>
<tr data-role="bucket"><td>&nbsp;</td><td><a href="${escape(artifactHref(""))}">Artifact bucket</a></td><td>&mdash;</td><td>&nbsp;</td><td align="right">-</td><td>&nbsp;</td><td>&nbsp;</td></tr>
${rows.join("\n")}
</tbody>
<tfoot><tr><th colspan="7"><hr></th></tr></tfoot>
</table>
</div>
<address>Atlas Cloud Downloads &middot; generated ${now} &middot; <a href="${escape(DOCS_URL)}">docs</a></address>
<script>
(() => {
  const table = document.getElementById('idx');
  const tbody = table.querySelector('tbody');
  const headers = Array.from(table.querySelectorAll('thead th[data-col]'));
  const isPinned = (row) => row.dataset.role === 'bucket';
  let dir = { col: 1, asc: false };
  const numericRe = /^-?\\d+(?:\\.\\d+)?$/;
  const cmp = (a, b) => {
    if (numericRe.test(a) && numericRe.test(b)) return Number(a) - Number(b);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const render = () => {
    headers.forEach(h => h.querySelector('.arrow').textContent = '');
    if (dir.col == null) return;
    headers[dir.col].querySelector('.arrow').textContent = dir.asc ? '▲' : '▼';
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const parent = rows.find(isPinned);
    const body = rows.filter(r => !isPinned(r));
    body.sort((r1, r2) => {
      const c1 = r1.children[dir.col], c2 = r2.children[dir.col];
      const k1 = c1?.dataset.sort ?? c1?.textContent ?? '';
      const k2 = c2?.dataset.sort ?? c2?.textContent ?? '';
      return dir.asc ? cmp(k1, k2) : -cmp(k1, k2);
    });
    tbody.replaceChildren(...(parent ? [parent, ...body] : body));
  };
  headers.forEach(h => {
    h.addEventListener('click', () => {
      const col = Number(h.dataset.col);
      if (col === 0) return;
      if (dir.col === col) dir.asc = !dir.asc;
      else { dir.col = col; dir.asc = true; }
      render();
    });
  });
  render();
})();
</script>
 </body>
</html>
`;
}

async function main() {
  const [entries, support] = await Promise.all([listCks(), fetchSupportMap()]);
  const bareNames = entries.map((e) => e.key.replace(/^cks\//, ""));
  const ascNames = new Set(bareNames.filter((n) => n.endsWith(".asc")));

  const shaByIso = new Map<string, string>();
  const shaResults = await Promise.allSettled(
    entries
      .filter((e) => e.key.endsWith(".iso.sha256"))
      .map(async (e) => {
        const digest = await fetchSha(e.key);
        return { name: e.key.replace(/^cks\//, "").replace(/\.sha256$/, ""), digest };
      }),
  );
  for (const r of shaResults) {
    if (r.status === "fulfilled" && r.value.digest) {
      shaByIso.set(r.value.name, r.value.digest);
    } else if (r.status === "rejected") {
      console.error(`[build] sha256 fetch failed: ${r.reason}`);
    }
  }

  const minorsWithChecksum = bareNames
    .filter((n) => n.startsWith("CHECKSUM-") && !n.endsWith(".asc"))
    .map((n) => n.replace(/^CHECKSUM-/, ""))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const html = renderHtml({ entries, support, shaByIso, ascNames, minorsWithChecksum });

  for (const target of [DIST, join(DIST, "cks")]) {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.html"), html);
    // Copy static assets verbatim into the Pages artifact.
    for (const asset of ["favicon.svg", "logo.svg"]) {
      writeFileSync(join(target, asset), readFileSync(join(BRANDING, asset)));
    }
    mkdirSync(join(target, "keys"), { recursive: true });
    writeFileSync(
      join(target, KEY_PATH),
      readFileSync(KEY_SOURCE),
    );
  }

  const isoCount = entries.filter((e) => parseIso(e.key.replace(/^cks\//, ""))).length;
  console.log(`[build] wrote ${DIST}/index.html and /cks/index.html (${html.length} bytes, ${isoCount} ISOs) + Pages assets`);
}

await main();
