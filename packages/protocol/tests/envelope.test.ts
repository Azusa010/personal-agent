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
} from "../schemas/host.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures");

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
  {
    file: "filesystem-list.request.json",
    envelope: Request,
    payload: FilesystemListParams,
    field: "params",
  },
  {
    file: "filesystem-list.response.json",
    envelope: Response,
    payload: FilesystemListResult,
    field: "result",
  },
  {
    file: "host-execute-tool.request.json",
    envelope: HostExecuteToolRequest,
    payload: HostExecuteToolParams,
    field: "params",
  },
  // result 的具体形状不在契约层校验（只钉 ok），所以 payload 给 null。
  // 六个 capability 返回形状各异，穷举会让 protocol 包退化成业务字典。
  {
    file: "host-execute-tool.response.json",
    envelope: HostExecuteToolResponse,
    payload: null,
    field: "result",
  },
  {
    file: "host-execute-tool.failure.response.json",
    envelope: HostExecuteToolResponse,
    payload: null,
    field: "result",
  },
];

describe("协议契约：合法 Fixture 必须被接受", () => {
  for (const c of legalCases) {
    it(`接受${c.file}`, () => {
      const raw = JSON.parse(readFileSync(join(fixturesDir, c.file), "utf-8"));
      expect(() => c.envelope.parse(raw)).not.toThrow();
      if (c.payload) {
        expect(() => c.payload.parse(raw[c.field])).not.toThrow();
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
      readFileSync(join(fixturesDir, "host-execute-tool.request.json"), "utf-8"),
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
