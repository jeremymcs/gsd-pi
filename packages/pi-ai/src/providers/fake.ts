import { readFileSync } from "node:fs";
import type { ApiProvider } from "../api-registry.js";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ToolCall,
	UserMessage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";

export const FAKE_API = "fake" as const;

interface ExpectFields {
	modelId?: string;
	messageCount?: number;
	lastUserText?: string;
	systemContains?: string[];
	toolNames?: string[];
	hasToolResultFor?: string;
}

type EmitSpec =
	| { kind: "text"; text: string; stopReason?: "stop" | "length" }
	| {
			kind: "tool_use";
			calls: { id?: string; name: string; input: Record<string, unknown> }[];
			stopReason?: "toolUse";
	  }
	| { kind: "error_429"; message?: string; retryAfterMs?: number }
	| { kind: "malformed"; message?: string }
	| { kind: "timeout"; delayMs?: number };

interface TranscriptTurn {
	turn: number;
	expect?: ExpectFields;
	emit: EmitSpec;
}

function parseTranscript(transcriptPath: string): TranscriptTurn[] {
	const raw = readFileSync(transcriptPath, "utf8");
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	return lines.map((line, index) => {
		try {
			return JSON.parse(line) as TranscriptTurn;
		} catch (error) {
			throw new Error(
				`fake-llm: failed to parse transcript ${transcriptPath} line ${index + 1}: ${
					error instanceof Error ? error.message : String(error)
				}\n  line: ${line}`,
			);
		}
	});
}

function lastUserMessage(context: Context): UserMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role === "user") return message;
	}
	return undefined;
}

function getUserText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function checkExpectations(model: Model<typeof FAKE_API>, context: Context, turn: TranscriptTurn): void {
	const expected = turn.expect;
	if (!expected) return;

	const fail = (message: string): never => {
		const detail = {
			turn: turn.turn,
			modelId: model.id,
			messageCount: context.messages.length,
			lastUserText: lastUserMessage(context)
				? getUserText(lastUserMessage(context)!).slice(0, 200)
				: null,
			toolNames: context.tools?.map((tool) => tool.name) ?? [],
		};
		throw new Error(`fake-llm: turn ${turn.turn} expectation mismatch: ${message}\n  actual: ${JSON.stringify(detail)}`);
	};

	if (expected.modelId !== undefined && model.id !== expected.modelId) {
		fail(`expected modelId=${expected.modelId}, got ${model.id}`);
	}
	if (expected.messageCount !== undefined && context.messages.length !== expected.messageCount) {
		fail(`expected messageCount=${expected.messageCount}, got ${context.messages.length}`);
	}
	if (expected.lastUserText !== undefined) {
		const lastMessage = lastUserMessage(context);
		if (!lastMessage) fail(`expected lastUserText to contain "${expected.lastUserText}", but no user messages found`);
		const text = getUserText(lastMessage!);
		if (!text.includes(expected.lastUserText)) {
			fail(`expected lastUserText to contain "${expected.lastUserText}", got "${text.slice(0, 200)}"`);
		}
	}
	if (expected.systemContains) {
		const systemPrompt = context.systemPrompt ?? "";
		for (const needle of expected.systemContains) {
			if (!systemPrompt.includes(needle)) fail(`expected systemPrompt to contain "${needle}"`);
		}
	}
	if (expected.toolNames) {
		const actual = (context.tools ?? []).map((tool) => tool.name).sort();
		const desired = [...expected.toolNames].sort();
		if (actual.length !== desired.length || actual.some((tool, index) => tool !== desired[index])) {
			fail(`expected toolNames=${JSON.stringify(desired)}, got ${JSON.stringify(actual)}`);
		}
	}
	if (expected.hasToolResultFor !== undefined) {
		const lastMessage = context.messages[context.messages.length - 1];
		if (!lastMessage || lastMessage.role !== "toolResult" || lastMessage.toolName !== expected.hasToolResultFor) {
			fail(`expected last message to be a toolResult for "${expected.hasToolResultFor}"`);
		}
	}
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function buildAssistantMessage(model: Model<typeof FAKE_API>, emit: EmitSpec): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let stopReason: AssistantMessage["stopReason"] = "stop";

	if (emit.kind === "text") {
		content.push({ type: "text", text: emit.text });
		stopReason = emit.stopReason ?? "stop";
	} else if (emit.kind === "tool_use") {
		for (const [index, call] of emit.calls.entries()) {
			const toolCall: ToolCall = {
				type: "toolCall",
				id: call.id ?? `fake-tool-${Date.now()}-${index}`,
				name: call.name,
				arguments: call.input,
			};
			content.push(toolCall);
		}
		stopReason = "toolUse";
	}

	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

export function createFakeProvider(opts: { transcriptPath: string }): ApiProvider<typeof FAKE_API> {
	const transcript = parseTranscript(opts.transcriptPath);
	let cursor = 0;

	function nextTurn(): TranscriptTurn {
		if (cursor >= transcript.length) {
			throw new Error(
				`fake-llm: provider invoked ${cursor + 1} times but transcript only has ${transcript.length} turns. Add another turn to ${opts.transcriptPath}.`,
			);
		}
		return transcript[cursor++];
	}

	function streamTurn(model: Model<typeof FAKE_API>, context: Context): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		const turn = nextTurn();
		checkExpectations(model, context, turn);

		queueMicrotask(async () => {
			try {
				const emit = turn.emit;
				if (emit.kind === "error_429" || emit.kind === "malformed" || emit.kind === "timeout") {
					if (emit.kind === "timeout") {
						await new Promise((resolve) => setTimeout(resolve, emit.delayMs ?? 60_000));
					}
					const errorMessage =
						emit.kind === "error_429"
							? emit.message ?? "rate_limit_exceeded"
							: emit.kind === "malformed"
								? emit.message ?? "malformed_response"
								: "timeout";
					const message: AssistantMessage = {
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: emptyUsage(),
						stopReason: "error",
						errorMessage,
						retryAfterMs: emit.kind === "error_429" ? emit.retryAfterMs : undefined,
						timestamp: Date.now(),
					};
					stream.push({ type: "error", reason: "error", error: message });
					stream.end(message);
					return;
				}

				const message = buildAssistantMessage(model, emit);
				stream.push({ type: "start", partial: { ...message, content: [] } });

				if (emit.kind === "text") {
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: emit.text, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: emit.text, partial: message });
				} else {
					for (const [index, content] of message.content.entries()) {
						if (content.type !== "toolCall") continue;
						stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: content, partial: message });
					}
				}

				stream.push({
					type: "done",
					reason: message.stopReason as "stop" | "length" | "toolUse" | "pauseTurn",
					message,
				});
				stream.end(message);
			} catch (error) {
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: emptyUsage(),
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				};
				stream.push({ type: "error", reason: "error", error: message });
				stream.end(message);
			}
		});

		return stream;
	}

	return {
		api: FAKE_API,
		stream: ((model: Model<typeof FAKE_API>, context: Context, _options?: StreamOptions) =>
			streamTurn(model, context)) as ApiProvider<typeof FAKE_API>["stream"],
		streamSimple: ((model: Model<typeof FAKE_API>, context: Context, _options?: SimpleStreamOptions) =>
			streamTurn(model, context)) as ApiProvider<typeof FAKE_API>["streamSimple"],
	};
}
