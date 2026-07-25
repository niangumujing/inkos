import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityAuditor } from "../agents/continuity.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("ContinuityAuditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a critical audit issue instead of throwing when audit output is not JSON", () => {
    const auditor = new ContinuityAuditor({
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
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-bad-json-test",
    });

    const result = (auditor as any).parseAuditResult("模型只返回了一段散文，没有 JSON。", "zh");

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("审稿输出解析失败");
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "critical",
        category: "系统错误",
      }),
    ]);
  });

  it("parses typed repair_scope from audit JSON", () => {
    const auditor = new ContinuityAuditor({
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
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-repair-scope-test",
    });

    const result = (auditor as any).parseAuditResult(JSON.stringify({
      passed: false,
      issues: [{
        severity: "critical",
        repair_scope: "structural",
        category: "模型审稿判断",
        description: "核心场面缺失",
        suggestion: "重写场面",
      }],
      summary: "needs rewrite",
    }), "zh");

    expect(result.issues[0]).toMatchObject({
      repairScope: "structural",
      category: "模型审稿判断",
    });
  });

  it("prefers book language override when building audit prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-lang-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await mkdir(join(root, "prompt", "longform"), { recursive: true });

    await Promise.all([
      writeFile(join(root, "prompt", "longform", "auditor.md"), "PROJECT AUDITOR OVERRIDE", "utf-8"),
      writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "english-book",
          title: "English Book",
          genre: "xuanhuan",
          platform: "royalroad",
          chapterWordCount: 800,
          targetChapters: 60,
          status: "active",
          language: "en",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue keeps the oath token hidden.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nReturn to the mentor debt.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(bookDir, "Chapter body.", 1, "xuanhuan");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("ALL OUTPUT MUST BE IN ENGLISH");
      expect(systemPrompt).toContain("PROJECT AUDITOR OVERRIDE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("localizes English audit prompts instead of mixing Chinese control text", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-en-prompt-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "english-book",
          title: "English Book",
          genre: "other",
          platform: "royalroad",
          chapterWordCount: 800,
          targetChapters: 60,
          status: "active",
          language: "en",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara keeps the warehouse key hidden.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nCheck Warehouse 9.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(bookDir, "Chapter body.", 1, "other");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      expect(systemPrompt).toContain("Hook Check");
      expect(systemPrompt).toContain("Chapter Memo Drift Check");
      expect(systemPrompt).not.toContain("Outline Drift Check");
      expect(systemPrompt).toContain("stays dormant long enough to feel abandoned");
      expect(systemPrompt).toContain("3-question test");
      expect(systemPrompt).toContain("same mode long enough to flatten rhythm");
      expect(systemPrompt).not.toContain("more than 5 chapters");
      expect(systemPrompt).not.toContain("3 straight chapters");
      expect(systemPrompt).not.toContain("3+ consecutive chapters");
      expect(systemPrompt).not.toContain("伏笔检查");
      expect(systemPrompt).not.toContain("大纲偏离检测");

      expect(userPrompt).toContain("Review chapter 1.");
      expect(userPrompt).toContain("## Current State Card");
      expect(userPrompt).toContain("## Pending Hooks");
      expect(userPrompt).not.toContain("请审查第1章");
      expect(userPrompt).not.toContain("## 当前状态卡");
      expect(userPrompt).not.toContain("## 伏笔池");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses selected summary and hook evidence instead of full long-history markdown in governed mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "# Pending Hooks",
          "",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| guild-route | 1 | mystery | open | 2 | 6 | Merchant guild trail |",
          "| mentor-oath | 8 | relationship | open | 99 | 101 | Mentor oath debt with Lin Yue |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "# Chapter Summaries",
          "",
          "| 1 | Guild Trail | Merchant guild flees west | Route clues only | None | guild-route seeded | tense | action |",
          "| 99 | Trial Echo | Lin Yue | Mentor left without explanation | Oath token matters again | mentor-oath advanced | aching | fallout |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线进度板\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感弧线\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 角色交互矩阵\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 100\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(
        bookDir,
        "Chapter body.",
        100,
        "xuanhuan",
        {
          chapterIntent: "# Chapter Intent\n\n## Goal\nBring the focus back to the mentor oath conflict.\n",
          contextPackage: {
            chapter: 100,
            selectedContext: [
              {
                source: "story/chapter_summaries.md#99",
                reason: "Relevant episodic memory.",
                excerpt: "Trial Echo | Mentor left without explanation | mentor-oath advanced",
              },
              {
                source: "story/pending_hooks.md#mentor-oath",
                reason: "Carry forward unresolved hook.",
                excerpt: "relationship | open | 101 | Mentor oath debt with Lin Yue",
              },
            ],
          },
          ruleStack: {
            layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
            sections: {
              hard: ["current_state"],
              soft: ["current_focus"],
              diagnostic: ["continuity_audit"],
            },
            overrideEdges: [],
            activeOverrides: [],
          },
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const userPrompt = messages?.[1]?.content ?? "";

      expect(userPrompt).toContain("story/chapter_summaries.md#99");
      expect(userPrompt).toContain("story/pending_hooks.md#mentor-oath");
      expect(userPrompt).not.toContain("| 1 | Guild Trail |");
      expect(userPrompt).not.toContain("guild-route | 1 | mystery");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects the chapter memo into the audit prompt for memo-drift checking", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-memo-drift-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 矩阵\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({ passed: true, issues: [], summary: "ok" }),
      usage: ZERO_USAGE,
    });

    const memoBody = [
      "## 当前任务",
      "陆焚在小巷抢回残刃并离开。",
      "",
      "## 读者此刻在等什么",
      "读者想看他怎么脱身。",
      "",
      "## 该兑现的 / 暂不掀的",
      "兑现：残刃归手；暂不掀：身世。",
      "",
      "## 日常/过渡承担什么任务",
      "开篇小巷场景 → 情绪代入 + 信息植入。",
      "",
      "## 关键抉择过三连问",
      "陆焚选择独自动手的理由是什么？",
      "",
      "## 章尾必须发生的改变",
      "陆焚拿回残刃，被人目击。",
      "",
      "## 本章 hook 账",
      "resolve: H11 残刃下落 → 本章找回。defer: H04 幕后主使 → 留到第 50 章。",
      "",
      "## 不要做",
      "不要写成大段打斗。",
      "不要出现“灰痕”“焰纹”等能力名称；只写“指尖发烫”等可观察反应。",
    ].join("\n");

    try {
      const result = await auditor.auditChapter(bookDir, "他启用了灰痕。", 42, "xuanhuan", {
        chapterMemo: {
          chapter: 42,
          goal: "陆焚抢回残刃并离开",
          isGoldenOpening: false,
          body: memoBody,
          threadRefs: [],
        },
      });

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      // Prompt declares structure-only scope and sparse-memo legality.
      expect(systemPrompt).toContain("审稿边界");
      expect(systemPrompt).toContain("你不审文笔");
      expect(systemPrompt).toContain("稀疏 memo 是合法状态");
      expect(systemPrompt).toContain("章节备忘偏离");
      expect(systemPrompt).not.toContain("大纲偏离检测");

      // User prompt injects the memo for drift-checking.
      expect(userPrompt).toContain("## 章节备忘（用于 memo 偏离检测）");
      expect(userPrompt).toContain("goal：陆焚抢回残刃并离开");
      expect(userPrompt).toContain("## 章尾必须发生的改变");
      expect(userPrompt).toContain("## 强制章末契约核对");
      expect(userPrompt).toContain("不得未经逐条核验就概括为“完全兑现”");
      expect(userPrompt).toContain("不要写成大段打斗。");
      expect(result.passed).toBe(false);
      expect(result.issues).toContainEqual(expect.objectContaining({
        severity: "critical",
        category: "章节备忘契约",
        description: expect.stringContaining("灰痕×1"),
      }));
      // Legacy volume-outline block is gone.
      expect(userPrompt).not.toContain("## 卷纲");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat parenthetical permitted evidence as a literal-term ban", () => {
    const contractAuditor = new ContinuityAuditor({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-parenthetical-evidence-test",
    });

    const issues = (contractAuditor as any).detectLiteralMemoContractViolations(
      "## 不要做\n不要出现手机短信（她用座机查气象局电话，拨号音真实）。",
      "她拿起座机，拨号音真实、单调、带着老式线路的底噪。",
      "zh",
    );

    expect(issues).toEqual([]);
  });

  it("does not treat an explanation ban as a literal-term ban", () => {
    const explanationAuditor = new ContinuityAuditor({
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
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-explanation-contract-test",
    });

    const issues = (explanationAuditor as any).detectLiteralMemoContractViolations(
      "## 不要做\n不要解释“临-07”含义，只测量并记录。",
      "铁牌正面蚀刻临-07。",
      "zh",
    );

    expect(issues).toEqual([]);
  });

  it("does not treat an allowed naming clause as a literal ban", () => {
    const contractAuditor = new ContinuityAuditor({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-allowed-name-test",
    });

    const issues = (contractAuditor as any).detectLiteralMemoContractViolations(
      "## 不要做\n- 不得提前使用“灰痕”“烬刻”“天炉”等术语，税票只能叫“记忆税票”，钟楼只能叫“钟楼”",
      "远处钟楼传来第七声钟响。",
      "zh",
    );

    expect(issues).toEqual([]);
  });

  it("extracts unquoted forbidden terms and catches unit subscript variants", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-forbidden-list-test",
    });

    const issues = (auditor as any).detectLiteralMemoContractViolations(
      "## 不要做\n不要量角器、OD、mV。",
      "她拿起量角器，记录 OD₅₄₀，再用 127mV 标记读数。",
      "zh",
    );

    expect(issues[0]).toMatchObject({
      severity: "critical",
      category: "章节备忘契约",
    });
    expect(issues[0]?.description).toContain("量角器×1");
    expect(issues[0]?.description).toContain("OD×1");
    expect(issues[0]?.description).toContain("mV×1");
  });

  it("downgrades model-only OOC and hook criticals without persisted user evidence", () => {
    const auditor = new ContinuityAuditor({ client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } }, model: "test-model", projectRoot: "/tmp/inkos-auditor-model-critical-boundary-test" });
    const memo = { chapter: 1, goal: "修复录音", isGoldenOpening: true, body: "## 当前任务\n修复录音。\n\n## 不要做\n不要提前解释真相。", threadRefs: [] };
    const issues = (auditor as any).sanitizeModelAuditIssues([
      { severity: "critical", category: "OOC检查", description: "角色违反了模型推断的OA工单规则。", suggestion: "改写。" },
      { severity: "critical", category: "伏笔检查", description: "必须逐字写出模型推断的格式。", suggestion: "补写。" },
    ], memo, "zh");
    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", category: "OOC检查" }),
      expect.objectContaining({ severity: "warning", category: "伏笔检查" }),
    ]);
  });

  it("keeps model-only OOC and hook criticals advisory even when user guidance exists", () => {
    const auditor = new ContinuityAuditor({ client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } }, model: "test-model", projectRoot: "/tmp/inkos-auditor-user-context-model-critical-test" });
    const memo = { chapter: 3, goal: "完成赴约", isGoldenOpening: true, body: "## 用户原始章节指导（逐条强制遵守）\n- 删除主动回忆。\n\n## 不要做\n不要提前揭示身份。", threadRefs: [] };
    const issues = (auditor as any).sanitizeModelAuditIssues([{ severity: "critical", category: "伏笔检查", description: "模型声称H002必须完成五维实体闭环。", suggestion: "补造精密测量。" }], memo, "zh");
    expect(issues[0]).toMatchObject({ severity: "warning", category: "伏笔检查" });
  });

  it("drops speculative memo-ban variant claims", () => {
    const auditor = new ContinuityAuditor({ client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } }, model: "test-model", projectRoot: "/tmp/inkos-auditor-memo-variant-test" });
    const memo = { chapter: 3, goal: "赴约", isGoldenOpening: false, body: "## 不要做\n不要出现任何‘他忽然想起’式闪回。", threadRefs: [] };
    const issues = (auditor as any).sanitizeModelAuditIssues([{ severity: "critical", category: "章节备忘偏离", description: "正文出现‘他忽然想起’式闪回变体，实质是用感官残留包装回忆。", suggestion: "删除。" }], memo, "zh");
    expect(issues).toEqual([]);
  });

  it("drops model explicit-ban claims unsupported by deterministic memo bans", () => {
    const auditor = new ContinuityAuditor({ client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } }, model: "test-model", projectRoot: "/tmp/inkos-auditor-explicit-ban-test" });
    const memo = { chapter: 1, goal: "修复录音", isGoldenOpening: true, body: "## 不要做\n不要出现手机短信（她用座机查电话，拨号音真实）。", threadRefs: [] };
    const issues = (auditor as any).sanitizeModelAuditIssues([{ severity: "critical", category: "章节备忘偏离", description: "正文直接违反 chapter_memo 中明确禁止的措辞：'拨号音真实'。", suggestion: "删除。" }], memo, "zh");
    expect(issues).toEqual([]);
  });

  it("drops unsupported memo requirement claims and neutralizes forbidden suggestions", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-evidence-boundary-test",
    });
    const memo = {
      chapter: 2,
      goal: "拿回残刃并离开",
      isGoldenOpening: false,
      body: "## 当前任务\n拿回残刃并离开。\n\n## 不要做\n不要量角器、OD、mV。",
      threadRefs: [],
    };

    const issues = (auditor as any).sanitizeModelAuditIssues(
      [
        {
          severity: "warning",
          category: "章节备忘偏离",
          description: "银线应在第3章显影，但正文没有写出。",
          suggestion: "加入银线第3章显影，并使用量角器、OD、mV复核。",
        },
        {
          severity: "warning",
          category: "数值检查",
          description: "正文出现了无法解释的测量表达。",
          suggestion: "加入量角器、OD、mV复核。",
        },
      ],
      memo,
      "zh",
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.description).toContain("无法解释");
    expect(issues[0]?.suggestion).toBe("仅依据正文中已经出现的可观察事实修复，不引入章节备忘明确禁止的术语、器材或单位。");
    expect(issues[0]?.suggestion).not.toMatch(/量角器|OD|mV/u);
  });

  it("uses persisted original chapter instructions as contract evidence", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-persisted-guidance-test",
    });
    const body = [
      "## 当前任务",
      "验证税票。",
      "",
      "## 不要做",
      "不要提前解释真相。",
      "",
      "## 用户原始章节指导（逐条强制遵守）",
      "- 本章没有任何测量仪器。禁止出现量角器、OD值、mV。",
    ].join("\n");

    const contractIssues = (auditor as any).detectLiteralMemoContractViolations(
      body,
      "他拿起量角器，记录OD₅₄₀与mV读数。",
      "zh",
    );
    const sanitized = (auditor as any).sanitizeModelAuditIssues(
      [{
        severity: "warning",
        category: "数值检查",
        description: "正文测量方式不可信。",
        suggestion: "加入量角器、OD和127mV复核。",
      }],
      { chapter: 2, goal: "验证税票", isGoldenOpening: false, body, threadRefs: [] },
      "zh",
    );

    expect(contractIssues[0]?.description).toContain("量角器×1");
    expect(contractIssues[0]?.description).toContain("OD×1");
    expect(contractIssues[0]?.description).toContain("mV×1");
    expect(sanitized[0]?.suggestion).not.toMatch(/量角器|OD|mV/u);
  });

  it("lets persisted user guidance override a contradictory model ban", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-user-guidance-precedence-test",
    });
    const body = [
      "## 不要做",
      "- 不得含数字“十七”。",
      "",
      "## 用户原始章节指导（逐条强制遵守）",
      "- 保留铜匣内壁十七道刻痕这一第1章已建立事实。",
    ].join("\n");

    const issues = (auditor as any).detectLiteralMemoContractViolations(
      body,
      "铜匣内壁十七道刻痕仍在。",
      "zh",
    );

    expect(issues).toEqual([]);
  });

  it("drops a fabricated quoted memo requirement despite incidental phrase overlap", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-fabricated-quote-test",
    });
    const memo = {
      chapter: 2,
      goal: "验证税票",
      isGoldenOpening: false,
      body: "## 当前任务\n验证税票。\n\n## 本章 hook 账\n第3章程十七买票。",
      threadRefs: [],
    };

    const issues = (auditor as any).sanitizeModelAuditIssues(
      [{
        severity: "critical",
        category: "章节备忘偏离",
        description: "memo明确要求‘H001银线需留到第3章由程十七递来的验尸报告显影’，但正文提前出现。",
        suggestion: "删除银线。",
      }],
      memo,
      "zh",
    );

    expect(issues).toEqual([]);
  });

  it("keeps memo claims that quote an actual requirement", () => {
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-supported-evidence-test",
    });
    const memo = {
      chapter: 2,
      goal: "拿回残刃并离开",
      isGoldenOpening: false,
      body: "## 章尾必须发生的改变\n陆焚拿回残刃并离开。",
      threadRefs: [],
    };
    const issue = {
      severity: "critical",
      category: "章节备忘偏离",
      description: "章节备忘要求“拿回残刃并离开”，但正文没有兑现。",
      suggestion: "补足离开现场的动作。",
    };

    const issues = (auditor as any).sanitizeModelAuditIssues([issue], memo, "zh");

    expect(issues).toEqual([issue]);
  });

  it("detects unquoted forbidden character introductions and planning markers", () => {
    const contractAuditor = new ContinuityAuditor({
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
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-auditor-planning-leak-test",
    });
    const chapter = "门外有人通报程十七求见。顾临川记下：NEW_H008已验。";

    const contractIssues = (contractAuditor as any).detectLiteralMemoContractViolations(
      "## 不要做\n- 不得引入程十七。",
      chapter,
      "zh",
    );
    const leakIssues = (contractAuditor as any).detectInternalPlanningLeaks(chapter, "zh");

    expect(contractIssues[0]?.description).toContain("程十七×1");
    expect(leakIssues[0]).toMatchObject({
      severity: "critical",
      category: "内部规划标记泄露",
    });
  });
});
