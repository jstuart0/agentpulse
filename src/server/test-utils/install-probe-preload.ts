/**
 * Test preload (bunfig.toml): the update check asks "what kind of install is this" by reading
 * ~/.agentpulse/install.json. Under test it answers from a fixed probe instead, so no test depends on (or
 * reads) a real home. Lives in test-utils/ because it uses a `...ForTests` seam.
 */
import { setInstallProbeForTests } from "../services/install-probe.js";

setInstallProbeForTests(() => ({ kind: "source", track: null }));
