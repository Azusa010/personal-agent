import * as z from "zod";
import { CapabilityFailure } from "./host";


export const DocumentExtractPdfParams = z.object({
    path: z.string().min(1),
})

export type DocumentExtractPdfParams = z.infer<typeof DocumentExtractPdfParams>

export const PageText = z.object({
    pageNumber: z.int().positive(),
    text: z.string(),
})

export type PageText = z.infer<typeof PageText>

export const DocumentExtractPdfResult = z.object({
    ok: z.literal(true),
    pages: z.array(PageText),
})

export type DocumentExtractPdfResult = z.infer<typeof DocumentExtractPdfResult>

export const DocumentExtractPdfOutcome = z.discriminatedUnion("ok", [
  DocumentExtractPdfResult,
  CapabilityFailure,
]);

export type DocumentExtractPdfOutcome = z.infer<typeof DocumentExtractPdfOutcome>
