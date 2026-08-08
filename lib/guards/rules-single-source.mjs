/**
 * 规则单一真身守卫：AGENTS.md 与 CLAUDE.md 必须是「一份真身＋一块门牌」。
 *
 * 防的坑：两份规则文件各自演化，不同 agent 读到互相矛盾的规矩，行为全看运气。
 *
 * 认可的形态（满足其一即可）：
 * - 推荐：AGENTS.md 为真身，CLAUDE.md 是指向它的软链，或内容仅为一行 `@AGENTS.md` 导入
 *   （@ 导入是 Claude Code 官方语法，Windows 上比软链稳）；
 * - 兼容：CLAUDE.md 为真身，AGENTS.md 是指向它的软链（存量项目的反向形态）。
 */

import fs from "node:fs";
import path from "node:path";

function isImportStub(text, target) {
  // 门牌只允许注释和唯一一行导入。无标题的命令同样是规则正文，不能混进来。
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const lines = withoutComments
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0] === `@${target}`;
}

function linkTarget(ctx, rel) {
  const stat = ctx.lstat(rel);
  if (!stat || !stat.isSymbolicLink()) return null;
  return fs.readlinkSync(path.join(ctx.root, rel));
}

function declaresBossCoding(ctx) {
  if (!ctx.exists("package.json")) return false;
  try {
    const pkg = JSON.parse(ctx.readText("package.json"));
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(
      (name) => name === "bosscoding" || name.endsWith("/bosscoding"),
    );
  } catch {
    // package.json 是否合法由它自己的工具负责；本守卫只判断规则有没有真的装上。
    return false;
  }
}

function hasBossCodingRules(text) {
  // 干活流程和红线不可缺；官方模板靠稳定标记认身份，手工合并的存量项目靠导师模式认身份。
  // 老板本身是开发者时，模板允许删掉导师模式，所以官方标记与导师标题满足其一即可。
  const hasWorkflow = text.includes("## 干活流程");
  const hasRedlines = text.includes("## 红线");
  const hasMarker =
    text.includes("<!-- bosscoding:intro-start -->") &&
    text.includes("<!-- bosscoding:intro-end -->");
  return hasWorkflow && hasRedlines && (hasMarker || text.includes("## 导师模式"));
}

export default {
  name: "rules-single-source",
  title: "规则只有一份真身",
  run(ctx) {
    const problems = [];
    const hasAgents = ctx.exists("AGENTS.md");
    const hasClaude = ctx.exists("CLAUDE.md");

    if (!hasAgents) {
      problems.push({
        file: "AGENTS.md",
        msg: "缺少 AGENTS.md（各家 coding agent 共同认的规则文件）",
        fix: "运行 npx bosscoding init 生成规则文件；已有规则写在 CLAUDE.md 的话，把它重命名为 AGENTS.md，再让 CLAUDE.md 指回来。",
      });
      return problems;
    }

    // 实测事故：已有一份普通 AGENTS.md 时，旧 init 会因「文件存在」跳过，
    // 却把其余资产装齐并宣布就位；随后本守卫只看两份文件有没有分叉，竟然全绿。
    if (declaresBossCoding(ctx) && !hasBossCodingRules(ctx.readText("AGENTS.md"))) {
      problems.push({
        file: "AGENTS.md",
        msg: "项目声明安装了 BossCoding，但 AGENTS.md 里没有它的核心规则；工具装了，AI 却没收到工作制度",
        fix: "让 AI 对照 node_modules/bosscoding/templates/AGENTS.template.md，把 BossCoding 核心规则合并进 AGENTS.md，并保留你原有的规则。",
      });
    }

    const agentsIsLink = ctx.lstat("AGENTS.md")?.isSymbolicLink() ?? false;

    if (!hasClaude) {
      problems.push({
        file: "CLAUDE.md",
        msg: "缺少 CLAUDE.md 门牌，Claude Code（含套壳接国产模型的用户）读不到规则",
        fix: "创建 CLAUDE.md，内容一行 `@AGENTS.md`（npx bosscoding init 会自动生成）。",
      });
      return problems;
    }

    // 形态 A：AGENTS.md 真身。
    if (!agentsIsLink) {
      const claudeStat = ctx.lstat("CLAUDE.md");
      if (claudeStat.isSymbolicLink()) {
        const target = linkTarget(ctx, "CLAUDE.md");
        if (target !== "AGENTS.md") {
          problems.push({
            file: "CLAUDE.md",
            msg: `软链指向 ${target}，不是 AGENTS.md`,
            fix: "把 CLAUDE.md 重建为指向 AGENTS.md 的软链，或改为内容仅一行 `@AGENTS.md` 的文件。",
          });
        }
        return problems;
      }
      if (!isImportStub(ctx.readText("CLAUDE.md"), "AGENTS.md")) {
        problems.push({
          file: "CLAUDE.md",
          msg: "与 AGENTS.md 各自有正文——两份规则必然分叉",
          fix: "选一份当真身（推荐 AGENTS.md），把另一份的独有内容合并过去，然后让 CLAUDE.md 只留一行 `@AGENTS.md`。",
        });
      }
      return problems;
    }

    // 形态 B（兼容存量）：AGENTS.md 是软链，则它必须指向 CLAUDE.md 真身。
    const target = linkTarget(ctx, "AGENTS.md");
    if (target !== "CLAUDE.md") {
      problems.push({
        file: "AGENTS.md",
        msg: `AGENTS.md 是软链但指向 ${target}，不是 CLAUDE.md`,
        fix: "让软链指向 CLAUDE.md，或倒转形态：AGENTS.md 当真身、CLAUDE.md 留一行 `@AGENTS.md`。",
      });
    }
    return problems;
  },
};
