/**
 * check：跑全部守卫，任一红则以非零退出。
 * 输出纪律：每条问题必须带「修」指引，且指引只许指向真实存在的命令或文件——
 * 一道守卫的检查逻辑改坏了自己会报错，修复指引只是一句中文，仓库怎么改它都不会响，
 * 所以它必须简单到不会过时。
 *
 * 两个级别：问题不带 level 就是硬拦（红、非零退出）；带 level: "warn" 是提醒
 * （黄、不影响退出码）。提醒这一级只给「本版新加的检查」用——用户项目按兼容范围
 * 引用本包，发一次新版全网自动用上，新检查若直接硬拦，等于我们单方面把别人昨天
 * 还绿的仓库改红。见 docs/decisions/2026-07-27-new-checks-land-as-warnings.md。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createContext, paint } from "../context.mjs";
import { guards } from "../guards/index.mjs";

const FRAMEWORK_FILES = new Set([
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "package-lock.json",
  ".github/workflows/bosscoding.yml",
  ".gemini/settings.json",
  ".iflow/settings.json",
]);

function hasProductFiles(files) {
  return files.some(
    (file) =>
      !FRAMEWORK_FILES.has(file) &&
      !file.startsWith("docs/decisions/") &&
      !file.startsWith(".agents/skills/boss-") &&
      !file.startsWith(".claude/skills/boss-") &&
      file !== ".DS_Store",
  );
}

function gitTopLevel(root) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return fs.realpathSync(top);
  } catch {
    return null;
  }
}

export function runCheck(root = process.cwd()) {
  const requested = path.resolve(root);
  const top = gitTopLevel(requested);
  // check 只读，可以替老板自动回到项目最外层；此前直接拒绝虽不会假绿，
  // 仍把「切目录」这种后厨调度退给了老板。
  const ctx = createContext(top ?? requested);

  if (!ctx.isGitRepo()) {
    console.error(paint.red("✗ 当前目录不是 git 仓库，守卫需要 git 提供确定的文件清单。"));
    console.error("  修：新项目运行 npx -y @s-ry2005/bosscoding@latest init（会顺带创建版本记录）；已有项目让 AI 先建版本记录。");
    return 1;
  }

  let failed = 0;
  let warned = 0;
  let total = 0;
  for (const guard of guards) {
    total += 1;
    let problems;
    try {
      problems = guard.run(ctx);
    } catch (error) {
      problems = [
        {
          msg: `守卫自身执行出错：${error.message}`,
          fix: "这是 BossCoding 的问题不是你的问题，请到 bosscoding 仓库开 issue 附上本条输出。",
        },
      ];
    }
    if (problems.length === 0) {
      console.log(paint.green(`✓ ${guard.title}`));
      continue;
    }
    const hard = problems.filter((p) => p.level !== "warn");
    if (hard.length > 0) {
      failed += 1;
      console.log(paint.red(`✗ ${guard.title}（${problems.length} 处）`));
    } else {
      warned += 1;
      console.log(paint.yellow(`△ ${guard.title}（${problems.length} 处提醒，本次不算未过）`));
    }
    for (const p of problems) {
      const where = p.file ? `${p.file}${p.line ? `:${p.line}` : ""} ` : "";
      const body = `  ${where}${p.msg}`;
      console.log(p.level === "warn" ? paint.yellow(body) : body);
      console.log(paint.dim(`  修：${p.fix}`));
    }
  }

  console.log("");
  const warnTail = warned > 0 ? `（另有 ${warned} 项只提醒不拦：新加的检查先跑一个版本，下一版转硬拦）` : "";

  // 「绿」必须能被追问一句「你看了什么」——扫了 0 个文件的绿是假绿。
  let scanned = 0;
  let files = [];
  try {
    files = ctx.workingFiles();
    scanned = files.length;
  } catch {
    scanned = 0;
  }
  if (scanned === 0) {
    console.log(paint.yellow("△ 这个项目里还没有任何文件可查（空目录），所以下面的『通过』并不代表安全。"));
  }

  if (failed === 0) {
    console.log(paint.green(`BossCoding 协作地基通过：${total} 项守卫全绿（扫了 ${scanned} 个文件）。${warnTail}`));
    if (!hasProductFiles(files)) {
      console.log(paint.yellow("△ 当前只有协作地基，还没有可验收的产品页面或功能。"));
    }
    console.log(paint.dim("这只证明协作规则与文件卫生通过，不代表产品功能已经验收。"));
    return 0;
  }
  console.log(
    paint.red(`${failed}／${total} 项守卫未过。按上面的「修」逐条处理后重跑 npx bosscoding check。${warnTail}`),
  );
  console.log("你不用理解上面的术语。对 AI 说：「把 BossCoding 自检修到全绿，再告诉我结果。」");
  return 1;
}
