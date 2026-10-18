import { describe, expect, it } from "bun:test";
import { el, node, text } from "@oh-my-pi/pi-tui/native/describe";
import {
	containsEl,
	EL_MAX_SHEET_BYTES,
	EL_MAX_VIEW_DEPTH,
	EL_MAX_VIEW_NODES,
	elActionName,
	elFallbackText,
	replaceElWithText,
	sanitizeElChildren,
} from "@oh-my-pi/pi-tui/native/el";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";

/** Every described node under `children`, depth first. */
function flatten(children: readonly NativeChild[] | undefined): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) {
		if (!("k" in child)) continue;
		out.push(child, ...flatten(child.c));
	}
	return out;
}

/** An `el` node built the way an untrusted tool might: props the types would refuse. */
function hostile(props: Record<string, unknown>, children?: NativeChild[]): NativeNode {
	return { k: "el", p: props, c: children } as NativeNode;
}

describe("sanitizeElChildren", () => {
	it("reduces a tool's el nodes to what the terminal accepts", () => {
		const view = [
			hostile(
				{
					tag: "script",
					class: "sf sf-card keep omp-other",
					attrs: {
						"data-x": 1,
						"aria-label": "owned by the terminal",
						"data-id": "owned",
						onclick: "boom()",
						style: "display:none",
						role: "group",
						"data-obj": { nested: true },
					},
					text: "hello",
					href: "file:///x",
					tone: "chaos",
					hidden: "yes",
					unknownProp: 1,
					actions: { click: "go", dblclick: 7, menu: ["a", 3, ""] },
				},
				[hostile({ tag: "input", type: "text" }), hostile({ tag: "span", text: "kept" })],
			),
		];

		const [root] = sanitizeElChildren(view, "test") as NativeNode[];
		expect(root?.p).toEqual({
			tag: "div",
			class: "keep omp-other",
			attrs: { "data-x": 1, role: "group" },
			text: "hello",
			href: "file:///x",
			actions: { click: "go", menu: ["a"] },
		});
		// The text input can't be drawn (an `input` is a checkbox or radio), so it is gone; its sibling stays.
		expect(root?.c?.map(child => (child as NativeNode).p)).toEqual([{ tag: "span", text: "kept" }]);
	});

	it("keeps control state only on an input, and gives input and hr no children", () => {
		const view = [
			hostile({ tag: "span", type: "radio", name: "n", checked: true, value: "v", disabled: true }),
			hostile(
				{ tag: "input", type: "radio", name: "n", value: "v", checked: true, disabled: false, text: "no text" },
				[hostile({ tag: "span", text: "child of input" })],
			),
			hostile({ tag: "hr", text: "ignored" }, [hostile({ tag: "span" })]),
		];
		const [span, input, hr] = sanitizeElChildren(view, "test") as NativeNode[];
		expect(span?.p).toEqual({ tag: "span" });
		expect(input?.p).toEqual({
			tag: "input",
			type: "radio",
			name: "n",
			value: "v",
			checked: true,
			disabled: false,
			text: "no text",
		});
		expect(input?.c).toBeUndefined();
		expect(hr?.p).toEqual({ tag: "hr" });
		expect(hr?.c).toBeUndefined();
	});

	it("drops nodes past the per-view node cap instead of truncating inside a node", () => {
		const flat = Array.from({ length: EL_MAX_VIEW_NODES + 500 }, () => el("span", { text: "x" }));
		const kept = sanitizeElChildren([el("div", {}, flat)], "test");
		// The container takes one slot of the budget.
		expect(flatten(kept)).toHaveLength(EL_MAX_VIEW_NODES);
	});

	it("drops subtrees nested deeper than the per-view depth cap", () => {
		let deep: NativeNode = el("span", { text: "bottom" });
		for (let i = 0; i < EL_MAX_VIEW_DEPTH + 10; i++) deep = el("div", {}, [deep]);
		const kept = flatten(sanitizeElChildren([deep], "test"));
		expect(kept).toHaveLength(EL_MAX_VIEW_DEPTH + 1);
		expect(kept.some(n => n.p && "text" in n.p && n.p.text === "bottom")).toBe(false);
	});

	it("drops a stylesheet over the size cap but keeps the node", () => {
		const big = `.a{${"x".repeat(EL_MAX_SHEET_BYTES)}}`;
		const [small, large] = sanitizeElChildren(
			[el("div", {}, [], undefined, ".a{color:red}"), el("div", {}, [], undefined, big)],
			"test",
		) as NativeNode[];
		expect(small?.sheet).toBe(".a{color:red}");
		expect(large).toBeDefined();
		expect(large?.sheet).toBeUndefined();
	});

	it("finds el nodes inside other nodes and leaves el-free views untouched", () => {
		const plain = [node("col", {}, [text("no html here")])];
		expect(containsEl(plain)).toBe(false);
		expect(sanitizeElChildren(plain, "test")).toBe(plain);

		const nested = [node("col", {}, [hostile({ tag: "div", class: "sf-x" })])];
		expect(containsEl(nested)).toBe(true);
		const col = sanitizeElChildren(nested, "test")[0] as NativeNode;
		expect((col.c![0] as NativeNode).p).toEqual({ tag: "div" });
	});
});

describe("el text fallback", () => {
	const form = el("form", {}, [
		el("h3", { text: "Pick a size" }),
		el("div", { attrs: { role: "radiogroup" } }, [
			el("label", {}, [
				el("input", { type: "radio", name: "s", value: "s", checked: true }),
				el("span", { text: "Small" }),
			]),
			el("label", {}, [el("input", { type: "radio", name: "s", value: "l" }), el("span", { text: "Large" })]),
		]),
		el("label", {}, [el("input", { type: "checkbox", name: "u", checked: true }), el("span", { text: "Urgent" })]),
		el("ul", {}, [el("li", { text: "one" }), el("li", { text: "two" })]),
		el("hr"),
		el("div", {}, [el("button", { text: "Send" }), el("button", { text: "More" })]),
	]);

	it("reads an el form as the lines a plain terminal can show", () => {
		expect(elFallbackText([form])).toBe(
			["Pick a size", "(•) Small ( ) Large", "[x] Urgent", "- one", "- two", "---", "[Send] [More]"].join("\n"),
		);
	});

	it("replaces el subtrees with their text and leaves other nodes alone", () => {
		const before = [text("note"), node("col", {}, [form])];
		const after = replaceElWithText(before);
		expect(after[0]).toBe(before[0]!);
		expect(containsEl(after)).toBe(false);
		const inner = (after[1] as NativeNode).c?.[0] as NativeNode;
		expect(inner.k).toBe("text");
		expect((inner.p as { text: string }).text).toContain("[Send] [More]");
	});
});

describe("one budget for every node of a view", () => {
	it("counts non-el nodes under an el, so a huge col of texts is pruned at the node cap", () => {
		const texts = Array.from({ length: EL_MAX_VIEW_NODES + 500 }, () => text("x"));
		const kept = sanitizeElChildren([el("div", {}, [node("col", {}, texts)])], "test");
		expect(flatten(kept)).toHaveLength(EL_MAX_VIEW_NODES);
	});

	it("prunes a very deep chain of non-el nodes without recursing into it", () => {
		let deep: NativeNode = el("span", { text: "bottom" });
		for (let i = 0; i < 100_000; i++) deep = node("col", {}, [deep]);
		expect(containsEl([deep])).toBe(true);
		const kept = flatten(sanitizeElChildren([deep], "test"));
		expect(kept.length).toBeLessThanOrEqual(EL_MAX_VIEW_DEPTH + 1);
		expect(kept.some(n => n.k === "el")).toBe(false);
	});

	it("gives a node with an empty key no key, so it can't take the id of its component's root", () => {
		const kept = sanitizeElChildren([el("div", {}, [node("text", { text: "t" }, undefined, "")], "")], "test");
		const [div] = kept as NativeNode[];
		expect(div?.key).toBeUndefined();
		expect((div!.c![0] as NativeNode).key).toBeUndefined();
	});
});

describe("action names Tern acts on itself", () => {
	/** The actions the sanitizer sends for one `el` with these props. */
	const sent = (props: Record<string, unknown>) => {
		const [kept] = sanitizeElChildren([hostile({ tag: "button", ...props })], "test") as [NativeNode];
		return (kept.p as { actions?: { click?: string; dblclick?: string; menu?: string[] } }).actions;
	};

	it("sends toggle, copy, open and zoom under a name the terminal delivers, in click, dblclick and menu", () => {
		expect(sent({ actions: { click: "open", dblclick: "zoom", menu: ["copy", "toggle", "mine"] } })).toEqual({
			click: "omp-reserved-open",
			dblclick: "omp-reserved-zoom",
			menu: ["omp-reserved-copy", "omp-reserved-toggle", "mine"],
		});
	});

	it("judges `name=value` actions by their name and keeps the value", () => {
		expect(sent({ actions: { click: "open=draft" } })?.click).toBe("omp-reserved-open=draft");
		expect(sent({ actions: { click: "opened=draft" } })?.click).toBe("opened=draft");
	});

	it("leaves open and copy alone on a node with an href, where they are the terminal's own", () => {
		expect(sent({ href: "https://example.com", actions: { click: "open", menu: ["copy", "zoom"] } })).toEqual({
			click: "open",
			menu: ["copy", "omp-reserved-zoom"],
		});
	});

	it("drops an action that already wears the prefix, so a reported name has one meaning", () => {
		expect(sent({ actions: { click: "omp-reserved-open", menu: ["fine"] } })).toEqual({ menu: ["fine"] });
	});

	it("restores the name the view wrote, and leaves every other name alone", () => {
		expect(elActionName("omp-reserved-open")).toBe("open");
		expect(elActionName("omp-reserved-open=draft")).toBe("open=draft");
		expect(elActionName("send")).toBe("send");
	});
});
