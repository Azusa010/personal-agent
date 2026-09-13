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

export type PdfEntry = z.infer<typeof PdfEntry>

export const FilesystemListResult = z.object({
  entries: z.array(PdfEntry),
});

// 创建目录参数
export const FilesystemCreateDirParams = z.object({
  path: z.string().min(1),
});

export type FilesystemCreateDirParams = z.infer<typeof FilesystemCreateDirParams>

// 字段名与 PermissionRecord 的 sourcePaths / targetPath 对齐
export const FilesystemMoveParams = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});

export type FilesystemMoveParams = z.infer<typeof FilesystemMoveParams>

