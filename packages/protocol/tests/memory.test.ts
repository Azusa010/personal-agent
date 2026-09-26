import { describe, it, expect } from "vitest";
import {
  UserMemoryCard,
  UserMemoryNote,
  UserMemoryItem,
  UserMemorySearchParams,
  UserMemorySearchResult,
  UserMemorySearchOutcome,
  MEMORY_ENTRY_FORMATS,
  MEMORY_TYPES,
  MEMORY_CATEGORIES,
} from "../schemas/memory.js";
import { CapabilityFailure } from "../schemas/host.js";

describe("UserMemoryCard schema", () => {
  it("接受完整的合法 Advanced JSON Card", () => {
    const card = UserMemoryCard.parse({
      id: "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      memoryType: "semantic",
      category: "preference",
      subject: "用户",
      person: "本人",
      relationship: "本人",
      content: { language: "zh-CN", tone: "concise" },
      backstory: "2026年9月在财报讨论中确认",
      sourceTaskId: "task-101",
      confidence: 0.95,
      occurredAt: "2026-09-24T10:00:00Z",
      validFrom: "2026-09-24T10:00:00Z",
      supersededBy: null,
      supersedeReason: null,
      accessCount: 3,
      lastAccessedAt: "2026-09-24T11:00:00Z",
      isSanitized: true,
      createdAt: "2026-09-24T10:00:00Z",
      updatedAt: "2026-09-24T10:00:00Z",
    });

    expect(card.subject).toBe("用户");
    expect(card.person).toBe("本人");
    expect(card.content).toEqual({ language: "zh-CN", tone: "concise" });
    expect(card.confidence).toBe(0.95);
    expect(card.isSanitized).toBe(true);
  });

  it("缺省可选字段时使用正确默认值或允许为 null/undefined", () => {
    const card = UserMemoryCard.parse({
      id: "a1b2c3d4-e5f6-4a8b-9c0d-1e2f3a4b5c6d",
      memoryType: "episodic",
      category: "general",
      subject: "东京之行",
      content: { destination: "Tokyo", year: 2025 },
      validFrom: "2025-01-01T00:00:00Z",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });

    expect(card.confidence).toBe(1.0);
    expect(card.accessCount).toBe(0);
    expect(card.isSanitized).toBe(false);
    expect(card.person).toBeUndefined();
    expect(card.supersededBy).toBeUndefined();
  });

  it("拒绝非法的 memoryType 或 category", () => {
    expect(
      UserMemoryCard.safeParse({
        id: "00000000-0000-0000-0000-000000000001",
        memoryType: "invalid_type",
        category: "preference",
        subject: "test",
        content: {},
        validFrom: "2025-01-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }).success,
    ).toBe(false);

    expect(
      UserMemoryCard.safeParse({
        id: "00000000-0000-0000-0000-000000000001",
        memoryType: "semantic",
        category: "unknown_category",
        subject: "test",
        content: {},
        validFrom: "2025-01-01T00:00:00Z",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("枚举定义与 readonly const 数组严格对齐", () => {
    expect(MEMORY_TYPES).toEqual(["semantic", "episodic", "procedural"]);
    expect(MEMORY_CATEGORIES).toEqual([
      "preference",
      "identity",
      "relationship",
      "work",
      "routine",
      "general",
    ]);
  });
});

describe("UserMemorySearchParams schema", () => {
  it("接受基础查询与默认值", () => {
    const params = UserMemorySearchParams.parse({
      query: "护照有效期",
    });
    expect(params.query).toBe("护照有效期");
    expect(params.topK).toBe(5);
    expect(params.includeSuperseded).toBe(false);
  });

  it("接受多维实体与时间切片参数", () => {
    const params = UserMemorySearchParams.parse({
      query: "预算讨论",
      memoryType: "episodic",
      category: "work",
      person: "本人",
      relationship: "本人",
      occurredAfter: "2026-01-01T00:00:00Z",
      occurredBefore: "2026-09-01T00:00:00Z",
      topK: 10,
      includeSuperseded: true,
      minScore: 0.6,
    });
    expect(params.memoryType).toBe("episodic");
    expect(params.person).toBe("本人");
    expect(params.occurredAfter).toBe("2026-01-01T00:00:00Z");
    expect(params.includeSuperseded).toBe(true);
  });

  it("拒绝空 query", () => {
    expect(UserMemorySearchParams.safeParse({ query: "" }).success).toBe(false);
  });

  it("拒绝越界 topK", () => {
    expect(
      UserMemorySearchParams.safeParse({ query: "test", topK: 0 }).success,
    ).toBe(false);
    expect(
      UserMemorySearchParams.safeParse({ query: "test", topK: 51 }).success,
    ).toBe(false);
  });
});

describe("UserMemorySearchOutcome schema", () => {
  it("成功分支识别与结构检验", () => {
    const outcome = UserMemorySearchOutcome.parse({
      ok: true,
      query: "素食偏好",
      totalFound: 1,
      items: [
        {
          card: {
            id: "11111111-1111-4111-8111-111111111111",
            memoryType: "semantic",
            category: "preference",
            subject: "饮食",
            person: "本人",
            relationship: "本人",
            content: { dietary: "vegetarian" },
            backstory: "外卖订餐时提及",
            validFrom: "2026-01-01T00:00:00Z",
            confidence: 1.0,
            accessCount: 2,
            isSanitized: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          score: 0.92,
          denseRank: 1,
          sparseRank: 1,
          matchedText: "饮食: dietary = vegetarian",
        },
      ],
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.items).toHaveLength(1);
      expect(outcome.items[0].card?.subject).toBe("饮食");
    }
  });

  it("失败分支与 CapabilityFailure 互斥对齐", () => {
    const outcome = UserMemorySearchOutcome.parse({
      ok: false,
      code: "USER_MEMORY_SEARCH_FAILED",
      reason: "数据库查询超时",
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("USER_MEMORY_SEARCH_FAILED");
    }

    expect(
      CapabilityFailure.safeParse({
        ok: true,
        query: "x",
        totalFound: 0,
        items: [],
      }).success,
    ).toBe(false);

    expect(
      UserMemorySearchResult.safeParse({
        ok: false,
        code: "FAIL",
        reason: "x",
      }).success,
    ).toBe(false);
  });
});

describe("UserMemoryNote schema", () => {
  it("接受合法的 Simple Note 并填充默认值", () => {
    const note = UserMemoryNote.parse({
      id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
      title: "关于 Docker 容器构建网络超时的排查记录",
      noteText: "在构建 pgvector 镜像时，偶尔会因为境外源超时导致 pip 安装失败，需要使用国内镜像源。",
      validFrom: "2026-09-25T12:00:00Z",
      createdAt: "2026-09-25T12:00:00Z",
      updatedAt: "2026-09-25T12:00:00Z",
    });

    expect(note.entryFormat).toBe("note");
    expect(note.title).toContain("Docker");
    expect(note.confidence).toBe(0.8);
    expect(note.tags).toEqual([]);
    expect(note.accessCount).toBe(0);
    expect(note.isSanitized).toBe(false);
  });

  it("带 tags 与自定义置信度的 Note 解析成功", () => {
    const note = UserMemoryNote.parse({
      entryFormat: "note",
      id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
      title: "终端快捷命令别名",
      noteText: "用户习惯使用 gs 替代 git status，使用 ll 替代 ls -l。",
      tags: ["shell", "alias", "git"],
      confidence: 0.9,
      validFrom: "2026-09-25T12:00:00Z",
      createdAt: "2026-09-25T12:00:00Z",
      updatedAt: "2026-09-25T12:00:00Z",
    });

    expect(note.tags).toHaveLength(3);
    expect(note.confidence).toBe(0.9);
  });
});

describe("UserMemoryItem 判别式联合 (Discriminated Union)", () => {
  it("根据 entryFormat 正确分流为 UserMemoryCard", () => {
    const item = UserMemoryItem.parse({
      entryFormat: "card",
      id: "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      memoryType: "semantic",
      category: "preference",
      subject: "代码格式偏好",
      content: { indent: 2, semicolons: false },
      validFrom: "2026-09-25T00:00:00Z",
      createdAt: "2026-09-25T00:00:00Z",
      updatedAt: "2026-09-25T00:00:00Z",
    });

    expect(item.entryFormat).toBe("card");
    if (item.entryFormat === "card") {
      expect(item.subject).toBe("代码格式偏好");
      expect(item.content).toEqual({ indent: 2, semicolons: false });
    }
  });

  it("根据 entryFormat 正确分流为 UserMemoryNote", () => {
    const item = UserMemoryItem.parse({
      entryFormat: "note",
      id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
      title: "日常备忘",
      noteText: "下周三下午有技术评审会。",
      tags: ["meeting", "work"],
      validFrom: "2026-09-25T00:00:00Z",
      createdAt: "2026-09-25T00:00:00Z",
      updatedAt: "2026-09-25T00:00:00Z",
    });

    expect(item.entryFormat).toBe("note");
    if (item.entryFormat === "note") {
      expect(item.title).toBe("日常备忘");
      expect(item.noteText).toContain("技术评审");
    }
  });

  it("非法 entryFormat 被严格拦截", () => {
    const result = UserMemoryItem.safeParse({
      entryFormat: "unknown_format",
      id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
      validFrom: "2026-09-25T00:00:00Z",
      createdAt: "2026-09-25T00:00:00Z",
      updatedAt: "2026-09-25T00:00:00Z",
    });

    expect(result.success).toBe(false);
  });
});
