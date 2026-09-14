import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Postgres connection settings for the pipeline logins.
 *
 * Remote connections use TLS verified against Supabase's own CA (verify-full:
 * the CA and the hostname are both checked). The certificate is public and
 * lives at certs/supabase-ca.crt. Download it from Supabase: Project Settings →
 * Database → SSL Configuration.
 *
 * SSL parameters in the URL are removed, because node-postgres lets them
 * override the settings here, and its `sslmode=require` means "verify against
 * the system CAs", which Supabase's certificate is not issued by.
 *
 * A local socket or localhost connects without TLS. That is only the throwaway
 * test database from scripts/test-queue.sh.
 */

const SSL_PARAMS = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];
const CA_FILE = path.join(process.cwd(), "certs", "supabase-ca.crt");

let supabaseCa: string | undefined;

function readSupabaseCa(): string {
  if (supabaseCa) return supabaseCa;
  try {
    supabaseCa = readFileSync(CA_FILE, "utf8");
  } catch {
    throw new Error(
      `Missing ${CA_FILE}. Download the CA certificate from Supabase (Project Settings → ` +
        "Database → SSL Configuration) and save it as certs/supabase-ca.crt.",
    );
  }
  return supabaseCa;
}

export interface DatabaseConnection {
  connectionString: string;
  ssl: false | { ca: string; rejectUnauthorized: true };
}

export function databaseConnection(databaseUrl: string): DatabaseConnection {
  const url = new URL(databaseUrl);
  for (const param of SSL_PARAMS) url.searchParams.delete(param);

  const host = decodeURIComponent(url.hostname);
  const local = host === "localhost" || host === "127.0.0.1" || host.startsWith("/");

  return {
    connectionString: url.toString(),
    ssl: local ? false : { ca: readSupabaseCa(), rejectUnauthorized: true },
  };
}
