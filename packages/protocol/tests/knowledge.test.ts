import { describe, it, expect } from "vitest";

import {
  KnowledgeSearchParams,
  KnowledgeChunkItem,
  KnowledgeSearchResult,
  KnowledgeSearchOutcome,
} from "../schemas/knowledge.js";
import { CapabilityFailure } from "../schemas/host.js";

describe("KnowledgeSearchParams", () => {
  it("接受合法查询参数（带默认 topK）", () => {
    const parsed = KnowledgeSearchParams.parse({
      query: "智能体混合检索",
    });
    expect(parsed.query).toBe("智能体混合检索");
    expect(parsed.topK).toBe(5);
  });

  it("接受显式 topK 和过滤参数", () => {
    const parsed = KnowledgeSearchParams.parse({
      query: "BM25 算法",
      topK: 10,
      denseLimit: 50,
      sparseLimit: 50,
      fileTypes: ["pdf", "markdown"],
      documentIds: ["a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d"],
      minScore: 0.5,
    });
    expect(parsed.topK).toBe(10);
    expect(parsed.fileTypes).toEqual(["pdf", "markdown"]);
  });

  it("拒绝空 query", () => {
    expect(KnowledgeSearchParams.safeParse({ query: "" }).success).toBe(false);
  });

  it("拒绝缺少 query", () => {
    expect(KnowledgeSearchParams.safeParse({}).success).toBe(false);
  });

  it("拒绝非法 topK（非正数或超出上限）", () => {
    expect(
      KnowledgeSearchParams.safeParse({ query: "test", topK: 0 }).success,
    ).toBe(false);
    expect(
      KnowledgeSearchParams.safeParse({ query: "test", topK: 100 }).success,
    ).toBe(false);
  });
});

describe("KnowledgeChunkItem", () => {
  it("接受合法 chunk 结构", () => {
    const chunk = KnowledgeChunkItem.parse({
      id: "c-1",
      documentId: "doc-1",
      fileName: "agent.md",
      sourcePath: "/path/agent.md",
      chunkIndex: 0,
      pageNumbers: [1, 2],
      headingPath: "第3章/3.1节",
      rawText: "分块内容",
      score: 0.88,
      denseRank: 1,
      sparseRank: 3,
    });
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.pageNumbers).toEqual([1, 2]);
    expect(chunk.denseRank).toBe(1);
  });

  it("允许 headingPath 为 null 或缺省", () => {
    const chunk = KnowledgeChunkItem.parse({
      id: "c-2",
      documentId: "doc-2",
      fileName: "plain.txt",
      sourcePath: "/path/plain.txt",
      chunkIndex: 1,
      pageNumbers: [1],
      headingPath: null,
      rawText: "无标题文本",
      score: 0.75,
    });
    expect(chunk.headingPath).toBeNull();
  });
});

describe("KnowledgeSearchOutcome", () => {
  it("判别到成功分支", () => {
    const outcome = KnowledgeSearchOutcome.parse({
      ok: true,
      query: "测试",
      totalFound: 1,
      chunks: [
        {
          id: "c-1",
          documentId: "d-1",
          fileName: "doc.md",
          sourcePath: "/doc.md",
          chunkIndex: 0,
          pageNumbers: [1],
          rawText: "文本",
          score: 0.9,
        },
      ],
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.chunks).toHaveLength(1);
    }
  });

  it("判别到失败分支", () => {
    const outcome = KnowledgeSearchOutcome.parse({
      ok: false,
      code: "KNOWLEDGE_SEARCH_FAILED",
      reason: "PostgreSQL 连接超时",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("KNOWLEDGE_SEARCH_FAILED");
    }
  });

  it("成功结果与 CapabilityFailure 互斥", () => {
    expect(
      CapabilityFailure.safeParse({
        ok: true,
        query: "x",
        totalFound: 0,
        chunks: [],
      }).success,
    ).toBe(false);

    expect(
      KnowledgeSearchResult.safeParse({
        ok: false,
        code: "FAIL",
        reason: "x",
      }).success,
    ).toBe(false);
  });
});
