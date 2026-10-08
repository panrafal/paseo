import { z } from "zod";

export const NotifyRequestSchema = z.object({
  type: z.literal("agent.notify.request"),
  requestId: z.string(),
  agentId: z.string().min(1),
  message: z.string().min(1),
  title: z.string().min(1).optional(),
  urgent: z.boolean().optional(),
});

export const NotifyResponseSchema = z.object({
  type: z.literal("agent.notify.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    error: z.string().nullable(),
  }),
});

export type NotifyRequest = z.infer<typeof NotifyRequestSchema>;
export type NotifyResponse = z.infer<typeof NotifyResponseSchema>;
export type NotifyOptions = Omit<NotifyRequest, "type" | "requestId">;
