/**
 * init 端到端：空目录 → 筹备完成 → 守卫全绿。这是「老板开司旅程」的机器化版本。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  initializeGit,
  runInit,
  packageNameFrom,
  refuseReason,
} from "../lib/commands/init.mjs";
import { runCheck } from "../lib/commands/check.mjs";
import { DEFAULT_PREFLIGHT, defaultPreflight } from "../lib/preflight.mjs";

const CLI = fileURLToPath(new URL("../bin/bosscoding.mjs", import.meta.url));

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-init-"));
}

/** 静音 console，返回恢复函数（init/check 输出很长，别刷测试日志）。 */
function muteConsole() {
  const original = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = original.log;
    console.error = original.error;
  };
}

function captureConsole(action) {
  const output = [];
  const original = { log: console.log, error: console.error };
  console.log = (...args) => output.push(args.join(" "));
  console.error = (...args) => output.push(args.join(" "));
  try {
    return { result: action(), output: output.join("\n") };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

test("init：空目录一次装齐全部资产", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }

  for (const rel of [
    "AGENTS.md",
    "CLAUDE.md",
    ".github/workflows/bosscoding.yml",
    "docs/decisions/README.md",
    "docs/decisions/_template.md",
    ".agents/skills/boss-flow/SKILL.md",
    ".agents/skills/boss-ladder/SKILL.md",
    ".agents/skills/boss-closeout/SKILL.md",
    ".gemini/settings.json",
    ".iflow/settings.json",
    ".gitignore",
    "package.json",
  ]) {
    assert.ok(fs.existsSync(path.join(dir, rel)), `缺 ${rel}`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.preflight, DEFAULT_PREFLIGHT);
  assert.equal(pkg.scripts.test, "node --test");
  assert.ok(pkg.devDependencies.bosscoding);

  // 门牌必须是 @ 导入桩，不是第二份真身。
  const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
  assert.ok(claude.includes("@AGENTS.md"));

  // Claude 技能入口必须是真实文件，不能是软链——软链在 Windows 上克隆后静默失效。
  for (const skill of ["boss-flow", "boss-ladder", "boss-closeout"]) {
    const entry = path.join(dir, ".claude/skills", skill);
    assert.ok(fs.existsSync(path.join(entry, "SKILL.md")), `缺 Claude 技能入口 ${skill}`);
    assert.equal(fs.lstatSync(entry).isSymbolicLink(), false, `${skill} 不该是软链`);
  }

  // git hook 也归 init 装（细节与拦截行为见 hooks.test.mjs）。
  for (const name of ["pre-commit", "post-checkout", "pre-push"]) {
    assert.ok(fs.existsSync(path.join(dir, ".git/hooks", name)), `缺 git hook ${name}`);
  }
});

test("init：旧 Git 不支持 init -b 时自动回退，并把未出生分支设为 main", () => {
  const calls = [];
  initializeGit("/project", (_command, args) => {
    calls.push(args);
    if (args.includes("-b")) {
      const error = new Error("unknown option b");
      error.status = 129;
      throw error;
    }
  });
  assert.deepEqual(calls, [
    ["init", "-b", "main"],
    ["init"],
    ["symbolic-ref", "HEAD", "refs/heads/main"],
  ]);
});

test("init：git init 的真实错误不会被当成旧版本参数问题掩盖", () => {
  const calls = [];
  assert.throws(() =>
    initializeGit("/project", (_command, args) => {
      calls.push(args);
      const error = new Error("permission denied");
      error.status = 128;
      throw error;
    }),
  );
  assert.deepEqual(calls, [["init", "-b", "main"]]);
});

test("init：幂等——跑两次不覆盖、不重复追加", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    runInit(dir);
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 老板已改过的规则文件\n\n自定义内容。\n");
    const gitignoreBefore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    runInit(dir);
    assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /老板已改过/);
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), gitignoreBefore);
  } finally {
    unmute();
  }
});

test("init：二次运行不把自己生成的 Gemini／iFlow 配置误报为待处理", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }

  const second = captureConsole(() => runInit(dir));
  assert.equal(second.result, 0);
  assert.doesNotMatch(second.output, /需要处理：/);
  assert.doesNotMatch(second.output, /\.gemini\/settings\.json：请在其中确认/);
  assert.doesNotMatch(second.output, /\.iflow\/settings\.json：请在其中确认/);
  assert.match(second.output, /BossCoding 就位/);
  assert.match(second.output, /下一步只做一件事/);
  assert.match(second.output, /项目选定的包管理器执行 bosscoding status/);
  assert.doesNotMatch(second.output, /npx boss status/);
});

test("init 后 git add，守卫全绿（完整开司旅程）", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    runInit(dir);
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    assert.equal(runCheck(dir), 0);
  } finally {
    unmute();
  }
});

test("init：preflight 会真实运行产品测试，失败时绝不会只报守卫绿", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.scripts.test = 'node -e "console.error(\'产品测试失败证据\'); process.exit(23)"';
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

  const result = spawnSync("npm", ["run", "preflight"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /产品测试失败证据/);
});

test("init：中文文件夹名生成合法包名，不是一串连字符", () => {
  assert.equal(packageNameFrom("我的第一个产品"), "my-project");
  assert.equal(packageNameFrom("My App 2"), "my-app-2");
  assert.equal(packageNameFrom("记账-tool"), "tool");
  assert.equal(packageNameFrom(""), "my-project");

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-cn-"));
  const dir = path.join(parent, "我的第一个产品");
  fs.mkdirSync(dir);
  const unmute = muteConsole();
  try {
    runInit(dir);
  } finally {
    unmute();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "my-project");
  assert.doesNotMatch(pkg.name, /^-|-$/, "包名不许以连字符开头或结尾（npm 非法）");
});

test("init：家目录与桌面这类「东西堆」一律拒绝开工，且不写任何文件", () => {
  // 判据是位置本身，不是文件数——已有项目接入时目录本来就文件很多。
  assert.ok(refuseReason(os.homedir()));
  assert.ok(refuseReason(path.join(os.homedir(), "Desktop")));
  assert.ok(refuseReason(path.join(os.homedir(), "桌面")));
  assert.ok(refuseReason(os.tmpdir()));
  if (fs.existsSync("/tmp")) assert.ok(refuseReason("/tmp"));
  assert.equal(refuseReason(path.join(os.homedir(), "code", "我的产品")), null);

  // 真的对家目录跑一次：必须返回 1。安全——它在写任何文件之前就退出了。
  const captured = captureConsole(() => runInit(os.homedir()));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /把这句话交给 AI/);
  assert.doesNotMatch(captured.output, /\bmkdir\b|\bcd\s/);
  assert.equal(fs.existsSync(path.join(os.homedir(), "AGENTS.md")), false, "家目录里不该出现规则文件");
});

test("init：软链实际指向家目录或桌面时也拒绝，不被表面路径骗过", (t) => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-fake-home-"));
  const desktop = path.join(fakeHome, "Desktop");
  fs.mkdirSync(desktop);
  const links = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-home-links-"));
  const homeLink = path.join(links, "看起来安全的产品");
  const desktopLink = path.join(links, "另一个产品");
  try {
    fs.symlinkSync(fakeHome, homeLink, "dir");
    fs.symlinkSync(desktop, desktopLink, "dir");
  } catch {
    t.skip("当前平台不允许创建目录软链");
    return;
  }

  for (const [cwd, expected] of [[homeLink, /家目录/], [desktopLink, /Desktop/]]) {
    const child = spawnSync(process.execPath, [CLI, "init"], {
      cwd,
      env: { ...process.env, HOME: fakeHome },
      encoding: "utf8",
    });
    const output = `${child.stdout}${child.stderr}`;
    assert.equal(child.status, 1);
    assert.match(output, expected);
  }
  assert.equal(fs.existsSync(path.join(fakeHome, "package.json")), false);
  assert.equal(fs.existsSync(path.join(desktop, "package.json")), false);
});

test("init：普通非空目录必须有根级明确清单；仅有 src／lib／测试或源码仍拒绝", () => {
  const clutter = tmpProject();
  fs.writeFileSync(path.join(clutter, "家庭照片.jpg"), "not really a photo");
  const refused = captureConsole(() => runInit(clutter));
  assert.equal(refused.result, 1);
  assert.match(refused.output, /看不出这是一个产品项目/);
  assert.equal(fs.existsSync(path.join(clutter, ".git")), false);
  assert.equal(fs.existsSync(path.join(clutter, "package.json")), false);

  const gitProject = tmpProject();
  fs.writeFileSync(path.join(gitProject, "产品想法.pdf"), "notes");
  execFileSync("git", ["init", "-b", "main"], { cwd: gitProject, stdio: "ignore" });
  const gitUnmute = muteConsole();
  try {
    assert.equal(runInit(gitProject), 0);
  } finally {
    gitUnmute();
  }
  assert.ok(fs.existsSync(path.join(gitProject, "AGENTS.md")));

  for (const setup of [
    (dir) => fs.mkdirSync(path.join(dir, "src")),
    (dir) => fs.mkdirSync(path.join(dir, "lib")),
    (dir) => fs.mkdirSync(path.join(dir, "test")),
    (dir) => fs.writeFileSync(path.join(dir, "main.py"), "print('hello')\n"),
  ]) {
    const sourceOnly = tmpProject();
    setup(sourceOnly);
    const result = captureConsole(() => runInit(sourceOnly));
    assert.equal(result.result, 1);
    assert.match(result.output, /看不出这是一个产品项目/);
    assert.equal(fs.existsSync(path.join(sourceOnly, ".git")), false);
    assert.equal(fs.existsSync(path.join(sourceOnly, "AGENTS.md")), false);
  }
});

test("init：只有 pnpm workspace 配置、尚无锁文件时也绝不误用 npm", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 0, captured.output);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.preflight, defaultPreflight("pnpm"));
  assert.match(captured.output, /pnpm install/);
  assert.equal(fs.existsSync(path.join(dir, "package-lock.json")), false);
});

test("init：package.json、.gitignore 或生成目录是软链时不跟随写到项目外", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-init-symlink-outside-"));

  const packageDir = tmpProject();
  const externalPackage = path.join(outside, "package.json");
  fs.writeFileSync(externalPackage, '{"name":"outside"}\n');
  try {
    fs.symlinkSync(externalPackage, path.join(packageDir, "package.json"));
  } catch {
    t.skip("当前平台不允许创建文件软链");
    return;
  }
  const packageResult = captureConsole(() => runInit(packageDir));
  assert.equal(packageResult.result, 1);
  assert.match(packageResult.output, /package\.json 不是项目内的普通文件/);
  assert.equal(fs.readFileSync(externalPackage, "utf8"), '{"name":"outside"}\n');
  assert.equal(fs.existsSync(path.join(packageDir, ".git")), false);

  const ignoreDir = tmpProject();
  const externalIgnore = path.join(outside, "gitignore");
  fs.writeFileSync(externalIgnore, "keep-me\n");
  fs.writeFileSync(path.join(ignoreDir, "package.json"), '{"name":"safe-ignore-test"}\n');
  fs.symlinkSync(externalIgnore, path.join(ignoreDir, ".gitignore"));
  const ignoreResult = captureConsole(() => runInit(ignoreDir));
  assert.equal(ignoreResult.result, 1);
  assert.match(ignoreResult.output, /\.gitignore 不是项目内的普通文件/);
  assert.equal(fs.readFileSync(externalIgnore, "utf8"), "keep-me\n");

  const parentDir = tmpProject();
  const externalGithub = path.join(outside, "github");
  fs.mkdirSync(externalGithub);
  fs.writeFileSync(path.join(parentDir, "package.json"), '{"name":"safe-parent-test"}\n');
  fs.symlinkSync(externalGithub, path.join(parentDir, ".github"));
  const parentResult = captureConsole(() => runInit(parentDir));
  assert.equal(parentResult.result, 1);
  assert.match(parentResult.output, /\.github\/workflows\/bosscoding\.yml 的路径不安全/);
  assert.equal(fs.existsSync(path.join(externalGithub, "workflows/bosscoding.yml")), false);
});

test("init：Git 子目录即使有 package.json 也拒绝，必须回到仓库最外层", () => {
  const root = tmpProject();
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  const nested = path.join(root, "apps/web");
  fs.mkdirSync(nested, { recursive: true });
  const pkg = '{"name":"nested","private":true}\n';
  fs.writeFileSync(path.join(nested, "package.json"), pkg);

  const captured = captureConsole(() => runInit(nested));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /子目录|最外层/);
  assert.equal(fs.readFileSync(path.join(nested, "package.json"), "utf8"), pkg);
  assert.equal(fs.existsSync(path.join(nested, "AGENTS.md")), false);
});

test("init：.env* 只能覆盖密钥忽略规则，绝不能顶替 node_modules/", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"existing","private":true}\n');
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env*\n");
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }
  const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.env\*$/m);
  assert.match(gitignore, /^node_modules\/$/m);
});

test("init：沿用 pnpm／Yarn／Bun，不生成 package-lock，CI 与下一步也不混入 npm install", () => {
  const cases = [
    {
      name: "pnpm",
      declaration: "pnpm@9.12.0",
      lock: "pnpm-lock.yaml",
      install: "pnpm install",
      ciInstall: "pnpm install --frozen-lockfile",
    },
    {
      name: "yarn",
      declaration: "yarn@4.5.0",
      lock: "yarn.lock",
      install: "yarn install",
      ciInstall: "yarn install --immutable",
    },
    {
      name: "bun",
      declaration: "bun@1.1.0",
      lock: "bun.lock",
      install: "bun install",
      ciInstall: "bun install --frozen-lockfile",
    },
  ];

  for (const item of cases) {
    const dir = tmpProject();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: item.name, private: true, packageManager: item.declaration })}\n`,
    );
    fs.writeFileSync(path.join(dir, item.lock), "lock\n");
    const captured = captureConsole(() => runInit(dir));
    assert.equal(captured.result, 0, captured.output);
    assert.match(captured.output, new RegExp(item.install.replace(" ", "\\s")));
    assert.equal(fs.existsSync(path.join(dir, "package-lock.json")), false);

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.preflight, defaultPreflight(item.name));
    const ci = fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8");
    assert.match(ci, new RegExp(item.ciInstall.replaceAll(" ", "\\s")));
    assert.match(ci, new RegExp(`${item.name} run preflight`));
    assert.doesNotMatch(ci, /\bnpm (?:ci|install)\b/);
  }
});

test("init：包管理器线索冲突时在任何写入前拒绝，不猜一套继续", () => {
  const dir = tmpProject();
  const pkg = '{"name":"conflict","private":true,"packageManager":"pnpm@9.0.0"}\n';
  fs.writeFileSync(path.join(dir, "package.json"), pkg);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "pnpm\n");
  fs.writeFileSync(path.join(dir, "yarn.lock"), "yarn\n");

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /互相冲突/);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkg);
  assert.equal(fs.existsSync(path.join(dir, ".git")), false);
  assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), false);
});

test("init：CI 跟随仓库真实稳定分支，不把 master 硬改成 main", () => {
  const dir = tmpProject();
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"master-project","private":true}\n');
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }
  const ci = fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8");
  assert.match(ci, /branches: \["master"\]/);
  assert.doesNotMatch(ci, /branches: \["main"\]/);
});

test("init：失效 origin/HEAD 不覆盖真实 main，并把确认结果记进本仓库", () => {
  const dir = tmpProject();
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"main-project","private":true}\n');
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=boss",
      "-c",
      "user.email=boss@example.com",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: dir, stdio: "ignore" },
  );
  execFileSync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing"],
    { cwd: dir, stdio: "ignore" },
  );

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 0, captured.output);
  const ci = fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8");
  assert.match(ci, /branches: \["main"\]/);
  assert.equal(
    execFileSync("git", ["config", "--local", "--get", "bosscoding.stableBranch"], {
      cwd: dir,
      encoding: "utf8",
    }).trim(),
    "main",
  );
});

test("init：多个自定义分支且没有可信默认分支时零写入退出", () => {
  const dir = tmpProject();
  execFileSync("git", ["init", "-b", "develop"], { cwd: dir, stdio: "ignore" });
  const pkg = '{"name":"ambiguous-branch","private":true}\n';
  fs.writeFileSync(path.join(dir, "package.json"), pkg);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=boss",
      "-c",
      "user.email=boss@example.com",
      "commit",
      "-qm",
      "init",
    ],
    { cwd: dir, stdio: "ignore" },
  );
  execFileSync("git", ["branch", "release"], { cwd: dir, stdio: "ignore" });

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /找不到唯一的稳定分支/);
  assert.doesNotMatch(captured.output, /\n\s+at |Error:/);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkg);
  assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), false);
  assert.equal(fs.existsSync(path.join(dir, ".github")), false);
});

test("init：没有 Git 时用人话失败，不显示程序堆栈", () => {
  const dir = tmpProject();
  const child = spawnSync(process.execPath, [CLI, "init"], {
    cwd: dir,
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 1);
  assert.match(output, /还没有 Git/);
  assert.match(output, /把这句话交给 AI/);
  assert.doesNotMatch(output, /spawnSync|node:child_process|\n\s+at /);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("init：已有非 BossCoding AGENTS.md 时保护原文，并给 AI 可直接执行的合并提示", () => {
  const dir = tmpProject();
  const rules = "# 我的项目规则\n\n所有按钮都要有中文说明。\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), rules);

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 1);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), rules);
  assert.doesNotMatch(captured.output, /BossCoding 就位。你是老板/);
  assert.match(captured.output, /暂不能宣布完全就位/);
  assert.match(captured.output, /请把这整句话交给 AI/);
  assert.match(captured.output, /保留 AGENTS\.md 里的全部现有规则/);
});

test("init：CLAUDE 门牌含额外正文时不算就位，必须严格只导入 AGENTS.md", () => {
  const dir = tmpProject();
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "@AGENTS.md\n# 我自己的另一套规则\n");

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /暂不能宣布完全就位/);
  assert.match(captured.output, /CLAUDE\.md 已有独立内容/);
});

test("init：AGENTS／CLAUDE 软链只有守卫认可的精确目标才算就位", (t) => {
  const agentsDir = tmpProject();
  fs.writeFileSync(path.join(agentsDir, "package.json"), '{"name":"bad-agents-link","private":true}\n');
  fs.writeFileSync(
    path.join(agentsDir, "OTHER.md"),
    "# 规则\n\n## 导师模式\n大白话。\n\n## 干活流程\n检查。\n\n## 红线\n确认。\n",
  );
  try {
    fs.symlinkSync("OTHER.md", path.join(agentsDir, "AGENTS.md"));
  } catch {
    t.skip("当前平台不允许创建文件软链");
    return;
  }
  const badAgents = captureConsole(() => runInit(agentsDir));
  assert.equal(badAgents.result, 1);
  assert.match(badAgents.output, /AGENTS\.md 是软链.*不是 CLAUDE\.md/);
  assert.match(badAgents.output, /暂不能宣布完全就位/);
  assert.equal(fs.readlinkSync(path.join(agentsDir, "AGENTS.md")), "OTHER.md");

  const claudeDir = tmpProject();
  const unmute = muteConsole();
  try {
    assert.equal(runInit(claudeDir), 0);
  } finally {
    unmute();
  }
  fs.unlinkSync(path.join(claudeDir, "CLAUDE.md"));
  fs.symlinkSync("MISSING.md", path.join(claudeDir, "CLAUDE.md"));
  const badClaude = captureConsole(() => runInit(claudeDir));
  assert.equal(badClaude.result, 1);
  assert.match(badClaude.output, /CLAUDE\.md 是软链.*不是 AGENTS\.md/);
  assert.match(badClaude.output, /暂不能宣布完全就位/);
  assert.equal(fs.readlinkSync(path.join(claudeDir, "CLAUDE.md")), "MISSING.md");
});

test("init：技能入口冲突或 hook 指到仓库外时明确未完成，不宣称就位", () => {
  const dir = tmpProject();
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"conflicts","private":true}\n');
  const skill = path.join(dir, ".agents/skills/boss-flow/SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: my-own-flow\n---\n别覆盖。\n");
  const outsideHooks = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-init-outside-hooks-"));
  execFileSync("git", ["config", "core.hooksPath", outsideHooks], { cwd: dir, stdio: "ignore" });

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /暂不能宣布完全就位/);
  assert.match(captured.output, /技能入口已有不属于 BossCoding 的内容/);
  assert.match(captured.output, /core\.hooksPath 指向项目外/);
  assert.equal(fs.readFileSync(skill, "utf8").includes("别覆盖"), true);
  assert.deepEqual(fs.readdirSync(outsideHooks), []);
});

test("init：Git hook 路径探测失败时明确未完成，不制造假就位", () => {
  const dir = tmpProject();
  const captured = captureConsole(() =>
    runInit(dir, {
      hookExecFileSync: () => {
        throw new Error("git probe failed");
      },
    }),
  );
  assert.equal(captured.result, 1);
  assert.match(captured.output, /无法确认本项目的 Git hook 路径/);
  assert.match(captured.output, /暂不能宣布完全就位/);
  assert.doesNotMatch(captured.output, /BossCoding 就位。/);
});

test("init：同路径自定义 CI 与决策模板保留，并明确后续不会接管", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"custom-managed-paths","private":true}\n');
  const ciPath = path.join(dir, ".github/workflows/bosscoding.yml");
  const decisionPath = path.join(dir, "docs/decisions/_template.md");
  fs.mkdirSync(path.dirname(ciPath), { recursive: true });
  fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
  fs.writeFileSync(ciPath, "name: my-own-ci\n");
  fs.writeFileSync(decisionPath, "# 我的模板\n");

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /已有非 BossCoding 内容/);
  assert.match(captured.output, /暂不能宣布完全就位/);
  assert.equal(fs.readFileSync(ciPath, "utf8"), "name: my-own-ci\n");
  assert.equal(fs.readFileSync(decisionPath, "utf8"), "# 我的模板\n");
});

test("init：手工合并过核心规则的自定义 AGENTS 不会被反复催合并", () => {
  const dir = tmpProject();
  const rules =
    "# 我的项目规则\n\n## 导师模式\n大白话。\n\n## 干活流程\n先检查。\n\n## 红线\n先确认。\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), rules);

  const captured = captureConsole(() => runInit(dir));
  assert.equal(captured.result, 0);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), rules);
  assert.doesNotMatch(captured.output, /暂不能宣布完全就位|保留 AGENTS\.md 里的全部现有规则/);
});

test("init：已有 package.json 只注入不重写", () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "existing",
        version: "2.0.0",
        scripts: { test: 'echo "Error: no test specified" && exit 1', dev: "vite" },
      },
      null,
      2,
    )}\n`,
  );
  const unmute = muteConsole();
  try {
    runInit(dir);
  } finally {
    unmute();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "existing");
  assert.equal(pkg.version, "2.0.0");
  assert.equal(pkg.scripts.dev, "vite");
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.scripts.preflight, DEFAULT_PREFLIGHT);
});

test("init：已有自定义 preflight 保留原检查，并补齐产品测试与 BossCoding", () => {
  const dir = tmpProject();
  fs.writeFileSync(
    path.join(dir, "package.json"),
    '{"name":"existing","private":true,"scripts":{"test":"node --test","preflight":"npm run lint","lint":"node -e \\"process.exit(0)\\""}}\n',
  );
  const unmute = muteConsole();
  try {
    assert.equal(runInit(dir), 0);
  } finally {
    unmute();
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts["preflight:project"], "npm run lint");
  assert.equal(pkg.scripts.preflight, "npm run preflight:project && npm test && bosscoding check");
  const ci = fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8");
  assert.match(ci, /run: npm run preflight/);
  assert.doesNotMatch(ci, /run: npm (?:test|run lint)/);
});
