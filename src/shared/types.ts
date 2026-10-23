// Core data model shared by the background service worker and the UI pages.

import type { UiLanguagePref } from './i18n.js';

export type HostRuleType = 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD' | 'DOMAIN-REGEX' | 'GEOSITE';
/** Rules that need the server's IP address (known from connections Chrome made). */
export type IpRuleType = 'IP-CIDR' | 'IP-CIDR6' | 'IP-ASN' | 'GEOIP';
export type RuleType = HostRuleType | IpRuleType;
export const RULE_TYPES: readonly RuleType[] = ['DOMAIN-SUFFIX', 'DOMAIN', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'GEOSITE', 'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'GEOIP'];
export const IP_RULE_TYPES: readonly RuleType[] = ['IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'GEOIP'];

export function isIpRuleType(t: RuleType): t is IpRuleType {
  return (IP_RULE_TYPES as readonly string[]).includes(t);
}

/** PROFILE = spoof with the rule's locale profile; SYSTEM = keep the browser's own locale. */
export type RuleAction = 'PROFILE' | 'SYSTEM';

export interface Geolocation {
  latitude: number;
  longitude: number;
  accuracy: number;
}

export interface LocaleProfile {
  /** BCP 47 tag used for Intl (Emulation.setLocaleOverride). */
  locale: string;
  /** navigator.languages; the first entry becomes navigator.language. */
  languages: string[];
  /** HTTP Accept-Language. Always derived from `languages` (Chrome generates it the same way). */
  acceptLanguage: string;
  /** IANA time zone, or null to keep the system time zone. */
  timezone: string | null;
  /** Geolocation override, or null to keep real geolocation behaviour. */
  geolocation: Geolocation | null;
}

export interface Rule {
  id: string;
  type: RuleType;
  /**
   * Normalized value: ASCII hostname (DOMAIN, DOMAIN-SUFFIX), lowercase keyword, regex source,
   * geosite category ("google", "apple@cn"), CIDR ("1.2.3.0/24"), AS number ("13335") or
   * country/special code ("US", "LAN").
   */
  value: string;
  action: RuleAction;
  /** Required when action is PROFILE. */
  profile: LocaleProfile | null;
  enabled: boolean;
  /** Tie-breaker between rules of equal specificity; higher wins. */
  priority: number;
  note: string;
  /** IP rules only: match IP-literal hosts only, never a looked-up server address (Clash no-resolve). */
  noResolve?: boolean;
  /** Set only on rules that come from a subscription (never stored in Settings.rules). */
  origin?: RuleOrigin;
}

export interface RuleOrigin {
  subscription: string;
  /** The subscription's display name. */
  name: string;
  /** 1 for the first subscription, 2 for the next…; your own rules are layer 0 and always win. */
  layer: number;
}

/** A rules file on the internet, fetched and kept up to date by the extension. */
export interface Subscription {
  id: string;
  /** Optional display name; the URL's host is shown when empty. */
  name: string;
  /** As entered (GitHub file pages are converted to the raw file when fetching). */
  url: string;
  enabled: boolean;
  /** Automatic updates. */
  interval: DatasetUpdateInterval;
}

export type DefaultAction = { action: 'SYSTEM' } | { action: 'PROFILE'; profile: LocaleProfile };

export type FrameMode = 'inherit' | 'per-frame';

export type DatasetUpdateInterval = 'off' | 'daily' | 'weekly' | 'monthly';

/** Automatic updates of downloaded data sets (opt-in). */
export interface DatasetUpdateOptions {
  /** Check when the browser starts. */
  onStartup: boolean;
  /** Check regularly. */
  interval: DatasetUpdateInterval;
  /** At most one automatic attempt per data set within this many hours (1–720). */
  minIntervalHours: number;
  /** Only update data sets that the current rules use. */
  onlyNeeded: boolean;
}

/** Checks for a newer Locale Jacket release (opt-in). */
export interface ExtensionUpdateOptions {
  /** Check when the browser starts. */
  onStartup: boolean;
  /** Check regularly. */
  interval: DatasetUpdateInterval;
  /** Where to ask: a GitHub "latest release" API URL. */
  source: string;
}

export interface Options {
  /** inherit: frames use the tab's top-level profile. per-frame: cross-site frames resolve their own rule. */
  frameMode: FrameMode;
  /** Keep a tab's debugger session (with overrides cleared) after it navigates to a SYSTEM site. */
  keepSessionOnSystem: boolean;
  /** Reload a freshly loaded page once if the override could only be applied after it started. */
  reloadOnLate: boolean;
  /** Also set Accept-Language for top-level navigations with declarativeNetRequest. */
  dnrHeaders: boolean;
  /** Apply navigator.language(s) overrides to dedicated workers. */
  overrideWorkers: boolean;
  /** Language of the extension's own interface. */
  uiLanguage: UiLanguagePref;
  /** Automatic data-set updates. */
  datasetUpdates: DatasetUpdateOptions;
  /** Checks for a newer version of the extension. */
  extensionUpdates: ExtensionUpdateOptions;
  /** Download the GeoSite / GeoIP / ASN data that subscription rules need when it is missing. */
  subscriptionDatasets: boolean;
}

export interface Settings {
  schemaVersion: 1;
  enabled: boolean;
  /** Your own rules. */
  rules: Rule[];
  /** Rule subscriptions; their rules apply after yours. */
  subscriptions: Subscription[];
  defaultAction: DefaultAction;
  options: Options;
}

export type ResolutionSource = 'rule' | 'default';

export interface Resolution {
  action: RuleAction;
  profile: LocaleProfile | null;
  source: ResolutionSource;
  rule: Rule | null;
  /** Every enabled rule that matched, best first. */
  matches: Rule[];
  host: string | null;
  /** Server address used for IP rules (formatted), if one was known. */
  ip: string | null;
}
