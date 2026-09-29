import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { fetchUsage, identify } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "devin",
    label: "Devin",
    input: inputSchema,
    discover: async () => [{}],
    identify,
    fetch: fetchUsage,
  });
  return () => {};
}
