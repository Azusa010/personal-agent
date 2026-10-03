/**
 * 配对比较两份 eval 报告（模型选型口径，第七章）：
 *
 *   node scripts/eval-compare.mjs tests/evals/reports/live-A.json tests/evals/reports/live-B.json
 *
 * 只统计两边都跑过的 case，逐条配对；双过/双挂的对子不携带分辨信息，
 * 结论看独赢对子。不一致的对子 < 5 时差异在噪声带宽内——先扩 case 再下结论。
 */
import { readFileSync } from "node:fs";

function loadReport(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.cases) || !raw.metrics) {
    throw new Error(`${path} 不是 eval 报告（缺 cases 或 metrics）`);
  }
  return raw;
}

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error(
    "用法: node scripts/eval-compare.mjs <报告A.json> <报告B.json>",
  );
  process.exit(2);
}

const a = loadReport(aPath);
const b = loadReport(bPath);
const ok = (report, id) => {
  const found = report.cases.find((c) => c.id === id);
  return found === undefined ? undefined : found.reasons.length === 0;
};

const ids = [
  ...new Set([...a.cases.map((c) => c.id), ...b.cases.map((c) => c.id)]),
].sort();
const aWins = [];
const bWins = [];
const unpaired = [];
let bothPass = 0;
let bothFail = 0;

for (const id of ids) {
  const aOk = ok(a, id);
  const bOk = ok(b, id);
  if (aOk === undefined || bOk === undefined) {
    unpaired.push(id);
  } else if (aOk && !bOk) aWins.push(id);
  else if (!aOk && bOk) bWins.push(id);
  else if (aOk) bothPass += 1;
  else bothFail += 1;
}

const discordant = aWins.length + bWins.length;
console.log(
  `配对比较（配对 ${ids.length - unpaired.length} 条${unpaired.length > 0 ? `，未配对 ${unpaired.length}: ${unpaired.join(", ")}` : ""}）`,
);
console.log(`A = ${a.model ?? aPath}`);
console.log(`B = ${b.model ?? bPath}`);
console.log(`A 独赢 ${aWins.length}: ${aWins.join(", ") || "—"}`);
console.log(`B 独赢 ${bWins.length}: ${bWins.join(", ") || "—"}`);
console.log(`双过 ${bothPass}｜双挂 ${bothFail}`);
console.log(
  discordant < 5
    ? "⚠ 不一致的对子 < 5：差异在噪声带宽内，别据此换模型（扩 case 或多跑几轮）"
    : `不一致对子 ${discordant} 个，超出噪声下限，可结合分维度 rates 定夺`,
);
for (const [label, report] of [
  ["A", a],
  ["B", b],
]) {
  const g = report.metrics.byType ?? {};
  const parts = Object.keys(g)
    .sort()
    .map((t) => `${t} ${g[t].fullSuccess}/${g[t].cases}`);
  console.log(
    `${label} 成功率 ${(report.metrics.successRate * 100).toFixed(1)}%${parts.length > 0 ? `（${parts.join("｜")}）` : ""}`,
  );
}
