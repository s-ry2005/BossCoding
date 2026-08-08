import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function packageIdentity() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  return { name: pkg.name, version: pkg.version };
}

/** 旧公开包仍被识别，避免 fork 的 update 把存量项目误报为未安装。 */
export function managedDependencyName(pkg) {
  const { name } = packageIdentity();
  if (pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]) return name;
  if (pkg?.dependencies?.bosscoding || pkg?.devDependencies?.bosscoding) return "bosscoding";
  return name;
}

export function hasManagedDependency(pkg) {
  const name = managedDependencyName(pkg);
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
}
