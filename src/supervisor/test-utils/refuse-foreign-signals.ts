// Loaded before every test file (bunfig.toml [test] preload). From here on, the stop ladder's two default
// killers cannot signal a process a test did not start (D10):
//  - a `descendantReach` with no `killPid` of its own is refused every pid (a test that needs real
//    descendant kills installs a signal guard);
//  - a `groupReach` with no `killGroup` of its own signals a group only if it is led by a direct child of
//    this test process, or (leader gone, a grandchild outliving it) was handed to `groupReach` as a child
//    handle, so the Codex shutdown tests, which start their own detached children, keep working, and a
//    mutation that points the kill elsewhere (pid 1, the parent, another user's process) is refused.
// If the seams are missing the preload throws: a silent no-op here would leave every test unprotected.
import * as stop from "../process-stop.js";
import { installPreloadKillers } from "./signal-guard.js";

if (
	typeof stop.__setDescendantKillerForTests !== "function" ||
	typeof stop.__setGroupKillerForTests !== "function"
) {
	throw new Error(
		"process-stop.ts no longer exports its test seams, so the supervisor tests can't be kept from signalling processes they did not start. Restore __setDescendantKillerForTests and __setGroupKillerForTests.",
	);
}

installPreloadKillers();
