// Compile domain rules into declarativeNetRequest rules for top-level navigations.
//
// Why: the very first document request of a tab often cannot be gated through
// chrome.debugger (e.g. leaving the New Tab Page, where attaching is refused
// until the navigation commits). DNR rules run inside the network stack for
// every main-frame request, so the Accept-Language header of the document is
// correct even before a debugger session exists.
//
// The engine's precedence is reproduced exactly: every rule gets a DNR
// priority from its position in the global precedence order. In DNR the
// highest-priority matching rule decides; an `allow` rule (used for SYSTEM)
// cancels all lower-priority modifyHeaders rules.

import { isAsciiKeyword, rulesInPrecedenceOrder } from './rules.js';
import type { Rule, Settings } from './types.js';

export const DNR_MAX_UNSAFE_RULES = 5000;
export const DNR_MAX_REGEX_RULES = 1000;

export interface DnrRule {
  id: number;
  priority: number;
  action:
    | { type: 'allow' }
    | { type: 'modifyHeaders'; requestHeaders: { header: string; operation: 'set'; value: string }[] };
  condition: {
    resourceTypes: ['main_frame'];
    requestDomains?: string[];
    regexFilter?: string;
  };
}

export interface DnrCompileResult {
  rules: DnrRule[];
  skipped: { rule: Rule; reason: string }[];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Scheme, optional userinfo, then the host. URLs reach DNR in canonical form,
// so the host is lowercase ASCII and the path starts with "/".
const PREFIX = '^https?://(?:[^/?#@]*@)?';

export function compileDnrRules(settings: Pick<Settings, 'rules' | 'defaultAction'>): DnrCompileResult {
  const ordered = rulesInPrecedenceOrder(settings.rules).filter((r) => r.action === 'SYSTEM' || r.profile);
  const skipped: DnrCompileResult['skipped'] = [];
  const out: DnrRule[] = [];
  let regexCount = 0;
  const top = ordered.length + 1;

  ordered.forEach((rule, rank) => {
    const priority = top - rank + 1; // > 1, so the catch-all default (priority 1) always loses.
    let condition: DnrRule['condition'];
    if (rule.type === 'DOMAIN-SUFFIX') {
      condition = { resourceTypes: ['main_frame'], requestDomains: [rule.value] };
    } else if (rule.type === 'DOMAIN') {
      condition = { resourceTypes: ['main_frame'], regexFilter: `${PREFIX}${escapeRegex(rule.value)}\\.?(?::[0-9]+)?/` };
    } else {
      if (!isAsciiKeyword(rule.value)) {
        skipped.push({ rule, reason: 'Non-ASCII keywords cannot be expressed in DNR (URLs use punycode).' });
        return;
      }
      condition = { resourceTypes: ['main_frame'], regexFilter: `${PREFIX}[^/?#@:]*${escapeRegex(rule.value)}[^/?#@]*/` };
    }
    if (condition.regexFilter) {
      if (regexCount >= DNR_MAX_REGEX_RULES) {
        skipped.push({ rule, reason: `More than ${DNR_MAX_REGEX_RULES} DOMAIN/KEYWORD rules; DNR regex limit reached.` });
        return;
      }
      regexCount++;
    }
    if (out.length >= DNR_MAX_UNSAFE_RULES - 1) {
      skipped.push({ rule, reason: `DNR rule limit (${DNR_MAX_UNSAFE_RULES}) reached.` });
      return;
    }
    out.push({
      id: out.length + 1,
      priority,
      action:
        rule.action === 'SYSTEM'
          ? { type: 'allow' }
          : { type: 'modifyHeaders', requestHeaders: [{ header: 'accept-language', operation: 'set', value: rule.profile!.acceptLanguage }] },
      condition,
    });
  });

  if (settings.defaultAction.action === 'PROFILE') {
    out.push({
      id: out.length + 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'accept-language', operation: 'set', value: settings.defaultAction.profile.acceptLanguage }],
      },
      condition: { resourceTypes: ['main_frame'] },
    });
  }
  return { rules: out, skipped };
}
