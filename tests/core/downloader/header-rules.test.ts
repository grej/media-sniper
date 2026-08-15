import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addOperationHeaderRules,
  buildOperationHeaderRules,
  removeHeaderRules,
} from "@/core/downloader/header-rules";

describe("operation DNR header rules", () => {
  const updateDynamicRules = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    updateDynamicRules.mockClear();
    vi.stubGlobal("chrome", {
      runtime: { id: "extension-id" },
      declarativeNetRequest: {
        RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
        HeaderOperation: { SET: "set" },
        ResourceType: { XMLHTTPREQUEST: "xmlhttprequest" },
        updateDynamicRules,
      },
    });
  });

  it("deduplicates directories and scopes rules to extension requests", () => {
    const rules = buildOperationHeaderRules({
      operationId: "clip_1",
      urls: [
        "https://cdn.test/a/seg-1.ts",
        "https://cdn.test/a/seg-2.ts",
        "https://cdn.test/b/seg-1.ts",
      ],
      pageUrl: "https://watch.test/title",
    });
    expect(rules).toHaveLength(2);
    expect(rules.map((rule) => rule.condition.urlFilter)).toEqual([
      "||cdn.test/a/",
      "||cdn.test/b/",
    ]);
    expect(rules[0].condition.initiatorDomains).toEqual(["extension-id"]);
    expect(rules[0].action.requestHeaders).toEqual([
      { header: "Origin", operation: "set", value: "https://watch.test" },
      { header: "Referer", operation: "set", value: "https://watch.test/" },
    ]);
  });

  it("returns caller-owned rule IDs for finally cleanup", async () => {
    const ids = await addOperationHeaderRules({
      operationId: "clip_2",
      urls: ["https://cdn.test/media/seg.ts"],
      pageUrl: "https://watch.test/page",
    });
    expect(ids).toHaveLength(1);
    expect(updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: ids,
      addRules: expect.any(Array),
    });

    await removeHeaderRules(ids);
    expect(updateDynamicRules).toHaveBeenLastCalledWith({ removeRuleIds: ids });
  });
});

