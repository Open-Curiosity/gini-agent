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
  web: WebOptions;
}
