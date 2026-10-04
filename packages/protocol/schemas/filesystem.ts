import * as z from "zod";
import { CapabilityFailure } from "./host";

export const RootId = z.enum(["downloads", "workspace"]);
export type RootId = z.infer<typeof RootId>;

export const FilesystemListParams = z.object({
  rootId: RootId,
  path: z.string().optional(),
  pattern: z.string().optional(),
});

export const EntryType = z.enum(["file", "directory"]);
export type EntryType = z.infer<typeof EntryType>;

export const PdfEntry = z.object({
  name: z.string(),
  absolutePath: z.string(),
  modifiedAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  type: EntryType.optional(),
});

export type PdfEntry = z.infer<typeof PdfEntry>;

export const FilesystemListResult = z.object({
  entries: z.array(PdfEntry),
});

// 创建目录参数
export const FilesystemCreateDirParams = z.object({
  path: z.string().min(1),
  // --- expected_* 审计参数（可选）---
  expected_parent_exists: z.boolean().optional(),
});

export type FilesystemCreateDirParams = z.infer<
  typeof FilesystemCreateDirParams
>;

// 字段名与 PermissionRecord 的 sourcePaths / targetPath 对齐
export const FilesystemMoveParams = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  // --- expected_* 审计参数（可选）---
  expected_source_exists: z.boolean().optional(),
  expected_source_is_file: z.boolean().optional(),
  expected_target_dir_exists: z.boolean().optional(),
});

export type FilesystemMoveParams = z.infer<typeof FilesystemMoveParams>;

// create_dir 幂等：目录已存在不算失败，用 created 区分「本次新建」与「本就存在」。
export const FilesystemCreateDirResult = z.object({
  ok: z.literal(true),
  // realpath 规范化后的目录绝对路径（正斜杠），与 bound.paths['path'] 同源。
  path: z.string().min(1),
  created: z.boolean(),
});

export type FilesystemCreateDirResult = z.infer<
  typeof FilesystemCreateDirResult
>;

export const FilesystemCreateDirOutcome = z.discriminatedUnion("ok", [
  FilesystemCreateDirResult,
  CapabilityFailure,
]);

export type FilesystemCreateDirOutcome = z.infer<
  typeof FilesystemCreateDirOutcome
>;

// move 不幂等：target 已存在直接拒（MOVE_TARGET_EXISTS），成功即移动完成。
export const FilesystemMoveResult = z.object({
  ok: z.literal(true),
  // 两个都是 realpath 后的绝对路径，与 bound.paths 的 source/target 同源。
  source: z.string().min(1),
  target: z.string().min(1),
});

export type FilesystemMoveResult = z.infer<typeof FilesystemMoveResult>;

export const FilesystemMoveOutcome = z.discriminatedUnion("ok", [
  FilesystemMoveResult,
  CapabilityFailure,
]);

export type FilesystemMoveOutcome = z.infer<typeof FilesystemMoveOutcome>;

// ---------- file_read ----------
export const FileReadParams = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});
export type FileReadParams = z.infer<typeof FileReadParams>;

export const FileReadResult = z.object({
  ok: z.literal(true),
  path: z.string().min(1),
  content: z.string(),
  totalLines: z.number().int().nonnegative(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});
export type FileReadResult = z.infer<typeof FileReadResult>;

export const FileReadOutcome = z.discriminatedUnion("ok", [
  FileReadResult,
  CapabilityFailure,
]);
export type FileReadOutcome = z.infer<typeof FileReadOutcome>;

// ---------- file_write ----------
export const FileWriteParams = z.object({
  path: z.string().min(1),
  content: z.string(),
  // --- expected_* 审计参数（可选）---
  expected_file_exists: z.boolean().optional(),
});
export type FileWriteParams = z.infer<typeof FileWriteParams>;

export const FileWriteResult = z.object({
  ok: z.literal(true),
  path: z.string().min(1),
  bytesWritten: z.number().int().nonnegative(),
  diagnostics: z.array(z.string()).optional(),
});
export type FileWriteResult = z.infer<typeof FileWriteResult>;

export const FileWriteOutcome = z.discriminatedUnion("ok", [
  FileWriteResult,
  CapabilityFailure,
]);
export type FileWriteOutcome = z.infer<typeof FileWriteOutcome>;

// ---------- file_edit ----------
export const FileEditParams = z.object({
  path: z.string().min(1),
  oldString: z.string().min(1),
  newString: z.string(),
  // --- expected_* 审计参数（可选）---
  expected_file_line_count: z.number().int().positive().optional(),
  expected_old_string_line: z.number().int().positive().optional(),
});
export type FileEditParams = z.infer<typeof FileEditParams>;

export const FileEditResult = z.object({
  ok: z.literal(true),
  path: z.string().min(1),
  replacements: z.number().int().positive().default(1),
  diagnostics: z.array(z.string()).optional(),
});
export type FileEditResult = z.infer<typeof FileEditResult>;

export const FileEditOutcome = z.discriminatedUnion("ok", [
  FileEditResult,
  CapabilityFailure,
]);
export type FileEditOutcome = z.infer<typeof FileEditOutcome>;
