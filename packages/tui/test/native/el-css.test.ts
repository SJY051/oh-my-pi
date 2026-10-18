import { describe, expect, it } from "bun:test";
import { scopeStyleSheet, styleRootClass, styleScopeName, viewSheetCss } from "@oh-my-pi/pi-tui/native/el";

/**
 * What a CSS selector engine would select in a document, for the subset the
 * tests need: compounds of `*`, `.class` and `:is()/:not()` lists joined by
 * descendant, `>`, `+` and `~` combinators. The assertions are about which
 * elements a rule selects, never about how its text is spelled.
 */
interface Element {
	name: string;
	classes: Set<string>;
	parent?: Element;
	children: Element[];
}

function element(name: string, classes: string[], children: Element[] = []): Element {
	const el: Element = { name, classes: new Set(classes), children };
	for (const child of children) child.parent = el;
	return el;
}

function descendants(el: Element): Element[] {
	return el.children.flatMap(child => [child, ...descendants(child)]);
}

function splitTop(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "(" || text[i] === "[") depth++;
		else if (text[i] === ")" || text[i] === "]") depth--;
		else if (text[i] === separator && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

function matchesCompound(el: Element, compound: string): boolean {
	let rest = compound;
	while (rest !== "") {
		let m: RegExpExecArray | null;
		if ((m = /^\*/.exec(rest))) {
			// matches anything
		} else if ((m = /^\.([\w-]+)/.exec(rest))) {
			if (!el.classes.has(m[1]!)) return false;
		} else if ((m = /^:(is|not|where)\(([^)]*)\)/.exec(rest))) {
			const any = splitTop(m[2]!, ",").some(inner => matchesCompound(el, inner.trim()));
			if (m[1] === "not" ? any : !any) return false;
		} else if ((m = /^[a-z][\w-]*/.exec(rest))) {
			// A type selector: the test document only has divs, whose name is "div".
			if (el.name !== m[0]) return false;
		} else {
			throw new Error(`matcher does not support ${rest}`);
		}
		rest = rest.slice(m[0].length);
	}
	return true;
}

function matchesComplex(el: Element, tokens: string[]): boolean {
	const compound = tokens[tokens.length - 1]!;
	if (!matchesCompound(el, compound)) return false;
	if (tokens.length === 1) return true;
	const combinator = tokens[tokens.length - 2]!;
	const before = tokens.slice(0, -2);
	const siblings = el.parent?.children ?? [];
	const at = siblings.indexOf(el);
	switch (combinator) {
		case ">":
			return el.parent !== undefined && matchesComplex(el.parent, before);
		case "+":
			return at > 0 && matchesComplex(siblings[at - 1]!, before);
		case "~":
			return siblings.slice(0, at).some(s => matchesComplex(s, before));
		default:
			for (let up = el.parent; up; up = up.parent) if (matchesComplex(up, before)) return true;
			return false;
	}
}

/** `a > b c` → ["a", ">", "b", " ", "c"] */
function tokenize(selector: string): string[] {
	const tokens: string[] = [];
	let depth = 0;
	let current = "";
	let pendingSpace = false;
	const flush = (): void => {
		if (current !== "") tokens.push(current);
		current = "";
	};
	for (const c of selector.trim()) {
		if (c === "(" || c === "[") depth++;
		if (c === ")" || c === "]") depth--;
		if (depth === 0 && /\s/.test(c)) {
			flush();
			pendingSpace = true;
		} else if (depth === 0 && (c === ">" || c === "+" || c === "~")) {
			flush();
			tokens.push(c);
			pendingSpace = false;
		} else {
			if (pendingSpace && tokens.length > 0 && !">+~".includes(tokens[tokens.length - 1]!)) tokens.push(" ");
			pendingSpace = false;
			current += c;
		}
	}
	flush();
	return tokens;
}

/** Rules of `css` (flat rules and `@media` blocks): selector list text and declaration text. */
function rulesOf(css: string): { selectors: string; body: string }[] {
	const rules: { selectors: string; body: string }[] = [];
	let i = 0;
	while (i < css.length) {
		const open = css.indexOf("{", i);
		if (open === -1) break;
		let depth = 1;
		let j = open + 1;
		while (j < css.length && depth > 0) {
			if (css[j] === "{") depth++;
			else if (css[j] === "}") depth--;
			j++;
		}
		const prelude = css.slice(i, open).trim();
		const body = css.slice(open + 1, j - 1);
		if (prelude.startsWith("@media")) rules.push(...rulesOf(body));
		else if (!prelude.startsWith("@")) rules.push({ selectors: prelude, body });
		i = j;
	}
	return rules;
}

const name = "omp-test";
const inner = styleRootClass(name);

/** A transcript: a message before the card, the card (outer wrapper > root > content), a message after, and the composer. */
function page() {
	const a = element("div", ["a"], [element("div", ["b"])]);
	const c = element("div", ["c"]);
	const root = element("div", [inner], [a, c]);
	const outer = element("div", [name], [root]);
	const before = element("div", ["message", "sf-card"]);
	const after = element("div", ["message", "sf-card", "next"]);
	const composer = element("div", ["composer", "sf-dock"]);
	const main = element("div", ["sf-main"], [before, outer, after]);
	const surface = element("div", ["sf-surface"], [main, composer]);
	return { surface, outer, root, a, b: a.children[0]!, c, before, after, composer, main };
}

/** The elements of the page some rule of `css` selects. */
function selected(css: string): Set<Element> {
	const dom = page();
	const out = new Set<Element>();
	const all = [dom.surface, ...descendants(dom.surface)];
	for (const rule of rulesOf(css)) {
		for (const selector of splitTop(rule.selectors, ",")) {
			const tokens = tokenize(selector);
			for (const el of all) if (matchesComplex(el, tokens)) out.add(el);
		}
	}
	return out;
}

describe("scopeStyleSheet: what a tool's rules can select", () => {
	it("selects the card's own elements: the root, descendants, children, and the root's own compounds", () => {
		const css = ":root{a:b} body > .a{a:b} html .b{a:b} .c{a:b} :root.x{a:b} .a + .c{a:b}";
		const names = [...selected(scopeStyleSheet(css, inner))].map(el => [...el.classes].join("."));
		expect(names.sort()).toEqual([inner, "a", "b", "c"].sort());
	});

	it("never selects the wrapper, a sibling of the card, an ancestor, or the rest of the surface", () => {
		const hostile = [
			".sf-card { display: none }",
			".sf-main, .sf-surface, .composer, .sf-dock { display: none }",
			".message { display: none } .next { display: none }",
			`.${name} { display: none }`,
			"* { display: none }",
			":not(.zzz) { display: none }",
			":is(.sf-card, .composer) { display: none }",
			"+ .next { display: none } ~ .next { display: none } > .a { display: none }",
		].join("\n");
		const dom = page();
		const hit = selected(scopeStyleSheet(hostile, inner));
		// Whatever matched is the root element or below: an outside element or the wrapper is never selected.
		const allowed = new Set([dom.root, ...descendants(dom.root)].map(el => [...el.classes].join(".")));
		for (const el of hit) expect(allowed.has([...el.classes].join("."))).toBe(true);
		for (const el of hit) {
			expect(el.classes.has("message")).toBe(false);
			expect(el.classes.has("composer")).toBe(false);
			expect(el.classes.has(name)).toBe(false);
		}
	});

	it.each([
		[":root + * { display: none }"],
		[":root ~ * { display: none }"],
		["html + * { display: none }"],
		[":root:not(.zzz) + .next { display: none }"],
		["@media all { :root + * { display: none } }"],
		["@media all { @media all { body ~ .next { display: none } } }"],
	])("%s selects nothing outside the root element", css => {
		const hit = [...selected(scopeStyleSheet(css, inner))];
		expect(hit.filter(el => el.classes.has("message") || el.classes.has("composer") || el.classes.has(name))).toEqual(
			[],
		);
		expect(scopeStyleSheet(css, inner)).toBe("");
	});

	it("keeps `html > body ~ *` only as a rule about elements below the root (no body element exists there)", () => {
		const out = scopeStyleSheet("html > body ~ * { display: none }", inner);
		const hit = [...selected(out)].filter(
			el => el.classes.has("message") || el.classes.has("composer") || el.classes.has(name),
		);
		expect(hit).toEqual([]);
	});

	it.each([
		[":root { :is(&, *) { display: none } }"],
		[".a { & { display: none } }"],
		[":root { .a { x: y } }"],
		[".a { @media all { x: y } }"],
	])("drops a rule with a nested block: %s", css => {
		expect(scopeStyleSheet(css, inner)).toBe("");
	});

	it("keeps flat rules around a dropped nested rule", () => {
		const css = ".a { x: y } :root { :is(&, *) { x: y } } .c { x: y }";
		const names = [...selected(scopeStyleSheet(css, inner))].map(el => [...el.classes].join("."));
		expect(names.sort()).toEqual(["a", "c"]);
	});

	it.each([
		["an extra closing brace", ".a { x: y } } .sf-card { display: none }"],
		["an unclosed rule", ".a { x: y } .b { x: y"],
		["a raw newline inside a string", '.a { content: "\n} .sf-card { display: none } /* " */ }'],
		["an unterminated string", '.a { content: "abc }'],
		["an unterminated comment", ".a { x: y } /* .sf-card { display: none }"],
		["a backslash escape", ".a\\7b x { y: z }"],
		["a url()", ".a { background: url(x) }"],
		["a url() in a comment", "/* url( */ .a { x: y }"],
	])("drops the whole sheet for %s", (_label, css) => {
		expect(scopeStyleSheet(css, inner)).toBe("");
	});

	it("keeps a sheet whose strings and comments contain braces, and confines @keyframes, @media and what follows", () => {
		const css =
			'/* } */ .a { content: "}{" } @media (max-width: 600px) { .b { x: y } } @keyframes spin { from { x: y } to { x: z } } .c { x: y }';
		const out = scopeStyleSheet(css, inner);
		expect(out).toContain("@keyframes spin");
		expect([...selected(out)].map(el => [...el.classes].join(".")).sort()).toEqual(["a", "b", "c"]);
	});

	it("drops at-rules that load or reach beyond the card", () => {
		const css = '@import "x.css"; @font-face { font-family: x } @supports (a: b) { .a { x: y } } .c { x: y }';
		expect([...selected(scopeStyleSheet(css, inner))].map(el => [...el.classes].join("."))).toEqual(["c"]);
	});

	it("names a sheet by its text, so equal sheets are one sheet", () => {
		expect(styleScopeName(".a{x:y}")).toBe(styleScopeName(".a{x:y}"));
		expect(styleScopeName(".a{x:y}")).not.toBe(styleScopeName(".a{x:z}"));
		expect(styleScopeName(".a{x:y}")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});
});

describe("viewSheetCss: containment of what the card paints", () => {
	const overlay =
		":root { position: relative; top: -200px; width: 100vw; height: 100vh; z-index: 2147483647; background: red }";

	it("gives the wrapper the clip, isolation and positioning only omp sets, and no tool rule can select the wrapper", () => {
		const css = viewSheetCss(overlay, name);
		const dom = page();
		const forOuter = rulesOf(css).filter(rule =>
			splitTop(rule.selectors, ",").some(selector => {
				const tokens = tokenize(selector);
				return [dom.surface, ...descendants(dom.surface)].some(
					el => matchesComplex(el, tokens) && el.classes.has(name),
				);
			}),
		);
		expect(forOuter).toHaveLength(1);
		expect(forOuter[0]!.body).toContain("overflow:clip");
		expect(forOuter[0]!.body).toContain("isolation:isolate");
		expect(forOuter[0]!.body).toContain("position:relative");
		// The overlay payload lands on the root element, which sits inside the clipped wrapper.
		expect([...selected(css)].some(el => el.classes.has(inner))).toBe(true);
	});

	it("still clips the card when the tool's own sheet is unusable", () => {
		const css = viewSheetCss(".a { x: y } }", name);
		expect(css).toContain("overflow:clip");
		expect(rulesOf(css)).toHaveLength(1);
	});
});
