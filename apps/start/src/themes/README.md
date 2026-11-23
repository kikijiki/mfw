# Themes (temporary preview)

Candidate design languages, so one can be chosen by using it. A theme changes
the **style** and never the layout: every theme has Classic's sidebar, header,
page structure, component placement and DOM order. `data-theme` on `<html>`
selects the theme, and `data-mode` (`light`, `dark`, or absent to follow the OS)
selects the variant.

| Id | Idea | Shape and surfaces | Type | Status |
|---|---|---|---|---|
| `classic` | The original look. Its values live in `styles/tokens.css`. | Baseline | System | Tinted pill |
| `margin` | Hairlines and whitespace, nothing filled | Square, open rows, one-edge rules | Source Sans 3, light titles | Icon and word, no box |
| `pebble` | Soft layered surfaces | Large radii, shadows instead of lines | Figtree | Soft tinted pill |
| `gauge` | Dense and exact | Square, strong rules, tight rows | IBM Plex Sans Condensed and Mono, uppercase titles | Tag with a leading bar |
| `slab` | Chunky and direct | Thick borders, flat blocks | Archivo, heavy and large | Heavy outlined label |

Colours stay close to Classic's muted family in every theme.

Switch with the palette button in the nav (or the phone header), or with a
link: `?theme=slab&mode=dark`. A link previews without saving; picking from the
menu saves to `localStorage`.

## What a theme may change

Tokens, and restyling of existing elements through `data-theme` selectors:
colour, borders, radii, shadows, type, and the padding and gaps that set
density. It may not move, reorder or hide anything. `themes.test.ts` fails on
`display`, `position`, `flex-direction`, `flex-wrap`, `order`, `float`, `grid-*`,
`inset`, `translate` or `visibility` in a theme file, unless the declaration is
listed with a reason in its `LAYOUT_ALLOWLIST` (empty today).

Selectors use hooks the app already has (`data-slot`, `data-need`, `data-card`,
`data-testid="project-row"`, `.mfw-panel`) plus two inert class names,
`.mfw-status` (`StatusPill`) and `.mfw-chip` (`Chip`).

## Files

- `registry.ts`: the list of themes, the only place they are registered
- `index.css`: imports each theme file
- `bridge.css`: maps the shadcn variables onto the `--mfw-*` tokens
- `<id>.css`: one theme (fonts, tokens, light and dark colours, component styles)
- `bootstrap.ts`: the pre-paint script
- `useThemeName.ts`, `ThemeSwitcher.tsx`: the state and the menu

## Fonts

Bundled through `@fontsource`, all SIL OFL 1.1, and fetched from this server
only when a theme uses them: Source Sans 3, Figtree, IBM Plex Sans Condensed,
IBM Plex Mono, Archivo, JetBrains Mono.

## Keeping one theme and removing the rest

To keep `<id>` (skip steps 1-2 if keeping `classic`):

1. Keep `<id>.css` and `bridge.css`, importing them directly from `styles.css`
   in place of `index.css`.
2. Set `DEFAULT_THEME` to `<id>` in `registry.ts`.
3. Delete the other `<id>.css` files, their `@import` lines and their entries in
   `registry.ts`, then remove the `@fontsource*` packages nothing imports.
4. Drop the switcher: delete `ThemeSwitcher.tsx` and its two uses in
   `components/AppShell.tsx`. The Settings page keeps the light/dark control.

To remove the theme system entirely, also delete this directory, the
`@import "./themes/index.css"` line in `styles.css`, and restore a plain
bootstrap in `routes/__root.tsx`. The `.mfw-status` and `.mfw-chip` class names
are inert without it.
