import { describe, expect, it } from "vitest";
import { bedragInEuro, euro, filterFacturen, goedkeurBlokkade, magVerwijderen, mogelijkeActies, valtTerugNaGewijzigd, type WorkflowContext } from "./workflow";
import { GEEN_OMREKENING, LEGE_WORKFLOW, type Factuur, type FactuurStatus, type Rol, type Signaal } from "../types";

const IK = "ik";
const ANDER = "ander";

function factuur(
  status: FactuurStatus,
  extra: Partial<Pick<Factuur, "totaal_incl" | "valuta" | "euro" | "signalen" | "codering" | "workflow">> = {},
) {
  return {
    status,
    totaal_incl: 1000,
    valuta: "EUR" as string | null,
    euro: GEEN_OMREKENING,
    signalen: [] as Signaal[],
    codering: { grootboekrekening_id: "r1", bron: "handmatig" as const, zekerheid: null },
    workflow: { ...LEGE_WORKFLOW, ingevoerd_door: ANDER, gecontroleerd_door: ANDER },
    ...extra,
  };
}

function ctx(rol: Rol, extra: Partial<WorkflowContext> = {}): WorkflowContext {
  return { userId: IK, rol, goedkeuringslimiet: null, aantalLeden: 3, ...extra };
}

const acties = (f: ReturnType<typeof factuur>, c: WorkflowContext) => mogelijkeActies(f, c).map((a) => a.actie);

describe("zichtbare knoppen per rol en status", () => {
  it.each<[FactuurStatus, Rol, string[]]>([
    ["gescand", "invoerder", ["controleren"]],
    ["gescand", "goedkeurder", ["afkeuren"]],
    ["gescand", "controller", ["controleren", "afkeuren"]],
    ["gescand", "beheerder", ["controleren", "afkeuren"]],
    ["gecontroleerd", "invoerder", []],
    ["gecontroleerd", "goedkeurder", ["goedkeuren", "afkeuren"]],
    ["gecontroleerd", "controller", ["goedkeuren", "afkeuren"]],
    ["goedgekeurd", "goedkeurder", []],
    ["goedgekeurd", "controller", ["betalen"]],
    ["goedgekeurd", "beheerder", ["betalen"]],
    ["betaald", "beheerder", []],
    ["afgekeurd", "invoerder", ["heropenen"]],
    ["afgekeurd", "goedkeurder", []],
  ])("%s + %s → %j", (status, rol, verwacht) => {
    expect(acties(factuur(status), ctx(rol))).toEqual(verwacht);
  });

  it("afkeuren vraagt om een reden", () => {
    expect(mogelijkeActies(factuur("gescand"), ctx("controller")).find((a) => a.actie === "afkeuren")?.vraagtReden).toBe(true);
  });
});

describe("goedkeuren geblokkeerd met reden", () => {
  const blokkade = (f: ReturnType<typeof factuur>, c: WorkflowContext) =>
    mogelijkeActies(f, c).find((a) => a.actie === "goedkeuren")?.geblokkeerd;

  it("uitvoerbaar als alles klopt", () => {
    expect(blokkade(factuur("gecontroleerd"), ctx("goedkeurder"))).toBeNull();
  });

  it("functiescheiding: zelf ingevoerd of zelf gecontroleerd", () => {
    expect(blokkade(factuur("gecontroleerd", { workflow: { ...LEGE_WORKFLOW, ingevoerd_door: IK } }), ctx("controller")))
      .toMatch(/zelf ingevoerd/);
    expect(blokkade(factuur("gecontroleerd", { workflow: { ...LEGE_WORKFLOW, gecontroleerd_door: IK } }), ctx("beheerder")))
      .toMatch(/zelf gecontroleerd/);
  });

  it("boven de limiet", () => {
    expect(blokkade(factuur("gecontroleerd", { totaal_incl: 5000.01 }), ctx("goedkeurder", { goedkeuringslimiet: 5000 })))
      .toBe("Boven je goedkeuringslimiet van € 5.000");
    expect(blokkade(factuur("gecontroleerd", { totaal_incl: 5000 }), ctx("goedkeurder", { goedkeuringslimiet: 5000 }))).toBeNull();
    expect(blokkade(factuur("gecontroleerd", { totaal_incl: null }), ctx("goedkeurder", { goedkeuringslimiet: 5000 })))
      .toMatch(/Totaalbedrag ontbreekt/);
  });

  it("open kritiek signaal, en ontbrekende grootboekrekening", () => {
    const kritiek = { ernst: "kritiek", opgelost: false } as Signaal;
    expect(blokkade(factuur("gecontroleerd", { signalen: [kritiek] }), ctx("goedkeurder"))).toMatch(/kritiek signaal/);
    expect(blokkade(factuur("gecontroleerd", { signalen: [{ ...kritiek, opgelost: true }] }), ctx("goedkeurder"))).toBeNull();
    expect(
      blokkade(factuur("gecontroleerd", { codering: { grootboekrekening_id: null, bron: null, zekerheid: null } }), ctx("goedkeurder")),
    ).toMatch(/grootboekrekening/);
  });

  it("organisatie met één lid: alle knoppen en geen functiescheiding, limiet blijft", () => {
    const enig = ctx("invoerder", { aantalLeden: 1 });
    const eigen = factuur("gecontroleerd", { workflow: { ...LEGE_WORKFLOW, ingevoerd_door: IK, gecontroleerd_door: IK } });
    expect(acties(eigen, enig)).toEqual(["goedkeuren", "afkeuren"]);
    expect(blokkade(eigen, enig)).toBeNull();
    expect(blokkade({ ...eigen, totaal_incl: 20 }, { ...enig, goedkeuringslimiet: 10 })).toMatch(/limiet/);
  });
});

describe("overige regels", () => {
  it("verwijderen", () => {
    const eigen = { status: "gescand" as const, workflow: { ...LEGE_WORKFLOW, ingevoerd_door: IK } };
    expect(magVerwijderen(eigen, ctx("invoerder"))).toBe(true);
    expect(magVerwijderen({ ...eigen, status: "gecontroleerd" }, ctx("invoerder"))).toBe(false);
    expect(magVerwijderen({ ...eigen, workflow: LEGE_WORKFLOW }, ctx("controller"))).toBe(false);
    expect(magVerwijderen({ ...eigen, status: "betaald" }, ctx("beheerder"))).toBe(true);
  });

  it("terugval na inhoudelijke wijziging", () => {
    const oud = { leverancier: "A", valuta: "EUR", bedrag_excl: 100, totaal_incl: 121, iban: "NL91ABNA0417164300", btw_regels: [] };
    expect(valtTerugNaGewijzigd("gecontroleerd", oud, { ...oud, totaal_incl: 122 })).toBe(true);
    expect(valtTerugNaGewijzigd("goedgekeurd", oud, { ...oud, iban: "nl91 abna 0417 1643 00" })).toBe(false);
    expect(valtTerugNaGewijzigd("goedgekeurd", oud, { ...oud, btw_regels: [{ tarief: 21, grondslag: 1, btw_bedrag: 0.21 }] })).toBe(true);
    expect(valtTerugNaGewijzigd("gescand", oud, { ...oud, totaal_incl: 1 })).toBe(false);
  });

  it("filters per tab", () => {
    const lijst = (["gescand", "gecontroleerd", "goedgekeurd", "betaald", "afgekeurd", "gescand"] as FactuurStatus[]).map((status) => ({ status }));
    expect(filterFacturen(lijst, "te_controleren")).toHaveLength(2);
    expect(filterFacturen(lijst, "te_keuren")).toEqual([{ status: "gecontroleerd" }]);
    expect(filterFacturen(lijst, "te_betalen")).toEqual([{ status: "goedgekeurd" }]);
    expect(filterFacturen(lijst, "afgekeurd")).toEqual([{ status: "afgekeurd" }]);
    expect(filterFacturen(lijst, "alles")).toHaveLength(6);
  });

  it("euro-notatie", () => {
    expect(euro(5000)).toBe("€ 5.000");
    expect(euro(1234.5)).toBe("€ 1.234,50");
  });
});

describe("goedkeuringslimiet in euro", () => {
  const usd = (bedrag: number | null) =>
    factuur("gecontroleerd", {
      valuta: "USD",
      totaal_incl: 6000,
      euro: { bedrag, koers: bedrag === null ? null : 1.1622, koers_datum: "2026-09-04", bron: "ecb" },
    });

  it("vreemde valuta: het omgerekende bedrag telt, niet het getal op de factuur", () => {
    const c = ctx("goedkeurder", { goedkeuringslimiet: 5000 });
    expect(bedragInEuro(usd(5162.62))).toBe(5162.62);
    expect(goedkeurBlokkade(usd(5162.62), c)).toBe("Boven je goedkeuringslimiet van € 5.000");
    expect(goedkeurBlokkade(usd(4900), c)).toBeNull();
  });

  it("koers nog onbekend: geblokkeerd bij een limiet, niet zonder limiet", () => {
    expect(goedkeurBlokkade(usd(null), ctx("goedkeurder", { goedkeuringslimiet: 5000 }))).toMatch(/Wisselkoers nog niet bekend/);
    expect(goedkeurBlokkade(usd(null), ctx("controller"))).toBeNull();
  });

  it("euro (of geen valuta): het totaal telt", () => {
    expect(bedragInEuro(factuur("gecontroleerd", { valuta: null, totaal_incl: 99 }))).toBe(99);
    expect(bedragInEuro(factuur("gecontroleerd", { valuta: "eur ", totaal_incl: 99 }))).toBe(99);
  });
});
