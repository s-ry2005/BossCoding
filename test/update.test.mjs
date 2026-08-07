import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runUpdate } from "../lib/commands/update.mjs";
import { DEFAULT_PREFLIGHT, defaultPreflight } from "../lib/preflight.mjs";

const CLI = fileURLToPath(new URL("../bin/bosscoding.mjs", import.meta.url));

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-update-"));
}

function initGit(dir) {
  const child = spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
}

function packageBody(version = "^0.3.0") {
  return `${JSON.stringify(
    {
      name: "existing-product",
      version: "1.0.0",
      private: true,
      devDependencies: { bosscoding: version },
    },
    null,
    2,
  )}\n`;
}

function lockBody(version, wanted = `^${version}`) {
  return `${JSON.stringify(
    {
      name: "existing-product",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { bosscoding: wanted } },
        "node_modules/bosscoding": { version },
      },
    },
    null,
    2,
  )}\n`;
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

test("update：未安装项目会失败，不再假装已经是当前版本", () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# 别人的规则\n");

  const child = spawnSync(process.execPath, [CLI, "update"], {
    cwd: dir,
    encoding: "utf8",
  });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 1);
  assert.match(output, /还没有安装 BossCoding/);
  assert.match(output, /把这句话交给 AI/);
  assert.doesNotMatch(output, /无需刷新|都已是当前版本|Error:|node:/);
  assert.equal(fs.existsSync(path.join(dir, ".agents")), false);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), "# 别人的规则\n");
});

test("update：latest CLI 升级 package.json 与锁定版本，再刷新管理文件", () => {
  const dir = tmpProject();
  initGit(dir);
  const agents = "# 老板自己的规则\n\n绝不能被 update 改写。\n";
  fs.writeFileSync(path.join(dir, "AGENTS.md"), agents);
  fs.writeFileSync(path.join(dir, "package.json"), packageBody());
  fs.writeFileSync(path.join(dir, "package-lock.json"), lockBody("0.3.0"));
  fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github/workflows/bosscoding.yml"),
    "# bosscoding:managed-ci\n# 旧质检文件\n",
  );

  let calls = 0;
  let invocation = null;
  const fakeNpm = (command, args, options) => {
    calls += 1;
    invocation = { command, args, options };
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg.devDependencies.bosscoding !== "^9.9.9") throw new Error("package version mismatch");
    fs.writeFileSync(path.join(dir, "package-lock.json"), lockBody("9.9.9"));
    fs.mkdirSync(path.join(dir, "node_modules/bosscoding"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "node_modules/bosscoding/package.json"),
      `${JSON.stringify({ name: "bosscoding", version: "9.9.9" })}\n`,
    );
  };

  const captured = captureConsole(() =>
    runUpdate(dir, { cliVersion: "9.9.9", execFileSync: fakeNpm }),
  );
  assert.equal(captured.result, 0, captured.output);
  assert.equal(calls, 1);
  assert.equal(invocation.command, "npm");
  assert.deepEqual(invocation.args, [
    "install",
    "--include=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  assert.equal(invocation.args.includes("--package-lock-only"), false);
  assert.equal(invocation.options.cwd, fs.realpathSync(dir));
  const updatedPackage = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(updatedPackage.devDependencies.bosscoding, "^9.9.9");
  assert.equal(updatedPackage.scripts.preflight, DEFAULT_PREFLIGHT);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"))
      .packages["node_modules/bosscoding"].version,
    "9.9.9",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "node_modules/bosscoding/package.json"), "utf8")).version,
    "9.9.9",
  );
  const ci = fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8");
  assert.match(ci, /branches: \["main"\]/);
  assert.doesNotMatch(ci, /__BOSSCODING_/);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), agents);
  assert.match(captured.output, /package\.json（BossCoding 9\.9\.9）/);
  assert.match(captured.output, /package-lock\.json（锁定 BossCoding 9\.9\.9）/);
});

test("update：离线失败说人话并恢复 package.json／锁文件，绝不改 AGENTS.md", () => {
  const dir = tmpProject();
  initGit(dir);
  const agents = "# 老板自己的规则\n";
  const pkgBefore = packageBody();
  const lockBefore = lockBody("0.3.0");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), agents);
  fs.writeFileSync(path.join(dir, "package.json"), pkgBefore);
  fs.writeFileSync(path.join(dir, "package-lock.json"), lockBefore);

  let calls = 0;
  const offline = () => {
    calls += 1;
    const error = new Error("network unreachable");
    error.code = "ENETUNREACH";
    throw error;
  };
  const captured = captureConsole(() =>
    runUpdate(dir, { cliVersion: "9.9.9", execFileSync: offline }),
  );

  assert.equal(captured.result, 1);
  assert.equal(calls, 2, "第一次升级失败后还应按旧锁尝试恢复本机依赖");
  assert.match(captured.output, /可能没联网/);
  assert.match(captured.output, /package\.json 与锁文件已恢复/);
  assert.match(captured.output, /本机依赖可能部分变化/);
  assert.match(captured.output, /把这句话交给 AI/);
  assert.doesNotMatch(captured.output, /network unreachable|\n\s+at /);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkgBefore);
  assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), lockBefore);
  assert.equal(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), agents);
});

test("update：refreshOnly 只补管理文件，不联网也不改依赖", () => {
  const dir = tmpProject();
  initGit(dir);
  const pkgBefore = packageBody();
  fs.writeFileSync(path.join(dir, "package.json"), pkgBefore);
  fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github/workflows/bosscoding.yml"),
    "# bosscoding:managed-ci\n# 旧质检文件\n",
  );

  let called = false;
  const captured = captureConsole(() =>
    runUpdate(dir, {
      refreshOnly: true,
      cliVersion: "9.9.9",
      execFileSync: () => {
        called = true;
        throw new Error("不该调用");
      },
    }),
  );

  assert.equal(captured.result, 0);
  assert.equal(called, false);
  const refreshedPackage = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(refreshedPackage.devDependencies.bosscoding, "^0.3.0");
  assert.equal(refreshedPackage.scripts.preflight, DEFAULT_PREFLIGHT);
  const ci = fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8");
  assert.match(ci, /BossCoding 质检口/);
  assert.match(ci, /branches: \["main"\]/);
  assert.doesNotMatch(ci, /__BOSSCODING_/);
});

test("update：升级失败后按旧锁重装；恢复成功才说本机依赖已恢复", () => {
  const dir = tmpProject();
  initGit(dir);
  const pkgBefore = packageBody();
  const lockBefore = lockBody("0.3.0");
  fs.writeFileSync(path.join(dir, "package.json"), pkgBefore);
  fs.writeFileSync(path.join(dir, "package-lock.json"), lockBefore);

  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "install") {
      fs.mkdirSync(path.join(dir, "node_modules/bosscoding"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "node_modules/bosscoding/package.json"),
        '{"name":"bosscoding","version":"8.8.8"}\n',
      );
      throw new Error("registry unavailable");
    }
    assert.equal(args[0], "ci");
    assert.equal(args.includes("--ignore-scripts"), false);
    assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkgBefore);
    assert.equal(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"), lockBefore);
    fs.writeFileSync(
      path.join(dir, "node_modules/bosscoding/package.json"),
      '{"name":"bosscoding","version":"0.3.0"}\n',
    );
  };

  const captured = captureConsole(() =>
    runUpdate(dir, { cliVersion: "9.9.9", execFileSync: runner }),
  );
  assert.equal(captured.result, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], "ci");
  assert.match(captured.output, /本机依赖已恢复到更新前状态/);
  assert.doesNotMatch(captured.output, /本机依赖可能部分变化/);
});

test("update：原来没有锁文件时，失败恢复也不凭空留下 package-lock", () => {
  const dir = tmpProject();
  initGit(dir);
  const pkgBefore = packageBody();
  fs.writeFileSync(path.join(dir, "package.json"), pkgBefore);

  const calls = [];
  const runner = (_command, args) => {
    calls.push(args);
    if (calls.length === 1) {
      fs.writeFileSync(path.join(dir, "package-lock.json"), lockBody("9.9.9"));
      throw new Error("install failed");
    }
    assert.equal(fs.existsSync(path.join(dir, "package-lock.json")), false);
    assert.ok(args.includes("--no-package-lock"));
    assert.equal(args.includes("--ignore-scripts"), false);
  };

  const captured = captureConsole(() =>
    runUpdate(dir, { cliVersion: "9.9.9", execFileSync: runner }),
  );
  assert.equal(captured.result, 1);
  assert.equal(calls.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkgBefore);
  assert.equal(fs.existsSync(path.join(dir, "package-lock.json")), false);
  assert.match(captured.output, /本机依赖已恢复到更新前状态/);
});

test("update：pnpm／Yarn／Bun 默认更新绝不运行 npm；原管理器升级后 refreshOnly 生成同源 CI", () => {
  const cases = [
    {
      name: "pnpm",
      declaration: "pnpm@9.12.0",
      lock: "pnpm-lock.yaml",
      upgrade: /pnpm add -D bosscoding@latest/,
      refresh: /pnpm exec bosscoding update --refresh-only/,
      ci: /pnpm install --frozen-lockfile/,
      preflight: /pnpm run preflight/,
    },
    {
      name: "yarn",
      declaration: "yarn@4.5.0",
      lock: "yarn.lock",
      upgrade: /yarn add -D bosscoding@latest/,
      refresh: /yarn exec bosscoding update --refresh-only/,
      ci: /yarn install --immutable/,
      preflight: /yarn run preflight/,
    },
    {
      name: "bun",
      declaration: "bun@1.1.0",
      lock: "bun.lock",
      upgrade: /bun add -d bosscoding@latest/,
      refresh: /bun run bosscoding update --refresh-only/,
      ci: /bun install --frozen-lockfile/,
      preflight: /bun run preflight/,
    },
  ];

  for (const item of cases) {
    const dir = tmpProject();
    initGit(dir);
    const pkgBefore = `${JSON.stringify(
      {
        name: item.name,
        private: true,
        packageManager: item.declaration,
        devDependencies: { bosscoding: "^0.3.0" },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(path.join(dir, "package.json"), pkgBefore);
    fs.writeFileSync(path.join(dir, item.lock), "lock\n");
    let calls = 0;
    const runner = () => {
      calls += 1;
      throw new Error("绝不该运行 npm");
    };

    const refused = captureConsole(() =>
      runUpdate(dir, { cliVersion: "9.9.9", execFileSync: runner }),
    );
    assert.equal(refused.result, 1);
    assert.equal(calls, 0);
    assert.match(refused.output, item.upgrade);
    assert.match(refused.output, item.refresh);
    assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkgBefore);
    assert.equal(fs.existsSync(path.join(dir, "package-lock.json")), false);

    const refreshed = captureConsole(() =>
      runUpdate(dir, {
        refreshOnly: true,
        cliVersion: "9.9.9",
        execFileSync: runner,
      }),
    );
    assert.equal(refreshed.result, 0, refreshed.output);
    assert.equal(calls, 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.devDependencies.bosscoding, "^0.3.0");
    assert.equal(pkg.scripts.preflight, defaultPreflight(item.name));
    assert.equal(fs.existsSync(path.join(dir, "package-lock.json")), false);
    const ci = fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8");
    assert.match(ci, item.ci);
    assert.match(ci, item.preflight);
    assert.doesNotMatch(ci, /\bnpm (?:ci|install)\b|npx boss|bunx boss/);
  }
});

test("update：包管理器冲突时 refreshOnly 也在任何写入前拒绝", () => {
  const dir = tmpProject();
  initGit(dir);
  const pkg = '{"name":"conflict","private":true,"packageManager":"pnpm@9.0.0","devDependencies":{"bosscoding":"^0.3.0"}}\n';
  fs.writeFileSync(path.join(dir, "package.json"), pkg);
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "pnpm\n");
  fs.writeFileSync(path.join(dir, "yarn.lock"), "yarn\n");

  const captured = captureConsole(() =>
    runUpdate(dir, {
      refreshOnly: true,
      execFileSync: () => {
        throw new Error("不该调用");
      },
    }),
  );
  assert.equal(captured.result, 1);
  assert.match(captured.output, /互相冲突/);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkg);
  assert.equal(fs.existsSync(path.join(dir, ".github/workflows/bosscoding.yml")), false);
  assert.equal(fs.existsSync(path.join(dir, ".agents")), false);
});

test("update：refreshOnly 遇到缺 package.json 或缺 bosscoding 依赖时拒绝假刷新", () => {
  for (const kind of ["missing-package", "missing-dependency"]) {
    const dir = tmpProject();
    initGit(dir);
    fs.writeFileSync(
      path.join(dir, "AGENTS.md"),
      "<!-- bosscoding:intro-start -->\n<!-- bosscoding:intro-end -->\n",
    );
    if (kind === "missing-dependency") {
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"incomplete","private":true}\n');
    }

    const captured = captureConsole(() => runUpdate(dir, { refreshOnly: true }));
    assert.equal(captured.result, 1);
    assert.match(captured.output, /安装不完整|添加 bosscoding/);
    assert.equal(fs.existsSync(path.join(dir, ".github")), false);
    assert.equal(fs.existsSync(path.join(dir, ".agents")), false);
  }
});

test("update：包文件、锁文件、node_modules 与管理目录的软链都不跟随", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bosscoding-update-symlink-outside-"));

  const packageDir = tmpProject();
  initGit(packageDir);
  const externalPackage = path.join(outside, "package.json");
  fs.writeFileSync(externalPackage, packageBody());
  try {
    fs.symlinkSync(externalPackage, path.join(packageDir, "package.json"));
  } catch {
    t.skip("当前平台不允许创建软链");
    return;
  }
  const packageResult = captureConsole(() => runUpdate(packageDir, { refreshOnly: true }));
  assert.equal(packageResult.result, 1);
  assert.match(packageResult.output, /package\.json 不是项目内的普通文件/);
  assert.equal(fs.readFileSync(externalPackage, "utf8"), packageBody());

  const lockDir = tmpProject();
  initGit(lockDir);
  fs.writeFileSync(path.join(lockDir, "package.json"), packageBody());
  const externalLock = path.join(outside, "package-lock.json");
  fs.writeFileSync(externalLock, lockBody("0.3.0"));
  fs.symlinkSync(externalLock, path.join(lockDir, "package-lock.json"));
  let npmCalls = 0;
  const lockResult = captureConsole(() =>
    runUpdate(lockDir, {
      cliVersion: "9.9.9",
      execFileSync: () => {
        npmCalls += 1;
      },
    }),
  );
  assert.equal(lockResult.result, 1);
  assert.equal(npmCalls, 0);
  assert.equal(fs.readFileSync(externalLock, "utf8"), lockBody("0.3.0"));

  const modulesDir = tmpProject();
  initGit(modulesDir);
  const modulesPackage = packageBody();
  fs.writeFileSync(path.join(modulesDir, "package.json"), modulesPackage);
  fs.writeFileSync(path.join(modulesDir, "package-lock.json"), lockBody("0.3.0"));
  const externalModules = path.join(outside, "node_modules");
  fs.mkdirSync(externalModules);
  fs.symlinkSync(externalModules, path.join(modulesDir, "node_modules"));
  const modulesResult = captureConsole(() =>
    runUpdate(modulesDir, {
      cliVersion: "9.9.9",
      execFileSync: () => {
        npmCalls += 1;
      },
    }),
  );
  assert.equal(modulesResult.result, 1);
  assert.match(modulesResult.output, /锁文件或 node_modules/);
  assert.equal(npmCalls, 0);
  assert.equal(fs.readFileSync(path.join(modulesDir, "package.json"), "utf8"), modulesPackage);

  const managedDir = tmpProject();
  initGit(managedDir);
  fs.writeFileSync(path.join(managedDir, "package.json"), packageBody());
  const externalGithub = path.join(outside, "github");
  fs.mkdirSync(externalGithub);
  fs.symlinkSync(externalGithub, path.join(managedDir, ".github"));
  const managedResult = captureConsole(() =>
    runUpdate(managedDir, { refreshOnly: true }),
  );
  assert.equal(managedResult.result, 1);
  assert.match(managedResult.output, /上级路径不是项目内普通目录/);
  assert.deepEqual(fs.readdirSync(externalGithub), []);
});

test("update：Git 子目录拒绝刷新，不新增或改写任何框架文件", () => {
  const root = tmpProject();
  initGit(root);
  const nested = path.join(root, "packages/app");
  fs.mkdirSync(nested, { recursive: true });
  const pkg = packageBody();
  fs.writeFileSync(path.join(nested, "package.json"), pkg);

  const captured = captureConsole(() => runUpdate(nested, { refreshOnly: true }));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /子目录|最外层/);
  assert.equal(fs.readFileSync(path.join(nested, "package.json"), "utf8"), pkg);
  assert.equal(fs.existsSync(path.join(nested, ".github")), false);
});

test("update：恢复缺失的官方 CI 与决策模板，并按真实 master 分支渲染", () => {
  const dir = tmpProject();
  const initialized = spawnSync("git", ["init", "-b", "master"], { cwd: dir, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.writeFileSync(path.join(dir, "package.json"), packageBody());

  const captured = captureConsole(() => runUpdate(dir, { refreshOnly: true }));
  assert.equal(captured.result, 0, captured.output);
  const ciPath = path.join(dir, ".github/workflows/bosscoding.yml");
  const decisionPath = path.join(dir, "docs/decisions/_template.md");
  assert.ok(fs.existsSync(ciPath));
  assert.ok(fs.existsSync(decisionPath));
  assert.match(fs.readFileSync(ciPath, "utf8"), /branches: \["master"\]/);
  assert.match(fs.readFileSync(decisionPath, "utf8"), /bosscoding:managed-decision-template/);
  assert.match(captured.output, /恢复缺失的官方文件/);
});

test("update：失效 origin/HEAD 回退真实 main，并记住稳定分支", () => {
  const dir = tmpProject();
  initGit(dir);
  fs.writeFileSync(path.join(dir, "package.json"), packageBody());
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
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
    { cwd: dir },
  );
  spawnSync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing"],
    { cwd: dir },
  );

  const captured = captureConsole(() => runUpdate(dir, { refreshOnly: true }));
  assert.equal(captured.result, 0, captured.output);
  assert.match(
    fs.readFileSync(path.join(dir, ".github/workflows/bosscoding.yml"), "utf8"),
    /branches: \["main"\]/,
  );
  assert.equal(
    spawnSync("git", ["config", "--local", "--get", "bosscoding.stableBranch"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim(),
    "main",
  );
});

test("update：多个自定义分支且没有可信默认分支时不改 package 或 CI", () => {
  const dir = tmpProject();
  const initialized = spawnSync("git", ["init", "-b", "develop"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const pkg = packageBody();
  fs.writeFileSync(path.join(dir, "package.json"), pkg);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync(
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
    { cwd: dir },
  );
  spawnSync("git", ["branch", "release"], { cwd: dir });

  const captured = captureConsole(() => runUpdate(dir, { refreshOnly: true }));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /找不到唯一的稳定分支/);
  assert.doesNotMatch(captured.output, /\n\s+at |Error:/);
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkg);
  assert.equal(fs.existsSync(path.join(dir, ".github")), false);
});

test("update：Git hook 路径探测失败时返回未完成，绝不宣称最新", () => {
  const dir = tmpProject();
  initGit(dir);
  fs.writeFileSync(path.join(dir, "package.json"), packageBody());

  const captured = captureConsole(() =>
    runUpdate(dir, {
      refreshOnly: true,
      hookExecFileSync: () => {
        throw new Error("git probe failed");
      },
    }),
  );
  assert.equal(captured.result, 1);
  assert.match(captured.output, /无法确认本项目的 Git hook 路径/);
  assert.match(captured.output, /更新还没完成/);
  assert.doesNotMatch(captured.output, /已是当前版本|无需刷新/);
});

test("update：同路径自定义 CI／决策模板与同名技能、合并 hook 都保留，并明确未完成", () => {
  const dir = tmpProject();
  initGit(dir);
  fs.writeFileSync(path.join(dir, "package.json"), packageBody());
  const ciPath = path.join(dir, ".github/workflows/bosscoding.yml");
  const decisionPath = path.join(dir, "docs/decisions/_template.md");
  fs.mkdirSync(path.dirname(ciPath), { recursive: true });
  fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
  fs.writeFileSync(ciPath, "name: my-own-ci\n");
  fs.writeFileSync(decisionPath, "# 我的决策模板\n");
  const skillPath = path.join(dir, ".agents/skills/boss-flow/SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, "---\nname: boss-flow\n---\n这是我的同名技能。\n");

  // 先装纯官方 hook，再追加用户命令，模拟按 init 提示合并过的真实形态。
  const first = captureConsole(() => runUpdate(dir, { refreshOnly: true }));
  assert.equal(first.result, 1, first.output);
  const hookPath = path.join(dir, ".git/hooks/pre-commit");
  fs.appendFileSync(hookPath, "\nnode my-check.mjs\n");
  const ciBefore = fs.readFileSync(ciPath, "utf8");
  const decisionBefore = fs.readFileSync(decisionPath, "utf8");
  const skillBefore = fs.readFileSync(skillPath, "utf8");

  const captured = captureConsole(() => runUpdate(dir, { refreshOnly: true }));
  assert.equal(captured.result, 1);
  assert.match(captured.output, /更新还没完成/);
  assert.doesNotMatch(captured.output, /都已是当前版本/);
  assert.equal(fs.readFileSync(ciPath, "utf8"), ciBefore);
  assert.equal(fs.readFileSync(decisionPath, "utf8"), decisionBefore);
  assert.equal(fs.readFileSync(skillPath, "utf8"), skillBefore);
  assert.match(fs.readFileSync(hookPath, "utf8"), /node my-check\.mjs/);
});

test("update：完整收尾技能刷新官方版本但保护用户同名版本", () => {
  const dir = tmpProject();
  initGit(dir);
  fs.writeFileSync(path.join(dir, "package.json"), packageBody());
  assert.equal(runUpdate(dir, { refreshOnly: true }), 0);

  const official = path.join(dir, ".agents/skills/boss-closeout/SKILL.md");
  fs.appendFileSync(official, "\n旧版残留\n");
  assert.equal(runUpdate(dir, { refreshOnly: true }), 0);
  assert.doesNotMatch(fs.readFileSync(official, "utf8"), /旧版残留/);

  const custom = path.join(dir, ".claude/skills/boss-closeout/SKILL.md");
  fs.writeFileSync(custom, "---\nname: boss-closeout\n---\n\n我的收尾规则。\n");
  const result = runUpdate(dir, { refreshOnly: true });
  assert.equal(result, 1);
  assert.match(fs.readFileSync(custom, "utf8"), /我的收尾规则/);
});
