import { describe, expect, test } from "bun:test";
import { isoDate, supportMapFrom } from "./lifecycle.ts";

describe("isoDate", () => {
  test("keeps a calendar date", () => {
    expect(isoDate("2026-02-28")).toBe("2026-02-28");
  });

  test("drops anything that is not a plain date", () => {
    for (const value of [
      '2026-02-28" onmouseover="alert(1)',
      "2026-02-28<script>",
      "2026-02-28\n",
      "28.02.2026",
      "",
      true,
      false,
      20260228,
      null,
      undefined,
    ]) {
      expect(isoDate(value)).toBeUndefined();
    }
  });
});

describe("supportMapFrom", () => {
  test("maps cycles to their support and end-of-life dates", () => {
    expect(
      supportMapFrom([
        { cycle: "1.34", support: "2026-10-28", eol: "2026-12-28" },
        { cycle: "1.33", support: "2026-04-28", eol: "2026-06-28" },
      ]),
    ).toEqual({
      "1.34": { maintenance: "2026-10-28", eol: "2026-12-28" },
      "1.33": { maintenance: "2026-04-28", eol: "2026-06-28" },
    });
  });

  test("treats a non-date value as absent", () => {
    expect(
      supportMapFrom([{ cycle: "1.34", support: '"><img src=x onerror=alert(1)>', eol: false }]),
    ).toEqual({ "1.34": { maintenance: undefined, eol: undefined } });
  });

  test("skips entries without a cycle and tolerates a non-array response", () => {
    expect(supportMapFrom([{ support: "2026-10-28" }, null, "1.34"])).toEqual({});
    expect(supportMapFrom({ cycle: "1.34" })).toEqual({});
  });
});
