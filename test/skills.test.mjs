/**
 * 技能安装单测。要害是「不许是软链」——软链会被提交进版本库，Windows 上克隆后
 * 变成一个写着路径的文本文件，两个技能同时静默失效，现象是「AI 就是不按规矩走」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installSkills, SKILLS } from "../lib/skills.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-skills-"));
}

const LEGACY_BOSS_FLOW = [
  "---",
  "name: boss-flow",
  "description: 按 BossCoding 流程开始并交付一个开发任务。项目根目录有 AGENTS.md 且老板提出加功能、修问题或改配置时使用；纯问答不触发。",
  "---",
  "",
  "# BossCoding 干活流程",
  "",
  "1. 开工前完整阅读项目根目录的 `AGENTS.md`，全程遵守导师模式和红线。拿不准真实状态就运行 `npx boss status`，不要读文档猜。",
  "2. 从 main（稳定版本）开任务分支。并行的第二个任务起，运行 `npx boss task <任务名>` 准备独立工作区；不要让老板切目录、搬文件或清理工作区。",
  "3. 遇到会长期影响产品的重要裁决，例如目标用户、核心流程、数据去留、收费、权限或上线取舍，按档案室模板把结论和原因追加到 `docs/decisions/`，不要靠下一个 AI 猜。",
  "4. 每次交付都要能回答「核心功能还能跑吗」：没有最小自动测试就建立一条，之后每次改动都运行。BossCoding 检查只管项目卫生，不能代替产品测试。",
  "5. 改完运行 `npm run preflight`；红了先修，不带红提交。报「命令找不到」时先运行 `npm install`，不得换命令绕过。",
  "6. 能预览的产品，必须尽力启动并直接打开给老板看，再交验收单：重点看哪三点、不满意怎么说。只有真实环境限制无法启动或打开时，才说明阻碍并附备用命令。老板没验收，任务不算完成。",
  "7. 本地阶段（`git remote -v` 为空）：先把改动提交在任务分支。老板说「验收通过，执行 BossCoding 收尾」后，在当前任务工作区运行 `npx bosscoding finish`；不要自己 `checkout main`，也不要让老板执行命令。",
  "8. 已连 GitHub：提交并开草稿改动申请，写清改了什么、为什么。老板验收通过后运行 `npx boss merge`；退出码为 0 才正式送检，为 1 就等前面的任务先完成。",
  "9. GitHub 自动检查通过后再合并；红了先修复或撤销。免费私有仓库的云端检查不一定能硬拦合并，本地保护也只是防手滑，所以 AI 必须自己守住「没绿不合并」。",
  "10. 收尾不自动删除任务工作区或分支，也不把清理命令丢给老板。确需回收时，由 AI 找准对象、说明影响并按删除规则确认。",
  "11. 老板说「改坏了／退回去」时，先问要回到哪个已验收版本，用人话列出候选点，再用保留历史的方式撤销。永不使用 `git reset --hard`。",
  "12. 触碰红线，例如删数据、对外发布、花钱、动权限或密钥时，先说明影响并等老板确认。",
  "13. 每次需要老板继续，只给一句可直接说给 AI 的自然语言。除非真实环境限制且 AI 已经尽力，不让老板处理命令、路径、分支或工作区。",
  "",
].join("\n");

test("装：两个目录各一份真实文件，都不是软链", () => {
  const dir = tmp();
  const result = installSkills(dir);
  assert.equal(result.created.length, SKILLS.length * 2);
  for (const skill of SKILLS) {
    for (const base of [".agents/skills", ".claude/skills"]) {
      const entry = path.join(dir, base, skill);
      assert.ok(fs.existsSync(path.join(entry, "SKILL.md")), `缺 ${base}/${skill}`);
      assert.equal(fs.lstatSync(entry).isSymbolicLink(), false, `${base}/${skill} 不该是软链`);
    }
  }
});

test("装：幂等——再跑一次什么都不动", () => {
  const dir = tmp();
  installSkills(dir);
  const again = installSkills(dir);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.refreshed, []);
  assert.deepEqual(again.migrated, []);
});

test("升级：精确等于上一版官方正文的无 marker 技能仍可安全刷新", () => {
  const dir = tmp();
  const target = path.join(dir, ".agents/skills/boss-flow/SKILL.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, LEGACY_BOSS_FLOW);

  const result = installSkills(dir);
  assert.ok(result.refreshed.includes(".agents/skills/boss-flow/SKILL.md"));
  assert.match(fs.readFileSync(target, "utf8"), /bosscoding:managed-skill/);
});

test("升级：旧版留下的软链就地换成真实副本", () => {
  const dir = tmp();
  installSkills(dir);
  // 还原成旧形态：.claude/skills/boss-flow 是指向 .agents 的目录软链。
  const claudeEntry = path.join(dir, ".claude/skills/boss-flow");
  fs.rmSync(claudeEntry, { recursive: true, force: true });
  fs.symlinkSync(path.join("..", "..", ".agents", "skills", "boss-flow"), claudeEntry);
  assert.equal(fs.lstatSync(claudeEntry).isSymbolicLink(), true);

  const result = installSkills(dir);
  assert.deepEqual(result.migrated, [".claude/skills/boss-flow/SKILL.md"]);
  assert.equal(fs.lstatSync(claudeEntry).isSymbolicLink(), false);
  assert.match(fs.readFileSync(path.join(claudeEntry, "SKILL.md"), "utf8"), /name: boss-flow/);
});

test("升级：Windows 把已知旧软链检出成路径文本时，安全迁成真实目录", () => {
  const dir = tmp();
  const claudeEntry = path.join(dir, ".claude/skills/boss-flow");
  fs.mkdirSync(path.dirname(claudeEntry), { recursive: true });
  fs.writeFileSync(claudeEntry, "..\\..\\.agents\\skills\\boss-flow\n");

  const result = installSkills(dir);
  assert.deepEqual(result.migrated, [".claude/skills/boss-flow/SKILL.md"]);
  assert.equal(fs.statSync(claudeEntry).isDirectory(), true);
  assert.match(fs.readFileSync(path.join(claudeEntry, "SKILL.md"), "utf8"), /name: boss-flow/);
});

test("让路：未知普通文件占着技能目录时不删不覆盖，并明确 skipped", () => {
  const dir = tmp();
  const claudeEntry = path.join(dir, ".claude/skills/boss-flow");
  fs.mkdirSync(path.dirname(claudeEntry), { recursive: true });
  fs.writeFileSync(claudeEntry, "这是我的普通文件，不是旧软链。\n");

  const result = installSkills(dir);
  assert.ok(result.skipped.includes(".claude/skills/boss-flow/SKILL.md"));
  assert.equal(fs.statSync(claudeEntry).isFile(), true);
  assert.equal(fs.readFileSync(claudeEntry, "utf8"), "这是我的普通文件，不是旧软链。\n");
});

test("让路：别人手写的同名技能不动", () => {
  const dir = tmp();
  const mine = path.join(dir, ".agents/skills/boss-flow/SKILL.md");
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, "---\nname: 我自己写的\n---\n别动我。\n");
  const result = installSkills(dir);
  assert.ok(result.skipped.includes(".agents/skills/boss-flow/SKILL.md"));
  assert.match(fs.readFileSync(mine, "utf8"), /别动我/);
});

test("让路：即使 front matter 也叫 boss-flow，没有 managed marker 仍视为用户技能", () => {
  const dir = tmp();
  const mine = path.join(dir, ".agents/skills/boss-flow/SKILL.md");
  const custom = "---\nname: boss-flow\n---\n\n# 我自己的同名流程\n\n绝不能整份覆盖。\n";
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, custom);

  const result = installSkills(dir);
  assert.ok(result.skipped.includes(".agents/skills/boss-flow/SKILL.md"));
  assert.equal(fs.readFileSync(mine, "utf8"), custom);
});

test("让路：SKILL.md 是未知或断开的软链时不跟随写入", () => {
  const dir = tmp();
  const skillDir = path.join(dir, ".agents/skills/boss-flow");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.symlinkSync("missing-user-skill.md", path.join(skillDir, "SKILL.md"));

  const result = installSkills(dir);
  assert.ok(result.skipped.includes(".agents/skills/boss-flow/SKILL.md"));
  assert.equal(fs.lstatSync(path.join(skillDir, "SKILL.md")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(skillDir, "missing-user-skill.md")), false);
});

test("让路：技能上级目录是外部软链时不在项目外创建文件", (t) => {
  const dir = tmp();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-skills-outside-"));
  try {
    fs.symlinkSync(outside, path.join(dir, ".agents"));
  } catch {
    t.skip("当前平台不允许创建目录软链");
    return;
  }
  const result = installSkills(dir);
  assert.ok(result.skipped.includes(".agents/skills/boss-flow/SKILL.md"));
  assert.ok(result.skipped.includes(".agents/skills/boss-ladder/SKILL.md"));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("交付技能：AI 负责预览、本地收尾与老板下一步", () => {
  const dir = tmp();
  installSkills(dir);
  const flow = fs.readFileSync(path.join(dir, ".agents/skills/boss-flow/SKILL.md"), "utf8");

  assert.match(flow, /启动并直接打开给老板看/);
  assert.match(flow, /只有真实环境限制/);
  assert.match(flow, /项目选定的包管理器执行 `bosscoding finish`/);
  assert.doesNotMatch(flow, /\bnpx boss\b/);
  assert.doesNotMatch(flow, /git checkout main/);
  assert.match(flow, /docs\/decisions\//);
  assert.match(flow, /不自动删除任务工作区/);
  assert.match(flow, /一句可直接说给 AI 的自然语言/);
});

test("四阶梯技能：先验收再注册，质检承诺不夸大", () => {
  const dir = tmp();
  installSkills(dir);
  const ladder = fs.readFileSync(path.join(dir, ".agents/skills/boss-ladder/SKILL.md"), "utf8");

  assert.match(ladder, /第一版已经打开给老板看，并且老板明确验收通过后，才提 GitHub/);
  assert.doesNotMatch(ladder, /第一次埋头干活/);
  assert.match(ladder, /自动检查/);
  assert.match(ladder, /本机保护/);
  assert.match(ladder, /不一定能硬性拦住网页合并/);
  assert.match(ladder, /不要让老板执行命令或清理工作区/);
});

test("完整收尾技能：线上验证、知识收尾和确认式清理不可混用", () => {
  const dir = tmp();
  installSkills(dir);
  const closeout = fs.readFileSync(path.join(dir, ".agents/skills/boss-closeout/SKILL.md"), "utf8");

  assert.match(closeout, /真实线上入口/);
  assert.match(closeout, /neat-freak/);
  assert.match(closeout, /老板看完完整报告后明确确认/);
  assert.match(closeout, /已合并/);
  assert.match(closeout, /线上已验证/);
  assert.match(closeout, /知识已收尾/);
  assert.match(closeout, /已清理/);
});
