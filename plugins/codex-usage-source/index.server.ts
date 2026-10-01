import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { inputSchema } from "./shared/input.js";
import { consumeBankedReset, fetchUsage, identify } from "./server/usage.js";

const consumeBankedResetRpc = defineRpc({
  name: "codex.consume_banked_reset",
  input: z.object({ creditId: z.string().min(1), idempotencyKey: z.string().min(1) }).strict(),
  output: z.enum(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
});

export default function contribute(server: PluginServerContext) {
  server.handle(consumeBankedResetRpc, (input) => consumeBankedReset(input));
  server.registerUsageSource({
    id: "codex",
    label: "Codex",
    icon: "icon.svg",
    input: inputSchema,
    discover: async () => [{}],
    identify,
    fetch: fetchUsage,
  });
  return () => {};
}
