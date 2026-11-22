# Themes (temporary preview)

Candidate ways of working, so one can be chosen by using it. Each changes the
layout and how information is presented, not only the colours. `data-theme` on
`<html>` selects the theme, and `data-mode` (`light`, `dark`, or absent to
follow the OS) selects the variant.

| Id | Idea | The task it serves | What it deliberately does not do |
|---|---|---|---|
| `classic` | The original look. Its values live in `styles/tokens.css`. | Baseline | |
| `docket` | Everything open is one numbered list | Clearing the queue across many projects | No cards, no decoration |
| `switchyard` | Work laid out in lanes by stage, with a bottom dock | Comparing where work stands at a glance | Home does not scroll as a page on a desktop |
| `singlefile` | One centred column, the next decision large | Deciding carefully, one thing at a time | Does not show everything at once |
| `bench` | Tiled panes, the queue always on the right | Drilling into work without losing the queue | Does not hide context behind navigation |

Switch with the palette button in the nav (or the phone header), or with a
link: `?theme=bench&mode=dark`. A link previews without saving; picking from the
menu saves to `localStorage`.

## How a theme changes the layout

The theme is not known during server rendering, so skeletons are CSS: shared
components carry stable `data-ui` hooks (`shell-body`, `rail`, `need`,
`home-grid`, `lead-grid`, ...) and each theme file rearranges them. There is one
copy of the data and the markup. The exception is `BenchPane.tsx`, mounted only
while Bench is painted.

## Files

- `registry.ts`: the list of themes, the only place they are registered
- `index.css`: imports each theme file
- `bridge.css`: maps the shadcn variables onto the `--mfw-*` tokens, and lays the nav flat for the themes without a left rail
- `<id>.css`: one theme (fonts, shape tokens, light and dark colours, its layout)
- `BenchPane.tsx`: Bench's persistent queue pane
- `bootstrap.ts`: the pre-paint script
- `useThemeName.ts`, `ThemeSwitcher.tsx`: the state and the menu

## Fonts

Bundled through `@fontsource`, all SIL OFL 1.1, and fetched from this server
only when a theme uses them: IBM Plex Sans Condensed, IBM Plex Mono, Archivo,
Martian Mono, Figtree, JetBrains Mono, Source Sans 3. `@fontsource-variable/fraunces`
and `@fontsource-variable/newsreader` are left over from the first round and
imported by nothing; remove them with the cleanup below.

## Keeping one theme and removing the rest

To keep `<id>` (skip steps 1-2 if keeping `classic`):

1. Keep `<id>.css` and `bridge.css`, importing them directly from `styles.css`
   in place of `index.css`.
2. Set `DEFAULT_THEME` to `<id>` in `registry.ts`.
3. Delete the other `<id>.css` files, their `@import` lines and their entries in
   `registry.ts`, then remove the `@fontsource*` packages nothing imports.
   Unless keeping `bench`, delete `BenchPane.tsx` and its use in
   `components/AppShell.tsx`.
4. Drop the switcher: delete `ThemeSwitcher.tsx` and its two uses in
   `components/AppShell.tsx`. The Settings page keeps the light/dark control.

To remove the theme system entirely, also delete this directory, the
`@import "./themes/index.css"` line in `styles.css`, and restore a plain
bootstrap in `routes/__root.tsx`. The `data-ui` attributes are inert without it.
