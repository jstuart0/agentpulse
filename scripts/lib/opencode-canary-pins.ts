/**
 * The two OpenCode builds a canary may run (AGEN-141, phase 0). A binary runs only when it is an absolute path
 * whose sha256 equals a pin here: the version string alone is not enough (a different build can print the same
 * one). Both were measured on macOS arm64 on 2026-11-09.
 *
 *  - 1.19.5: the platform package `opencode-darwin-arm64` that `npm i opencode-ai@1.19.5` fetches (the file
 *    `bin/opencode`; `opencode-ai/bin/opencode.exe` is a hard link to it).
 *  - 2.2.6: the `opencode` file inside the darwin-arm64 zip of the GitHub release v2.2.6. The zip's own sha256
 *    (`zipSha256`) matches the release's published SHA256SUMS; the binary's is what a run checks.
 */

export type OpenCodeLine = "v1" | "v2";

export interface OpenCodePin {
	line: OpenCodeLine;
	version: string;
	/** Matches the whole trimmed `--version` output. */
	versionOutput: RegExp;
	sha256: string;
	zipSha256?: string;
}

export const OPENCODE_PINS: Record<OpenCodeLine, OpenCodePin> = {
	v1: {
		line: "v1",
		version: "1.19.5",
		versionOutput: /^1\.19\.5$/,
		sha256: "feaafead8cd563af0c2dcb386b0757e4355e327ebb6bd1aaad5440fe2f83596c",
	},
	v2: {
		line: "v2",
		version: "2.2.6",
		versionOutput: /^opencode v2\.2\.6$/,
		sha256: "90e4d03597b03d2051b65b4d793467764e55bacd8e22bf4824479c7233ea0e15",
		zipSha256: "15491608f6b0bc4debe5eac35eab629a2b07ea9a1fbac68ad53bcea59fcc4b45",
	},
};
