import * as z from "zod";

export const RootId = z.enum(["downloads"]);

export const FilesystemListParams = z.object({
  rootId: RootId,
});

export const PdfEntry = z.object({
  name: z.string(),
  absolutePath: z.string(),
  modifiedAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const FilesystemListResult = z.object({
  entries: z.array(PdfEntry),
});
