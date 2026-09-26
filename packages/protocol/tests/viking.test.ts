import { describe, it, expect } from "vitest";
import {
  VikingReadL0Params,
  VikingReadL0Result,
  VikingReadL1Params,
  VikingReadL1Result,
  VikingReadL2Params,
  VikingReadL2Result,
  VikingWriteL2Params,
  VikingWriteL2Result,
} from "../schemas/viking.js";
import {
  CapabilityId,
  VIKING_READ_L0_CAPABILITY,
  VIKING_READ_L1_CAPABILITY,
  VIKING_READ_L2_CAPABILITY,
  VIKING_WRITE_L2_CAPABILITY,
} from "../schemas/host.js";

describe("Viking protocol schemas", () => {
  describe("Capability registration", () => {
    it("包含四个 Viking capability 枚举值", () => {
      expect(VIKING_READ_L0_CAPABILITY).toBe("viking_read_l0");
      expect(VIKING_READ_L1_CAPABILITY).toBe("viking_read_l1");
      expect(VIKING_READ_L2_CAPABILITY).toBe("viking_read_l2");
      expect(VIKING_WRITE_L2_CAPABILITY).toBe("viking_write_l2");

      expect(CapabilityId.options).toContain("viking_read_l0");
      expect(CapabilityId.options).toContain("viking_read_l1");
      expect(CapabilityId.options).toContain("viking_read_l2");
      expect(CapabilityId.options).toContain("viking_write_l2");
    });
  });

  describe("VikingReadL0 schemas", () => {
    it("解析合法 L0 参数与结果", () => {
      const params = VikingReadL0Params.parse({ uri: "viking://identity" });
      expect(params.uri).toBe("viking://identity");

      const result = VikingReadL0Result.parse({
        ok: true,
        uri: "viking://identity",
        abstractText: "用户核心偏好与画像摘要 #profile #pref #settings",
        isValid: true,
      });
      expect(result.ok).toBe(true);
      expect(result.abstractText).toContain("画像摘要");
      expect(result.isValid).toBe(true);
    });

    it("空 uri 校验失败", () => {
      expect(() => VikingReadL0Params.parse({ uri: "" })).toThrow();
    });
  });

  describe("VikingReadL1 schemas", () => {
    it("解析合法 L1 参数与结果", () => {
      const params = VikingReadL1Params.parse({ uri: "viking://projects" });
      expect(params.uri).toBe("viking://projects");

      const result = VikingReadL1Result.parse({
        ok: true,
        uri: "viking://projects",
        overviewText: "# 项目概览\n记录进行中的主要任务与背景。",
      });
      expect(result.ok).toBe(true);
      expect(result.overviewText).toContain("项目概览");
    });
  });

  describe("VikingReadL2 schemas", () => {
    it("解析合法 L2 参数与结果", () => {
      const params = VikingReadL2Params.parse({
        uri: "viking://identity/profile.md",
      });
      expect(params.uri).toBe("viking://identity/profile.md");

      const result = VikingReadL2Result.parse({
        ok: true,
        uri: "viking://identity/profile.md",
        content: "# 个人核心事实\n姓名: 张三\n时区: Asia/Shanghai",
      });
      expect(result.ok).toBe(true);
      expect(result.content).toContain("张三");
    });
  });

  describe("VikingWriteL2 schemas", () => {
    it("解析合法 L2 写入参数与结果", () => {
      const params = VikingWriteL2Params.parse({
        uri: "viking://knowledge/cpu/avx.md",
        content: "# AVX 指令集\n256位向量寄存器与运算说明。",
      });
      expect(params.uri).toBe("viking://knowledge/cpu/avx.md");
      expect(params.content).toContain("AVX 指令集");

      const result = VikingWriteL2Result.parse({
        ok: true,
        uri: "viking://knowledge/cpu/avx.md",
        bytesWritten: 128,
      });
      expect(result.ok).toBe(true);
      expect(result.bytesWritten).toBe(128);
    });

    it("负数字节数抛出错误", () => {
      expect(() =>
        VikingWriteL2Result.parse({
          ok: true,
          uri: "viking://test.md",
          bytesWritten: -5,
        })
      ).toThrow();
    });
  });
});
