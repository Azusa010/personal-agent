import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KnowledgeProposal,
  KnowledgeReviewOutcome,
  KnowledgeDiffOp,
  KNOWLEDGE_DIFF_OPS,
  KNOWLEDGE_PR_STATUSES,
  REVIEW_VERDICTS,
  CRITIQUE_VERDICTS,
  CRITIQUE_ISSUE_TYPES,
} from "../schemas/knowledge_update.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

describe("Knowledge Update Protocol Schemas", () => {
  describe("Fixtures cross-validation", () => {
    it("正确解析 knowledge-proposal.json fixture", () => {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURES_DIR, "knowledge-proposal.json"),
          "utf-8"
        )
      );
      const parsed = KnowledgeProposal.parse(raw);
      expect(parsed.id).toBe("e3f1a2b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b");
      expect(parsed.targetLayer).toBe("user_memory");
      expect(parsed.operations).toHaveLength(1);
      expect(parsed.operations[0].op).toBe("UPDATE");
      expect(parsed.operations[0].qualification).toBe(
        "限公务出差场景，私人旅行不在此限"
      );
      expect(parsed.status).toBe("pending");
    });

    it("正确解析 knowledge-review.json fixture", () => {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURES_DIR, "knowledge-review.json"),
          "utf-8"
        )
      );
      const parsed = KnowledgeReviewOutcome.parse(raw);
      expect(parsed.proposalId).toBe("e3f1a2b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b");
      expect(parsed.reviewerModel).toBe("gpt-4o");
      expect(parsed.verdict).toBe("approved");
      expect(parsed.critiques).toHaveLength(1);
      expect(parsed.critiques[0].verdict).toBe("pass");
    });
  });

  describe("枚举与边界校验", () => {
    it("包含预期的操作类型枚举", () => {
      expect(KNOWLEDGE_DIFF_OPS).toEqual([
        "ADD",
        "UPDATE",
        "INVALIDATE",
        "QUALIFY",
      ]);
    });

    it("包含预期的 PR 状态枚举", () => {
      expect(KNOWLEDGE_PR_STATUSES).toEqual([
        "pending",
        "approved",
        "rejected",
        "revision_requested",
      ]);
    });

    it("包含预期的审查判定枚举", () => {
      expect(REVIEW_VERDICTS).toEqual([
        "approved",
        "rejected",
        "revision_requested",
      ]);
      expect(CRITIQUE_VERDICTS).toEqual(["pass", "reject", "revise"]);
      expect(CRITIQUE_ISSUE_TYPES).toEqual([
        "lacks_evidence",
        "over_broad_deletion",
        "missing_qualification",
        "format_error",
      ]);
    });

    it("非法操作类型被拒", () => {
      expect(() =>
        KnowledgeDiffOp.parse({
          op: "UNKNOWN_OP",
          targetType: "user_memory",
          payload: { text: "val" },
          evidenceRefs: ["c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f"],
        })
      ).toThrow();
    });

    it("缺少 evidenceRefs 被拒", () => {
      expect(() =>
        KnowledgeDiffOp.parse({
          op: "ADD",
          targetType: "user_memory",
          payload: { text: "val" },
          evidenceRefs: [],
        })
      ).toThrow();
    });

    it("空操作列表的提案被拒", () => {
      expect(() =>
        KnowledgeProposal.parse({
          id: "e3f1a2b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b",
          title: "空提案",
          targetLayer: "user_memory",
          proposerModel: "claude",
          operations: [],
          evidenceIds: ["c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f"],
          createdAt: "2026-09-26T12:00:00Z",
          updatedAt: "2026-09-26T12:00:00Z",
        })
      ).toThrow();
    });
  });
});
