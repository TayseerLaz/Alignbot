# INTEGRATION — Step by step

This walks through porting an existing React + CSS app to the Aligned system.
Three paths covered: plain CSS / CSS Modules, Tailwind, Styled-components.

---

## A. Plain CSS / CSS Modules (simplest)

### Step 1 — Install tokens

```bash
cp tokens.css src/styles/tokens.css
```

In `src/main.tsx` (or `src/index.tsx`):

```ts
import './styles/tokens.css';
```

### Step 2 — Update your base layout

Wherever your app shell lives (likely `Layout.tsx` or `AppShell.tsx`):

```tsx
// Before
<div className="layout">
  <aside className="sidebar"> … </aside>
  <main className="main"> … </main>
</div>

// After — wrap in .al so tokens cascade cleanly
<div className="al">
  <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--al-bg)' }}>
    <aside style={{
      width: 256,
      background: 'var(--al-surface)',
      padding: '24px 14px',
      borderRight: '1px solid var(--al-border)',
    }}> … </aside>
    <main style={{ flex: 1 }}> … </main>
  </div>
</div>
```

### Step 3 — Update sidebar nav items

```tsx
<NavLink
  to="/products"
  className={({ isActive }) =>
    'al-nav-item' + (isActive ? ' active' : '')
  }
>
  <span className="ico"><PackageIcon /></span>
  Products
</NavLink>
```

### Step 4 — Update your button component

```tsx
// Button.tsx
export function Button({ variant = 'primary', size, children, ...rest }) {
  return (
    <button
      className={[
        'al-btn',
        variant === 'primary' && 'al-btn-primary',
        variant === 'coral' && 'al-btn-coral',
        variant === 'dark' && 'al-btn-dark',
        variant === 'ghost' && 'al-btn-ghost',
        variant === 'soft' && 'al-btn-soft',
        size === 'sm' && 'al-btn-sm',
        size === 'lg' && 'al-btn-lg',
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}
```

### Step 5 — Update your form inputs

```tsx
<div className="al-field">
  <label className="al-label">Email</label>
  <input className="al-input" placeholder="you@company.com" />
</div>
```

### Step 6 — Replace status pills

Find every place you render a status (Available / Live / Failed / Draft):

```tsx
// status helper
function StatusBadge({ status }) {
  const map = {
    available: { cls: 'green', icon: '✓' },
    live: { cls: 'green', icon: '●' },
    syncing: { cls: 'blue', icon: '●' },
    draft: { cls: 'yellow', icon: '●' },
    partial: { cls: 'yellow', icon: '⚠' },
    failed: { cls: 'red', icon: '●' },
    succeeded: { cls: 'green', icon: '✓' },
    unavailable: { cls: 'gray', icon: '' },
  };
  const m = map[status.toLowerCase()] || { cls: 'gray', icon: '' };
  return (
    <span className={`al-badge ${m.cls}`}>
      {m.icon && <span className="dot" />} {status}
    </span>
  );
}
```

---

## B. Tailwind

### Step 1 — Merge config

In your `tailwind.config.js`, spread in the snippet from `tailwind.config.snippet.js`:

```js
const aligned = require('./tailwind.config.snippet.js');

module.exports = {
  // your existing config…
  theme: {
    extend: {
      ...aligned.theme.extend,
    },
  },
};
```

### Step 2 — Still import tokens.css

Tailwind tokens are duplicated as CSS vars so non-Tailwind components (third-party) inherit the system too:

```ts
import './styles/tokens.css';
```

### Step 3 — Class examples

```tsx
// Primary button
<button className="rounded-full bg-al-primary text-white font-semibold px-5 py-2.5 shadow-al-primary hover:bg-al-primary-600 transition">
  Sync catalog
</button>

// Card
<div className="bg-white rounded-[28px] p-6 shadow-al">
  …
</div>

// Active nav item
<a className="flex items-center gap-3 px-4 py-2.5 rounded-full bg-al-primary text-white shadow-al-primary">
  <Icon /> Products
</a>
```

---

## C. Styled-components / Emotion

### Step 1 — Import theme

```ts
import { ThemeProvider } from 'styled-components';
import { alignedTheme } from './theme';

<ThemeProvider theme={alignedTheme}>
  <App />
</ThemeProvider>
```

### Step 2 — Use it

```ts
const Button = styled.button`
  background: ${({ theme }) => theme.colors.primary};
  color: #fff;
  font-weight: 600;
  padding: 11px 22px;
  border-radius: ${({ theme }) => theme.radii.pill};
  box-shadow: ${({ theme }) => theme.shadows.primary};
  border: none;
  font-family: inherit;
  cursor: pointer;
  &:hover { background: ${({ theme }) => theme.colors.primary600}; }
`;
```

You can ALSO still load `tokens.css` so global elements (third-party form inputs, etc.) inherit.

---

## Component-by-component port checklist

Pick a page, find each pattern, swap it in:

- [ ] **App shell** — sidebar bg → `--al-surface`, border-right `--al-border`, body bg → `--al-bg`
- [ ] **Sidebar logo** — gradient lavender square with white 3-bar mark (see Dashboard artboard top-left)
- [ ] **Sidebar section headers** — uppercase 10px 700 with `letter-spacing: 0.15em`, color `--al-mute-2`
- [ ] **Nav items** — `.al-nav-item` + `.active` on the matched route
- [ ] **Topbar workspace switcher** — pill with lavender icon + name + role + chevron
- [ ] **Page header** — `H1 32/700 -0.025em`, subtitle 14px muted, actions right-aligned
- [ ] **Primary actions** — `.al-btn.al-btn-primary` (lavender)
- [ ] **Secondary actions** — `.al-btn.al-btn-ghost` (outlined) or `.al-btn.al-btn-soft` (lavender 100 bg)
- [ ] **Tables** — wrap in `.al-card.al-card-lg` with `padding: 0`, use `.al-table`
- [ ] **Status pills** — `.al-badge.green/.coral/.yellow/.red/.blue/.gray`
- [ ] **Forms** — `.al-field` + `.al-label` + `.al-input`
- [ ] **Tabs** — pill rail (see Business info artboard)
- [ ] **Modals** — `.al-card` with 28px radius + dark blur backdrop
- [ ] **Empty states** — illustrated bubble + heading + paragraph + primary CTA

---

## Spot-checks — does it look right?

After porting a page, compare against the artboard. Things to verify:

1. **Buttons are pills**, not rounded rects (16/20px is too sharp — must be 999px / pill)
2. **Cards have 28px radius**, not 8/12
3. **Active sidebar item is a lavender pill** with soft purple shadow
4. **Status text reads in color, on tinted bg** — not just colored text on white
5. **Headlines use -0.025em letter-spacing** — looks tighter and more confident
6. **No drop shadows on flat surfaces** — only on cards and elevated buttons

---

## Questions?

When you've imported your repo I can do the conversion for you — point me at any 1-2 components and I'll rewrite them with these tokens applied, then you can copy that pattern across.
