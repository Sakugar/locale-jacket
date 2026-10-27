// Human-readable presentation of a tab's status, shared by popup and options.

import { t } from '../shared/i18n.js';
import type { GlobalStatus, TabStatus } from '../shared/messages.js';

export type ChipKind = 'ok' | 'warn' | 'bad' | 'off' | 'accent';

export interface StatusView {
  label: string;
  kind: ChipKind;
  detail: string;
}

export function describeStatus(s: TabStatus | null, g: GlobalStatus | null): StatusView {
  if (g && !g.enabled) return { label: t('status.off'), kind: 'off', detail: t('status.offDetail') };
  if (g?.suspended) return { label: t('status.paused'), kind: 'warn', detail: t('status.pausedDetail') };
  if (!s) return { label: t('status.unknown'), kind: 'off', detail: t('status.unknownDetail') };
  const target = s.resolution.profile;
  if (!target) {
    // Nothing is spoofed here, but the page can still be wrong (its Intl locale taken from
    // another tab in the same renderer process): conflicts are shown, never hidden.
    if (s.warnings.length) return { label: t('status.partial'), kind: 'warn', detail: s.warnings[0]! };
    return { label: t('status.system'), kind: 'off', detail: t(s.session === 'attached' ? 'status.systemAttachedDetail' : 'status.systemDetail') };
  }
  if (s.session === 'restricted') return { label: t('status.notAllowed'), kind: 'off', detail: t('status.notAllowedDetail') };
  if (s.session === 'failed') return { label: t('status.error'), kind: 'bad', detail: s.error ?? t('status.errorDetail') };
  if (s.session !== 'attached') return { label: t('status.notActive'), kind: 'warn', detail: s.error ?? t('status.notActiveDetail') };
  if (s.warnings.length) return { label: t('status.partial'), kind: 'warn', detail: s.warnings[0]! };
  if (s.late) return { label: t('status.reloadNeeded'), kind: 'warn', detail: s.lateReason ?? t('status.reloadNeededDetail') };
  return {
    label: t('status.active', { locale: target.locale }),
    kind: 'ok',
    detail: t(s.autoReloaded ? 'status.activeReloadedDetail' : 'status.activeDetail'),
  };
}
