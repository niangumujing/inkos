import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseAgent } from "../agents/base.js";
import { LengthNormalizerAgent } from "../agents/length-normalizer.js";
import { LengthSpecSchema } from "../models/length-governance.js";
import { countChapterLength } from "../utils/length-metrics.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const AGENT_CONTEXT = {
  client: {
    provider: "openai",
    apiFormat: "chat",
    stream: false,
    defaults: {
      temperature: 0.7,
      maxTokens: 4096,
      thinkingBudget: 0,
      extra: {},
    },
  } as const,
  model: "test-model",
  projectRoot: "/tmp/inkos-length-normalizer-test",
};

function createAgent(): LengthNormalizerAgent {
  return new LengthNormalizerAgent(AGENT_CONTEXT as never);
}

describe("LengthNormalizerAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compresses a long draft while preserving required markers", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "压缩后的正文。".repeat(22) + "[[KEEP_ME]]",
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "开头。" + "多余句子。".repeat(80) + "[[KEEP_ME]]";

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Preserve [[KEEP_ME]] and remove redundancy.",
      reducedControlBlock: "Avoid [[FORBIDDEN]] and keep the scene on target.",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.mode).toBe("compress");
    expect(result.normalizedContent).toContain("[[KEEP_ME]]");
    expect(result.normalizedContent).not.toContain("[[FORBIDDEN]]");
    expect(result.finalCount).toBe(countChapterLength(result.normalizedContent, "zh_chars"));
    expect(result.finalCount).toBeLessThan(countChapterLength(draft, "zh_chars"));
  });

  it("expands a short draft without inserting forbidden markers", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "扩写后的正文，补足细节和过渡，但不引入禁词。",
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "expand",
    });
    const draft = "开头太短。";

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Keep the chapter focused on the mentor conflict.",
      reducedControlBlock: "Forbidden marker: [[FORBIDDEN]].",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.mode).toBe("expand");
    expect(result.normalizedContent).not.toContain("[[FORBIDDEN]]");
    expect(result.finalCount).toBe(countChapterLength(result.normalizedContent, "zh_chars"));
    expect(result.finalCount).toBeGreaterThan(countChapterLength(draft, "zh_chars"));
  });

  it("never retries normalization in the same pass", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "仍然过长的正文。".repeat(60),
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "开头。" + "冗余句子。".repeat(100);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Preserve the scene marker [[KEEP_ME]].",
      reducedControlBlock: "Do not invent new subplots.",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.mode).toBe("compress");
    expect(result.warning).toContain("outside");
  });

  it("does not override provider output budget for large compression outputs", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "压缩后的完整正文。".repeat(200),
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 3500,
      softMin: 3023,
      softMax: 3977,
      hardMin: 2800,
      hardMax: 4200,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });

    await agent.normalizeChapter({
      chapterContent: "原始正文。".repeat(1200),
      lengthSpec,
    });

    const options = chatSpy.mock.calls[0]?.[1] as { maxTokens?: number } | undefined;
    expect(options?.maxTokens).toBeUndefined();
  });

  it("falls back to the original chapter when normalized output is truncated mid-sentence", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "李队把传真和登记表叠在一起，收进文件夹，眼神已经不是单",
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 3500,
      softMin: 3023,
      softMax: 3977,
      hardMin: 2800,
      hardMax: 4200,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "原始正文有完整句号。".repeat(400);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(draft);
    expect(result.warning).toContain("truncated");
  });

  it("keeps the original chapter when compression crosses below the hard minimum", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "压缩过头。".repeat(70),
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 1000,
      softMin: 864,
      softMax: 1136,
      hardMin: 728,
      hardMax: 1272,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "完整场景。".repeat(300);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(draft);
    expect(result.finalCount).toBe(countChapterLength(draft, "zh_chars"));
    expect(result.applied).toBe(false);
    expect(result.warning).toContain("crossed the hard range");
  });

  it("keeps the original chapter when expansion crosses above the hard maximum", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "扩写过头。".repeat(400),
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 1000,
      softMin: 864,
      softMax: 1136,
      hardMin: 728,
      hardMax: 1272,
      countingMode: "zh_chars",
      normalizeMode: "expand",
    });
    const draft = "短。".repeat(100);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(draft);
    expect(result.finalCount).toBe(countChapterLength(draft, "zh_chars"));
    expect(result.applied).toBe(false);
    expect(result.warning).toContain("crossed the hard range");
  });

  it("keeps a complete in-range rewrite even when it ends without punctuation", async () => {
    const agent = createAgent();
    const rewrite = "完整正文".repeat(900);
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: rewrite,
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 3500,
      softMin: 3023,
      softMax: 3977,
      hardMin: 2800,
      hardMax: 4200,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "原始正文有完整句号。".repeat(500);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(rewrite);
    expect(result.warning).toBeUndefined();
  });

  it("strips explanatory wrappers from malformed normalizer output", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: [
        "我先压缩一下正文。",
        "",
        "```markdown",
        "压缩后的正文。[[KEEP_ME]]",
        "```",
      ].join("\n"),
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "开头。" + "冗余句子。".repeat(50) + "[[KEEP_ME]]";

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Preserve [[KEEP_ME]] only.",
      reducedControlBlock: "No extra commentary.",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe("压缩后的正文。[[KEEP_ME]]");
    expect(result.normalizedContent).not.toContain("我先压缩一下正文");
    expect(result.normalizedContent).not.toContain("```");
  });

  it("falls back to the original chapter when the response contains only wrappers", async () => {
    const agent = createAgent();
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: "我先压缩一下正文。",
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "开头。" + "冗余句子。".repeat(40) + "[[KEEP_ME]]";

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      chapterIntent: "Preserve [[KEEP_ME]] only.",
      reducedControlBlock: "No extra commentary.",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(draft);
    expect(result.finalCount).toBe(countChapterLength(draft, "zh_chars"));
  });

  it("preserves legitimate Chinese prose that starts with '我先'", async () => {
    const agent = createAgent();
    const prose = "我先回去了，明天再说。\n风从窗缝里灌进来。";
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: prose,
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "zh_chars",
      normalizeMode: "compress",
    });
    const draft = "原文。".repeat(80);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(prose);
  });

  it("preserves legitimate English prose that starts with 'I will'", async () => {
    const agent = createAgent();
    const prose = "I will wait here until dawn.\nThe shutters rattled in the wind.";
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: prose,
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 280,
      countingMode: "en_words",
      normalizeMode: "compress",
    });
    const draft = "Original text. ".repeat(80);

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(prose);
  });

  it("rejects newly introduced forbidden OD output even when the length is valid", async () => {
    const agent = createAgent();
    const draft = "原始正文保持在安全范围内。".repeat(20);
    const polluted = "顾临川把票据按平，OD₅₄₀=1.87的读数落在纸面上。".repeat(5);
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: polluted,
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 320,
      countingMode: "zh_chars",
      normalizeMode: "expand",
    });

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      reducedControlBlock: "本章没有任何测量仪器。禁止出现 OD值、mV、nm、量角器或肉眼无法获得的精度。",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(draft);
    expect(result.applied).toBe(false);
    expect(result.warning).toContain("forbidden term OD");
  });

  it("rejects numeric-token overflow instead of accepting a polluted expansion", async () => {
    const agent = createAgent();
    const draft = "原始正文保持在安全范围内。".repeat(20);
    const polluted = "他在纸边连续写下1、2、3、4、5、6、7、8、9、10、11、12、13、14、15、16、17、18。";
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: polluted,
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 320,
      countingMode: "zh_chars",
      normalizeMode: "expand",
    });

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      reducedControlBlock: "数字 token 不超过 5 个；避免过密数值。",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(draft);
    expect(result.applied).toBe(false);
    expect(result.warning).toContain("numeric token count 18 exceeds 5");
  });

  it("rejects newly introduced unobservable precision", async () => {
    const agent = createAgent();
    const draft = "原始正文保持在安全范围内。".repeat(20);
    const polluted = "他记录下纸背的变化：误差0.004mm，随后把结果归入精度模型。".repeat(4);
    const chatSpy = vi.spyOn(BaseAgent.prototype as never, "chat").mockResolvedValue({
      content: polluted,
      usage: ZERO_USAGE,
    });
    const lengthSpec = LengthSpecSchema.parse({
      target: 220,
      softMin: 190,
      softMax: 250,
      hardMin: 160,
      hardMax: 320,
      countingMode: "zh_chars",
      normalizeMode: "expand",
    });

    const result = await agent.normalizeChapter({
      chapterContent: draft,
      lengthSpec,
      reducedControlBlock: "本章没有任何测量仪器，不得生成不可观测精度；只保留少量可由手感获得的数据。",
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.normalizedContent).toBe(draft);
    expect(result.applied).toBe(false);
    expect(result.warning).toContain("unobservable precision introduced");
  });
});
