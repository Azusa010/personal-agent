import * as z from "zod";
import { CapabilityFailure } from "./host";

export const DocumentExtractPdfParams = z.object({
  path: z.string().min(1),
});

export type DocumentExtractPdfParams = z.infer<typeof DocumentExtractPdfParams>;

export const PageText = z.object({
  pageNumber: z.number().int().positive(),
  text: z.string(),
});

export type PageText = z.infer<typeof PageText>;

export const DocumentExtractPdfResult = z.object({
  ok: z.literal(true),
  pages: z.array(PageText),
});

export type DocumentExtractPdfResult = z.infer<typeof DocumentExtractPdfResult>;

export const DocumentExtractPdfOutcome = z.discriminatedUnion("ok", [
  DocumentExtractPdfResult,
  CapabilityFailure,
]);

export type DocumentExtractPdfOutcome = z.infer<typeof DocumentExtractPdfOutcome>;

// ---------- 现代化 read_document 统一文档读取规范 ----------

export const DocumentFileType = z.enum(["auto", "pdf", "docx", "pptx", "xlsx", "text"]);
export type DocumentFileType = z.infer<typeof DocumentFileType>;

export const ReadDocumentParams = z.object({
  path: z.string().min(1),
  fileType: DocumentFileType.default("auto"),
  pageStart: z.number().int().positive().default(1),
  pageEnd: z.number().int().positive().optional(),
  maxCharsPerPage: z.number().int().positive().default(4000),
});

export type ReadDocumentParams = z.infer<typeof ReadDocumentParams>;

export const DocumentPage = z.object({
  pageNumber: z.number().int().positive(),
  text: z.string(),
  truncated: z.boolean().default(false),
});

export type DocumentPage = z.infer<typeof DocumentPage>;

export const ReadDocumentResult = z.object({
  ok: z.literal(true),
  path: z.string().optional(),
  totalPages: z.number().int().nonnegative(),
  returnedPages: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextPage: z.number().int().positive().optional().nullable(),
  pages: z.array(DocumentPage),
});

export type ReadDocumentResult = z.infer<typeof ReadDocumentResult>;

export const ReadDocumentOutcome = z.discriminatedUnion("ok", [
  ReadDocumentResult,
  CapabilityFailure,
]);

export type ReadDocumentOutcome = z.infer<typeof ReadDocumentOutcome>;
