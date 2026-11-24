/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically when their agent loop ends (see the `agent_end` handler);
 * interactive agents end when the human exits the pane.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (auto-exit is suppressed for that turn via `awaitingAnswer`), and the parent
 * replies with subagent_message — which lands as the subagent's next turn.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_end` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Prefix on orchestrator messages the child submits from its inbox. */
export const ORCHESTRATOR_MARKER = "[orchestrator]";

/** Join queued orchestrator messages into one user message. */
export function formatInboxBatch(texts: string[]): string {
  return texts.map((text) => `${ORCHESTRATOR_MARKER} ${text}`).join("\n\n");
}

/**
 * Take every message queued in `${sessionFile}.inbox` (JSONL, appended by the
 * parent's subagent_message). Rename first so a concurrent append lands in a
 * fresh inbox instead of being lost.
 */
export function drainInbox(sessionFile: string): string[] {
  const inbox = `${sessionFile}.inbox`;
  if (!existsSync(inbox)) return [];
  const taken = `${inbox}.${process.pid}.${Date.now()}`;
  try {
    renameSync(inbox, taken);
  } catch {
    return [];
  }
  let raw = "";
  try {
    raw = readFileSync(taken, "utf8");
  } finally {
    try {
      unlinkSync(taken);
    } catch {}
  }
  const messages: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const text = JSON.parse(line)?.text;
      if (typeof text === "string" && text.trim()) messages.push(text);
    } catch {
      // Skip a malformed line rather than dropping the whole batch.
    }
  }
  return messages;
}

/** Text of the latest assistant message in an agent_end `messages` array. */
export function lastAssistantText(messages: any[] | undefined): string {
  if (!messages) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim();
    }
    return "";
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  // Set when ask_question is called; suppresses auto-exit so the session stays
  // open while it waits for the orchestrator's reply. Cleared when the reply
  // lands — on `input` (covers a reply steered into the current run) and on
  // `agent_start` (covers a reply that starts a fresh turn after parking).
  let awaitingAnswer = false;
  // Persistent (non-auto-exit) children report each orchestrator-initiated turn
  // back via a `${sessionFile}.report` signal and stay open. The first turn is
  // the orchestrator's task; later turns count only when submitted from the
  // inbox (source "extension" + ORCHESTRATOR_MARKER). Turns the human types in
  // the pane stay silent.
  let reportPending = !autoExit;
  let agentRunning = false;
  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  // Set when an inbox message started a turn from idle, cleared on agent_start.
  // pi checks isStreaming only after async input handlers, so a second send in
  // that window would also try to start a turn and be dropped.
  // shortcut: expires after 10s in case the turn never starts (send failed); a smarter retry is only needed if that shows up in practice.
  let inboxStartingAt = 0;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);

    // Orchestrator messages arrive through a file inbox, not tmux keystrokes,
    // so delivery never depends on what the pane UI is showing.
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile && !inboxTimer) {
      inboxTimer = setInterval(() => {
        if (Date.now() - inboxStartingAt < 10_000) return;
        const texts = drainInbox(sessionFile);
        if (texts.length === 0) return;
        if (ctx.isIdle()) inboxStartingAt = Date.now();
        // One message per batch: several sends in one tick race each other.
        pi.sendUserMessage(formatInboxBatch(texts), { deliverAs: "followUp" });
      }, 500);
    }
  });

  pi.on("input", (event) => {
    recorder.input();
    const text = String((event as any)?.text ?? "");
    if (!autoExit) {
      if ((event as any)?.source === "extension" && text.startsWith(ORCHESTRATOR_MARKER)) {
        reportPending = true;
      }
      // A human prompt on an idle session is their own turn. Mid-run human
      // steers don't cancel an orchestrator turn's report.
      else if (agentStarted && !agentRunning) reportPending = false;
    }
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and agent_end would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingAnswer = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    inboxStartingAt = 0;
    agentStarted = true;
    agentRunning = true;
    // A new turn is starting — any pending ask_question has now been answered
    // (or superseded), so let auto-exit resume normally when this turn ends.
    awaitingAnswer = false;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    agentRunning = false;
    const messages = (event as any).messages as any[] | undefined;

    // Report to the orchestrator without exiting. Skip while an ask_question is
    // pending (the question already went up; the reply re-arms the report).
    const reportFile = process.env.PI_SUBAGENT_SESSION;
    if (!autoExit && reportPending && !awaitingAnswer && reportFile) {
      reportPending = false;
      const aborted = !shouldAutoExitOnAgentEnd(false, messages);
      try {
        writeFileSync(
          `${reportFile}.report`,
          JSON.stringify({
            name: subagentName,
            agent: subagentAgent,
            cwd: process.cwd(),
            aborted,
            report: lastAssistantText(messages) || "(no assistant text)",
          }),
        );
      } catch {
        // Best effort — the human can still relay the result manually.
      }
    }
    // Never shut down while this session still has work in flight:
    //  - awaitingAnswer: an ask_question is pending the orchestrator's reply.
    //  - runningChildrenCount(): this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    // In both cases the session parks as `waiting` and resumes when the next
    // turn lands.
    const hasPendingChildren = runningChildrenCount() > 0;
    const shouldExit =
      !awaitingAnswer &&
      !hasPendingChildren &&
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify({
              type: "error",
              errorMessage: errorInfo.errorMessage,
              stopReason: errorInfo.stopReason,
            }),
          );
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    if (inboxTimer) clearInterval(inboxTimer);
    inboxTimer = null;
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) a single question and pause until they reply. " +
      "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
      "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
      "Your session stays open while you wait — the answer arrives as your next message, then you continue. " +
      "Ask exactly one question per call; make separate calls for unrelated questions.",
    promptSnippet:
      "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "After asking, stop and wait — the reply will arrive as your next message.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      // Keep the session open: suppress auto-exit for this turn and park in the
      // "waiting" phase. The parent's watcher picks up the `.ask` signal and
      // notifies the orchestrator, who replies via subagent_message.
      awaitingAnswer = true;
      recorder.askQuestion();
      const askData = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      writeFileSync(`${sessionFile}.ask`, JSON.stringify(askData));

      return {
        content: [
          {
            type: "text",
            text:
              "Question sent to the orchestrator. Stop here and wait — do not continue working or " +
              "assume an answer. Their reply will arrive as your next message.",
          },
        ],
        details: { question: params.question },
      };
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

}
