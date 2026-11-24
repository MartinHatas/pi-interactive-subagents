/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──
//
// The parent pi pane (`$TMUX_PANE`) keeps the left column. Subagent panes fill
// columns to its right, at most SUBAGENT_PANES_PER_COLUMN stacked per column;
// when every column is full a new full-height column opens at the right edge.
// Columns share the window width equally; panes in a column share its height.

const SUBAGENT_PANES_PER_COLUMN = 2;

interface PaneGeometry {
  id: string;
  left: number;
  top: number;
}

/** Panes of the window containing `target`, grouped into columns (left → right, top → bottom). */
export function groupPanesIntoColumns(panes: PaneGeometry[]): PaneGeometry[][] {
  const byLeft = new Map<number, PaneGeometry[]>();
  for (const pane of panes) {
    const column = byLeft.get(pane.left) ?? [];
    column.push(pane);
    byLeft.set(pane.left, column);
  }
  return [...byLeft.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, column]) => column.sort((a, b) => a.top - b.top));
}

function listWindowPanes(target: string): { panes: PaneGeometry[]; width: number; height: number } {
  const out = execFileSync(
    "tmux",
    ["list-panes", "-t", target, "-F", "#{pane_id} #{pane_left} #{pane_top} #{window_width} #{window_height}"],
    { encoding: "utf8" },
  );
  let width = 0;
  let height = 0;
  const panes = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, left, top, w, h] = line.split(" ");
      width = Number(w);
      height = Number(h);
      return { id, left: Number(left), top: Number(top) };
    });
  return { panes, width, height };
}

/**
 * Pick where the next subagent pane goes: below the top pane of the first
 * subagent column that still has room, else a new column at the right edge.
 */
export function chooseSubagentSplit(
  columns: PaneGeometry[][],
  rootLeft: number,
): { direction: "down"; from: string } | { direction: "new-column" } {
  const open = columns.find(
    (column) => column[0].left > rootLeft && column.length < SUBAGENT_PANES_PER_COLUMN,
  );
  return open ? { direction: "down", from: open[open.length - 1].id } : { direction: "new-column" };
}

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Equalize column widths and per-column pane heights in the parent pi window.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to uneven sizes. Debounced
 * so bursts of spawns/exits collapse into one pass, and non-fatal: a cosmetic
 * resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      const { panes, width, height } = listWindowPanes(target);
      const columns = groupPanesIntoColumns(panes);
      const columnWidth = Math.floor((width - (columns.length - 1)) / columns.length);
      for (const column of columns.slice(0, -1)) {
        execFileSync("tmux", ["resize-pane", "-t", column[0].id, "-x", String(columnWidth)]);
      }
      for (const column of columns) {
        const paneHeight = Math.floor((height - (column.length - 1)) / column.length);
        for (const pane of column.slice(0, -1)) {
          execFileSync("tmux", ["resize-pane", "-t", pane.id, "-y", String(paneHeight)]);
        }
      }
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent in the parent pi's window (never steals
 * focus). See the layout notes above. Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  const root = process.env.TMUX_PANE;
  if (!root) return createSurfaceSplit(name, "right");
  requireTmux();
  const { panes } = listWindowPanes(root);
  const rootLeft = panes.find((pane) => pane.id === root)?.left ?? 0;
  const choice = chooseSubagentSplit(groupPanesIntoColumns(panes), rootLeft);
  if (choice.direction === "down") return createSurfaceSplit(name, "down", choice.from);
  return createSurfaceSplit(name, "right", root, { fullHeight: true });
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  options?: { fullHeight?: boolean },
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  // -f: span the full window height, opening a new column at the edge.
  if (options?.fullHeight) args.push("-f");
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
