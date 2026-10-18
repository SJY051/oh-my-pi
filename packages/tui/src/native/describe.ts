/**
 * Builders for {@link NativeNode}s, so `describe()` implementations read as
 * a tree instead of object literals.
 *
 * @example
 * describe() {
 *   return card({ role: "omp.tool.bash", status: "running", head: [span("Bash", "toolTitle")] }, [
 *     ansi(this.#output, { follow: true, preview: { lines: 10 } }),
 *   ]);
 * }
 */
import type { TspCommonProps, TspElTag, TspKind, TspProps, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { NativeChild, NativeNode } from "./node";

/** A node of any kind. */
export function node<K extends TspKind>(k: K, p?: TspProps<K>, c?: readonly NativeChild[], key?: string): NativeNode {
	return { k, p, c, key } as NativeNode;
}

/** One styled span; `s` is a space-separated list of semantic or theme tokens. */
export function span(t: string, s?: string, extra?: Omit<TspSpan, "t" | "s">): TspSpan {
	return s === undefined && extra === undefined ? { t } : { t, s, ...extra };
}

/** Plain or styled text. */
export function text(content: TspText, p?: Omit<TspProps<"text">, "text" | "spans">): NativeNode {
	return typeof content === "string" ? node("text", { ...p, text: content }) : node("text", { ...p, spans: content });
}

/** Vertical stack. */
export function col(c: readonly NativeChild[], p?: TspProps<"col">): NativeNode {
	return node("col", p, c);
}

/** Horizontal flex row. */
export function row(c: readonly NativeChild[], p?: TspProps<"row">): NativeNode {
	return node("row", p, c);
}

/** Card with an optional header, status and collapsible body. */
export function card(p: TspProps<"card">, c: readonly NativeChild[]): NativeNode {
	return node("card", p, c);
}

/** Markdown source in omp's dialect. */
export function md(source: string, p?: Omit<TspProps<"md">, "text">): NativeNode {
	return node("md", { ...p, text: source });
}

/** Highlighted code. */
export function code(source: string, p?: Omit<TspProps<"code">, "text">): NativeNode {
	return node("code", { ...p, text: source });
}

/** Raw terminal output rendered as a mini terminal. */
export function ansi(output: string, p?: Omit<TspProps<"ansi">, "text">): NativeNode {
	return node("ansi", { ...p, text: output });
}

/** Unified diff. */
export function diff(unified: string, p?: Omit<TspProps<"diff">, "text">): NativeNode {
	return node("diff", { ...p, text: unified });
}

/** A mounted, empty, invisible node for components that describe nothing. */
export const EMPTY_NODE: NativeNode = node("col", { hidden: true });

/** `described` with a sibling identity key (the layout builders only take props). */
export function keyed(described: NativeNode, key: string): NativeNode {
	return { ...described, key };
}

/** `described` mounted but not laid out when `hidden` (cheap visibility toggles keep ids and view state). */
export function withHidden(described: NativeNode, hidden: boolean): NativeNode {
	if (!hidden) return described;
	return node(described.k, { ...described.p, hidden: true } as TspProps, described.c, described.key);
}

/**
 * One HTML element (`el`). `sheet` is CSS confined to the element's subtree:
 * selectors are relative to it and the terminal never sees a rule that could
 * reach beyond it (see {@link NativeNode.sheet}).
 */
export function el(
	tag: TspElTag,
	p?: Omit<TspProps<"el">, "tag">,
	c?: readonly NativeChild[],
	key?: string,
	sheet?: string,
): NativeNode {
	const described = node("el", { ...p, tag }, c, key);
	return sheet === undefined ? described : { ...described, sheet };
}

/** Layout props a tool view's text field or image may set. */
type ToolLeafLayout = Pick<TspCommonProps, "tone" | "hidden" | "grow" | "shrink" | "basis" | "min" | "title">;

/**
 * Props of a text field in a tool view (see {@link inputField}). The text the
 * user types lives in the card, not here: `value` seeds it and replaces it
 * only when it changes between descriptions.
 */
export interface ToolFieldProps extends ToolLeafLayout, Pick<TspCommonProps, "max" | "aria"> {
	/** The text; a value that differs from the one given last time replaces what the user typed (caret to the end). */
	value?: string;
	/** Dim hint while the text is empty. */
	placeholder?: string;
	/** Shown but not editable: a click does not take the keys. */
	readonly?: boolean;
	/** `input` only: keep the keys after Enter instead of handing them back to the composer. */
	keepFocus?: boolean;
	/** `editor` only: grow to this many lines, then scroll (at most 64). */
	maxLines?: number;
}

/**
 * A single-line text field of a tool view, for `onNativeEvent` to read (`edit`
 * with the full text, Enter as the `submit` action). Needs a `key`: the key
 * path names the field in events and holds its text between descriptions.
 */
export function inputField(p: ToolFieldProps, key: string): NativeNode {
	return { k: "input", p, key } as NativeNode;
}

/** A multi-line text field (a textarea): Enter inserts a line break, nothing submits. See {@link inputField}. */
export function editorField(p: ToolFieldProps, key: string): NativeNode {
	return { k: "editor", p, key } as NativeNode;
}

/** Props of an image a tool view gives as bytes (see {@link imageBytes}). */
export interface ToolImageProps extends ToolLeafLayout {
	/** Accessible name; also what a terminal that can't draw the picture shows. */
	alt?: string;
	/** Pixel size, which lets the terminal reserve the space before the picture decodes. */
	w?: number;
	h?: number;
	max?: TspProps<"image">["max"];
}

/**
 * An image from bytes: PNG, JPEG, GIF, WebP, or SVG (`image/svg+xml`, at most
 * 256 KiB). omp uploads it to the terminal once per content (equal bytes share
 * one blob) and drops it when no card shows it. At most 2 MiB per image and
 * 8 MiB per card; one over a cap is replaced by its `alt` text.
 */
export function imageBytes(bytes: Uint8Array, mime: string, p?: ToolImageProps, key?: string): NativeNode {
	return { k: "image", p: { ...p, bytes, mime }, key } as NativeNode;
}

/** Stable node key for an arbitrary identity string; keys join into `/` keypaths, so identities are hashed. */
export function stableKey(identity: string): string {
	return Bun.hash(identity).toString(36);
}

/** Drop absent entries (`undefined`, `null`, `false`) from a child list. */
export function compact<T>(items: readonly (T | undefined | null | false)[]): T[] {
	const out: T[] = [];
	for (const entry of items) if (entry !== undefined && entry !== null && entry !== false) out.push(entry);
	return out;
}

/** A `kv` grid from label/value pairs with muted labels, skipping empty values; undefined when nothing is left. */
export function kv(pairs: readonly (readonly [string, TspText | undefined])[]): NativeNode | undefined {
	const items: { k: TspText; v: TspText }[] = [];
	for (const [label, value] of pairs) {
		if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
		items.push({ k: [span(label, "muted")], v: value });
	}
	return items.length > 0 ? node("kv", { items }) : undefined;
}

/** One list `item`, keyed by the value select/activate events report back. */
export function item(key: string, p: TspProps<"item">): NativeNode {
	return node("item", p, undefined, key);
}

/** A `list` of items. */
export function list(items: readonly NativeChild[], p?: TspProps<"list">, key?: string): NativeNode {
	return node("list", p, items, key);
}

/** Terminal-clocked elapsed counter: `age` ms already elapsed; `stopped` freezes it there. */
export function elapsed(age: number, stopped?: boolean): NativeNode {
	const ms = Math.max(0, Math.round(age));
	return node("elapsed", stopped ? { age: ms, stopped: ms, format: "short" } : { age: ms, format: "short" });
}

/**
 * Keycap for one key id (`"ctrl+o"` → keys `["ctrl", "o"]`); the terminal
 * draws platform glyphs. A literal `+` key survives (`"+"`, `"ctrl++"`).
 */
export function kbd(key: string, nodeKey?: string): NativeNode {
	const keys = key === "+" ? ["+"] : key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
	return node("kbd", { keys: keys.filter(part => part.length > 0) }, undefined, nodeKey);
}
