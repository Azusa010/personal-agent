import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  A2UIComponentType,
  A2UIActionType,
  A2UIAction,
  A2UIComponent,
  A2UIDocument,
  A2UIRenderParams,
  A2UIRenderResult,
  A2UIRenderOutcome,
  A2UIFormSubmitParams,
  A2UIFormSubmitResult,
  A2UIFormSubmitOutcome,
  normalizeA2UIRenderParams,
} from "../schemas/a2ui.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "..", "fixtures");

function loadFixture(filename: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, filename), "utf-8"));
}

describe("A2UI 协议契约 (TASK-D1)", () => {
  describe("A2UIComponentType 白名单", () => {
    const expectedTypes = [
      // 输入组件 (10)
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
      // 展示组件 (8)
      "heading",
      "paragraph",
      "code_block",
      "table",
      "chart",
      "image",
      "divider",
      "alert",
      // 布局组件 (5)
      "form",
      "card",
      "tabs",
      "grid",
      "accordion",
    ] as const;

    it("精准包含全部 23 种受信组件类型", () => {
      expect(A2UIComponentType.options).toHaveLength(23);
      for (const t of expectedTypes) {
        expect(A2UIComponentType.options).toContain(t);
        expect(A2UIComponentType.parse(t)).toBe(t);
      }
    });

    it("拒绝未知或恶意组件类型", () => {
      expect(() => A2UIComponentType.parse("script")).toThrow();
      expect(() => A2UIComponentType.parse("iframe")).toThrow();
      expect(() => A2UIComponentType.parse("webview")).toThrow();
      expect(() => A2UIComponentType.parse("custom_exec")).toThrow();
    });
  });

  describe("A2UIActionType 与 A2UIAction", () => {
    it("接受合法动作类型与属性", () => {
      expect(A2UIActionType.options).toEqual(["submit", "cancel", "navigate"]);

      const act1 = A2UIAction.parse({
        id: "submit-btn",
        label: "提交配置",
        type: "submit",
        variant: "primary",
      });
      expect(act1.id).toBe("submit-btn");
      expect(act1.type).toBe("submit");

      const act2 = A2UIAction.parse({
        id: "nav-docs",
        label: "查看文档",
        type: "navigate",
        target: "https://example.com/docs",
      });
      expect(act2.type).toBe("navigate");
      expect(act2.target).toBe("https://example.com/docs");
    });

    it("拒绝非法或空动作定义", () => {
      expect(() =>
        A2UIAction.parse({
          id: "",
          label: "空 ID",
          type: "submit",
        }),
      ).toThrow();

      expect(() =>
        A2UIAction.parse({
          id: "act-1",
          label: "",
          type: "submit",
        }),
      ).toThrow();

      expect(() =>
        A2UIAction.parse({
          id: "act-1",
          label: "执行",
          type: "unknown_action",
        }),
      ).toThrow();
    });
  });

  describe("A2UIComponent 组件树与递归", () => {
    it("正确解析扁平组件", () => {
      const comp = A2UIComponent.parse({
        type: "heading",
        id: "h-title",
        props: { text: "页面标题", level: 1 },
      });
      expect(comp.type).toBe("heading");
      expect(comp.id).toBe("h-title");
      expect(comp.props).toEqual({ text: "页面标题", level: 1 });
      expect(comp.children).toBeUndefined();
    });

    it("props 缺省时自动默认为空对象", () => {
      const comp = A2UIComponent.parse({
        type: "divider",
        id: "div-1",
      });
      expect(comp.props).toEqual({});
    });

    it("支持多层递归嵌套 children", () => {
      const nested = A2UIComponent.parse({
        type: "card",
        id: "card-root",
        props: { title: "根卡片" },
        children: [
          {
            type: "form",
            id: "form-inner",
            children: [
              {
                type: "text_input",
                id: "input-name",
                props: { label: "姓名", placeholder: "请输入" },
              },
            ],
          },
        ],
      });
      expect(nested.children).toHaveLength(1);
      expect(nested.children?.[0].type).toBe("form");
      expect(nested.children?.[0].children?.[0].type).toBe("text_input");
    });

    it("拒绝非法嵌套与无效类型", () => {
      expect(() =>
        A2UIComponent.parse({
          type: "card",
          id: "card-1",
          children: [
            {
              type: "invalid_child_type",
              id: "bad-1",
            },
          ],
        }),
      ).toThrow();
    });
  });

  describe("A2UIDocument 文档根契约", () => {
    it("正确解析完整 A2UIDocument 并默认 version 为 1.0", () => {
      const doc = A2UIDocument.parse({
        title: "配置表单",
        components: [{ type: "divider", id: "d-1" }],
        actions: [{ id: "ok", label: "确定", type: "submit" }],
      });
      expect(doc.version).toBe("1.0");
      expect(doc.title).toBe("配置表单");
      expect(doc.components).toHaveLength(1);
      expect(doc.actions).toHaveLength(1);
    });

    it("版本号严格限定为 1.0", () => {
      expect(() =>
        A2UIDocument.parse({
          version: "2.0",
          components: [],
        }),
      ).toThrow();
    });
  });

  describe("a2ui_render 与 a2ui_form_submit 入参及出参契约", () => {
    it("A2UIRenderParams 支持 document 字段或平铺组件", () => {
      const p1 = A2UIRenderParams.parse({
        document: {
          version: "1.0",
          components: [
            { type: "paragraph", id: "p-1", props: { text: "段落" } },
          ],
        },
      });
      expect(p1.document?.components).toHaveLength(1);

      const normalized1 = normalizeA2UIRenderParams(p1);
      expect(normalized1.version).toBe("1.0");
      expect(normalized1.components).toHaveLength(1);

      const p2 = A2UIRenderParams.parse({
        title: "平铺标题",
        components: [{ type: "divider", id: "div-flat" }],
        actions: [{ id: "sub", label: "提交", type: "submit" }],
      });
      expect(p2.components).toHaveLength(1);

      const normalized2 = normalizeA2UIRenderParams(p2);
      expect(normalized2.title).toBe("平铺标题");
      expect(normalized2.components).toHaveLength(1);
      expect(normalized2.actions).toHaveLength(1);
    });

    it("A2UIRenderParams 在两者皆空时拒绝", () => {
      expect(() => A2UIRenderParams.parse({})).toThrow();
      expect(() => A2UIRenderParams.parse({ components: [] })).toThrow();
    });

    it("A2UIRenderResult 与 Outcome 校验", () => {
      const res = A2UIRenderResult.parse({
        ok: true,
        renderId: "r-123",
        componentCount: 3,
      });
      expect(res.ok).toBe(true);
      expect(res.renderId).toBe("r-123");

      const outcomeSuccess = A2UIRenderOutcome.parse(res);
      expect(outcomeSuccess.ok).toBe(true);

      const outcomeFailure = A2UIRenderOutcome.parse({
        ok: false,
        code: "INVALID_ARGUMENT",
        reason: "组件格式不合法",
      });
      expect(outcomeFailure.ok).toBe(false);
    });

    it("A2UIFormSubmitParams 与 Result 校验", () => {
      const submitParams = A2UIFormSubmitParams.parse({
        renderId: "r-123",
        actionId: "submit",
        formData: { choice: "option-a" },
      });
      expect(submitParams.actionId).toBe("submit");
      expect(submitParams.formData).toEqual({ choice: "option-a" });

      const submitResult = A2UIFormSubmitResult.parse({
        ok: true,
        actionId: "submit",
        formData: { choice: "option-a" },
        accepted: true,
      });
      expect(submitResult.accepted).toBe(true);

      const outcome = A2UIFormSubmitOutcome.parse(submitResult);
      expect(outcome.ok).toBe(true);
    });
  });

  describe("A2UI Fixture 真实样本验证", () => {
    it("正确加载并校验 a2ui-document.form.json", () => {
      const raw = loadFixture("a2ui-document.form.json");
      const doc = A2UIDocument.parse(raw);
      expect(doc.version).toBe("1.0");
      expect(doc.title).toBe("重构配置表单");
      expect(doc.components).toHaveLength(1);

      const root = doc.components[0];
      expect(root.type).toBe("card");
      expect(root.id).toBe("card-config");
      expect(root.children).toHaveLength(5);

      const childTypes = root.children?.map((c) => c.type);
      expect(childTypes).toEqual([
        "heading",
        "paragraph",
        "multi_select",
        "radio_group",
        "checkbox",
      ]);

      expect(doc.actions).toHaveLength(2);
      expect(doc.actions?.[0].type).toBe("submit");
      expect(doc.actions?.[1].type).toBe("cancel");
    });

    it("正确加载并校验 a2ui-document.dashboard.json", () => {
      const raw = loadFixture("a2ui-document.dashboard.json");
      const doc = A2UIDocument.parse(raw);
      expect(doc.version).toBe("1.0");
      expect(doc.title).toBe("系统监控仪表盘");
      expect(doc.components).toHaveLength(2);
      expect(doc.components[0].type).toBe("alert");
      expect(doc.components[1].type).toBe("tabs");
      expect(doc.components[1].children).toHaveLength(3);

      const tabChildTypes = doc.components[1].children?.map((c) => c.type);
      expect(tabChildTypes).toEqual(["chart", "table", "code_block"]);
    });

    it("正确加载并校验 a2ui-form-submit.json", () => {
      const raw = loadFixture("a2ui-form-submit.json");
      const submit = A2UIFormSubmitParams.parse(raw);
      expect(submit.renderId).toBe("render-refactor-001");
      expect(submit.actionId).toBe("submit");
      expect(submit.formData).toHaveProperty("strategy", "提取接口");
      expect(submit.formData).toHaveProperty("run_tests", true);
    });

    it("正确加载并校验 a2ui-render.result.json", () => {
      const raw = loadFixture("a2ui-render.result.json");
      const res = A2UIRenderResult.parse(raw);
      expect(res.ok).toBe(true);
      expect(res.renderId).toBe("render-refactor-001");
      expect(res.componentCount).toBe(5);
    });
  });
});
