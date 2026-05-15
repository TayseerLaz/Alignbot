# ALIGNED — Design System Handoff

> Soft lavender + coral system for the ALIGNED Business Platform.
> Drop into your existing React app to redesign every page without rebuilding components.

---

## What's in this package

```
aligned-design-system/
├── README.md                  ← you are here
├── INTEGRATION.md             ← step-by-step port guide
├── COMPONENTS.md              ← class & token reference
├── tokens.css                 ← all design tokens (drop-in)
├── tailwind.config.snippet.js ← if you use Tailwind
└── theme.ts                   ← if you use Styled-components / Emotion / MUI
```

The visual reference (Brand sheet, components, all 11 redesigned pages) is in **`Aligned Panel Redesign.html`** — open it to see what you're aiming for.

---

## Quick start (5 min)

### 1. Drop in `tokens.css`

```bash
# Copy tokens.css to your styles folder
cp tokens.css src/styles/
```

In your root entry (`main.tsx`, `App.tsx`, or `index.css`):

```ts
import './styles/tokens.css';
```

### 2. Load the font

```html
<!-- index.html <head> -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
  rel="stylesheet"
/>
```

### 3. Set the body

```css
body {
  font-family: var(--al-font);
  color: var(--al-text);
  background: var(--al-bg);
}
```

### 4. Start swapping classes

| Before (your slate-navy app) | After (Aligned system) |
|---|---|
| `<button className="primary-btn">` | `<button className="al-btn al-btn-primary">` |
| `<div className="card">` | `<div className="al-card al-card-lg">` |
| `<span className="status-pill green">` | `<span className="al-badge green">` |
| `<input className="form-input">` | `<input className="al-input">` |
| sidebar link active | `<a className="al-nav-item active">` |

See **COMPONENTS.md** for the full mapping.

---

## What gets redesigned automatically

Once `tokens.css` is loaded:
- ✅ Every primary button → lavender pill with soft shadow
- ✅ Every input → 14px radius, lavender focus ring
- ✅ Every card → 28px radius, soft purple-tinted shadow
- ✅ Every status badge → semantic color (green/yellow/coral/red)
- ✅ Sidebar active state → lavender pill
- ✅ Topbar — minor visual tweaks, structure stays

## What needs manual swap

These look the same shape but want a one-line class change to feel right:
- Empty-state pages (add the illustrated bubble pattern — see **Integrations** artboards)
- Modal dialogs (use the `al-card-lg` + overlay pattern in `New product modal` artboard)
- Tab navs (replace your tabs with the **pill-rail** in Business info)

---

## Need more?

If you import your React repo (Import → from GitHub or codebase), I can convert specific components — sidebar, button, modal — into actual JSX with these tokens applied. Just say the word.
