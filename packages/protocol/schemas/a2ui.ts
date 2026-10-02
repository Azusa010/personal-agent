import * as z from "zod";
import { CapabilityFailure } from "./host";

/**
 * A2UI (Agent-to-UI) 组件类型白名单 (23 种受信组件)
 * 划分为：输入组件、展示组件、布局组件
 */
export const A2UIComponentType = z.enum([
  // --- 输入组件 (10) ---
  "text_input", // 单行文本输入
  "textarea", // 多行文本输入
  "number_input", // 数字输入
  "select", // 下拉选择
  "multi_select", // 多选
  "checkbox", // 复选框
  "radio_group", // 单选组
  "date_picker", // 日期选择
  "file_picker", // 文件选择
  "slider", // 滑块
  // --- 展示组件 (8) ---
  "heading", // 标题
  "paragraph", // 段落文本
  "code_block", // 代码块
  "table", // 数据表格
  "chart", // 图表（柱/线/饼）
  "image", // 图片展示
  "divider", // 分割线
  "alert", // 提示/警告
  // --- 布局组件 (5) ---
  "form", // 表单容器
  "card", // 卡片容器
  "tabs", // 选项卡
  "grid", // 网格布局
  "accordion", // 折叠面板
]);
export type A2UIComponentType = z.infer<typeof A2UIComponentType>;

export const A2UI_INPUT_COMPONENT_TYPES = new Set<A2UIComponentType>([
  "text_input",
  "textarea",
  "number_input",
  "select",
  "multi_select",
  "checkbox",
  "radio_group",
  "date_picker",
  "file_picker",
  "slider",
]);

/**
 * A2UI 动作类型
 */
export const A2UIActionType = z.enum(["submit", "cancel", "navigate"]);
export type A2UIActionType = z.infer<typeof A2UIActionType>;

/**
 * A2UI 交互动作按钮定义
 */
export const A2UIAction = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: A2UIActionType,
  variant: z.string().optional(),
  target: z.string().optional(),
});
export type A2UIAction = z.infer<typeof A2UIAction>;

/**
 * A2UI 组件树结构定义（支持递归嵌套 children）
 */
export interface A2UIComponent {
  type: A2UIComponentType;
  id: string;
  props?: Record<string, unknown>;
  children?: A2UIComponent[];
}

export const A2UIComponent: z.ZodType<A2UIComponent> = z.lazy(() =>
  z.object({
    type: A2UIComponentType,
    id: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional().default({}),
    children: z.array(A2UIComponent).optional(),
  }),
);

/**
 * A2UI 完整文档结构协议
 */
export const A2UIDocument = z.object({
  version: z.literal("1.0").default("1.0"),
  title: z.string().optional(),
  components: z.array(A2UIComponent),
  actions: z.array(A2UIAction).optional(),
});
export type A2UIDocument = z.infer<typeof A2UIDocument>;

/**
 * a2ui_render 能力入参契约
 * 兼容直接传 document 或平铺传 title/components/actions
 */
export const A2UIRenderParams = z
  .object({
    document: A2UIDocument.optional(),
    version: z.literal("1.0").optional().default("1.0"),
    title: z.string().optional(),
    components: z.array(A2UIComponent).optional(),
    actions: z.array(A2UIAction).optional(),
  })
  .refine(
    (data) => {
      if (data.document !== undefined) {
        return data.document.components.length > 0;
      }
      return data.components !== undefined && data.components.length > 0;
    },
    { message: "Either document or non-empty components must be provided" },
  );
export type A2UIRenderParams = z.infer<typeof A2UIRenderParams>;

/**
 * 归一化 A2UIRenderParams 为标准 A2UIDocument
 */
export function normalizeA2UIRenderParams(
  params: A2UIRenderParams,
): A2UIDocument {
  if (params.document) {
    return params.document;
  }
  return {
    version: params.version ?? "1.0",
    title: params.title,
    components: params.components ?? [],
    actions: params.actions,
  };
}

/**
 * a2ui_render 执行结果契约
 */
export const A2UIRenderResult = z.object({
  ok: z.literal(true),
  renderId: z.string().min(1),
  componentCount: z.number().int().nonnegative(),
  actionId: z.string().optional(),
  formData: z.record(z.string(), z.unknown()).optional(),
});
export type A2UIRenderResult = z.infer<typeof A2UIRenderResult>;

export const A2UIRenderOutcome = z.discriminatedUnion("ok", [
  A2UIRenderResult,
  CapabilityFailure,
]);
export type A2UIRenderOutcome = z.infer<typeof A2UIRenderOutcome>;

/**
 * 用户表单提交入参契约 (IPC / a2ui_form_submit)
 */
export const A2UIFormSubmitParams = z.object({
  renderId: z.string().min(1).optional(),
  actionId: z.string().min(1),
  formData: z.record(z.string(), z.unknown()).default({}),
});
export type A2UIFormSubmitParams = z.infer<typeof A2UIFormSubmitParams>;

/**
 * 用户表单提交处理结果契约
 */
export const A2UIFormSubmitResult = z.object({
  ok: z.literal(true),
  actionId: z.string().min(1),
  formData: z.record(z.string(), z.unknown()).default({}),
  accepted: z.boolean().default(true),
});
export type A2UIFormSubmitResult = z.infer<typeof A2UIFormSubmitResult>;

export const A2UIFormSubmitOutcome = z.discriminatedUnion("ok", [
  A2UIFormSubmitResult,
  CapabilityFailure,
]);
export type A2UIFormSubmitOutcome = z.infer<typeof A2UIFormSubmitOutcome>;
