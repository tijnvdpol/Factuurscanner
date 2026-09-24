import { describe, expect, it } from "vitest";
import { leesEmailConfig, leesMailActieHash, mailVoorWeergave, vulAppUrl } from "./notificaties";

describe("notificaties (frontend)", () => {
  it("leest de mail-link uit de hash", () => {
    expect(leesMailActieHash("#mail-actie=v1.abc.def&keuze=afkeuren")).toEqual({ token: "v1.abc.def", keuze: "afkeuren" });
    expect(leesMailActieHash("#mail-actie=v1.abc.def")).toEqual({ token: "v1.abc.def", keuze: null });
    expect(leesMailActieHash("#mail-actie=v1.a.b&keuze=iets")).toEqual({ token: "v1.a.b", keuze: null });
    // Andere hashes (bijv. na een Supabase-login) zijn geen mail-link
    expect(leesMailActieHash("#access_token=abc&type=signup")).toBeNull();
    expect(leesMailActieHash("")).toBeNull();
  });

  it("config met dezelfde grenzen als de database", () => {
    expect(leesEmailConfig(null)).toEqual({ dagen_voor_vervaldatum: 3, link_geldig_uren: 72 });
    expect(leesEmailConfig({ dagen_voor_vervaldatum: 90, link_geldig_uren: 0 })).toEqual({ dagen_voor_vervaldatum: 30, link_geldig_uren: 1 });
    expect(leesEmailConfig({ dagen_voor_vervaldatum: "5", link_geldig_uren: 2.5 })).toEqual({ dagen_voor_vervaldatum: 5, link_geldig_uren: 72 });
  });

  it("mock-mail: app-URL invullen en links in een nieuw tabblad", () => {
    expect(vulAppUrl('<a href="{{APP_URL}}/#mail-actie=x">', "https://app.nl/")).toBe('<a href="https://app.nl/#mail-actie=x">');
    expect(mailVoorWeergave("<html><head><title>t</title></head></html>", "https://app.nl")).toBe(
      '<html><head><base target="_blank"><title>t</title></head></html>',
    );
  });
});
