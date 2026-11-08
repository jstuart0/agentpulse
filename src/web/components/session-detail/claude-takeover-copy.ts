/**
 * What the dashboard says when a person continues an observed Claude Code session in a new one (AGEN-117,
 * the "Exact copy" of the plan): the entry card, the dialog, the machine list's reasons, and "Continued as".
 * Pure functions, so every sentence is tested without rendering. Display only: the server decides who may
 * continue which session, on which machine, and the host decides what applies to the new session.
 *
 * Loaded only by the card's lazy chunk. The words the session page itself needs (the prompt box, Stop, the
 * status line) are beside the code that shows them, so a person who never meets a fork doesn't pay for this.
 *
 * Two names are kept apart. `{Sname}` is the observed session's name, and `{Sid}` is its id, which appears
 * only inside the command that opens it in a terminal. The dialog commits to neither permission mode: the
 * host picks one from the login it finds, and the new session says which before anything is sent.
 */
import {
	askLoginPhrase,
	forkSentenceName,
	restrictedLoginPhrase,
} from "../../../shared/claude-fork-copy.js";
import {
	CLAUDE_FORK_MCP,
	FORK_MCP_CONTROL_LABEL,
	FORK_MCP_FRAGMENT,
	forkMcpControlHelp,
	forkMcpHostCannot,
} from "../../../shared/claude-fork-mcp.js";
import {
	CLAUDE_FORK_SUBAGENTS,
	SUBAGENTS_FRAGMENT,
	SUBAGENTS_OPTION_HELP,
	SUBAGENTS_OPTION_LABEL,
	subagentsUnavailableReason,
} from "../../../shared/claude-fork-subagents.js";
import { type ForkOptionsRequest, isResumableSessionId } from "../../../shared/session-resume.js";
import type { SupervisorRecord } from "../../../shared/types.js";

export const CLAUDE_CARD_ELIGIBLE =
	"Started outside AgentPulse. You can continue it here in a new session once it's closed.";
export const CLAUDE_QUIET_WAIT =
	"You can continue this in a new session once it's been quiet for 5 minutes.";
export const CLAUDE_NO_HOST_SOLO =
	"To continue this here, its machine needs the AgentPulse supervisor running.";
export const CLAUDE_NO_HOST_TEAM =
	"To continue this, you need a connected host of your own. An admin can use a shared one.";
export const CLAUDE_ENTRY_BUTTON = "Continue in a new session";
export const CLAUDE_BUSY_LABEL = "Starting…";
export const CLAUDE_PICK_MACHINE_FIRST = "Choose a machine first.";
export const CLAUDE_NOT_ADMIN = "Only an admin can continue a session with no owner.";

export function claudeStaleWorking(lastHeard: string): string {
	return `AgentPulse last heard from this session at ${lastHeard}. If it crashed, you can continue it in a new session about an hour after that.`;
}

export function claudeConfirmLabel(host: string | null): string {
	return host ? `Continue on ${host}` : "Continue";
}

export function claudeProgress(host: string | null, stillWaiting: boolean): string {
	const name = host?.trim() || "the host";
	return stillWaiting
		? `Still no answer from ${name}. This can take about a minute and a half. You can leave this page.`
		: `Starting Claude on ${name}…`;
}

/**
 * The command that opens the original in a terminal again, so a person can get back to it once a fork exists.
 * Null unless the id is a session id Claude Code can resume (a UUID): an id is never put into a command line
 * on trust, whatever sent it here.
 */
export function claudeResumeCommand(sourceId: string): string | null {
	return isResumableSessionId(sourceId) ? `claude --resume ${sourceId}` : null;
}

/** Said before the command, so it isn't a bare line of code to someone reading by ear or at a glance. */
export const CLAUDE_RESUME_COMMAND_LEAD = "To open the original in a terminal again, run:";

/** What the Copy button is called for a screen reader. */
export function claudeCopyCommandLabel(name: string | null): string {
	return `Copy the command that opens ${forkSentenceName(name, "the original session")} in a terminal`;
}

// ── The machines ────────────────────────────────────────────────────────────

export type ClaudeHostReason = "unsupported_os" | "needs_claude";

/** The brackets after a machine's name when it can't be chosen for a Claude session. */
export const CLAUDE_HOST_SUFFIX: Record<ClaudeHostReason, string> = {
	unsupported_os: "macOS only so far",
	needs_claude: "Claude Code not found or supervisor out of date",
};

/** Why a host can't continue a Claude session, judged from what it advertises; null when it can. */
export function claudeHostReason(
	host: Pick<SupervisorRecord, "platform" | "capabilities">,
	feature: string,
): ClaudeHostReason | null {
	if (host.platform !== "darwin") return "unsupported_os";
	return (host.capabilities?.features ?? []).includes(feature) ? null : "needs_claude";
}

// ── The dialog ──────────────────────────────────────────────────────────────

/** One checkbox in the dialog's options fieldset. AGEN-121 and AGEN-120 each added theirs. */
export interface ForkOptionControl {
	key: keyof ForkOptionsRequest;
	label: string;
	/** The description under the label, naming the machine once one is chosen. */
	help(machine: string | null): string;
	/** Said instead of the description when the chosen machine's supervisor lacks `hostFeature`. */
	hostCannot(host: string): string;
	/** The `/capabilities` feature that says this server accepts the option; the control is shown only when it is on. */
	capability: string;
	/** The supervisor feature the chosen machine must advertise; without it the control is disabled with a reason. */
	hostFeature: string;
}

/** The options a person can turn on. */
export const FORK_OPTION_CONTROLS: readonly ForkOptionControl[] = [
	{
		key: "mcp",
		label: FORK_MCP_CONTROL_LABEL,
		help: forkMcpControlHelp,
		hostCannot: forkMcpHostCannot,
		capability: "claudeForkMcp",
		hostFeature: CLAUDE_FORK_MCP,
	},
	{
		key: "subagents",
		label: SUBAGENTS_OPTION_LABEL,
		help: () => SUBAGENTS_OPTION_HELP,
		hostCannot: subagentsUnavailableReason,
		capability: "claudeForkSubagents",
		hostFeature: CLAUDE_FORK_SUBAGENTS,
	},
];
export interface ForkOptionControlState {
	shown: boolean;
	/** The checkbox can't be used on the chosen machine; its checked state is kept. */
	disabled: boolean;
	/** What is said under the label. */
	help: string;
}

/**
 * Whether a control is drawn and usable. It is drawn only when the server advertises it (an older server never
 * shows an option it would refuse). A chosen machine whose supervisor lacks the feature disables it and says why
 * in place of the description; with no machine chosen it is usable and the description says "the chosen machine".
 */
export function forkOptionControlState(
	control: ForkOptionControl,
	serverFeatures: ReadonlySet<string> | null,
	machine: string | null,
	hostFeatures: readonly string[] | null,
): ForkOptionControlState {
	const shown = serverFeatures?.has(control.capability) === true;
	const named = machine?.trim() ? machine.trim() : null;
	const hostCannot =
		named !== null && hostFeatures !== null && !hostFeatures.includes(control.hostFeature);
	return {
		shown,
		disabled: hostCannot,
		help: hostCannot ? control.hostCannot(named) : control.help(named),
	};
}

export const FORK_OPTIONS_LEGEND = "Options for this session (off by default)";
export const FORK_OPTIONS_CLOSING =
	"These stay as chosen for this session. To change them, continue again.";

// What the new session leaves out, in named fragments so a requested option takes its own away.
const NOT_IN_PROJECT_FILES = "your project's CLAUDE.md, hooks and MCP servers";
const NOT_IN_OWN_MCP = "your own MCP servers";
const NOT_IN_SUBAGENTS = SUBAGENTS_FRAGMENT;
const NOT_IN_REST = ["slash commands", "saving memories"];

/** "a, b and c": the same joining the sentence always used. */
function listOf(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The "Not in this session" sentence: only absences, so an option the person turned on is not listed. */
export function notInSessionLine(requested: ForkOptionsRequest = {}): string {
	const items = [
		NOT_IN_PROJECT_FILES,
		...(requested.mcp === true ? [] : [NOT_IN_OWN_MCP]),
		...(requested.subagents === true ? [] : [NOT_IN_SUBAGENTS]),
		...NOT_IN_REST,
	];
	return `${listOf(items)}.`;
}

/**
 * The paragraph about who can open what each tool call ran (AGEN-123): the stored input and output, kept for
 * 7 days, readable only by a signed-in person who may. `ownerLine` is how the owner reads in the dialog
 * ("you", a name); null in team mode means the session has no owner, which is an admin's.
 */
export function toolDetailLine(audience: "solo" | "team", ownerLine: string | null): string | null {
	switch (audience) {
		case "solo":
			return "You can open what each tool call ran, for 7 days.";
		case "team": {
			const who = ownerLine
				? `${ownerLine.charAt(0).toUpperCase()}${ownerLine.slice(1)} and admins`
				: "Admins";
			return `${who} can open what each tool call ran, for 7 days, when signed in. Others see only the tool's name and outcome.`;
		}
	}
}

export interface ClaudeDialogInput {
	/** The options the person has chosen in the dialog; none by default. */
	requested?: ForkOptionsRequest;
	sessionName: string;
	/** The chosen machine's name; null until one is chosen. */
	machine: string | null;
	cwd: string | null;
	/** Whom the new session will belong to, as the person will read it ("you", a name), or null in solo. */
	ownerName: string | null;
	/** An earlier fork of this session that has ended: its name. */
	endedFork: string | null;
}

export interface ClaudeDialogParagraph {
	/** A lead-in shown in bold. */
	label: string | null;
	text: string;
}

export interface ClaudeDialogLines {
	title: string;
	directory: string;
	ownerLine: string | null;
	paragraphs: readonly ClaudeDialogParagraph[];
}

const para = (text: string, label: string | null = null): ClaudeDialogParagraph => ({
	label,
	text,
});

/**
 * One text for both modes, because which one applies isn't known until the host has looked at its login.
 * It says what waits for the person, what depends on the login (both ways, neither chosen), and what the new
 * session leaves out. It never uses "enforced" and never says commands wait without saying which ones.
 */
export function claudeDialogLines(input: ClaudeDialogInput): ClaudeDialogLines {
	const machine = input.machine?.trim() || "the machine you choose";
	const name = forkSentenceName(input.sessionName, "this session");
	const paragraphs: ClaudeDialogParagraph[] = [
		para(
			`Close ${name} in your terminal first. AgentPulse checks and won't start if it sees it open.`,
		),
		para(
			"A new session starts here with the conversation so far, except what subagents read. After that the two conversations are separate, but both change the same files.",
		),
		para(
			"file changes, web fetches and commands, except ones Claude treats as read-only, like `ls` and `cat`.",
			"Waits for you:",
		),
		para(
			"The new session tells you which before you send anything.",
			`What else applies depends on how Claude Code logs in for the supervisor on ${machine}.`,
		),
		para(
			"your Claude settings aren't used. That includes your own CLAUDE.md and any hooks you rely on as safety checks.",
			`With ${restrictedLoginPhrase()}:`,
		),
		para(
			"your Claude settings still apply, so commands they allow, and anything a hook there answers, run without waiting for you.",
			`With ${askLoginPhrase()}:`,
		),
		...(input.requested?.mcp === true ? [para(FORK_MCP_FRAGMENT, "Fork MCP servers:")] : []),
		para(notInSessionLine(input.requested), "Not in this session:"),
		para(
			"Your terminal's conversation isn't changed. Don't open the new session in a terminal. Afterwards, `claude --continue` here can open the new session instead, so use the command this page gives you to get back.",
		),
		para(
			"API keys you've issued can send prompts to it too, unless it runs under your own Claude settings: then only a signed-in person can.",
		),
	];
	const detail = toolDetailLine(input.ownerName === null ? "solo" : "team", input.ownerName);
	if (detail !== null) paragraphs.push(para(detail, "Tool details:"));
	if (input.endedFork) {
		paragraphs.push(
			para(
				`This starts from your terminal's conversation. Nothing from ${forkSentenceName(input.endedFork, "the earlier session")} carries over.`,
			),
		);
	}
	return {
		title: `Continue ${name} in a new session?`,
		directory: `Directory: ${input.cwd?.trim() || "not reported"}`,
		ownerLine: input.ownerName
			? `The new session will belong to ${forkSentenceName(input.ownerName, "someone")}. This one stays as it is.`
			: null,
		paragraphs,
	};
}

// ── "Continued as" ──────────────────────────────────────────────────────────

/** The line on the observed session while its fork is live. */
export function claudeContinuedAs(name: string | null): string {
	return `Continued as ${forkSentenceName(name, "a new session")}`;
}
