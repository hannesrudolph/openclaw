import { zstdDecompressSync } from "node:zlib";
import type { Api, Context, Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import { cleanupSessionResources } from "../session-resources.js";
import { resolveResponsesContextUsageBoundary } from "./openai-responses-context-usage.js";
import { createCompactionContext } from "./openai-responses-prompt-observer.test-support.js";

const initialHost = getAiTransportHost();

function createModel<TApi extends Api = "openai-responses">(
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } as Model<TApi>;
}

function createContext(systemPrompt: string, overrides: Partial<Context> = {}): Context {
  return {
    systemPrompt,
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools: [],
    ...overrides,
  } as Context;
}

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completedSseResponse(responseId = "resp_test"): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

beforeEach(() => {
  configureAiTransportHost(initialHost);
});

afterEach(() => {
  cleanupSessionResources();
  closeOpenAICodexWebSocketSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(initialHost);
});

describe("OpenAI Responses native prompt observer", () => {
  it("observes each native WebSocket connection-limit dispatch before send", async () => {
    const prompt = "PRIVATE-NATIVE-WEBSOCKET-PROMPT";
    const identity = { sessionId: "websocket-usage-session", authProfileId: "websocket-profile" };
    const model = createModel({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.test/backend-api",
    });
    const context = createCompactionContext(model, identity);
    context.systemPrompt = prompt;
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    const sentRequests: Array<Record<string, unknown>> = [];
    let connections = 0;
    class ConnectionLimitWebSocket extends EventTarget {
      private readonly limitReached = connections++ === 0;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        order.push("send");
        sentRequests.push(JSON.parse(payload) as Record<string, unknown>);
        const event = this.limitReached
          ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
          : {
              type: "response.completed",
              response: {
                id: "resp_ws",
                status: "completed",
                output: [],
                usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
              },
            };
        queueMicrotask(() => {
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
        });
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);
    vi.stubGlobal("fetch", vi.fn());
    const options = { apiKey: createJwt(), transport: "websocket" as const, ...identity };
    responsesPromptObserver.set(options, (observation) => {
      order.push("observe");
      observations.push(observation);
    });

    const result = await streamOpenAICodexResponses(model, context, options).result();

    expect(result.stopReason).toBe("stop");
    expect(
      resolveResponsesContextUsageBoundary(
        [...context.messages, result],
        model,
        identity,
        context.systemPrompt,
      ),
    ).toEqual({ index: context.messages.length, totalTokens: 8, suffix: [] });
    expect(connections).toBe(2);
    expect(order).toEqual(["observe", "send", "observe", "send"]);
    expect(sentRequests.map((request) => request.instructions)).toEqual([prompt, prompt]);
    expect(observations).toEqual([
      {
        egress: "native-codex-websocket",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
      {
        egress: "native-codex-websocket",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain(prompt);
  });

  it("forwards the private observer through simple options to final native SSE egress", async () => {
    const prompt = "PRIVATE-NATIVE-SSE-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    let sentRequest: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        order.push("fetch");
        const body =
          typeof init?.body === "string"
            ? init.body
            : zstdDecompressSync(init?.body as Uint8Array).toString("utf8");
        sentRequest = JSON.parse(body) as Record<string, unknown>;
        return completedSseResponse();
      }),
    );
    const options = {
      apiKey: createJwt(),
      transport: "sse" as const,
      onPayload: async (body: unknown) => {
        await Promise.resolve();
        return { ...(body as Record<string, unknown>), finalTransform: true };
      },
    };
    responsesPromptObserver.set(options, (observation) => {
      order.push("observe");
      observations.push(observation);
    });

    const result = await streamSimpleOpenAICodexResponses(
      createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.test/backend-api",
      }),
      createContext(prompt),
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(order).toEqual(["observe", "fetch"]);
    expect(sentRequest).toMatchObject({ instructions: prompt, finalTransform: true });
    expect(observations).toEqual([
      {
        egress: "native-codex-sse",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain(prompt);
  });
});
