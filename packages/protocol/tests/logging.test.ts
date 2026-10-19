import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOG_LEVELS,
  LOG_SCHEMA_VERSION,
  LOG_SOURCES,
  LogRecord,
  PYTHON_LOG_PREFIX,
} from "../schemas/logging.js";
import * as schemaIndex from "../schemas/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGGING_FIXTURES = path.resolve(__dirname, "../fixtures/logging");

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(LOGGING_FIXTURES, name), "utf-8"));
}

function readStringFixture(name: string): string {
  return fs.readFileSync(path.join(LOGGING_FIXTURES, name), "utf-8");
}

describe("Logging Protocol Schemas", () => {
  describe("常量契约", () => {
    it("级别枚举固定为五档，warning 不在其中", () => {
      expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error", "fatal"]);
      expect(LOG_LEVELS).not.toContain("warning");
    });

    it("来源枚举固定为三档", () => {
      expect(LOG_SOURCES).toEqual(["main", "python", "renderer"]);
    });

    it("schemaVersion 与 Python 帧前缀已钉死", () => {
      expect(LOG_SCHEMA_VERSION).toBe(1);
      expect(PYTHON_LOG_PREFIX).toBe("@@PALOG@@");
    });
  });

  describe("Fixtures 交叉验证", () => {
    it("完整样本可解析且字段逐一正确", () => {
      const parsed = LogRecord.parse(readFixture("log-record.valid.json"));

      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.id).toBe("8f14e45f-ceea-467f-a8d1-9a3b0b6f0c11");
      expect(parsed.ts).toBe("2026-10-19T13:29:33.123Z");
      expect(parsed.level).toBe("error");
      expect(parsed.source).toBe("main");
      expect(parsed.event).toBe("tool.call.failed");
      expect(parsed.code).toBe("HOST_HANDLER_FAILED");
      expect(parsed.message).toBe("tool call failed after 3 retries");
      expect(parsed.fingerprint).toBe("5547fcd84f52e0b0391ba871f039167be3253785");
      expect(parsed.sessionId).toBe("session-2026-10-19-001");
      expect(parsed.taskId).toBe("task-42");
      expect(parsed.traceId).toBe("trace-7");
      expect(parsed.durationMs).toBe(1830);
      expect(parsed.context).toEqual({
        capability: "terminal_execute",
        attempt: 3,
        nested: { ok: false, reason: "timeout" },
      });
    });

    it("最小样本（仅必填字段）可解析", () => {
      const parsed = LogRecord.parse(readFixture("log-record.minimal.json"));

      expect(parsed.level).toBe("info");
      expect(parsed.source).toBe("renderer");
      expect(parsed.event).toBe("app.started");
      expect(parsed.code).toBeUndefined();
      expect(parsed.stack).toBeUndefined();
      expect(parsed.context).toBeUndefined();
    });

    it("level=warning 必须被拒绝，且报错指向 level 字段", () => {
      const result = LogRecord.safeParse(readFixture("log-record.invalid-level.json"));

      expect(result.success).toBe(false);
      if (result.success) return;
      const fields = result.error.issues.map((issue) => issue.path.join("."));
      expect(fields).toContain("level");
    });

    it("schemaVersion 不是 1 必须被拒绝", () => {
      const raw = readFixture("log-record.minimal.json") as Record<string, unknown>;
      const bumped = { ...raw, schemaVersion: 2 };

      const result = LogRecord.safeParse(bumped);

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues.map((i) => i.path.join("."))).toContain("schemaVersion");
    });

    it("fingerprint 非 40 位小写 hex 必须被拒绝", () => {
      const raw = readFixture("log-record.minimal.json") as Record<string, unknown>;

      for (const bad of ["ABC", "5547FCD84F52E0B0391BA871F039167BE3253785", "z".repeat(40)]) {
        const result = LogRecord.safeParse({ ...raw, fingerprint: bad });
        expect(result.success).toBe(false);
      }
    });

    it("必填字段缺失必须被拒绝", () => {
      const raw = readFixture("log-record.minimal.json") as Record<string, unknown>;

      for (const key of ["id", "ts", "level", "source", "event", "message", "sessionId"]) {
        const clone = { ...raw };
        delete clone[key];
        const result = LogRecord.safeParse(clone);
        expect(result.success, `缺失 ${key} 时应拒绝`).toBe(false);
      }
    });

    it("未知字段保留而非静默丢弃（对齐 Pydantic extra=allow）", () => {
      const raw = readFixture("log-record.minimal.json") as Record<string, unknown>;
      const parsed = LogRecord.parse({ ...raw, futureField: { hint: "keep-me" } });

      expect(parsed.futureField).toEqual({ hint: "keep-me" });
    });
  });

  describe("指纹 fixture 自身一致性", () => {
    const fixture = JSON.parse(readStringFixture("fingerprint-cases.json")) as {
      cases: Array<{
        name: string;
        input: { source: string; event: string };
        normalizedMessage: string;
        topFrame: string | null;
        expected: string;
      }>;
    };

    const byName = (name: string) => {
      const found = fixture.cases.find((c) => c.name === name);
      if (!found) throw new Error(`缺少 fixture case: ${name}`);
      return found;
    };

    it("所有期望值都是 40 位小写 hex", () => {
      for (const item of fixture.cases) {
        expect(item.expected, item.name).toMatch(/^[0-9a-f]{40}$/);
      }
    });

    it("仅数字/行号/UUID 不同的样本必须共享同一指纹", () => {
      expect(byName("retry-count-variant-a").expected).toBe(
        byName("retry-count-variant-b").expected,
      );
      expect(byName("uuid-a").expected).toBe(byName("uuid-b").expected);
    });

    it("event 不同的样本必须分裂成不同指纹", () => {
      expect(byName("different-event").expected).not.toBe(
        byName("retry-count-variant-a").expected,
      );
      expect(byName("no-code-no-stack").expected).not.toBe(byName("different-event").expected);
    });
  });

  describe("包入口接线（反孤岛）", () => {
    it("schemas/index 必须 re-export 日志契约", () => {
      const exported = schemaIndex as unknown as Record<string, unknown>;

      expect(exported.LogRecord).toBe(LogRecord);
      expect(exported.LOG_LEVELS).toEqual(LOG_LEVELS);
      expect(exported.LOG_SOURCES).toEqual(LOG_SOURCES);
      expect(exported.PYTHON_LOG_PREFIX).toBe(PYTHON_LOG_PREFIX);
    });
  });
});
