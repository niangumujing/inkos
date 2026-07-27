import { describe, expect, it } from "vitest";
import { evaluateFactBoundary } from "../utils/fact-boundary.js";

const INTENT = `# Chapter Intent

- [FACT_GATE] forbidden_terms: 鱼干、陶碗、石子
- [FACT_GATE] forbidden_pattern: 井底.{0,20}(第二件祟物|正是)
- [FACT_GATE] forbidden_pattern: 井底.{0,80}(触碰|抓住|接触)
- [FACT_GATE] no_arabic_numbers
- [FACT_GATE] no_colors
`;

describe("fact boundary", () => {
  it("reports reviewed-plan forbidden terms, numbers, and colors as critical", () => {
    const issues = evaluateFactBoundary("阿绫递来鱼干，旁边有一只陶碗，数了17次，青砖上结霜。", INTENT);

    expect(issues).toHaveLength(3);
    expect(issues.every((issue) => issue.severity === "critical")).toBe(true);
    expect(issues.map((issue) => issue.description).join("\n")).toContain("鱼干");
    expect(issues.map((issue) => issue.description).join("\n")).toContain("17");
    expect(issues.map((issue) => issue.description).join("\n")).toContain("青");
  });

  it("does nothing unless the reviewed plan opts into fact gates", () => {
    expect(evaluateFactBoundary("鱼干 17 青砖", "# Chapter Intent")).toEqual([]);
  });

  it("does not mistake ordinary words containing color characters for colors", () => {
    const issues = evaluateFactBoundary("武溪终于明白了沈砚的话。", INTENT);

    expect(issues).toEqual([]);
  });

  it("rejects reviewer-authored narrative patterns", () => {
    const issues = evaluateFactBoundary("沈砚说井底的东西正是第二件祟物，随后它抓住武溪的手腕。", INTENT);

    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.severity === "critical")).toBe(true);
    expect(issues.map((issue) => issue.description).join("\n")).toContain("井底");
    expect(issues.map((issue) => issue.description).join("\n")).toContain("抓住");
  });

  it("rejects malformed reviewer-authored narrative patterns", () => {
    const malformedIntent = "- [FACT_GATE] forbidden_pattern: (未闭合";
    const issues = evaluateFactBoundary("正常正文", malformedIntent);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.description).toContain("无效");
  });
});
