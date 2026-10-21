import { describe, expect, it } from "vitest";
import { parseSynthesisJson } from "./ingestion.js";

describe("parseSynthesisJson", () => {
  it("parsuje czysty JSON", () => {
    expect(parseSynthesisJson('{"title":"Test"}')).toEqual({ title: "Test" });
  });

  it("zdejmuje fence ```json", () => {
    expect(parseSynthesisJson('```json\n{"title":"A"}\n```')).toEqual({ title: "A" });
  });

  it("zdejmuje fence ```JSON (wielkie litery)", () => {
    expect(parseSynthesisJson('```JSON\n{"title":"B"}\n```')).toEqual({ title: "B" });
  });

  it("zdejmuje goły fence ```", () => {
    expect(parseSynthesisJson('```\n{"title":"C"}\n```')).toEqual({ title: "C" });
  });

  it("ignoruje prozę przed i po JSON", () => {
    expect(parseSynthesisJson('Oto artykuł:\n{"title":"D"}\nMam nadzieję, że pasuje.')).toEqual({ title: "D" });
  });

  it("przy dwóch obiektach bierze pierwszy", () => {
    expect(parseSynthesisJson('{"a":1}\n{"b":2}')).toEqual({ a: 1 });
  });

  it("przechodzi przez klamry w prozie (klama przed JSON)", () => {
    expect(parseSynthesisJson('Uwaga {to nie jest json}, dane: {"title":"E"}')).toEqual({ title: "E" });
  });

  it("radzi sobie z niezamkniętym fence", () => {
    expect(parseSynthesisJson('```json\n{"title":"F"}')).toEqual({ title: "F" });
  });

  it("rzuca wyjątek, gdy nie ma żadnego JSON-a", () => {
    expect(() => parseSynthesisJson("Przepraszam, nie mogę tego zrobić.")).toThrow();
  });

  it("nie myli klamry wewnątrz stringa z końcem obiektu", () => {
    expect(parseSynthesisJson('{"title":"nawias } w środku"}')).toEqual({ title: "nawias } w środku" });
  });
});
