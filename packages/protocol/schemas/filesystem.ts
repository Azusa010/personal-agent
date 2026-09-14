import * as z from "zod";
import { CapabilityFailure } from "./host";

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

// create_dir 幂等：目录已存在不算失败，用 created 区分「本次新建」与「本就存在」。
export const FilesystemCreateDirResult = z.object({
  ok: z.literal(true),
  // realpath 规范化后的目录绝对路径（正斜杠），与 bound.paths['path'] 同源。
  path: z.string().min(1),
  created: z.boolean(),
});

export type FilesystemCreateDirResult = z.infer<typeof FilesystemCreateDirResult>

export const FilesystemCreateDirOutcome = z.discriminatedUnion("ok", [
  FilesystemCreateDirResult,
  CapabilityFailure,
]);

export type FilesystemCreateDirOutcome = z.infer<typeof FilesystemCreateDirOutcome>

// move 不幂等：target 已存在直接拒（MOVE_TARGET_EXISTS），成功即移动完成。
export const FilesystemMoveResult = z.object({
  ok: z.literal(true),
  // 两个都是 realpath 后的绝对路径，与 bound.paths 的 source/target 同源。
  source: z.string().min(1),
  target: z.string().min(1),
});

export type FilesystemMoveResult = z.infer<typeof FilesystemMoveResult>

export const FilesystemMoveOutcome = z.discriminatedUnion("ok", [
  FilesystemMoveResult,
  CapabilityFailure,
]);

export type FilesystemMoveOutcome = z.infer<typeof FilesystemMoveOutcome>

