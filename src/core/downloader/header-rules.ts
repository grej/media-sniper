/**
 * Declarative Net Request header injection for HLS segment downloads.
 *
 * Browsers silently strip `Origin` and `Referer` from `fetch()` calls (they
 * are "forbidden headers"). To ensure CDNs that require these headers still
 * receive them, we add dynamic DNR rules that inject the headers at the
 * network layer for requests matching a specific URL prefix.
 */

import { logger } from "../utils/logger";

/**
 * Derive two deterministic rule IDs from a download ID string.
 * We hash the string into a 31-bit positive integer range and use two
 * consecutive IDs (one for Origin, one for Referer).
 */
function ruleIdsFromDownloadId(downloadId: string): [number, number] {
  let hash = 0;
  for (let i = 0; i < downloadId.length; i++) {
    hash = (hash * 31 + downloadId.charCodeAt(i)) | 0;
  }
  // Keep in positive 30-bit range so both IDs stay positive 31-bit ints
  const base = (hash & 0x3fffffff) + 1;
  return [base, base + 1];
}

/**
 * Build a `urlFilter` that matches all segment requests under the same
 * directory as `cdnUrl`. For example, given
 *   https://cdn.example.com/hls/videos/.../720P_4000K.mp4/seg-1-v1-a1.ts
 * the filter becomes
 *   ||cdn.example.com/hls/videos/.../720P_4000K.mp4/
 * which matches every segment under that path.
 */
function buildUrlFilter(cdnUrl: string): string {
  const url = new URL(cdnUrl);
  const lastSlash = url.pathname.lastIndexOf("/");
  const pathPrefix = lastSlash > 0 ? url.pathname.substring(0, lastSlash + 1) : url.pathname;
  return `||${url.hostname}${pathPrefix}`;
}

export interface OperationHeaderRuleScope {
  operationId: string;
  /** Representative URLs; each distinct directory becomes a narrow rule. */
  urls: readonly string[];
  pageUrl: string;
}

function operationRuleId(operationId: string, urlFilter: string): number {
  const [id] = ruleIdsFromDownloadId(`${operationId}\0${urlFilter}`);
  return id;
}

/** Pure builder used by clip handlers and tests. */
export function buildOperationHeaderRules(
  scope: OperationHeaderRuleScope,
): chrome.declarativeNetRequest.Rule[] {
  const origin = new URL(scope.pageUrl).origin;
  const filters = [...new Set(scope.urls.map(buildUrlFilter))];
  const usedIds = new Set<number>();

  return filters.map((urlFilter) => {
    let id = operationRuleId(scope.operationId, urlFilter);
    while (usedIds.has(id)) id += 1;
    usedIds.add(id);

    return {
      id,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          {
            header: "Origin",
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: origin,
          },
          {
            header: "Referer",
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: origin + "/",
          },
        ],
      },
      condition: {
        urlFilter,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
        ],
      },
    };
  });
}

/**
 * Add all path-scoped header rules required by one operation. Returned IDs are
 * owned by the caller and are safe to pass to removeHeaderRules() in finally.
 */
export async function addOperationHeaderRules(
  scope: OperationHeaderRuleScope,
): Promise<number[]> {
  const rules = buildOperationHeaderRules(scope);
  const ruleIds = rules.map((rule) => rule.id);
  if (rules.length === 0) return ruleIds;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIds,
    addRules: rules,
  });
  logger.info(
    `[DNR] Added ${rules.length} scoped header rule(s) for operation ${scope.operationId}`,
  );
  return ruleIds;
}

/**
 * Add Origin + Referer header-injection rules scoped to a specific CDN path.
 *
 * @param downloadId  Unique download identifier (used to derive rule IDs)
 * @param cdnUrl      A representative segment/playlist URL on the CDN
 * @param pageUrl     The page URL whose origin should be used for the headers
 * @returns The two rule IDs that were added (pass to `removeHeaderRules`)
 */
export async function addHeaderRules(
  downloadId: string,
  cdnUrl: string,
  pageUrl: string,
): Promise<number[]> {
  const [originRuleId, refererRuleId] = ruleIdsFromDownloadId(downloadId);
  const origin = new URL(pageUrl).origin;
  const urlFilter = buildUrlFilter(cdnUrl);

  const rules: chrome.declarativeNetRequest.Rule[] = [
    {
      id: originRuleId,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          {
            header: "Origin",
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: origin,
          },
        ],
      },
      condition: {
        urlFilter,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
        ],
      },
    },
    {
      id: refererRuleId,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
        requestHeaders: [
          {
            header: "Referer",
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: origin + "/",
          },
        ],
      },
      condition: {
        urlFilter,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
        ],
      },
    },
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [originRuleId, refererRuleId],
    addRules: rules,
  });

  logger.info(
    `[DNR] Added header rules ${originRuleId},${refererRuleId} for ${urlFilter}`,
  );

  return [originRuleId, refererRuleId];
}

/**
 * Remove previously added header-injection rules.
 */
export async function removeHeaderRules(ruleIds: number[]): Promise<void> {
  if (ruleIds.length === 0) return;

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ruleIds,
  });

  logger.info(`[DNR] Removed header rules ${ruleIds.join(",")}`);
}
