import type { RuntimeConfig } from "../types";
import type { WebOptions } from "./process";

// Per-invocation parameters threaded through every command module.
//
// `cliArgs` is the args list AFTER global flags have been stripped, so
// `cliArgs[0]` is the verb (`task`, `chat`, ...) and `cliArgs[1]` is the
// sub-verb. Command modules read positional tail args via
// `args.restAfter(cliArgs, sub)`.
export interface CliContext {
  config: RuntimeConfig;
  cliArgs: string[];
  command: string;
  ephemeralSmoke: boolean;
  // True when --instance was passed explicitly OR GINI_INSTANCE was set in the
  // env. Drives the uninstall command's split between full-uninstall (default)
  // and single-instance mode. stripGlobalArgs erases the flag from cliArgs, so
  // commands that need the original signal read this instead.
  explicitInstance: boolean;
  // The original argv slice before stripGlobalArgs. Commands that need to peek
  // at flags consumed by the global parser (e.g. uninstall checking --yes,
  // --purge) read from here.
  rawArgs: string[];
  web: WebOptions;
}
