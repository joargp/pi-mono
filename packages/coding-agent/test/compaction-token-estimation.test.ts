import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateContextTokens } from "../src/core/compaction/index.ts";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(text: string, timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

describe("estimateContextTokens with compaction boundaries", () => {
	it("ignores stale assistant usage that predates compaction timestamp", () => {
		const compactionTs = 1_000;
		const staleAssistantTs = 900;

		const messages: AgentMessage[] = [
			createCompactionSummaryMessage("summary", 26_314, new Date(compactionTs).toISOString()),
			createAssistantMessage("small retained text", staleAssistantTs, 26_314),
		];

		const estimate = estimateContextTokens(messages);

		expect(estimate.lastUsageIndex).toBeNull();
		expect(estimate.usageTokens).toBe(0);
		expect(estimate.tokens).toBeLessThan(26_314);
		expect(estimate.tokens).toBeGreaterThan(0);
	});

	it("uses assistant usage when it is newer than the latest compaction", () => {
		const compactionTs = 1_000;

		const messages: AgentMessage[] = [
			createCompactionSummaryMessage("summary", 26_314, new Date(compactionTs).toISOString()),
			createAssistantMessage("retained old message", 900, 26_314),
			createAssistantMessage("new response after compaction", 1_100, 2_048),
		];

		const estimate = estimateContextTokens(messages);

		expect(estimate.lastUsageIndex).toBe(2);
		expect(estimate.usageTokens).toBe(2_048);
		expect(estimate.trailingTokens).toBe(0);
		expect(estimate.tokens).toBe(2_048);
	});
});
