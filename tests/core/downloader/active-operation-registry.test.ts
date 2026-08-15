import { describe, expect, it } from "vitest";
import { ActiveOperationRegistry } from "@/core/downloader/active-operation-registry";

describe("ActiveOperationRegistry", () => {
  it("allows distinct operation keys for the same source", () => {
    const registry = new ActiveOperationRegistry<string>();
    expect(
      registry.register({ id: "clip-a", operationKey: "range:0-1000", value: "a" }),
    ).toBe(true);
    expect(
      registry.register({
        id: "clip-b",
        operationKey: "range:1000-2000",
        value: "b",
      }),
    ).toBe(true);
    expect(registry.size).toBe(2);
  });

  it("rejects an exact active duplicate", () => {
    const registry = new ActiveOperationRegistry<string>();
    registry.register({ id: "clip-a", operationKey: "same", value: "a" });
    expect(
      registry.register({ id: "clip-b", operationKey: "same", value: "b" }),
    ).toBe(false);
    expect(registry.getByOperationKey("same")?.id).toBe("clip-a");
  });

  it("releases both indexes on completion", () => {
    const registry = new ActiveOperationRegistry<string>();
    registry.register({ id: "clip-a", operationKey: "same", value: "a" });
    registry.removeById("clip-a");
    expect(registry.getByOperationKey("same")).toBeUndefined();
    expect(
      registry.register({ id: "clip-b", operationKey: "same", value: "b" }),
    ).toBe(true);
  });
});
