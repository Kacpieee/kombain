import { describe, expect, it } from "vitest";
import { slugify } from "./slug.js";

describe("slugify (PL)", () => {
  it("zamienia polskie znaki diakrytyczne na ASCII", () => {
    expect(slugify("Łódź")).toBe("lodz");
  });

  it("czyści typowy tytuł AgTech: interpunkcja, ampersand, wielkie litery", () => {
    expect(slugify("Agri-PV w Polsce: 2026 & więcej!")).toBe("agri-pv-w-polsce-2026-wiecej");
  });

  it("obsługuje pełny zestaw polskich znaków", () => {
    expect(slugify("Zażółć gęślą jaźń")).toBe("zazolc-gesla-jazn");
  });

  it("usuwa diakrytyki nie-polskie przez NFD", () => {
    expect(slugify("Café über")).toBe("cafe-uber");
  });

  it("zwija powtarzające się separatory i przycina krawędzie", () => {
    expect(slugify("  --wiele   separatorów--  ")).toBe("wiele-separatorow");
  });

  it("pusty string daje pusty slug", () => {
    expect(slugify("")).toBe("");
  });

  it("same znaki specjalne dają pusty slug", () => {
    expect(slugify("!!! ??? ...")).toBe("");
  });

  it("nie kończy się myślnikiem po obcięciu do limitu", () => {
    const result = slugify(`${"x".repeat(79)} yz`);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("-")).toBe(false);
  });

  it("zachowuje cyfry", () => {
    expect(slugify("Drony 2026")).toBe("drony-2026");
  });

  it("jest idempotentny", () => {
    const once = slugify("Inteligentne Maszyny i Drony: RTK/GNSS");
    expect(slugify(once)).toBe(once);
  });

  it("wielokrotne wywołanie na tytule z Znakami PL nie gubi liter", () => {
    expect(slugify("źdźbło żółwia")).toBe("zdzblo-zolwia");
  });

  it("respektuje własny limit długości", () => {
    expect(slugify("bardzo długi tytuł artykułu o dronach", 10)).toBe("bardzo-dlu");
  });
});
