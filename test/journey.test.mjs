/**
 * 真正的老板旅程：不调用内部函数，使用装进临时项目的本地包走完整 CLI。
 * 这条回归负责证明「空目录开工 → 产品测试 → 任务 → 验收收尾」没有断在模块接缝处。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packageIdentity } from "../lib/package-identity.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_CLI = path.join(PACKAGE_ROOT, "bin", "bosscoding.mjs");
const PACKAGE_PATH_SEGMENTS = packageIdentity().name.split("/");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "boss",
  GIT_AUTHOR_EMAIL: "boss@example.com",
  GIT_COMMITTER_NAME: "boss",
  GIT_COMMITTER_EMAIL: "boss@example.com",
  NO_COLOR: "1",
};

function run(cwd, command, args) {
  return execFileSync(command, args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(cwd, ...args) {
  return run(cwd, "git", args).trim();
}

function writeProduct(project, label) {
  fs.writeFileSync(
    path.join(project, "index.html"),
    `<!doctype html><html lang="zh-CN"><body><button>${label}</button></body></html>\n`,
  );
  fs.mkdirSync(path.join(project, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "test", "product.test.mjs"),
    [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      "",
      `test("核心按钮仍可见", () => {`,
      '  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");',
      `  assert.match(html, /${label}/);`,
      "});",
      "",
    ].join("\n"),
  );
}

test("黑盒老板旅程：空目录做到首个任务安全回到稳定版本", { timeout: 60_000 }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-journey-"));
  const project = path.join(parent, "我的第一个产品");
  const target = path.join(parent, "我的第一个产品-按钮更清楚");
  fs.mkdirSync(project);

  try {
    run(project, process.execPath, [SOURCE_CLI, "init"]);

    const pkgPath = path.join(project, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.devDependencies[packageIdentity().name] = `file:${PACKAGE_ROOT}`;
    pkg.scripts.test = "node --test test/product.test.mjs";
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const agentsPath = path.join(project, "AGENTS.md");
    const agents = fs.readFileSync(agentsPath, "utf8");
    fs.writeFileSync(
      agentsPath,
      agents.replace(
        /（本项目做什么[\s\S]*?）/,
        "给第一次做产品的人使用的按钮示例，运行在本机浏览器。",
      ),
    );
    writeProduct(project, "开始使用");

    run(project, "npm", [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    run(project, "npm", ["run", "preflight"]);
    git(project, "add", "-A");
    git(project, "commit", "-qm", "first visible product");

    run(project, process.execPath, [path.join(project, "node_modules", ...PACKAGE_PATH_SEGMENTS, "bin", "bosscoding.mjs"), "task", "按钮更清楚"]);
    assert.equal(git(target, "branch", "--show-current"), "lane/按钮更清楚");

    writeProduct(target, "马上开始");
    git(target, "add", "-A");
    git(target, "commit", "-qm", "make button clearer");
    const accepted = git(target, "rev-parse", "HEAD");

    const finishOutput = run(
      target,
      process.execPath,
      [path.join(target, "node_modules", ...PACKAGE_PATH_SEGMENTS, "bin", "bosscoding.mjs"), "finish"],
    );
    assert.match(finishOutput, /任务已安全快进合并/);
    assert.equal(git(project, "rev-parse", "main"), accepted);
    assert.match(fs.readFileSync(path.join(project, "index.html"), "utf8"), /马上开始/);

    const statusOutput = run(
      project,
      process.execPath,
      [path.join(project, "node_modules", ...PACKAGE_PATH_SEGMENTS, "bin", "bosscoding.mjs"), "status"],
    );
    assert.match(statusOutput, /已保留：1 个任务工作区已经合并/);
    assert.doesNotMatch(statusOutput, /进行中的任务：1 条/);
  } finally {
    if (fs.existsSync(path.join(project, ".git")) && fs.existsSync(target)) {
      try {
        git(project, "worktree", "remove", "--force", target);
      } catch {
        // 临时验收目录稍后整体删除；这里不掩盖主断言。
      }
    }
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
