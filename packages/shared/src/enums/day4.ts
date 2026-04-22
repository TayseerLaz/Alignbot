export const RevisionEntityType = {
  product: 'product',
  service: 'service',
  business_info: 'business_info',
  faq: 'faq',
  policy: 'policy',
} as const;
export type RevisionEntityType = (typeof RevisionEntityType)[keyof typeof RevisionEntityType];

export const RevisionAction = {
  created: 'created',
  updated: 'updated',
  deleted: 'deleted',
  restored: 'restored',
} as const;
export type RevisionAction = (typeof RevisionAction)[keyof typeof RevisionAction];

export const NotificationKind = {
  import_succeeded: 'import_succeeded',
  import_partial: 'import_partial',
  import_failed: 'import_failed',
  sync_succeeded: 'sync_succeeded',
  sync_failed: 'sync_failed',
  webhook_disabled: 'webhook_disabled',
  api_key_first_use: 'api_key_first_use',
  generic: 'generic',
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

export const NotificationSeverity = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
} as const;
export type NotificationSeverity = (typeof NotificationSeverity)[keyof typeof NotificationSeverity];
