import type { RuntimeConfig } from "../types";
import { claimPairingCode, createPairingCode, findActiveDeviceByToken, mutateState, readState, revokeDevice } from "../state";

export function createPairing(config: RuntimeConfig, input: Record<string, unknown>) {
  const ttlSeconds = Math.min(3600, Math.max(60, Number(input.ttlSeconds ?? 600)));
  const created = mutateState(config.lane, (state) => createPairingCode(state, ttlSeconds));
  return {
    id: created.pairing.id,
    lane: created.pairing.lane,
    code: created.code,
    expiresAt: created.pairing.expiresAt
  };
}

export function claimPairing(config: RuntimeConfig, input: Record<string, unknown>) {
  const code = String(input.code ?? "");
  const deviceName = String(input.deviceName ?? "Mobile device");
  if (!code) throw new Error("Pairing code is required.");
  const claimed = mutateState(config.lane, (state) => claimPairingCode(state, code, deviceName));
  return {
    device: redactDevice(claimed.device),
    token: claimed.token
  };
}

export function revokePairedDevice(config: RuntimeConfig, deviceId: string) {
  return redactDevice(mutateState(config.lane, (state) => revokeDevice(state, deviceId)));
}

export function authorizedBearer(config: RuntimeConfig, bearer: string | undefined): boolean {
  if (bearer === config.token) return true;
  if (!bearer) return false;
  const device = mutateState(config.lane, (state) => findActiveDeviceByToken(state, bearer));
  return Boolean(device);
}

export function redactDevice(device: ReturnType<typeof readState>["devices"][number]) {
  return {
    id: device.id,
    lane: device.lane,
    name: device.name,
    status: device.status,
    scopes: device.scopes,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt
  };
}
