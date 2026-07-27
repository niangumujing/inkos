import type { AuditIssue } from "../agents/continuity.js";

const FACT_GATE_PREFIX = "[FACT_GATE]";
const COLOR_PATTERN = /(?:赤(?:色|红)|橙色|黄(?:色|衣|袍|光)|绿(?:色|衣|袍|光)|蓝(?:色|衣|袍|光)|紫(?:色|衣|袍|光)|青(?:色|砖|石|纹|衣|袍|灰)|黑(?:色|衣|袍|影|发)|白(?:色|衣|袍|发|脸|霜|雪)|红(?:色|衣|袍|光|火|脸)|褐色|橘色|灰(?:色|衣|袍|烬|烬))/g;
const ARABIC_NUMBER_PATTERN = /\d+/g;

/**
 * Evaluates compact, reviewer-authored fact gates embedded in a chapter intent.
 * Gates are opt-in so existing books retain their current behavior.
 */
export function evaluateFactBoundary(
  content: string,
  chapterIntent?: string,
): ReadonlyArray<AuditIssue> {
  if (!chapterIntent?.includes(FACT_GATE_PREFIX)) return [];

  const issues: AuditIssue[] = [];
  const forbiddenTerms = extractGateTerms(chapterIntent, "forbidden_terms");
  const forbiddenPatterns = extractGatePatterns(chapterIntent, "forbidden_pattern");
  const requireNoArabicNumbers = hasGate(chapterIntent, "no_arabic_numbers");
  const requireNoColors = hasGate(chapterIntent, "no_colors");

  const hits = forbiddenTerms.filter((term) => content.includes(term));
  if (hits.length > 0) {
    issues.push(createIssue(`命中审查计划禁词：${hits.join("、")}`));
  }

  for (const pattern of forbiddenPatterns) {
    try {
      if (new RegExp(pattern, "u").test(content)) {
        issues.push(createIssue(`命中审查计划禁用叙事模式：${pattern}`));
      }
    } catch {
      issues.push(createIssue(`审查计划的禁用叙事模式无效：${pattern}`));
    }
  }

  if (requireNoArabicNumbers) {
    const numbers = [...new Set(content.match(ARABIC_NUMBER_PATTERN) ?? [])];
    if (numbers.length > 0) issues.push(createIssue(`出现未经授权的阿拉伯数字：${numbers.join("、")}`));
  }

  if (requireNoColors) {
    const colors = [...new Set(content.match(COLOR_PATTERN) ?? [])];
    if (colors.length > 0) issues.push(createIssue(`出现未经授权的颜色词：${colors.join("、")}`));
  }

  return issues;
}

function hasGate(intent: string, name: string): boolean {
  return new RegExp(`^\\s*(?:-\\s*)?${escapeRegExp(FACT_GATE_PREFIX)}\\s+${escapeRegExp(name)}\\s*$`, "m").test(intent);
}

function extractGateTerms(intent: string, name: string): string[] {
  const match = intent.match(new RegExp(`^\\s*(?:-\\s*)?${escapeRegExp(FACT_GATE_PREFIX)}\\s+${escapeRegExp(name)}\\s*:\\s*(.+)$`, "m"));
  return match?.[1]
    ?.split(/[、,，]/)
    .map((term) => term.trim())
    .filter(Boolean) ?? [];
}

function extractGatePatterns(intent: string, name: string): string[] {
  const expression = new RegExp(
    `^\\s*(?:-\\s*)?${escapeRegExp(FACT_GATE_PREFIX)}\\s+${escapeRegExp(name)}\\s*:\\s*(.+)$`,
    "gm",
  );

  return [...intent.matchAll(expression)]
    .map((match) => match[1]?.trim())
    .filter((pattern): pattern is string => Boolean(pattern));
}

function createIssue(description: string): AuditIssue {
  return {
    severity: "critical",
    category: "事实边界",
    description,
    suggestion: "删除未授权细节，并严格按 chapter intent 中的事实闸门重写相关段落。",
    repairScope: "structural",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
