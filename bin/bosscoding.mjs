#!/usr/bin/env node
/**
 * BossCoding 命令入口。七个命令，没有更多：
 *   init    开司筹备：把流程地基装进当前项目（幂等，不覆盖已有内容）
 *   status  我在四阶梯的哪一阶、下一步该干什么（只读）
 *   check   跑守卫：任一机器检查标红即非零退出
 *   task    开并行任务：独立工作区＋分支，一条命令（只建不删）
 *   finish  验收后收尾：自检并把任务安全并回主干
 *   update  刷新框架管理的文件（老板的规则永不被碰）
 *   merge   排队判定：现在轮不轮得到我合并（只读，不替你合）
 *
 * 用户可复制的命令只写唯一全名 `bosscoding`；短名与 npm 上的第三方包重名，
 * 依赖没装好时可能执行错包，所以只保留为旧项目兼容入口，不再展示。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `BossCoding——你是老板：需求你说，AI 干活，制度验收。

用法：
  npx -y @s-ry2005/bosscoding@latest init      第一次使用：给当前产品装好协作地基
  npx bosscoding status              看真实进度，以及此刻唯一的下一步
  npx bosscoding check               检查协作地基有没有明显风险
  npx bosscoding task <任务名>       给一项新需求开独立工作区
  npx bosscoding finish              验收后自检，并把当前任务安全并回主干
  npx -y @s-ry2005/bosscoding@latest update    升级 BossCoding，再刷新它管理的文件
  npx bosscoding merge               只问「现在轮到这项任务合并了吗」

你不必记命令。装好后只需对 AI 说：
「读一遍 AGENTS.md。之后我说需求，你负责做到能让我直接验收。」

始终使用全名 bosscoding，避免误执行 npm 上的同名第三方包。
`;

async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  if (cmd === "--version" || cmd === "-v") {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(fileURLToPath(new URL("../", import.meta.url)), "package.json"), "utf8"),
    );
    console.log(pkg.version);
    return 0;
  }

  // 帮助必须永远只读。此前 `init --help` 会真的安装文件，是小白最危险的反直觉入口。
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  // 修改型命令不许默默吞掉拼错的参数；`init --hepl` 曾因此真的往目录里写文件。
  const noArgs = new Set(["init", "check", "status", "finish"]);
  let badArgs = false;
  if (noArgs.has(cmd)) badArgs = args.length > 0;
  if (cmd === "update") badArgs = args.length > 1 || (args.length === 1 && args[0] !== "--refresh-only");
  if (cmd === "merge") {
    badArgs =
      args.length !== 0 &&
      !(args.length === 2 && args[0] === "--pr" && Number.isInteger(Number(args[1])) && Number(args[1]) > 0);
  }
  if (cmd === "task") badArgs = args.some((arg) => arg.startsWith("--"));
  if (badArgs) {
    console.error(`✗ 命令「${cmd}」后面有不认识的参数：${args.join(" ")}`);
    console.error(`  先运行 npx bosscoding ${cmd} --help 查看正确用法；本次没有执行任何操作。`);
    return 1;
  }

  if (cmd === "init") {
    const { runInit } = await import("../lib/commands/init.mjs");
    return runInit();
  }
  if (cmd === "check") {
    const { runCheck } = await import("../lib/commands/check.mjs");
    return runCheck();
  }
  if (cmd === "status") {
    const { runStatus } = await import("../lib/commands/status.mjs");
    return runStatus();
  }
  if (cmd === "task") {
    const { runTask } = await import("../lib/commands/task.mjs");
    return runTask(process.cwd(), args.join(" "));
  }
  if (cmd === "finish") {
    const { runFinish } = await import("../lib/commands/finish.mjs");
    return runFinish();
  }
  if (cmd === "update") {
    const { runUpdate } = await import("../lib/commands/update.mjs");
    return runUpdate(process.cwd(), { refreshOnly: args.includes("--refresh-only") });
  }
  if (cmd === "merge") {
    const { runMerge } = await import("../lib/commands/merge.mjs");
    const flag = args.indexOf("--pr");
    const prNumber = flag >= 0 ? Number(args[flag + 1]) : null;
    return runMerge(process.cwd(), { prNumber: Number.isFinite(prNumber) ? prNumber : null });
  }

  if (cmd !== undefined && cmd !== "--help" && cmd !== "-h") {
    console.error(`✗ 不认识命令「${cmd}」。下面是 BossCoding 真正支持的命令：\n`);
  }
  console.log(HELP);
  return cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 1;
}

// Windows 兼容：子进程句柄关闭期间直接 process.exit 会触发 libuv 断言
// （src/win/async.c，表现为 exit 127）。只设 exitCode 让事件循环自然结束；
// 兜底定时器防残留句柄挂起，unref 保证不阻挡正常退出。
function settle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}

try {
  settle(await main());
} catch {
  console.error("✗ BossCoding 遇到意外问题，本次没有完成。");
  console.error("  把这句话交给 AI：「检查当前项目状态和文件权限，找出 BossCoding 命令失败的原因，修好后重试；不要把原始报错丢给我。」");
  settle(1);
}
