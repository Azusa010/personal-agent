import { describe, it, expect } from "vitest";

import {
  DocumentExtractPdfOutcome,
  DocumentExtractPdfParams,
  DocumentExtractPdfResult,
  PageText,
} from "../schemas/document.js";
import { CapabilityFailure } from "../schemas/host.js";

/**
 * document.extract_pdf 的 payload 级契约。
 *
 * envelope.test.ts 那套是 envelope 级的（按文件名前缀选 schema），
 * 这里校验的是 executor 拿来过滤模型输出的关口 —— SEC-006 要求
 * PDF 文本、模型输出和 Tool Result 全部视为不可信输入。
 */
describe("DocumentExtractPdfParams", () => {
  it("接受绝对路径", () => {
    expect(
      DocumentExtractPdfParams.parse({
        path: "D:/Users/demo/Downloads/report-2026.pdf",
      }),
    ).toEqual({ path: "D:/Users/demo/Downloads/report-2026.pdf" });
  });

  it("拒绝空 path", () => {
    // min(1) 挡的是模型给出空字符串。放过去的话 executor 会拿 '' 去
    // resolve，得到一个指向 cwd 的路径，然后读目录当文件。
    expect(DocumentExtractPdfParams.safeParse({ path: "" }).success).toBe(false);
  });

  it("拒绝缺 path", () => {
    expect(DocumentExtractPdfParams.safeParse({}).success).toBe(false);
  });

  it("拒绝非字符串 path", () => {
    expect(DocumentExtractPdfParams.safeParse({ path: 123 }).success).toBe(
      false,
    );
  });

  it("不校验路径是否越界", () => {
    // 契约层只钉形状。绝对化、拒 `..`、确认在授权根内是 executor 的
    // path-guard 的职责；完整版（junction/symlink/UNC）属 Phase 2 TASK-017。
    // 这条钉住"契约层没有偷偷承担路径安全"，否则两处校验会各自演化。
    expect(
      DocumentExtractPdfParams.safeParse({
        path: "../../../../etc/passwd",
      }).success,
    ).toBe(true);
  });
});

describe("PageText", () => {
  it("接受合法页", () => {
    expect(PageText.parse({ pageNumber: 1, text: "内容" })).toEqual({
      pageNumber: 1,
      text: "内容",
    });
  });

  it("接受空文本", () => {
    // 扫描件的页确实没有文本层，这是提取成功的结果，不是失败。
    // 收成 min(1) 会让每一页都校验不过，而真实语义由 PDF_NO_TEXT 错误码表达。
    expect(PageText.safeParse({ pageNumber: 3, text: "" }).success).toBe(true);
  });

  it("拒绝 pageNumber 为 0", () => {
    // PDF 页码从 1 开始。0 会让 SummaryVerifier（TASK-014）的页码存在性
    // 检查失去意义 —— 引用第 0 页既不算命中也不算越界。
    expect(PageText.safeParse({ pageNumber: 0, text: "x" }).success).toBe(false);
  });

  it("拒绝负数与小数页码", () => {
    expect(PageText.safeParse({ pageNumber: -1, text: "x" }).success).toBe(
      false,
    );
    expect(PageText.safeParse({ pageNumber: 1.5, text: "x" }).success).toBe(
      false,
    );
  });
});

describe("DocumentExtractPdfOutcome", () => {
  it("判别到成功分支", () => {
    const parsed = DocumentExtractPdfOutcome.parse({
      ok: true,
      pages: [{ pageNumber: 1, text: "PersonalAgent fixture page one" }],
    });
    expect(parsed.ok).toBe(true);
    // 判别联合收窄之后 pages 可访问；若 ok 用 boolean 而非 literal，
    // 这里拿不到 pages（两个分支都有 ok，联合分不开）
    if (parsed.ok) {
      expect(parsed.pages).toHaveLength(1);
    }
  });

  it("判别到失败分支", () => {
    const parsed = DocumentExtractPdfOutcome.parse({
      ok: false,
      code: "PDF_CORRUPT",
      reason: "PDF 结构损坏",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("PDF_CORRUPT");
    }
  });

  it("缺 ok 时拒绝，而不是猜一个分支", () => {
    // 实测 zod 4 报 invalid_union 且 path 精确指向 ['ok']。
    // 没有判别键的话 zod 会逐个分支试，报"哪个都不像"，错误现场离源头更远。
    const r = DocumentExtractPdfOutcome.safeParse({
      pages: [{ pageNumber: 1, text: "x" }],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["ok"]);
    }
  });

  it("成功分支缺 pages 时拒绝", () => {
    expect(
      DocumentExtractPdfOutcome.safeParse({ ok: true }).success,
    ).toBe(false);
  });

  it("失败分支的 code 不受枚举限制", () => {
    // code 是宽松字符串。收成枚举就得把 PDF_EMPTY / PDF_CORRUPT /
    // PDF_ENCRYPTED / PDF_NO_TEXT 搬进 protocol，契约层会变成业务错误码字典。
    expect(
      DocumentExtractPdfOutcome.safeParse({
        ok: false,
        code: "SOME_FUTURE_CODE",
        reason: "x",
      }).success,
    ).toBe(true);
  });
});

describe("DocumentExtractPdfResult 与 CapabilityFailure 互斥", () => {
  it("成功形状过不了失败 schema", () => {
    expect(
      CapabilityFailure.safeParse({
        ok: true,
        pages: [{ pageNumber: 1, text: "x" }],
      }).success,
    ).toBe(false);
  });

  it("失败形状过不了成功 schema", () => {
    expect(
      DocumentExtractPdfResult.safeParse({
        ok: false,
        code: "PDF_CORRUPT",
        reason: "x",
      }).success,
    ).toBe(false);
  });
});
