import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Request, Response } from "../schemas/envelope.js";
import { InitializeParams, InitializeResult } from "../schemas/systems.js";

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
      if (file.startsWith("request-")) {
        expect(() => Request.parse(raw)).toThrow();
      } else if (file.startsWith("response-")) {
        expect(() => Response.parse(raw)).toThrow();
      }
    });
  }
});
