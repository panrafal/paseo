export type { PluginHandlerContext } from "./contracts.js";

export { defineAttachmentSource } from "./attachments.js";
export { defineRpc, type PluginRpcContract, type RpcInput, type RpcOutput } from "./rpc.js";

export type {
  PluginBeforeRequests,
  PluginHookAgent,
  PluginHookContext,
  PluginHookWorkspace,
  PluginLifecycleEvents,
  PluginLifecycleRegistration,
  PluginSessionOpenRequest,
  PluginTurnOutcome,
} from "./lifecycle.js";
