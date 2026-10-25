import { describe, expect, it } from "vitest";
import { rejectArticle, saveArticle } from "@kombain/db";
import { saveArticle as saveArticleSubpath } from "@kombain/db/persist";

describe("@kombain/db — eksport persist", () => {
  it("saveArticle/rejectArticle dostępne z roota i subpathu", () => {
    expect(typeof saveArticle).toBe("function");
    expect(typeof rejectArticle).toBe("function");
    expect(saveArticleSubpath).toBe(saveArticle);
  });
});
