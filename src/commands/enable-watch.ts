import { installLaunchAgent, uninstallLaunchAgent } from "../launchd/install.ts";
import { info } from "../log.ts";

export async function enableWatch(opts: { binPath: string }): Promise<string> {
  const path = await installLaunchAgent({ binPath: opts.binPath });
  info(`launchd watch agent installed at ${path}`);
  return path;
}

export async function disableWatch(): Promise<boolean> {
  const removed = await uninstallLaunchAgent();
  info(removed ? "launchd watch agent removed" : "launchd watch agent was not installed");
  return removed;
}
