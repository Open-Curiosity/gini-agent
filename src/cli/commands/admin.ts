// Lifecycle and lane-admin commands: install, start, stop, status, doctor, reset.
import type { CliContext } from "../context";
import { install, resetLane } from "../../domain/runtime";
import {
  doctor,
  remoteOrLocalStatus,
  start as startLifecycle,
  stopRuntime
} from "../process";
import { print } from "../output";

export async function install_(ctx: CliContext): Promise<void> {
  const { config } = ctx;
  install(config);
  print({ installed: true, lane: config.lane, stateRoot: config.stateRoot, port: config.port });
}

export async function start(ctx: CliContext): Promise<boolean> {
  const { banner, runtimeStarted } = await startLifecycle(ctx.config, ctx.web);
  print(banner);
  return runtimeStarted;
}

export function stop(ctx: CliContext): void {
  print(stopRuntime(ctx.config));
}

export async function statusCmd(ctx: CliContext): Promise<void> {
  print(await remoteOrLocalStatus(ctx.config, ctx.web));
}

export async function doctorCmd(ctx: CliContext): Promise<void> {
  print(await doctor(ctx.config, ctx.web));
}

export function reset(ctx: CliContext): void {
  resetLane(ctx.config);
  print({ reset: true, lane: ctx.config.lane, stateRoot: ctx.config.stateRoot });
}
