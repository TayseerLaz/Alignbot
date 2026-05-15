# COMPONENTS — Class & token reference

Every class and CSS variable in `tokens.css`, with usage and "before → after" examples.

---

## Tokens (CSS variables)

### Colors

| Token | Hex | Use |
|---|---|---|
| `--al-bg` | `#F4F2F8` | Page background |
| `--al-bg-2` | `#ECE9F4` | Hover / subtle wash |
| `--al-surface` | `#FFFFFF` | Card / sidebar bg |
| `--al-surface-2` | `#FAF9FD` | Table header / inset |
| `--al-primary` | `#7C6BFF` | Primary button, active nav, links |
| `--al-primary-600` | `#6856E8` | Primary hover |
| `--al-primary-700` | `#5546D9` | Primary deep / pressed |
| `--al-primary-100` | `#EEEAFF` | Soft btn bg, badge bg |
| `--al-primary-200` | `#DCD4FF` | Border / gradient stop |
| `--al-coral` | `#FF8A6B` | Accent button, escalation badge |
| `--al-coral-100` | `#FFE5DC` | Coral badge bg, gradient |
| `--al-yellow` | `#FFD66B` | Decoration |
| `--al-yellow-100` | `#FFF3D1` | Draft / partial bg |
| `--al-green` | `#5BC97A` | Success, online, available |
| `--al-green-100` | `#D8F2DE` | Success badge bg |
| `--al-red` | `#FF6B7C` | Error, delete |
| `--al-red-100` | `#FFE0E4` | Error badge bg |
| `--al-text` | `#1A1828` | Body text |
| `--al-text-2` | `#3D3950` | Form labels, secondary |
| `--al-muted` | `#6B6880` | Captions, helper text |
| `--al-mute-2` | `#9C99B0` | Placeholder, disabled |
| `--al-border` | `#ECE9F4` | Card / table borders |
| `--al-border-2` | `#DDD8EA` | Input border, dividers |

### Radii

| Token | Value | Use |
|---|---|---|
| `--al-r-xs` | 8px | Tiny inset corners |
| `--al-r-sm` | 14px | Inputs, textareas |
| `--al-r-md` | 20px | Small cards |
| `--al-r-lg` | 28px | Cards (default) |
| `--al-r-xl` | 36px | Hero / showcase cards |
| `--al-r-pill` | 999px | Buttons, badges, nav items |

### Shadows

| Token | Use |
|---|---|
| `--al-shadow-sm` | Subtle separation |
| `--al-shadow` | Default card shadow |
| `--al-shadow-lg` | Modals, popovers |
| `--al-shadow-primary` | Lavender buttons + active nav |
| `--al-shadow-coral` | Coral buttons |

### Type

| Token | Use |
|---|---|
| `--al-font` | `Plus Jakarta Sans` + fallbacks |
| `--al-font-mono` | `JetBrains Mono` (SKUs, IDs, code) |

---

## Classes

### Layout

| Class | Description |
|---|---|
| `.al` | Root wrapper — scopes tokens & sets font/bg/color |
| `.al-shell` | Grid layout (sidebar + main) |
| `.al-sidebar` | Sidebar container |
| `.al-sidebar-section` | Uppercase section header |
| `.al-main` | Main content area |
| `.al-topbar` | Topbar row |
| `.al-crumb` | Breadcrumb text |

### Buttons

```html
<button class="al-btn al-btn-primary">Sync catalog</button>
<button class="al-btn al-btn-coral">Send broadcast</button>
<button class="al-btn al-btn-dark">Explore now</button>
<button class="al-btn al-btn-ghost">Cancel</button>
<button class="al-btn al-btn-soft">+ New product</button>

<!-- sizes -->
<button class="al-btn al-btn-primary al-btn-sm">Save</button>
<button class="al-btn al-btn-primary al-btn-lg">Save changes</button>

<!-- icon-only round -->
<button class="al-btn al-btn-ghost al-btn-icon">⋯</button>
```

### Inputs

```html
<div class="al-field">
  <label class="al-label">Email</label>
  <input class="al-input" placeholder="you@company.com" />
</div>

<!-- with search icon -->
<div class="al-search">
  <svg>…</svg>
  <input class="al-input" placeholder="Search…" />
</div>

<!-- textarea -->
<textarea class="al-textarea" rows="3"></textarea>
```

### Cards

```html
<div class="al-card">…</div>          <!-- 28px radius, 24px padding -->
<div class="al-card al-card-lg">…</div> <!-- 36px radius, 28px padding -->
<div class="al-card-flat">…</div>     <!-- 1px border, no shadow -->
```

### Badges & chips

```html
<span class="al-badge"><span class="dot"></span> Live</span>
<span class="al-badge coral"><span class="dot"></span> Needs reply</span>
<span class="al-badge green">✓ Available</span>
<span class="al-badge yellow"><span class="dot"></span> Draft</span>
<span class="al-badge red"><span class="dot"></span> Failed</span>
<span class="al-badge blue"><span class="dot"></span> Syncing</span>
<span class="al-badge gray">archived</span>
```

### Avatars

```html
<span class="al-avatar">JD</span>              <!-- 36px lavender -->
<span class="al-avatar coral">SA</span>        <!-- coral -->
<span class="al-avatar yellow">KB</span>       <!-- yellow -->
<span class="al-avatar green">LP</span>        <!-- green -->
<span class="al-avatar sm">MR</span>           <!-- 28px -->
<span class="al-avatar lg">AL</span>           <!-- 56px -->

<!-- stack -->
<div class="al-avatar-stack">
  <span class="al-avatar sm">MR</span>
  <span class="al-avatar sm coral">SA</span>
  <span class="al-avatar sm yellow">KB</span>
</div>
```

### Nav items (sidebar)

```html
<div class="al-nav-item active">
  <span class="ico"><HomeIcon /></span>
  Dashboard
  <span class="count">12</span>
</div>
```

### Table

```html
<table class="al-table">
  <thead>
    <tr><th>Product</th><th>SKU</th><th>Price</th><th>Status</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Stoneware Mug</td>
      <td>STN-MG-318</td>
      <td>$32.00</td>
      <td><span class="al-badge green">✓ Live</span></td>
    </tr>
  </tbody>
</table>
```

### Toggle

```html
<span class="al-toggle on"></span>   <!-- on state -->
<span class="al-toggle"></span>      <!-- off state -->
```

---

## Pattern → Page

| Pattern | Find it on artboard |
|---|---|
| App shell + sidebar | Dashboard |
| Topbar + workspace chip | Dashboard |
| Stat tiles (4-up gradient) | Dashboard |
| Gradient hero card | Dashboard (AI budget) |
| Activity feed | Dashboard (right column) |
| Search + filter row | Products, Services |
| Data table (full) | Products, Services, Categories |
| Tab pill-rail | Business info |
| Form fields (2-col) | Business info |
| Day-row picker | Business info (operating hours) |
| Notice banner (yellow) | WhatsApp |
| Side-panel status list | WhatsApp |
| File / template cards | Imports |
| Recent activity rows | Imports |
| Approved template card | Templates |
| Empty state illustration | API connectors / keys / Webhooks |
| Modal overlay | Modal popup artboard |

Every pattern is intentionally simple — you can copy the JSX from `screen-artboards.jsx` straight into your codebase.
