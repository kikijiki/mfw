# The mfw web UI

This is the whole app. The v1 UI is deleted; these screens own the root, and
the design document (`docs/overhaul/ui.md`) describes what shipped.

Screens are mounted at the **top level** by thin route files in `src/routes/`
(flat convention: `now.tsx`, `p.$project.board.tsx`, ...). There is no
`/v2/*` prefix. `routes.tsx` holds the route tree as *data* (paths, files,
backing procedures, allowed search params) and owns every link target via
`href`.

> Same reading rules as `ui.md`: unmarked prose describes code that exists,
> **Not built** marks intent that never landed, **Unverified** marks something
> nobody has checked. Last swept against the code on 2026-08-14.

---

## What exists

| File | What it is |
|---|---|
| `routes.tsx` | the route tree as a typed const, `href` helpers, `withBase`, `isActive`, `APP_ROOT` |
| `lib/trpc.ts` | tRPC v11 client for `AppRouter`, `TRPCProvider`/`useTRPC`/`useTRPCClient`, `makeQueryClient()`, `RouterInputs`/`RouterOutputs`/`YieldOf` |
| `lib/live.ts` | `useLiveChannel()`, `applyEvent()`, `LiveContext`/`useLive()` |
| `lib/toast.tsx` | `ToastProvider`, `useToast()`, `useMutationToast()`, `toastBus`, `humanizeError()` |
| `lib/theme.ts` | `useTheme()` (theme + density → `data-theme`/`data-density`) and `useDarkClassSync()` |
| `lib/keyboard.ts` | the ONE shortcut registry (ui.md §8): `useKeyBindings`, `activeBindings`, `describeKey`; a key like `g h` is a two-key sequence (`matchSequence`, 1.5s window), and `handleKeyDown`/`registerScope` drive it without a DOM in tests |
| `lib/flowPatch.ts` | pure patches `applyEvent` applies to the Flow caches: `insertRun`, `patchRunState`, `patchRunActivity`, `patchTaskStatus` over `flow.tree`/`flow.live` nodes (rollups included), and `applySpanChange`/`spanChangesFor` for the `flow.spans` live edge |
| `lib/nodeRef.ts` | the node ref grammar (`task:MFW-41`, `run:…`, `sub:<run>/<call>`, `decision:512`, `brain`...): `parseNodeRef`, `formatNodeRef`, `nodeRef.*` builders |
| `lib/nav.ts` | `useGo()`, `useMediaQuery()`, `useWideViewport()` |
| `lib/seen.ts` | the since-marker Home's "Since you left" reads (per device, per project; advanced only by Mark caught up) |
| `lib/format.ts` | `formatCost/formatTokens/formatDuration/formatRelative/formatAbsolute`, plus `humanizeToken` and `summarizePayload` for raw event rows |
| `lib/markdown.tsx` | the markdown renderer (react-markdown + remark-gfm) |
| `lib/utils.ts` | `cn()` |
| `styles/tokens.css` | the whole design system (ui.md §6) |
| `styles.css` | Tailwind entry, the shadcn variables, and the `@custom-variant` declarations |
| `components/AppShell.tsx` | shell: nav, inbox badge, project switcher, health dot + banner, the usage block under the nav and the phone usage strip |
| `features/usage/` | subscription usage meters: `usageModel.ts` (pure: `severityOf` warn at 80 and critical at 95, `formatResetIn` / `resetPhrase` "resets in 2h13m", `subscriptionOf` view with stale and unavailable notes), `UsageMeters.tsx` (`useUsageFeed` mounted ONCE by the shell: the single 60 s `usage.subscriptions` refetch plus the `usage.changes` subscription; `useUsage` reads the cache; `UsageRail` expanded meters or collapsed monogram + worst percent, `UsageStrip` on the phone, `UsagePanelBody` on Fleet). Every severity is also a word and a glyph, stale bars are hatched |
| `features/shell/` sidebar | `projectRail.ts` (pure: the ONE status badge by priority needs-you > blocked > brain stuck/paused > live runs > dispatch running, the one-sentence tile tooltip, the expanded row's stats chips and idle line), `SidebarProject.tsx` (`ProjectEntry`: collapsed = one avatar tile with one corner badge, expanded = avatar, name, badge, hover/running dispatch toggle and a stats line; the actions menu opens on right-click, long-press, the hover chevron, or Shift+F10 / Menu key; `useRailRows` mixes `projects.summary`, refetched every 45 s and on live changes, with the live runs/inbox/fleet/brain caches) |
| `features/projects/ProjectAvatar.tsx`, `ProjectAppearance.tsx` | the one `ProjectAvatar` (curated icon key, 1-2 character mark, or the derived monogram, on a muted swatch from `tokens.css`), and the picker: a card at the top of project settings and a "Change icon..." dialog from the tile menu; rules in `@mfw/daemon/project-appearance`, stored as `icon`/`color` on the project's config entry |
| `components/ui/tooltip.tsx` | the one tooltip and its policy: `Tip label=...` / `TipSpan tip=...` (never native `title=`, enforced by `tooltipPolicy.test.ts`); it must add what is not visible (delete it when it repeats text or an `aria-label`), one line + at most one sentence, `clipped` for truncated text, `side="right"` so it never covers what it describes; portalled, 400 ms open, instant close, no touch. Keep `aria-label` on icon-only controls. `Button`, `AppLink`, `Chip`, `Cost` turn their `title` prop into a Tip |
| `components/Page.tsx` | `Page`, `PageHeader`, `Panel`, `Field`, `Chip`, `Scroller` |
| `components/StatusPill.tsx` | task status + run state as icon **and** color |
| `components/Empty.tsx` | empty states, incl. `reason="filtered"` and `tone="success"` |
| `components/ErrorState.tsx` | panel errors, `DaemonUnreachableBanner`, `ReconnectingOverlay`, `StaleWhenOffline` |
| `components/Loading.tsx` | `Skeleton`, `LoadingRows`, `LoadingCards`, `Pending` |
| `components/ConfirmDialog.tsx` | typed-string confirmation for destructive actions |
| `components/RelativeTime.tsx` | `RelativeTime`, `Elapsed`, `useNow()` |
| `components/Cost.tsx` | `Cost`, `Tokens`, `Duration`, `Mono` (tabular numerals) |
| `components/AppLink.tsx` | real `<a href>` + client-side navigation |
| `components/VirtualList.tsx` | windowing list for MB-scale transcripts (no dep) |
| `components/KeyboardHelp.tsx` | `?` cheat sheet, generated from the registry |
| `components/agent/` | the agent state vocabulary: `look.ts` (pure table: glyph + label + token per `RunActivity`, `RunState`, pip, brain state; `harnessMonogram`, `shortModel`), `StateGlyph`, `HarnessBadge`, `AgentChip`, `HistoryPips` |
| `features/flow/` | the Flow lens (`/p/$project/flow`): `flowModel.ts` (pure: `buildFlow` flattens `flow.tree` to visible rows with default expansion "follow what matters", done-sibling folds, filter keeping dimmed ancestors, `followTarget`, `stepTree` treegrid keys, `lineageOf`; the `f` filter parse/format), `timeScale.ts` (window presets and `fit`, LIVE vs `t`, ticks, bar rectangles, the bucketed `flow.spans` range), `TreeGrid` (virtual `role="treegrid"` over `components/VirtualList`, `aria-activedescendant`), `NodeRow` (the one row, also Home's; a `group:<id>` node from `run_groups` draws the compete icon, its status, who selects and the star-marked winner, and its attempts nest under it; `group:ended:<task>` is the unrelated fold of old runs), `TimelineCell` (a cell has fixed lanes: the marker lane on top, the 8px activity lane under it, a 2px status rail along the bottom, and nothing crosses between them; `cellModel` is its pure half; markers are real buttons, one Tab stop per row and Left/Right between them), `laneLayout` (pure: `layoutMarks` clusters events closer than `MARK_PITCH` px into one counted badge whose popover lists the members, `fitWindowMs` frames the activity), `marks` (the mark vocabulary and its shapes: brain decision diamond, human action ring, merge square, verify passed check, verify failed cross, run failed disc, needs you triangle, hold placed bars, hold released outline play, review verdict hexagon, spawned chevrons, run stopped no-entry), `FlowHover` (the pointer crosshair and time readout, driven by one CSS variable, and the hover/focus card for anything carrying `data-tip`), `FlowLegend` (the "?" button in the toolbar: a popover on hover, keyboard focus and click, Escape closes; it reads the same tables as the cells, so it cannot drift), `TimeHeader` (axis and window controls; `fit` is the default window), `TimeCursor` (the scrub: what `?t=` means, `[`/`]` step one event, `L` live, `rowActions` withheld while scrubbed, the `ScrubBanner` every scrubbed surface shows), `FlowPage` (data, filter bar, follow; `FlowLens` is the pure render; with `t` set the tree is `flow.at`, not `flow.tree`) |
| `features/inspector/` | `Inspector` (frame: header, tabs per node kind, body) in three presentations (`dock` beside a lens via `?node=`, `sheet` in `TaskOverlay`, `page` at `/p/$project/n/$ref`); `dock.ts` holds the breakpoint table (`dockFor`), the pane classes and Escape-closes; a run's body is `RunInspector` (lineage header with breadcrumb, sibling switcher and spawn/continue links; `StateBand` over `bandModel.ts`, the scrubbable strip of what the run was doing; the pruned-transcript summary) around `transcript/RunPage` |
| `features/palette/` | `CommandPalette` (cmdk, `Ctrl K` / the command key on macOS) over `palette.ts` (ranking, targets, the `g h` / `g b` / `g f` bindings) |
| `features/dispatch/DispatchControls.tsx` | per-project play/stop + the separate tri-state global mfw control |
| `features/dispatch/state.ts` | the wording: labels, tones, and the "who stopped it" sentence |
| `features/agents/useNodeActions.tsx` | **the only place** a node mutation is built: `useNodeActions(target)` for a run (stop, steer, approval, pause = stop keeping the worktree, resume, reroute, answer), a group (select winner, add attempt, stop all) and a task (pause, resume, stop all), with `StopRunDialog` / `StopAllDialog`. Stop, pause, reroute and select-winner patch the run, group and Flow caches optimistically and roll back on a refusal; the server's `data.fix` text is appended to the message (`refusalText`). `useRunControls.tsx` is the run slice, re-exported so run screens import what they always did; `runControls.ts` holds the pure rules (`runControlState`, `runMoves`, `markRunStopping`, `markGroupWinner`) |
| `features/agents/RerouteDialog.tsx` + `RunMoves.tsx` + `routePick.ts` | Reroute (and Add attempt) pick a harness, model, effort and host from `settings.providers.catalogue` and `hosts.list` (`routePick.ts`: the choices, and which fields a form actually changes); `RunMoves` is the Pause / Resume / Reroute… button group in `RunConsole` and the run page header |
| `features/agents/RunConsole.tsx` | an agent wherever the work is: live tail (approvals answerable), the run's open question (`clarify/AnswerBox`), steer, stop, transcript link |
| `features/presence/` | `PresenceBar` (32px strip on every screen, mounted by `AppShell`: per-project live dots from `runs.active`, a needs-you count and popover from `inbox.list`, `n` jumps to the oldest) over `presence.ts` (pure view model, `COLLAPSE_AFTER`) |
| `features/home/` | `HomePage` (`/`): `NeedsQueue` (`inbox.list` whole, answerable in place; `needs.ts` holds the rules, `useNeedActions` the dismiss and merge mutations), `LiveSection` (`runs.active` grouped project → task, `live.ts`), `SinceYouLeft` (`system.digest` against `lib/seen.ts`) |
| `features/projects/` | the add-project flow: `AddProjectDialog` (repository -> board), `BoardStep` (where the board lives, live `system.inspectBoardFolder` result, `TemplateCards`, summary), `FolderPicker` / `DirectoryBrowser`; `addProject.ts` holds the pure rules (`describeInspection`, `buildAddInput`, `summarize`, `suggestFolders`) |
| `features/home/` | `HomePage` (`/`): `NeedsQueue` (`inbox.list` whole, answerable in place; `needs.ts` holds the rules, `useNeedActions` the dismiss and merge mutations), `LiveSection` (`flow.live` per project with live runs, flattened by `flowModel` into the same `flow/NodeRow` rows the Flow lens draws; `live.ts`), `SinceYouLeft` (`system.digest` against `lib/seen.ts`) |
| `features/agents/attention.ts` | "needs you": an open question, a live run's activity (question, approval, stalled; a guessed question never counts), an escalation brief, an inbox item naming the run; the attention sort (most urgent reason first) |
| `features/agents/activity.ts` + `ActivityChip.tsx` | how `runs.activity` reads (label, tone, explanation from the detail); the chip and the defensive scope meter (renders only when a `scopeSample` exists) |
| `features/clarify/AnswerBox.tsx` | an open question answered where it is shown: a task run's single question inline ("Answer and resume"), anything else via `ClarifyDialog` |
| `components/icons/` | `StatusIcon` (keyed by the board's status ROLE from `board.schema`, so custom statuses draw right) and `TaskTypeIcon`; every look is icon + accessible label, unknown names get a deterministic fallback (`looks.ts` is the pure table) |
| `features/board/columns.ts` | the board's columns from `board.schema` (declared order, terminal ones collapsed), where a task sits, and the one drop rule (`dropVerdict`) that refuses with a reason |
| `features/board/lanes.ts` | the lanes layout's pure maths: `SPACE` (the one spacing scale: tile padding 8/10, row gap 6, a 3px stripe drawn as an inset shadow so it takes no padding, row/line/meta heights) with `tileContent`/`tileNeeds`/`tileMetrics` (title lines, gap and equal top/bottom padding of a tile; dense below the regular one-line tile), `laneSizes` (tile height budget from the stack's measured height, open, collapsed and empty-open lanes; min 68, max 100, below min the stack scrolls vertically), `laneTile` (a lane takes only what its titles need out of that budget, so short titles are not stretched into bands), `laneChrome` (the scrollbar only costs height while the strip overflows; an empty open lane is one `EMPTY_OPEN` row: header controls inline, one-line placeholder), `visibleTiles`, `wheelScrollLeft` (vertical wheel over an overflowing lane scrolls it sideways, yields at the edge), `scrollLeftToReveal`, `stepFocus` (arrow/Home/End across cards and lanes). `BoardPage` draws it as `LaneStack`/`Lane` (default layout; Lanes \| Columns toggle in the toolbar, remembered per project by `lib/boardColumns.ts`): every status is a full-width, one-tile-tall swimlane with a fixed header gutter and its own horizontal scroller; a tile is `TaskCard` with `tile`, whose expansion is a fixed-position popover. Phones keep the status pills and a card list. Nothing on the board animates: a live run reads by glyph, colour and label (`components/agent/look.ts` has no pulse) |
| `features/board/CardAgentStrip.tsx` | the card's agent strip: one chip per live run, else the last outcome line, then history pips |
| `features/board/CardSubtree.tsx` | the card expanded in place (Space or the chevron): the task's runs nested by lineage from `node.story` (read only while expanded, so collapsed cards add no observers), steer/stop per live run through `useRunControls`, the brain's intent line when a decision is newer than the latest run; never opens a transcript stream. The column menu ("only with agents", "sort by activity") is `columns.columnView`; `?gate=review` and the "N to review" chip are in `BoardPage` |
| `features/board/boardAgents.ts` | per-board maps built once from `runs.active` (live runs by task), `clarify.open` (asking tasks) and `runs.pipsByTask`; cards read them through context, so cards add no query observers |
| `features/projects/BoardSettings.tsx` + `boardDraft.ts` | project settings' Board section (mounted by `ProjectConfig`): the board's statuses in order with the daemon role of each (`StatusIcon`), task types (`TaskTypeIcon`), hierarchy depth, "use template statuses", and a diff preview before Apply, over `boardConfig.get/preview/save`; `boardDraft.ts` holds the pure rules (rename vs remove, where a removed status's tasks go, the patch) |
| `features/brain/` | the project brain as the UI reads it: `brain.ts` (pure: action state from `output.status`, outcome chips, filters, grouping by turn, open escalations, glyph and one-line status, the "Brain: off" hint, plan line diff), `BrainBadge.tsx` (`useBrainStates` over `brain.states`, the rail glyph and the project header chip) |
| `features/inspector/BrainInspector.tsx` + `DecisionRow.tsx` | `node=brain`: Decisions (grouped by turn, filters), Turns, Plan (markdown, diff against the previous plan), Session; a stuck circuit (Retry) and the brain's `notify_human` calls come first on every tab; a `proposed` action wears the "shadow: proposed vs pipeline" chip. There is no separate Decisions screen: brain decisions also live in each task's Story (`BrainDecisionRow`) and as the intent line on cards (`brain.intents`, one query per board) |
| `features/projects/BrainSettings.tsx` + `brainDraft.ts` | project settings' Brain section (mounted by `ProjectConfig`): routes in order, heartbeat, rollover tokens, turn timeout and caps; no routes = off; saves through `settings.update({brain})`, applied live |
| `features/sessions/SessionCard.tsx` | escalation briefs (`sessions.*`) on NOW: read, start, resolve |
| `features/inspector/GroupCompare.tsx` + `groupGate.ts` + `TaskActions.tsx` | `node=group:<id>` (an attempt group, from `groups.get`): one column per attempt (route, state, cost, checks, scope, review, a lazily loaded read-only diff through `review/DiffView` with `readOnly` and `keys={false}`, last message), `Select winner` enabled only where the server's own validator answers `select.ok` (`groupGate.ts`: `selectGate`, and `mirrorGate`, the same I2 order written down so a disagreement is a test failure), the refusal and its fix shown under a disabled button, Add attempt… and Stop all. `TaskActions` is the task inspector header's Pause / Resume / Stop all (`holds.list` says whether it is held) |
| `features/inspector/TaskStory.tsx` + `story.tsx` | the task's Story tab over `node.story`: one newest-first spine grouped by day, runs nested by lineage with verify, verdicts and (live) answer/stop; `RunConsole` mounts only when a live block is expanded; "Load older" pages by cursor |
| `features/tasks/TaskPage.tsx` + `TaskDefinition.tsx` | the task inspector body: header over Story \| Definition \| Changes; Definition is the editor (kept mounted so a draft survives tab switches; flat boards via `board.schema` hide spec and attachments); Changes mounts `review/ReviewPage` |
| `features/board/boardAgents.ts` | per-board map of live runs and asking tasks (from `runs.active`, `clarify.open`) that cards read through context |
| `features/board/boardAt.ts` | the board at a past `t` (`?t=`): `tasksAt` (tasks that existed, with the status then) and `boardAgentsAt` (live runs and pips then), both from `flow.at`; `BoardPage` is read-only while scrubbed (no drag, moves or create) |
| `features/sessions/SessionCard.tsx` | escalation briefs (`sessions.*`) on Home: read, start, resolve |
| `features/tasks/TaskRunPanel.tsx` | the claiming run's console at the top of the task page |

Tests live next to what they cover: `routes.test.ts` (link shape, and every
procedure the route table names exists on `AppRouter`),
`features/agents/*.test.ts(x)` (one action path, optimistic stop, attention
sort, activity presentation), `features/home/home.test.ts`,
`features/presence/presence.test.ts`,
`features/board/boardAgents.test.ts`, `features/settings/providers.test.ts`,
`features/shell/layout.test.ts` and `features/dispatch/dispatch.test.ts`. Hook
and component tests render with `react-dom/server` (no DOM): effects do not run,
so a hook test captures what the hook returned and calls it.

**Dead code, not yet removed:** `lib/url.ts` (`getBaseUrl()`) is imported by
nothing.

### Screens

| Route | Feature |
|---|---|
| *(every route)* | `presence/PresenceBar` (live dots, needs-you count and popover) |
| `/` | `home/HomePage`: needs queue (`clarify/AnswerBox`, `agents/RunConsole` for approvals, `sessions/SessionCard` escalations), live runs, since you left (`history/ProjectEventFeed` behind a disclosure) |
| `/settings` | `settings/SettingsPage`: projects, providers, appearance |
| `/fleet` | `fleet/FleetPage` (`fleet.summary`: hosts, harness accounts, RunPod, OpenRouter, budgets, plus a Subscriptions panel from `usage.subscriptions`; every occupant chip opens `?node=run:<id>` in its project's Flow) + the Models outcomes table (`stats.outcomes`). Replaces the Models, Resources, RunPod and OpenRouter pages |
| `/fleet/resources`, `/fleet/runpod`, `/fleet/openrouter` | `resources/ResourcesPage`, `runpod/RunPodGlobalPage`, `openrouter/OpenRouterGlobalPage`: the per-resource detail views. `/models`, `/resources`, `/runpod`, `/openrouter` redirect here (`routes/$.tsx`, `legacyFleetPath`) |
| `/p/$project` | `shell/ProjectLayout` (header: lenses Board \| Flow, plus an overflow for ADRs, Triggers, Files, Settings; `projectNav.ts`) |
| `/p/$project/flow` | `flow/FlowPage`: the work tree beside a shared time axis; `?f=` filter, `?w=` window (absent = `fit`: first run of the last day to now), `?t=` right edge (absent = LIVE), `?node=` docks `inspector/Inspector` |
| `/p/$project` | `shell/ProjectLayout` (header: lenses Board \| Flow, plus an overflow for Docs, Triggers, Files, Settings; `projectNav.ts`) |
| `/p/$project/docs/$` | `docs/DocsPage`: the project's documentation. Splat is `<source>/<key>` (`adr/MFW-ADR-7`, `docs/guide/setup.md`), `?q=` the search. Left: `DocsTree` (board types, then configured directories as file trees) or the search results; right: `DocReader` (property header, markdown through `DocMarkdown`: GFM, heading anchors, relative links and images resolved by `docLinks.ts`, ```` ```mermaid ```` fences drawn by `Mermaid` (lazy npm chunk, theme aware, source on failure), `.mmd`/`.svg`/`.png` inline, `.puml` as source) or, for an ADR, `AdrEditor` (the old ADRs page's create/edit/accept/supersede flows). `DocSourcesManager` adds directories (also in project settings); `ImportDocSources` offers detected ones in the import dialog. Pure rules: `docsModel.ts`, `docLinks.ts`, `markdownBlocks.ts`, `sourceDraft.ts`. `/adrs` redirects here. Images stream from `routes/api/docs.$project.$sourceId.$.ts` |
| `/p/$project/flow` | `flow/FlowPage`: the work tree beside a shared time axis; `?f=` filter, `?w=` window, `?t=` right edge (absent = LIVE), `?node=` docks `inspector/Inspector` |
| `/p/$project/board` | `board/BoardPage`; `?node=` docks `inspector/Inspector` beside it |
| `/p/$project/n/$ref` | `inspector/Inspector` as a page (any node ref) |
| `/p/$project/inbox` | `inbox/InboxPage`, narrowed to one project |
| `/p/$project/tasks/$taskId` | `tasks/TaskPage` (tabs: Story, Definition, Changes) + `TaskDefinition` + `DodBuilder` + `DepsPicker` |
| `/p/$project/review` | `review/ReviewQueueList` |
| `/p/$project/review/$taskId` | `review/ReviewPage` + `DiffView` + `diff.ts` |
| `/p/$project/runs` | `agents/AgentsPage` (the **Agents** tab; the path predates the rename and is kept for links) |
| `/p/$project/tasks/$taskId` | `tasks/TaskPage` + `TaskRunPanel` + `DodBuilder` + `DepsPicker` |
| `/p/$project/review/$taskId` | redirects to `/p/$project/board?node=task:<id>&tab=changes`; the screen is `review/ReviewPage` + `DiffView` + `diff.ts`, mounted as the task inspector's **Changes** tab |
| `/p/$project/runs/$runId` | `transcript/RunPage` + `entries.tsx` + `useRunStream` + `agents/useNodeActions` (`useRunControls`) |
| `/p/$project/repo/*` | `repo/RepoPage` (sections Files, Branches, Worktrees, Commits, Compare; the splat is parsed by `repo/repoModel.parseRepoPath`). Files is `files/FilesPage` + `CodeView` + `changes.ts`, now with `?ref=` to browse any branch, tag or commit tree. `repo/branches`, `worktrees`, `commits` (graph lanes from `repoModel.assignLanes`), `compare`, and shared `parts` (`ChangedFiles` with lazy `review/DiffView`) |
| `/p/$project/files` | redirects to `/p/$project/repo/files`, search kept |
| `/p/$project/settings` | `settings/ProjectSettingsPage` → `ProjectConfig` + `board/SeedRuns` + `ResourcesPanel` + `board/WipeBoard` |

`/p/$project` redirects to its board. There are no Now, Inbox, History, Agents or review-list routes: Home is the queue.

Note: `/settings` covers projects, providers and appearance (no daemon
section), and **per-project configuration is a route, not a tab of
`/settings`** (`/p/$project/settings`), so there is no project picker inside a
settings screen.

### Primitives

`src/components/ui/` holds twelve shadcn primitives and no more: `badge`,
`button`, `card`, `checkbox`, `dialog`, `input`, `label`, `scroll-area`,
`select`, `separator`, `tabs`, `textarea`. They come off the `radix-ui`
umbrella package (`import { Dialog as DialogPrimitive } from "radix-ui"`).

Every menu, disclosure, toggle, combobox and toast is hand-rolled on top of
those. `dropdown-menu`, `popover`, `tooltip`, `sonner`, `skeleton`,
`collapsible` and `toggle-group` were specified in ui.md §5 and **none were
added**. The command palette is the exception: it uses `cmdk` directly, with
its own filtering (`features/palette/palette.ts`), inside the `dialog`
primitive.

Beyond the primitives the app does have real dependencies: `@codemirror/*` and
`@uiw/react-codemirror` (read-only viewer in FILES), `react-markdown` +
`remark-gfm` + `unist-util-visit`, `lucide-react`, `superjson`, `@trpc/*`,
`@tanstack/*`. **Do not add more without a good reason**; the diff engine and
the virtual list are hand-written.

`anser` and `@xyflow/react` are in `apps/start/package.json` and imported by
nothing (`@xyflow/react` was for the unbuilt Graph screen).

---

## Looking at it in a real browser

Everything else here is tested as SSR or pure functions, so layout bugs (a
clipped tab strip, a dialog whose Add button sits below the fold, a mobile
board that lands on an empty column) are invisible to the suite.
`tools/ui-capture.ts` drives system Firefox (>= 130, headless, WebDriver BiDi,
no dependency to install) through every main screen at 1920x1080, 1440x900
and 390x844, writes PNGs plus `report.json`, and lists console errors/warnings,
HTTP >= 400 and failed requests per screen. It is read-only: it navigates and
opens dialogs, it never submits.

```
cd apps/start
MFW_BASE_PATH=/ MFW_HOME=$(mktemp -d) bun --bun x vite dev --port 7790   # throwaway daemon
# attach a few repos (tRPC system.addProject / tasks.create), then:
bun tools/ui-capture.ts --base http://127.0.0.1:7790 --out /tmp/ui-shots \
  --projects my-board,my-kanban [--only board] [--sizes 1440x900]
```

To look at a hover state (a tooltip), `bun run screenshots --only fleet` with
`MFW_SHOTS_HOVER='<css selector>'` moves the pointer over the first visible match
before the shot (`Browser.hover` in `tools/screenshots/browser.ts`).

Against the deployed daemon use `--base http://127.0.0.1:7777/mfw`. `vite dev`
needs `MFW_BASE_PATH=/` (see `server/boot.ts`) and sometimes wedges after an
SSR hot reload: restart it if every navigation times out.

### Screenshots for READMEs and the website

`bun run screenshots` (`tools/screenshots.ts`) builds a whole throwaway mfw and
photographs every main section of the app, so README images and the website
page can be refreshed from the current appearance:

```
bun run screenshots                        # dark, 1440x900 @2x, into docs/screenshots/
bun run screenshots --theme both --only home,board,flow
bun run screenshots --publish-dir ~/dev/website/public/mfw   # copy PNGs + index.json, no git
bun run screenshots --dry-run              # validate sections and seed plan, launch nothing
```

Flags: `--out DIR` (default `docs/screenshots/` in the repo, which is tracked so the README and the website can use the images), `--sizes WxH,WxH`, `--scale N`,
`--theme dark|light|both`, `--only a,b`, `--publish-dir DIR`, `--dry-run`,
`--firefox PATH`, `--port N`. Output is `<section>-<theme>-<WxH>.png` plus an
`index.json` manifest (section, title, file, viewport, scale, theme, route,
commit, and the sections skipped with their reason). A section whose route does
not exist in this build (`docs`, `repo`, the board layout switch) is skipped with
a note, not a failure. Console errors, exceptions, HTTP >= 400 and failed
requests are listed per section and make the run exit 1 (the PNGs are still
written).

The run lives in `/tmp/mfw-screenshots-<timestamp>/`: its own
`MFW_HOME`, dev server on a free port, tmux socket `mfw-shots-<pid>`, dummy
repositories, a `HOME` that is not yours, stub `claude`/`codex` binaries first on
`PATH`, and `MFW_USAGE_FIXTURE` so no credential file is ever read. The dev
server, Firefox and the tmux server are stopped by pid and socket at the end,
and on failure or Ctrl-C. The run directory is kept (logs, `seed-info.json`); the PNGs and `index.json` are written to the output directory, not the run directory.

How it works, in `tools/screenshots/`:

- `plan.ts` is pure: the `SECTIONS` array (add a screenshot by adding one line:
  name, title, path with `{p:<project>}`, `{t:<project>:<task>}`, `{r:<run>}`,
  `{g:<group>}` placeholders, optional `action`, `size`, `optional`), CLI parsing,
  the manifest and the seed-plan validator. Tested by
  `src/lib/screenshotsPlan.test.ts`.
- `seedPlan.ts` + `repos.ts` are the data: three projects (a TypeScript API on
  the default template, a docs site with a separate board folder on kanban, a
  data pipeline on planning) with a week of tasks, runs, a brain and usage.
  Times are "minutes before the anchor", so the same plan renders the same
  relative times ("34m ago") on every run.
- Seeding: repositories are real git history with merge commits and review
  branches; projects are attached through `system.addProject` over tRPC; the
  board (tasks, parents, dependencies, ADRs) is written with `mfwb`; the run
  history is written through the db package's own writers (`appendEvent`, which
  derives the span timeline, `recordSpend`, the brain tables as
  `BrainActionService.act` writes them), offline and in time order, because a
  real fake-agent run goes through tmux and takes wall-clock minutes, so
  history could not be days old with controlled costs. The daemon then boots on
  top of it and supervises it as usual. The project with live runs is attached
  last, after their tmux sessions exist (each project's boot reconcile kills
  tmux sessions it does not own, see `supervisor.ts`).
- The page clock is frozen (`Date` answers the seed instant) and the sidebar,
  theme and "since you left" marker are preset in localStorage, so shots do not
  drift. Scrollbars and animations are suppressed.

---

## How it is wired

`src/routes/__root.tsx` is the mount. It creates the QueryClient and tRPC
client once, in state (never at module scope, where the server would share a
cache between requests), and renders the shell:

```tsx
<QueryClientProvider client={queryClient}>
  <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
    <AppShell project={params.project} activePath={pathname} navigate={go}>
      <Outlet />
      <KeyboardHelp />
    </AppShell>
  </TRPCProvider>
</QueryClientProvider>
```

`AppShell` calls `useLiveChannel()` exactly once and publishes the result via
`LiveContext`. **Do not call `useLiveChannel()` anywhere else**: a second call
opens a second SSE stream per project and double-applies every event.

Navigation goes through `useGo()` (`lib/nav.ts`) and `<AppLink>`, not
`<Link to=...>`: these paths are *built* (project names, run ULIDs, task ids)
and the typed `to` overload cannot express them without a cast per call site.
`AppLink` renders a real `<a href={withBase(path)}>` (middle-click and "copy
link" work); a plain left click becomes `router.history.push`, a client-side
navigation. `href` in `routes.tsx` is the only place a path is spelled.

`APP_ROOT` is the empty string and links are single-slash: a leading `//` (as in
`//p/mfw/board`) is read as a protocol-relative URL. `routes.test.ts` asserts
it.

The tRPC mount is `src/routes/api/trpc.$.ts`, serving `appRouter` at
`${BASE_URL}api/trpc`, which is what `trpcEndpoint()` derives rather than
duplicates.

### Layout and scrolling

The shell is a fixed-height flex chain and exactly one element scrolls.
`<body>` is `h-dvh overflow-hidden` (`dvh` not `vh`, because mobile browser
chrome retracts); the shell row is `h-full overflow-hidden`; the content column
is `min-h-0 flex-1 overflow-auto`. `min-h-0` is required: without it a flex child
will not shrink below its content, `overflow-auto` never engages, and the
overflow escapes to the document, taking the sidebar with it. `Panel` carries
`min-h-0` too, so a Panel given a height scrolls its own contents; screens that
manage their own scrolling use `<Page className="h-full">` over a `<Scroller>`.

### Theme

Two switches drive two different things, and both are needed:

- `--mfw-*` tokens key off **`data-theme`** on `<html>` (absent = follow the OS).
- The shadcn primitives' `dark:` utilities compile to a selector under
  **`.dark`**, because `styles.css` declares
  `@custom-variant dark (&:is(.dark *))`.

`useDarkClassSync()` (`lib/theme.ts`, called from `__root.tsx`) is the bridge:
a MutationObserver on `data-theme` plus the OS media query keeps the class in
step with the attribute. Without it every button paints for the wrong theme.

The *first frame* is handled by a synchronous inline script in `<head>` that
reads `localStorage` and sets `data-theme`, `data-density` and the class before
the body paints. The storage keys are duplicated between that script and
`lib/theme.ts` (the script cannot import); each side has a comment pointing at
the other.

Set the preference with `useTheme()`, never by writing the attribute or the
class by hand.

---

## The live channel

One SSE subscription **per attached project** (`live.events` is a
`projectProcedure`), opened by the shell, alive for the app's lifetime.

- Resume: each subscription starts at the last seq this browser applied,
  persisted at `localStorage["mfw:v2:live:seq:<project>"]`. Events are deduped
  by seq, because the transport's own reconnect redials with the original
  `sinceSeq`. There is no `tracked()` on the server side, so resume is entirely
  the client's job.
- Frames are `{ kind: "event" | "gap" | "ping" }`. **`ping` is a 5s keepalive**:
  `Bun.serve` defaults to `idleTimeout: 10` and kills a response that has
  written nothing for ten seconds (a 15s ping made every subscription die
  before its first ping).
- `gap` means the daemon could not backfill (>500 events behind, `MAX_BACKFILL`):
  `invalidateQueries()` with no filter, then resume from `gap.lastSeq`.
- Invalidations are coalesced over 60ms, so a 500-event backfill costs one
  refetch per query rather than five hundred.
- Connection state: `connected` → `reconnecting` → `offline`. The
  `reconnecting` banner waits 1.5s before appearing (the transport redials in a
  few hundred ms); `offline` is 30s. Both transitions are single scheduled
  timeouts, not polls. Recovering from `offline` triggers one full
  invalidation.
- **There is no polling.** The `setInterval`s in the app are render clocks
  that fetch nothing and skip their tick while the tab is hidden: the
  relative-time clock in `RelativeTime.tsx` (one for the whole app), and the
  Flow lens's 5s tick that moves its right edge while LIVE
  (`features/flow/FlowPage.tsx`). The `flow.spans` query range is snapped to a
  bucket (`spanRange`), so a moving clock does not move its query key.

### Transcript streams

Separate from the event channel, every mounted `TranscriptTail` or `RunPage`
holds one `live.runOutput` subscription. The server shares ONE reader per
run across them (`packages/api/src/run-output-hub.ts`: one poll every 500 ms
into a 4 MiB window, each subscriber served by byte offset; a stream behind
the window catches up with direct reads), so a run visible in a card, the
Story and Home at once costs one file read per tick. Still mount tails only
while visible: the dock renders a `RunConsole` for its single expanded
row and picks its desktop or phone variant in JS (a CSS-hidden copy would
stream too); a live Story run block opens its stream only when expanded; NOW renders no
tail. Dock rows themselves read only `runs.active` and `clarify.open`, which
only while visible: Home's needs queue renders a `RunConsole` only for a row
the person expanded (never a CSS-hidden copy, which would stream too);
`TaskRunPanel` closes its stream when collapsed. The presence bar and Home's
live section read only `runs.active`, `inbox.list` and `clarify.open`, which
the event channel already keeps fresh, so six or sixty live runs cost the
same requests. **Not built:** a multiplexed tail feed with one server-side
reader per run; the same run open in a Home row, the task panel and the run
page is three readers today.

### `applyEvent` table

`applyEvent(queryClient, trpc, { project, event })` is the only place that maps
an audit event to cache work. Event types come from `packages/core/src/events.ts`
(`EventSchema`); anything not listed is a **no-op** plus one `console.warn` per
unseen type. Patch only when the payload carries enough to be certainly correct,
and otherwise invalidate the narrowest filter that can have changed.

| Event | Patch | Invalidate |
|---|---|---|
| `task.created` | - | `tasks.list`, `tasks.graph`, `flow.tree`, `system.health` |
| `task.status_changed` | `tasks.list` row `status`; `flow.tree`/`flow.live` task node `status` and its inbox `needsMe`; `flow.spans` status lane (live edge) | `tasks.list`, `tasks.get`, `tasks.graph`, `node.story`, `inbox.list`, `system.health` |
| `task.edited` | - | `tasks.get`, `tasks.list`, `flow.tree`, `flow.live` |
| `task.deleted` | - | `tasks.list`, `tasks.graph`, `inbox.list`, `flow.tree`, `flow.live`, `system.health` |
| `task.claimed` | `tasks.list` row `claimedByRunId` | `tasks.list`, `runs.active` |
| `task.lease_expired` | `tasks.list` row `claimedByRunId = null` | `tasks.list`, `runs.active`, `system.health` |
| `task.held_for_resource` | - | `tasks.list`, `tasks.get`, `flow.spans`, `system.health` |
| `task.conflict` | - | `tasks.get`, `tasks.list` |
| `task.quarantined` | - | `tasks.list`, `inbox.list`, `system.health` |
| `run.started` | `flow.tree`/`flow.live` insert the run node (under its task or parent run) and count it into ancestors' rollups; `flow.spans` state lane opens | `flow.tree`, `flow.live` (harness, host), `runs.active`, `runs.list`, `runs.listAll`, `runs.get`, `runs.steps`, `tasks.list`, `system.health` |
| `run.state_changed` | `runs.active` row `state`/`steerable`, or the row removed once `to` is not an active state (`patchActiveRun`); `flow.tree`/`flow.live` node `state`, `finishedAt`, live/done/needs-me rollups; `flow.spans` state and activity lanes close | `flow.tree` (cost, only when the run ended), `flow.live`, `runs.active`, `runs.list`, `runs.listAll`, `runs.get`, `runs.steps`, `tasks.list`, `inbox.list`, `system.health` |
| `run.activity_changed` | `runs.active` row `activity` (`patchActiveActivity`; also applied as `working` after a steer is delivered); `flow.tree`/`flow.live` node `activity`, `needsMe` and needs-me rollups; `flow.spans` activity lane (close, open) | `runs.active`, `runs.list`, `runs.listAll`, `runs.get`, `runs.steps`, `runs.activity`, `inbox.list` |
| `run.usage_sampled` | `runs.active` row `liveCostUsd` (`patchActiveCost`), the `$` on the agent chip; no refetch (fires at most every 30 s per live run) | - |
| `run.subagents_changed` | - | `flow.tree`, `flow.spans` (a subagent started or finished: its `sub:` node and span) |
| `run.finalize_step` | - | `runs.get`, `runs.steps` |
| `verify.check` | - | `runs.get`, `runs.steps`, `tasks.get`, `node.story`, `flow.spans` (a failed check only) |
| `merge.completed` | - | `flow.spans`, `tasks.list`, `tasks.get`, `node.story`, `runs.list`, `runs.get`, `inbox.list`, `system.health` |
| `merge.deferred` | - | `flow.spans`, `tasks.get`, `tasks.list`, `inbox.list`, `system.health` |
| `main.red` / `main.green` | - | `system.scheduler.status`, `system.scheduler.all`, `inbox.list`, `system.health` |
| `board.suspended` / `board.resumed` | - | `system.scheduler.status`, `system.scheduler.all`, `tasks.list`, `system.health` |
| `scheduler.paused` / `scheduler.resumed` | - | `system.scheduler.status`, `system.scheduler.all`, `system.health` |
| `rate_limit.hit` / `rate_limit.cleared` | - | `system.scheduler.status`, `system.scheduler.all`, `inbox.list`, `system.health` |
| `resource.locked` / `released` / `leaked` / `cleanup` | - | `resources.list`, `system.health` |
| `clarify.raised` / `clarify.resolved` | - | `clarify.open`, `inbox.list`, `system.health` |
| `session.raised` / `opened` / `resolved` | - | `sessions.open`, `sessions.list`, `inbox.list`, `system.health` (+ `runs.active`, `runs.list`, `runs.listAll` on `opened`) |
| `lifetime.fired` | - | `tasks.list`, `tasks.graph` |
| *(`gap` frame)* | - | **everything** (`invalidateEverything`), the Flow caches included |

**Not built:** a rule appending every event to an `events.list` timeline cache
and bumping a Home unseen dot (ui.md §2.4). The raw event feed is per-project
and fetched on demand, and the sidebar has no unseen dot. The per-project
applied seq is in `useLiveChannel().seqByProject`; the *seen* marker is a
separate, user-advanced value (`lib/seen.ts`) that Home's "Since you left" owns.

---

## Error policy

`makeQueryClient()` installs a `MutationCache.onError` that toasts **every**
failed mutation. Opting out must be explicit:

```ts
useMutation(
  trpc.tasks.approve.mutationOptions({
    meta: { label: "Approve" },   // → "Approve failed: …"
    // meta: { toast: false },    // ONLY when the surface renders its own error
  }),
);
```

Rules, from ui.md §3.7:

- **mutations** → toast. Errors carry `duration: 0` and never auto-dismiss.
- **queries** → inline `<ErrorState>` in the panel that owns them, with `Retry`.
  Never a toast for a background refetch. A failed panel never blanks siblings.
- **streams** → surfaced in place, never as a toast.
- Toasts are hand-rolled in `lib/toast.tsx`; `sonner` is not a dependency.
- `toastBus` supports an `action` (label + onClick). Nothing supplies one yet.

**`.catch(() => {})` is banned for anything that can fail meaningfully.** Two
exist, both on optional lazy-load paths in FILES: the CodeMirror
language-grammar load in `features/files/CodeView.tsx` (a missing grammar
leaves the text readable and unhighlighted) and the dynamic
`import("./CodeView")` in `features/files/FilesPage.tsx` (uncommented; a failed
chunk silently pins the viewer to its plain `<pre>` fallback). Neither swallows
a mutation or a data error.

---

## Tokens

All tokens are prefixed `--mfw-`: `styles.css` declares the unprefixed shadcn
names (`--background`, `--foreground`, `--accent`, ...) on `:root` for the
primitives, so an unprefixed `--accent` in `tokens.css` would repaint them.

**Do not write a color anywhere but `tokens.css`.** Consume them with
`style={{ color: "var(--mfw-fg-muted)" }}` or Tailwind arbitrary values
(`className="bg-[var(--mfw-bg-raised)]"`); `tokens.css` is a standalone
stylesheet, so `@theme`-generated Tailwind utilities are *not* available for
these names.

- surfaces: `--mfw-bg`, `-bg-subtle`, `-bg-raised`, `-bg-inset`, `-bg-hover`
- lines: `--mfw-border`, `--mfw-border-strong`
- text: `--mfw-fg`, `-fg-muted`, `-fg-faint`, `-fg-on-accent`
- accent (interaction only): `--mfw-accent`, `-accent-hover`, `-accent-subtle`
- semantics (meaning only): `--mfw-ok`, `--mfw-warn`, `--mfw-critical`,
  `--mfw-info`, `--mfw-neutral` (the accent hue is *not* one of these)
- task status ramp: `--mfw-status-{backlog,ready,in-progress,blocked,review,done,archived}`
- diff: `--mfw-diff-{add,del}-bg` are used by `DiffView`;
  `--mfw-diff-{add,del}-hl` exist for intra-line highlighting that was never
  built
- size scale: `--mfw-text-{2xs,xs,sm,md,lg,xl,2xl}` (13px = `sm` is the data
  base), `--mfw-leading-{data,prose}`
- font families: only `--mfw-font-ui` and `--mfw-font-mono`, both system
  stacks. (`--mfw-font-data` is a *size*, aliasing `--mfw-text-sm`, switched by
  density.)
- space: `--mfw-space-{1,2,3,4,5,6,8}` (4px grid)
- radii: `--mfw-radius-{sm,md,lg}` (4/6/10px)
- density: `--mfw-row-h`, `--mfw-font-data` (switched by `[data-density]`)
- helper classes: `.mfw-v2` (root wrapper), `.mfw-num` (tabular mono),
  `.mfw-focus`, `.mfw-pulse`, `.mfw-skeleton`

Theme resolution: no `data-theme` → follow the OS; `data-theme="light|dark"`
wins in both directions. The pre-paint bootstrap is done; see "Theme" above.

---

## What is left

The screens for Home (needs, live, since you left), review (the Changes tab), the transcript viewer, the board,
task detail (with its spec and attachments), TRIGGERS, FILES, project settings
and machine settings are built. What ui.md describes and this does **not** have:

- **Graph** (`/p/$project/graph`): no route, feature directory or tab.
  `tasks.graph` ships on the API and `applyEvent` invalidates it (currently
  dead code); `@xyflow/react` is an unused dependency for it.
- ~~**Scheduler control**~~: built. `features/dispatch/` renders a play/stop
  per project in each desktop sidebar row and, where that sidebar is absent, in
  the mobile project-route header. A separate tri-state global mfw control lives
  in the shell, over `system.scheduler.status/set/all/setAll`.
  `kick` and `hold` still have no caller.
- **Browser notifications** (ui.md §2.3): no `Notification` call, favicon
  variant, per-kind toggles, or `/settings` section. The permission prompt must
  not be automatic when built.
- ~~**Command palette** and the `g ...` chord shortcuts~~: built (`Ctrl K` (command key on macOS), `g h`,
  `g b`, `g f`). Not built: `>` verbs scoped to the selection (only navigation
  commands exist), and `g l` (no Fleet page). `g f` targets `/p/$project/flow`
  (the Flow lens).
- **Inspector**: docked panes have fixed widths (not resizable); only task and
  run nodes have bodies, other kinds render a placeholder.
- **Board keyboard shortcuts**: the board registers no `useKeyBindings` scope.
- **Syntax highlighting and intra-line diffing in the review diff**:
  `@codemirror/merge` is not a dependency, so `review/diff.ts` computes the
  alignment (common-prefix/suffix trim + bounded LCS, `collapse(rows, 3)`) and
  `DiffView` renders it: side-by-side ≥1000px, unified below, collapsed
  unchanged regions, gutter-anchored comments. Highlighting is what the merge
  view would have added. (CodeMirror *is* used in the app, read-only, in the
  FILES viewer.)
- **Task-editor three-way merge** (ui.md §3.5): the conflict bar offers
  "Reload theirs" / "Keep mine"; field-granular merge would remove the
  blind-overwrite path.
- **Route loaders**: no route file defines one; every screen fetches
  in-component and renders a skeleton on cold cache.

Already built, so do not re-plan: the **raw event feed** (under Since you left)
(`history/ProjectEventFeed.tsx`, paging `events.list` by `beforeSeq`, mounted
on demand per project) and **clarify answering from the INBOX**
(`clarify/ClarifyDialog.tsx` over `clarify.get/answer/dismiss`, with an
optional re-plan).

---

## Conventions to keep

- Never hand-copy a server type. Use `RouterOutputs["tasks"]["list"][number]`
  from `lib/trpc.ts`, or import the type from `@mfw/api/...`. There is no
  `shared.ts` of zod enums; a screen that needs a status list declares its own
  local const.
- URL is the only navigation state; no view state in modals (ephemeral input
  dialogs are fine). If you can look at it, it should have a link.
- `applyEvent` and `lib/keyboard.ts` are the only registries. No scattered
  `useEffect` event or key listeners: a surface declares its shortcuts with
  `useKeyBindings([...])` and the innermost mounted scope wins a key.
- Optimistic mutations snapshot in `onMutate` and restore in `onError`, always
  both. Write them as `useMutation(trpc.x.mutationOptions({ … }))`, not
  `useMutation({ ...trpc.x.mutationOptions(), … })`: only the first form infers
  the context type your rollback reads.
- Destructive actions go through `ConfirmDialog` with an exact string to type.
  `window.confirm` appears nowhere in `src/` and must not start.
- Badges come from the query that backs the surface they point at.
- Icons: lucide-react only, no emoji in UI chrome. lucide 1.x dropped the
  old aliases: `TriangleAlert`, not `AlertTriangle`; `CircleCheck`, not
  `CheckCircle2`; `CircleQuestionMark`, not `HelpCircle`.
- State and event marks are SVG icons from one registry,
  `components/icons/glyphs.ts` (`GLYPHS`, drawn by `<Glyph name=...>`): a
  monochrome lucide icon in the state's token colour, with an `aria-label` or
  `title`. `components/agent/look.ts` maps states to a glyph name and a word;
  the Flow timeline's event marks are their own set (`features/flow/marks.tsx`,
  `MARK_LOOK`: one geometric SVG shape and one colour per kind, 16px) that the
  cell, the hover card and the legend all read. Never type a pictograph or symbol
  character (check, cross, dot, diamond, flag, hand, arrows) into JSX or a
  string: `noEmoji.test.ts` fails on a denylist of code points (plain
  typography such as `…`, `·`, `→`, `×` is fine). Add a new mark to
  `GLYPHS`, not inline.
- Keyboard hints go through `components/ShortcutKbd.tsx` / `describeKey`
  (`lib/keyboard.ts`) with `useIsMac()` (`lib/platform.ts`): `Ctrl K` on
  Linux and Windows, the command-key symbol on macOS, resolved after mount so
  server and client markup agree.
- When you assert something in a comment or a doc, name the file you checked.
