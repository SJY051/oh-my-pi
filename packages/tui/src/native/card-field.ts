/**
 * A text field of a tool view (`inputField`/`editorField`, see `describe.ts`)
 * made real: the card swaps each such node for one {@link CardField}, a
 * component that owns the text, takes the keys while it has the terminal's
 * focus, applies the terminal's own selection edits, and reports the result
 * to the card through {@link CardFieldHost}.
 *
 * The editing itself is the composer's: a single line is an {@link Input}, several lines an {@link Editor}
 * (Enter inserts a line break there), so caret keys, word motion, kill ring,
 * undo, paste and IME commits behave as in the composer. A field is a
 * component and not a bare node because the terminal routes focus and edits
 * per component: the keys go to whichever component holds the TUI's focus,
 * and Tern's `focus`/`edit` events name the node a component described.
 */
import type { TspProps } from "@oh-my-pi/pi-wire";
import { matchesKey } from "../keys";
import type { Component, Focusable } from "../tui";
import { Editor } from "../components/editor";
import { Input } from "../components/input";
import { getEditorTheme } from "../theme/theme";
import { col } from "./describe";
import { TOOL_FIELD_MAX_CHARS } from "./el";
import { Memo } from "./memo";
import type { DescribeContext, NativeNode, NativeUiEvent } from "./node";

/** What a field needs from the card that owns it. */
export interface CardFieldHost {
	requestRender(): void;
	/** Hand the keys back to whoever held them before the user clicked into the field. */
	releaseFocus(field: Component): void;
	/** The text changed (typing, paste, a selection edit of the terminal); `text` is all of it, `cursor` a UTF-16 offset. */
	onEdit(key: string, text: string, cursor: number): void;
	/** Enter in a single-line field. */
	onSubmit(key: string, text: string): void;
}

/** The layout props copied onto the field's wrapper (the field node itself takes `readonly` and `aria`). */
const WRAPPER_KEYS = ["tone", "hidden", "grow", "shrink", "basis", "min", "max", "title"] as const;

/** The props of a sanitized field node of a tool view (see `sanitizeField` in `el.ts`). */
export type CardFieldProps = Record<string, unknown>;

/** The node of kind `input`/`editor` under `described` (the field's own node), or undefined. */
function findFieldNode(described: NativeNode): NativeNode | undefined {
	if (described.k === "input" || described.k === "editor") return described;
	for (const child of described.c ?? []) {
		if ("k" in child) {
			const found = findFieldNode(child);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

/** `described` with `patch` merged into the props of its field node. */
function patchField(described: NativeNode, patch: Record<string, unknown>): NativeNode {
	if (described.k === "input" || described.k === "editor") {
		return { ...described, p: { ...described.p, ...patch } } as NativeNode;
	}
	return {
		...described,
		c: (described.c ?? []).map(child => ("k" in child ? patchField(child, patch) : child)),
	} as NativeNode;
}

export class CardField implements Component, Focusable {
	readonly kind: "input" | "editor";
	/** The field's key path in the view, as `onNativeEvent` reports it. */
	readonly key: string;
	#host: CardFieldHost;
	#input: Input | undefined;
	#editor: Editor | undefined;
	/** The last `value` the view supplied: only a different one replaces the text. */
	#supplied: string | undefined;
	/** The text as last reported (or supplied): an edit event is due when it differs. */
	#reported = "";
	#keepFocus = false;
	#readonly = false;
	#aria: string | undefined;
	#wrapper: TspProps<"col"> = {};
	#wrapperKey = "";
	#disposed = false;
	readonly #memo = new Memo();

	constructor(kind: "input" | "editor", key: string, host: CardFieldHost) {
		this.kind = kind;
		this.key = key;
		this.#host = host;
		if (kind === "input") {
			const input = new Input();
			input.prompt = "";
			input.onSubmit = text => {
				if (this.#disposed) return;
				this.#sync();
				this.#host.onSubmit(this.key, text);
				if (!this.#keepFocus) this.#host.releaseFocus(this);
			};
			this.#input = input;
		} else {
			const editor = new Editor(getEditorTheme());
			// Enter is a line break here (see `handleInput`); nothing submits an editor.
			editor.disableSubmit = true;
			editor.setBorderVisible(false);
			this.#editor = editor;
		}
	}

	get focused(): boolean {
		return (this.#input ?? this.#editor)!.focused;
	}

	set focused(value: boolean) {
		const inner = (this.#input ?? this.#editor)!;
		inner.focused = value;
	}

	setUseTerminalCursor(use: boolean): void {
		this.#input?.setUseTerminalCursor(use);
		this.#editor?.setUseTerminalCursor(use);
	}

	/** The text as it stands. */
	get text(): string {
		return this.#input ? this.#input.getValue() : this.#editor!.getText();
	}

	/** The caret as a UTF-16 offset into {@link text}. */
	get cursor(): number {
		if (this.#input) return this.#input.getCursor();
		const { line, col: column } = this.#editor!.getCursor();
		const lines = this.#editor!.getText().split("\n");
		let offset = column;
		for (let i = 0; i < line && i < lines.length; i++) offset += lines[i]!.length + 1;
		return offset;
	}

	#setText(text: string): void {
		if (this.#input) this.#input.setValue(text);
		else this.#editor!.setText(text);
	}

	/** Take the props of the field node the view describes now. A changed `value` replaces the text; an unchanged one never overwrites typing. */
	apply(props: CardFieldProps): void {
		const value = typeof props.value === "string" ? props.value : undefined;
		if (value !== undefined && value !== this.#supplied) {
			this.#supplied = value;
			if (value !== this.text) this.#setText(value);
			this.#reported = value;
		}
		const placeholder = typeof props.placeholder === "string" ? props.placeholder : undefined;
		if (this.#input) this.#input.placeholder = placeholder;
		else this.#editor!.placeholder = placeholder === undefined ? undefined : () => placeholder;
		if (this.#editor) {
			const lines = typeof props.maxLines === "number" ? props.maxLines : undefined;
			this.#editor.setMaxHeight(lines);
		}
		this.#readonly = props.readonly === true;
		this.#keepFocus = props.keepFocus === true;
		this.#aria = typeof props.aria === "string" ? props.aria : undefined;
		const wrapper: TspProps<"col"> = {};
		for (const name of WRAPPER_KEYS) if (props[name] !== undefined) Object.assign(wrapper, { [name]: props[name] });
		const wrapperKey = JSON.stringify(wrapper);
		if (wrapperKey !== this.#wrapperKey) {
			this.#wrapperKey = wrapperKey;
			this.#wrapper = wrapper;
		}
	}

	/** Report a text change the field's own editing made since the last report. */
	#sync(before?: string): void {
		const text = this.text;
		if (text === this.#reported) return;
		if (before !== undefined && text.length > TOOL_FIELD_MAX_CHARS) {
			// The tool's own cap: what the user types is held to it, too.
			this.#setText(before);
			return;
		}
		this.#reported = text;
		this.#host.onEdit(this.key, text, this.cursor);
	}

	handleInput(data: string): void {
		if (this.#disposed || this.#readonly) return;
		if (matchesKey(data, "escape")) {
			this.#host.releaseFocus(this);
			return;
		}
		const before = this.text;
		if (this.#editor && (matchesKey(data, "enter") || data === "\n")) this.#editor.insertText("\n");
		else if (this.#input) this.#input.handleInput(data);
		else this.#editor!.handleInput(data);
		this.#sync(before);
	}

	/** The terminal's own selection edits and undo (`edit`/`undo` events) reach the same editing. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed || this.#readonly) return;
		const before = this.text;
		(this.#input ?? this.#editor)!.handleNativeEvent(event);
		this.#sync(before);
	}

	/** The card is gone (a transcript rebuild, or the view dropped the field): give the keys back. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#host.releaseFocus(this);
	}

	render(width: number): readonly string[] {
		return (this.#input ?? this.#editor)!.render(width);
	}

	invalidate(): void {
		(this.#input ?? this.#editor)!.invalidate?.();
	}

	describe(cx: DescribeContext): NativeNode {
		const inner = (this.#input ?? this.#editor)!.describe(cx);
		return this.#memo.get([inner, this.#readonly, this.#aria, this.#wrapper], () => {
			const patch: Record<string, unknown> = {};
			if (this.#readonly) patch.readonly = true;
			if (this.#aria !== undefined) patch.aria = this.#aria;
			const field =
				Object.keys(patch).length === 0 || findFieldNode(inner) === undefined ? inner : patchField(inner, patch);
			return col([field], this.#wrapper);
		});
	}
}
