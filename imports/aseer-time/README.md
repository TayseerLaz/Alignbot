# Aseer Time — bulk-import package

Two CSV files ready to upload through the ALIGNED **Imports** page.

| File | Rows | Entity kind | Categories created |
|---|---|---|---|
| `products.csv` | 97 | `product` | `mixes-drinks`, `premium-mixes`, `sweets`, `fresh-fruit`, `specials`, `soft-drinks`, `coffee` |
| `services.csv` | 10 | `service` | `dining`, `delivery`, `catering`, `franchise` |

## How to import

1. Sign in to the ALIGNED portal as the Aseer Time org (or your demo org).
2. Go to **Imports → New import**.
3. Pick **Products** → upload `products.csv`. Wait for the row count to settle (green).
4. Pick **Services** → upload `services.csv`. Wait for it to finish.
5. Open **Products** and **Services** in the sidebar — every row should be live and pre-categorised. Categories are auto-created from `categorySlug` on first sight.

> Headers match the canonical field names the import worker expects (`sku`, `name`, `priceMinor`, `currency`, `categorySlug`, etc.). No column mapping step is needed.

## Pricing — read before demoing

- All `priceMinor` values are in **fils** (1 KD = 1,000 fils). So `1500` = `1.500 KD`.
- All prices are **placeholders** based on Kuwait juice-bar market norms, derived from the Talabat KD range we saw (0.850 – 9.600 KD).
- **Confirm with the client before going live.** Mass-update via a second CSV import or directly in the UI.

## What's covered

### Products (97 items, organised in 7 categories)
- **Mixes & Drinks** — all signature non-premium milkshakes and juice blends: Heart Attack, Ibn Battotah, Fresh Cocktail, Refresh, Vitamin, Lemon Mint, all branded shakes (Kinder, Lotus, Snickers, Nutella, Kit Kat, Oreo), Cerelac, The Legend, Super Bobo, Lulu, Fashkal, Farrouha, Panda, Salman's Story, Film, Just for Me, Chug Jug…
- **Premium Mixes** — avocado-based and Ferrero signature mixes: VIP, The King, Bridal, Avocado, Nuts Avocado, Happiness Hormon, Grandson, Chalk, Special Cocktail
- **Sweets** — Mini Pancake, Crepes, all Crepe Pillow variants (Legend, Bobo, Lulu, Farrouha), Crepe Fettuccini, Sushi Crepe, Red Waffle, Takmeem (+ Panda variant), Milky Kunafa, Dipping Me, Hanan Mix, Kinder Berry, Dr. Sweet, Chocolate Strawberry, Dubai Chocolate / Ice Cream / Crepe
- **Specials** — sharing + gifting: Hamba, 1L / 1.5L bottles, Mini Prestige 12pc, Twins Milkshake, Twins Fresh, Zwara Box, Happiness Macintosh
- **Fresh Fruit** — Fruit Salad Cup
- **Soft Drinks** — flavoured 7UP, Mojito, all 7 flavoured Redbull variants
- **Coffee** — Cappuccino, Espresso (single + double), Turkish, Karak, Pistachio coffee, all 7 frappes (Cream Caramel, Nutella, Lotus, Oreo, Pistachio, White Mocha, Farouhah)

### Services (10 entries)
- Dine-in (free)
- Takeaway (free)
- Delivery via Talabat / Deliveroo / Carriage (free — platform handles pricing)
- WhatsApp Order Concierge (free)
- Catering & Party Orders (from 25.000 KD)
- Corporate Gifting (from 12.000 KD)
- Birthday & Event Package (from 30.000 KD)
- Franchise Partnership (priced on application — published as "from USD 500,000")

## Items needing the client's input

- **Valentino** — recipe was mentioned in reviews but never published. The row exists with a generic description; ask the client for the exact recipe.
- **Variants (Small / Large)** — the import schema stores one price per row. Sizing options are mentioned in the `description` field. After import, add explicit variants in the Products UI for each item that has Small/Large.
- **Images** — none included. Add via the per-product editor after import.
- **Branch-level availability** — every product is set `isAvailable=true`; if certain SKUs are branch-specific, toggle in the UI.

## Provenance

Sourced from:
- aseertime.com (corporate site + about page + brand page)
- aseertimecanton.com (official Canton, MI franchise — full menu used as the canonical catalog)
- Talabat / Deliveroo / Carriage Kuwait listings (price ranges)
- LinkedIn — corporate descriptors

See the conversation log at `/tmp/aseer-time-research.md` if you need to re-trace any item.
