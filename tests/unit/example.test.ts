import { describe, expect, it } from "vitest";

import { featureExample } from "@/feature";
import { example } from "@/index";

describe("example test", () => {
    it("should return example", () => {
        expect(example()).toBe("example");
    });

    it("returns the feature entry example", () => {
        expect(featureExample()).toBe("feature");
    });
});
