// Draait de handtest-scripts uit supabase/handtests (die je ook in de SQL Editor van Supabase kunt
// plakken) op een lokale database. Elk script eindigt met de fout "GESLAAGD: ..." als alles klopt.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { leesSql, maakDatabase } from "./db";

const scripts = readdirSync(join(import.meta.dirname, "..", "handtests"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("handtests", () => {
  it.each(scripts)("%s eindigt met GESLAAGD", async (script) => {
    const db = await maakDatabase();
    await expect(db.exec(leesSql(`handtests/${script}`))).rejects.toThrow(/^GESLAAGD/);
    await db.close();
  });
});
