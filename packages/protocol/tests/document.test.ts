import { describe, it, expect } from "vitest";

import {
  ReadDocumentParams,
  ReadDocumentResult,
  DocumentPage,
  ReadDocumentOutcome,
} from "../schemas/document.js";

/**
 * read_document 统一文档读取的 payload 级契约。
 *
 * envelope.test.ts 那套是 envelope 级的（按文件名前缀选 schema），
 * 这里校验的是 executor 拿来过滤模型输出的关口 —— SEC-006 要求
 * PDF 文本、模型输出和 Tool Result 全部视为不可信输入。
 */
describe("ReadDocumentParams", () => {
  it("接受合法参数并应用默认值", () => {
    const parsed = ReadDocumentParams.parse({ path: "reports/doc.pdf" });
    expect(parsed).toEqual({
      path: "reports/doc.pdf",
      fileType: "auto",
      pageStart: 1,
      maxCharsPerPage: 4000,
    });
  });

  it("接受自定义分页与文件类型", () => {
    const parsed = ReadDocumentParams.parse({
      path: "notes.docx",
      fileType: "docx",
      pageStart: 2,
      pageEnd: 10,
      maxCharsPerPage: 2000,
    });
    expect(parsed.fileType).toBe("docx");
    expect(parsed.pageStart).toBe(2);
    expect(parsed.pageEnd).toBe(10);
    expect(parsed.maxCharsPerPage).toBe(2000);
  });

  it("拒绝空 path 与非法 pageStart", () => {
    expect(ReadDocumentParams.safeParse({ path: "" }).success).toBe(false);
    expect(
      ReadDocumentParams.safeParse({ path: "a.pdf", pageStart: 0 }).success,
    ).toBe(false);
  });

  it("拒绝缺 path", () => {
    expect(ReadDocumentParams.safeParse({}).success).toBe(false);
  });

  it("不校验路径是否越界", () => {
    // 契约层只钉形状。绝对化、拒 `..`、确认在授权根内是 executor 的
    // path-guard 的职责；完整版（junction/symlink/UNC）属 Phase 2 TASK-017。
    // 这条钉住"契约层没有偷偷承担路径安全"，否则两处校验会各自演化。
    expect(
      ReadDocumentParams.safeParse({
        path: "../../../../etc/passwd",
      }).success,
    ).toBe(true);
  });
});

describe("DocumentPage", () => {
  it("接受合法页", () => {
    expect(DocumentPage.parse({ pageNumber: 1, text: "内容" })).toEqual({
      pageNumber: 1,
      text: "内容",
      truncated: false,
    });
  });

  it("接受空文本", () => {
    // 扫描件的页确实没有文本层，这是提取成功的结果，不是失败。
    // 收成 min(1) 会让每一页都校验不过，而真实语义由 PDF_NO_TEXT 错误码表达。
    expect(DocumentPage.safeParse({ pageNumber: 3, text: "" }).success).toBe(
      true,
    );
  });

  it("拒绝 pageNumber 为 0", () => {
    // PDF 页码从 1 开始。0 会让 SummaryVerifier（TASK-014）的页码存在性
    // 检查失去意义 —— 引用第 0 页既不算命中也不算越界。
    expect(
      DocumentPage.safeParse({ pageNumber: 0, text: "x" }).success,
    ).toBe(false);
  });

  it("拒绝负数与小数页码", () => {
    expect(DocumentPage.safeParse({ pageNumber: -1, text: "x" }).success).toBe(
      false,
    );
    expect(DocumentPage.safeParse({ pageNumber: 1.5, text: "x" }).success).toBe(
      false,
    );
  });
});

describe("ReadDocumentResult 与 Outcome", () => {
  it("接受带截断标记的分页响应", () => {
    const res = {
      ok: true as const,
      path: "a.pdf",
      totalPages: 10,
      returnedPages: 2,
      hasMore: true,
      nextPage: 3,
      pages: [
        { pageNumber: 1, text: "Page 1 content", truncated: false },
        { pageNumber: 2, text: "Page 2 content", truncated: true },
      ],
    };
    expect(ReadDocumentResult.safeParse(res).success).toBe(true);
    expect(ReadDocumentOutcome.safeParse(res).success).toBe(true);
  });

  it("失败分支支持 CapabilityFailure", () => {
    const fail = { ok: false as const, code: "FILE_UNREADABLE", reason: "Cannot read" };
    expect(ReadDocumentOutcome.safeParse(fail).success).toBe(true);
  });

  it("缺 ok 时拒绝，而不是猜一个分支", () => {
    // 判别联合没有判别键时 zod 会逐个分支试，报"哪个都不像"，
    // 错误现场离源头更远；这里只钉"必须显式给 ok"。
    expect(
      ReadDocumentOutcome.safeParse({
        pages: [{ pageNumber: 1, text: "x" }],
      }).success,
    ).toBe(false);
  });
});
