import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent, type ToolExecutionUi } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { editorField, el, imageBytes, inputField, node } from "@oh-my-pi/pi-tui/native/describe";
import {
	TOOL_FIELD_MAX_CHARS,
	TOOL_IMAGE_MAX_BYTES,
	TOOL_SVG_MAX_BYTES,
	TOOL_VIEW_IMAGE_MAX_BYTES,
} from "@oh-my-pi/pi-tui/native/el";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { nativeComponentId } from "@oh-my-pi/pi-tui/native/reconcile";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { NativeToolView, ToolNativeEvent } from "@oh-my-pi/pi-tui/tools/renderer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TSP_KINDS, type TspNode } from "@oh-my-pi/pi-wire";
import { TspHarness, type TspHarnessOptions } from "./tsp-harness";

const FEATURES = ["blobs", "settle", "adopt", "dock", "styles", "edit", "undo"];

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

/** Stands in for the composer: holds the keys until the user clicks into a field. */
class Composer implements Component {
	keys: string[] = [];
	focused = false;
	render(): readonly string[] {
		return ["> "];
	}
	describe(): NativeNode {
		return node("editor", { text: "" });
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
}

interface Probe {
	seen: ToolNativeEvent[];
	/** What `describeResult` draws now. */
	view: () => readonly NativeChild[];
	describes: number;
	/** Times the tool's own rows renderers ran (a native terminal never paints rows). */
	rowRenders?: number;
	fallback?: string;
}

function probeTool(probe: Probe): AgentTool {
	const tool = {
		name: "form",
		label: "Form",
		describeResult(): NativeToolView {
			probe.describes++;
			return { tool: { title: "Form" }, body: probe.view(), fallback: probe.fallback };
		},
		onNativeEvent(event: ToolNativeEvent): void {
			probe.seen.push(event);
		},
	};
	// Rows renderers only for a probe that counts them: without them a plain terminal draws the view's fallback text.
	if (probe.rowRenders === undefined) return tool as unknown as AgentTool;
	return {
		...tool,
		renderCall() {
			probe.rowRenders!++;
			return new Text("call rows", 0, 0);
		},
		renderResult() {
			probe.rowRenders!++;
			return new Text("result rows", 0, 0);
		},
	} as unknown as AgentTool;
}

/** The ui every card of a test shares (cards are made before the TUI exists, so it reaches the harness lazily). */
let ui: ToolExecutionUi;
let visibilityListeners: Set<(visible: boolean) => void>;
beforeEach(() => {
	visibilityListeners = new Set();
	ui = {
		requestRender: () => harness?.tui.requestRender(),
		requestComponentRender: () => harness?.tui.requestRender(),
		resetDisplay: () => {},
		releaseFocus: component => harness?.tui.releaseFocus(component),
		addVisibilityListener: listener => {
			visibilityListeners.add(listener);
			return () => visibilityListeners.delete(listener);
		},
	};
});

/** A harness whose pane visibility reaches the test ui's listeners, as the real TUI's reaches the cards'. */
async function start(setup: (tui: TspHarness["tui"]) => void, options: TspHarnessOptions = { features: FEATURES }) {
	const h = await TspHarness.start(setup, options);
	h.tui.addVisibilityListener(visible => {
		for (const listener of visibilityListeners) listener(visible);
	});
	return h;
}

function makeCard(probe: Probe, id = "call-a"): ToolExecutionComponent {
	const card = new ToolExecutionComponent("form", { id }, {}, probeTool(probe), ui, "/tmp", id);
	card.setExecutionStarted(id);
	card.updateResult({ content: [{ type: "text", text: `result ${id}` }] }, false, id);
	return card;
}

/** The `at`th node of `kind` on the surface: a field is a component of its own, so it has an id of its own. */
const nodeOf = (h: TspHarness, kind: string, at = 0): TspNode => {
	const found = h.findAll(n => n.k === kind)[at];
	if (!found) throw new Error(`no ${kind} #${at} on the surface`);
	return found;
};

const focusOps = (h: TspHarness): (string | null)[] =>
	h.frames.flatMap(frame => frame.ops.filter(op => op[0] === "focus").map(op => op[1] as string | null));

const nameField = (value = ""): NativeChild =>
	el("form", {}, [inputField({ value, placeholder: "Name" }, "name")], "form");

describe("text fields in a tool view", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("takes the keys from the composer while focused, reports every edit with the whole text, and gives the keys back on Enter", async () => {
		const probe: Probe = { seen: [], view: () => [nameField()], describes: 0 };
		const composer = new Composer();
		const card = makeCard(probe);
		harness = await start(
			tui => {
				tui.addChild(card);
				tui.addChild(composer);
				tui.setFocus(composer);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const sf = h.terminal.surface!;

		// Before the user clicks into the field every key is the composer's.
		h.terminal.send("x");
		h.flush();
		expect(composer.keys).toEqual(["x"]);

		const field = nodeOf(h, "input");
		expect(field.p).toMatchObject({ text: "", placeholder: "Name" });
		h.event({ ev: "focus", sf, id: field.id });
		expect(h.tui.getFocused()).not.toBe(composer);
		expect(focusOps(h).at(-1)).toBe(field.id);

		for (const key of ["h", "i"]) h.terminal.send(key);
		h.flush();
		// Not one of those keys reached the composer.
		expect(composer.keys).toEqual(["x"]);
		expect(probe.seen.filter(e => e.type === "edit")).toMatchObject([
			{ type: "edit", toolCallId: "call-a", key: "form/name", value: "h", cursor: 1 },
			{ type: "edit", toolCallId: "call-a", key: "form/name", value: "hi", cursor: 2 },
		]);
		expect(nodeOf(h, "input").p).toMatchObject({ text: "hi", cursor: 2 });

		// An edit over the terminal's own selection is applied and reported like typing.
		h.event({ ev: "edit", sf, id: field.id, from: 0, to: 2, text: "yo", cursor: 2, len: 2 });
		expect(probe.seen.at(-1)).toMatchObject({ type: "edit", key: "form/name", value: "yo", cursor: 2 });
		// A stale one (the text it was computed against is gone) changes nothing.
		const before = probe.seen.length;
		h.event({ ev: "edit", sf, id: field.id, from: 0, to: 1, text: "z", cursor: 1, len: 7 });
		expect(probe.seen).toHaveLength(before);

		h.terminal.send("\r");
		h.flush();
		expect(probe.seen.at(-1)).toMatchObject({
			type: "action",
			act: "submit",
			key: "form/name",
			value: "yo",
			mods: [],
		});
		// The keys are the composer's again, and the terminal is told.
		expect(h.tui.getFocused()).toBe(composer);
		expect(focusOps(h).at(-1)).not.toBe(field.id);
		h.terminal.send("q");
		h.flush();
		expect(composer.keys).toEqual(["x", "q"]);
		expect(h.errors).toEqual([]);
	});

	it("hands the keys back on Escape, and keeps them after Enter when the field asks", async () => {
		const probe: Probe = {
			seen: [],
			view: () => [inputField({ value: "" }, "once"), inputField({ value: "", keepFocus: true }, "stay")],
			describes: 0,
		};
		const composer = new Composer();
		const card = makeCard(probe);
		harness = await start(
			tui => {
				tui.addChild(card);
				tui.addChild(composer);
				tui.setFocus(composer);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const sf = h.terminal.surface!;
		const [once, stay] = h.findAll(n => n.k === "input");

		h.event({ ev: "focus", sf, id: once!.id });
		h.terminal.send("a");
		h.terminal.send("\x1b");
		h.flush();
		expect(h.tui.getFocused()).toBe(composer);
		// Escape is not an edit and not a submit.
		expect(probe.seen.map(e => e.type)).toEqual(["edit"]);

		h.event({ ev: "focus", sf, id: stay!.id });
		h.terminal.send("b");
		h.terminal.send("\r");
		h.flush();
		expect(probe.seen.at(-1)).toMatchObject({ type: "action", act: "submit", key: "stay", value: "b" });
		expect(h.tui.getFocused()).not.toBe(composer);
		h.terminal.send("c");
		h.flush();
		expect(probe.seen.at(-1)).toMatchObject({ type: "edit", key: "stay", value: "bc" });
		expect(composer.keys).toEqual([]);

		// Clicking back into the composer is the terminal's own focus event; the field keeps what it typed.
		h.event({ ev: "focus", sf, id: nativeComponentId(composer) });
		expect(h.tui.getFocused()).toBe(composer);
	});

	it("hands the keys back when the card is disposed or the view drops the field", async () => {
		let dropped = false;
		const probe: Probe = {
			seen: [],
			view: () => [dropped ? el("p", { text: "gone" }, undefined, "p") : inputField({ value: "" }, "name")],
			describes: 0,
		};
		const composer = new Composer();
		const a = makeCard(probe, "call-a");
		const b = makeCard({ ...probe, seen: [], view: () => [inputField({ value: "" }, "name")] }, "call-b");
		harness = await start(
			tui => {
				tui.addChild(a);
				tui.addChild(b);
				tui.addChild(composer);
				tui.setFocus(composer);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const sf = h.terminal.surface!;

		h.event({ ev: "focus", sf, id: nodeOf(h, "input").id });
		expect(h.tui.getFocused()).not.toBe(composer);
		dropped = true;
		ToolExecutionComponent.redescribe(ui, "form", "call-a");
		await h.until(() => h.findAll(n => n.k === "input").length === 1);
		expect(h.tui.getFocused()).toBe(composer);

		h.event({ ev: "focus", sf, id: nodeOf(h, "input").id });
		expect(h.tui.getFocused()).not.toBe(composer);
		b.dispose();
		expect(h.tui.getFocused()).toBe(composer);
	});

	it("keeps typed text across descriptions unless the view supplies another value", async () => {
		let supplied = "";
		const probe: Probe = { seen: [], view: () => [inputField({ value: supplied }, "name")], describes: 0 };
		const composer = new Composer();
		const card = makeCard(probe);
		harness = await start(
			tui => {
				tui.addChild(card);
				tui.addChild(composer);
				tui.setFocus(composer);
			},
			{ features: FEATURES },
		);
		const h = harness;
		h.event({ ev: "focus", sf: h.terminal.surface!, id: nodeOf(h, "input").id });
		h.terminal.send("a");
		h.terminal.send("b");
		h.flush();

		// The view still says "" (it never echoed): a redescribe must not wipe "ab".
		ToolExecutionComponent.redescribe(ui, "form");
		const describes = probe.describes;
		await h.until(() => probe.describes > describes);
		expect(nodeOf(h, "input").p).toMatchObject({ text: "ab" });

		// A different value is the tool's to set.
		supplied = "preset";
		ToolExecutionComponent.redescribe(ui, "form");
		await h.until(() => (nodeOf(h, "input").p as { text: string }).text === "preset");
		expect(nodeOf(h, "input").p).toMatchObject({ text: "preset", cursor: 6 });
		h.terminal.send("!");
		h.flush();
		expect(probe.seen.at(-1)).toMatchObject({ type: "edit", value: "preset!" });
	});

	it("inserts a line break on Enter in an editor, never submits, and holds typing to the text cap", async () => {
		const probe: Probe = {
			seen: [],
			view: () => [editorField({ value: "", placeholder: "Notes", maxLines: 4 }, "notes")],
			describes: 0,
		};
		const composer = new Composer();
		const card = makeCard(probe);
		harness = await start(
			tui => {
				tui.addChild(card);
				tui.addChild(composer);
				tui.setFocus(composer);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const field = nodeOf(h, "editor");
		expect(field.p).toMatchObject({ placeholder: "Notes", maxLines: 4 });
		h.event({ ev: "focus", sf: h.terminal.surface!, id: field.id });
		for (const key of ["a", "\r", "b"]) h.terminal.send(key);
		h.flush();
		expect(probe.seen.map(e => (e.type === "edit" ? e.value : e.type))).toEqual(["a", "a\n", "a\nb"]);
		expect(probe.seen.at(-1)).toMatchObject({ cursor: 3 });
		expect(composer.keys).toEqual([]);

		// What the tool supplies is cut to the cap; what the user types cannot pass it.
		const long = "z".repeat(TOOL_FIELD_MAX_CHARS + 10);
		const capped: Probe = { seen: [], view: () => [inputField({ value: long }, "big")], describes: 0 };
		const big = makeCard(capped, "call-big");
		h.tui.addChild(big);
		await h.render();
		const bigField = nodeOf(h, "input");
		expect((bigField.p as { text: string }).text).toHaveLength(TOOL_FIELD_MAX_CHARS);
		h.event({ ev: "focus", sf: h.terminal.surface!, id: bigField.id });
		h.terminal.send("y");
		h.flush();
		expect(capped.seen).toEqual([]);
		expect((nodeOf(h, "input").p as { text: string }).text).toHaveLength(TOOL_FIELD_MAX_CHARS);
	});

	it("never takes the keys for a read-only field, and strips props a tool must not set", async () => {
		const probe: Probe = {
			seen: [],
			view: () => [
				// `role`, `actions`, `cursor`, `prompt` and `mode` are the composer's, never a tool's.
				{
					k: "input",
					p: {
						value: "fixed",
						readonly: true,
						role: "omp.editor",
						actions: { click: "x" },
						cursor: 1,
						prompt: "> ",
						mode: "vim",
					},
					key: "locked",
				} as unknown as NativeChild,
			],
			describes: 0,
		};
		const composer = new Composer();
		const card = makeCard(probe);
		harness = await start(
			tui => {
				tui.addChild(card);
				tui.addChild(composer);
				tui.setFocus(composer);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const field = nodeOf(h, "input");
		expect(field.p).toEqual({ text: "fixed", cursor: 5, sendable: false, readonly: true });
		h.event({ ev: "focus", sf: h.terminal.surface!, id: field.id });
		// The terminal doesn't send `focus` for a read-only field; one that arrives anyway gives it nothing either.
		h.terminal.send("k");
		h.flush();
		expect(probe.seen.filter(e => e.type === "edit")).toEqual([]);
	});
});

describe("text fields where the terminal draws no el", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("reads a field as [text] (its placeholder while empty) and an image as its alt text", async () => {
		const probe: Probe = {
			seen: [],
			view: () => [
				el("form", {}, [
					el("label", { text: "Name" }),
					inputField({ value: "Ada", placeholder: "Your name" }, "name"),
					inputField({ value: "", placeholder: "Email" }, "mail"),
					imageBytes(new Uint8Array([1, 2, 3]), "image/png", { alt: "Logo" }, "logo"),
				]),
				editorField({ value: "line 1\nline 2" }, "notes"),
			],
			describes: 0,
		};
		const card = makeCard(probe);
		harness = await start(tui => tui.addChild(card), {
			kinds: TSP_KINDS.filter(kind => kind !== "el"),
			features: FEATURES,
		});
		const h = harness;
		expect(h.findAll(n => n.k === "input" || n.k === "editor")).toEqual([]);
		const texts = h
			.findAll(n => n.k === "text" && n.id.startsWith(`${nativeComponentId(card)}.`))
			.map(n => (n.p as { text: string }).text);
		expect(texts).toContain("Name [Ada] [Email]\nLogo");
		expect(texts).toContain("line 1\nline 2");
	});

	it("shows the view's fallback, else the fields' text, in a plain terminal's rows", () => {
		const probe: Probe = {
			seen: [],
			view: () => [
				inputField({ value: "", placeholder: "Name" }, "name"),
				imageBytes(new Uint8Array([1]), "image/svg+xml", { alt: "Chart" }, "chart"),
			],
			describes: 0,
		};
		const plain = (card: ToolExecutionComponent): string => Bun.stripANSI(card.render(80).join("\n"));
		const ui: ToolExecutionUi = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const derived = new ToolExecutionComponent("form", {}, {}, probeTool(probe), ui, "/tmp", "call-a");
		derived.updateResult({ content: [{ type: "text", text: "raw result" }] }, false, "call-a");
		expect(plain(derived)).toContain("[Name]");
		expect(plain(derived)).toContain("Chart");
		expect(plain(derived)).not.toContain("raw result");

		const withFallback = new ToolExecutionComponent(
			"form",
			{},
			{},
			probeTool({ ...probe, fallback: "Type a name" }),
			ui,
			"/tmp",
			"call-b",
		);
		withFallback.updateResult({ content: [{ type: "text", text: "raw result" }] }, false, "call-b");
		expect(plain(withFallback)).toContain("Type a name");
	});
});

/** A distinct image of `size` bytes: `seed` picks its content. */
const picture = (seed: number, size = 64): Uint8Array => {
	const bytes = new Uint8Array(size).fill(seed % 251);
	new DataView(bytes.buffer).setUint32(0, seed);
	return bytes;
};

const blobSends = (h: TspHarness): number => h.terminal.log.filter(entry => entry.verb === "b").length;

describe("images from bytes in a tool view", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("draws a PNG and an SVG as blob images and uploads the same bytes once, however many cards or redescriptions", async () => {
		const png = picture(1, 300);
		const svg = new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
		);
		const view = (): readonly NativeChild[] => [
			imageBytes(png, "image/png", { alt: "Shot", w: 30, h: 20 }, "shot"),
			imageBytes(svg, "image/svg+xml", { alt: "Chart" }, "chart"),
			// A second description hands over a new buffer with the same content.
			imageBytes(png.slice(), "image/png", { alt: "Again" }, "again"),
		];
		const a = makeCard({ seen: [], view, describes: 0 }, "call-a");
		const b = makeCard({ seen: [], view, describes: 0 }, "call-b");
		harness = await start(
			tui => {
				tui.addChild(a);
				tui.addChild(b);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const images = (card: Component) =>
			h.findAll(n => n.k === "image" && n.id.startsWith(`${nativeComponentId(card)}.`)).map(n => n.p);
		const [shot, chart, again] = images(a);
		expect(shot).toMatchObject({ alt: "Shot", w: 30, h: 20 });
		expect(chart).toMatchObject({ alt: "Chart" });
		expect(again).toMatchObject({ alt: "Again" });
		expect((shot as { blob: string }).blob).toBe((again as { blob: string }).blob);
		expect((shot as { blob: string }).blob).not.toBe((chart as { blob: string }).blob);
		expect(images(b)).toEqual(images(a));
		// Two distinct pictures, six images, two uploads; the terminal holds exactly those two.
		expect(blobSends(h)).toBe(2);
		expect(h.terminal.blobs.size).toBe(2);

		ToolExecutionComponent.redescribe(ui, "form");
		await h.render();
		expect(blobSends(h)).toBe(2);
		expect(h.errors).toEqual([]);
	});

	it("replaces an image over a cap, a refused type or a fifth over the card's budget with its alt text", async () => {
		const big = TOOL_IMAGE_MAX_BYTES + 1;
		const hugeSvg = TOOL_SVG_MAX_BYTES + 1;
		const fit = Math.floor(TOOL_VIEW_IMAGE_MAX_BYTES / TOOL_IMAGE_MAX_BYTES);
		const view = (): readonly NativeChild[] => [
			imageBytes(picture(1, big), "image/png", { alt: "too big" }, "big"),
			imageBytes(picture(2, hugeSvg), "image/svg+xml", { alt: "too big svg" }, "svg"),
			imageBytes(picture(3, 10), "image/bmp", { alt: "bad type" }, "bmp"),
			imageBytes(new Uint8Array(0), "image/png", { alt: "empty" }, "empty"),
			...Array.from({ length: fit + 1 }, (_, i) =>
				imageBytes(picture(10 + i, TOOL_IMAGE_MAX_BYTES), "image/png", { alt: `fits ${i}` }, `fit${i}`),
			),
		];
		const card = makeCard({ seen: [], view, describes: 0 });
		harness = await start(tui => tui.addChild(card), { features: FEATURES });
		const h = harness;
		const own = (kind: string) => h.findAll(n => n.k === kind && n.id.startsWith(`${nativeComponentId(card)}.`));
		expect(own("image").map(n => (n.p as { alt: string }).alt)).toEqual(
			Array.from({ length: fit }, (_, i) => `fits ${i}`),
		);
		const shown = own("text").map(n => (n.p as { text: string }).text);
		expect(shown).toEqual(expect.arrayContaining(["too big", "too big svg", "bad type", "empty", `fits ${fit}`]));
		// Only what was drawn went over the wire.
		expect(blobSends(h)).toBe(fit);
	});

	it("forgets old blob ids past a bound, so a card that swaps pictures forever stays bounded, and sends one again if it returns", async () => {
		let n = 0;
		const probe: Probe = {
			seen: [],
			view: () => [imageBytes(picture(n), "image/png", { alt: `p${n}` }, "pic")],
			describes: 0,
		};
		const card = makeCard(probe);
		harness = await start(tui => tui.addChild(card), { features: FEATURES });
		const h = harness;
		const total = 600;
		for (n = 1; n < total; n++) {
			ToolExecutionComponent.redescribe(ui, "form");
			await h.until(() => (h.find(x => x.k === "image" && (x.p as { alt: string }).alt === `p${n}`) ? true : false));
		}
		expect(blobSends(h)).toBe(total);
		const before = blobSends(h);
		// The very first picture again: its id was forgotten, so it is sent again rather than assumed held.
		n = 0;
		ToolExecutionComponent.redescribe(ui, "form");
		await h.until(() => h.find(x => x.k === "image" && (x.p as { alt: string }).alt === "p0") !== undefined);
		expect(blobSends(h)).toBe(before + 1);
		// The newest one is still remembered.
		n = total - 1;
		ToolExecutionComponent.redescribe(ui, "form");
		await h.until(
			() => h.find(x => x.k === "image" && (x.p as { alt: string }).alt === `p${total - 1}`) !== undefined,
		);
		expect(blobSends(h)).toBe(before + 1);
	});
});

describe("bursts of redescribe requests", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("describes a card once for a whole burst, and not again for rows a native terminal never paints", async () => {
		let label = "0";
		const probe: Probe = {
			seen: [],
			view: () => [el("p", { text: label }, undefined, "label")],
			describes: 0,
			rowRenders: 0,
		};
		const card = makeCard(probe);
		harness = await start(tui => tui.addChild(card), { features: FEATURES });
		const h = harness;
		const textOfLabel = () =>
			(
				h.find(n => n.k === "el" && n.id.startsWith(`${nativeComponentId(card)}.`) && n.p?.tag === "p")!.p as {
					text: string;
				}
			).text;
		const before = probe.describes;
		const rowsBefore = probe.rowRenders;

		// 60 requests in one second's worth of ticks, no frame in between.
		for (let i = 1; i <= 60; i++) {
			label = String(i);
			ToolExecutionComponent.redescribe(ui, "form", "call-a");
			await Promise.resolve();
		}
		h.flush();
		expect(textOfLabel()).toBe("60");
		expect(probe.describes - before).toBe(1);
		// The tool's rows renderers (ANSI) are not run for a card the terminal draws natively.
		expect(probe.rowRenders).toBe(rowsBefore);

		// Rows catch up when something does paint them (a fallback after the surface is dropped).
		h.stop();
		const painted = Bun.stripANSI(card.render(80).join("\n"));
		expect(painted).toContain("result rows");
		expect(probe.rowRenders).toBeGreaterThan(rowsBefore!);
	});

	it("sends at most `credits` frames for a burst while the terminal holds its acks, then one with the latest state", async () => {
		let label = "0";
		const probe: Probe = { seen: [], view: () => [el("p", { text: label }, undefined, "label")], describes: 0 };
		const card = makeCard(probe);
		harness = await start(tui => tui.addChild(card), { features: FEATURES, autoAck: false, credits: 2 });
		const h = harness;
		h.terminal.ackAll();
		h.flush();
		const sent = h.frames.length;
		const before = probe.describes;

		for (let i = 1; i <= 60; i++) {
			label = String(i);
			ToolExecutionComponent.redescribe(ui, "form");
			await h.render();
		}
		// Two credits: two frames out, the other 58 requests wait (and are not described) until the terminal acks.
		expect(h.frames.length - sent).toBe(2);
		expect(probe.describes - before).toBeLessThanOrEqual(2);
		h.terminal.ackAll();
		h.flush();
		expect(h.frames.length - sent).toBe(3);
		expect(probe.describes - before).toBeLessThanOrEqual(3);
		const latest = h.find(n => n.k === "el" && n.id.startsWith(`${nativeComponentId(card)}.`) && n.p?.tag === "p");
		expect((latest!.p as { text: string }).text).toBe("60");
	});
});

describe("a finished card in the transcript that keeps changing", () => {
	beforeAll(async () => {
		await initTheme();
	});

	/** The ops of the frame a redescribe causes, with the card inside the transcript container (which settles finished blocks). */
	async function opsAfterRedescribe(hook: boolean): Promise<string[]> {
		let label = "0";
		const probe: Probe = { seen: [], view: () => [el("p", { text: label }, undefined, "label")], describes: 0 };
		const card = makeCard(probe);
		if (!hook) {
			// The same card, for a tool that has no `onNativeEvent`: it settles like every finished block.
			(card as unknown as { keepsNativeLive: () => boolean }).keepsNativeLive = () => false;
		}
		const transcript = new TranscriptContainer();
		transcript.addChild(card);
		harness = await start(tui => tui.addChild(transcript), { features: [...FEATURES, "settle"] });
		const h = harness;
		const before = h.frames.length;
		label = "1";
		ToolExecutionComponent.redescribe(ui, "form");
		await h.until(() => h.frames.length > before);
		return h.frames.at(-1)!.ops.map(op => op[0]);
	}

	it("changes a card whose tool answers events with a minimal diff, not a del and add of its whole body", async () => {
		expect(await opsAfterRedescribe(true)).toEqual(["set"]);
	});

	it("still settles a finished card the transcript has no reason to keep live", async () => {
		const ops = await opsAfterRedescribe(false);
		expect(ops).toContain("add");
		expect(ops).toContain("settle");
	});
});

describe("scroll position while a card is used", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("emits no reveal or scroll op for clicks, typing, Enter, Esc or redescribes of a card", async () => {
		let label = "0";
		const probe: Probe = {
			seen: [],
			view: () => [el("p", { text: label }, undefined, "label"), inputField({ value: "" }, "name")],
			describes: 0,
		};
		const composer = new Composer();
		const card = makeCard(probe);
		harness = await start(
			tui => {
				tui.addChild(card);
				tui.addChild(composer);
				tui.setFocus(composer);
			},
			{ features: [...FEATURES, "scroll"] },
		);
		const h = harness;
		const sf = h.terminal.surface!;
		const first = h.frames.length;
		h.event({ ev: "focus", sf, id: nodeOf(h, "input").id });
		for (const key of ["a", "b", "\r"]) h.terminal.send(key);
		h.flush();
		h.event({ ev: "focus", sf, id: nodeOf(h, "input").id });
		h.terminal.send("c");
		h.terminal.send("\x1b");
		for (let i = 1; i <= 20; i++) {
			label = String(i);
			ToolExecutionComponent.redescribe(ui, "form");
			await h.render();
		}
		expect(h.frames.length).toBeGreaterThan(first + 5);
		const kinds = h.frames.slice(first).flatMap(frame => frame.ops.map(op => op[0]));
		expect(kinds).not.toContain("reveal");
		expect(kinds).not.toContain("scroll");
	});
});

describe("pane visibility reported to a card's tool", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("tells the tool when the pane is hidden or shown again, once per change, without describing the card again", async () => {
		const probe: Probe = { seen: [], view: () => [el("p", { text: "live" }, undefined, "p")], describes: 0 };
		const plain: Probe = { seen: [], view: () => [], describes: 0 };
		const card = makeCard(probe, "call-a");
		// A card that shows no el view has nothing to pause.
		const quiet = makeCard(plain, "call-b");
		harness = await start(
			tui => {
				tui.addChild(card);
				tui.addChild(quiet);
			},
			{ features: FEATURES },
		);
		const h = harness;
		const sf = h.terminal.surface!;
		const describes = probe.describes;

		h.event({ ev: "visible", sf, visible: false });
		h.event({ ev: "visible", sf, visible: false });
		expect(probe.seen).toMatchObject([{ type: "visible", visible: false, key: "", toolCallId: "call-a" }]);
		h.event({ ev: "visible", sf, visible: true });
		expect(probe.seen.map(e => (e.type === "visible" ? e.visible : e.type))).toEqual([false, true]);
		expect(h.tui.terminalVisible).toBe(true);
		expect(probe.describes).toBe(describes);
		expect(plain.seen).toEqual([]);
	});
});
