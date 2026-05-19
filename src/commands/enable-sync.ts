import { installLaunchAgent, uninstallLaunchAgent } from "../launchd/install.ts";
import { info } from "../log.ts";

export async function enableSync(opts: { binPath: string }): Promise<string> {
  const path = await installLaunchAgent({ binPath: opts.binPath });
  info(`launchd sync agent installed at ${path}`);
  return path;
}

export async function disableSync(): Promise<boolean> {
  const removed = await uninstallLaunchAgent();
  info(removed ? "launchd sync agent removed" : "launchd sync agent was not installed");
  return removed;
}
