import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SidecarAssessment,
  CircuitBreakerEvent,
  SidecarCompactedObservation,
  AGENT_RESET_CIRCUIT_BREAKER,
  ResetCircuitBreakerRequest,
  ResetCircuitBreakerResponse,
  SIDECAR_VERDICTS,
  SIDECAR_RISK_CATEGORIES,
  CIRCUIT_BREAKER_STATES,
} from "../schemas/sidecar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../fixtures");

describe("Sidecar Protocol Schemas", () => {
  describe("Fixtures 交叉验证", () => {
    it("正确解析 sidecar-assessment.allow.json", () => {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURES_DIR, "sidecar-assessment.allow.json"),
          "utf-8"
        )
      );
      const parsed = SidecarAssessment.parse(raw);
      expect(parsed.callId).toBe("call-allow-1234");
      expect(parsed.capability).toBe("filesystem_list");
      expect(parsed.verdict).toBe("ALLOW");
      expect(parsed.riskCategory).toBe("NONE");
      expect(parsed.confidence).toBe(0.98);
      expect(parsed.assessedBy).toBe("jev-system-one");
      expect(parsed.remediation).toBeNull();
    });

    it("正确解析 sidecar-assessment.reject.json", () => {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURES_DIR, "sidecar-assessment.reject.json"),
          "utf-8"
        )
      );
      const parsed = SidecarAssessment.parse(raw);
      expect(parsed.callId).toBe("call-reject-5678");
      expect(parsed.verdict).toBe("REJECT_WITH_FEEDBACK");
      expect(parsed.riskCategory).toBe("SCOPE_ESCAPING");
      expect(parsed.remediation).toContain("确保前缀为已授权的根标识");
    });

    it("正确解析 sidecar-assessment.escalate.json", () => {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURES_DIR, "sidecar-assessment.escalate.json"),
          "utf-8"
        )
      );
      const parsed = SidecarAssessment.parse(raw);
      expect(parsed.callId).toBe("call-escalate-9999");
      expect(parsed.verdict).toBe("ESCALATE_TO_USER");
      expect(parsed.riskCategory).toBe("DESTRUCTIVE_COMMAND");
      expect(parsed.reason).toContain("rm -rf");
    });

    it("正确解析 sidecar-circuit-breaker.json", () => {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURES_DIR, "sidecar-circuit-breaker.json"),
          "utf-8"
        )
      );
      const parsed = CircuitBreakerEvent.parse(raw);
      expect(parsed.taskId).toBe("task-cb-001");
      expect(parsed.state).toBe("OPEN");
      expect(parsed.consecutiveRejections).toBe(3);
      expect(parsed.recentRejections).toHaveLength(3);
      expect(parsed.recentRejections[0].riskCategory).toBe("DESTRUCTIVE_COMMAND");
      expect(parsed.recentRejections[2].riskCategory).toBe("CREDENTIAL_EXFILTRATION");
    });

    it("正确解析 reset-circuit-breaker.request.json", () => {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURES_DIR, "reset-circuit-breaker.request.json"),
          "utf-8"
        )
      );
      const parsed = ResetCircuitBreakerRequest.parse(raw);
      expect(parsed.method).toBe(AGENT_RESET_CIRCUIT_BREAKER);
      expect(parsed.params.taskId).toBe("task-cb-001");
      expect(parsed.params.reason).toContain("恢复试探执行");
    });

    it("正确解析 reset-circuit-breaker.response.json", () => {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURES_DIR, "reset-circuit-breaker.response.json"),
          "utf-8"
        )
      );
      const parsed = ResetCircuitBreakerResponse.parse(raw);
      expect(parsed.result?.ok).toBe(true);
      expect(parsed.result?.state).toBe("HALF_OPEN");
    });
  });

  describe("枚举与模式边界校验", () => {
    it("包含预期的判决枚举集合", () => {
      expect(SIDECAR_VERDICTS).toEqual([
        "ALLOW",
        "REJECT_WITH_FEEDBACK",
        "ESCALATE_TO_USER",
      ]);
    });

    it("包含预期的风险类别枚举集合", () => {
      expect(SIDECAR_RISK_CATEGORIES).toEqual([
        "NONE",
        "DESTRUCTIVE_COMMAND",
        "CREDENTIAL_EXFILTRATION",
        "PROMPT_INJECTION",
        "SCOPE_ESCAPING",
        "SYSTEM_RESOURCE_ABUSE",
      ]);
    });

    it("包含预期的熔断器状态枚举集合", () => {
      expect(CIRCUIT_BREAKER_STATES).toEqual([
        "CLOSED",
        "OPEN",
        "HALF_OPEN",
      ]);
    });

    it("正确校验并填充 SidecarCompactedObservation 契约", () => {
      const sample = {
        callId: "call-compact-001",
        capability: "read_document",
        originalChars: 15000,
        compactedChars: 850,
        summary: "财务报表提取完成，本季度总营收增长 12%",
        keyFacts: ["总营收 5000 万", "净利润 800 万"],
      };
      const parsed = SidecarCompactedObservation.parse(sample);
      expect(parsed.callId).toBe("call-compact-001");
      expect(parsed.compactedChars).toBe(850);
      expect(parsed.keyFacts).toHaveLength(2);
    });
  });
});
