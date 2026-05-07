// Argument parsing helpers shared by the CLI entry and command modules.

export function stripGlobalArgs(values: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (["--lane", "--state-root", "--log-root", "--port", "--web-port"].includes(values[index] ?? "")) {
      index += 1;
      continue;
    }
    if (values[index] === "--no-web" || values[index] === "--web") continue;
    stripped.push(values[index]);
  }
  return stripped;
}

export function applyGlobalEnvOverrides(values: string[], ephemeral: boolean): void {
  const stateRoot = flagValue(values, "--state-root");
  const logRoot = flagValue(values, "--log-root");
  const port = flagValue(values, "--port");
  if (stateRoot) process.env.GINI_STATE_ROOT = stateRoot;
  if (logRoot) process.env.GINI_LOG_ROOT = logRoot;
  if (port) process.env.GINI_PORT = port;
  if (ephemeral) {
    process.env.GINI_STATE_ROOT ??= `/tmp/gini-smoke-${process.pid}`;
    process.env.GINI_LOG_ROOT ??= `/tmp/gini-smoke-${process.pid}-logs`;
    process.env.GINI_PORT ??= String(7400 + Math.floor(Math.random() * 1000));
  }
}

export function flagValue(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index >= 0 ? values[index + 1] : undefined;
}

export function hasFlag(values: string[], flag: string): boolean {
  return values.includes(flag);
}

// Returns the args after a marker token within cliArgs. Used by command
// modules to collect the variable-length tail of a sub-command:
//   `gini task submit hello world` → restAfter(cliArgs, "submit") === ["hello", "world"]
export function restAfter(cliArgs: string[], marker: string): string[] {
  const index = cliArgs.indexOf(marker);
  return index >= 0 ? cliArgs.slice(index + 1) : [];
}
