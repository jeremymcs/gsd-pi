import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getApiProvider } from "../src/api-registry.ts";

describe("fake LLM registration", () => {
	const originalTranscript = process.env.GSD_FAKE_LLM_TRANSCRIPT;

	afterEach(() => {
		if (originalTranscript === undefined) {
			delete process.env.GSD_FAKE_LLM_TRANSCRIPT;
		} else {
			process.env.GSD_FAKE_LLM_TRANSCRIPT = originalTranscript;
		}
	});

	it("registers the fake model and provider when a transcript is configured", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "fake-llm-registration-"));
		const transcriptPath = join(tempDir, "transcript.jsonl");
		writeFileSync(transcriptPath, `${JSON.stringify({ turn: 1, emit: { kind: "text", text: "ok" } })}\n`);
		process.env.GSD_FAKE_LLM_TRANSCRIPT = transcriptPath;

		const models = await import("../src/models.ts?fake-model");
		const registerBuiltins = await import("../src/providers/register-builtins.ts?fake-provider");

		registerBuiltins.resetApiProviders();

		expect(models.getProviders()).toContain("gsd-fake");
		expect(models.getModel("gsd-fake" as any, "gsd-fake-model" as any)).toMatchObject({
			id: "gsd-fake-model",
			api: "fake",
			provider: "gsd-fake",
		});
		expect(getApiProvider("fake")).toBeDefined();

		rmSync(tempDir, { recursive: true, force: true });
	});
});
