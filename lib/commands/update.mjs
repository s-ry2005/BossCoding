/**
 * update：把项目升级到「执行本命令的 BossCoding 版本」，再刷新框架管理的文件。
 *
 * 边界（守约）：规则真身 AGENTS.md 与门牌 CLAUDE.md 是老板的规则，本命令永不碰——
 * 「背后实时更新」只更新工具与质检，不远程改任何人的规则。模板有大改时，
 * 这里只打印新模板的位置，由老板（和他的 AI）自己对照决定要不要采纳。
 *
 * 技能与 git hook 允许「补装」而不只是刷新：新版本可能新增技能或门禁，
 * 只刷新已有文件的话，老用户永远拿不到新的。补装只对已装过 BossCoding 的
 * 项目做，免得在别人的仓库里凭空长出文件。
 *
 * 正常入口是 `npx -y @s-ry2005/bosscoding@latest update`：npm 先拿到最新 CLI，本模块再把
 * 项目 package.json、package-lock.json 与本地实际运行的包都对齐到该版本。
 * `refreshOnly` 留给已经完成依赖升级、只需要补本地文件的场景。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";
import { hasManagedDependency, managedDependencyName, packageIdentity } from "../package-identity.mjs";
import { installHooks } from "../hooks.mjs";
import {
  detectPackageManager,
  packageManagerCommand,
  renderCi,
} from "../package-manager.mjs";
import { ensurePreflightScripts } from "../preflight.mjs";
import { inspectProjectTarget } from "../safe-path.mjs";
import { installSkills } from "../skills.mjs";

// 旧版把 .claude/skills 下装成目录软链，本版换成真实副本，由 installSkills 就地迁移。

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");

const NPM_INSTALL_ARGS = ["install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
const NPM_RECOVERY_INSTALL_ARGS = ["install", "--include=dev", "--no-audit", "--no-fund"];
const NPM_RECOVERY_CI_ARGS = ["ci", "--include=dev", "--no-audit", "--no-fund"];
const LEGACY_MANAGED_HASHES = {
  ".github/workflows/bosscoding.yml":
    "ec2c7c831c1609c1ff115a8f5437666e95958fe1b7e08459091f78ac38cf571a",
  "docs/decisions/_template.md":
    "e2369208a36f46d1df35df093ba7db27863d381837598823ac9a37405023ec06",
};

function includesMarker(target, marker) {
  try {
    return fs.readFileSync(target, "utf8").includes(marker);
  } catch {
    return false;
  }
}

function hasDependency(pkg) {
  return hasManagedDependency(pkg);
}

function installedHere(abs, pkg) {
  return (
    hasDependency(pkg) ||
    includesMarker(path.join(abs, "AGENTS.md"), "<!-- bosscoding:intro-start -->") ||
    includesMarker(path.join(abs, ".github/workflows/bosscoding.yml"), "BossCoding 质检口")
  );
}

function lockVersion(target, dependencyName) {
  try {
    const lock = JSON.parse(fs.readFileSync(target, "utf8"));
    return lock?.packages?.[`node_modules/${dependencyName}`]?.version ?? lock?.dependencies?.[dependencyName]?.version ?? null;
  } catch {
    return null;
  }
}

function localPackageVersion(abs, dependencyName) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(abs, "node_modules", dependencyName, "package.json"), "utf8"),
    );
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function restoreFile(target, original) {
  if (original === null) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return;
  }
  fs.writeFileSync(target, original);
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function gitText(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitTopLevel(root) {
  const top = gitText(root, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  try {
    return fs.realpathSync(top);
  } catch {
    return path.resolve(top);
  }
}

function stableBranch(root) {
  const configured = gitText(root, [
    "config",
    "--local",
    "--get",
    "bosscoding.stableBranch",
  ]);
  if (configured) {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${configured}`], {
        cwd: root,
        stdio: "ignore",
      });
      return configured;
    } catch {
      // 旧记录指向已删除分支时，继续从当前仓库事实恢复。
    }
  }
  const remoteHead = gitText(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead?.startsWith("origin/")) {
    const candidate = remoteHead.slice("origin/".length);
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], {
        cwd: root,
        stdio: "ignore",
      });
      return candidate;
    } catch {
      // origin/HEAD 可能是换远端后留下的失效记录；没有同名本地分支就不能信。
    }
  }
  for (const candidate of ["main", "master", "trunk"]) {
    try {
      execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], {
        cwd: root,
        stdio: "ignore",
      });
      return candidate;
    } catch {
      // 继续找真实存在的稳定分支。
    }
  }
  const branches = (gitText(root, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]) ?? "")
    .split(/\r?\n/)
    .filter((name) => name && !name.startsWith("lane/"));
  if (branches.length === 1) return branches[0];
  if (branches.length === 0) {
    return gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "main";
  }
  return null;
}

function recoverPreviousInstall({ abs, runCommand, pkgPath, pkgBefore, lockPath, lockBefore }) {
  restoreFile(pkgPath, pkgBefore);
  restoreFile(lockPath, lockBefore);
  try {
    const recoveryArgs =
      lockBefore === null
        ? [...NPM_RECOVERY_INSTALL_ARGS, "--no-package-lock"]
        : NPM_RECOVERY_CI_ARGS;
    runCommand("npm", recoveryArgs, {
      cwd: abs,
      stdio: "pipe",
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

function printRecovery(recovered) {
  if (recovered) {
    console.error("  package.json、锁文件和本机依赖已恢复到更新前状态；AGENTS.md 从未改动。");
  } else {
    console.error("  package.json 与锁文件已恢复，但本机依赖可能部分变化；AGENTS.md 从未改动。");
  }
}

function ownedManagedFile(rel, current) {
  if (rel === ".github/workflows/bosscoding.yml") {
    if (current.includes("# bosscoding:managed-ci")) return true;
    return digest(current) === LEGACY_MANAGED_HASHES[rel];
  }
  if (rel === "docs/decisions/_template.md") {
    if (current.includes("<!-- bosscoding:managed-decision-template -->")) return true;
    return digest(current) === LEGACY_MANAGED_HASHES[rel];
  }
  return false;
}

/**
 * options 允许测试替换联网命令与 CLI 版本，不需要真的访问 npm：
 *   refreshOnly：只刷新管理文件；
 *   execFileSync：替代 npm 命令执行器；
 *   cliVersion：替代当前 CLI 包版本。
 */
export function runUpdate(root = process.cwd(), options = {}) {
  const requested = path.resolve(root);
  const refreshOnly = options.refreshOnly === true;
  const runCommand = options.execFileSync ?? execFileSync;
  const cliVersion = options.cliVersion ?? packageIdentity().version;
  let refreshed = 0;
  const pending = [];

  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    console.error(paint.red("✗ 这个产品文件夹不存在，BossCoding 没有执行更新。"));
    return 1;
  }
  const abs = fs.realpathSync(requested);

  const pkgPath = path.join(abs, "package.json");
  const pkgTarget = inspectProjectTarget(abs, "package.json");
  if (!pkgTarget.safe || (pkgTarget.stat !== null && !pkgTarget.stat.isFile())) {
    console.error(paint.red("✗ package.json 不是项目内的普通文件，BossCoding 没有更新任何文件。"));
    console.error('  把这句话交给 AI：「请检查 package.json 是否为软链、目录或指向项目外，修好后重新运行 BossCoding 更新。」');
    return 1;
  }
  let pkg = null;
  if (pkgTarget.stat !== null) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      console.error(paint.red("✗ package.json 已损坏，BossCoding 没有更新任何文件。"));
      console.error('  把这句话交给 AI：「请修好 package.json，再运行 npx -y @s-ry2005/bosscoding@latest update。」');
      return 1;
    }
  }

  if (!installedHere(abs, pkg)) {
    console.error(paint.red("✗ 这个文件夹还没有安装 BossCoding，所以没有执行更新。"));
    console.error('  把这句话交给 AI：「请确认这是我的产品文件夹，重新运行 BossCoding 初始化，再用项目原来的包管理器安装依赖。」');
    return 1;
  }

  const top = gitTopLevel(abs);
  if (top === null) {
    console.error(paint.red("✗ 当前文件夹不是 Git 项目，BossCoding 没有写入任何文件。"));
    console.error('  把这句话交给 AI：「请确认我打开的是正确产品文件夹，并先修好版本记录，再重新运行 BossCoding 更新。」');
    return 1;
  }
  if (top !== abs) {
    console.error(paint.red("✗ 当前文件夹只是 Git 项目的子目录，BossCoding 没有写入任何文件。"));
    console.error('  把这句话交给 AI：「请到这个 Git 项目的最外层文件夹重新运行 BossCoding 更新。」');
    return 1;
  }

  const manager = detectPackageManager(abs, pkg);
  if (manager.ambiguous) {
    console.error(
      paint.red(
        "✗ 包管理器的声明或锁文件互相冲突，BossCoding 没有安装、刷新或改写任何项目文件。",
      ),
    );
    console.error('  把这句话交给 AI：「请确认这个项目原来用哪一种包管理器，只保留正确的 packageManager 声明和一套锁文件，再重新运行 BossCoding 更新。」');
    return 1;
  }
  const branch = stableBranch(abs);
  if (!branch) {
    console.error(paint.red("✗ 找不到唯一的稳定分支，BossCoding 没有更新任何文件。"));
    console.error("  把这句话交给 AI：「确认哪一条分支代表稳定版本，再重新运行 BossCoding 更新；不要任选一条。」");
    return 1;
  }
  const rememberBranch = () => {
    try {
      execFileSync("git", ["config", "--local", "bosscoding.stableBranch", branch], {
        cwd: abs,
        stdio: "ignore",
      });
      return true;
    } catch {
      console.error(paint.red("✗ 无法记住项目的稳定分支，BossCoding 没有更新任何文件。"));
      console.error("  把这句话交给 AI：「检查本项目的 Git 配置权限，确认稳定分支后重新运行 BossCoding 更新。」");
      return false;
    }
  };

  if (refreshOnly && (pkg === null || !hasDependency(pkg))) {
    const installInstruction =
      pkg === null || manager.upgrade === null
        ? "请先修复 package.json，再用项目原来的包管理器添加 bosscoding"
        : `请运行 ${manager.upgrade}`;
    console.error(
      paint.red(
        "✗ BossCoding 安装不完整：refresh-only 只能刷新已正确安装依赖的项目，本次没有写入文件。",
      ),
    );
    console.error(
      `  把这句话交给 AI：「${installInstruction}；成功后用同一个包管理器执行 bosscoding update --refresh-only。」`,
    );
    return 1;
  }
  if (refreshOnly && !rememberBranch()) return 1;

  if (!refreshOnly) {
    if (pkg === null) {
      console.error(paint.red("✗ BossCoding 安装不完整：缺少 package.json，所以没有执行更新。"));
      console.error('  把这句话交给 AI：「请在这个产品文件夹重新运行 BossCoding 初始化，再用项目原来的包管理器安装依赖。」');
      return 1;
    }
    if (manager.name !== "npm") {
      const instruction =
        manager.upgrade === null
          ? "请先确认项目原来使用哪种包管理器，用它升级 bosscoding"
          : `请运行 ${manager.upgrade}`;
      const refreshInvocation = packageManagerCommand(manager, "exec-boss", {
        args: ["update", "--refresh-only"],
      });
      const refreshCommand = [refreshInvocation.command, ...refreshInvocation.args].join(" ");
      console.error(
        paint.red(
          `✗ 这是 ${manager.label} 项目。BossCoding 不会擅自运行 npm install，也不会生成 package-lock.json。`,
        ),
      );
      console.error(
        `  把这句话交给 AI：「${instruction}；成功后运行 ${refreshCommand}，再修到全绿。」`,
      );
      return 1;
    }
    if (!rememberBranch()) return 1;

    const pkgBefore = fs.readFileSync(pkgPath, "utf8");
    const shrinkwrapPath = path.join(abs, "npm-shrinkwrap.json");
    const lockPath = fs.existsSync(shrinkwrapPath)
      ? shrinkwrapPath
      : path.join(abs, "package-lock.json");
    const lockBefore = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null;
    const wanted = `^${cliVersion}`;
    const dependencyName = managedDependencyName(pkg);
    let packageChanged = false;

    pkg.scripts ??= {};
    if (ensurePreflightScripts(pkg.scripts, manager)) packageChanged = true;

    if (Object.hasOwn(pkg.dependencies ?? {}, dependencyName)) {
      if (pkg.dependencies[dependencyName] !== wanted) {
        pkg.dependencies[dependencyName] = wanted;
        packageChanged = true;
      }
    } else {
      pkg.devDependencies ??= {};
      if (pkg.devDependencies[dependencyName] !== wanted) {
        pkg.devDependencies[dependencyName] = wanted;
        packageChanged = true;
      }
    }

    const lockChanged = lockVersion(lockPath, dependencyName) !== cliVersion;
    const localChanged = localPackageVersion(abs, dependencyName) !== cliVersion;
    if (packageChanged || lockChanged || localChanged) {
      const lockTarget = inspectProjectTarget(abs, path.basename(lockPath));
      const modulesTarget = inspectProjectTarget(abs, "node_modules");
      if (
        !lockTarget.safe ||
        (lockTarget.stat !== null && !lockTarget.stat.isFile()) ||
        !modulesTarget.safe ||
        (modulesTarget.stat !== null && !modulesTarget.stat.isDirectory())
      ) {
        console.error(
          paint.red(
            "✗ 锁文件或 node_modules 不是项目内的普通文件夹／文件，BossCoding 没有运行 npm，也没有改写 package.json。",
          ),
        );
        console.error('  把这句话交给 AI：「请检查 package-lock.json、npm-shrinkwrap.json 与 node_modules 是否为软链或指向项目外，修好后重新运行 BossCoding 更新。」');
        return 1;
      }
      if (packageChanged) fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      try {
        runCommand("npm", NPM_INSTALL_ARGS, { cwd: abs, stdio: "pipe", encoding: "utf8" });
      } catch (error) {
        const recovered = recoverPreviousInstall({
          abs,
          runCommand,
          pkgPath,
          pkgBefore,
          lockPath,
          lockBefore,
        });
        if (error?.code === "ENOENT") {
          console.error(paint.red("✗ 这台电脑找不到 npm（Node.js 自带的安装工具），BossCoding 没有完成更新。"));
        } else {
          console.error(paint.red("✗ BossCoding 没更新成功：现在可能没联网，或网络暂时连不上软件仓库。"));
        }
        printRecovery(recovered);
        console.error('  把这句话交给 AI：「请检查 Node.js 和网络，恢复后重新运行 npx -y @s-ry2005/bosscoding@latest update；不要改 AGENTS.md。」');
        return 1;
      }

      if (
        lockVersion(lockPath, dependencyName) !== cliVersion ||
        localPackageVersion(abs, dependencyName) !== cliVersion
      ) {
        const recovered = recoverPreviousInstall({
          abs,
          runCommand,
          pkgPath,
          pkgBefore,
          lockPath,
          lockBefore,
        });
        console.error(paint.red("✗ npm 没有正确装好新版 BossCoding，项目版本文件已恢复。"));
        printRecovery(recovered);
        console.error('  把这句话交给 AI：「请检查 npm 为什么没有装好新版 BossCoding，再运行 npx -y @s-ry2005/bosscoding@latest update；不要改 AGENTS.md。」');
        return 1;
      }

      if (packageChanged) {
        console.log(paint.green(`↻ package.json（BossCoding ${cliVersion}）`));
        refreshed += 1;
      }
      if (lockBefore !== fs.readFileSync(lockPath, "utf8")) {
        console.log(
          paint.green(`↻ ${path.basename(lockPath)}（锁定 BossCoding ${cliVersion}）`),
        );
        refreshed += 1;
      }
      if (localChanged) {
        console.log(paint.green(`↻ 本机实际运行的 BossCoding（${cliVersion}）`));
        refreshed += 1;
      }
    }
  }
  if (refreshOnly && pkg !== null) {
    pkg.scripts ??= {};
    if (ensurePreflightScripts(pkg.scripts, manager)) {
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      console.log(paint.green(`↻ package.json（按 ${manager.label} 修正自检入口，未改依赖版本）`));
      refreshed += 1;
    }
  }

  const managed = [
    [
      ".github/workflows/bosscoding.yml",
      manager.name === "unknown"
        ? null
        : renderCi(fs.readFileSync(path.join(TEMPLATES, "ci.yml"), "utf8"), { manager, branch }),
    ],
    [
      "docs/decisions/_template.md",
      fs.readFileSync(path.join(TEMPLATES, "decision-template.md"), "utf8"),
    ],
  ];
  for (const [rel, next] of managed) {
    if (next === null) {
      pending.push(`${rel} 未生成：包管理器尚未确认。`);
      continue;
    }
    const target = path.join(abs, rel);
    const inspected = inspectProjectTarget(abs, rel);
    if (!inspected.safe) {
      pending.push(`${rel} 的上级路径不是项目内普通目录，已保护不覆盖。`);
      continue;
    }
    const targetStat = inspected.stat;
    if (targetStat === null) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, next);
      console.log(paint.green(`+ ${rel}（恢复缺失的官方文件）`));
      refreshed += 1;
      continue;
    }
    if (!targetStat.isFile()) {
      pending.push(`${rel} 已被其他类型的文件或链接占用，已保护不覆盖。`);
      continue;
    }
    const current = fs.readFileSync(target, "utf8");
    if (current === next) continue;
    if (!ownedManagedFile(rel, current)) {
      pending.push(`${rel} 已有非 BossCoding 内容，已保护不覆盖。`);
      continue;
    }
    fs.writeFileSync(target, next);
    console.log(paint.green(`↻ ${rel}`));
    refreshed += 1;
  }

  const skills = installSkills(abs);
  for (const rel of skills.created) {
    console.log(paint.green(`+ ${rel}（本版新增的技能）`));
    refreshed += 1;
  }
  for (const rel of skills.migrated) {
    console.log(paint.green(`↻ ${rel}（软链换成真实副本：软链在 Windows 上克隆会失效）`));
    refreshed += 1;
  }
  for (const rel of skills.refreshed) {
    console.log(paint.green(`↻ ${rel}`));
    refreshed += 1;
  }
  if (skills.skipped.length > 0) {
    pending.push(
      `以下技能入口已有不属于 BossCoding 的内容，已保护不覆盖：${skills.skipped.join("、")}。`,
    );
  }

  // git hook 不进版本库，clone 出来的副本天生是裸的——这里补装。
  const hooks = installHooks(abs, { execFileSync: options.hookExecFileSync });
  for (const name of [...hooks.installed, ...hooks.refreshed]) {
    console.log(paint.green(`↻ .git/hooks/${name}（本地门禁）`));
    refreshed += 1;
  }
  if (hooks.skipped.length > 0) {
    console.log(paint.yellow(`! 已有别人的 git hook（${hooks.skipped.join("、")}），未覆盖。`));
    pending.push(`以下 git hook 含用户内容或所有权不明，已保护不覆盖：${hooks.skipped.join("、")}。`);
  }
  pending.push(...hooks.blocked);

  if (pending.length > 0) {
    if (refreshed > 0) console.log(`\n已安全完成 ${refreshed} 项更新。`);
    console.log(paint.yellow("\n更新还没完成："));
    for (const item of pending) console.log(paint.yellow(`  ! ${item}`));
    console.log("把上面的内容交给 AI 处理；在全部解决前，BossCoding 不会宣称已是最新状态。");
  } else if (refreshed === 0) {
    console.log(
      refreshOnly
        ? "框架管理的文件已是当前版本，无需刷新。"
        : `BossCoding ${cliVersion} 与框架管理的文件都已是当前版本。`,
    );
  } else {
    console.log(`\n共完成 ${refreshed} 项更新。`);
  }
  console.log(
    paint.dim(
      `你的 AGENTS.md 从不被本命令改动；想对照最新规则模板：${path.join(TEMPLATES, "AGENTS.template.md")}`,
    ),
  );
  return pending.length > 0 ? 1 : 0;
}
