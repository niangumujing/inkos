import { BaseAgent } from "./base.js";
import type { LengthNormalizeMode, LengthSpec } from "../models/length-governance.js";
import { countChapterLength, chooseNormalizeMode, isOutsideHardRange, isOutsideSoftRange } from "../utils/length-metrics.js";

export interface NormalizeLengthInput {
  readonly chapterContent: string;
  readonly lengthSpec: LengthSpec;
  readonly chapterIntent?: string;
  readonly reducedControlBlock?: string;
  /** Retry mode used only after a constraint-safe expansion was rejected. */
  readonly safeExpansion?: boolean;
}

export interface NormalizeLengthOutput {
  readonly normalizedContent: string;
  readonly finalCount: number;
  readonly applied: boolean;
  readonly mode: LengthNormalizeMode;
  readonly warning?: string;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

interface NormalizerConstraintPolicy {
  readonly forbiddenTerms: readonly string[];
  readonly maxNumericTokens?: number;
  readonly maxAddedNumericTokens?: number;
  readonly forbidUnobservablePrecision: boolean;
}

const NEGATIVE_CONSTRAINT_RE = /(?:禁止|不得|不要|避免|不使用|不出现|must not|do not|forbidden)/i;
const NUMERIC_LIMIT_PATTERNS = [
  /(?:数字(?:\s*(?:token|tokens|标记|数量))?|numeric\s+tokens?)[^\n。；;]{0,24}(?:不超过|最多|至多|少于或等于|<=|at most)\s*(\d+)/i,
  /(?:最多|至多)\s*(\d+)\s*个?\s*(?:数字|numeric\s+tokens?)/i,
];
const KNOWN_FORBIDDEN_TERMS = [
  "红外热像仪",
  "气压计",
  "光谱仪",
  "显微镜",
  "统计模型",
  "量角器",
  "折射率",
  "mV",
  "nm",
  "Hz",
  "R²",
  "p值",
  "OD",
];
const UNOBSERVABLE_PRECISION_RE = /(?:\d+\.\d+\s*(?:°|度|mV|nm|Hz|N|℃|K|%|mm|cm|秒|s)|精度|误差|公差|分辨率|浓度|频率|折射率|仅仪器可测|肉眼不可见|不可观测精度)/giu;
const NUMERIC_TOKEN_RE = /\d+(?:\.\d+)?/g;
const MAX_ADDED_NUMERIC_TOKENS_WITHOUT_EXPLICIT_LIMIT = 12;

export class LengthNormalizerAgent extends BaseAgent {
  get name(): string {
    return "length-normalizer";
  }

  async normalizeChapter(input: NormalizeLengthInput): Promise<NormalizeLengthOutput> {
    const originalCount = countChapterLength(input.chapterContent, input.lengthSpec.countingMode);
    const mode = input.lengthSpec.normalizeMode === "none"
      ? chooseNormalizeMode(originalCount, input.lengthSpec)
      : input.lengthSpec.normalizeMode;

    if (mode === "none") {
      return {
        normalizedContent: input.chapterContent,
        finalCount: originalCount,
        applied: false,
        mode,
      };
    }

    const systemPrompt = this.buildSystemPrompt(mode, input.safeExpansion === true);
    const userPrompt = this.buildUserPrompt(input, originalCount, mode);
    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        temperature: 0.2,
      },
    );

    const sanitizedContent = this.sanitizeNormalizedContent(response.content, input.chapterContent);
    const constraintViolation = this.findConstraintViolation(
      sanitizedContent,
      input.chapterContent,
      this.buildConstraintPolicy(input),
    );
    const sanitizedCount = countChapterLength(sanitizedContent, input.lengthSpec.countingMode);
    const wasTruncated = sanitizedContent !== input.chapterContent
      && sanitizedCount < input.lengthSpec.hardMin
      && this.looksTruncated(sanitizedContent);
    const crossedHardRange = sanitizedContent !== input.chapterContent
      && this.crossesOppositeHardBound(originalCount, sanitizedCount, input.lengthSpec);
    const normalizedContent = (constraintViolation || wasTruncated || crossedHardRange)
      ? input.chapterContent
      : sanitizedContent;
    const finalCount = countChapterLength(normalizedContent, input.lengthSpec.countingMode);
    const warning = constraintViolation
      ? `Length normalizer output violated user constraints; kept original chapter (${constraintViolation}).`
      : wasTruncated
      ? "Length normalizer output appeared truncated; kept original chapter."
      : crossedHardRange
        ? "Length normalizer output crossed the hard range; kept original chapter."
      : this.buildWarning(finalCount, input.lengthSpec);

    return {
      normalizedContent,
      finalCount,
      applied: normalizedContent !== input.chapterContent,
      mode,
      warning,
      tokenUsage: response.usage,
    };
  }

  private buildSystemPrompt(mode: LengthNormalizeMode, safeExpansion: boolean): string {
    const action = mode === "compress"
      ? "compress"
      : "expand";

    return `你是一位章节长度修正器。你的任务是对章节正文做一次单次修正，只能执行一次，不得递归重写。

修正目标：
- ${action} 章节长度到给定目标区间
- 保留章节原有事实、关键钩子、角色名和必须保留的标记
- 用户提供的章节约束是硬约束；不得以扩写、压缩或长度目标为理由放宽、改写或反向解释
- 不要引入新的支线、未来揭示或额外总结
- 不要在正文外输出任何解释${safeExpansion ? `
- 当前是安全扩写补偿：只增加已有场景中的对白、动作、空间过渡和可观察反应；不得新增数字、单位、器材、人物、势力、设定、伏笔或未来信息
- 如果原文已经含有违反用户约束的字面术语，先用不新增事实的中性可观察表达替换，再进行安全扩写` : ""}`;
  }

  private buildUserPrompt(
    input: NormalizeLengthInput,
    originalCount: number,
    mode: LengthNormalizeMode,
  ): string {
    const intentBlock = input.chapterIntent
      ? `\n## Chapter Intent\n${input.chapterIntent}\n`
      : "";
    const controlBlock = input.reducedControlBlock
      ? `\n## Reduced Control Block\n${input.reducedControlBlock}\n`
      : "";

    return `请对下面正文做一次${mode === "compress" ? "压缩" : "扩写"}修正。

## Length Spec
- Target: ${input.lengthSpec.target}
- Soft Range: ${input.lengthSpec.softMin}-${input.lengthSpec.softMax}
- Hard Range: ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax}
- Counting Mode: ${input.lengthSpec.countingMode}

## Current Count
${originalCount}

## Correction Rules
- 只修正一次，不要递归
- 保留正文中的关键标记、人物名、地点名和已有事实
- 严格执行用户原始约束；禁止项、数字上限和可观测性边界优先于长度目标
- 如果无法同时满足长度目标和用户约束，宁可保持原文，不要补造禁用术语、过密数字或不可观测精度
- 如果当前正文已经含有用户明确禁止的术语、超限数字或不可观测精度，必须在不新增事实的前提下删除或改成中性可观察表达
- 不要凭空新增子情节
- 不要插入解释性总结或分析
- 输出修正后的完整正文，不要加标签

${intentBlock}${controlBlock}${input.safeExpansion ? `
## Safe Expansion Fallback
这是一次有界的长度补偿，不是可选建议。为抵消模型欠量，必须输出至少达到 Soft Range 下限 ${input.lengthSpec.softMin} 的完整正文；最终验收仍以 Hard Range 下限 ${input.lengthSpec.hardMin} 为底线。不要原样返回当前短正文。
仅补足已有场景的对白、动作、空间过渡和可观察反应。不要改写既有事实，不要添加任何新的数字、单位、精度、器材、人物、势力、世界观解释、伏笔或内部标记。` : ""}
## Chapter Content
${input.chapterContent}`;
  }

  private buildConstraintPolicy(input: NormalizeLengthInput): NormalizerConstraintPolicy {
    const constraintText = [input.chapterIntent, input.reducedControlBlock]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n");
    if (!constraintText) {
      return {
        forbiddenTerms: [],
        forbidUnobservablePrecision: false,
      };
    }

    const forbiddenTerms = new Set<string>();
    for (const line of constraintText.split(/\r?\n/)) {
      if (!NEGATIVE_CONSTRAINT_RE.test(line)) continue;

      for (const quoted of line.matchAll(/[“”「」『』‘’'`"]([^“”「」『』‘’'`"]+)[“”「」『』‘’'`"]?/g)) {
        const term = quoted[1]?.trim();
        if (term && term.length >= 2 && term.length <= 24) {
          forbiddenTerms.add(this.normalizeForbiddenTerm(term));
        }
      }

      for (const knownTerm of KNOWN_FORBIDDEN_TERMS) {
        if (new RegExp(this.escapeRegExp(knownTerm), "iu").test(line)) {
          forbiddenTerms.add(this.normalizeForbiddenTerm(knownTerm));
        }
      }
    }

    const explicitLimit = NUMERIC_LIMIT_PATTERNS
      .map((pattern) => pattern.exec(constraintText))
      .find((match) => match?.[1]);
    const hasNumericDensityRule = /过密数值|过多数字|数字堆砌|少量(?:可由|能由)?[^\n。；;]{0,12}数据/i.test(constraintText);
    const forbidUnobservablePrecision = /(?:不可观测|肉眼无法|仅仪器可测|没有任何测量仪器|无测量仪器)[^\n。；;]{0,24}(?:精度|数据|数值|测量)|(?:精度|数据|数值|测量)[^\n。；;]{0,24}(?:不可观测|肉眼无法|仅仪器可测)/i.test(constraintText);

    return {
      forbiddenTerms: [...forbiddenTerms].filter(Boolean),
      maxNumericTokens: explicitLimit ? Number(explicitLimit[1]) : undefined,
      maxAddedNumericTokens: explicitLimit || hasNumericDensityRule || forbidUnobservablePrecision
        ? MAX_ADDED_NUMERIC_TOKENS_WITHOUT_EXPLICIT_LIMIT
        : undefined,
      forbidUnobservablePrecision,
    };
  }

  private findConstraintViolation(
    candidate: string,
    original: string,
    policy: NormalizerConstraintPolicy,
  ): string | undefined {
    for (const term of policy.forbiddenTerms) {
      const candidateCount = this.countTerm(candidate, term);
      const originalCount = this.countTerm(original, term);
      if (candidateCount > originalCount) {
        return `forbidden term ${term}`;
      }
      if (candidateCount > 0) {
        return `forbidden term ${term} remains in output`;
      }
    }

    const candidateNumericTokens = this.countNumericTokens(candidate);
    if (policy.maxNumericTokens !== undefined && candidateNumericTokens > policy.maxNumericTokens) {
      return `numeric token count ${candidateNumericTokens} exceeds ${policy.maxNumericTokens}`;
    }

    const originalNumericTokens = this.countNumericTokens(original);
    if (
      policy.maxAddedNumericTokens !== undefined
      && candidateNumericTokens > originalNumericTokens + policy.maxAddedNumericTokens
    ) {
      return `numeric token increase ${candidateNumericTokens - originalNumericTokens} exceeds ${policy.maxAddedNumericTokens}`;
    }

    if (policy.forbidUnobservablePrecision) {
      const candidatePrecision = this.countMatches(candidate, UNOBSERVABLE_PRECISION_RE);
      const originalPrecision = this.countMatches(original, UNOBSERVABLE_PRECISION_RE);
      if (candidatePrecision > originalPrecision) {
        return originalPrecision > 0
          ? "unobservable precision remains in output"
          : "unobservable precision introduced";
      }
    }

    return undefined;
  }

  private countNumericTokens(content: string): number {
    return content.match(NUMERIC_TOKEN_RE)?.length ?? 0;
  }

  private countTerm(content: string, term: string): number {
    const escaped = this.escapeRegExp(term);
    const pattern = /^[A-Za-z][A-Za-z0-9²]*$/u.test(term)
      ? new RegExp(`(?<![A-Za-z])${escaped}(?:值|[_0-9₀-₉]+)?(?![A-Za-z])`, "giu")
      : new RegExp(escaped, "gu");
    return this.countMatches(content, pattern);
  }

  private countMatches(content: string, pattern: RegExp): number {
    return [...content.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].length;
  }

  private normalizeForbiddenTerm(term: string): string {
    return term.trim().replace(/^['“”「」『』‘’`]+|['“”「」『』‘’`]+$/g, "").replace(/值$/u, "");
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private buildWarning(finalCount: number, lengthSpec: LengthSpec): string | undefined {
    if (!isOutsideSoftRange(finalCount, lengthSpec)) {
      return undefined;
    }

    if (isOutsideHardRange(finalCount, lengthSpec)) {
      return `Final count ${finalCount} is outside the hard range ${lengthSpec.hardMin}-${lengthSpec.hardMax} after one normalization pass.`;
    }

    return `Final count ${finalCount} is outside the soft range ${lengthSpec.softMin}-${lengthSpec.softMax} after one normalization pass.`;
  }

  private crossesOppositeHardBound(
    originalCount: number,
    candidateCount: number,
    lengthSpec: LengthSpec,
  ): boolean {
    if (originalCount > lengthSpec.hardMax && candidateCount < lengthSpec.hardMin) {
      return true;
    }
    if (originalCount < lengthSpec.hardMin && candidateCount > lengthSpec.hardMax) {
      return true;
    }
    return false;
  }

  private sanitizeNormalizedContent(rawContent: string, fallbackContent: string): string {
    const trimmed = rawContent.trim();
    if (!trimmed) return fallbackContent;

    const fenced = this.extractFirstFencedBlock(trimmed);
    if (fenced) return fenced;

    const stripped = this.stripCommonWrappers(trimmed);
    if (stripped !== undefined) {
      // Empty after stripping = response was only wrapper text, use original
      if (!stripped) return fallbackContent;
      // Guard: if stripping removed more than 50% of content, the regex was too aggressive.
      if (stripped.length < trimmed.length * 0.5) return trimmed;
      return stripped;
    }

    return trimmed;
  }

  private looksTruncated(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (trimmed.endsWith("```")) return false;
    if (/[。！？!?」』”’）)\]】》…]$/.test(trimmed)) return false;
    if (/\n\s*$/.test(content) && /[，,；;：:]$/.test(trimmed)) return true;
    return /[，,；;：:、]$/.test(trimmed) || /[\u4e00-\u9fffA-Za-z0-9]$/.test(trimmed);
  }

  private extractFirstFencedBlock(content: string): string | undefined {
    const match = content.match(/```(?:[a-zA-Z-]+)?\s*\n([\s\S]*?)\n```/);
    if (!match) return undefined;
    const body = match[1]?.trim();
    return body ? body : undefined;
  }

  private stripCommonWrappers(content: string): string | undefined {
    const lines = content.split("\n");
    let removedAny = false;
    const keptLines: string[] = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (this.isWrapperLine(trimmed)) {
        removedAny = true;
        continue;
      }
      keptLines.push(rawLine);
    }

    if (!removedAny) {
      return undefined;
    }

    return keptLines.join("\n").trim();
  }

  private isWrapperLine(line: string): boolean {
    if (!line) return false;
    if (/^```/.test(line)) return true;
    if (/^#+\s*(说明|解释|注释|analysis|analysis note)\b/i.test(line)) return true;

    if (/^(下面是|以下是).*(正文|章节|压缩|扩写|修正|修改|调整|改写|润色|结果|内容|输出|版本)/i.test(line)) {
      return true;
    }

    if (/^我先.*(压缩|扩写|修正|修改|调整|改写|润色|处理).*(正文|章节)?/i.test(line)) {
      return true;
    }

    if (/^(here(?:'s| is)|below is).*(chapter|draft|content|rewrite|revised|compressed|expanded|normalized|adjusted|output|version|result)/i.test(line)) {
      return true;
    }

    if (/^i(?:'ll| will)\s+(rewrite|revise|reword|compress|expand|normalize|adjust|shorten|lengthen|trim|fix)\b/i.test(line)) {
      return true;
    }

    return false;
  }
}
