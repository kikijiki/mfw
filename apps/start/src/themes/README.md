# Themes (temporary preview)

Several candidate looks, so one can be chosen by using them. `data-theme` on
`<html>` selects the theme, and `data-mode` (`light`, `dark`, or absent to
follow the OS) selects the variant.

| Id | Direction |
|---|---|
| `classic` | The original look. Its values live in `styles/tokens.css`. |
| `broadsheet` | Editorial: serif heads, hairline rules, ink on warm paper |
| `swiss` | International Style: grotesque type, square, black acts, red signals |
| `control` | Operations console: condensed, mono numerals, amber on near-black |
| `fieldnotes` | Calm and natural: moss, clay, soft shapes, generous rows |
| `teletype` | Brutalist instrument: all mono, 2px rules, hard offset blocks |

Switch with the palette button in the sidebar (or the phone header), or with a
link: `?theme=swiss&mode=dark`. A link previews without saving; picking from the
menu saves to `localStorage`.

## Files

- `registry.ts`: the list of themes, the only place they are registered
- `index.css`: imports each theme file
- `bridge.css`: maps the shadcn variables onto the `--mfw-*` tokens
- `<id>.css`: one theme (fonts, shape tokens, light and dark colours, a few structural rules)
- `bootstrap.ts`: the pre-paint script
- `useThemeName.ts`, `ThemeSwitcher.tsx`: the state and the menu

## Fonts

Bundled through `@fontsource`, all SIL OFL 1.1, and fetched from this server
only when a theme uses them: Newsreader, Source Sans 3, Archivo, IBM Plex Mono,
IBM Plex Sans Condensed, Fraunces, Figtree, JetBrains Mono, Martian Mono.

## Keeping one theme and removing the rest

To keep `<id>` (skip steps 1-2 if keeping `classic`):

1. Move the values from `<id>.css` and `bridge.css` into `styles/tokens.css`
   and `styles.css`, or keep those two files and import them directly from
   `styles.css` in place of `index.css`.
2. Set `DEFAULT_THEME` to `<id>` in `registry.ts`.
3. Delete the other `<id>.css` files, their `@import` lines and their entries in
   `registry.ts`, then remove the `@fontsource*` packages nothing imports.
4. Drop the switcher: delete `ThemeSwitcher.tsx` and its two uses in
   `components/AppShell.tsx`. The Settings page keeps the light/dark control.

To remove the theme system entirely, also delete this directory, the
`@import "./themes/index.css"` line in `styles.css`, and restore a plain
bootstrap in `routes/__root.tsx`.
