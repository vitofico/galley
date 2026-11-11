/**
 * Binds the connector's HTTP surface to the deployment: the token and
 * connected-project records on the web service's data volume, the relay, and
 * the compile service. The connector only READS the data volume; what Auto
 * mode writes (checkpoints, the activity trail) goes to a volume of its own.
 */
import { listConnectedProjects, verifyConnectorToken } from "@galley/auth";
import {
  FsCapabilityRoomRegistry,
  FsConnectorActivityLog,
  FsConnectorCheckpoints,
  FsConnectorTokenStore,
  FsSessionStore,
  KeyedMutex,
} from "@galley/persistence";
import { createHttpCompileService } from "../compile-client.js";
import type { ConnectorAppDeps } from "./app.js";
import type { HostedConfig } from "./config.js";
import { createProjectRunner } from "./room.js";

export function buildConnectorDeps(config: HostedConfig): ConnectorAppDeps {
  const tokens = new FsConnectorTokenStore(config.dataDir);
  const registry = new FsCapabilityRoomRegistry(config.dataDir);
  const accounts = new FsSessionStore(config.dataDir);
  return {
    authenticate: async (token) => {
      try {
        const who = await verifyConnectorToken(tokens, token, Date.now());
        // ADR-0033 §3: a token for a closed account is refused.
        if (who === null || (await accounts.isUserClosed(who.userId)))
          return null;
        return who;
      } catch {
        return null; // an unreadable store denies; it never admits
      }
    },
    listProjects: (userId) =>
      listConnectedProjects(registry, userId, Date.now()),
    withProject: createProjectRunner(config.syncUrl),
    ...(config.compileUrl !== undefined
      ? { compileService: createHttpCompileService(config.compileUrl) }
      : {}),
    ...(config.stateDir !== undefined ? { auto: autoStore(config.stateDir) } : {}),
  };
}

function autoStore(stateDir: string): NonNullable<ConnectorAppDeps["auto"]> {
  const locks = new KeyedMutex();
  return {
    checkpoints: new FsConnectorCheckpoints(stateDir),
    activity: new FsConnectorActivityLog(stateDir),
    serialize: (room, op) => locks.run(room, op),
  };
}
