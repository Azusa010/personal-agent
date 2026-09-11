import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Request, Response } from "../schemas/envelope.js";
import { InitializeParams, InitializeResult } from "../schemas/systems.js";
import {
  FilesystemListParams,
  FilesystemListResult,
} from "../schemas/filesystem.js";
import {
  HostExecuteToolParams,
  HostExecuteToolRequest,
  HostExecuteToolResponse,
  CapabilityFailure,
} from "../schemas/host.js";
import {
  DocumentExtractPdfParams,
  DocumentExtractPdfResult,
} from "../schemas/document.js";
import {
  RunTaskEvent,
  RunTaskParams,
  RunTaskRequest,
  RunTaskResponse,
  RunTaskResult,
  SummaryFact,
} from "../schemas/agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures");

/**
 * 按点路径取嵌套字段。
 *
 * capability 的 arguments 住在 params.arguments 里，原来的一层取值拿不到。
 */
function pick(raw: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc === null || acc === undefined
          ? undefined
          : (acc as Record<string, unknown>)[key],
      raw,
    );
}

const legalCases = [
  {
    file: "initialize.request.json",
    envelope: Request,
    payload: InitializeParams,
    field: "params",
  },
  {
    file: "initialize.response.json",
    envelope: Response,
    payload: InitializeResult,
    field: "result",
  },
  {
    file: "ping.request.json",
    envelope: Request,
    payload: null,
    field: "params",
  },
  {
    file: "ping.response.json",
    envelope: Response,
    payload: null,
    field: "result",
  },
  // filesystem.list 不再是 TS→Python 的独立 method（执行体已移到 host 侧），
  // 所以它的 params/result 挂在 host.execute_tool 的 arguments/result 上。
  {
    file: "host-filesystem-list.request.json",
    envelope: HostExecuteToolRequest,
    payload: HostExecuteToolParams,
    field: "params",
  },
  {
    file: "host-filesystem-list.request.json",
    envelope: HostExecuteToolRequest,
    payload: FilesystemListParams,
    field: "params.arguments",
  },
  // FilesystemListResult 只钉 entries。host result 里的 ok 会被 z.object 剥掉
  //（实测：parse({ok:true,entries:[…]}) 输出只剩 entries），
  // ok 由 envelope 层的 HostExecuteToolResult 负责，两层各管一件事。
  {
    file: "host-filesystem-list.response.json",
    envelope: HostExecuteToolResponse,
    payload: FilesystemListResult,
    field: "result",
  },
  {
    file: "host-execute-tool.request.json",
    envelope: HostExecuteToolRequest,
    payload: HostExecuteToolParams,
    field: "params",
  },
  {
    file: "host-execute-tool.request.json",
    envelope: HostExecuteToolRequest,
    payload: DocumentExtractPdfParams,
    field: "params.arguments",
  },
  {
    file: "host-execute-tool.response.json",
    envelope: HostExecuteToolResponse,
    payload: DocumentExtractPdfResult,
    field: "result",
  },
  // 业务失败（PDF 损坏等）走 result 不走 error，形状由 CapabilityFailure 钉。
  {
    file: "host-execute-tool.failure.response.json",
    envelope: HostExecuteToolResponse,
    payload: CapabilityFailure,
    field: "result",
  },
  {
    file: "agent-run-task.request.json",
    envelope: RunTaskRequest,
    payload: RunTaskParams,
    field: "params",
  },
  // 两个 response 的 payload 层写 null：RunTaskResponse.result 已经是
  // 强类型的判别联合，envelope 校验会递归到 facts 与 events。
  // host 那边需要单独钉 payload，是因为 HostExecuteToolResult 只有 ok 一个字段。
  {
    file: "agent-run-task.completed.response.json",
    envelope: RunTaskResponse,
    payload: null,
    field: "result",
  },
  {
    file: "agent-run-task.failed.response.json",
    envelope: RunTaskResponse,
    payload: null,
    field: "result",
  },
];

describe("协议契约：合法 Fixture 必须被接受", () => {
  for (const c of legalCases) {
    // 名字带上 field：同一个 fixture 会被多条 case 用不同 payload 校验，
    // 只写文件名的话测试报告里出现两条同名用例，红了分不清是哪一层。
    it(`接受 ${c.file} 的 ${c.field}`, () => {
      const raw = JSON.parse(readFileSync(join(fixturesDir, c.file), "utf-8"));
      expect(() => c.envelope.parse(raw)).not.toThrow();
      if (c.payload) {
        expect(() => c.payload.parse(pick(raw, c.field))).not.toThrow();
      }
    });
  }
});

describe("协议契约：非法 Fixture 必须被拒绝", () => {
  const files = readdirSync(join(fixturesDir, "invalid")).filter((f) =>
    f.endsWith(".json"),
  );
  for (const file of files) {
    it(`拒绝${file}`, () => {
      const raw = JSON.parse(
        readFileSync(join(fixturesDir, "invalid", file), "utf-8"),
      );
      // host- 前缀必须先判：Envelope 的 Request 不校验 id 命名空间和
      // capability 白名单，用它校验这三个 fixture 会全部通过。
      if (file.startsWith("host-request-")) {
        expect(() => HostExecuteToolRequest.parse(raw)).toThrow();
      } else if (file.startsWith("host-response-")) {
        expect(() => HostExecuteToolResponse.parse(raw)).toThrow();
      } else if (file.startsWith("request-")) {
        expect(() => Request.parse(raw)).toThrow();
      } else if (file.startsWith("response-")) {
        expect(() => Response.parse(raw)).toThrow();
      } else {
        // 缺这一行时命名不合规的 fixture 会空跑通过：
        // 循环走完一个断言都没执行，vitest 仍然报 passed。
        throw new Error(`未知前缀的非法 fixture: ${file}`);
      }
    });
  }
});

describe("host schema 不得与 Envelope 漂移", () => {
  // host 的 Request/Response 没有 extend Envelope（zod 4 里 Response 带
  // superRefine，extend 行为不确定），改由这两条钉住包含关系。
  it("host 请求同时满足 Envelope Request", () => {
    const raw = JSON.parse(
      readFileSync(
        join(fixturesDir, "host-execute-tool.request.json"),
        "utf-8",
      ),
    );
    expect(() => HostExecuteToolRequest.parse(raw)).not.toThrow();
    expect(() => Request.parse(raw)).not.toThrow();
  });

  it("host 响应同时满足 Envelope Response", () => {
    for (const f of [
      "host-execute-tool.response.json",
      "host-execute-tool.failure.response.json",
    ]) {
      const raw = JSON.parse(readFileSync(join(fixturesDir, f), "utf-8"));
      expect(() => HostExecuteToolResponse.parse(raw)).not.toThrow();
      expect(() => Response.parse(raw)).not.toThrow();
    }
  });
});

const TASK_EVENT = {
  type: "tool_called",
  payload: { capability: "filesystem.list" },
  occurredAt: "2026-09-11T10:00:00.120Z",
};

describe("RunTaskParams 约束", () => {
  it("合法入参被接受", () => {
    expect(() =>
      RunTaskParams.parse({ taskId: "t-1", goal: "整理 PDF" }),
    ).not.toThrow();
  });

  it("空 goal 被拒", () => {
    expect(() => RunTaskParams.parse({ taskId: "t-1", goal: "" })).toThrow();
  });

  it("缺 taskId 被拒", () => {
    expect(() => RunTaskParams.parse({ goal: "整理 PDF" })).toThrow();
  });

  it("字段清单钉死：预算不在契约里", () => {
    // 多出预算字段就意味着 TS 能调预算，UI 就得暴露旋钮并校验范围，
    // 而指导书没这个需求。
    expect(Object.keys(RunTaskParams.shape)).toEqual(["taskId", "goal"]);
  });
});

describe("RunTaskEvent 的字段与时间戳约束", () => {
  it("字段清单钉死：不带 taskId", () => {
    // 带上 taskId 就允许 Python 把事件回传到别的任务上，
    // 而那个 id 恰好存在时 DB 外键不会拦，Timeline 会静默串任务。
    expect(Object.keys(RunTaskEvent.shape)).toEqual([
      "type",
      "payload",
      "occurredAt",
    ]);
  });

  it("3 位毫秒 + Z 合法", () => {
    expect(() => RunTaskEvent.parse(TASK_EVENT)).not.toThrow();
  });

  it("+00:00 结尾被拒", () => {
    // Python 的 datetime.now(timezone.utc).isoformat() 默认就是这个格式，
    // engine 不显式格式化会在这里红。
    expect(() =>
      RunTaskEvent.parse({
        ...TASK_EVENT,
        occurredAt: "2026-09-11T10:00:00.120+00:00",
      }),
    ).toThrow();
  });

  it("无小数秒被拒", () => {
    expect(() =>
      RunTaskEvent.parse({ ...TASK_EVENT, occurredAt: "2026-09-11T10:00:00Z" }),
    ).toThrow();
  });

  it("6 位微秒被拒", () => {
    expect(() =>
      RunTaskEvent.parse({
        ...TASK_EVENT,
        occurredAt: "2026-09-11T10:00:00.120000Z",
      }),
    ).toThrow();
  });

  it("type 为空串被拒", () => {
    expect(() => RunTaskEvent.parse({ ...TASK_EVENT, type: "" })).toThrow();
  });

  it("payload 缺失被拒", () => {
    // execution_events.payload 是 TEXT NOT NULL，落库走 JSON.stringify(event.payload)。
    // 契约允许缺键的话，undefined 会在 better-sqlite3 绑定处炸，或者 TS 侧
    // 补一个 ?? {} 的静默默认，把生产端漏字段盖住。
    // 同一条线上的 Request.params 也是 z.unknown() 且必填，ping.request.json
    // 写的是 "params": {} 而不是省略 —— 这里跟现有约定保持一致。
    expect(() =>
      RunTaskEvent.parse({ type: "t", occurredAt: TASK_EVENT.occurredAt }),
    ).toThrow();
  });

  it("payload 显式为 null 合法", () => {
    // JSON.stringify(null) 是 "null"，存得进 NOT NULL 的 TEXT 列也读得回。
    expect(() =>
      RunTaskEvent.parse({
        type: "t",
        payload: null,
        occurredAt: TASK_EVENT.occurredAt,
      }),
    ).not.toThrow();
  });
});

describe("SummaryFact 的页码约束", () => {
  it("字段清单钉死", () => {
    expect(Object.keys(SummaryFact.shape)).toEqual(["text", "pageRefs"]);
  });

  it("pageRefs 为空数组合法", () => {
    // REQ-007 的「必须有页码引用」是业务规则，判定它的是 TASK-014 的
    // SummaryVerifier。契约层拒的话错误码会指向 PROTOCOL 而不是
    // 「摘要不可信」，排查方向就错了。
    expect(() =>
      SummaryFact.parse({ text: "结论", pageRefs: [] }),
    ).not.toThrow();
  });

  it("pageRefs 含 0 被拒", () => {
    expect(() => SummaryFact.parse({ text: "结论", pageRefs: [0] })).toThrow();
  });

  it("pageRefs 含小数被拒", () => {
    expect(() =>
      SummaryFact.parse({ text: "结论", pageRefs: [1.5] }),
    ).toThrow();
  });

  it("text 为空串被拒", () => {
    expect(() => SummaryFact.parse({ text: "", pageRefs: [1] })).toThrow();
  });
});

describe("RunTaskResult 的判别联合", () => {
  it("completed 分支合法", () => {
    expect(() =>
      RunTaskResult.parse({ status: "completed", facts: [], events: [] }),
    ).not.toThrow();
  });

  it("failed 分支合法", () => {
    expect(() =>
      RunTaskResult.parse({ status: "failed", reason: "预算耗尽", events: [] }),
    ).not.toThrow();
  });

  it("status 为 running 被拒：任务生命周期归 TS 侧状态机", () => {
    // tasks 表的 CHECK 允许五个值，但那是 TS 侧 ALLOWED_TRANSITIONS 管的。
    // Python 能回 running 就等于给了它改任务生命周期的权力。
    expect(() =>
      RunTaskResult.parse({ status: "running", events: [] }),
    ).toThrow();
  });

  it("completed 缺 facts 被拒", () => {
    expect(() =>
      RunTaskResult.parse({ status: "completed", events: [] }),
    ).toThrow();
  });

  it("failed 缺 reason 被拒", () => {
    expect(() =>
      RunTaskResult.parse({ status: "failed", events: [] }),
    ).toThrow();
  });

  it("failed 缺 events 被拒：失败任务的时间线不能是空的", () => {
    expect(() =>
      RunTaskResult.parse({ status: "failed", reason: "预算耗尽" }),
    ).toThrow();
  });
});

describe("RunTask 的 envelope", () => {
  it("method 字面值钉死", () => {
    expect(() =>
      RunTaskRequest.parse({
        jsonrpc: "2.0",
        id: "req-002",
        method: "agent.runTask",
        params: { taskId: "t-1", goal: "g" },
      }),
    ).toThrow();
  });

  it("result 与 error 同时出现被拒", () => {
    expect(() =>
      RunTaskResponse.parse({
        jsonrpc: "2.0",
        id: "req-002",
        result: { status: "completed", facts: [], events: [] },
        error: { code: "X", message: "y" },
      }),
    ).toThrow();
  });

  it("result 与 error 都缺失被拒", () => {
    expect(() =>
      RunTaskResponse.parse({ jsonrpc: "2.0", id: "req-002" }),
    ).toThrow();
  });
});

describe("InitializeParams 的能力清单约束", () => {
  const legal = {
    protocolVersion: "0.1",
    capabilities: [
      {
        name: "filesystem.list",
        kind: "READ",
        description: "列出授权根目录下的条目",
      },
    ],
    client: { name: "personal-agent-electron", version: "0.1.0" },
  };

  it("合法清单被接受", () => {
    expect(() => InitializeParams.parse(legal)).not.toThrow();
  });

  it("缺 capabilities 被拒", () => {
    // 可选带默认空数组的话，TS 侧漏传与“真的一个能力都看不到”
    // 在 wire 上长得一样，Python 无法分辨。
    expect(() =>
      InitializeParams.parse({
        protocolVersion: "0.1",
        client: { name: "personal-agent-electron", version: "0.1.0" },
      }),
    ).toThrow();
  });

  it("capabilities 是单个对象而不是数组时被拒", () => {
    // Python 侧镜像是 list[...]。TS 侧漏写 z.array() 时这一条会红，
    // 两端对同一份 wire 给出不同判定就是漂移。
    expect(() =>
      InitializeParams.parse({ ...legal, capabilities: legal.capabilities[0] }),
    ).toThrow();
  });

  it("空数组合法：一个能力都不可见是合法配置", () => {
    expect(() =>
      InitializeParams.parse({ ...legal, capabilities: [] }),
    ).not.toThrow();
  });

  it("description 为空串被拒", () => {
    expect(() =>
      InitializeParams.parse({
        ...legal,
        capabilities: [{ ...legal.capabilities[0], description: "" }],
      }),
    ).toThrow();
  });

  it("name 不在 CapabilityId 白名单里被拒", () => {
    expect(() =>
      InitializeParams.parse({
        ...legal,
        capabilities: [{ ...legal.capabilities[0], name: "filesystem.delete" }],
      }),
    ).toThrow();
  });
});
