import { describe, expect, it } from "vitest";
import { APPROVAL_MAX_AGE_MS, type ApprovalLedger, defaultConfig } from "./config.js";
import {
	approvalMatches,
	approvalRequest,
	checkTrust,
	gatedAgents,
	pruneApprovals,
	recordApproval,
	storedApproval,
	withApprovals,
} from "./trust.js";
import type { AgentDefinition, PinnedAgent, SourceKind } from "./types.js";

const HASH = "abcdef0123456789".repeat(4);
const NOW = 1_700_000_000_000;

function makeAgent(kind: SourceKind, name = "reviewer", hash = HASH): PinnedAgent {
	const definition: AgentDefinition = {
		name,
		description: `${name} description`,
		tools: ["read"],
		toolsInheritance: "none",
		model: undefined,
		thinking: undefined,
		maxTurns: undefined,
		timeoutMs: undefined,
		tokenBudget: undefined,
		costBudget: undefined,
		isolation: "process",
		sandbox: "none",
		body: "body",
	};
	return {
		definition,
		source: {
			kind,
			path: `/agents/${name}.md`,
			directory: "/agents",
			trusted: kind === "global" || kind === "bundled",
		},
		hash,
		pinnedAt: NOW,
	};
}

describe("checkTrust", () => {
	it("always trusts bundled and global agents", () => {
		for (const kind of ["bundled", "global"] as const) {
			const decision = checkTrust(makeAgent(kind), { hasUI: false, approvals: {}, now: () => NOW });
			expect(decision.ok).toBe(true);
		}
	});

	it("asks for approval in an interactive session", () => {
		const decision = checkTrust(makeAgent("project"), { hasUI: true, approvals: {}, now: () => NOW });
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.needsApproval).toBe(true);
	});

	it("refuses in a headless session with no stored approval", () => {
		const decision = checkTrust(makeAgent("project"), { hasUI: false, approvals: {}, now: () => NOW });
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.needsApproval).toBe(false);
		expect(decision.refusal.reason).toBe("unapproved-project-agent");
	});

	it("accepts a matching stored approval headlessly", () => {
		const agent = makeAgent("project");
		const approvals = recordApproval({}, agent, NOW);
		const decision = checkTrust(agent, { hasUI: false, approvals, now: () => NOW + 1000 });
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		expect(decision.alreadyApproved).toBe(true);
	});

	it("refuses when the hash changed since approval", () => {
		const agent = makeAgent("project");
		const approvals = recordApproval({}, agent, NOW);
		const changed = { ...agent, hash: "f".repeat(64) };
		const decision = checkTrust(changed, { hasUI: false, approvals, now: () => NOW + 1000 });
		expect(decision.ok).toBe(false);
		if (decision.ok) return;
		expect(decision.refusal.reason).toBe("unapproved-project-agent");
	});

	it("refuses an expired approval", () => {
		const agent = makeAgent("project");
		const approvals = recordApproval({}, agent, NOW);
		const decision = checkTrust(agent, { hasUI: false, approvals, now: () => NOW + APPROVAL_MAX_AGE_MS + 1 });
		expect(decision.ok).toBe(false);
	});

	it("gates config-sourced agents too", () => {
		const decision = checkTrust(makeAgent("config"), { hasUI: false, approvals: {}, now: () => NOW });
		expect(decision.ok).toBe(false);
	});
});

describe("approvalRequest", () => {
	it("includes name, source, hash and tools, with no control characters", () => {
		const agent = makeAgent("project", "reviewer");
		agent.definition.description = "evil\u0007desc";
		const request = approvalRequest(agent);
		expect(request.fileName).toBe("reviewer.md");
		expect(request.directory).toBe("/agents");
		expect(request.summary).toContain("Agent: reviewer");
		expect(request.summary).toContain(HASH.slice(0, 12));
		expect(request.summary).not.toContain("\u0007");
	});

	it("shows inherit rules when tools is absent", () => {
		const agent = makeAgent("project");
		agent.definition.tools = undefined;
		expect(approvalRequest(agent).summary).toContain("(inherit rules)");
	});
});

describe("recordApproval", () => {
	it("is pure and keys by real directory and file name", () => {
		const agent = makeAgent("project");
		const before: ApprovalLedger = {};
		const after = recordApproval(before, agent, NOW);
		expect(before).toEqual({});
		expect(after["/agents"]["reviewer.md"]).toEqual({ hash: HASH, kind: "project", approvedAt: NOW });
	});

	it("replaces a stale hash for the same file", () => {
		const agent = makeAgent("project");
		const first = recordApproval({}, agent, NOW);
		const second = recordApproval(first, { ...agent, hash: "b".repeat(64) }, NOW + 5);
		expect(second["/agents"]["reviewer.md"].hash).toBe("b".repeat(64));
	});
});

describe("storedApproval / approvalMatches", () => {
	it("returns undefined for a missing directory or file", () => {
		expect(storedApproval({}, "/agents", "a.md", NOW)).toBeUndefined();
		expect(storedApproval({ "/agents": {} }, "/agents", "a.md", NOW)).toBeUndefined();
	});

	it("matches only on an exact hash", () => {
		expect(approvalMatches(undefined, HASH)).toBe(false);
		expect(approvalMatches({ hash: HASH, kind: "project", approvedAt: NOW }, HASH)).toBe(true);
		expect(approvalMatches({ hash: HASH, kind: "project", approvedAt: NOW }, "0".repeat(64))).toBe(false);
	});
});

describe("pruneApprovals", () => {
	it("drops approvals whose file no longer exists", () => {
		const live = makeAgent("project", "keep");
		const gone = makeAgent("project", "gone");
		let approvals = recordApproval({}, live, NOW);
		approvals = recordApproval(approvals, gone, NOW);

		const result = pruneApprovals(approvals, [live], NOW);
		expect(Object.keys(result.approvals["/agents"])).toEqual(["keep.md"]);
		expect(result.removed).toBe(1);
	});

	it("drops expired approvals", () => {
		const agent = makeAgent("project");
		const approvals = recordApproval({}, agent, NOW);
		const result = pruneApprovals(approvals, [agent], NOW + APPROVAL_MAX_AGE_MS + 1);
		expect(result.removed).toBe(1);
		expect(result.approvals).toEqual({});
	});

	it("keeps everything when nothing is stale", () => {
		const agent = makeAgent("project");
		const approvals = recordApproval({}, agent, NOW);
		const result = pruneApprovals(approvals, [agent], NOW + 1);
		expect(result.removed).toBe(0);
		expect(result.diagnostics).toEqual([]);
	});
});

describe("gatedAgents / withApprovals", () => {
	it("filters to untrusted sources", () => {
		const agents = [
			makeAgent("bundled", "a"),
			makeAgent("global", "b"),
			makeAgent("project", "c"),
			makeAgent("config", "d"),
		];
		expect(gatedAgents(agents).map((a) => a.definition.name)).toEqual(["c", "d"]);
	});

	it("replaces the ledger without mutating the config", () => {
		const config = defaultConfig();
		const next = withApprovals(config, recordApproval({}, makeAgent("project"), NOW));
		expect(config.approvals).toEqual({});
		expect(next.approvals["/agents"]["reviewer.md"].hash).toBe(HASH);
	});
});
