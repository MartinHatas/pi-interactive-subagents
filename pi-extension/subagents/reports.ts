import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let sequence = 0;

export function queueReport(sessionFile: string, payload: { report: string; aborted: boolean }): void {
  const dir = `${sessionFile}.reports`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${Date.now()}-${String(sequence++).padStart(12, "0")}-${randomUUID()}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(payload), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export function deliverReports(sessionFile: string, deliver: (payload: { report: string; aborted: boolean }) => void): void {
  const dir = `${sessionFile}.reports`;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of files.filter((file) => file.endsWith(".json")).sort()) {
    const file = join(dir, name);
    const payload = JSON.parse(readFileSync(file, "utf8"));
    if (typeof payload.report !== "string") continue;
    deliver(payload);
    unlinkSync(file);
  }
}
