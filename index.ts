import { config } from "dotenv";
import { select } from "@inquirer/prompts";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import figlet from "figlet";
import { Chalk } from "chalk";

const chalk = new Chalk({ level: 2 });

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

  for (const [key, env] of envs.entries()) {
    if (!env.url) {
      console.warn(
        chalk.yellow(
          `Warning: Environment '${key}' is missing a URL. Skipping.`,
        ),
      );
      continue;
    }

    try {
      const parsedUrl = new URL(env.url);
      if (
        parsedUrl.protocol !== "postgresql:" &&
        parsedUrl.protocol !== "postgres:"
      ) {
        console.warn(
          chalk.yellow(
            `Warning: Environment '${key}' has an invalid protocol (${parsedUrl.protocol}). Must be postgres:// or postgresql://. Skipping.`,
          ),
        );
        continue;
      }
    } catch (e) {
      console.warn(
        chalk.yellow(
          `Warning: Environment '${key}' has a malformed/unparseable URL. Skipping.`,
        ),
      );
      continue;
    }

    validEnvs.push({
      key: env.key as string,
      name: env.name || key,
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

    try {
      const parsedUrl = new URL(dbUrl);
      if (parsedUrl.password) {
        env.PGPASSWORD = parsedUrl.password;
      }
    } catch (e) {
      // Ignored: Caught by prior validation
    }

    const processSpawn = spawn("pg_dump", args, { env });

    processSpawn.stderr.on("data", (data) => {
      console.warn(chalk.dim(`pg_dump output: ${data.toString().trim()}`));
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
  const supabaseLines = figlet
    .textSync("Supabase", {
      horizontalLayout: "controlled smushing",
    })
    .split("\n");

  const toolsLines = figlet
    .textSync("Tools", {
      horizontalLayout: "controlled smushing",
    })
    .split("\n");

  // 2. Stitch them together row-by-row, applying the correct colors
  const combinedArt = supabaseLines
    .map((line, index) => {
      const coloredSupabase = chalk.hex("#3ecf8e")(line);
      // We use toolsLines[index] || "" as a fallback just in case the heights ever mismatch
      const coloredTools = chalk.hex("#00311d")(toolsLines[index] || "");

      // Combine the left and right sides with a space in between
      return `${coloredSupabase} ${coloredTools}`;
    })
    .join("\n");

  // 3. Print the final result
  console.log(combinedArt);
  console.log("\n");

  console.log(chalk.blue("Scanning environment variables...\n"));
  const environments = getAvailableEnvironments();

  if (environments.length === 0) {
    console.error(
      chalk.red("Error: No valid database environments found in .env file."),
    );
    process.exit(1);
  }

  console.log(
    chalk.green(`${environments.length} environment(s) loaded successfully.\n`),
  );

  // Interactive CLI to choose the environment
  const selectedEnvKey = await select({
    message: "Select the database environment to backup:",
    choices: environments.map((env) => ({
      name: env.name,
      value: env.key,
    })),
    theme: {
      icon: { cursor: chalk.cyan("◉") }, // Use a colored circle for the active selection
    },
  });

  const targetEnv = environments.find((e) => e.key === selectedEnvKey);

  if (!targetEnv) {
    console.error(
      chalk.red("Error: Failed to resolve the selected environment."),
    );
    process.exit(1);
  }

  // Prepare the output directory
  const today = new Date().toISOString();
  const baseDir = path.join(process.cwd(), "artefacts", "downloads", today);

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const schemaOnlyPath = path.join(baseDir, `${targetEnv.key}-schema-only.sql`);
  const fullBackupPath = path.join(baseDir, `${targetEnv.key}-full-backup.sql`);

  console.log(chalk.magenta(`\nStarting backup for: [${targetEnv.name}]`));
  console.log(chalk.gray(`Destination: ${baseDir}\n`));

  try {
    // Execute Schema-Only Dump
    console.log(chalk.cyan("Running schema-only backup..."));
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
    console.log(chalk.green(`Schema dump saved to: ${schemaOnlyPath}`));

    // Execute Full Data + Schema Dump
    console.log(
      chalk.cyan("\nRunning full backup (schema + data + metadata)..."),
    );
    await runPgDump(["-f", fullBackupPath, targetEnv.url], targetEnv.url);
    console.log(chalk.green(`Full backup saved to: ${fullBackupPath}`));

    console.log(chalk.bgGreen.black("\n Backup completed successfully! \n"));
  } catch (error) {
    console.error(
      chalk.red(
        `\nBackup failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }
}

main();
