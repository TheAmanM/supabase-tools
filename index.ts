import { config } from "dotenv";
import { confirm, select } from "@inquirer/prompts";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import figlet from "figlet";
import { Chalk } from "chalk";

const chalk = new Chalk({ level: 2 });

config();

interface EnvironmentConfig {
  key: string;
  name: string;
  url: string;
}

type ActionType = "backup" | "restore";
type BackupKind = "schema-only" | "full-backup" | "unknown";
type DataRestoreMode = "with-data" | "schema-only";

interface BackupManifest {
  version: 1;
  createdAt: string;
  sourceEnvironmentKey: string;
  sourceEnvironmentName: string;
  sourceProjectName: string;
  sourceProjectId?: string;
  files: {
    schemaOnly: string;
    fullBackup: string;
  };
  hasData: {
    schemaOnly: boolean;
    fullBackup: boolean;
  };
}

interface BackupOption {
  id: string;
  filePath: string;
  fileName: string;
  backupFolder: string;
  kind: BackupKind;
  hasData: boolean;
  sizeBytes: number;
  backupDateTime: string;
  sourceEnvironmentKey?: string;
  sourceEnvironmentName: string;
  sourceProjectName: string;
  sourceProjectId?: string;
  pairedSchemaOnlyPath?: string;
}

const DOWNLOADS_ROOT = path.join(process.cwd(), "artefacts", "downloads");
const MANIFEST_FILE_NAME = "backup-manifest.json";

function getSupabaseProjectId(dbUrl: string): string | undefined {
  try {
    const parsedUrl = new URL(dbUrl);
    const host = parsedUrl.hostname;
    const username = decodeURIComponent(parsedUrl.username || "");

    const poolerUsernameMatch = username.match(/^[^.]+\.([a-z0-9]{8,30})$/i);
    if (poolerUsernameMatch) {
      return poolerUsernameMatch[1];
    }

    const dbHostMatch = host.match(/^db\.([a-z0-9]{8,30})\.supabase\.co$/i);
    if (dbHostMatch) {
      return dbHostMatch[1];
    }

    const genericHostMatch = host.match(/^([a-z0-9]{8,30})\.supabase\.co$/i);
    if (genericHostMatch) {
      return genericHostMatch[1];
    }
  } catch (error) {
    return undefined;
  }

  return undefined;
}

function getSafeDbUrl(dbUrl: string): string {
  try {
    const parsedUrl = new URL(dbUrl);
    parsedUrl.password = "";
    return parsedUrl.toString();
  } catch (error) {
    return dbUrl;
  }
}

function getPgCommandEnv(dbUrl: string): NodeJS.ProcessEnv {
  const env = { ...process.env };

  try {
    const parsedUrl = new URL(dbUrl);
    if (parsedUrl.password) {
      env.PGPASSWORD = parsedUrl.password;
    }
  } catch (error) {}

  return env;
}

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

function runPgDump(args: string[], dbUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = getPgCommandEnv(dbUrl);

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

function runPsql(filePath: string, dbUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = getPgCommandEnv(dbUrl);
    const safeDbUrl = getSafeDbUrl(dbUrl);
    const processSpawn = spawn(
      "psql",
      ["-v", "ON_ERROR_STOP=1", "-f", filePath, safeDbUrl],
      { env },
    );

    processSpawn.stdout.on("data", (data) => {
      console.log(chalk.dim(`psql output: ${data.toString().trim()}`));
    });

    processSpawn.stderr.on("data", (data) => {
      console.warn(chalk.dim(`psql output: ${data.toString().trim()}`));
    });

    processSpawn.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`psql exited with code ${code}`));
      }
    });

    processSpawn.on("error", (err) => {
      reject(
        new Error(
          `Failed to start psql. Is PostgreSQL installed on this machine? Error: ${err.message}`,
        ),
      );
    });
  });
}

function backupHasData(filePath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      rl.close();
      stream.destroy();
      resolve(value);
    };

    rl.on("line", (line) => {
      if (
        (line.startsWith("-- Data for Name:") &&
          line.includes("Type: TABLE DATA")) ||
        /^COPY\s+.+\s+FROM\s+stdin;$/i.test(line)
      ) {
        finish(true);
      }
    });

    rl.on("close", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });

    rl.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    stream.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function getBackupKind(fileName: string): BackupKind {
  if (fileName.endsWith("-schema-only.sql")) {
    return "schema-only";
  }

  if (fileName.endsWith("-full-backup.sql")) {
    return "full-backup";
  }

  return "unknown";
}

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listSqlFilesRecursively(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const results: string[] = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      results.push(...listSqlFilesRecursively(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".sql")) {
      results.push(fullPath);
    }
  }

  return results;
}

function readBackupManifest(directory: string): BackupManifest | null {
  const manifestPath = path.join(directory, MANIFEST_FILE_NAME);

  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(content) as Partial<BackupManifest>;

    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.sourceEnvironmentKey !== "string" ||
      typeof parsed.sourceEnvironmentName !== "string" ||
      typeof parsed.sourceProjectName !== "string" ||
      !parsed.files ||
      typeof parsed.files.schemaOnly !== "string" ||
      typeof parsed.files.fullBackup !== "string" ||
      !parsed.hasData ||
      typeof parsed.hasData.schemaOnly !== "boolean" ||
      typeof parsed.hasData.fullBackup !== "boolean"
    ) {
      console.warn(
        chalk.yellow(
          `Warning: Invalid backup manifest format at '${manifestPath}'. Falling back to inferred metadata.`,
        ),
      );
      return null;
    }

    return {
      version: 1,
      createdAt: parsed.createdAt,
      sourceEnvironmentKey: parsed.sourceEnvironmentKey,
      sourceEnvironmentName: parsed.sourceEnvironmentName,
      sourceProjectName: parsed.sourceProjectName,
      sourceProjectId:
        typeof parsed.sourceProjectId === "string"
          ? parsed.sourceProjectId
          : undefined,
      files: {
        schemaOnly: parsed.files.schemaOnly,
        fullBackup: parsed.files.fullBackup,
      },
      hasData: {
        schemaOnly: parsed.hasData.schemaOnly,
        fullBackup: parsed.hasData.fullBackup,
      },
    };
  } catch (error) {
    console.warn(
      chalk.yellow(
        `Warning: Failed to parse backup manifest at '${manifestPath}'. Falling back to inferred metadata.`,
      ),
    );
    return null;
  }
}

function resolveSchemaOnlyPair(backup: BackupOption): string | null {
  if (backup.kind === "schema-only") {
    return backup.filePath;
  }

  if (
    backup.pairedSchemaOnlyPath &&
    fs.existsSync(backup.pairedSchemaOnlyPath)
  ) {
    return backup.pairedSchemaOnlyPath;
  }

  if (backup.kind === "full-backup") {
    const derivedPath = path.join(
      path.dirname(backup.filePath),
      backup.fileName.replace(/-full-backup\.sql$/, "-schema-only.sql"),
    );

    if (fs.existsSync(derivedPath)) {
      return derivedPath;
    }
  }

  return null;
}

function getBackupChoiceLabel(backup: BackupOption): string {
  const badge = backup.hasData
    ? chalk.green("DATA")
    : chalk.yellow("SCHEMA_ONLY");
  const projectName = backup.sourceProjectName || "Unknown Project";
  const projectId = backup.sourceProjectId || "unknown-id";
  const backupTime = formatDateTime(backup.backupDateTime);
  const size = formatFileSize(backup.sizeBytes);

  return `${badge} ${chalk.cyan(projectName)} ${chalk.gray(`(${projectId})`)} ${chalk.gray("•")} ${backupTime} ${chalk.gray("•")} ${size} ${chalk.gray("•")} ${backup.fileName}`;
}

async function getBackupOptions(
  environments: EnvironmentConfig[],
): Promise<BackupOption[]> {
  if (!fs.existsSync(DOWNLOADS_ROOT)) {
    return [];
  }

  const sqlFiles = listSqlFilesRecursively(DOWNLOADS_ROOT);
  const manifestCache = new Map<string, BackupManifest | null>();
  const envByKey = new Map<string, EnvironmentConfig>(
    environments.map((env) => [env.key, env]),
  );

  const options: BackupOption[] = [];

  for (const filePath of sqlFiles) {
    const directory = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const backupFolder = path.basename(directory);
    const stats = fs.statSync(filePath);
    const backupKind = getBackupKind(fileName);

    let manifest = manifestCache.get(directory);
    if (manifest === undefined) {
      manifest = readBackupManifest(directory);
      manifestCache.set(directory, manifest);
    }

    let sourceEnvironmentKey: string | undefined;
    let sourceEnvironmentName = "Unknown Environment";
    let sourceProjectName = "Unknown Project";
    let sourceProjectId: string | undefined;
    let backupDateTime = stats.mtime.toISOString();
    let hasData: boolean | undefined;
    let pairedSchemaOnlyPath: string | undefined;

    if (manifest) {
      sourceEnvironmentKey = manifest.sourceEnvironmentKey;
      sourceEnvironmentName = manifest.sourceEnvironmentName;
      sourceProjectName = manifest.sourceProjectName;
      sourceProjectId = manifest.sourceProjectId;
      backupDateTime = manifest.createdAt;
      pairedSchemaOnlyPath = path.join(directory, manifest.files.schemaOnly);

      if (fileName === manifest.files.schemaOnly) {
        hasData = manifest.hasData.schemaOnly;
      } else if (fileName === manifest.files.fullBackup) {
        hasData = manifest.hasData.fullBackup;
      }
    }

    if (
      !sourceEnvironmentKey ||
      sourceEnvironmentName === "Unknown Environment"
    ) {
      const inferredMatch = fileName.match(
        /^(.*)-(schema-only|full-backup)\.sql$/,
      );

      if (inferredMatch) {
        sourceEnvironmentKey = inferredMatch[1];
        const mappedEnvironment = envByKey.get(sourceEnvironmentKey);

        if (mappedEnvironment) {
          sourceEnvironmentName = mappedEnvironment.name;
          sourceProjectName = mappedEnvironment.name;
          sourceProjectId = getSupabaseProjectId(mappedEnvironment.url);
        } else {
          sourceEnvironmentName = sourceEnvironmentKey;
          sourceProjectName = sourceEnvironmentKey;
        }
      }
    }

    if (!hasData && hasData !== false) {
      hasData = await backupHasData(filePath);
    }

    if (!pairedSchemaOnlyPath && backupKind === "full-backup") {
      const derivedSchemaPath = path.join(
        directory,
        fileName.replace(/-full-backup\.sql$/, "-schema-only.sql"),
      );

      if (fs.existsSync(derivedSchemaPath)) {
        pairedSchemaOnlyPath = derivedSchemaPath;
      }
    }

    options.push({
      id: `${directory}::${fileName}`,
      filePath,
      fileName,
      backupFolder,
      kind: backupKind,
      hasData,
      sizeBytes: stats.size,
      backupDateTime,
      sourceEnvironmentKey,
      sourceEnvironmentName,
      sourceProjectName,
      sourceProjectId,
      pairedSchemaOnlyPath,
    });
  }

  options.sort((a, b) => {
    const aTime = new Date(a.backupDateTime).getTime();
    const bTime = new Date(b.backupDateTime).getTime();

    if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) {
      return bTime - aTime;
    }

    return b.sizeBytes - a.sizeBytes;
  });

  return options;
}

async function runBackupFlow(environments: EnvironmentConfig[]): Promise<void> {
  const selectedEnvKey = await select({
    message: "Select the database environment to backup:",
    choices: environments.map((env) => ({
      name: env.name,
      value: env.key,
    })),
    theme: {
      icon: { cursor: chalk.cyan("◉") },
    },
  });

  const targetEnv = environments.find((e) => e.key === selectedEnvKey);

  if (!targetEnv) {
    throw new Error("Failed to resolve the selected environment.");
  }

  const timestamp = new Date().toISOString();
  const baseDir = path.join(DOWNLOADS_ROOT, timestamp);

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const schemaOnlyFileName = `${targetEnv.key}-schema-only.sql`;
  const fullBackupFileName = `${targetEnv.key}-full-backup.sql`;
  const schemaOnlyPath = path.join(baseDir, schemaOnlyFileName);
  const fullBackupPath = path.join(baseDir, fullBackupFileName);
  const manifestPath = path.join(baseDir, MANIFEST_FILE_NAME);
  const safeDbUrl = getSafeDbUrl(targetEnv.url);

  console.log(chalk.magenta(`\nStarting backup for: [${targetEnv.name}]`));
  console.log(chalk.gray(`Destination: ${baseDir}\n`));

  console.log(chalk.cyan("Running schema-only backup..."));
  await runPgDump(
    [
      "--schema-only",
      "--clean",
      "--if-exists",
      "-f",
      schemaOnlyPath,
      safeDbUrl,
    ],
    targetEnv.url,
  );
  console.log(chalk.green(`Schema dump saved to: ${schemaOnlyPath}`));

  console.log(
    chalk.cyan("\nRunning full backup (schema + data + metadata)..."),
  );
  await runPgDump(["-f", fullBackupPath, safeDbUrl], targetEnv.url);
  console.log(chalk.green(`Full backup saved to: ${fullBackupPath}`));

  const schemaOnlyHasData = await backupHasData(schemaOnlyPath);
  const fullBackupHasData = await backupHasData(fullBackupPath);
  const projectId = getSupabaseProjectId(targetEnv.url);

  const manifest: BackupManifest = {
    version: 1,
    createdAt: timestamp,
    sourceEnvironmentKey: targetEnv.key,
    sourceEnvironmentName: targetEnv.name,
    sourceProjectName: targetEnv.name,
    sourceProjectId: projectId,
    files: {
      schemaOnly: schemaOnlyFileName,
      fullBackup: fullBackupFileName,
    },
    hasData: {
      schemaOnly: schemaOnlyHasData,
      fullBackup: fullBackupHasData,
    },
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(chalk.gray(`Backup manifest saved to: ${manifestPath}`));
  console.log(
    chalk.gray(
      `Backup metadata: project='${manifest.sourceProjectName}', projectId='${manifest.sourceProjectId || "unknown-id"}', createdAt='${formatDateTime(manifest.createdAt)}'`,
    ),
  );
  console.log(chalk.bgGreen.black("\n Backup completed successfully! \n"));
}

async function runRestoreFlow(
  environments: EnvironmentConfig[],
): Promise<void> {
  const selectedEnvKey = await select({
    message: "Select the target environment to restore into:",
    choices: environments.map((env) => ({
      name: env.name,
      value: env.key,
    })),
    theme: {
      icon: { cursor: chalk.cyan("◉") },
    },
  });

  const targetEnv = environments.find((e) => e.key === selectedEnvKey);

  if (!targetEnv) {
    throw new Error("Failed to resolve the selected restore environment.");
  }

  console.log(chalk.blue("\nScanning local backups...\n"));
  const backups = await getBackupOptions(environments);

  if (backups.length === 0) {
    throw new Error(`No SQL backups found under '${DOWNLOADS_ROOT}'.`);
  }

  const selectedBackupId = await select({
    message: "Select the backup to restore:",
    choices: backups.map((backup) => ({
      name: getBackupChoiceLabel(backup),
      value: backup.id,
      description: chalk.gray(
        `Source env: ${backup.sourceEnvironmentName} | Folder: ${backup.backupFolder}`,
      ),
    })),
    pageSize: 15,
    theme: {
      icon: { cursor: chalk.cyan("◉") },
    },
  });

  const selectedBackup = backups.find(
    (backup) => backup.id === selectedBackupId,
  );

  if (!selectedBackup) {
    throw new Error("Failed to resolve the selected backup.");
  }

  let dataRestoreMode: DataRestoreMode = "with-data";

  if (selectedBackup.hasData) {
    dataRestoreMode = await select({
      message:
        "This backup includes table data (including auth users and app data). How should restore run?",
      choices: [
        {
          name: chalk.green("Apply schema and data"),
          value: "with-data",
          description:
            "Restores database objects and table rows from the selected file.",
        },
        {
          name: chalk.yellow("Apply schema only"),
          value: "schema-only",
          description:
            "Restores only schema objects (uses matching schema-only backup file).",
        },
      ],
      theme: {
        icon: { cursor: chalk.cyan("◉") },
      },
    });
  }

  let restoreFilePath = selectedBackup.filePath;

  if (selectedBackup.hasData && dataRestoreMode === "schema-only") {
    const schemaOnlyPath = resolveSchemaOnlyPair(selectedBackup);

    if (!schemaOnlyPath) {
      throw new Error(
        `Schema-only restore requested, but no matching schema-only backup file was found for '${selectedBackup.fileName}'.`,
      );
    }

    restoreFilePath = schemaOnlyPath;
  }

  const continueWithRestore = await confirm({
    message: `Restore '${path.basename(restoreFilePath)}' into '${targetEnv.name}' now? This operation can overwrite existing objects.`,
    default: false,
  });

  if (!continueWithRestore) {
    console.log(chalk.yellow("Restore cancelled by user."));
    return;
  }

  console.log(chalk.magenta(`\nStarting restore into: [${targetEnv.name}]`));
  console.log(chalk.gray(`Backup file: ${restoreFilePath}`));
  console.log(
    chalk.gray(
      `Data restore: ${
        selectedBackup.hasData
          ? dataRestoreMode === "with-data"
            ? "enabled"
            : "disabled (schema only)"
          : "not detected in selected backup"
      }`,
    ),
  );

  await runPsql(restoreFilePath, targetEnv.url);

  console.log(chalk.bgGreen.black("\n Restore completed successfully! \n"));
}

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

  const combinedArt = supabaseLines
    .map((line, index) => {
      const coloredSupabase = chalk.hex("#3ecf8e")(line);
      const coloredTools = chalk.hex("#00311d")(toolsLines[index] || "");

      return `${coloredSupabase}${coloredTools}`;
    })
    .join("\n");

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

  const action = await select<ActionType>({
    message: "What would you like to do?",
    choices: [
      {
        name: chalk.green("Backup"),
        value: "backup",
        description:
          "Create a new schema + full SQL dump and save local metadata.",
      },
      {
        name: chalk.yellow("Restore"),
        value: "restore",
        description:
          "Apply a local SQL backup to the selected target environment.",
      },
    ],
    theme: {
      icon: { cursor: chalk.cyan("◉") },
    },
  });

  try {
    if (action === "backup") {
      await runBackupFlow(environments);
    } else {
      await runRestoreFlow(environments);
    }
  } catch (error) {
    console.error(
      chalk.red(
        `\nOperation failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }
}

main();
