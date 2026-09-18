import { ProductionPaseoGateway } from "../src/paseo/gateway.js";

const homeFlag = process.argv.indexOf("--home");
const home = homeFlag === -1 ? undefined : process.argv[homeFlag + 1];
if (!home) throw new Error("Usage: npm run smoke:daemon -- --home <isolated-paseo-home>");

const gateway = new ProductionPaseoGateway({ home });
await gateway.connect();
try {
  const observation = await gateway.observeDirectory(() => undefined);
  try {
    const snapshot = await gateway.getDirectorySnapshot();
    if (
      !Array.isArray(snapshot.projects) ||
      !Array.isArray(snapshot.workspaces) ||
      !Array.isArray(snapshot.agents) ||
      !Array.isArray(snapshot.providers)
    ) {
      throw new Error("The daemon returned an invalid directory snapshot.");
    }
    console.log("Connected to an isolated Paseo daemon and observed its directory.");
  } finally {
    await observation.release();
  }
} finally {
  await gateway.close();
}
