import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL en/of VITE_SUPABASE_ANON_KEY ontbreken. Kopieer .env.example naar .env en vul de waarden in.",
  );
}

export const supabase = createClient(url, anonKey);
