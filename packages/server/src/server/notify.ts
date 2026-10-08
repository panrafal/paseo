import {
  buildAgentAttentionNotificationPayload,
  findLatestPermissionRequest,
  truncateNotificationText,
  type AgentAttentionNotificationPayload,
} from "@getpaseo/protocol/agent-attention-notification";
import type { AgentProvider } from "./agent/agent-sdk-types.js";
import type { NotifyRequest, NotifyResponse } from "@getpaseo/protocol/notify";
import type { AgentManager, ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { PushPayload } from "./push/push-service.js";
import {
  computeNotificationPlan,
  isPushEligibleAttentionReason,
  type ClientPresenceState,
  type NotificationPlan,
} from "./agent-attention-policy.js";

export type AgentAttentionParams = {
  agentId: string;
  provider: AgentProvider;
} & (
  | { reason: "finished" | "error" | "permission"; notification?: never; urgent?: never }
  | { reason: "notify"; notification: AgentAttentionNotificationPayload; urgent?: boolean }
);

export type NotifyHandler = (request: NotifyRequest) => Promise<NotifyResponse["payload"]>;

export interface NotificationClientState extends ClientPresenceState {
  deviceType: "web" | "mobile" | null;
}

interface AgentNotificationPlanInput {
  params: AgentAttentionParams;
  allStates: NotificationClientState[];
  nowMs: number;
}

export function computeAgentNotificationPlan({
  params,
  allStates,
  nowMs,
}: AgentNotificationPlanInput): NotificationPlan {
  const plan = computeNotificationPlan({
    allStates,
    focusTarget: { kind: "agent", id: params.agentId },
    pushEligible: isPushEligibleAttentionReason(params.reason),
    forcePush: params.urgent,
    nowMs,
  });
  if (params.reason === "notify" && plan.inAppRecipientIndex !== null) {
    const recipient = allStates[plan.inAppRecipientIndex];
    const visibleWebRecipient = recipient.appVisible && recipient.deviceType === "web";
    return { ...plan, shouldPush: plan.shouldPush || !visibleWebRecipient };
  }
  return plan;
}

interface AttentionNotificationInput {
  params: AgentAttentionParams;
  agent: ManagedAgent | null;
  agentManager: Pick<AgentManager, "getLastAssistantMessage">;
  serverId: string;
}

export async function resolveAgentAttentionNotification({
  params,
  agent,
  agentManager,
  serverId,
}: AttentionNotificationInput): Promise<AgentAttentionNotificationPayload | null> {
  if (params.reason === "notify") return params.notification;
  if (!agent?.workspaceId) return null;
  const assistantMessage = await agentManager.getLastAssistantMessage(params.agentId);
  return buildAgentAttentionNotificationPayload({
    reason: params.reason,
    serverId,
    workspaceId: agent.workspaceId,
    agentId: params.agentId,
    assistantMessage,
    permissionRequest: findLatestPermissionRequest(agent.pendingPermissions),
  });
}

interface NotifyAgentInput {
  request: NotifyRequest;
  agentManager: Pick<AgentManager, "getAgent">;
  agentStorage: Pick<AgentStorage, "get">;
  serverId: string;
  broadcastAttention: (params: AgentAttentionParams) => Promise<void>;
}

export async function notifyAgent({
  request,
  agentManager,
  agentStorage,
  serverId,
  broadcastAttention,
}: NotifyAgentInput): Promise<NotifyResponse["payload"]> {
  const { requestId, agentId } = request;
  const agent = agentManager.getAgent(agentId);
  const stored = await agentStorage.get(agentId);
  const sender = agent ?? stored;
  if (!sender) return { requestId, agentId, error: `Agent not found: ${agentId}` };
  if (!sender.workspaceId)
    return { requestId, agentId, error: `Agent has no workspace: ${agentId}` };

  const title = stored?.title ?? agent?.config.title;
  const notification: AgentAttentionNotificationPayload = {
    title: request.title ?? (title?.trim() || "Agent message"),
    body: request.message,
    data: { serverId, workspaceId: sender.workspaceId, agentId, reason: "notify" },
  };
  await broadcastAttention({
    agentId,
    provider: sender.provider,
    reason: "notify",
    notification,
    urgent: request.urgent,
  });
  return { requestId, agentId, error: null };
}

interface AttentionPushInput {
  notification: AgentAttentionNotificationPayload;
  urgent: boolean | undefined;
}

export function buildAttentionPushPayload({
  notification,
  urgent,
}: AttentionPushInput): PushPayload {
  const options: Pick<PushPayload, "priority" | "channelId" | "interruptionLevel"> = urgent
    ? { priority: "high", channelId: "urgent", interruptionLevel: "time-sensitive" }
    : {};
  return {
    ...notification,
    title: truncateNotificationText(notification.title),
    body: truncateNotificationText(notification.body),
    ...options,
  };
}
