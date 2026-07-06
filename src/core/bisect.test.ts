import { describe, it, expect } from "vitest";
import { splitRange, midpointDate, addDays } from "./bisect";

describe("addDays", () => {
  it("soma dias respeitando virada de mês/ano", () => {
    expect(addDays("2024-01-30", 2)).toBe("2024-02-01");
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
  });
});

describe("midpointDate", () => {
  it("acha o meio de um intervalo par de dias", () => {
    expect(midpointDate("2024-01-01", "2024-01-05")).toBe("2024-01-03");
  });

  it("arredonda pra baixo em intervalo ímpar", () => {
    expect(midpointDate("2024-01-01", "2024-01-02")).toBe("2024-01-01");
  });
});

describe("splitRange", () => {
  it("divide em duas metades contíguas sem sobreposição nem buraco", () => {
    const result = splitRange("2024-01-01", "2024-12-31");
    expect(result).not.toBeNull();
    const [[f1, t1], [f2, t2]] = result!;

    expect(f1).toBe("2024-01-01");
    expect(t2).toBe("2024-12-31");
    expect(addDays(t1, 1)).toBe(f2);
  });

  it("retorna null quando o intervalo já é de um único dia (não bissecta mais)", () => {
    expect(splitRange("2024-05-15", "2024-05-15")).toBeNull();
  });

  it("lida com intervalo de 2 dias (menor caso bissectável)", () => {
    const result = splitRange("2024-05-15", "2024-05-16");
    expect(result).toEqual([
      ["2024-05-15", "2024-05-15"],
      ["2024-05-16", "2024-05-16"],
    ]);
  });
});
