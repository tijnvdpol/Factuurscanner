// Hulpfuncties voor de databasetests: een verse Postgres (PGlite) met de platform-nabootsing en alle
// migraties uit supabase/migrations, in bestandsvolgorde.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const SUPABASE_MAP = join(import.meta.dirname, "..");

export function leesSql(relatiefPad: string): string {
  return readFileSync(join(SUPABASE_MAP, relatiefPad), "utf8");
}

function migraties(): string[] {
  return readdirSync(join(SUPABASE_MAP, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Verse database met de platform-nabootsing en de migraties. Met `tot` alleen de migraties waarvan
 * de bestandsnaam daarvóór komt (om een backfill te testen); vervolg dan met migreerVanaf().
 */
export async function maakDatabase(tot?: string): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(leesSql("tests/platform.sql"));
  await voerUit(db, migraties().filter((f) => tot === undefined || f < tot));
  return db;
}

export async function migreerVanaf(db: PGlite, vanaf: string): Promise<void> {
  await alsBeheerder(db);
  await voerUit(db, migraties().filter((f) => f >= vanaf));
}

async function voerUit(db: PGlite, bestanden: string[]): Promise<void> {
  for (const bestand of bestanden) {
    try {
      await db.exec(leesSql(`migrations/${bestand}`));
    } catch (err) {
      throw new Error(`Migratie ${bestand} faalt: ${(err as Error).message}`, { cause: err });
    }
  }
}

/** Schakelt de sessie naar een ingelogde gebruiker (rol authenticated), of naar anon bij null. */
export async function alsGebruiker(db: PGlite, userId: string | null): Promise<void> {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : "",
  ]);
  await db.exec(userId ? "set role authenticated" : "set role anon");
}

/** Als de service role (zoals een Edge Function met de geheime sleutel), zonder ingelogde gebruiker. */
export async function alsServiceRole(db: PGlite): Promise<void> {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claims', '', false)");
  await db.exec("set role service_role");
}

/** Terug naar de superuser (zoals de SQL Editor). */
export async function alsBeheerder(db: PGlite): Promise<void> {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claims', '', false)");
}

export async function maakGebruiker(db: PGlite, email: string): Promise<string> {
  await alsBeheerder(db);
  const id = crypto.randomUUID();
  await db.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return id;
}

export async function waarde<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<Record<string, T>>(sql, params);
  const rij = rows[0];
  if (!rij) throw new Error(`Geen resultaat voor: ${sql}`);
  return Object.values(rij)[0];
}

/** Voert een query uit en geeft alle rijen terug. */
export async function rijen<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

export async function organisatieVan(db: PGlite, userId: string): Promise<string> {
  await alsBeheerder(db);
  return waarde<string>(db, "select organisatie_id from public.organisatie_leden where user_id = $1 order by created_at limit 1", [userId]);
}
