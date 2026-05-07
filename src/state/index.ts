// Barrel re-export. Mirrors the public surface of the previous
// monolithic src/state.ts so importers can keep `from "../state"` /
// `from "./state"` paths unchanged. Add a new name here when promoting
// an internal helper to public; everything that was exported before the
// split must remain re-exported here.

export { now, id } from "./ids";
export { assertInsideWorkspace, hashSecret } from "./security";
export {
  createEmptyState,
  readState,
  writeState,
  mutateState
} from "./store";
export { appendTrace, readTrace, tracePath, appendLog } from "./trace";
export { addAudit, appendEvent } from "./audit";
export {
  taskCounts,
  upsertTask,
  createTask,
  createChatSession,
  createChatMessage,
  createApproval,
  createMemory,
  createSkill,
  createJob,
  createJobRun,
  createImprovementProposal,
  createPairingCode,
  claimPairingCode,
  revokeDevice,
  findActiveDeviceByToken,
  createPromotionProposal,
  decidePromotion,
  createSnapshotRecord,
  createSubagentRecord,
  createMcpServerRecord,
  createMessagingBridgeRecord,
  createMessagingMessageRecord,
  createImportReport,
  createProfileRecord,
  createRelayRecord,
  createNotificationRecord,
  activateProfile,
  updateConnectorHealth
} from "./records";
