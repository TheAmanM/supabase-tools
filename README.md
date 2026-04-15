# Supabase Tools

> Small CLI to create and restore local SQL backups for Supabase/Postgres projects.

This repository provides a lightweight interactive CLI (TypeScript) that:

- Creates schema-only and full SQL dumps using `pg_dump`.
- Restores SQL dumps using `psql`.

The entrypoint is `index.ts` and the project is intended to be run locally (development via `npm run dev`).

**Table of contents**

- Prerequisites
- Install
- Configuration
- Usage (backup / restore)
- Backup layout & manifest
- Troubleshooting & notes
- What a good README contains

## Prerequisites

- Node.js (v16+ recommended)
- PostgreSQL client tools available on PATH: `pg_dump` and `psql`
- An `.env` file with database environment variables (see Configuration)

The CLI uses `pg_dump` and `psql` under the hood — ensure those binaries are installed and accessible.

## Install

1. Install dependencies:

```bash
npm install
```

2. Run in development (the project includes a `dev` script that uses `tsx`):

```bash
npm run dev
```

Alternatively, compile with `tsc` then run the compiled `index.js`:

```bash
npx tsc
node index.js
```

## Configuration

This tool reads environment variables (via `dotenv`). It expects database entries using this naming pattern:

- `database.<envKey>.url` — the Postgres connection URL (postgres:// or postgresql://)
- `database.<envKey>.name` — a human-friendly name for the environment (optional)

Example `.env` snippet:

```
database.primary.url=postgresql://user:password@db.xxxxxxxx.supabase.co:5432/postgres
database.primary.name=Primary (prod)

database.staging.url=postgresql://user:password@db.yyyyyyyy.supabase.co:5432/postgres
database.staging.name=Staging
```

Keep your `.env` out of source control and never commit secrets.

## Usage

Run the CLI with `npm run dev` and follow the interactive prompts.

- Backup flow:
  1. Select the source environment.
  2. The tool runs a schema-only `pg_dump --schema-only --clean --if-exists` and a full `pg_dump`.
  3. Dumps are saved under `artefacts/downloads/<ISO-timestamp>/` with filenames:
     - `<envKey>-schema-only.sql`
     - `<envKey>-full-backup.sql`
  4. A `backup-manifest.json` is written alongside the dumps with metadata.

- Restore flow:
  1. Select the target environment.
  2. Choose a local backup file.
  3. If the selected backup contains data, you will be offered to restore schema+data or schema-only (using the paired schema-only file if present).
  4. Confirm the overwrite warning, then the CLI runs `psql -v ON_ERROR_STOP=1 -f <file> <safe-db-url>` to apply the SQL.

Important: the tool sets `PGPASSWORD` from the URL when invoking `pg_dump`/`psql` so the password is not leaked in logs, and it strips the password when passing the URL to `psql` so the command-line is safer.

## Backup layout & manifest

Backups are stored under:

```
artefacts/downloads/<ISO-timestamp>/
  - <envKey>-schema-only.sql
  - <envKey>-full-backup.sql
  - backup-manifest.json
```

The `backup-manifest.json` follows this structure (example):

```json
{
  "version": 1,
  "createdAt": "2026-04-15T00:38:10.760Z",
  "sourceEnvironmentKey": "primary",
  "sourceEnvironmentName": "Primary (prod)",
  "sourceProjectName": "Primary (prod)",
  "sourceProjectId": "xxxxxxxx",
  "files": {
    "schemaOnly": "primary-schema-only.sql",
    "fullBackup": "primary-full-backup.sql"
  },
  "hasData": {
    "schemaOnly": false,
    "fullBackup": true
  }
}
```

The CLI will attempt to infer missing manifest fields if the manifest is absent or malformed.

## Troubleshooting

- `pg_dump` or `psql` not found: install PostgreSQL client tools and ensure they're on your `PATH`.
- Authentication failures: verify the connection URL in your `.env`; ensure the credentials are correct.
- Large dumps: make sure you have sufficient disk space under `artefacts/`.
- Manifest parse warnings: if the manifest is invalid, the CLI falls back to inferring metadata from filenames.

## Security notes

- Do not commit `artefacts/` or `.env` to source control.
- Limit who has access to local backup files — they can contain sensitive data.

## What a README for a CLI tool should contain

Necessary:

- One-line summary of purpose.
- Clear prerequisites (binaries, versions).
- Quick start (install + run) commands.
- Basic usage examples (common flows).

Good to have:

- Configuration examples and environment variables.
- Troubleshooting tips and common error explanations.
- File layout / manifest format so users and automation can parse outputs.
- Security and privacy notes for credentials and backups.

Unnecessary (usually avoid):

- Long internal design docs or implementation details that quickly go out of date.
- Dense API docs for internal functions — keep these in code or separate developer docs.

## Contributing

Contributions are welcome. Open an issue or PR with a clear description of the change.

## Files of interest

- `index.ts` — main CLI implementation
- `package.json` — scripts and dependencies (run `npm run dev` to start)

## License

Choose and add a license if you plan to publish or share this project publicly.
