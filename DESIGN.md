# no-sdr Design System

## Design Philosophy

no-sdr's interface draws from **military avionics** and **broadcast studio equipment** — tactile hardware controls, high information density, and data-first presentation. The UI recedes into near-black so the waterfall and spectrum (live RF data) become the primary visual focus.

### Core Principles

1. **Dark-first, blue-tinted** — background scale uses blue-black (`#07090e` → `#1a2435`), creating an instrumentation/monitoring feel
2. **Theme-adaptive accent** — a single `--sdr-accent` variable drives all highlights (cyan, phosphor green, or amber). Components never hardcode accent colors
3. **Monospace-dominant** — virtually all text uses JetBrains Mono with uppercase + letter-spacing, matching technical readouts and radio equipment labeling
4. **Glow as active state** — selected/active states use accent box-shadow glow ("lit LED" effect) rather than just color change
5. **Canvas for hot data** — waterfall, spectrum, and S-meter bypass the DOM entirely, rendered imperatively on Canvas 2D for performance
6. **Analog + digital hybrid** — canvas-rendered analog needle S-meter alongside digital controls
7. **Minimal chrome** — thin scrollbars, no decorative borders beyond functional ones. The interface disappears so data is primary

---

## Color System

### Background Scale (shared across all themes)

| Token | Value | Usage |
|-------|-------|-------|
| `--color-sdr-base` | `#07090e` | Page background |
| `--color-sdr-surface` | `#0b1018` | Panels, sidebar, header, footer |
| `--color-sdr-elevated` | `#101520` | Elevated/selected backgrounds |
| `--color-sdr-card` | `#0d1219` | Card backgrounds |
| `--color-sdr-hover` | `#161d28` | Hover state |
| `--color-sdr-active` | `#1a2435` | Active/pressed state |
| `--color-sdr-overlay` | `rgba(8, 13, 20, 0.75)` | Modal overlay |
| `--color-sdr-glass` | `rgba(16, 25, 37, 0.82)` | Glass-morphism panels |

### Theme Accents

| Token | Default (Cyan) | CRT (Phosphor Green) | VFD (Amber) |
|-------|---------------|---------------------|-------------|
| `--sdr-accent` | `#4aa3ff` | `#33ff77` | `#ffaa00` |
| `--sdr-accent-light` | `#6bb3ff` | `#55ff99` | `#ffcc44` |
| `--sdr-accent-dim` | `rgba(74,163,255,0.16)` | `rgba(51,255,119,0.16)` | `rgba(255,170,0,0.16)` |
| `--sdr-freq-color` | `#4aa3ff` | `#33ff77` | `#ffaa00` |
| `--sdr-glow` | `0 0 18px rgba(74,163,255,0.16)` | `0 0 18px rgba(51,255,119,0.2)` | `0 0 18px rgba(255,170,0,0.2)` |

### Text Scale

| Token | Value | Usage |
|-------|-------|-------|
| `--color-text-primary` | `#d7e0ee` | Primary readable text |
| `--color-text-secondary` | `#9fb0c7` | Labels, descriptions |
| `--color-text-dim` | `#6f7f94` | Muted info |
| `--color-text-muted` | `#445266` | Very subtle, barely visible |

### Semantic Colors

| Token | Value | Usage |
|-------|-------|-------|
| Green | `#38c180` | Success, online, stereo indicator |
| Amber | `#d6a85e` | Warning, admin badge |
| Red | `#e25d5d` | Error, overload |
| Neon green | `#00ff88` | S-meter low level |
| Neon yellow | `#ffcc00` | S-meter mid level |
| Neon orange | `#ff8800` | S-meter high level |
| Neon red | `#ff3366` | S-meter overload |

### Borders

| Token | Value |
|-------|-------|
| `--color-border` | `#263246` |
| `--color-border-light` | `#354458` |
| `--color-border-focus` | `#4aa3ff` (accent) |

---

## Typography

### Font Stack

| Token | Value | Usage |
|-------|-------|-------|
| `--font-mono` | `'JetBrains Mono', 'Fira Code', ui-monospace, monospace` | All labels, controls, headers, status |
| `--font-display` | `'DSEG7 Classic', 'Share Tech Mono', 'JetBrains Mono', monospace` | Frequency LCD digits only |
| `--font-sans` | `'Inter', ui-sans-serif, system-ui, sans-serif` | Rarely used (available as fallback) |

### Size Scale

| Size | Context |
|------|---------|
| `36px` | Frequency display digits |
| `13px` | RDS station name overlay |
| `12px` | App title |
| `11px` | RDS label |
| `10px` | Panel content, dropdown items, dongle selectors |
| `9px` | Labels, slider values, panel headers |
| `8px` | Status bar, footer, miniature labels, button text |
| `7px` | Help text, EQ sub-labels |

### Text Patterns

- **Uppercase + tracking** on all panel headers, labels, buttons
- Panel headers: `0.1em` tracking, mode buttons: `0.05em`, mil-btn: `0.12em`
- Weights: 700 (bold) for panel headers and buttons, 600 for secondary emphasis, 400 for body

---

## Component Patterns

### Panels (`.sdr-panel`)

```
┌─── 3px accent bar (left edge) ───────────────────────┐
│ PANEL HEADER              ▼ (chevron, collapsible)    │
├───────────────────────────────────────────────────────┤
│                                                       │
│  Content (padding: 8px 12px)                          │
│                                                       │
└───────────────────────────────────────────────────────┘
```

- Background: `--color-sdr-surface`
- Border: `1px solid --color-border`
- Radius: `6px`
- Left accent bar: `3px wide`, `var(--sdr-accent)`, absolute positioned on header

### Military Buttons (`.mil-btn`)

Embossed tactile buttons mimicking aviation hardware switches:

```
    ╔══════════════╗  ← LED indicator bar (18×4px)
    ║              ║     Lit with accent glow when active
    ║   WFM        ║  ← Dark matte gradient body
    ║              ║     Asymmetric borders (bevel effect)
    ╚══════════════╝  ← Press: translateY(1px) + deeper inset
```

- Body: `linear-gradient(175deg, #1a2030 0%, #0e131c 60%, #090d14 100%)`
- LED (inactive): dark slit at top
- LED (active): accent-colored bar + 12px glow halo
- Press: `translateY(1px)`, deeper inset shadow
- Min-width: `44px`, radius: `4px`

### Range Sliders (`.sdr-range`)

- Track: `4px` height, dark gradient with inset shadow
- Thumb: `10px × 20px` rectangular, dark matte body
- Accent-colored left-edge stripe (12% width)
- Center grip notch (dark line at 44-56% height)
- Vertical variant for EQ: `22px × 12px` thumb, accent top-edge stripe

### S-Meter (Canvas-rendered)

- **Analog mode**: Radial gradient backlit face (themed), red needle, smooth lerp animation
- **Bar mode**: Segmented bars with color gradient (green → amber → orange → red)
- Peak hold marker decays over ~25 seconds
- Face gradient varies by theme (amber warm / green phosphor / white cool)

### Frequency Display

- Font: DSEG7 Classic (seven-segment LCD aesthetic)
- Digit groups are cursor-ns-resize (scroll to tune)
- Glow on hover: `text-shadow: 0 0 8px var(--sdr-accent-dim)`
- Scanline + dot-grid texture overlays for physicality

---

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Header (44px) — fixed                                        │
│ [Logo] [Status] ──────────────── [Theme] [Audio] [Admin]    │
├──────────────┬──────────────────────────────────────────────┤
│ Sidebar      │ Main Area (flex-1)                           │
│ (300px)      │ ┌──────────────────────────────────────────┐ │
│              │ │ Frequency Display (shrink-0)             │ │
│ scrollable   │ ├──────────────────────────────────────────┤ │
│              │ │ Spectrum (180px, min 120px)              │ │
│ Panels:      │ ├──────────────────────────────────────────┤ │
│ • Dongle/    │ │ Waterfall (flex-1, fills remaining)      │ │
│   Profile    │ │                                          │ │
│ • Demod      │ │ Canvas: OffscreenCanvas via Worker       │ │
│ • Audio      │ │                                          │ │
│ • NR/Filters │ ├──────────────────────────────────────────┤ │
│ • Codec      │ │ Seek bar (20px)                          │ │
│ • Admin      │ └──────────────────────────────────────────┘ │
├──────────────┴──────────────────────────────────────────────┤
│ Footer (28px) — fixed                                        │
│ [Mode] [BW] [Vol] [SQL] ───── [Bandwidth sparkline] [CPU]  │
└─────────────────────────────────────────────────────────────┘
```

- Root: `h-screen flex flex-col`
- Content: `flex-1 flex min-h-0` (sidebar + main horizontal)
- Main: `flex-1 flex flex-col min-w-0`
- Sidebar: conditional via `store.sidebarOpen()`
- No responsive breakpoints (desktop-only design)

---

## Visual Effects

### Glows & Shadows

| Purpose | Value |
|---------|-------|
| Panel elevation | `0 4px 8px rgba(0,0,0,0.35)` |
| Modal elevation | `0 8px 24px rgba(0,0,0,0.5)` |
| Accent glow | `0 0 18px var(--sdr-accent-dim)` |
| Status glow (green) | `0 0 12px rgba(56,193,128,0.2)` |

### Textures

- **Scanlines**: `repeating-linear-gradient` every `4px`, opacity `0.06`
- **Dot grid**: Radial gradient dots on `16×16px` grid, opacity `0.03`
- **Vignette**: Radial gradient from transparent center to dark edges (S-meter canvas)

### Animations

| Name | Timing | Usage |
|------|--------|-------|
| `pulse-glow` | 2s ease-in-out infinite | Connection indicator, Enable Audio button |
| Mil-btn press | instant `translateY(1px)` | Button depression feedback |
| Chevron rotation | CSS transition | Panel collapse/expand |

---

## Waterfall Color Palettes

Five palettes for the waterfall/spectrum display (independent of UI theme):

| Name | Color stops |
|------|-------------|
| **Turbo** | Black → Blue → Cyan → Green → Yellow → Red → White |
| **Viridis** | Dark purple → Blue → Teal → Green → Yellow |
| **Classic** | Black → Blue → Green → Yellow → Red |
| **Grayscale** | Black → White |
| **Hot** | Black → Red → Orange → Yellow → White |

Selected via palette picker in sidebar. Stored in `client/src/engine/palettes.ts`.

---

## Implementation

- **Styling**: Tailwind CSS v4 with `@theme` directive in `client/src/styles/app.css`
- **Theme switching**: `data-theme` attribute on root element (`default` | `crt` | `vfd`)
- **No JS config**: All design tokens defined in CSS, no `tailwind.config.js`
- **Hot data bypass**: Waterfall, spectrum, S-meter rendered directly to Canvas 2D — no DOM/reactivity overhead
