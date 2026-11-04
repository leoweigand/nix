import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { validateNetwork } from "./egress.ts";

export interface Source {
  network?: { server: string[] };
  files: Record<string, string>;
  dependencies: Record<string, string>;
}
export function validateSource(source: Source) {
  validateNetwork(source.network);
  if (!source.files?.["src/app.ts"])
    throw new Error("Supply src/app.ts exporting class App");
  if (Object.keys(source.files).length > 64)
    throw new Error("At most 64 files");
  let bytes = 0;
  for (const [name, value] of Object.entries(source.files)) {
    if (
      !/^(src|public)\/[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split("/").some((p) => !p || p === "." || p === "..") ||
      typeof value !== "string"
    )
      throw new Error(`Invalid source path: ${name}`);
    bytes += Buffer.byteLength(value);
  }
  if (bytes > 1024 * 1024) throw new Error("Source exceeds 1 MiB");
  if (Object.keys(source.dependencies ?? {}).length > 24)
    throw new Error("At most 24 dependencies");
  for (const [name, version] of Object.entries(source.dependencies ?? {}))
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
    )
      throw new Error(
        "Dependencies require package names and exact semver versions",
      );
}

function killJob(child: ChildProcess) {
  try {
    if (child.pid && process.platform !== "win32")
      process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function watchJob(
  child: ChildProcess,
  signal: AbortSignal | undefined,
  timeout: number,
  failed: (error: Error) => void,
) {
  const abort = () => {
    failed(
      signal?.reason instanceof Error
        ? signal.reason
        : new Error("Build cancelled"),
    );
    killJob(child);
  };
  const timer = setTimeout(() => {
    failed(new Error("Build timed out"));
    killJob(child);
  }, timeout);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.once("close", () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
}
function install(
  directory: string,
  npm: string,
  sandbox?: string,
  signal?: AbortSignal,
): Promise<void> {
  // No submitted package.json, scripts, npmrc, environment or lifecycle hooks.
  const args = [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org/",
  ];
  const command = sandbox ?? npm;
  const fullArgs = sandbox ? [directory, npm, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, fullArgs, {
      cwd: directory,
      env: {
        PATH: process.env.PATH!,
        HOME: directory,
        npm_config_cache: path.join(directory, ".cache"),
        npm_config_userconfig: path.join(directory, ".npm-user"),
        npm_config_globalconfig: path.join(directory, ".npm-global"),
        ...(process.env.SSL_CERT_FILE
          ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let diagnostics = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (b) => {
        diagnostics = (diagnostics + b).slice(-12000);
      });
    let failure: Error | undefined;
    watchJob(child, signal, 120_000, (error) => {
      failure = error;
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) =>
      code === 0 && !failure
        ? resolve()
        : reject(
            failure ??
              new Error(
                `Dependency installation failed (${code}): ${diagnostics}`,
              ),
          ),
    );
  });
}

export async function bundle(
  source: Source,
  scratch: string,
  options: {
    npm?: string;
    sandbox?: string;
    compileSandbox?: string;
    signal?: AbortSignal;
  } = {},
) {
  options.signal?.throwIfAborted();
  validateSource(source);
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "build-"));
  try {
    for (const [name, content] of Object.entries(source.files)) {
      const target = path.join(directory, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: source.dependencies ?? {},
      }),
    );
    if (Object.keys(source.dependencies ?? {}).length) {
      await writeFile(path.join(directory, ".npm-user"), "");
      await writeFile(path.join(directory, ".npm-global"), "");
      await install(
        directory,
        options.npm ?? "npm",
        options.sandbox,
        options.signal,
      );
    }
    options.signal?.throwIfAborted();
    const code = options.compileSandbox
      ? await isolatedCompile(directory, options.compileSandbox, options.signal)
      : await compile(directory);
    options.signal?.throwIfAborted();
    return {
      code,
      lock: Object.keys(source.dependencies ?? {}).length
        ? await readFile(path.join(directory, "package-lock.json"), "utf8")
        : null,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function compile(directory: string): Promise<string> {
  const root = await realpath(directory);
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/app.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    tsconfigRaw: { compilerOptions: {} },
    plugins: [
      {
        name: "contained-source",
        setup(build) {
          build.onResolve({ filter: /.*/ }, async (args) => {
            if (args.path === "cloudflare:workers")
              return { path: args.path, external: true };
            if (args.pluginData?.checked) return;
            const resolved = await build.resolve(args.path, {
              importer: args.importer,
              resolveDir: args.resolveDir,
              kind: args.kind,
              pluginData: { checked: true },
            });
            if (resolved.errors.length) return resolved;
            const actual = await realpath(resolved.path);
            if (!actual.startsWith(root + path.sep))
              return {
                errors: [
                  {
                    text: "Imports must stay inside the submitted source and installed dependencies",
                  },
                ],
              };
            // The recursion marker must not reach onLoad: esbuild passes a
            // loaded module's pluginData to its imports as well.
            return { ...resolved, pluginData: undefined };
          });
        },
      },
    ],
  });
  const code = result.outputFiles[0]!.text;
  if (Buffer.byteLength(code) > 2 * 1024 * 1024)
    throw new Error("Bundle exceeds 2 MiB");

  return code;
}

function isolatedCompile(
  directory: string,
  sandbox: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(sandbox, [directory], {
      cwd: directory,
      env: { ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let code = "",
      diagnostics = "";
    child.stdout.on("data", (b) => {
      code += b;
      if (Buffer.byteLength(code) > 3 * 1024 * 1024) killJob(child);
    });
    child.stderr.on("data", (b) => {
      diagnostics = (diagnostics + b).slice(-12000);
    });
    let failure: Error | undefined;
    watchJob(child, signal, 30_000, (error) => {
      failure = error;
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (status) =>
      status === 0 && !failure
        ? resolve(code)
        : reject(failure ?? new Error(`Compile failed: ${diagnostics}`)),
    );
  });
}
if (process.argv[2] === "--compile") {
  try {
    process.stdout.write(await compile(process.argv[3]!));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Compile failed");
    process.exitCode = 1;
  }
}
