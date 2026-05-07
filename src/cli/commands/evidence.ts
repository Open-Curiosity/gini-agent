import type { CliContext } from "../context";
import { createEvidenceBundle } from "../../domain/harness";
import { print } from "../output";

export function evidence(ctx: CliContext): void {
  print(createEvidenceBundle(ctx.config));
}
