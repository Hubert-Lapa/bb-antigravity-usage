import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import { readAntigravityUsage } from "./antigravity-usage.js";
import { hostUsageState, usageHostContract } from "./usage-host-contract.js";

export default experimental_defineHostEntry({
  contract: usageHostContract,
  handlers: {
    async "usage.readAntigravity"() {
      const agyCli = await experimental_resolveExecutablePath("agy") ?? undefined;
      const result = await readAntigravityUsage({ agyCli });
      return hostUsageState.parse(result.supported
        ? result.usage
        : { status: "error", message: "Antigravity usage is unsupported.", accountEmail: null, planLabel: null });
    },
  },
});
