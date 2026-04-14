import { config } from "dotenv";
import { select } from "@inquirer/prompts";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Load environment variables from .env file
config();

interface EnvironmentConfig {
  key: string;
  name: string;
  url: string;
}

/**
 * Scans process.env to find all defined database environments
 * and validates the URL format.
 */
function getAvailableEnvironments(): EnvironmentConfig[] {
  const envs = new Map<string, Partial<EnvironmentConfig>>();

  // Extract keys, URLs, and Names from process.env
  for (const envKey in process.env) {
    const urlMatch = envKey.match(/^database\.(.+)\.url$/);
    const nameMatch = envKey.match(/^database\.(.+)\.name$/);

    if (urlMatch) {
      const key = urlMatch[1];
      const existing = envs.get(key) || { key };
      existing.url = process.env[envKey] as string;
      envs.set(key, existing);
    }

    if (nameMatch) {
      const key = nameMatch[1];
      const existing = envs.get(key) || { key };
      existing.name = process.env[envKey] as string;
      envs.set(key, existing);
    }
  }

  const validEnvs: EnvironmentConfig[] = [];

  // Validate extracted environments
  for (const [key, env] of envs.entries()) {
    if (!env.url) {
      console.warn(
        `⚠️ Warning: Environment '${key}' is missing a URL. Skipping.`,
      );
      continue;
    }

    // URL Format Validation
    try {
      const parsedUrl = new URL(env.url);
      if (
        parsedUrl.protocol !== "postgresql:" &&
        parsedUrl.protocol !== "postgres:"
      ) {
        console.warn(
          `⚠️ Warning: Environment '${key}' has an invalid protocol (${parsedUrl.protocol}). Must be postgres:// or postgresql://. Skipping.`,
        );
        continue;
      }
    } catch (e) {
      console.warn(
        `⚠️ Warning: Environment '${key}' has a malformed/unparseable URL. Skipping.`,
      );
      continue;
    }

    validEnvs.push({
      key: env.key as string,
      name: env.name || key, // Fallback to the env key (e.g., 'primary') if name is omitted
      url: env.url,
    });
  }

  return validEnvs;
}

/**
 * Wraps the pg_dump CLI tool in a Promise-based spawn function
 */
function runPgDump(args: string[], dbUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };

    // Safely extract the password from the validated URL to prevent pg_dump from hanging
    try {
      const parsedUrl = new URL(dbUrl);
      if (parsedUrl.password) {
        env.PGPASSWORD = parsedUrl.password;
      }
    } catch (e) {
      // Should not hit this due to prior validation, but caught for safety
    }

    const processSpawn = spawn("pg_dump", args, { env });

    processSpawn.stderr.on("data", (data) => {
      // pg_dump writes its progress/warnings to stderr
      console.warn(`pg_dump output: ${data.toString().trim()}`);
    });

    processSpawn.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pg_dump exited with code ${code}`));
      }
    });

    processSpawn.on("error", (err) => {
      reject(
        new Error(
          `Failed to start pg_dump. Is PostgreSQL installed on this machine? Error: ${err.message}`,
        ),
      );
    });
  });
}

/**
 * Main execution block
 */
async function main() {
  console.log("Scanning environment variables...\n");
  const environments = getAvailableEnvironments();

  if (environments.length === 0) {
    console.error("❌ No valid database environments found in .env file.");
    process.exit(1);
  }

  // Initialization Output
  console.log(
    `✅ ${environments.length} environment(s) loaded successfully.\n`,
  );

  // Interactive CLI to choose the environment
  const selectedEnvKey = await select({
    message: "Select the database environment to backup:",
    choices: environments.map((env) => ({
      name: env.name,
      value: env.key, // Value used to look up the selected environment later
    })),
  });

  const targetEnv = environments.find((e) => e.key === selectedEnvKey);

  if (!targetEnv) {
    console.error("❌ Failed to resolve the selected environment.");
    process.exit(1);
  }

  // Prepare the output directory
  const today = new Date().toISOString().split("T")[0];
  const baseDir = path.join(process.cwd(), "artefacts", "downloads", today);

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const schemaOnlyPath = path.join(baseDir, `${targetEnv.key}-schema-only.sql`);
  const fullBackupPath = path.join(baseDir, `${targetEnv.key}-full-backup.sql`);

  console.log(`\nStarting backup for: [${targetEnv.name}]`);
  console.log(`Destination: ${baseDir}\n`);

  try {
    // Execute Schema-Only Dump
    console.log("⏳ Running schema-only backup...");
    await runPgDump(
      [
        "--schema-only",
        "--clean",
        "--if-exists",
        "-f",
        schemaOnlyPath,
        targetEnv.url,
      ],
      targetEnv.url,
    );
    console.log(`✅ Schema dump saved to: ${schemaOnlyPath}`);

    // Execute Full Data + Schema Dump
    console.log("\n⏳ Running full backup (schema + data + metadata)...");
    await runPgDump(["-f", fullBackupPath, targetEnv.url], targetEnv.url);
    console.log(`✅ Full backup saved to: ${fullBackupPath}`);

    console.log("\n🎉 Backup completed successfully!");
  } catch (error) {
    console.error(
      `\n❌ Backup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

main();
