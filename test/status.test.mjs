/**
 * status 单测：探测必须来自真实命令输出，且全程只读——
 * 一个会动手的状态命令，老板就不敢随便跑了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { probe, runStatus, verifyRemoteUpload } from "../lib/commands/status.mjs";
import { runInit } from "../lib/commands/init.mjs";
import { runTask } from "../lib/commands/task.mjs";
import { packageIdentity } from "../lib/package-identity.mjs";

const FRAMEWORK_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FRAMEWORK_DEPENDENCY = packageIdentity().name;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "boss",
  GIT_AUTHOR_EMAIL: "boss@example.com",
  GIT_COMMITTER_NAME: "boss",
  GIT_COMMITTER_EMAIL: "boss@example.com",
};

function mute() {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = original.log;
    console.error = original.error;
  };
}

function capture(run) {
  const lines = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { result: run(), output: lines.join("\n") };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

function git(dir, ...args) {
  return execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8", stdio: "pipe" }).trim();
}

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-status-"));
  const unmute = mute();
  try {
    runInit(dir);
  } finally {
    unmute();
  }
  return dir;
}

function commitAll(dir) {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

test("探测：远端已配置、本机旧记录、当前远端确认是三件不同的事实", () => {
  const dir = project();
  assert.equal(probe(dir).rung, 0);
  commitAll(dir);

  git(dir, "remote", "add", "origin", "/tmp/not-a-github-repository.git");
  const arbitrary = probe(dir);
  assert.equal(arbitrary.remoteConfigured, true);
  assert.equal(arbitrary.githubRemote, false);
  assert.equal(arbitrary.currentCommitUploaded, false);
  assert.equal(arbitrary.originDisplay, "本地地址（已隐藏）");
  assert.equal(arbitrary.rung, 0);
  assert.doesNotMatch(capture(() => runStatus(dir)).output, /\/tmp\/not-a-github-repository/);

  git(
    dir,
    "remote",
    "set-url",
    "origin",
    "https://oauth2:top-secret@github.com/o/r.git?token=query-secret#hash-secret",
  );
  const configured = probe(dir, { remoteVerifier: () => "missing" });
  assert.equal(configured.remoteConfigured, true);
  assert.equal(configured.githubRemote, true);
  assert.equal(configured.currentCommitUploaded, false);
  assert.equal(configured.originDisplay, "https://github.com/o/r");
  assert.equal(configured.rung, 0);

  // 旧 remote-tracking ref 只能证明本机曾记录过；origin 换成空仓库后不能借尸还魂。
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  const staleRecord = probe(dir, { remoteVerifier: () => "missing" });
  assert.equal(staleRecord.localUploadRecord, true);
  assert.equal(staleRecord.currentCommitUploaded, false);
  assert.equal(staleRecord.rung, 0);

  const uploaded = probe(dir, { remoteVerifier: () => "verified" });
  assert.equal(uploaded.currentCommitUploaded, true);
  assert.equal(uploaded.currentContentBackedUp, true);
  assert.equal(uploaded.rung, 1);

  fs.writeFileSync(path.join(dir, "unsaved.txt"), "not committed\n");
  const dirty = probe(dir, { remoteVerifier: () => "verified" });
  assert.equal(dirty.currentCommitUploaded, true);
  assert.equal(dirty.currentContentBackedUp, false);
  assert.equal(dirty.unsavedChanges, true);
  const shown = capture(() => runStatus(dir, { remoteVerifier: () => "verified" })).output;
  assert.match(shown, /另有未保存改动，这部分没有异地备份/);
  assert.doesNotMatch(shown, /top-secret|query-secret|hash-secret|\/tmp\/not-a-github/);
});

test("远端实时证据：只在当前提交确实存在于此刻的 origin 时亮绿", () => {
  const dir = project();
  commitAll(dir);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-status-remote-"));
  git(bare, "init", "--bare", "-q");
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "origin", "main");

  const first = git(dir, "rev-parse", "HEAD");
  assert.equal(verifyRemoteUpload(dir, first), "verified");

  fs.writeFileSync(path.join(dir, "local-only.txt"), "not uploaded\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "local only");
  assert.equal(verifyRemoteUpload(dir, git(dir, "rev-parse", "HEAD")), "missing");
});

test("探测：规则、官方门禁、四份技能、可解析依赖与测试入口逐项看事实", () => {
  const dir = project();
  const before = probe(dir);
  assert.equal(before.intro, "placeholder");
  assert.equal(before.depsInstalled, false);
  assert.equal(before.dependenciesRequired, true);
  assert.equal(before.hasPackageJson, true);
  assert.equal(before.packageJsonValid, true);
  assert.equal(before.rulesReady, true);
  assert.equal(before.hooksReady, true);
  assert.equal(before.skillsReady, true);
  assert.equal(before.testEntryConfigured, false);

  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    agents.replace(/（本项目做什么[\s\S]*?）/, "给自己用的记账小工具，跑在本地。"),
  );
  const dependencyDir = path.join(dir, "node_modules", FRAMEWORK_DEPENDENCY);
  fs.mkdirSync(dependencyDir, { recursive: true });
  assert.equal(probe(dir).depsInstalled, false, "空目录不能冒充依赖已安装");
  fs.writeFileSync(path.join(dependencyDir, "package.json"), "{broken");
  assert.equal(probe(dir).depsInstalled, false, "损坏的依赖 package.json 不能冒充已安装");
  fs.writeFileSync(path.join(dependencyDir, "package.json"), `${JSON.stringify({ name: FRAMEWORK_DEPENDENCY, version: "0.5.0" })}\n`);

  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test", "smoke.test.mjs"), "/* 最小产品测试 */\n");
  const commentOnly = probe(dir);
  assert.equal(commentOnly.testEntryConfigured, false, "默认 node --test 的空测试不能亮绿");
  fs.writeFileSync(
    path.join(dir, "test", "smoke.test.mjs"),
    'import assert from "node:assert/strict";\nassert.equal(1, 1);\n',
  );
  const after = probe(dir);
  assert.equal(after.intro, "filled");
  assert.equal(after.depsInstalled, true);
  assert.equal(after.testEntryConfigured, true);

  // marker 仍在但内容过期也不是当前门禁。
  const prePush = path.join(dir, ".git", "hooks", "pre-push");
  const originalHook = fs.readFileSync(prePush, "utf8");
  fs.writeFileSync(prePush, `${originalHook}\n# 旧版残留\n`);
  assert.equal(probe(dir).hooksReady, false);
  assert.deepEqual(probe(dir).missingHooks, ["pre-push"]);
  if (process.platform !== "win32") {
    fs.writeFileSync(prePush, originalHook);
    fs.chmodSync(prePush, 0o644);
    assert.equal(probe(dir).hooksReady, false);
    assert.deepEqual(probe(dir).missingHooks, ["pre-push"]);
  }

  fs.writeFileSync(prePush, originalHook);
  fs.chmodSync(prePush, 0o755);
  const skill = path.join(dir, ".agents", "skills", "boss-flow", "SKILL.md");
  fs.appendFileSync(skill, "\n旧版残留\n");
  const staleSkill = probe(dir);
  assert.equal(staleSkill.skillsReady, false);
  assert.deepEqual(staleSkill.missingSkills, [".agents/skills/boss-flow/SKILL.md"]);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-global-hooks-"));
  for (const name of ["pre-commit", "post-checkout", "pre-push"]) {
    const source = path.join(dir, ".git", "hooks", name);
    const target = path.join(outside, name);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o755);
  }
  git(dir, "config", "core.hooksPath", outside);
  const externalHooks = probe(dir);
  assert.equal(externalHooks.hooksReady, false, "项目外的全局 hook 不能冒充本项目门禁");
  assert.deepEqual(externalHooks.missingHooks.sort(), ["post-checkout", "pre-commit", "pre-push"]);
});

test("没有声明任何依赖时，不因 node_modules 不存在而要求安装", () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"plain","private":true}\n');
  const state = probe(dir);
  assert.equal(state.dependenciesRequired, false);
  assert.equal(state.depsInstalled, true);
});

test("package.json 无法解析时，依赖与测试入口都不能亮绿", () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, "package.json"), "{broken");
  const state = probe(dir);
  assert.equal(state.packageJsonValid, false);
  assert.equal(state.depsInstalled, false);
  assert.equal(state.testEntryConfigured, false);
});

test("Yarn PnP：真实非空入口可替代 node_modules；空文件和软链不能亮绿", () => {
  const dir = project();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.packageManager = "yarn@4.2.0";
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "yarn.lock"), "lock\n");
  const pnp = path.join(dir, ".pnp.cjs");

  fs.writeFileSync(pnp, "");
  assert.equal(probe(dir).depsInstalled, false, "空 PnP 入口不能冒充已安装");

  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-pnp-")), "outside.cjs");
  fs.writeFileSync(outside, "module.exports = {};\n");
  fs.rmSync(pnp);
  try {
    fs.symlinkSync(outside, pnp);
    assert.equal(probe(dir).depsInstalled, false, "项目外软链不能冒充已安装");
  } catch {
    // 当前平台若不允许软链，仍继续验证真实普通文件。
  }
  fs.rmSync(pnp, { force: true });
  fs.writeFileSync(pnp, "module.exports = {};\n");
  const ready = probe(dir);
  assert.equal(ready.packageManager.name, "yarn");
  assert.equal(ready.depsInstalled, true);
});

test("状态：多套安装工具冲突时只让 AI 统一，不误导去装依赖或连 GitHub", () => {
  const dir = project();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.packageManager = "pnpm@9.0.0";
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lock\n");
  fs.writeFileSync(path.join(dir, "yarn.lock"), "lock\n");
  commitAll(dir);

  const output = capture(() => runStatus(dir)).output;
  assert.match(output, /同时出现多套安装工具的痕迹/);
  const next = output.split("下一步：")[1];
  assert.match(next, /确认项目原来用哪一种包管理器/);
  assert.doesNotMatch(next, /安装完整|npm install|连上 GitHub/);
});

test("自定义测试命令只声明入口，不冒充已验证结果", () => {
  const dir = project();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.scripts.test = "vitest run";
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  assert.equal(probe(dir).testEntryConfigured, true);

  for (const noop of ["echo ok", "printf ok", "true", ":", "exit 0", 'node -e "process.exit(0)"']) {
    pkg.scripts.test = noop;
    fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    assert.equal(probe(dir).testEntryConfigured, false, noop);
  }

  pkg.scripts.test = "echo preparing && vitest run";
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  assert.equal(probe(dir).testEntryConfigured, true);
});

test("手工合并过的自定义规则：三块核心标题齐全就视为 BossCoding 已就绪", () => {
  const dir = project();
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    "# 我的项目规则\n\n## 导师模式\n\n说人话。\n\n## 干活流程\n\n先检查。\n\n## 红线\n\n上线前确认。\n",
  );
  const state = probe(dir);
  assert.equal(state.intro, "custom");
  assert.equal(state.rulesReady, true);
});

test("缺本地门禁时，下一步只让 AI 用最新版全名恢复", () => {
  const dir = project();
  fs.rmSync(path.join(dir, ".git", "hooks", "post-checkout"));
  const { result, output } = capture(() => runStatus(dir));
  assert.equal(result, 0);
  const next = output.split("下一步：")[1];
  assert.match(next, /npx -y @s-ry2005\/bosscoding@latest update/);
  assert.doesNotMatch(next, /npm install|提交一下|带我连上 GitHub/);
  assert.equal(output.match(/对 AI 说/g)?.length, 1, "缺门禁时不应同时派发第二个动作");
});

test("任务尚未产出或有未保存改动时，下一步不跳去连接 GitHub", () => {
  const dir = project();
  commitAll(dir);
  const unmute = mute();
  let target;
  try {
    assert.equal(runTask(dir, "尚未产出", { installDeps: false }), 0);
    target = path.join(path.dirname(dir), `${path.basename(dir)}-尚未产出`);
  } finally {
    unmute();
  }

  try {
    const clean = capture(() => runStatus(target)).output.split("下一步：")[1];
    assert.match(clean, /当前任务还没有产出/);
    assert.doesNotMatch(clean, /连上 GitHub/);

    fs.writeFileSync(path.join(target, "wip.txt"), "working\n");
    const dirty = capture(() => runStatus(target)).output.split("下一步：")[1];
    assert.match(dirty, /妥善保存当前未提交改动/);
    assert.doesNotMatch(dirty, /连上 GitHub/);
  } finally {
    if (target && fs.existsSync(target)) {
      execFileSync("git", ["worktree", "remove", "--force", target], {
        cwd: dir,
        env: GIT_ENV,
        stdio: "pipe",
      });
    }
  }
});

test("任务已有提交但还没收尾时，下一步必须先验收和 finish", () => {
  const dir = project();
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    agents.replace(/（本项目做什么[\s\S]*?）/, "给自己用的记账小工具，跑在本地。"),
  );
  fs.mkdirSync(path.join(dir, "node_modules", FRAMEWORK_DEPENDENCY), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", FRAMEWORK_DEPENDENCY, "package.json"),
    `${JSON.stringify({ name: FRAMEWORK_DEPENDENCY, version: "0.5.0" })}\n`,
  );
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test", "smoke.test.mjs"), "process.exitCode = 0;\n");
  commitAll(dir);

  const unmute = mute();
  let target;
  try {
    assert.equal(runTask(dir, "等待验收", { installDeps: false }), 0);
    target = path.join(path.dirname(dir), `${path.basename(dir)}-等待验收`);
  } finally {
    unmute();
  }

  try {
    fs.mkdirSync(path.join(target, "node_modules", FRAMEWORK_DEPENDENCY), { recursive: true });
    fs.writeFileSync(
      path.join(target, "node_modules", FRAMEWORK_DEPENDENCY, "package.json"),
      `${JSON.stringify({ name: FRAMEWORK_DEPENDENCY, version: "0.5.0" })}\n`,
    );
    fs.writeFileSync(path.join(target, "done.txt"), "done\n");
    git(target, "add", "-A");
    git(target, "commit", "-qm", "done");
    const next = capture(() => runStatus(target)).output.split("下一步：")[1];
    assert.match(next, /打开给我验收/);
    assert.match(next, /BossCoding 收尾/);
    assert.doesNotMatch(next, /连上 GitHub/);
  } finally {
    if (target && fs.existsSync(target)) {
      execFileSync("git", ["worktree", "remove", "--force", target], {
        cwd: dir,
        env: GIT_ENV,
        stdio: "pipe",
      });
    }
  }
});

test("Codex 默认 codex/ 分支也被识别为待收尾任务", () => {
  const dir = project();
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    agents.replace(/（本项目做什么[\s\S]*?）/, "给自己用的三件事小工具，跑在本地。"),
  );
  fs.mkdirSync(path.join(dir, "node_modules", FRAMEWORK_DEPENDENCY), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", FRAMEWORK_DEPENDENCY, "package.json"),
    `${JSON.stringify({ name: FRAMEWORK_DEPENDENCY, version: "0.5.0" })}\n`,
  );
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "test", "smoke.test.mjs"),
    'import assert from "node:assert/strict";\nassert.equal(1, 1);\n',
  );
  commitAll(dir);

  git(dir, "checkout", "-q", "-b", "codex/首个产品");
  fs.writeFileSync(path.join(dir, "done.txt"), "done\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "done");

  const state = probe(dir);
  assert.equal(state.taskBranch, true);
  assert.equal(state.taskHasCommittedChanges, true);
  const next = capture(() => runStatus(dir)).output.split("下一步：")[1];
  assert.match(next, /打开给我验收/);
  assert.match(next, /BossCoding 收尾/);
  assert.doesNotMatch(next, /连上 GitHub/);
});

test("从仓库子目录运行 status，所有事实统一取项目最外层", () => {
  const dir = project();
  const nested = path.join(dir, "src", "feature");
  fs.mkdirSync(nested, { recursive: true });

  const rootState = probe(dir);
  const nestedState = probe(nested);
  assert.equal(nestedState.abs, fs.realpathSync(dir));
  for (const key of [
    "rulesReady",
    "hooksReady",
    "skillsReady",
    "packageJsonValid",
    "depsInstalled",
    "testEntryConfigured",
    "branch",
  ]) {
    assert.equal(nestedState[key], rootState[key], key);
  }
});

test("文件夹已丢失的任务登记不冒充进行中，并优先提示找回", () => {
  const dir = project();
  commitAll(dir);
  const unmute = mute();
  let target;
  try {
    assert.equal(runTask(dir, "文件夹丢失", { installDeps: false }), 0);
    target = path.join(path.dirname(dir), `${path.basename(dir)}-文件夹丢失`);
  } finally {
    unmute();
  }

  fs.rmSync(target, { recursive: true, force: true });
  try {
    const output = capture(() => runStatus(dir)).output;
    assert.match(output, /工作区登记异常：1 条任务的文件夹已不在原位置/);
    assert.doesNotMatch(output, /进行中的任务：1 条/);
    const next = output.split("下一步：")[1];
    assert.match(next, /是否被移动、能否从备份找回/);
    assert.doesNotMatch(next, /连上 GitHub/);
  } finally {
    git(dir, "worktree", "prune", "--expire", "now");
  }
});

test("已合并且保留的工作区不算进行中，也不把回收变成老板唯一下一步", () => {
  const dir = project();
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    agents.replace(/（本项目做什么[\s\S]*?）/, "给自己用的记账小工具，跑在本地。"),
  );
  fs.mkdirSync(path.join(dir, "node_modules", FRAMEWORK_DEPENDENCY), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", FRAMEWORK_DEPENDENCY, "package.json"),
    `${JSON.stringify({ name: FRAMEWORK_DEPENDENCY, version: "0.5.0" })}\n`,
  );
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test", "smoke.test.mjs"), "process.exitCode = 0;\n");
  commitAll(dir);

  const unmute = mute();
  let target;
  try {
    assert.equal(runTask(dir, "已合并保留", { installDeps: false }), 0);
    target = path.join(path.dirname(dir), `${path.basename(dir)}-已合并保留`);
  } finally {
    unmute();
  }

  try {
    fs.writeFileSync(path.join(target, "done.txt"), "done\n");
    git(target, "add", "-A");
    git(target, "commit", "-qm", "done");
    git(dir, "merge", "--ff-only", "lane/已合并保留");

    const output = capture(() => runStatus(dir)).output;
    assert.match(output, /已保留：1 个任务工作区已经合并/);
    assert.doesNotMatch(output, /进行中的任务/);
    const next = output.split("下一步：")[1];
    assert.match(next, /继续说下一个产品需求/);
    assert.doesNotMatch(next, /回收/);
  } finally {
    if (target && fs.existsSync(target)) {
      execFileSync("git", ["worktree", "remove", "--force", target], {
        cwd: dir,
        env: GIT_ENV,
        stdio: "pipe",
      });
    }
  }
});

test("只读：跑一次 status 不产生任何文件变化", () => {
  const dir = project();
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  const unmute = mute();
  try {
    assert.equal(runStatus(dir), 0);
  } finally {
    unmute();
  }
  const after = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert.equal(after, before);
});

test("不是版本库：明确失败并指路 init", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-status-norepo-"));
  const unmute = mute();
  try {
    assert.equal(runStatus(dir), 1);
  } finally {
    unmute();
  }
});

test("状态：缺少或篡改完整收尾技能时不能亮绿", () => {
  const missingDir = project();
  const missing = path.join(missingDir, ".agents/skills/boss-closeout/SKILL.md");
  fs.rmSync(missing);
  const missingState = probe(missingDir);
  assert.equal(missingState.skillsReady, false);
  assert.ok(missingState.missingSkills.includes(".agents/skills/boss-closeout/SKILL.md"));

  const alteredDir = project();
  const altered = path.join(alteredDir, ".agents/skills/boss-closeout/SKILL.md");
  fs.writeFileSync(altered, "---\nname: boss-closeout\n---\n\n用户篡改版本。\n");
  const alteredState = probe(alteredDir);
  assert.equal(alteredState.skillsReady, false);
  assert.ok(alteredState.missingSkills.includes(".agents/skills/boss-closeout/SKILL.md"));
});

test("状态：框架仓库检查模板与 CI，不误报未安装产品资产", () => {
  const state = probe(FRAMEWORK_ROOT, { remoteVerifier: () => "verified" });
  assert.equal(state.frameworkMode, true);
  assert.equal(state.hooksReady, true);
  assert.equal(state.skillsReady, true);
  assert.equal(state.ciReady, true);

  const shown = capture(() => runStatus(FRAMEWORK_ROOT, { remoteVerifier: () => "verified" }));
  assert.equal(shown.result, 0, shown.output);
  assert.match(shown.output, /BossCoding 框架维护模式/);
  assert.doesNotMatch(shown.output, /本地门禁缺失或过期|AI 技能缺失或过期/);
});
