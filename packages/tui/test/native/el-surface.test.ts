import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { el } from "@oh-my-pi/pi-tui/native/describe";
import { styleScopeName, viewSheetCss } from "@oh-my-pi/pi-tui/native/el";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { NativeToolView, ToolNativeEvent } from "@oh-my-pi/pi-tui/tools/renderer";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TSP_KINDS, type TspNode } from "@oh-my-pi/pi-wire";
import { TspHarness } from "./tsp-harness";

const FEATURES = ["blobs", "settle", "adopt", "dock", "styles"];

/** A component that describes one el tree and keeps the events it is sent. */
class Card implements Component {
	current: NativeNode;
	events: NativeUiEvent[] = [];
	constructor(current: NativeNode) {
		this.current = current;
	}
	render(): readonly string[] {
		return ["card rows"];
	}
	describe(): NativeNode {
		return this.current;
	}
	handleNativeEvent(event: NativeUiEvent): void {
		this.events.push(event);
	}
}

const form = (sheet: string | undefined, label = "Send"): NativeNode =>
	el(
		"form",
		{ class: "ask" },
		[el("button", { text: label, actions: { click: "send" } }, undefined, "go")],
		undefined,
		sheet,
	);

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

/** `s` and `f` messages in the order the terminal received them. */
const wire = (h: TspHarness): string[] =>
	h.terminal.log
		.filter(entry => entry.verb === "s" || entry.verb === "f")
		.map(entry => {
			if (entry.verb === "f") return "f";
			const style = entry.body as { name: string; css?: string | null };
			return style.css ? `s+${style.name}` : `s-${style.name}`;
		});

function sheetsOf(h: TspHarness): Map<string, string> {
	return h.terminal.sheets.get(h.terminal.surface!) ?? new Map();
}

describe("el stylesheets on the surface", () => {
	it("installs a sheet before the frame that wears it, shared by equal sheets, and removes it after the last user is gone", async () => {
		const css = ".ask { color: red } button { padding: 2px }";
		const name = styleScopeName(css);
		const a = new Card(form(css));
		const b = new Card(form(css, "Other"));
		harness = await TspHarness.start(
			tui => {
				tui.addChild(a);
				tui.addChild(b);
			},
			{ features: FEATURES },
		);
		const h = harness;
		expect(wire(h)).toEqual([`s+${name}`, "f"]);
		// One sheet for two cards, confined to the subtree that wears the scope class.
		expect([...sheetsOf(h).keys()]).toEqual([name]);
		expect(sheetsOf(h).get(name)).toBe(viewSheetCss(css, name));
		// The tool's rules reach only below the root element; the outer wrapper's clip is omp's.
		expect(sheetsOf(h).get(name)).toContain(`.${name}-in .ask{ color: red }`);
		for (const card of [a, b]) {
			expect(h.byId(nativeComponentId(card))?.p).toEqual({ tag: "form", class: `ask ${name}` });
		}

		h.tui.removeChild(a);
		await h.render();
		expect([...sheetsOf(h).keys()]).toEqual([name]);

		h.tui.removeChild(b);
		await h.render();
		// The sheet leaves after the frame that deletes its last node, never before.
		expect(wire(h).slice(-2)).toEqual(["f", `s-${name}`]);
		expect(sheetsOf(h).size).toBe(0);
		expect(h.errors).toEqual([]);
	});

	it("swaps the sheet and the scope class when a node's CSS changes", async () => {
		const card = new Card(form(".ask { color: red }"));
		harness = await TspHarness.start(tui => tui.addChild(card), { features: FEATURES });
		const h = harness;
		const id = nativeComponentId(card);
		const before = styleScopeName(".ask { color: red }");
		const after = styleScopeName(".ask { color: blue }");

		card.current = form(".ask { color: blue }");
		await h.render();
		expect(h.byId(id)?.p).toEqual({ tag: "form", class: `ask ${after}` });
		expect([...sheetsOf(h).keys()]).toEqual([after]);
		expect(wire(h).slice(-3)).toEqual([`s+${after}`, "f", `s-${before}`]);
	});

	it("sends no stylesheet and no scope class to a terminal without the styles feature", async () => {
		const card = new Card(form(".ask { color: red }"));
		harness = await TspHarness.start(tui => tui.addChild(card), { features: ["blobs", "settle", "adopt", "dock"] });
		const h = harness;
		expect(h.terminal.log.some(entry => entry.verb === "s")).toBe(false);
		expect(h.byId(nativeComponentId(card))?.p).toEqual({ tag: "form", class: "ask" });
	});

	it("releases a sheet when its card stops using it and installs it again when the card returns to it", async () => {
		const css = ".ask { color: red }";
		const card = new Card(form(css));
		harness = await TspHarness.start(tui => tui.addChild(card), { features: FEATURES });
		const h = harness;
		const name = styleScopeName(css);
		// The card changes shape: its old subtree is deleted and the new one wears no sheet.
		card.current = el("div", { text: "plain" });
		await h.render();
		expect(sheetsOf(h).size).toBe(0);
		card.current = form(css);
		await h.render();
		expect([...sheetsOf(h).keys()]).toEqual([name]);
	});
});

interface Hooks {
	seen: ToolNativeEvent[];
	more: Set<string>;
	/** Resolves the event handler's promise when set. */
	gate?: PromiseWithResolvers<void>;
}

function makeTool(hooks: Hooks, opts: { fallback?: string; sheet?: string } = {}): AgentTool {
	const tool = {
		name: "card",
		label: "Card",
		describeResult(_result: unknown, options: { toolCallId?: string }): NativeToolView {
			const id = options.toolCallId ?? "";
			return {
				tool: { title: "Card" },
				sheet: opts.sheet,
				fallback: opts.fallback,
				body: [
					el(
						"form",
						{ class: "ask" },
						[
							el("label", {}, [
								el("input", { type: "radio", name: "size", value: "m" }, undefined, "radio"),
								el("span", { text: "Medium" }),
							]),
							el("button", { text: "Send", actions: { click: "send" } }, undefined, "send"),
							el("button", { text: "More", actions: { click: "more" } }, undefined, "more"),
							...(hooks.more.has(id) ? [el("p", { text: `details ${id}` }, undefined, "details")] : []),
						],
						"form",
					),
				],
			};
		},
		async onNativeEvent(event: ToolNativeEvent): Promise<void> {
			hooks.seen.push(event);
			if (event.type === "action" && event.act === "more") hooks.more.add(event.toolCallId);
			if (event.type === "action" && event.act === "throw") throw new Error("boom");
			await hooks.gate?.promise;
		},
	};
	return tool as unknown as AgentTool;
}

function makeCard(h: () => TspHarness, tool: AgentTool, id: string): ToolExecutionComponent {
	const ui = {
		requestRender: () => h().tui.requestRender(),
		requestComponentRender: () => h().tui.requestRender(),
		resetDisplay: () => {},
	};
	const card = new ToolExecutionComponent("card", { id }, {}, tool, ui, "/tmp", id);
	card.setExecutionStarted(id);
	card.updateResult({ content: [{ type: "text", text: `result ${id}` }], details: { id } }, false, id);
	return card;
}

const buttonOf = (h: TspHarness, card: Component, text: string): TspNode => {
	const base = nativeComponentId(card);
	const found = h.find(node => node.k === "el" && node.id.startsWith(`${base}.`) && node.p?.text === text);
	if (!found) throw new Error(`no ${text} button under ${base}`);
	return found;
};

describe("interactive tool views", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("delivers an event only to the card the user acted on, with its call id, values and body-relative key", async () => {
		const hooks: Hooks = { seen: [], more: new Set() };
		const tool = makeTool(hooks, { sheet: ".ask { color: red }" });
		const a = makeCard(() => harness!, tool, "call-a");
		const b = makeCard(() => harness!, tool, "call-b");
		harness = await TspHarness.start(
			tui => {
				tui.addChild(a);
				tui.addChild(b);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const sf = h.terminal.surface!;

		h.event({ ev: "action", sf, id: buttonOf(h, b, "Send").id, act: "send", values: { size: "m" } });
		expect(hooks.seen).toHaveLength(1);
		expect(hooks.seen[0]).toMatchObject({
			type: "action",
			toolCallId: "call-b",
			// The wrapper that carries the stylesheet is not part of the author's key.
			key: "form/send",
			act: "send",
			mods: [],
			values: { size: "m" },
			args: { id: "call-b" },
			result: { details: { id: "call-b" } },
		});

		const radio = h.find(
			node => node.k === "el" && node.id.startsWith(`${nativeComponentId(a)}.`) && node.p?.type === "radio",
		)!;
		h.event({ ev: "change", sf, id: radio.id, name: "size", value: "m", checked: true, values: { size: "m" } });
		expect(hooks.seen[1]).toMatchObject({
			type: "change",
			toolCallId: "call-a",
			key: "form/0/radio",
			name: "size",
			value: "m",
			checked: true,
			values: { size: "m" },
		});
		expect(hooks.seen.map(event => event.toolCallId)).toEqual(["call-b", "call-a"]);
	});

	it("describes the card again once the handler returns, so state it changed shows", async () => {
		const hooks: Hooks = { seen: [], more: new Set() };
		const tool = makeTool(hooks);
		const a = makeCard(() => harness!, tool, "call-a");
		const b = makeCard(() => harness!, tool, "call-b");
		harness = await TspHarness.start(
			tui => {
				tui.addChild(a);
				tui.addChild(b);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const sf = h.terminal.surface!;
		const details = (card: Component) =>
			h.find(
				n =>
					n.id.startsWith(`${nativeComponentId(card)}.`) &&
					n.k === "el" &&
					n.p?.text?.startsWith("details") === true,
			);
		expect(details(a)).toBeUndefined();

		// A handler that settles later redescribes when it does, not before.
		hooks.gate = Promise.withResolvers<void>();
		h.event({ ev: "action", sf, id: buttonOf(h, a, "More").id, act: "more" });
		expect(details(a)).toBeUndefined();
		hooks.gate.resolve();
		await h.until(() => details(a) !== undefined);
		expect((details(a)!.p as { text: string }).text).toBe("details call-a");
		expect(details(b)).toBeUndefined();
	});

	it("ignores events of the card's own chrome and survives a handler that throws", async () => {
		const hooks: Hooks = { seen: [], more: new Set() };
		const a = makeCard(() => harness!, makeTool(hooks), "call-a");
		harness = await TspHarness.start(tui => tui.addChild(a), { features: FEATURES });
		const h = harness;
		const sf = h.terminal.surface!;

		// The head's own actions and the fold name the card's root, not a node of the view.
		h.event({ ev: "action", sf, id: nativeComponentId(a), act: "copy-command" });
		expect(hooks.seen).toEqual([]);

		h.event({ ev: "action", sf, id: buttonOf(h, a, "Send").id, act: "throw" });
		expect(hooks.seen).toHaveLength(1);
		h.event({ ev: "action", sf, id: buttonOf(h, a, "Send").id, act: "send" });
		expect(hooks.seen).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	it("shows the fallback text instead of el nodes on a terminal that lists no el kind", async () => {
		const hooks: Hooks = { seen: [], more: new Set() };
		const withFallback = makeCard(() => harness!, makeTool(hooks, { fallback: "Pick a size, then Send" }), "call-a");
		const derived = makeCard(() => harness!, makeTool(hooks), "call-b");
		harness = await TspHarness.start(
			tui => {
				tui.addChild(withFallback);
				tui.addChild(derived);
			},
			{ kinds: TSP_KINDS.filter(kind => kind !== "el"), features: FEATURES },
		);
		const h = harness;
		expect(h.findAll(node => node.k === "el")).toEqual([]);
		expect(h.terminal.log.some(entry => entry.verb === "s")).toBe(false);
		const textOf = (card: Component) =>
			h
				.findAll(node => node.k === "text" && node.id.startsWith(`${nativeComponentId(card)}.`))
				.map(node => (node.p as { text: string }).text);
		expect(textOf(withFallback)).toEqual(["Pick a size, then Send"]);
		expect(textOf(derived)).toEqual(["( ) Medium [Send] [More]"]);
	});

	it("draws the el nodes once the terminal's real hello lists the kind, not on the optimistic start", async () => {
		const hooks: Hooks = { seen: [], more: new Set() };
		const a = makeCard(() => harness!, makeTool(hooks, { fallback: "text only" }), "call-a");
		harness = await TspHarness.start(tui => tui.addChild(a), {
			expected: true,
			manualProbe: true,
			features: FEATURES,
		});
		const h = harness;
		// Before the reply: the surface is open on assumed capabilities, which exclude `el`.
		h.flush();
		expect(h.findAll(node => node.k === "el")).toEqual([]);
		expect(h.terminal.surface).toBeDefined();

		h.terminal.answerProbe();
		h.flush();
		expect(h.findAll(node => node.k === "el").length).toBeGreaterThan(0);
		expect(h.errors).toEqual([]);
	});
});

describe("tool views in a terminal that draws no el", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const plain = (card: ToolExecutionComponent): string => Bun.stripANSI(card.render(80).join("\n"));

	it("shows the view's fallback, else the el nodes read as text, instead of the result's own text", () => {
		const hooks: Hooks = { seen: [], more: new Set() };
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
		const withFallback = new ToolExecutionComponent(
			"card",
			{},
			{},
			makeTool(hooks, { fallback: "Pick a size, then Send" }),
			ui,
			"/tmp",
			"call-a",
		);
		withFallback.updateResult({ content: [{ type: "text", text: "model-facing note" }] }, false, "call-a");
		expect(plain(withFallback)).toContain("Pick a size, then Send");
		expect(plain(withFallback)).not.toContain("model-facing note");

		const derived = new ToolExecutionComponent("card", {}, {}, makeTool(hooks), ui, "/tmp", "call-b");
		derived.updateResult({ content: [{ type: "text", text: "model-facing note" }] }, false, "call-b");
		expect(plain(derived)).toContain("( ) Medium [Send] [More]");
		expect(plain(derived)).not.toContain("model-facing note");
	});

	it("leaves a tool whose view has no el nodes on its own result text", () => {
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
		const tool = {
			name: "card",
			label: "Card",
			describeResult: (): NativeToolView => ({ tool: { title: "Card" }, body: [] }),
		} as unknown as AgentTool;
		const card = new ToolExecutionComponent("card", {}, {}, tool, ui, "/tmp", "call-a");
		card.updateResult({ content: [{ type: "text", text: "model-facing note" }] }, false, "call-a");
		expect(plain(card)).toContain("model-facing note");
	});
});

/** `el` buttons a tool view draws, with a switch that removes "Send" once "More" was clicked. */
function makeDynamicTool(hooks: Hooks & { hideSend: Set<string> }): AgentTool {
	const tool = {
		name: "card",
		label: "Card",
		describeResult(_result: unknown, options: { toolCallId?: string }): NativeToolView {
			const id = options.toolCallId ?? "";
			return {
				tool: { title: "Card" },
				body: [
					el("form", {}, [
						...(hooks.hideSend.has(id)
							? []
							: [el("button", { text: "Send", actions: { click: "send" } }, undefined, "send")]),
						el("button", { text: "More", actions: { click: "more" } }, undefined, "more"),
					]),
				],
			};
		},
		onNativeEvent(event: ToolNativeEvent): void {
			hooks.seen.push(event);
			if (event.type === "action" && event.act === "more") hooks.hideSend.add(event.toolCallId);
		},
	};
	return tool as unknown as AgentTool;
}

describe("late events", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("drops an event for a control the card no longer holds, and one for a disposed card, but not one for a card that finished normally", async () => {
		const hooks = { seen: [] as ToolNativeEvent[], more: new Set<string>(), hideSend: new Set<string>() };
		const tool = makeDynamicTool(hooks);
		const a = makeCard(() => harness!, tool, "call-a");
		const b = makeCard(() => harness!, tool, "call-b");
		harness = await TspHarness.start(
			tui => {
				tui.addChild(a);
				tui.addChild(b);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const sf = h.terminal.surface!;
		const sendA = buttonOf(h, a, "Send").id;
		const sendB = buttonOf(h, b, "Send").id;

		h.event({ ev: "action", sf, id: buttonOf(h, a, "More").id, act: "more" });
		expect(hooks.seen.map(e => e.type === "action" && e.act)).toEqual(["more"]);
		// "More" removed A's Send button; a click that was already on its way names a node that is gone.
		h.event({ ev: "action", sf, id: sendA, act: "send" });
		expect(hooks.seen).toHaveLength(1);

		// A card sealed as final history (its turn ended) is not disposed: its buttons keep working.
		b.seal();
		h.event({ ev: "action", sf, id: sendB, act: "send" });
		expect(hooks.seen.map(e => e.toolCallId)).toEqual(["call-a", "call-b"]);

		// A rebuild disposes the old card; its late event reaches nothing.
		b.dispose();
		h.event({ ev: "action", sf, id: sendB, act: "send" });
		expect(hooks.seen).toHaveLength(2);
	});

	it("does not redescribe a card whose async handler settles after it was disposed", async () => {
		const gate = Promise.withResolvers<void>();
		const seen: ToolNativeEvent[] = [];
		const renders = { count: 0 };
		const ui = {
			requestRender: () => {
				renders.count++;
			},
			requestComponentRender() {},
			resetDisplay() {},
		};
		const card = new ToolExecutionComponent(
			"card",
			{},
			{},
			makeTool({ seen, more: new Set(), gate }),
			ui,
			"/tmp",
			"call-a",
		);
		card.setExecutionStarted("call-a");
		card.updateResult({ content: [{ type: "text", text: "r" }] }, false, "call-a");
		harness = await TspHarness.start(tui => tui.addChild(card), { features: FEATURES });
		const h = harness;
		h.event({ ev: "action", sf: h.terminal.surface!, id: buttonOf(h, card, "More").id, act: "more" });
		expect(seen).toHaveLength(1);
		const before = renders.count;

		card.dispose();
		gate.resolve();
		await gate.promise;
		await Promise.resolve();
		expect(renders.count).toBe(before);
	});
});

describe("stylesheet budget", () => {
	/** `count` unique flat rules. */
	const rules = (seed: string, count: number): string =>
		Array.from({ length: count }, (_, i) => `.r${seed}${i}{color:red}`).join("");
	const holder = (sheet: string): Card => new Card(el("div", { text: "x" }, undefined, undefined, sheet));

	it("takes the old sheet off before installing a swap that would not fit beside it", async () => {
		// Size sheets so four fill most of the surface's CSS budget and a fifth does not fit beside them.
		const probe = Buffer.byteLength(viewSheetCss(rules("p", 200), styleScopeName(rules("p", 200))));
		const count = Math.floor((62_000 / probe) * 200);
		const sheets = ["a", "b", "c", "d", "e"].map(seed => rules(seed, count));
		const cards = sheets.slice(0, 4).map(holder);
		harness = await TspHarness.start(
			tui => {
				for (const card of cards) tui.addChild(card);
			},
			{ features: FEATURES },
		);
		const h = harness;
		expect(sheetsOf(h).size).toBe(4);

		cards[0]!.current = el("div", { text: "x" }, undefined, undefined, sheets[4]);
		await h.render();
		const next = styleScopeName(sheets[4]!);
		expect(h.terminal.rejectedSheets).toEqual([]);
		expect(sheetsOf(h).has(next)).toBe(true);
		expect(sheetsOf(h).has(styleScopeName(sheets[0]!))).toBe(false);
		// The old sheet left first; the card was never left without its new one afterwards.
		expect(wire(h).slice(-3)).toEqual([`s-${styleScopeName(sheets[0]!)}`, `s+${next}`, "f"]);
	});
});

describe("tool views with both a call and a result", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps the stylesheet and the fallback of each side", async () => {
		const hooks: Hooks = { seen: [], more: new Set() };
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
		const tool = {
			name: "card",
			label: "Card",
			describeCall: (): NativeToolView => ({
				sheet: ".c{color:red}",
				fallback: "call fallback",
				body: [el("div", { class: "c", text: "call" })],
			}),
			describeResult: (): NativeToolView => ({
				sheet: ".r{color:blue}",
				fallback: "result fallback",
				body: [el("div", { class: "r", text: "result" })],
			}),
			onNativeEvent: () => {},
		} as unknown as AgentTool;
		const card = new ToolExecutionComponent("card", {}, {}, tool, ui, "/tmp", "call-a");
		card.setExecutionStarted("call-a");
		card.updateResult({ content: [{ type: "text", text: "r" }] }, false, "call-a");
		harness = await TspHarness.start(tui => tui.addChild(card), { features: FEATURES });
		const h = harness;
		expect([...sheetsOf(h).keys()].sort()).toEqual(
			[styleScopeName(".c{color:red}"), styleScopeName(".r{color:blue}")].sort(),
		);
		void hooks;

		harness.stop();
		harness = await TspHarness.start(tui => tui.addChild(card), {
			features: ["blobs", "settle", "adopt", "dock"],
			kinds: TSP_KINDS.filter(k => k !== "el"),
		});
		const text = harness.findAll(n => n.k === "text").map(n => (n.p as { text: string }).text);
		expect(text).toEqual(expect.arrayContaining(["call fallback", "result fallback"]));
	});
});

describe("a generic component that returns el", () => {
	it("reaches the wire as text where the terminal lists no el kind, and not before the real hello", async () => {
		const card = new Card(form(undefined));
		harness = await TspHarness.start(tui => tui.addChild(card), {
			kinds: TSP_KINDS.filter(kind => kind !== "el"),
			features: FEATURES,
		});
		expect(harness.findAll(node => node.k === "el")).toEqual([]);
		expect(harness.byId(nativeComponentId(card))?.k).toBe("text");
		harness.stop();

		const early = new Card(form(".ask{color:red}"));
		harness = await TspHarness.start(tui => tui.addChild(early), {
			expected: true,
			manualProbe: true,
			features: FEATURES,
		});
		harness.flush();
		expect(harness.findAll(node => node.k === "el")).toEqual([]);
		expect(harness.terminal.log.some(entry => entry.verb === "s")).toBe(false);
		harness.terminal.answerProbe();
		harness.flush();
		expect(harness.byId(nativeComponentId(early))?.k).toBe("el");
		expect(sheetsOf(harness).size).toBe(1);
	});
});

/** A ui that counts the renders a card asks for. */
function countingUi(): { ui: ToolExecutionUi; renders: () => number } {
	let renders = 0;
	return {
		renders: () => renders,
		ui: {
			requestRender: () => {
				renders++;
				harness?.tui.requestRender();
			},
			requestComponentRender: () => harness?.tui.requestRender(),
			resetDisplay: () => {},
		},
	};
}

describe("describing tool cards again on request", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const state = { label: "first" };
	const liveTool = {
		name: "card",
		label: "Card",
		describeResult: (): NativeToolView => ({
			tool: { title: "Card" },
			body: [el("p", { text: state.label }, undefined, "label")],
		}),
	} as unknown as AgentTool;
	const labelOf = (h: TspHarness, card: Component): string | undefined => {
		const found = h.find(n => n.k === "el" && n.id.startsWith(`${nativeComponentId(card)}.`) && n.p?.tag === "p");
		return found?.p && "text" in found.p && typeof found.p.text === "string" ? found.p.text : undefined;
	};
	const liveCard = (ui: ToolExecutionUi, id: string): ToolExecutionComponent => {
		const card = new ToolExecutionComponent("card", {}, {}, liveTool, ui, "/tmp", id);
		card.setExecutionStarted(id);
		card.updateResult({ content: [{ type: "text", text: "r" }] }, false, id);
		return card;
	};

	it("redraws the cards of one call, or of the tool, when what their view reads changed outside an event", async () => {
		state.label = "first";
		const { ui } = countingUi();
		const a = liveCard(ui, "call-a");
		const b = liveCard(ui, "call-b");
		harness = await TspHarness.start(
			tui => {
				tui.addChild(a);
				tui.addChild(b);
			},
			{ features: FEATURES },
		);
		const h = harness;

		// Nothing in the card changed, so a repaint keeps the description it has.
		state.label = "second";
		h.tui.requestRender();
		h.flush();
		expect([labelOf(h, a), labelOf(h, b)]).toEqual(["first", "first"]);

		ToolExecutionComponent.redescribe(ui, "card", "call-a");
		await h.until(() => labelOf(h, a) === "second");
		expect(labelOf(h, b)).toBe("first");

		ToolExecutionComponent.redescribe(ui, "card");
		await h.until(() => labelOf(h, b) === "second");
	});

	it("does nothing for a tool or call no card shows, another ui's cards, or a disposed card", async () => {
		state.label = "first";
		const mine = countingUi();
		const other = countingUi();
		const a = liveCard(mine.ui, "call-a");
		const gone = liveCard(mine.ui, "call-gone");
		harness = await TspHarness.start(
			tui => {
				tui.addChild(a);
				tui.addChild(gone);
			},
			{ features: FEATURES },
		);
		const h = harness;
		gone.dispose();
		const before = mine.renders();

		ToolExecutionComponent.redescribe(mine.ui, "other-tool");
		ToolExecutionComponent.redescribe(mine.ui, "card", "call-unknown");
		ToolExecutionComponent.redescribe(other.ui, "card");
		ToolExecutionComponent.redescribe(mine.ui, "card", "call-gone");
		await Promise.resolve();
		expect(mine.renders()).toBe(before);
		expect(other.renders()).toBe(0);
		h.flush();
	});
});

describe("reserved action names in a tool view", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("sends an el's `open` under another name Tern delivers, and hands the hook the name the view wrote", async () => {
		const seen: ToolNativeEvent[] = [];
		const tool = {
			name: "card",
			label: "Card",
			describeResult: (): NativeToolView => ({
				tool: { title: "Card" },
				body: [
					el("button", { text: "Mine", actions: { click: "open=draft" } }, undefined, "mine"),
					el("span", { text: "Docs", href: "https://example.com", actions: { click: "open" } }, undefined, "docs"),
				],
			}),
			onNativeEvent: (event: ToolNativeEvent) => {
				seen.push(event);
			},
		} as unknown as AgentTool;
		const { ui } = countingUi();
		const card = new ToolExecutionComponent("card", {}, {}, tool, ui, "/tmp", "call-a");
		card.setExecutionStarted("call-a");
		card.updateResult({ content: [{ type: "text", text: "r" }] }, false, "call-a");
		harness = await TspHarness.start(tui => tui.addChild(card), { features: FEATURES });
		const h = harness;

		const mine = buttonOf(h, card, "Mine");
		const clickOf = (node: TspNode): string | undefined =>
			node.p && "actions" in node.p ? (node.p.actions as { click?: string } | undefined)?.click : undefined;
		// Tern would swallow `open` on a button with no link; the link's `open` is Tern's own and stays.
		expect(clickOf(mine)).toBe("omp-reserved-open=draft");
		expect(clickOf(buttonOf(h, card, "Docs"))).toBe("open");

		h.event({ ev: "action", sf: h.terminal.surface!, id: mine.id, act: "omp-reserved-open", value: "draft" });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: "action", act: "open", value: "draft", key: "mine" });
	});
});
