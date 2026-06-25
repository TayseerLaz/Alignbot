// ALIGNED-admin per-tenant access control.
//
// Each feature maps to a set of portal routes (hidden + route-guarded when
// disabled). The 'ai' feature additionally turns off the bot's auto-reply, so
// a tenant becomes a pure social-media handler answered manually from the inbox.
// Disabling a feature is stored in Organization.disabledFeatures (a list of the
// keys below). Empty list = full access.
export const ORG_FEATURES = [
  {
    key: 'ai',
    label: 'AI auto-reply + bot builder',
    description:
      'The AI answers customers automatically. Turn OFF to make this tenant a social-media handler with MANUAL replies only (the inbox still works; the bot stays silent). Also hides the AI bot builder page.',
    hrefs: ['/bot'],
  },
  {
    key: 'catalog',
    label: 'Catalog (products, services, business info, imports)',
    description: 'Products, services, categories, business info, and CSV imports.',
    hrefs: ['/products', '/services', '/categories', '/business-info', '/imports'],
  },
  {
    key: 'broadcasts',
    label: 'Broadcasts & templates',
    description: 'WhatsApp broadcast campaigns + message templates.',
    hrefs: ['/broadcasts'],
  },
  {
    key: 'contacts',
    label: 'Contacts',
    description: 'The contact list (CRM).',
    hrefs: ['/contacts'],
  },
  {
    key: 'orders',
    label: 'Orders / cart',
    description: 'The orders (cart) page where WhatsApp/Messenger orders land.',
    hrefs: ['/cart'],
  },
  {
    key: 'bookings',
    label: 'Bookings',
    description: 'The appointment bookings page.',
    hrefs: ['/bookings'],
  },
  {
    key: 'messenger',
    label: 'Facebook Messenger',
    description:
      'Let the bot answer Facebook Messenger DMs. Turn OFF to silence Messenger (DMs still land in the inbox; the bot stays silent and operators can’t reply on it). Does not affect WhatsApp or Instagram.',
    // No page to hide — Messenger + Instagram share the /settings/messenger
    // config page, so gating is enforced at the channel level (bot reply +
    // operator send + inbox filter), not by hiding a route.
    hrefs: [],
  },
  {
    key: 'instagram',
    label: 'Instagram Direct',
    description:
      'Let the bot answer Instagram DMs. Turn OFF to silence Instagram only (Messenger stays active if enabled separately).',
    hrefs: [],
  },
  {
    key: 'phone',
    label: 'Phone / voice integration',
    description:
      'The AI voicebot answers phone calls (Aseer-time phone bridge). Turn OFF to disable the phone bot and hide the Phone integration + Voice calls pages — the voicebot stops receiving this tenant’s persona/config.',
    hrefs: ['/phone-integrations', '/voice-calls'],
  },
  {
    key: 'exports',
    label: 'Data export',
    description:
      'Self-service GDPR data export (the /settings/data-export page). Turn OFF to remove it for the tenant — ALIGNED admins can still export this org’s data from the admin panel at any time.',
    hrefs: ['/settings/data-export'],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    description: 'The analytics dashboard.',
    hrefs: ['/analytics'],
  },
  {
    key: 'inbox',
    label: 'Inbox & canned replies',
    description:
      'The conversation inbox + canned replies. Disable for accounts that should not handle conversations at all (e.g. an admin-only HQ).',
    hrefs: ['/inbox', '/inbox-full'],
  },
  {
    key: 'shopify',
    label: 'Shopify sync',
    description:
      'Connect a Shopify store to scrape products, customers, business info and policies into the platform (with a review + approve step) and keep them in sync. Opt-in: OFF by default for every tenant — enable it only for stores on a Shopify plan.',
    hrefs: ['/settings/shopify'],
    // Opt-in feature: new orgs start with this DISABLED. See ORG_FEATURE_DEFAULT_DISABLED.
    defaultDisabled: true,
  },
] as const;

export type OrgFeatureKey = (typeof ORG_FEATURES)[number]['key'];

export const ORG_FEATURE_KEYS = ORG_FEATURES.map((f) => f.key) as OrgFeatureKey[];

/**
 * Opt-in features: keys that should be DISABLED by default for every org (new
 * tenants start with these in `disabledFeatures`; existing orgs are backfilled
 * by the feature's migration). An ALIGNED admin enables them per tenant.
 */
export const ORG_FEATURE_DEFAULT_DISABLED = ORG_FEATURES.filter(
  (f) => 'defaultDisabled' in f && f.defaultDisabled,
).map((f) => f.key) as OrgFeatureKey[];

/** True if `href` belongs to a feature that's in the disabled list. */
export function isHrefDisabled(href: string, disabled: string[]): boolean {
  if (disabled.length === 0) return false;
  return ORG_FEATURES.some(
    (f) =>
      disabled.includes(f.key) &&
      f.hrefs.some((h) => href === h || href.startsWith(`${h}/`)),
  );
}
