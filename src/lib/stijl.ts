import type { SignaalErnst } from "../types";

/** Tailwind-klassen voor badges per ernst van een signaal. */
export const ERNST_KLASSEN: Record<SignaalErnst, string> = {
  kritiek: "bg-red-100 text-red-700",
  waarschuwing: "bg-amber-100 text-amber-800",
  info: "bg-sky-100 text-sky-700",
};
