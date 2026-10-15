// 最小复现：同一子进程命令，唯一变量是 stdio 形态。
// 目的：证明「默认 stdio（stdin 为管道）」在宿主沙箱下 spawnSync 直接失败（stdout/stderr 为 undefined），
//       与 run-weekly-collection.mjs 合并步骤观测到的「失败：undefined」形态一致。
import { spawnSync } from "node:child_process";

const cp = process.execPath;
const probe = ["-e", "console.log(JSON.stringify({ok:true,from:'child'}))"];

const a = spawnSync(cp, probe, { encoding: "utf8" }); // 默认 stdio（stdin 管道）
const b = spawnSync(cp, probe, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); // 显式

console.log("DEFAULT  status=", a.status,
  "error=", a.error ? a.error.code : null,
  "stdout=", JSON.stringify(a.stdout),
  "stderr=", JSON.stringify(a.stderr));
console.log("EXPLICIT status=", b.status,
  "error=", b.error ? b.error.code : null,
  "stdout=", JSON.stringify((b.stdout || "").trim()),
  "stderr=", JSON.stringify(b.stderr));
