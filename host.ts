import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { readAntigravityUsage } from "./antigravity-usage.js";
import { hostUsageState, usageHostContract } from "./usage-host-contract.js";

export default experimental_defineHostEntry({
  contract: usageHostContract,
  handlers: {
    async "usage.readAntigravity"() {
      const result = await readAntigravityUsage();
      return hostUsageState.parse(result.supported
        ? result.usage
        : { status: "error", message: "Antigravity usage is unsupported.", accountEmail: null, planLabel: null });
    },
  },
});
