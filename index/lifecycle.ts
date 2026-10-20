// Kubernetes lifecycle dates from endoflife.date. The response is third-party
// input that the page writes into HTML attributes, so only calendar dates in
// YYYY-MM-DD form are kept; any other value is treated as absent, the same
// rule the page's own refresh script applies in the browser.

export type SupportEntry = { maintenance?: string; eol?: string };
export type SupportMap = Record<string, SupportEntry>;

const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(value: unknown): string | undefined {
  return typeof value === "string" && isoDateRe.test(value) ? value : undefined;
}

export function supportMapFrom(items: unknown): SupportMap {
  const out: SupportMap = {};
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const { cycle, support, eol } = item as Record<string, unknown>;
    if (typeof cycle !== "string" || !cycle) continue;
    out[cycle] = { maintenance: isoDate(support), eol: isoDate(eol) };
  }
  return out;
}
