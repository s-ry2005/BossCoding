/**
 * init：开司筹备队。把整套流程地基装进当前目录，幂等、绝不覆盖用户已有内容。
 *
 * 覆盖纪律：AGENTS.md 与 CLAUDE.md 是老板的规则，存在即跳过；
 * 框架管理的文件（CI、决策模板、技能）由 `bosscoding update` 负责刷新。
 * 执行者往往是 agent 而不是人，所以「跳过」时要打印出下一步该怎么办的指引。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paint } from "../context.mjs";
import { packageIdentity } from "../package-identity.mjs";
import { installHooks } from "../hooks.mjs";
import { detectPackageManager, renderCi } from "../package-manager.mjs";
import { defaultPreflight, ensurePreflightScripts } from "../preflight.mjs";
import { inspectProjectTarget } from "../safe-path.mjs";
import { installSkills } from "../skills.mjs";

const TEMPLATES = path.join(fileURLToPath(new URL("../../", import.meta.url)), "templates");

const CLAUDE_STUB = `<!-- 规则真身在 AGENTS.md（单一规则源，由 BossCoding 守卫盯着）；本文件只是给 Claude Code 的门牌，不要在这里写规则。 -->\n@AGENTS.md\n`;

const NPM_DEFAULT_TEST = /^echo .Error: no test specified. && exit 1$/;

const GITIGNORE_LINES = ["node_modules/", ".env", ".env.local", ".env.*.local"];

const PROJECT_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "Dockerfile",
  "Makefile",
  "CMakeLists.txt",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".yarnrc.yml",
  ".yarn",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "deno.json",
  "deno.jsonc",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
  "Cargo.toml",
  "go.mod",
  "go.sum",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "Package.swift",
]);

const EMPTY_FOLDER_LEFTOVERS = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const LEGACY_CI_HASH = "ec2c7c831c1609c1ff115a8f5437666e95958fe1b7e08459091f78ac38cf571a";

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES, name), "utf8");
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function directoryState(abs) {
  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((entry) => !EMPTY_FOLDER_LEFTOVERS.has(entry.name));
  const looksLikeProject = entries.some((entry) => {
    if (PROJECT_FILES.has(entry.name)) return true;
    if (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".sln")) return true;
    return false;
  });
  return { empty: entries.length === 0, looksLikeProject };
}

function hasAgentContext(target, kind) {
  try {
    const settings = JSON.parse(fs.readFileSync(target, "utf8"));
    const value = kind === "gemini" ? settings?.context?.fileName : settings?.contextFileName;
    return value === "AGENTS.md" || (Array.isArray(value) && value.includes("AGENTS.md"));
  } catch {
    return false;
  }
}

function hasBossCodingRules(text) {
  const hasWorkflow = text.includes("## 干活流程");
  const hasRedlines = text.includes("## 红线");
  const hasMarker =
    text.includes("<!-- bosscoding:intro-start -->") &&
    text.includes("<!-- bosscoding:intro-end -->");
  return hasWorkflow && hasRedlines && (hasMarker || text.includes("## 导师模式"));
}

function lstat(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function exactLink(target, expected) {
  const stat = lstat(target);
  if (!stat?.isSymbolicLink()) return false;
  try {
    return fs.readlinkSync(target) === expected;
  } catch {
    return false;
  }
}

function readIfRegularOrValidLink(target) {
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

function isClaudeImportStub(text) {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
  const lines = withoutComments
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0] === "@AGENTS.md";
}

/**
 * 文件夹名 → 合法的 npm 包名。
 *
 * 实测踩过：老版本把每个非 ASCII 字符换成一个连字符，「我的第一个产品」变成了
 * 七个横杠——npm 规则里这不是合法名字，而且此后每条 npm 输出都顶着一串横杠。
 * 中文文件夹名对目标用户是常态，所以：非法字符整段折成一个连字符，掐掉首尾，
 * 全被掐光就退回一个老实的默认名。
 */
export function packageNameFrom(basename) {
  const name = (basename ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "my-project";
}

function gitText(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
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

export function initializeGit(root, runGit = execFileSync) {
  try {
    runGit("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    return;
  } catch (error) {
    const unsupportedOption =
      error?.status === 129 ||
      /unknown (?:option|switch).*['"]?b|usage:\s*git init/i.test(
        `${error?.stderr ?? ""}${error?.message ?? ""}`,
      );
    if (!unsupportedOption) throw error;
    // Git 2.28 之前没有 `git init -b`。普通初始化后直接设置未出生分支的 HEAD，
    // 不要求用户理解或升级 Git。
    runGit("git", ["init"], { cwd: root, stdio: "ignore" });
    runGit("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
      cwd: root,
      stdio: "ignore",
    });
  }
}

/**
 * 不许在这些地方开工：家目录本身，以及桌面／文档／下载这类「东西堆」。
 * 实测：在堆着简历、报税表的文件夹里 init 会一声不吭地把它变成版本库，
 * 之后一次 `git add -A` 就把私人文件全收进去了。执行者常常是 agent，
 * 而 agent 的当前目录很可能就是家目录——这不是边缘情况。
 */
const FORBIDDEN_BASENAMES = new Set([
  "Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures", "Public",
  "桌面", "文档", "下载", "图片", "音乐", "影片",
]);

export function refuseReason(abs) {
  const resolved = path.resolve(abs);
  const target = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const lexicalHome = path.resolve(os.homedir());
  const home = fs.realpathSync(lexicalHome);
  if (target === home) return "这是你的用户主目录（家目录）";
  if (target === path.parse(target).root) return "这是磁盘根目录";
  if (path.dirname(resolved) === lexicalHome && FORBIDDEN_BASENAMES.has(path.basename(resolved))) {
    return `这是系统的「${path.basename(resolved)}」文件夹，是东西堆不是项目`;
  }

  const tempRoots = new Set();
  for (const candidate of [os.tmpdir(), "/tmp"]) {
    try {
      tempRoots.add(fs.realpathSync(candidate));
    } catch {
      // 这个平台没有该临时目录。
    }
  }
  if (tempRoots.has(target)) return "这是系统临时目录的根，里面会混放许多程序的文件";

  for (const basename of FORBIDDEN_BASENAMES) {
    const candidate = path.join(home, basename);
    try {
      if (fs.realpathSync(candidate) === target) {
        return `这是系统的「${basename}」文件夹，是东西堆不是项目`;
      }
    } catch {
      // 用户没有这个系统文件夹。
    }
  }
  return null;
}

export function runInit(root = process.cwd(), options = {}) {
  const requested = path.resolve(root);
  const done = [];
  const skipped = [];
  const notes = [];

  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) {
    console.error(paint.red("✗ 这个产品文件夹不存在，BossCoding 没有开始安装。"));
    console.error('  把这句话交给 AI：「请新建一个只放这个产品的文件夹，在里面重新运行 npx -y @s-ry2005/bosscoding@latest init。」');
    return 1;
  }
  const abs = fs.realpathSync(requested);

  const refuse = refuseReason(abs);
  if (refuse) {
    console.error(paint.red(`✗ 不能在这里开工：${refuse}。`));
    console.error("  把整个文件夹变成代码仓库之后，一次全量提交就会把里面的私人文件一起收走。");
    console.error("  把这句话交给 AI：「请新建一个只放这个产品的独立文件夹，不要移动或收走这里已有的私人文件；然后在新文件夹里重新初始化。」");
    return 1;
  }

  const write = (rel, content) => {
    const inspected = inspectProjectTarget(abs, rel);
    if (!inspected.safe) {
      skipped.push(rel);
      notes.push(`${rel} 的路径不安全：${inspected.reason}。已保护不写；处理前安装不算完成。`);
      return false;
    }
    const { target, stat } = inspected;
    if (stat) {
      skipped.push(rel);
      return false;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    done.push(rel);
    return true;
  };

  // 1. git 仓库兜底。
  let inRepo = false;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: abs, stdio: "ignore" });
    inRepo = true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.error(paint.red("✗ 这台电脑还没有 Git（保存每次改动、方便撤回的工具），BossCoding 没有改动任何文件。"));
      console.error('  把这句话交给 AI：「请帮我安装 Git，装好后在这个文件夹重新运行 npx -y @s-ry2005/bosscoding@latest init。」');
      return 1;
    }
  }
  if (inRepo && gitTopLevel(abs) !== abs) {
    console.error(paint.red("✗ 当前文件夹只是一个 Git 项目的子目录，BossCoding 没有写入任何文件。"));
    console.error('  把这句话交给 AI：「请找到这个 Git 项目的最外层文件夹，在那里重新运行 npx -y @s-ry2005/bosscoding@latest init。」');
    return 1;
  }

  const state = directoryState(abs);
  if (!state.empty && !state.looksLikeProject && !inRepo) {
    console.error(paint.red("✗ 这里已有文件，但看不出这是一个产品项目。为了避免把私人文件一起收进版本记录，BossCoding 没有改动。"));
    console.error('  把这句话交给 AI：「请先判断这里是不是我的产品：如果是，先建立 Git 版本记录再重新初始化；如果只是私人杂物，再把产品迁到单独的空文件夹。不要擅自收走私人文件。」');
    return 1;
  }

  const pkgPath = path.join(abs, "package.json");
  const pkgTarget = inspectProjectTarget(abs, "package.json");
  if (!pkgTarget.safe || (pkgTarget.stat !== null && !pkgTarget.stat.isFile())) {
    console.error(paint.red("✗ package.json 不是项目内的普通文件，BossCoding 没有改动任何文件。"));
    console.error('  把这句话交给 AI：「请检查 package.json 是否为软链、目录或指向项目外，修好后重新运行 BossCoding 初始化。」');
    return 1;
  }
  let existingPackage = null;
  if (pkgTarget.stat !== null) {
    try {
      existingPackage = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      console.error(paint.red("✗ package.json 已损坏，BossCoding 没有继续安装。"));
      console.error('  把这句话交给 AI：「请修好 package.json，再重新运行 npx -y @s-ry2005/bosscoding@latest init。」');
      return 1;
    }
  }
  const manager = detectPackageManager(abs, existingPackage);
  if (manager.ambiguous) {
    console.error(
      paint.red(
        "✗ 包管理器的声明或锁文件互相冲突，BossCoding 无法安全判断该用 npm、pnpm、Yarn 还是 Bun。",
      ),
    );
    console.error('  把这句话交给 AI：「请确认这个项目原来用哪一种包管理器，只保留正确的 packageManager 声明和一套锁文件，再重新运行 BossCoding 初始化。」');
    return 1;
  }

  if (!inRepo) {
    try {
      initializeGit(abs);
    } catch {
      console.error(paint.red("✗ Git 没能建立版本记录，BossCoding 没有继续安装。"));
      console.error('  把这句话交给 AI：「请检查 Git 为什么无法在这个文件夹工作，修好后重新运行 npx -y @s-ry2005/bosscoding@latest init。」');
      return 1;
    }
    done.push("（git init，主干名 main）");
    if (gitTopLevel(abs) !== abs) {
      console.error(paint.red("✗ Git 没有把当前文件夹识别为项目最外层，BossCoding 没有继续安装。"));
      return 1;
    }
  }
  const branch = stableBranch(abs);
  if (!branch) {
    console.error(paint.red("✗ 找不到唯一的稳定分支，BossCoding 没有继续安装。"));
    console.error("  把这句话交给 AI：「确认哪一条分支代表稳定版本，再重新运行 BossCoding 初始化；不要任选一条。」");
    return 1;
  }
  try {
    execFileSync("git", ["config", "--local", "bosscoding.stableBranch", branch], {
      cwd: abs,
      stdio: "ignore",
    });
  } catch {
    console.error(paint.red("✗ 无法记住项目的稳定分支，BossCoding 没有继续安装。"));
    console.error("  把这句话交给 AI：「检查本项目的 Git 配置权限，确认稳定分支后重新运行 BossCoding 初始化。」");
    return 1;
  }

  // 2. package.json：注入 preflight 与 bosscoding 依赖，替换 npm 默认的报错占位 test。
  const framework = packageIdentity();
  if (existingPackage === null) {
    const name = packageNameFrom(path.basename(abs));
    fs.writeFileSync(
      pkgPath,
      `${JSON.stringify(
        {
          name,
          version: "0.1.0",
          private: true,
          scripts: { test: "node --test", preflight: defaultPreflight(manager) },
          devDependencies: { [framework.name]: `^${framework.version}` },
        },
        null,
        2,
      )}\n`,
    );
    done.push("package.json");
  } else {
    const pkg = existingPackage;
    pkg.scripts ??= {};
    let touched = false;
    if (pkg.scripts.test && NPM_DEFAULT_TEST.test(pkg.scripts.test)) {
      pkg.scripts.test = "node --test";
      touched = true;
    }
    if (ensurePreflightScripts(pkg.scripts, manager)) touched = true;
    pkg.devDependencies ??= {};
    if (!pkg.devDependencies[framework.name] && !pkg.dependencies?.[framework.name]) {
      pkg.devDependencies[framework.name] = `^${framework.version}`;
      touched = true;
    }
    if (touched) {
      fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      done.push("package.json（注入 preflight／bosscoding 依赖）");
    } else {
      skipped.push("package.json");
    }
  }

  // 3. 规则真身与门牌。
  const agentsPath = path.join(abs, "AGENTS.md");
  let reverseRules = false;
  if (!write("AGENTS.md", readTemplate("AGENTS.template.md"))) {
    const agentsStat = lstat(agentsPath);
    if (agentsStat?.isSymbolicLink()) {
      if (exactLink(agentsPath, "CLAUDE.md")) {
        reverseRules = true;
      } else {
        let target = "无法读取的目标";
        try {
          target = fs.readlinkSync(agentsPath);
        } catch {
          // 保留默认说明。
        }
        notes.push(`AGENTS.md 是软链，但指向「${target}」而不是 CLAUDE.md；已保护不覆盖，处理前安装不算完成。`);
      }
    }
    const existing = readIfRegularOrValidLink(agentsPath);
    if (existing !== null && !hasBossCodingRules(existing)) {
      notes.push(
        `AGENTS.md 是你原有的规则，已保护不覆盖。请把这整句话交给 AI：「保留 AGENTS.md 里的全部现有规则；读取 ${path.join(TEMPLATES, "AGENTS.template.md")}，把缺少的 BossCoding 规则合并进去，不要整份覆盖；完成后运行 ${manager.install ?? "本项目原有包管理器的安装命令"} 和 ${manager.runPreflight ?? "项目自检"}，修到通过。」`,
      );
    }
  }
  const claudePath = path.join(abs, "CLAUDE.md");
  if (reverseRules && !lstat(claudePath)) {
    write("CLAUDE.md", readTemplate("AGENTS.template.md"));
  } else if (!reverseRules && !write("CLAUDE.md", CLAUDE_STUB)) {
    const claudeStat = lstat(claudePath);
    if (claudeStat?.isSymbolicLink() && !exactLink(claudePath, "AGENTS.md")) {
      let target = "无法读取的目标";
      try {
        target = fs.readlinkSync(claudePath);
      } catch {
        // 保留默认说明。
      }
      notes.push(`CLAUDE.md 是软链，但指向「${target}」而不是 AGENTS.md；已保护不覆盖，处理前安装不算完成。`);
    } else {
      const existing = readIfRegularOrValidLink(claudePath);
      if (existing !== null && !isClaudeImportStub(existing) && !claudeStat?.isSymbolicLink()) {
        notes.push(
          "CLAUDE.md 已有独立内容：请把它的规则合并进 AGENTS.md，然后让 CLAUDE.md 只留一行 @AGENTS.md（守卫 rules-single-source 会盯着这件事）。",
        );
      }
    }
  }
  if (reverseRules) {
    const existing = readIfRegularOrValidLink(agentsPath);
    if (existing === null || !hasBossCodingRules(existing)) {
      notes.push(
        "AGENTS.md 虽然正确指向 CLAUDE.md，但规则真身还没有 BossCoding 核心规则；请让 AI 合并后再自检。",
      );
    }
  }

  // 4. 质检口与档案室。
  const ciRel = ".github/workflows/bosscoding.yml";
  const ciBody = renderCi(readTemplate("ci.yml"), { manager, branch });
  if (!write(ciRel, ciBody)) {
    const target = path.join(abs, ciRel);
    const current = readIfRegularOrValidLink(target);
    if (
      !lstat(target)?.isFile() ||
      current === null ||
      (!current.includes("# bosscoding:managed-ci") && digest(current) !== LEGACY_CI_HASH)
    ) {
      notes.push(`${ciRel} 已有非 BossCoding 内容，已保护不覆盖；后续更新也不会接管。`);
    }
  }
  write("docs/decisions/README.md", readTemplate("decisions-readme.md"));
  const decisionRel = "docs/decisions/_template.md";
  const decisionBody = readTemplate("decision-template.md");
  if (!write(decisionRel, decisionBody)) {
    const current = readIfRegularOrValidLink(path.join(abs, decisionRel));
    const previousOfficial = decisionBody.replace(
      "<!-- bosscoding:managed-decision-template -->\n\n",
      "",
    );
    if (
      current === null ||
      (!current.includes("<!-- bosscoding:managed-decision-template -->") &&
        current !== previousOfficial)
    ) {
      notes.push(`${decisionRel} 已有非 BossCoding 内容，已保护不覆盖；后续更新也不会接管。`);
    }
  }

  // 5. Gemini／iFlow 的规则文件指路配置（这两家默认不读 AGENTS.md）。
  if (!write(".gemini/settings.json", readTemplate("gemini-settings.json"))) {
    const target = path.join(abs, ".gemini/settings.json");
    if (!hasAgentContext(target, "gemini")) {
      notes.push('已有 .gemini/settings.json：请在其中确认 context.fileName 含 "AGENTS.md"。');
    }
  }
  if (!write(".iflow/settings.json", readTemplate("iflow-settings.json"))) {
    const target = path.join(abs, ".iflow/settings.json");
    if (!hasAgentContext(target, "iflow")) {
      notes.push('已有 .iflow/settings.json：请在其中确认 contextFileName 含 "AGENTS.md"。');
    }
  }

  // 6. 技能（交付流程 boss-flow ＋ 四阶梯 boss-ladder）：安装逻辑与 update 共用。
  const skills = installSkills(abs);
  done.push(...skills.created);
  skipped.push(...skills.skipped);
  if (skills.skipped.length > 0) {
    notes.push(
      `以下技能入口已有不属于 BossCoding 的内容，已保护不覆盖：${skills.skipped.join("、")}。请让 AI 判断如何合并；处理前安装不算完成。`,
    );
  }

  // 7. .gitignore 幂等补行。
  const giPath = path.join(abs, ".gitignore");
  const gitignoreTarget = inspectProjectTarget(abs, ".gitignore");
  if (
    !gitignoreTarget.safe ||
    (gitignoreTarget.stat !== null && !gitignoreTarget.stat.isFile())
  ) {
    skipped.push(".gitignore");
    notes.push(
      `.gitignore 不是项目内的普通文件，已保护不写；请让 AI 修好路径后重新初始化。`,
    );
  } else {
    const current =
      gitignoreTarget.stat !== null ? fs.readFileSync(giPath, "utf8") : "";
    const currentLines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = GITIGNORE_LINES.filter((line) => {
      if (currentLines.has(line)) return false;
      return !(line.startsWith(".env") && currentLines.has(".env*"));
    });
    if (missing.length > 0) {
      const block = `${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}# BossCoding：依赖与密钥不进版本库\n${missing.join("\n")}\n`;
      fs.appendFileSync(giPath, block);
      done.push(`.gitignore（补 ${missing.length} 行）`);
    } else {
      skipped.push(".gitignore");
    }
  }

  // 8. git hook 本地门禁：并行时主工作区只跑主干；禁止直推主干（细节见 templates/hooks/）。
  const hooks = installHooks(abs, { execFileSync: options.hookExecFileSync });
  if (hooks.installed.length > 0) {
    done.push(`git hook：${hooks.installed.join("、")}（本地门禁：并行时主工作区只跑主干＋禁止直推主干）`);
  }
  if (hooks.skipped.length > 0) {
    notes.push(
      `已有别人的 git hook（${hooks.skipped.join("、")}），未覆盖：想要 BossCoding 的本地门禁，请把 ${path.join(TEMPLATES, "hooks")} 下对应脚本的内容并进你现有的 hook。`,
    );
  }
  notes.push(...hooks.blocked);

  // 汇总。
  console.log(
    paint.bold(
      notes.length > 0
        ? "BossCoding 基础已装好，但还有事项没处理，暂不能宣布完全就位。"
        : "BossCoding 就位。你是老板：需求你说，制度盯人。",
    ),
  );
  if (done.length) {
    console.log(`\n写入：`);
    for (const f of done) console.log(paint.green(`  + ${f}`));
  }
  if (skipped.length) {
    console.log(`\n已存在、未动：`);
    for (const f of skipped) console.log(paint.dim(`  = ${f}`));
  }
  if (notes.length) {
    console.log(`\n需要处理：`);
    for (const n of notes) console.log(paint.yellow(`  ! ${n}`));
  }
  // 结尾指引只说真话：有待处理事项时不许承诺「应当全绿」（实测：已有 CLAUDE.md 的
  // 项目装完必红，而旧文案还在说全绿，新人第一眼就是红叉加一句被打脸的承诺）。
  const installInstruction =
    manager.install && manager.runPreflight
      ? `运行 ${manager.install} 和 ${manager.runPreflight}`
      : "先确认这个项目原来使用的包管理器，再安装依赖并运行 preflight 自检";
  console.log(`
下一步只做一件事：
  把这句话交给 AI：「${notes.length > 0 ? "先替我逐条完成上面的『需要处理』；" : ""}${installInstruction}，修到通过；读一遍 AGENTS.md，之后需求我说、规矩你守。完成后只问我：『你想做个什么？』」${inRepo ? "" : "\n  （版本记录刚建好，第一次保存也交给 AI，你不用管。）"}

任何时候不知道自己在哪一步：让 AI 用项目选定的包管理器执行 bosscoding status`);
  return notes.length > 0 ? 1 : 0;
}
