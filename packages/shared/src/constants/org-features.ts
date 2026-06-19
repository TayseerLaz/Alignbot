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
    key: 'bookings',
    label: 'Bookings & orders',
    description: 'Appointment bookings and the orders/cart page.',
    hrefs: ['/bookings', '/cart'],
  },
  {
    key: 'analytics',
    label: 'Analytics',
    description: 'The analytics dashboard.',
    hrefs: ['/analytics'],
  },
] as const;

export type OrgFeatureKey = (typeof ORG_FEATURES)[number]['key'];

export const ORG_FEATURE_KEYS = ORG_FEATURES.map((f) => f.key) as OrgFeatureKey[];

/** True if `href` belongs to a feature that's in the disabled list. */
export function isHrefDisabled(href: string, disabled: string[]): boolean {
  if (disabled.length === 0) return false;
  return ORG_FEATURES.some(
    (f) =>
      disabled.includes(f.key) &&
      f.hrefs.some((h) => href === h || href.startsWith(`${h}/`)),
  );
}
