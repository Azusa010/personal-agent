import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Notification } from "../schemas/envelope.js";
import {
  AGENT_STREAM,
  AgentStreamNotification,
  AgentStreamParams,
} from "../schemas/agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf-8"));
}

const TASK_ID = "3f6a9c1e-8b4d-4f2a-9c7e-1d5b8a2e4f60";

/** wire 上的一条引擎事件通知：params 是 RunTaskEvent 的发生时副本。 */
const eventNotice = {
  jsonrpc: "2.0",
  method: AGENT_STREAM,
  params: {
    kind: "event",
    taskId: TASK_ID,
    event: {
      type: "tool_called",
      payload: {
        callId: "call-1",
        capability: "filesystem.list",
        arguments: { rootId: "downloads" },
      },
      occurredAt: "2026-09-18T09:00:00.123Z",
    },
  },
};

/** 思维摘要的增量：delta 是追加语义，不是全量快照。 */
const thinkingNotice = {
  jsonrpc: "2.0",
  method: AGENT_STREAM,
  params: {
    kind: "thinking",
    taskId: TASK_ID,
    delta: "先列出 Downloads 里有哪些 PDF，再决定提取哪一份。",
  },
};

/**
 * agent.stream 的 payload 级契约（TASK-033）。
 *
 * 方法是 Python → TS 的单向通知（无 id）：它是「尽力而为的实时预览」，
 * 事实来源仍是 agent.run_task 的回包。Python 侧的对称用例在
 * services/agent-runtime/tests/test_protocol_fixtures.py 与 test_stream.py，
 * 共享样本在 fixtures/agent-stream.*.notification.json。
 */
describe("AgentStreamParams", () => {
  it("接受 event 分支：带一条完整 RunTaskEvent", () => {
    const parsed = AgentStreamParams.parse(eventNotice.params);
    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") {
      expect(parsed.taskId).toBe(TASK_ID);
      expect(parsed.event.type).toBe("tool_called");
      expect(parsed.event.occurredAt).toBe("2026-09-18T09:00:00.123Z");
    }
  });

  it("接受 thinking 分支", () => {
    expect(AgentStreamParams.parse(thinkingNotice.params)).toEqual(
      thinkingNotice.params,
    );
  });

  it("kind 决定分支：event 分支缺 event 不猜成 thinking", () => {
    // 判别联合的意义就在这儿：缺字段只该报「这个分支不完整」，
    // 而不是悄悄落到另一支上去。
    const r = AgentStreamParams.safeParse({ kind: "event", taskId: TASK_ID });
    expect(r.success).toBe(false);
  });

  it("thinking 的 delta 不能是空串", () => {
    // 空增量上线只有一个效果：让 UI 收到一条没有内容的通知。
    // 契约层拒掉，Python 侧也有一条「空 delta 不写」的对称用例。
    const r = AgentStreamParams.safeParse({
      ...thinkingNotice.params,
      delta: "",
    });
    expect(r.success).toBe(false);
  });

  it("taskId 不能是空串", () => {
    expect(
      AgentStreamParams.safeParse({ ...thinkingNotice.params, taskId: "" })
        .success,
    ).toBe(false);
    expect(
      AgentStreamParams.safeParse({ ...eventNotice.params, taskId: "" })
        .success,
    ).toBe(false);
  });

  it("拒绝未知 kind", () => {
    expect(
      AgentStreamParams.safeParse({ kind: "final", taskId: TASK_ID, text: "x" })
        .success,
    ).toBe(false);
  });

  it("occurredAt 必须是毫秒三位 + Z", () => {
    // 与 RunTaskEvent 同一条钉子：datetime.now(UTC).isoformat() 给的是
    // +00:00 结尾、微秒六位，直接塞进来会被这里拒掉。
    const bad = {
      ...eventNotice.params,
      event: {
        ...eventNotice.params.event,
        occurredAt: "2026-09-18T09:00:00+00:00",
      },
    };
    expect(AgentStreamParams.safeParse(bad).success).toBe(false);
  });

  it("剥掉自由文本字段：payload 形状由生产端决定，但未知键不进阶", () => {
    // z.object 默认 strip。这条钉住「将来有人把 schema 放宽成 passthrough」。
    const parsed = AgentStreamParams.parse({
      ...thinkingNotice.params,
      text: "模型想自己编的字段",
    });
    expect(parsed).toEqual(thinkingNotice.params);
  });
});

describe("AgentStreamNotification", () => {
  it("接受两条合法通知", () => {
    expect(AgentStreamNotification.parse(eventNotice)).toEqual(eventNotice);
    expect(AgentStreamNotification.parse(thinkingNotice)).toEqual(
      thinkingNotice,
    );
  });

  it("jsonrpc 与 method 都钉死", () => {
    expect(
      AgentStreamNotification.safeParse({ ...eventNotice, jsonrpc: "1.0" })
        .success,
    ).toBe(false);
    expect(
      AgentStreamNotification.safeParse({
        ...eventNotice,
        method: "agent.run_task",
      }).success,
    ).toBe(false);
  });

  it("通知不带 id：它不属于任何一次请求的回包", () => {
    // 带上 id 会被 Envelope 的 Response 语义吸引，读的人会去等一个永远不会来的
    // pending 匹配。这条钉住「通知就是通知」。
    expect(
      AgentStreamNotification.safeParse({ ...eventNotice, id: "req-1" })
        .success,
    ).toBe(true);
    // 上面这条会通过（z.object strip 掉 id），所以真正的钉子在下一条：
    const parsed = AgentStreamNotification.parse({
      ...eventNotice,
      id: "req-1",
    });
    expect(Object.keys(parsed)).toEqual(["jsonrpc", "method", "params"]);
  });
});

describe("agent.stream 的 fixture 不得与 Envelope 漂移", () => {
  // 与 host 那组对称：AgentStreamNotification 没有 extend Envelope 的 Notification，
  // 用这两条钉住包含关系。任一侧放宽都会在这里红。
  for (const file of [
    "agent-stream.event.notification.json",
    "agent-stream.thinking.notification.json",
  ]) {
    it(`${file} 同时满足 Envelope Notification`, () => {
      const raw = load(file);
      expect(() => AgentStreamNotification.parse(raw)).not.toThrow();
      expect(() => Notification.parse(raw)).not.toThrow();
    });
  }
});
