/**
 * 技能安装：本体放开放标准目录 .agents/skills，Claude 系目录 .claude/skills 放一份副本。
 * init 与 update 共用——update 需要它，是因为新版本可能新增技能：只刷新已有文件的话，
 * 老用户永远拿不到新技能。
 *
 * 为什么是复制而不是软链（实测事故）：软链会被提交进版本库（mode 120000），
 * 而 Windows 默认不支持软链，克隆下来会变成一个写着路径的文本文件——两个技能
 * 同时静默失效，且现象是「AI 就是不按规矩走」，没人查得到根因。
 * 副本的代价是同一份内容存两处，由本模块负责保持一致；这个代价比静默失效小得多。
 *
 * 边界：技能是框架管理的文件（老板的规则在 AGENTS.md，不在这里），
 * 所以允许创建缺失的、刷新改过的；别人手写的同名技能没有我们的 front matter
 * 标记时不动——与 git hook 的认领纪律同一套。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { inspectProjectTarget } from "./safe-path.mjs";

const TEMPLATES = path.join(fileURLToPath(new URL("../", import.meta.url)), "templates");

export const SKILLS = ["boss-flow", "boss-ladder", "boss-closeout"];

// marker 上线前最后一版官方正文的精确哈希。只认已知正文，不用技能名或 front matter
// 猜所有权，否则用户恰好写了同名技能就会被整份覆盖。
const LEGACY_OFFICIAL_HASHES = {
  "boss-flow": new Set(["4ff8285f2443a36ceba87956970afc27c2517a29ae95a8afbd7dbeb6a65ac632"]),
  "boss-ladder": new Set(["ad53d68ab23edfa381878b6556ede24fdd131b5eba693e00108e4058baad2163"]),
};

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 新版靠唯一 marker；无 marker 时只兼容精确等于已知旧版官方正文的存量副本。 */
function ownedByUs(text, skill) {
  if (text.includes("<!-- bosscoding:managed-skill -->")) return true;
  return LEGACY_OFFICIAL_HASHES[skill]?.has(digest(text)) === true;
}

function lstat(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function knownLegacyTarget(value, base, skill) {
  if (base !== ".claude/skills" || typeof value !== "string") return false;
  const normalized = value.trim().replaceAll("\\", "/");
  return normalized === `../../.agents/skills/${skill}`;
}

function migrateLegacyEntry(dir, rel, body, result) {
  fs.unlinkSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  result.migrated.push(rel);
}

/** 写一份技能副本；返回 "created" | "refreshed" | "skipped" | null（无需动作）。 */
function place(target, body, skill) {
  const targetStat = lstat(target);
  if (targetStat === null) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return "created";
  }
  if (!targetStat.isFile()) return "skipped";
  const current = fs.readFileSync(target, "utf8");
  if (!ownedByUs(current, skill)) return "skipped";
  if (current === body) return null;
  fs.writeFileSync(target, body);
  return "refreshed";
}

/**
 * 幂等安装。返回 { created, refreshed, skipped, migrated }，全部是项目内相对路径数组。
 * migrated：把旧版本留下的软链换成了真实副本（跨平台修复，见文件头）。
 */
export function installSkills(root) {
  const abs = path.resolve(root);
  const result = { created: [], refreshed: [], skipped: [], migrated: [] };

  for (const skill of SKILLS) {
    const body = fs.readFileSync(path.join(TEMPLATES, "skills", skill, "SKILL.md"), "utf8");

    for (const base of [".agents/skills", ".claude/skills"]) {
      const dir = path.join(abs, base, skill);
      const rel = `${base}/${skill}/SKILL.md`;
      const inspected = inspectProjectTarget(abs, path.join(base, skill));
      if (!inspected.safe) {
        result.skipped.push(rel);
        continue;
      }

      // 旧版生成的是 .claude 下指向 .agents 的目录软链。Windows 可能把它检出成
      // 一个只写着目标路径的普通文本文件；只迁移我们生成过的精确目标，未知文件让路。
      const entryStat = lstat(dir);
      if (entryStat?.isSymbolicLink()) {
        const target = fs.readlinkSync(dir);
        if (knownLegacyTarget(target, base, skill)) {
          migrateLegacyEntry(dir, rel, body, result);
        } else {
          result.skipped.push(rel);
        }
        continue;
      }
      if (entryStat?.isFile()) {
        const target = fs.readFileSync(dir, "utf8");
        if (knownLegacyTarget(target, base, skill)) {
          migrateLegacyEntry(dir, rel, body, result);
        } else {
          result.skipped.push(rel);
        }
        continue;
      }
      if (entryStat && !entryStat.isDirectory()) {
        result.skipped.push(rel);
        continue;
      }

      const outcome = place(path.join(dir, "SKILL.md"), body, skill);
      if (outcome === "created") result.created.push(rel);
      else if (outcome === "refreshed") result.refreshed.push(rel);
      else if (outcome === "skipped") result.skipped.push(rel);
    }
  }

  return result;
}
