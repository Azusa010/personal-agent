import * as z from "zod";

export const RootId = z.enum(["downloads", "download"]);

export const FilesystemListParams = z.object({
  rootId: RootId,
});

export const PdfEntry = z.object({
  name: z.string(),
  absolutePath: z.string(),
  modifiedAT: z.string(),
  sizeBytes: z.uint64(),
});

export const FilesystemListResult = z.object({
  entries: z.array(PdfEntry),
});
