/**
 * `el` support for programs that are not the terminal's own code: validating
 * an `el` subtree handed over by a tool or extension, confining its stylesheet
 * to that subtree, and reading it back as plain text for terminals that draw
 * no `el` (the Tern SDK, `elements/el.md` and `protocol/theme.md`, is the
 * spec).
 *
 * Why confine the sheet: the terminal applies a program sheet to the whole
 * surface, and omp's transcript, composer and approval prompts are all in
 * that surface. A tool's `.sf-card { display: none }` would reach them. Every
 * rule is therefore prefixed with a class that only the owning subtree wears.
 */
import {
	TSP_EL_TAGS,
	TSP_MAX_DEPTH,
	TSP_MAX_SURFACE_CSS_BYTES,
	TSP_MAX_SURFACE_NODES,
	type TspCommonProps,
	type TspElAttr,
	type TspElTag,
} from "@oh-my-pi/pi-wire";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { node } from "./describe";
import type { NativeChild, NativeNode } from "./node";

/** Most nodes one tool view may carry: a hundredth of the surface's {@link TSP_MAX_SURFACE_NODES}, which the whole transcript shares. */
export const EL_MAX_VIEW_NODES = TSP_MAX_SURFACE_NODES / 100;
/**
 * Deepest nesting inside one tool view. The surface allows {@link TSP_MAX_DEPTH}
 * levels in all; half of them, less the handful the transcript's own nesting takes above a tool body.
 */
export const EL_MAX_VIEW_DEPTH = TSP_MAX_DEPTH / 2 - 8;
/** Largest stylesheet one tool view may carry: a quarter of the surface's {@link TSP_MAX_SURFACE_CSS_BYTES}, which all its sheets share. */
export const EL_MAX_SHEET_BYTES = TSP_MAX_SURFACE_CSS_BYTES / 4;
/** Longest action name, class list, attribute value and form field name kept. */
const MAX_TOKEN_CHARS = 256;
/** Most entries kept in an `attrs` table or a `menu`. */
const MAX_LIST_ENTRIES = 32;

const EL_TAGS: readonly string[] = TSP_EL_TAGS;
/** Tags that draw no children (their children are ignored by the terminal). */
const LEAF_TAGS: Record<string, true> = { input: true, hr: true };
const ATTR_NAME = /^(?:data-[a-z0-9_-]+|aria-[a-z0-9_-]+|role|colspan|rowspan)$/;
/** Tern owns these; an attribute of the same name is ignored by the terminal. */
const OWNED_ATTRS: Record<string, true> = {
	"data-id": true,
	"data-role": true,
	"data-tone": true,
	"data-mark": true,
	"data-href": true,
	"data-scope": true,
	"aria-label": true,
	"aria-checked": true,
};
const TONES: Record<string, true> = {
	neutral: true,
	accent: true,
	info: true,
	success: true,
	warning: true,
	error: true,
	pending: true,
	muted: true,
	user: true,
};
/** Common props an `el` accepts besides its own. */
const COMMON_KEYS = [
	"role",
	"key",
	"tone",
	"hidden",
	"grow",
	"shrink",
	"basis",
	"min",
	"max",
	"title",
	"aria",
	"href",
	"mark",
] as const;

/** Whether `child` is a described node rather than a component that describes itself. */
function isNativeNode(child: NativeChild): child is NativeNode {
	return !("render" in child && typeof child.render === "function");
}

/**
 * Whether any described node under `children` is an `el`, the node the tool-view
 * sanitizer handles. Components are opaque. Iterative and bounded: a view too
 * big to scan counts as holding one, so the sanitizer (which prunes) runs on it.
 */
export function containsEl(children: readonly NativeChild[] | undefined): boolean {
	if (!children) return false;
	const pending: (readonly NativeChild[])[] = [children];
	let visited = 0;
	while (pending.length > 0) {
		for (const child of pending.pop()!) {
			if (!isNativeNode(child)) continue;
			if (child.k === "el") return true;
			if (++visited > EL_MAX_VIEW_NODES * 4) return true;
			if (child.c) pending.push(child.c);
		}
	}
	return false;
}

interface Budget {
	nodes: number;
	problems: Set<string>;
}

function sanitizeAttrs(attrs: unknown, budget: Budget): Record<string, TspElAttr> | undefined {
	if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) return undefined;
	const out: Record<string, TspElAttr> = {};
	let count = 0;
	for (const [name, value] of Object.entries(attrs)) {
		if (!ATTR_NAME.test(name) || Object.hasOwn(OWNED_ATTRS, name)) {
			budget.problems.add(`attribute ${name} is not allowed`);
			continue;
		}
		if (typeof value === "string") {
			if (value.length > MAX_TOKEN_CHARS) continue;
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) continue;
		} else if (typeof value !== "boolean") continue;
		if (++count > MAX_LIST_ENTRIES) {
			budget.problems.add("too many attributes");
			break;
		}
		out[name] = value;
	}
	return count > 0 ? out : undefined;
}

/** An action name the terminal can send back: a non-empty string of bounded length. */
function isActionName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_CHARS;
}

/**
 * The actions Tern performs itself (a fold, a copy, opening the node's `href`,
 * the image viewer) and never reports back to the program.
 */
const TERN_ACTIONS: Record<string, true> = { toggle: true, copy: true, open: true, zoom: true };

/**
 * Prefix an `el` action gets on the wire when its name is one of
 * {@link TERN_ACTIONS} and Tern's own behavior is not what the view asks for.
 * {@link elActionName} takes it off again where the event is delivered.
 */
const ACTION_ALIAS = "omp-reserved-";

/**
 * The name an `el` action is sent under. A name Tern acts on itself would
 * never come back, so it gets {@link ACTION_ALIAS}: a view's `open` button is
 * the view's own. `open` and `copy` on a node with an `href` stay as written —
 * that pairing is Tern's built-in (open or copy the link), and omp's own
 * chrome relies on it. `name=value` actions are judged by the part before `=`.
 */
function wireAction(action: string, hasHref: boolean, budget: Budget): string | undefined {
	if (action.startsWith(ACTION_ALIAS)) {
		budget.problems.add(`action ${action} uses the reserved prefix ${ACTION_ALIAS}`);
		return undefined;
	}
	const eq = action.indexOf("=");
	const name = eq < 0 ? action : action.slice(0, eq);
	if (!Object.hasOwn(TERN_ACTIONS, name)) return action;
	if (hasHref && (name === "open" || name === "copy")) return action;
	return `${ACTION_ALIAS}${action}`;
}

/** The action name a tool's `el` wrote, from the one the terminal reported (undoes {@link wireAction}). */
export function elActionName(wire: string): string {
	return wire.startsWith(ACTION_ALIAS) ? wire.slice(ACTION_ALIAS.length) : wire;
}

function sanitizeActions(actions: unknown, hasHref: boolean, budget: Budget): TspCommonProps["actions"] {
	if (typeof actions !== "object" || actions === null || Array.isArray(actions)) return undefined;
	const one = (value: unknown): string | undefined =>
		isActionName(value) ? wireAction(value, hasHref, budget) : undefined;
	const click = "click" in actions ? one(actions.click) : undefined;
	const dblclick = "dblclick" in actions ? one(actions.dblclick) : undefined;
	const menu =
		"menu" in actions && Array.isArray(actions.menu)
			? actions.menu
					.filter(isActionName)
					.slice(0, MAX_LIST_ENTRIES)
					.map(one)
					.filter(name => name !== undefined)
			: [];
	if (click === undefined && dblclick === undefined && menu.length === 0) return undefined;
	return {
		...(click === undefined ? {} : { click }),
		...(dblclick === undefined ? {} : { dblclick }),
		...(menu.length === 0 ? {} : { menu }),
	};
}

/** The `class` prop minus the terminal's own (`sf`, `sf-*`) classes. */
function sanitizeClass(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const kept = value
		.split(/\s+/)
		.filter(name => name.length > 0 && name !== "sf" && !name.startsWith("sf-"))
		.join(" ");
	return kept.length > 0 && kept.length <= MAX_TOKEN_CHARS * 4 ? kept : undefined;
}

/** Keep the props an `el` of `tag` honors; drop everything else. */
function sanitizeElProps(
	tag: TspElTag,
	raw: Record<string, unknown>,
	budget: Budget,
): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = { tag };
	const className = sanitizeClass(raw.class);
	if (className !== undefined) out.class = className;
	const attrs = sanitizeAttrs(raw.attrs, budget);
	if (attrs !== undefined) out.attrs = attrs;
	if (typeof raw.text === "string" && tag !== "hr") out.text = raw.text;
	if (tag === "input") {
		if (raw.type !== "checkbox" && raw.type !== "radio") {
			budget.problems.add("input needs type checkbox or radio");
			return undefined;
		}
		out.type = raw.type;
		if (typeof raw.name === "string" && raw.name.length <= MAX_TOKEN_CHARS) out.name = raw.name;
		if (typeof raw.value === "string" && raw.value.length <= MAX_TOKEN_CHARS) out.value = raw.value;
		if (typeof raw.checked === "boolean") out.checked = raw.checked;
		if (typeof raw.disabled === "boolean") out.disabled = raw.disabled;
	}
	copyCommonProps(raw, out, COMMON_KEYS);
	const actions = sanitizeActions(raw.actions, typeof out.href === "string", budget);
	if (actions !== undefined) out.actions = actions;
	return out;
}

/** Copy the common props named in `keys` that `raw` holds in a form the terminal accepts. */
function copyCommonProps(
	raw: Record<string, unknown>,
	out: Record<string, unknown>,
	keys: readonly (typeof COMMON_KEYS)[number][],
): void {
	for (const key of keys) {
		const value = raw[key];
		if (value === undefined) continue;
		switch (key) {
			case "tone":
				if (typeof value === "string" && Object.hasOwn(TONES, value)) out.tone = value;
				break;
			case "hidden":
				if (typeof value === "boolean") out.hidden = value;
				break;
			case "grow":
			case "shrink":
				if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
				break;
			case "basis":
				if (value === "auto" || value === "content" || (typeof value === "number" && Number.isFinite(value)))
					out.basis = value;
				break;
			case "min":
			case "max":
				if (typeof value === "object" && value !== null) out[key] = value;
				break;
			default:
				if (typeof value === "string" && value.length <= 2048) out[key] = value;
		}
	}
}

function sanitizeChild(child: NativeChild, depth: number, budget: Budget): NativeChild | undefined {
	// A component describes itself; only described nodes are untrusted data.
	if (!isNativeNode(child)) return child;
	if (depth > EL_MAX_VIEW_DEPTH) {
		budget.problems.add(`nesting deeper than ${EL_MAX_VIEW_DEPTH}`);
		return undefined;
	}
	// One budget for every described node of the view, whatever its kind.
	if (budget.nodes >= EL_MAX_VIEW_NODES) {
		budget.problems.add(`more than ${EL_MAX_VIEW_NODES} nodes`);
		return undefined;
	}
	budget.nodes++;
	// An empty key would give the node the id of its component's root.
	const key = typeof child.key === "string" && child.key !== "" ? child.key : undefined;
	if (child.k !== "el") {
		const { key: _key, c, ...rest } = child;
		const kept = { ...rest, ...(key === undefined ? {} : { key }) } as NativeNode;
		return c === undefined ? kept : ({ ...kept, c: sanitizeChildren(c, depth + 1, budget) } as NativeNode);
	}
	const raw = (child.p ?? {}) as Record<string, unknown>;
	let tag: TspElTag = "div";
	if (raw.tag !== undefined) {
		if (typeof raw.tag === "string" && EL_TAGS.includes(raw.tag)) tag = raw.tag as TspElTag;
		else budget.problems.add(`tag ${String(raw.tag)} is not allowed`);
	}
	const props = sanitizeElProps(tag, raw, budget);
	if (props === undefined) return undefined;
	const children = Object.hasOwn(LEAF_TAGS, tag) ? undefined : sanitizeChildren(child.c, depth + 1, budget);
	let sheet: string | undefined;
	if (typeof child.sheet === "string") {
		if (Buffer.byteLength(child.sheet) <= EL_MAX_SHEET_BYTES) sheet = child.sheet;
		else budget.problems.add(`stylesheet larger than ${EL_MAX_SHEET_BYTES} bytes`);
	}
	const out: { k: "el"; p: Record<string, unknown>; c?: readonly NativeChild[]; key?: string; sheet?: string } = {
		k: "el",
		p: props,
	};
	if (children !== undefined && children.length > 0) out.c = children;
	if (key !== undefined) out.key = key;
	if (sheet !== undefined) out.sheet = sheet;
	return out as NativeNode;
}

function sanitizeChildren(children: readonly NativeChild[] | undefined, depth: number, budget: Budget): NativeChild[] {
	const out: NativeChild[] = [];
	if (!children) return out;
	for (const child of children) {
		const kept = sanitizeChild(child, depth, budget);
		if (kept !== undefined) out.push(kept);
	}
	return out;
}

/**
 * `children` with every `el` node reduced to what the terminal accepts: tags
 * from the allowlist (another tag draws as a `div`), `attrs` from the
 * attribute allowlist, the terminal's own classes removed, `input` only as a
 * checkbox or radio, no children under `input`/`hr`, and the view held to
 * {@link EL_MAX_VIEW_NODES} nodes, {@link EL_MAX_VIEW_DEPTH} levels and
 * {@link EL_MAX_SHEET_BYTES} of CSS per sheet. What exceeds a cap is dropped,
 * never truncated mid-node. Returns `children` itself when it holds no `el`.
 */
export function sanitizeElChildren(children: readonly NativeChild[], context: string): readonly NativeChild[] {
	if (!containsEl(children)) return children;
	const budget: Budget = { nodes: 0, problems: new Set() };
	const out = sanitizeChildren(children, 0, budget);
	if (budget.problems.size > 0) logger.warn("TSP: el view adjusted", { context, problems: [...budget.problems] });
	return out;
}

// ── Stylesheet confinement ───────────────────────────────────────────────

/** Name of the sheet (and its confining class) for stylesheet text: the same text always names the same sheet. */
export function styleScopeName(css: string): string {
	return `omp-${Bun.hash(css).toString(36)}`;
}

/** The class of the element the tool's selectors are rooted at (`:root`, `html`, `body` name it). */
export function styleRootClass(name: string): string {
	return `${name}-in`;
}

/**
 * The rules only omp writes, for the outer wrapper `.name`: the tool's own CSS
 * can't select it, so a card that overflows (a huge box, a negative offset)
 * is clipped to its wrapper and can't paint or catch pointer events outside it.
 */
function trustedRules(name: string): string {
	return `.${name}{position:relative;overflow:clip;isolation:isolate;clip-path:inset(0)}`;
}

/** The CSS Tern receives for a view sheet: omp's containment rules, then the tool's rules confined below the root element (none when the sheet is unusable). */
export function viewSheetCss(css: string, name: string): string {
	return trustedRules(name) + scopeStyleSheet(css, styleRootClass(name));
}

/**
 * A view's body inside the two wrappers its `sheet` needs: the outer `div`
 * (keyed `key`, carrying the sheet and the containment) and the inner `div`
 * (keyed `root`, the element `:root` names). Event keys of the body start with
 * `${key}/root/`.
 */
export function scopedView(body: readonly NativeChild[], sheet: string, key: string): NativeNode {
	const inner = node("el", { tag: "div", class: styleRootClass(styleScopeName(sheet)) }, body, "root");
	return { ...node("el", { tag: "div" }, [inner], key), sheet } as NativeNode;
}

class SheetAnomaly extends Error {}

function anomaly(message: string): never {
	throw new SheetAnomaly(message);
}

/** Index just past the comment or string starting at `i`, or `i` when none starts there. A raw newline ends a string unterminated (CSS Syntax "bad string"). */
function skipLiteral(css: string, i: number): number {
	const c = css[i];
	if (c === "/" && css[i + 1] === "*") {
		const end = css.indexOf("*/", i + 2);
		if (end === -1) anomaly("unterminated comment");
		return end + 2;
	}
	if (c === '"' || c === "'") {
		for (let j = i + 1; j < css.length;) {
			const d = css[j];
			if (d === "\\") j += 2;
			else if (d === c) return j + 1;
			else if (d === "\n" || d === "\r" || d === "\f") anomaly("raw newline in a string");
			else j++;
		}
		anomaly("unterminated string");
	}
	return i;
}

/** Reject text whose reading could differ from Tern's: escapes, `url()`, unbalanced braces, bad strings. */
function validateSheet(css: string): void {
	if (/url\(/i.test(css)) anomaly("url()");
	let depth = 0;
	for (let i = 0; i < css.length;) {
		const skipped = skipLiteral(css, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		const c = css[i];
		if (c === "\\") anomaly("escape outside a string");
		if (c === "{") depth++;
		else if (c === "}" && --depth < 0) anomaly("unbalanced }");
		i++;
	}
	if (depth !== 0) anomaly("unbalanced {");
}

/** Index of the `}` matching the `{` before `from` (the sheet is validated, so it exists). */
function matchingBrace(css: string, from: number): number {
	let depth = 1;
	for (let i = from; i < css.length;) {
		const skipped = skipLiteral(css, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		const c = css[i];
		if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i;
		i++;
	}
	return -1;
}

/** Whether a declaration block holds a `{` (a nested rule), outside strings and comments. */
function hasNestedBlock(body: string): boolean {
	for (let i = 0; i < body.length;) {
		const skipped = skipLiteral(body, i);
		if (skipped !== i) i = skipped;
		else if (body[i] === "{") return true;
		else i++;
	}
	return false;
}

/** `selector` split at top-level commas (not inside parentheses, brackets or strings). */
function splitSelectors(selector: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < selector.length;) {
		const skipped = skipLiteral(selector, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		const c = selector[i];
		if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
		else if (c === "," && depth === 0) {
			parts.push(selector.slice(start, i));
			start = i + 1;
		}
		i++;
	}
	parts.push(selector.slice(start));
	return parts;
}

const ROOT_SELECTOR = /^(?::root|html|body)(?![\w-])/;

/** The first combinator after a root compound: `>`, `+`, `~`, a space (descendant) or "" when none follows. */
function firstCombinator(rest: string): string {
	let depth = 0;
	for (let i = 0; i < rest.length;) {
		const skipped = skipLiteral(rest, i);
		if (skipped !== i) {
			i = skipped;
			continue;
		}
		const c = rest[i]!;
		if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
		else if (depth === 0) {
			if (c === ">" || c === "+" || c === "~") return c;
			if (/\s/.test(c)) {
				let j = i;
				while (j < rest.length && /\s/.test(rest[j]!)) j++;
				const next = rest[j];
				return next === ">" || next === "+" || next === "~" ? next : j < rest.length ? " " : "";
			}
		}
		i++;
	}
	return "";
}

/**
 * One selector confined to `.scope` and its descendants, or undefined when it
 * could select anything else. `:root`/`html`/`body` at the start name the scope
 * element itself; what follows may only continue it or descend from it, never
 * leave it through a sibling combinator.
 */
function scopeSelector(selector: string, scope: string): string | undefined {
	const trimmed = selector.trim();
	if (trimmed === "" || trimmed.includes("&")) return undefined;
	if (trimmed[0] === ">" || trimmed[0] === "+" || trimmed[0] === "~") return undefined;
	const root = ROOT_SELECTOR.exec(trimmed);
	if (root) {
		const rest = trimmed.slice(root[0].length);
		const combinator = firstCombinator(rest);
		if (combinator === "+" || combinator === "~") return undefined;
		return `.${scope}${rest}`;
	}
	return `.${scope} ${trimmed}`;
}

function scopeBlock(css: string, scope: string, depth: number): string {
	let out = "";
	let i = 0;
	while (i < css.length) {
		const skipped = skipLiteral(css, i);
		// Top-level comments and whitespace carry nothing.
		if (skipped !== i || /\s/.test(css[i]!)) {
			i = skipped !== i ? skipped : i + 1;
			continue;
		}
		let j = i;
		while (j < css.length && css[j] !== "{" && css[j] !== ";") {
			const lit = skipLiteral(css, j);
			j = lit !== j ? lit : j + 1;
		}
		if (j >= css.length) break;
		const prelude = css.slice(i, j).trim();
		if (css[j] === ";") {
			// Statement at-rules (`@import`, `@charset`) have no place in a confined sheet.
			i = j + 1;
			continue;
		}
		const close = matchingBrace(css, j + 1);
		if (close === -1) anomaly("unbalanced {");
		const body = css.slice(j + 1, close);
		i = close + 1;
		if (prelude.startsWith("@")) {
			const name = /^@(-webkit-)?([a-z-]+)/i.exec(prelude)?.[2]?.toLowerCase();
			if (name === "media" && depth < 4) {
				const inner = scopeBlock(body, scope, depth + 1);
				if (inner !== "") out += `${prelude}{${inner}}`;
			} else if (name === "keyframes") {
				out += `${prelude}{${body}}`;
			}
			// Everything else (`@font-face`, `@supports`, `@layer`, …) is dropped or unsupported by the terminal.
			continue;
		}
		// A nested rule could be expanded by the terminal to selectors outside the scope: no nesting at all.
		if (hasNestedBlock(body)) continue;
		const selectors = splitSelectors(prelude)
			.map(selector => scopeSelector(selector, scope))
			.filter((selector): selector is string => selector !== undefined);
		if (selectors.length > 0) out += `${selectors.join(",")}{${body}}`;
	}
	return out;
}

/** Validate, then confine; a sheet that can't be read safely is dropped whole. */
function scopeRules(css: string, scope: string, depth: number): string {
	try {
		validateSheet(css);
		return scopeBlock(css, scope, depth);
	} catch (error) {
		if (!(error instanceof SheetAnomaly)) throw error;
		logger.warn("TSP: tool stylesheet dropped", { reason: error.message });
		return "";
	}
}

/**
 * `css` with every style rule confined to elements below `.scope`: selectors get
 * the class as a prefix; `:root`, `html` and `body` at the start stand for the
 * scope element itself, but a selector that then leaves it through a sibling
 * combinator, one that starts with a combinator, one with `&` and every rule
 * with a nested block are dropped; `@media` is confined inside, `@keyframes`
 * pass through, every other at-rule is dropped. A sheet whose text can't be
 * read the way a CSS parser reads it (unbalanced braces, a raw newline in a
 * string, an escape, `url()`) is dropped whole: the result is empty.
 */
export function scopeStyleSheet(css: string, scope: string): string {
	return scopeRules(css, scope, 0);
}

// ── Plain-text fallback ──────────────────────────────────────────────────

const BLOCK_TAGS: Record<string, true> = {
	div: true,
	p: true,
	section: true,
	header: true,
	footer: true,
	nav: true,
	aside: true,
	main: true,
	article: true,
	figure: true,
	blockquote: true,
	ul: true,
	ol: true,
	li: true,
	dl: true,
	dt: true,
	dd: true,
	h1: true,
	h2: true,
	h3: true,
	h4: true,
	pre: true,
	table: true,
	thead: true,
	tbody: true,
	tr: true,
	form: true,
};

interface TextOut {
	lines: string[];
	line: string;
}

function flushLine(out: TextOut): void {
	const line = out.line.replace(/[ \t]+/g, " ").trim();
	if (line !== "") out.lines.push(line);
	out.line = "";
}

function spansText(spans: readonly { t: string }[] | undefined): string {
	return spans ? spans.map(span => span.t).join("") : "";
}

/** The text a node itself carries (not its children's). */
function ownText(child: NativeNode): string {
	switch (child.k) {
		case "el":
		case "md":
		case "code":
		case "ansi":
			return child.p?.text ?? "";
		case "text":
			return child.p?.text ?? spansText(child.p?.spans);
		default:
			return "";
	}
}

/** Plain text of a subtree, run together. */
function plainOf(child: NativeChild): string {
	if (!isNativeNode(child)) return "";
	return `${ownText(child)}${(child.c ?? []).map(plainOf).join("")}`;
}

function emit(child: NativeChild, out: TextOut): void {
	if (!isNativeNode(child)) return;
	if (child.k !== "el") {
		const own = ownText(child);
		if (own !== "") {
			flushLine(out);
			for (const line of own.split("\n")) {
				out.line = line;
				flushLine(out);
			}
		}
		for (const inner of child.c ?? []) emit(inner, out);
		return;
	}
	const props = child.p;
	const tag = props?.tag ?? "div";
	if (tag === "input") {
		out.line += props?.type === "radio" ? (props.checked ? "(•) " : "( ) ") : props?.checked ? "[x] " : "[ ] ";
		return;
	}
	if (tag === "hr") {
		flushLine(out);
		out.lines.push("---");
		return;
	}
	if (tag === "button") {
		out.line += `[${plainOf(child).replace(/\s+/g, " ").trim()}] `;
		return;
	}
	const block = Object.hasOwn(BLOCK_TAGS, tag);
	if (block) flushLine(out);
	if (tag === "li") out.line += "- ";
	if ((tag === "td" || tag === "th") && out.line !== "") out.line += " | ";
	if (props?.text) out.line += props.text;
	for (const inner of child.c ?? []) emit(inner, out);
	if (block) flushLine(out);
	else if (tag === "label" || tag === "td" || tag === "th") out.line += " ";
}

/**
 * The readable text of a view's nodes, for terminals that draw no `el`: one
 * line per block element, `- ` before list items, `[x]`/`[ ]` checkboxes,
 * `(•)`/`( )` radios, `[Label]` buttons, cells joined with ` | `. Empty when
 * `children` has no text.
 */
export function elFallbackText(children: readonly NativeChild[]): string {
	const out: TextOut = { lines: [], line: "" };
	for (const child of children) emit(child, out);
	flushLine(out);
	return out.lines.join("\n");
}

/**
 * `children` with every `el` subtree replaced by a `text` node of its
 * {@link elFallbackText} (one with no text is dropped); other nodes are kept as they are.
 */
export function replaceElWithText(children: readonly NativeChild[] | undefined): NativeChild[] {
	const out: NativeChild[] = [];
	for (const child of children ?? []) {
		if (!isNativeNode(child) || !containsEl([child])) {
			out.push(child);
		} else if (child.k === "el") {
			const plain = elFallbackText([child]);
			if (plain !== "") out.push(node("text", { text: plain }, undefined, child.key));
		} else {
			out.push({ ...child, c: replaceElWithText(child.c) } as NativeNode);
		}
	}
	return out;
}
