# The OpenCode step of the shell installers (AGEN-141). This file is a template:
# `bun run embed:opencode-plugin` fills the @@AP_OC_*@@ lines from
# src/shared/opencode-plugin.ts and writes the result into setup-hooks.sh and
# setup-relay.sh (between their markers) and into the /setup.sh template.
# The host installer provides ap_opencode_plugin_1_template and
# ap_opencode_plugin_2_template (print the plugin text with its two holes), and
# ap_write_no_follow / ap_write_private_no_follow / ap_validate_hook_base_url.
# It never runs `opencode`.
# In the all-gated layout the force option is remembered in ~/.agentpulse/opencode-force; only the
# no-opencode option clears it (and it removes the plugins too). Outside that layout nothing is remembered.
@@AP_OC_DATA@@

@@AP_OC_GATE@@

# ap_oc_fill <text> <hole> <value>: <text> with every <hole> replaced by <value>, without any pattern or "&" meaning.
ap_oc_fill() {
	local t="$1" h="$2" v="$3" out=""
	while [[ "$t" == *"$h"* ]]; do
		out="$out${t%%"$h"*}$v"
		t="${t#*"$h"}"
	done
	printf '%s' "$out$t"
}

ap_oc_first_line_is_ours() {
	local first=""
	[ -f "$1" ] || return 1
	IFS= read -r first < "$1" || true
	case "$first" in "$AP_OC_HEADER_PREFIX"*) return 0 ;; esac
	return 1
}

ap_oc_config_dir() {
	if [ -n "${OPENCODE_CONFIG_DIR:-}" ] && [ "${OPENCODE_CONFIG_DIR#/}" != "$OPENCODE_CONFIG_DIR" ]; then
		printf '%s' "${OPENCODE_CONFIG_DIR%/}"
	elif [ -n "${XDG_CONFIG_HOME:-}" ] && [ "${XDG_CONFIG_HOME#/}" != "$XDG_CONFIG_HOME" ]; then
		printf '%s' "${XDG_CONFIG_HOME%/}/opencode"
	else
		printf '%s' "$HOME/.config/opencode"
	fi
}

ap_oc_data_dir() {
	if [ -n "${XDG_DATA_HOME:-}" ] && [ "${XDG_DATA_HOME#/}" != "$XDG_DATA_HOME" ]; then
		printf '%s' "${XDG_DATA_HOME%/}/opencode"
	else
		printf '%s' "$HOME/.local/share/opencode"
	fi
}

# ap_oc_detected: OpenCode is here when `opencode` is on PATH or its config or data folder exists. Nothing is run.
ap_oc_detected() {
	local cfg data
	cfg="$(ap_oc_config_dir)"
	data="$(ap_oc_data_dir)"
	command -v opencode >/dev/null 2>&1 || [ -e "$cfg" ] || [ -L "$cfg" ] || [ -e "$data" ]
}

ap_oc_backup() {
	local path="$1" to
	to="$HOME/.agentpulse/backups/opencode/$(basename -- "$path").$(date -u +%Y%m%dT%H%M%SZ)"
	( umask 077 && mkdir -p "$HOME/.agentpulse/backups/opencode" ) || return 1
	mv -- "$path" "$to" || return 1
	echo "  ✓ Moved $path to $to"
}

# ap_oc_remove_ours <plugins dir> <entry> <file> : removes the entry only when line 1 of its file is our header.
ap_oc_remove_ours() {
	local plugins="$1" entry="$2" file="$3" top n extra=0
	top="$plugins/$entry"
	if [ "$entry" = "$file" ]; then
		if [ -f "$top" ] && [ ! -L "$top" ] && ap_oc_first_line_is_ours "$top"; then
			rm -f -- "$top"
			echo "  ✓ Removed OpenCode plugin $top"
		fi
		return 0
	fi
	[ -d "$top" ] && [ ! -L "$top" ] || return 0
	ap_oc_first_line_is_ours "$top/index.js" || return 0
	for n in "$top"/* "$top"/.[!.]* "$top"/..?*; do
		[ -e "$n" ] || [ -L "$n" ] || continue
		[ "${n##*/}" = "index.js" ] || extra=1
	done
	if [ "$extra" = 0 ]; then
		rm -f -- "$top/index.js"
		rmdir -- "$top"
		echo "  ✓ Removed OpenCode plugin $top"
	else
		ap_oc_backup "$top"
	fi
}

# ap_oc_write_entry <plugins dir> <entry> <file> <line 1|2> <base> <direct>: writes (or leaves unchanged) one entry.
ap_oc_write_entry() {
	local plugins="$1" entry="$2" file="$3" line="$4" base="$5" direct="$6" text abs top cur
	text="$(ap_opencode_plugin_${line}_template)"
	text="$(ap_oc_fill "$text" '@@AP_OPENCODE_BASE_URL@@' "$base")"
	text="$(ap_oc_fill "$text" '@@AP_OPENCODE_DIRECT@@' "$direct")"
	case "$text" in
		"$AP_OC_HEADER_PREFIX"*) ;;
		*) echo "  ✗ OpenCode: this copy of the installer doesn't carry the plugin text, so nothing was written. Use the installer your AgentPulse server serves." >&2; return 1 ;;
	esac
	# $(...) took the trailing line break off; the file ends with exactly one, as buildOpenCodePluginFiles' text does.
	text="$text"$'\n'
	abs="$plugins/$file"
	top="$plugins/$entry"
	if [ "$entry" != "$file" ] && [ -e "$top" ] && [ ! -d "$top" ]; then
		ap_oc_backup "$top" || return 1
	fi
	mkdir -p -- "$(dirname -- "$abs")"
	if [ -f "$abs" ] && [ ! -L "$abs" ]; then
		cur="$(cat -- "$abs"; printf x)"
		if [ "$cur" = "${text}x" ]; then
			echo "  ✓ OpenCode plugin unchanged: $abs"
			return 0
		fi
		if ! ap_oc_first_line_is_ours "$abs"; then ap_oc_backup "$abs" || return 1; fi
	fi
	printf '%s' "$text" | ap_write_no_follow "$abs" || return 1
	echo "  ✓ OpenCode plugin → $abs"
}

# ap_opencode_install <base url> <direct 0|1> <force 0|1> <no-opencode 0|1>
# Returns 1 only when it refused because something it would touch is a symlink.
ap_opencode_install() {
	local base="$1" direct="$2" force="$3" noop="$4"
	local cfg plugins marker="$HOME/.agentpulse/opencode-force" sdk=0 foreign=0 remembered=0 rule=0 open=0 touched=0 from_env=0
	local e_name e_file e_line e_gated e_kind p
	cfg="$(ap_oc_config_dir)"
	plugins="$cfg/plugins"
	from_env=0
	if [ -n "${OPENCODE_CONFIG_DIR:-}" ] && [ "${OPENCODE_CONFIG_DIR#/}" != "$OPENCODE_CONFIG_DIR" ]; then from_env=1; fi
	if [ "$noop" != 1 ] && ! ap_oc_detected; then
		echo "  - OpenCode not detected (no \`opencode\` on PATH, no config or data folder); nothing written."
		return 0
	fi
	if [ "$noop" != 1 ]; then
		ap_validate_hook_base_url "$base" || return 1
		case "$base" in *'"'*|*'\'*|*'@@'*|*$'\n'*|*$'\r'*) echo "invalid AgentPulse base URL for the OpenCode plugin" >&2; return 1 ;; esac
	fi
	# Links first: nothing below writes or removes anything unless none of these is a link.
	while IFS='|' read -r e_name e_file e_line e_gated e_kind; do
		if [ "$e_kind" = dir ] && [ -L "$plugins/$e_name" ]; then
			echo "  ✗ OpenCode: refusing to touch $plugins/$e_name: it is a symlink. Nothing was written or removed." >&2
			return 1
		fi
	done <<< "$AP_OC_ENTRIES"
	for p in "$cfg" "$plugins"; do
		if [ -L "$p" ]; then
			echo "  ✗ OpenCode: refusing to touch $p: it is a symlink. Nothing was written or removed." >&2
			return 1
		fi
	done
	if [ "$noop" = 1 ]; then
		while IFS='|' read -r e_name e_file e_line e_gated e_kind; do
				ap_oc_remove_ours "$plugins" "$e_name" "$e_file"
		done <<< "$AP_OC_ENTRIES"
@@AP_OC_NOOP_MARKER@@
		echo "  - OpenCode plugins removed (no-opencode)."
		return 0
	fi
	# What setup looks at, read-only; links are followed on purpose.
	if [ -f "$cfg/$AP_OC_SDK_MARKER" ]; then
		sdk=1
		if [ "$AP_OC_SDK_CHECK" != marker_only ]; then
			if [ -f "$cfg/package.json" ] && grep -qF -- "$AP_OC_SDK_CONFIG_DEP" "$cfg/package.json" 2>/dev/null; then :; else sdk=0; fi
		fi
	fi
	ap_oc_foreign_plugin_present "$plugins" && foreign=1
@@AP_OC_REMEMBERED@@
	[ "$force" = 1 ] || force=0
	ap_oc_gate_open "$sdk" "$foreign" 0 0 && rule=1
	ap_oc_gate_open "$sdk" "$foreign" "$force" "$remembered" && open=1
	while IFS='|' read -r e_name e_file e_line e_gated e_kind; do
		[ -n "$e_name" ] || continue
		if [ "$e_gated" = 1 ] && [ "$open" = 0 ]; then
			ap_oc_remove_ours "$plugins" "$e_name" "$e_file"
		else
			ap_oc_write_entry "$plugins" "$e_name" "$e_file" "$e_line" "$base" "$direct" || return 1
			touched=1
		fi
	done <<< "$AP_OC_ENTRIES"
@@AP_OC_WRITE_MARKER@@
	if [ "$from_env" = 1 ]; then echo "  - OPENCODE_CONFIG_DIR is set; installing into $cfg/plugins."; fi
	if [ "$open" = 0 ]; then
		echo "  $(ap_oc_fill "$AP_OC_MSG_SKIP" '<dir>' "$cfg")"
	elif [ "$force" = 1 ] && [ "$rule" = 0 ]; then
		echo "  $(ap_oc_fill "$AP_OC_MSG_FORCE" '<dir>' "$cfg")"
	fi
	if [ "$touched" = 1 ]; then
		echo "  $AP_OC_NOTE_SERVER_FIRST"
		echo "  $AP_OC_NOTE_SERVICE_SKIP"
	fi
	return 0
}
