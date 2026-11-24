# Pi Interactive Subagents

Run Pi agents in separate tmux panes. Use a persistent `repo` agent for each repository in a cross-service change, or delegate a short task to an agent that exits when it finishes.

## Quick start

You need [Pi](https://pi.dev/) and tmux. Install this fork, then start Pi inside tmux:

```sh
pi install git:github.com/MartinHatas/pi-interactive-subagents
tmux new -A -s pi 'pi'
```

If you already installed the Amos Blomqvist package, remove that source before installing this fork so Pi loads only one copy of the extension.

In the parent Pi session, try:

> Start a `repo` agent named `api` in `/absolute/path/to/api`. Ask it to read `AGENTS.md` and identify the test command without editing files.

Look for `🦆 orchestrator: ON` in the footer. Orchestrator mode starts on in top-level sessions. Use `/orchestrate off` to hide the delegation tools, `/orchestrate on` to restore them, or `/orchestrate` to toggle. Pi remembers the setting for that session.

## Work across repositories

1. Give the orchestrator the repository paths and the dependency order. For a shared API or schema, start with the provider, then pass the exact contract it reports to the consumers.
2. Give each child a work order with **Goal, Context, Contract, Scope, Out of scope, and Acceptance**. The bundled [`repo` profile](agents/repo.md) asks children to report what changed, contract changes, verification, branch or commit, and open questions.
3. Open the child pane to inspect the diff or steer it yourself. Use `/diff-review` or MR-comment tooling if you have installed them. Manual turns in the child stay local; orchestrator work orders report back to the parent.
4. Exit each child when you finish reviewing it. A `repo` agent stays open after reporting and does not auto-exit.

Pi leaves the parent on the left and adds child columns on the right, stacking up to two panes per column. The parent widget shows each repo child's working directory, badge, elapsed time, and status. Match the colored `◆<pane number>` badge to the child footer and tmux border. The extension leaves existing visible border styling alone.

Use `/orchestrate focus` to choose a child, or `/orchestrate focus <name>` to jump directly to it. In a child, `Ctrl+Alt+O` expands its tools widget. In the parent, `Ctrl+O` expands completion messages.

## Delegate and follow up

| Command or tool | Use |
| --- | --- |
| `subagent({ agent, task, name?, cwd?, model? })` | Launch a named profile asynchronously. Use `cwd` for the target directory and `model` to override the profile's model. |
| `subagent_message({ name, message })` | Send follow-up work to an open child or resume a closed one under the same name. |
| `subagents_list()` | Discover agent profiles available to this session. |
| `ask_question({ question })` | In a child, ask the parent for a decision and keep the pane open. The parent answers with `subagent_message`. |
| `/subagent <agent> <task>` | Ask the parent to delegate to a named profile from the editor. For a specific directory, give the parent the path and have it use `cwd`. |

A second persistent spawn targeting an already open directory sends the task to the existing child. Directory matching resolves symlinks. If the first child is still launching, the duplicate spawn is rejected; wait for launch and send the follow-up by name.

Pi children read multiline work orders from a session inbox instead of receiving keystrokes. Persistent children take inbox work after the current turn ends. Orders queued together may share one turn and one report. Claude Code CLI profiles still receive keystrokes, so an open selector or partially typed prompt can interfere.

### Reload, close, and resume

- To reconnect to live children, reload or resume the **same parent session in the same tmux window**. Only children launched with pane tagging can reconnect. The parent drains queued reports when it reconnects.
- Exit a child from its own Pi pane when done. Killing a pane in tmux also removes it from the parent's widget; it does not complete any unfinished work.
- Message a closed Pi child by name to reopen its session using its saved tool and model settings. The parent needs the original session file and its loadout snapshot. A persistent child resumes as persistent.
- Treat the inbox as a live work queue. If a child closes before handling an order, verify the outcome before assuming the work ran.

## Agent profiles and configuration

| Profile | Role | Lifecycle |
| --- | --- | --- |
| `repo` | Implement and review changes in one repository with normal Pi configuration | Persistent |
| `scout` | Inspect a codebase with read-only tools | Auto-exit |
| `researcher` | Search the web and write a sourced brief | Auto-exit |
| `worker` | Implement changes; may delegate to `scout` and `researcher` | Auto-exit |

The three auto-exit profiles ship with `openrouter/z-ai/glm-5.3`; configure that provider or supply a model override. `repo` uses the child Pi configuration's default model. Auto-exit Pi agents stay open if a question is unanswered or their own children are still running.

Place profiles in `.pi/agents/` for one project or `~/.pi/agent/agents/` for all projects. Pi resolves duplicate profile names in this order: project, global, bundled. See [`agents/`](agents/) for complete examples.

| Frontmatter | Meaning |
| --- | --- |
| `name`, `description` | Profile identifier and description in `subagents_list`. |
| `model`, `thinking`, `skills` | Model ID, thinking level, and comma-separated skills to load. |
| `cwd` | Default working directory; an explicit spawn `cwd` overrides it. |
| `tools` | Comma-separated tool allowlist for a restricted Pi child. Omit it, as `repo` does, to use normal extension and tool discovery when no nested spawning grant is configured. |
| `subagent_agents` | Comma-separated profiles that a restricted child may spawn. |
| `session-mode` | `standalone` starts fresh; `lineage-only` links to the parent without copying turns; `fork` copies the parent's conversation context. |
| `system-prompt` | `append` or `replace` uses the profile body as a system prompt. Otherwise, the body goes into the task. |
| `auto-exit`, `interactive` | Control whether the child exits when done and whether stall/recovery notifications wake the parent. |
| `disable-model-invocation`, `cli` | Hide a profile from discovery output, or set `cli: claude` to run it through Claude Code. |

Restricted Pi profiles use `--no-extensions` and `--tools`; the launcher loads registered extensions for allowed tools. These flags limit Pi tool exposure; they are not an OS sandbox. Extensions can register tool paths with `globalThis.__pi_interactive_subagents.registerToolExtension(name, path)`.

Copy [`config.json.example`](config.json.example) to `config.json` at the package root to configure status tracking. If new panes open but shell startup eats the launch command, increase the launch delay before starting Pi:

```sh
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500  # default: 500
```

## Testing

From a checkout, install the development dependencies and run the unit suite:

```sh
npm ci
npm test
```

Run the tmux-only checks from a disposable tmux window. They create and focus real panes but make no model calls:

```sh
node --test test/integration/tmux-surface.test.ts
```

`npm run test:integration` also runs model-backed lifecycle tests. Use `PI_TEST_MODEL` to select a model you can access. Some unit tests discover profiles and extensions from your Pi configuration, so local overrides can affect their results.

## Credits and license

This fork builds on [Amos Blomqvist's tmux fork](https://github.com/amosblomqvist/pi-interactive-subagents) of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). The upstream status supervision drew inspiration from [RepoPrompt](https://repoprompt.com/).

[MIT](LICENSE)
