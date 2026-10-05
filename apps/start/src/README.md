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
| `lib/keyboard.ts` | the ONE shortcut registry (ui.md §8): `useKeyBindings`, `activeBindings`, `describeKey` |
| `lib/nav.ts` | `useGo()`, `useMediaQuery()`, `useWideViewport()` |
| `lib/seen.ts` | HISTORY since-marker (per device, per project) |
| `lib/format.ts` | `formatCost/formatTokens/formatDuration/formatRelative/formatAbsolute`, plus `humanizeToken` and `summarizePayload` for raw event rows |
| `lib/markdown.tsx` | the markdown renderer (react-markdown + remark-gfm) |
| `lib/utils.ts` | `cn()` |
| `styles/tokens.css` | the whole design system (ui.md §6) |
| `styles.css` | Tailwind entry, the shadcn variables, and the `@custom-variant` declarations |
| `components/AppShell.tsx` | shell: nav, inbox badge, project switcher, health dot + banner |
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
| `features/dispatch/DispatchControls.tsx` | per-project play/stop + the separate tri-state global mfw control |
| `features/dispatch/state.ts` | the wording: labels, tones, and the "who stopped it" sentence |

Tests live next to what they cover: `routes.test.ts` (link shape),
`features/settings/providers.test.ts`, `features/shell/layout.test.ts` and
`features/dispatch/dispatch.test.ts`.

**Dead code, not yet removed:** `lib/url.ts` (`getBaseUrl()`) is imported by
nothing.

### Screens

| Route | Feature |
|---|---|
| `/now` | `now/NowPage` + `transcript/TranscriptTail` |
| `/inbox` | `inbox/InboxPage` + `inbox/useInbox` + `clarify/ClarifyDialog` |
| `/history` | `history/HistoryPage` + `history/ProjectEventFeed` |
| `/settings` | `settings/SettingsPage`: projects, providers, appearance |
| `/p/$project` | `shell/ProjectLayout` (header + tab strip) |
| `/p/$project/board` | `board/BoardPage` |
| `/p/$project/inbox` | `inbox/InboxPage`, narrowed to one project |
| `/p/$project/tasks/$taskId` | `tasks/TaskPage` + `DodBuilder` + `DepsPicker` |
| `/p/$project/review` | `review/ReviewQueueList` |
| `/p/$project/review/$taskId` | `review/ReviewPage` + `DiffView` + `diff.ts` |
| `/p/$project/runs` | `transcript/RunsListPage` |
| `/p/$project/runs/$runId` | `transcript/RunPage` + `entries.tsx` + `useRunStream` |
| `/p/$project/files` | `files/FilesPage` + `CodeView` + `changes.ts` |
| `/p/$project/settings` | `settings/ProjectSettingsPage` → `ProjectConfig` + `board/SeedRuns` + `ResourcesPanel` + `board/WipeBoard` |

`/` redirects to `/now`; `/p/$project` redirects to its board.

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
those. `dropdown-menu`, `popover`, `command`, `tooltip`, `sonner`, `sheet`,
`skeleton`, `switch`, `alert`, `collapsible` and `toggle-group` were specified
in ui.md §5 and **none were added** (hence no command palette).

Beyond the primitives the app does have real dependencies: `@codemirror/*` and
`@uiw/react-codemirror` (read-only viewer in FILES), `react-markdown` +
`remark-gfm` + `unist-util-visit`, `lucide-react`, `superjson`, `@trpc/*`,
`@tanstack/*`. **Do not add more without a good reason**; the diff engine and
the virtual list are hand-written.

`anser` and `@xyflow/react` are in `apps/start/package.json` and imported by
nothing (`@xyflow/react` was for the unbuilt Graph screen).

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
- **There is no polling.** The lone `setInterval` in the app is the
  relative-time clock in `RelativeTime.tsx`, which fetches nothing, runs once
  for the whole app, and skips its tick while the tab is hidden.

### `applyEvent` table

`applyEvent(queryClient, trpc, { project, event })` is the only place that maps
an audit event to cache work. Event types come from `packages/core/src/events.ts`
(`EventSchema`); anything not listed is a **no-op** plus one `console.warn` per
unseen type. Patch only when the payload carries enough to be certainly correct,
and otherwise invalidate the narrowest filter that can have changed.

| Event | Patch | Invalidate |
|---|---|---|
| `task.created` | - | `tasks.list`, `tasks.graph`, `system.health` |
| `task.status_changed` | `tasks.list` row `status` | `tasks.list`, `tasks.get`, `tasks.graph`, `system.taskTrace`, `inbox.list`, `system.health` |
| `task.edited` | - | `tasks.get`, `tasks.list` |
| `task.deleted` | - | `tasks.list`, `tasks.graph`, `inbox.list`, `system.health` |
| `task.claimed` | `tasks.list` row `claimedByRunId` | `tasks.list`, `runs.active` |
| `task.lease_expired` | `tasks.list` row `claimedByRunId = null` | `tasks.list`, `runs.active`, `system.health` |
| `task.held_for_resource` | - | `tasks.list`, `tasks.get`, `system.health` |
| `task.conflict` | - | `tasks.get`, `tasks.list` |
| `task.quarantined` | - | `tasks.list`, `inbox.list`, `system.health` |
| `run.started` | - | `runs.active`, `runs.list`, `runs.get`, `runs.steps`, `tasks.list`, `system.health` |
| `run.state_changed` | - | `runs.active`, `runs.list`, `runs.get`, `runs.steps`, `tasks.list`, `inbox.list`, `system.health` |
| `run.finalize_step` | - | `runs.get`, `runs.steps` |
| `verify.check` | - | `runs.get`, `runs.steps`, `tasks.get`, `system.taskTrace` |
| `merge.completed` | - | `tasks.list`, `tasks.get`, `system.taskTrace`, `runs.list`, `runs.get`, `inbox.list`, `system.health` |
| `merge.deferred` | - | `tasks.get`, `tasks.list`, `inbox.list`, `system.health` |
| `main.red` / `main.green` | - | `system.scheduler.status`, `system.scheduler.all`, `inbox.list`, `system.health` |
| `board.suspended` / `board.resumed` | - | `system.scheduler.status`, `system.scheduler.all`, `tasks.list`, `system.health` |
| `scheduler.paused` / `scheduler.resumed` | - | `system.scheduler.status`, `system.scheduler.all`, `system.health` |
| `rate_limit.hit` / `rate_limit.cleared` | - | `system.scheduler.status`, `system.scheduler.all`, `inbox.list`, `system.health` |
| `resource.locked` / `released` / `leaked` / `cleanup` | - | `resources.list`, `system.health` |
| `clarify.raised` / `clarify.resolved` | - | `inbox.list`, `system.health` |
| `lifetime.fired` | - | `tasks.list`, `tasks.graph` |
| *(`gap` frame)* | - | **everything** |

**Not built:** a rule appending every event to an `events.list` timeline cache
and bumping a HISTORY unseen dot (ui.md §2.4). The raw event feed is per-project
and fetched on demand, and the sidebar has no History dot. The per-project
applied seq is in `useLiveChannel().seqByProject`; the *seen* marker is a
separate, user-advanced value (`lib/seen.ts`) that HISTORY owns.

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

The screens for NOW, INBOX, HISTORY, REVIEW, the transcript viewer, the board,
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
- **Command palette** and the `g ...` chord shortcuts: `lib/keyboard.ts`
  resolves single keys and modifier chords, not two-key sequences (`normalize()`
  only splits on `+`). The palette also needs a `command` primitive.
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

Already built, so do not re-plan: the **HISTORY raw event feed**
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
- When you assert something in a comment or a doc, name the file you checked.
