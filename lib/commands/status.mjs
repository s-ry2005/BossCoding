/**
 * status：一句话回答「我现在在哪一阶，下一步该干什么」。
 *
 * 为什么值得一个命令（实测事故，见 docs/decisions/2026-07-27-status-command.md）：
 * 四阶梯此前只活在技能文件里，也就是只活在**当前这轮对话的记忆**里。换个对话窗口、
 * 换台电脑、隔一周回来，老板和 AI 都无从知道项目走到哪儿了，只能靠读文档猜——
 * 而这套框架自己的规矩是「现在实际什么状态，跑命令看，不要读文档猜」。
 *
 * 只读：不装东西、不建仓库、不改任何文件。它只是把跑几条命令才能拼出来的事实
 * 摆成一句人话。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";
import { isGitHubRemote, redactRemote } from "../git-remote.mjs";
import { detectPackageManager } from "../package-manager.mjs";
import { dependencyState, readPackageState, testEntryState } from "../project-health.mjs";
import { defaultBase, mergedTaskWorktrees, worktreeEntries } from "./task.mjs";

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");
const HOOKS = [
  { name: "pre-commit", template: "main-worktree.sh" },
  { name: "post-checkout", template: "main-worktree.sh" },
  { name: "pre-push", template: "no-direct-push.sh" },
];
const SKILLS = ["boss-flow", "boss-ladder", "boss-closeout"];

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function tryGit(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** 当前提交是否真的存在于「此刻配置的」origin；旧的远端跟踪引用不算实时证据。 */
export function verifyRemoteUpload(root, head) {
  if (!head) return "missing";
  try {
    const output = execFileSync(
      "git",
      ["-c", "credential.interactive=never", "ls-remote", "--heads", "--tags", "origin"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
        },
      },
    );
    const hashes = output
      .split(/\r?\n/)
      .map((line) => /^([0-9a-f]{40,64})\s/i.exec(line)?.[1] ?? null)
      .filter(Boolean);
    return hashes.includes(head) ? "verified" : "missing";
  } catch {
    return "unknown";
  }
}

export { isGitHubRemote };

function projectFiles(abs, isRepo) {
  if (!isRepo) return [];
  return (tryGit(abs, ["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "")
    .split(/\r?\n/)
    .filter(Boolean);
}

/** 保守判定：宁可说「没看见」，也不把只有一条空 test 脚本的项目说成产品已验证。 */
function fileMatches(file, expected, executable = false) {
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    if (fs.readFileSync(file, "utf8") !== expected) return false;
    return !executable || process.platform === "win32" || (fs.statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function localAssets(abs, hooksDir) {
  const missingHooks = HOOKS.filter(({ name, template }) => {
    const expected = fs.readFileSync(path.join(TEMPLATES, "hooks", template), "utf8");
    return !hooksDir || !fileMatches(path.join(hooksDir, name), expected, true);
  }).map(({ name }) => name);

  const missingSkills = [];
  for (const skill of SKILLS) {
    const expected = fs.readFileSync(path.join(TEMPLATES, "skills", skill, "SKILL.md"), "utf8");
    for (const base of [".agents/skills", ".claude/skills"]) {
      const rel = `${base}/${skill}/SKILL.md`;
      const file = path.join(abs, rel);
      let isRealFile = false;
      try {
        isRealFile = fs.lstatSync(file).isFile();
      } catch {
        isRealFile = false;
      }
      if (!isRealFile || !fileMatches(file, expected)) missingSkills.push(rel);
    }
  }
  return {
    hooksReady: missingHooks.length === 0,
    missingHooks,
    skillsReady: missingSkills.length === 0,
    missingSkills,
  };
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

function realOrResolved(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function safeHooksDir(abs, isRepo) {
  if (!isRepo) return null;
  const raw = tryGit(abs, ["rev-parse", "--git-path", "hooks"]);
  const top = tryGit(abs, ["rev-parse", "--show-toplevel"]);
  const commonRaw = tryGit(abs, ["rev-parse", "--git-common-dir"]);
  if (!raw || !top || !commonRaw) return null;

  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(abs, raw);
  const common = path.isAbsolute(commonRaw) ? path.resolve(commonRaw) : path.resolve(abs, commonRaw);
  const logicalAllowed = [path.resolve(top), common].some((root) => inside(candidate, root));
  const realCandidate = realOrResolved(candidate);
  const realAllowed = [realOrResolved(top), realOrResolved(common)].some((root) => inside(realCandidate, root));
  return logicalAllowed && realAllowed ? candidate : null;
}

/** 探测四阶梯的当前位置。全部靠跑命令，不读任何声明式配置。 */
export function probe(root, options = {}) {
  const requested = path.resolve(root);
  const top = tryGit(requested, ["rev-parse", "--show-toplevel"]);
  // status 是只读体检，可以替老板自动找到项目最外层；不能把子目录的文件事实
  // 与整个仓库的 Git 事实拼成一张真假混合的体检单。
  const abs = top ? realOrResolved(top) : requested;
  const isRepo = tryGit(abs, ["rev-parse", "--is-inside-work-tree"]) === "true";
  const head = isRepo ? tryGit(abs, ["rev-parse", "--verify", "HEAD"]) : null;
  const hasCommit = head !== null;
  const origin = isRepo ? tryGit(abs, ["config", "--get", "remote.origin.url"]) : null;
  const remoteConfigured = Boolean(origin);
  const githubRemote = isGitHubRemote(origin);
  const originDisplay = redactRemote(origin);
  const unsaved = isRepo ? tryGit(abs, ["status", "--porcelain"]) : "";
  const unsavedChanges = isRepo && (unsaved === null || unsaved.length > 0);
  const uploadedRefs =
    githubRemote && hasCommit
      ? (tryGit(abs, [
          "for-each-ref",
          "--contains",
          "HEAD",
          "--format=%(refname)",
          "refs/remotes/origin/",
        ]) ?? "")
          .split(/\r?\n/)
          .filter((ref) => ref && ref !== "refs/remotes/origin/HEAD")
      : [];
  const localUploadRecord = uploadedRefs.length > 0;
  let remoteUploadState = "not-applicable";
  if (githubRemote && hasCommit) {
    const verdict = options.remoteVerifier
      ? options.remoteVerifier(abs, head)
      : "unknown";
    remoteUploadState = ["verified", "missing", "unknown"].includes(verdict)
      ? verdict
      : "unknown";
  }
  const currentCommitUploaded = remoteUploadState === "verified";
  const currentContentBackedUp = currentCommitUploaded && !unsavedChanges;
  const packageState = readPackageState(abs);
  const packageManager = detectPackageManager(abs, packageState.pkg);
  const dependencies = dependencyState(abs, packageState, packageManager);
  let entries = [];
  if (isRepo) {
    try {
      entries = worktreeEntries(abs);
    } catch {
      entries = [];
    }
  }
  const stableBranch = isRepo ? defaultBase(abs) : null;
  const worktrees = entries.length;
  // BossCoding 自己创建 lane/ 分支，但 Codex 默认用 codex/，其他 agent 也会用
  // feature/、fix/ 等名字。任务的事实是「它不是稳定分支」，不能靠某个前缀猜。
  const taskWorktrees = stableBranch
    ? entries.filter((entry) => entry.branch && entry.branch !== stableBranch)
    : [];
  const brokenTaskWorktrees = taskWorktrees.filter(
    (entry) => entry.prunable || !fs.existsSync(entry.path),
  );
  const branch = isRepo ? tryGit(abs, ["symbolic-ref", "--short", "HEAD"]) : null;
  const files = projectFiles(abs, isRepo);
  const taskBranch = Boolean(branch && stableBranch && branch !== stableBranch);
  const taskHead = taskBranch ? tryGit(abs, ["rev-parse", "HEAD"]) : null;
  const taskStart = taskBranch ? tryGit(abs, ["config", "--get", `branch.${branch}.bosscoding-start`]) : null;
  const taskAhead = stableBranch ? Number(tryGit(abs, ["rev-list", "--count", `${stableBranch}..HEAD`]) ?? 0) : 0;
  const taskHasCommittedChanges = taskBranch
    ? taskStart
      ? taskStart !== taskHead
      : taskAhead > 0
    : null;

  let agentsText = "";
  const intro = (() => {
    const file = path.join(abs, "AGENTS.md");
    if (!fs.existsSync(file)) return "missing";
    agentsText = fs.readFileSync(file, "utf8");
    const m = /<!-- bosscoding:intro-start -->([\s\S]*?)<!-- bosscoding:intro-end -->/.exec(agentsText);
    if (!m) return "custom"; // 老板自己改过结构，不评判
    return m[1].includes("本项目做什么、给谁用、跑在哪") ? "placeholder" : "filled";
  })();

  const rulesReady =
    agentsText.includes("## 干活流程") &&
    agentsText.includes("## 红线") &&
    (agentsText.includes("<!-- bosscoding:intro-start -->") || agentsText.includes("## 导师模式"));

  const hooksDir = safeHooksDir(abs, isRepo);
  const assets = localAssets(abs, hooksDir);
  const tests = testEntryState(abs, files, packageState);

  // 第 1 阶必须同时有 GitHub 身份和「当前提交曾上传」的本地证据；只填一个地址不算备份。
  const rung = githubRemote && currentCommitUploaded ? 1 : 0;
  return {
    abs,
    isRepo,
    hasCommit,
    origin,
    originDisplay,
    remoteConfigured,
    githubRemote,
    currentCommitUploaded,
    currentContentBackedUp,
    localUploadRecord,
    remoteUploadState,
    uploadedRefs,
    unsavedChanges,
    ...packageState,
    packageManager,
    ...dependencies,
    worktrees,
    taskWorktrees,
    brokenTaskWorktrees,
    branch,
    taskBranch,
    taskHasCommittedChanges,
    intro,
    rulesReady,
    hooksDir,
    ...assets,
    ...tests,
    // 兼容旧调用方；含义已收紧为「测试入口确实可执行」。
    hasProductTest: tests.testEntryConfigured,
    rung,
  };
}

export function runStatus(root = process.cwd(), options = {}) {
  const s = probe(root, {
    ...options,
    remoteVerifier: options.remoteVerifier ?? verifyRemoteUpload,
  });

  if (!s.isRepo) {
    console.log(paint.red("这里还不是一个项目（没有版本库）。"));
    console.log("  从这一步开始：npx bosscoding init");
    return 1;
  }
  const stale = mergedTaskWorktrees(s.abs);
  const stalePaths = new Set(stale.map((entry) => path.resolve(entry.path)));
  const activeTasks = s.taskWorktrees.filter(
    (entry) =>
      !entry.prunable &&
      fs.existsSync(entry.path) &&
      !stalePaths.has(path.resolve(entry.path)),
  );
  const currentTaskMerged =
    s.taskBranch && stalePaths.has(path.resolve(s.abs));

  console.log(paint.bold("你的项目现在在这儿："));

  // 阶梯位置。
  if (!s.remoteConfigured) {
    console.log(paint.green("  第 0–1 阶・本地阶段") + "：东西只在这台电脑上，还没有异地备份。");
  } else if (!s.githubRemote) {
    console.log(paint.yellow("  已配置远端，但不是 GitHub") + `：${s.originDisplay}`);
    console.log("    这里只能确认填过一个地址，不能据此说代码已经异地备份。");
  } else if (s.remoteUploadState === "missing") {
    console.log(paint.yellow("  已连接 GitHub，但当前版本不在这个远端") + `：${s.originDisplay}`);
    console.log("    地址已经配好；当前这版仍没有得到异地备份。");
  } else if (s.remoteUploadState === "unknown") {
    console.log(paint.yellow("  已连接 GitHub，但暂时无法确认当前远端") + `：${s.originDisplay}`);
    console.log(
      s.localUploadRecord
        ? "    本机留有一次旧上传记录，但远端地址可能换过；实时确认前不算已有备份。"
        : "    当前没有足够证据证明这版已经上传。",
    );
  } else if (s.unsavedChanges) {
    console.log(paint.yellow("  第 1 阶・已连 GitHub") + `：${s.originDisplay}`);
    console.log("    已提交版本有上传记录；另有未保存改动，这部分没有异地备份。");
  } else {
    console.log(paint.green("  第 1 阶・已连 GitHub") + `：${s.originDisplay}`);
    console.log("    当前已保存版本有上传记录；后续改动走 PR（一次改动的申请单），过质检再进主干。");
  }

  // 只陈述事实；所有修法集中在「下一步」，避免同一屏给老板五个动作。
  console.log("\n干活环境：");
  console.log(`  ${s.rulesReady ? "✓" : "✗"} BossCoding 规则${s.rulesReady ? "已识别" : "未识别"}`);
  console.log(
    `  ${s.hooksReady ? "✓" : "✗"} 本地门禁${
      s.hooksReady ? "三个都与当前版本一致" : `缺失或过期：${s.missingHooks.join("、")}`
    }`,
  );
  console.log(
    `  ${s.skillsReady ? "✓" : "✗"} AI 技能${
      s.skillsReady ? "四份都与当前版本一致" : `缺失或过期：${s.missingSkills.join("、")}`
    }`,
  );
  console.log(`  ${s.hasCommit ? "✓" : "✗"} 首个提交${s.hasCommit ? "已完成" : "还没有"}`);
  console.log(`  ${s.unsavedChanges ? "✗" : "✓"} 未保存改动${s.unsavedChanges ? "存在，尚未进入版本记录" : "没有"}`);
  if (s.hasPackageJson && !s.packageJsonValid) {
    console.log("  ✗ 项目配置 package.json 无法解析");
  } else if (s.packageManager.ambiguous) {
    console.log("  ✗ 项目同时出现多套安装工具的痕迹");
  } else if (s.hasPackageJson && s.dependenciesRequired) {
    console.log(
      `  ${s.depsInstalled ? "✓" : "✗"} 依赖${s.depsInstalled ? "已装" : "未完整安装"}`,
    );
  } else if (s.packageJsonValid) {
    console.log("  ✓ 这个项目没有需要另装的依赖");
  } else {
    console.log("  ○ 这个项目还没有 package.json");
  }
  if (s.intro === "filled") console.log("  ✓ 项目简介已填");
  if (s.intro === "placeholder") console.log("  ○ 项目简介还是占位符");
  if (s.intro === "custom") console.log("  ○ 使用自定义规则，无法自动判断项目简介");
  if (s.intro === "missing") console.log("  ✗ 没有 AGENTS.md 规则文件");
  console.log(`  ${s.testEntryConfigured ? "✓" : "○"} 测试入口${s.testEntryConfigured ? "已配置" : "还没配置"}`);
  if (s.taskBranch && !s.taskHasCommittedChanges) {
    console.log("  ○ 当前任务还没有新的已提交版本");
  }
  if (activeTasks.length > 0) {
    console.log(`  ✓ 进行中的任务：${activeTasks.length} 条（当前分支 ${s.branch ?? "游离状态"}）`);
  }
  if (s.brokenTaskWorktrees.length > 0) {
    console.log(`  ✗ 工作区登记异常：${s.brokenTaskWorktrees.length} 条任务的文件夹已不在原位置`);
  }

  if (stale.length > 0) {
    console.log(paint.dim(`\n已保留：${stale.length} 个任务工作区已经合并，不计入进行中，也不会自动删除。`));
  }

  // 下一步：永远只给一条，且是此刻真正该做的那条。
  console.log(paint.bold("\n下一步："));
  if (!s.rulesReady) {
    console.log("  对 AI 说：「确认这是我的产品项目，然后运行 npx bosscoding init，把 BossCoding 规则装完整。」");
  } else if (!s.hooksReady || !s.skillsReady) {
    console.log("  对 AI 说：「运行 npx -y bosscoding@latest update，恢复缺失或过期的本地门禁和 AI 技能，然后重新检查状态。」");
  } else if (!s.hasCommit) {
    console.log("  先把现在的东西存一版（对 AI 说「提交一下」）。");
  } else if (s.unsavedChanges) {
    console.log("  对 AI 说：「检查并妥善保存当前未提交改动，再重新检查状态。」");
  } else if (s.brokenTaskWorktrees.length > 0) {
    console.log("  对 AI 说：「先确认缺失的任务文件夹是否被移动、能否从备份找回，再安全修复工作区登记；不要直接删分支。」");
  } else if (s.taskBranch && !s.taskHasCommittedChanges) {
    console.log("  当前任务还没有产出；AI 继续完成需求并提交后，再进入验收。");
  } else if (s.hasPackageJson && !s.packageJsonValid) {
    console.log("  对 AI 说：「修好无法解析的 package.json，再重新检查状态。」");
  } else if (s.packageManager.ambiguous) {
    console.log("  对 AI 说：「确认项目原来用哪一种包管理器，只保留正确声明和一套锁文件，再重新检查状态。」");
  } else if (s.hasPackageJson && s.dependenciesRequired && !s.depsInstalled) {
    console.log("  对 AI 说：「把项目依赖安装完整，再跑一次自检。」");
  } else if (s.intro === "placeholder") {
    console.log("  对 AI 说：「陪我把 AGENTS.md 开头的项目简介填了。」");
  } else if (!s.testEntryConfigured) {
    console.log("  对 AI 说：「配置一条真正可执行的测试入口；默认 node --test 时至少放一条非空测试。」");
  } else if (s.taskBranch && !currentTaskMerged) {
    console.log("  对 AI 说：「把当前任务跑完自检并直接打开给我验收；我确认后，执行 BossCoding 收尾。」");
  } else if (stale.length > 0) {
    console.log("  继续说下一个产品需求；如果这是首版且你已验收满意，再让 AI 带你连 GitHub。");
  } else if (!s.remoteConfigured) {
    console.log("  东西做出来、你验收满意之后，对 AI 说：「带我连上 GitHub。」");
    console.log(paint.dim("  （免费，约十分钟，代码从此有异地备份，云端质检口也会自动亮起来）"));
  } else if (s.githubRemote && !s.currentCommitUploaded) {
    console.log(
      s.remoteUploadState === "missing"
        ? "  对 AI 说：「确认当前版本已经验收，再把它安全上传到现在连接的 GitHub 仓库，并重新检查状态。」"
        : "  对 AI 说：「检查 GitHub 连接与网络，确认当前版本是否真的已有异地备份；无法确认就不要报成功。」",
    );
  } else if (!s.githubRemote) {
    console.log("  对 AI 说：「检查这个远端地址是什么；确认代码真正上传后，再告诉我有没有异地备份。」");
  } else if (!s.currentCommitUploaded) {
    console.log("  对 AI 说：「把当前版本安全上传到已经连接的 GitHub；不要直推主干。」");
  } else {
    console.log("  照常干活：说需求 → AI 开分支做 → 你验收 → 合并。");
    console.log(paint.dim("  想给朋友用（要服务器）或想要自己的域名，直接跟 AI 说，它会带你走。"));
  }
  return 0;
}
