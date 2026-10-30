# Home title — Cult UI PixelHeading options

Preview: `npm run preview:title` (opens `/preview-title.html`).

## What was installed, and how

Per the Cult UI rules, the component came from the registry — it was **not**
recreated by hand:

```bash
npx shadcn@latest add @cult-ui/pixel-heading-character --yes
```

Result: `src/components/ui/pixel-heading-character.tsx` (528 lines, full
registry source including `showLabel`, `onFontIndexChange`, `prefix`,
`prefixFont`, `isolate`). This file is owned code — edit it there.

The project had **no Tailwind and no shadcn** before this, so the minimum
scaffolding was added first:

| Piece | File | Note |
| --- | --- | --- |
| Tailwind v4 + Vite plugin | `package.json`, `vite.config.ts` | `tailwindcss@4.3.3`, `@tailwindcss/vite` |
| Tailwind entry (scoped) | `src/styles/tailwind.css` | theme tokens + presets only |
| shadcn config | `components.json` | `style: new-york`, css → `src/styles/tailwind.css` |
| `cn()` helper | `src/lib/utils.ts` | required by every `components/ui` file |
| Path aliases | `tsconfig.json` | root-level `paths`, needed for the CLI to resolve `@/` |
| Pixel font faces | `src/styles/geist-pixel.css` | see "Font wiring" below |

## Font wiring — why not `geist/font/pixel`

The docs say to import from `geist/font/pixel` and put the `.variable` classes on
`<html>`. **That entry point does not work here**: it is a Next.js `localFont`
wrapper (`import localFont from "next/font/local"`), and this is a Vite
renderer. Importing it throws at runtime.

Instead `src/styles/geist-pixel.css` declares the five faces directly against the
woff2 files shipped inside `geist@1.8.2`, and sets **the same CSS variable names**
the component's Tailwind classes expect:

```css
:root {
  --font-geist-pixel-square: 'Geist Pixel Square';
  /* … grid / circle / triangle / line */
}
```

Note `geist` must be **>= 1.8.0** — 1.3.x has no pixel fonts at all.

## Coexistence with the existing hand-written CSS

The app's UI is ~8k lines of tuned CSS in `src/styles/` (design tokens, 9 skins,
component scopes). It was **not** migrated to Tailwind. The two layers coexist:

```
src/styles/main.css        → design tokens + element defaults
src/styles/components.css  → component scopes
src/styles/tailwind.css    → shadcn tokens + utilities, for components/ui only
```

Two deliberate choices:

1. **Preflight is not imported.** Tailwind's reset would override the
   `button / input / select` element rules in `main.css`, which the existing
   chrome depends on. Only `theme.css` and `utilities.css` are pulled in.
2. **shadcn tokens alias the existing palette.** `--color-background` maps to
   `var(--bg-app)`, `--color-ring` to `var(--accent)`, etc. A component dropped
   into a panel inherits the current skin instead of looking foreign.

Verified against the shipped 0.1.4 CSS: **0 selectors removed**, 192 added
(Tailwind utilities + font faces + presets). `.btn-primary`, `button{...}` reset
and `body` metrics are byte-identical.

## Shipped: Ember Duotone (option 03)

`WelcomePanel.tsx` now renders the title through PixelHeading:

```tsx
<PixelHeading as="h2" mode="random" className="px-title px-grad-ember welcome-title">
  Keyper
</PixelHeading>
```

`random` at rest uses the golden-ratio split; on hover/focus each character
scrambles independently, which reads as live data rather than a static logo.
`autoPlay` is deliberately **off** — the home tab can stay open for hours, and a
perpetually animating title competes with the connection list.

Gradient: `#dc382d → #f4650f → #e5a13a → #f472b6 → #a78bfa` at 92°, with an 11s
drift. Deep and light themes carry separate stops.

Verified against the golden-ratio expectation (`floor(i × φ × 5) mod 5`):

```
Square,Triangle,Grid,Line,Circle,Square,Triangle,Grid,Line,Circle,Square   PASS
```

### Sizing: why 56px

The five Geist pixel variants share **identical advance widths** — measured
spread across all five was **0%** at every size from 22px to 80px. They are
design variants of one metric family, so "changing font" is only visible as a
change in the *ink* inside each glyph cell. Measured ink-coverage spread:

| size | 22px | 30px | 37px | 44px | 54px | 68px | 80px |
| --- | --- | --- | --- | --- | --- | --- | --- |
| spread | 11% | 19% | 16% | 31% | 33% | 42% | 59% |

At 37px (the first attempt) the five families were effectively
indistinguishable — the component degraded to "one pixel font + a gradient".
56px sits around the 33% mark, where the switch is visible without the title
overwhelming the hero.

`font-size: clamp(36px, 4vw, 56px)` keeps it readable in narrow windows.

### Badge alignment and logo scoping

Two defects were found while wiring the badge:

1. **Logo collapsed to 22px.** `.s-app .logo` (the 22px topbar brand mark) also
   matched the welcome logo, because the welcome panel lives inside `.s-app`.
   Both rules were scoped to `.s-app .brand .logo`. This was a pre-existing CSS
   scope collision, not something Tailwind introduced — the larger title just
   made it visible.
2. **Centring looked detached.** With `align-items: center` and a much shorter
   badge, the mark floated in the gap between title and subtitle. The grid layout
   above replaces that entirely.

## Light theme

Pastels are tuned for a dark canvas. Measured on `#f4f5f7`, option 02's cyan head
fell to **39 visible pixels** in its first quarter — effectively invisible. Light
overrides deepen the same hues (`[data-theme='light'] .px-grad-ember`).

## Structural notes

- **Gradient clipping.** `PixelHeading` renders one `<span>` per character, so a
  gradient on the heading would restart at every glyph. `.px-grad-ember` paints
  the background and `.px-title span` forces every child transparent via
  `-webkit-text-fill-color`.
- **`uniform` mode has no spans.** It returns `children` directly, so the heading
  holds a single text node. That is the registry contract; the gradient still
  applies because the clip lives on the heading. Do not "fix" it by wrapping
  spans.
- **Reduced motion.** Handled in two places, because they are two mechanisms:
  - `tailwind.css` freezes the gradient drift (`animation: none`) under
    `prefers-reduced-motion: reduce`;
  - the component stops the 50 ms font-swap timer. The registry source has **no**
    such handling, so it was added to `src/components/ui/pixel-heading-character.tsx`
    (the file is owned code). The preference is *subscribed*, not sampled once,
    so toggling it in the OS takes effect without a reload, and turning it on
    mid-animation also clears the running interval.

  Verified: with the preference on, hover leaves `data-state="idle"` and the font
  sequence unchanged; the computed `animation-name` goes from `px-sweep` to
  `none`.

## Verification scripts

| Script | Checks |
| --- | --- |
| `check-welcome-title.cjs` | component mounted, mode, span count, 5-family mix, clip |
| `measure-hero.cjs` | logo size, optical alignment vs glyph cap, theme gradient |
| `verify-hero-theme.cjs` | canvas is actually dark/light (pixel-sampled) |
| `verify-title-interaction.cjs` | golden ratio, hover activate, leave stop, Enter step |
| `verify-reduced-motion.cjs` | CSS drift frozen |
| `verify-reduced-motion-js.cjs` | font-swap timer suppressed |
| `measure-pixel-fonts.cjs` | advance-width spread across families |
| `measure-pixel-ink.cjs` | ink-coverage spread per size |
| `capture-home-page.cjs` | full-page screenshot |

All Electron capture scripts force a repaint (two rAF + a size nudge) before
`capturePage()`; without it the compositor returns the *previous* frame and the
screenshot shows the old theme — this produced a false "dark theme is still
white" reading during development.

## Previous comparison page

`src/preview/HomeTitleOptions.tsx` (opened via `npm run preview:title`) used to
compare all four presets. It now shows only the shipped option, with live
controls for `mode` / `cycleInterval` / `staggerDelay` / `autoPlay`, so the
production props can be tuned by feel.

The earlier hand-written `previews/home-title-options.html` (React UMD + a
hand-ported component) is superseded by the real component and is kept only as
history.

## Hero layout: icon spans both lines

The hero is a 2×2 grid, not a flex row:

```css
.hero {
  --title-size: clamp(36px, 4vw, 56px);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  column-gap: 16px;
  row-gap: 4px;
}
.logo { grid-row: 1 / -1; aspect-ratio: 1 / 1; }
```

`grid-row: 1 / -1` makes the badge exactly as tall as the two text rows — no
magic numbers, and it tracks the `clamp()` title size automatically. The three
elements must be **siblings** in the grid; wrapping the text in a `.hero-text`
div would make the badge match that wrapper instead of the two rows.

### Filling both lines exactly

The badge is stretched to the full two-row height, not to the text ink:

```css
.logo {
  grid-row: 1 / -1;
  align-self: stretch;
  block-size: 100%;
  aspect-ratio: 1 / 1;
}
```

Measured at 1440×900: badge **88.83 × 88.83**, identical to the sum of the title
and subtitle line boxes plus the row gap, and its top edge is at the same y as
the title's line-box top (**Δ 0.00px**).

An earlier revision shrank the badge to 80% so its edges matched the *ink*
rather than the line boxes (ink is ~71px vs 88.83px of line box, because a line
box carries half-leading above and below the glyphs). That reads as "badge
slightly smaller than the text block" — the opposite of the intent, so it was
reverted. The distinction worth keeping:

| layer | what it measures | which question it answers |
| --- | --- | --- |
| line box | layout box including leading | "does the badge fill the block?" |
| ink | actual glyph pixels | "do the edges look optically even?" |

Filling the block is what was asked for; the ink will always sit inset from the
badge edges, which is correct.

### Top spacing and left alignment

- `.inner` padding-top went from 52px to 26px. Combined with the 34px topbar the
  first line of content now starts ~72px from the window top instead of ~98px.
- `.inner` is left-aligned (`margin: 0` instead of `0 auto`). When centred, the
  hero badge sat 407px from the workspace's left edge while the topbar brand
  mark sat 14px from the window edge — two brand marks on unrelated axes. Left
  alignment puts both on the same 32px gutter.

### Autoplay

`autoPlay` is on: the title starts cycling on mount rather than on hover. It is
the only animation on the home tab, and the component still stops itself when
`prefers-reduced-motion: reduce` is active (the preference is subscribed, so
toggling it in the OS takes effect without a reload).
