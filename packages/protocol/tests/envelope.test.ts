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
