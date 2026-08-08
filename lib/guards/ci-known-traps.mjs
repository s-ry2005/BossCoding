/**
 * CI 配置守卫：三个已经把人坑过的 GitHub Actions 写法。
 *
 * 三条都只在「你确实用了那个写法」时才出声，没用到的项目零噪音——这是它敢一次收
 * 三条的前提（v1 不变量 3：误报多的守卫会被关掉，比没有更糟）。
 *
 * 坑一 · 可选加速步骤没有上限（issue #12）：一个 `continue-on-error: true` 的镜像
 * 上传步骤没设超时，实测 10 次里 2 次卡 829／892 秒。算总账：上传期望耗时
 * 0.8×8s + 0.2×850s ＝ 176 秒，而命中缓存只省 115 秒——这个「加速器」平均在让整件事
 * 变慢。`continue-on-error` 只吸收失败，不吸收拖住：失败可容忍 ≠ 挂住可容忍。
 *
 * 坑二 · `workflow_run` 触发不筛不钉（issue #9）：该事件对失败的、PR 的上游运行同样
 * 触发，且事件里的 `github.ref` 指向默认分支最新提交、不是触发它的那次提交——
 * 「CI 绿的那棵树」和「你部署的那棵树」可以不是同一棵，而且不会有任何报错。
 *
 * 坑三 · AWS CLI v2.23+ 的默认校验打烂 S3 兼容存储（issue #12）：2025 年初起默认开启
 * CRC64 完整性校验，用 aws-chunked 流式编码、不带 Content-Length，MinIO／Ceph／
 * Backblaze／腾讯云 COS 全部报错。这不是「某家不兼容」，是一个可以关掉的默认开关。
 */

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const CONTINUE_ON_ERROR = /^(\s*)(-\s+)?continue-on-error\s*:\s*true\s*(#.*)?$/;
const TIMEOUT = /^\s*(-\s+)?timeout-minutes\s*:/;
const AWS_CUSTOM_ENDPOINT = /\baws\b[^\n]*--endpoint-url/;
const CHECKSUM_SWITCH = /AWS_REQUEST_CHECKSUM_CALCULATION/;
const BOSSCODING_WORKFLOW = ".github/workflows/bosscoding.yml";

const indentOf = (line) => line.length - line.trimStart().length;
const ignorable = (line) => line.trim() === "" || line.trim().startsWith("#");

/**
 * 取 `continue-on-error` 所在的那一块（步骤或任务）的行号范围。
 * 判据是缩进：同块的兄弟键缩进相同，更深的是自己的子结构，更浅的说明出块了。
 */
function blockRange(lines, at) {
  const raw = lines[at];
  const isItemHead = /^\s*-\s/.test(raw);
  const ind = isItemHead ? indentOf(raw) + 2 : indentOf(raw);

  let start = at;
  if (!isItemHead) {
    for (let i = at - 1; i >= 0; i--) {
      if (ignorable(lines[i])) continue;
      if (indentOf(lines[i]) >= ind) {
        start = i;
        continue;
      }
      start = i; // 块头（`- name: …` 或上一层的键），它也属于这一块
      break;
    }
  }

  let end = at;
  for (let i = at + 1; i < lines.length; i++) {
    if (ignorable(lines[i])) continue;
    if (indentOf(lines[i]) < ind) break;
    if (indentOf(lines[i]) === ind && /^\s*-\s/.test(lines[i])) break; // 下一个兄弟条目
    end = i;
  }
  return [start, end];
}

function checkOptionalStepTimeout(file, text, problems) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!CONTINUE_ON_ERROR.test(lines[i])) continue;
    const [start, end] = blockRange(lines, i);
    if (lines.slice(start, end + 1).some((l) => TIMEOUT.test(l))) continue;
    problems.push({
      file,
      line: i + 1,
      level: "warn",
      msg: "continue-on-error 的步骤没有 timeout-minutes——失败可容忍，挂住不可容忍",
      fix: "给这一块加 timeout-minutes，上限按「正常耗时 × 2~3」定，不要拍脑袋；一个没有上限的可选加速步骤，期望收益可能是负的。",
    });
  }
}

function checkWorkflowRun(file, text, problems) {
  if (!/^\s*workflow_run\s*:/m.test(text)) return;

  if (!/workflow_run\.conclusion/.test(text)) {
    problems.push({
      file,
      level: "warn",
      msg: "workflow_run 触发没有筛上游结论——失败的、PR 的上游运行同样会触发它",
      fix: "加条件：github.event.workflow_run.conclusion == 'success' && …event == 'push' && …head_branch == '<默认分支>'。",
    });
  }
  if (/actions\/checkout/.test(text) && !/workflow_run\.head_sha/.test(text)) {
    problems.push({
      file,
      level: "warn",
      msg: "workflow_run 里 checkout 没有显式指定 head_sha——取到的是默认分支最新提交，不是触发它的那次",
      fix: "checkout 加 ref: ${{ github.event.workflow_run.head_sha }}，否则「CI 绿的那棵树」和你实际用的那棵可以不是同一棵，且不会报错。",
    });
  }
}

function checkS3Checksum(file, text, problems) {
  if (!AWS_CUSTOM_ENDPOINT.test(text) || CHECKSUM_SWITCH.test(text)) return;
  problems.push({
    file,
    level: "warn",
    msg: "对 S3 兼容存储用 aws cli，但没关掉默认完整性校验（v2.23+ 起默认开）",
    fix: "设 AWS_REQUEST_CHECKSUM_CALCULATION=when_required 与 AWS_RESPONSE_CHECKSUM_VALIDATION=when_required；注意高层的 aws s3 cp 曾有不遵守该开关的 bug，低层 aws s3api 一定遵守。",
  });
}

function declaresBossCoding(ctx) {
  if (!ctx.exists("package.json")) return false;
  try {
    const pkg = JSON.parse(ctx.readText("package.json"));
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(
      (name) => name === "bosscoding" || name.endsWith("/bosscoding"),
    );
  } catch {
    return false;
  }
}

export default {
  name: "ci-known-traps",
  title: "CI 配置不踩已知的坑",
  run(ctx) {
    const problems = [];
    if (declaresBossCoding(ctx) && !ctx.exists(BOSSCODING_WORKFLOW)) {
      problems.push({
        file: BOSSCODING_WORKFLOW,
        level: "warn",
        msg: "项目装了 BossCoding，但 GitHub 自动质检文件缺失；连上 GitHub 后不会自动检查",
        fix: "让 AI 运行 npx -y @s-ry2005/bosscoding@latest update 恢复质检文件，再重新检查状态。",
      });
    }
    for (const file of ctx.trackedFiles()) {
      const isWorkflow = WORKFLOW.test(file);
      if (!isWorkflow && !file.endsWith(".sh")) continue;
      const text = ctx.readTextIfSmallText(file);
      if (text === null) continue;
      if (isWorkflow) {
        checkOptionalStepTimeout(file, text, problems);
        checkWorkflowRun(file, text, problems);
      }
      checkS3Checksum(file, text, problems);
    }
    return problems;
  },
};
