// What Options says about a data set the service worker downloaded for a subscription.
// The record (SubscriptionDatasetState) outlives the file on purpose: while it stays, a
// data set you deleted is not downloaded again (see datasetDownloadDue). So the text is
// derived from the record together with what is installed now, not from the record alone.

import type { DatasetMeta } from './dataset-store.js';
import type { SubscriptionDatasetRecord } from './subscriptions.js';

export type SubscriptionDatasetStatus =
  /** Installed, and still the file downloaded for the subscription (or an update of it from the same address). */
  | 'downloaded'
  /** The download failed and nothing is installed. */
  | 'failed'
  /** It was downloaded, but is no longer installed: you deleted it, so it is not downloaded again. */
  | 'deleted'
  /** Something else is installed now (another address, an imported file, or one saved after a failed attempt): nothing to say. */
  | 'replaced';

export function subscriptionDatasetStatus(rec: SubscriptionDatasetRecord, installed: DatasetMeta | undefined): SubscriptionDatasetStatus {
  if (!installed) return rec.ok ? 'deleted' : 'failed';
  return rec.ok && installed.source === rec.url ? 'downloaded' : 'replaced';
}
