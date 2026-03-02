const express = require("express");
const fs = require("fs");
const https = require("https");
const crypto = require("crypto");

require('dotenv').config({ quiet: true });

// --- Configuration ---
// port and ssl configuration will be determined at server start based on environment variables
const OPENAI_BASE_URL = (
    process.env.A2O_OPENAI_BASE_URL || "https://api.openai.com/v1"
).replace(/\/+$/, "");
let OPENAI_API_KEY; // defined later during server start 
const OPENAI_MODEL = process.env.A2O_OPENAI_MODEL || "gpt-4o";
// Optional model mapping: map Anthropic model names to specific OpenAI models via JSON in A2O_MODEL_MAP env var
// Example: A2O_MODEL_MAP='{"claude-3-5-sonnet-20241022":"gpt-4o-mini"}'
// Validate and parse model mapping on startup
const MODEL_MAP = (() => {
    const raw = process.env.A2O_MODEL_MAP;
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
            console.error('A2O_MODEL_MAP must be a JSON object');
            return {};
        }
        // Ensure all values are non-empty strings
        const invalid = Object.entries(parsed).filter(
            ([k, v]) => typeof k !== 'string' || typeof v !== 'string' || v.trim() === ''
        );
        if (invalid.length) {
            console.error('A2O_MODEL_MAP contains invalid entries:', invalid);
            return {};
        }
        return parsed;
    } catch (e) {
        console.error('Failed to parse A2O_MODEL_MAP JSON', e);
        return {};
    }
})();

const app = express();
app.use(express.json({limit: "50mb"}));

// ---------- helpers ----------

function genId(prefix = "msg") {
    // Generate a 24‑character hex identifier (12 bytes → 24 hex chars)
    return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** Map Anthropic stop_reason ← OpenAI finish_reason */
function mapFinishReason(reason) {
    switch (reason) {
        case "stop":
            return "end_turn";
        case "length":
            return "max_tokens";
        case "content_filter":
            return "end_turn";
        default:
            return "end_turn";
    }
}

// ---------- request conversion ----------

/**
 * Convert an Anthropic Messages API request body into an OpenAI
 * Chat Completions request body.
 */
function anthropicToOpenAI(body) {
    const messages = [];

    // Anthropic "system" field → OpenAI system message
    if (body.system) {
        if (typeof body.system === "string") {
            messages.push({role: "system", content: body.system});
        } else if (Array.isArray(body.system)) {
            // system can be an array of content blocks
            const text = body.system
                .map((b) => (typeof b === "string" ? b : b.text || ""))
                .join("\n");
            messages.push({role: "system", content: text});
        }
    }

    // Convert messages
    for (const msg of body.messages || []) {
        // Only "user" and "assistant" roles are expected from Anthropic API
        // System prompts are handled separately via body.system
        let role;
        if (msg.role === "assistant") {
            role = "assistant";
        } else if (msg.role === "user") {
            role = "user";
        } else {
            console.warn(`Unexpected role "${msg.role}" in message, treating as "user"`);
            role = "user";
        }
        let content;

        if (typeof msg.content === "string") {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            // Convert Anthropic content blocks → OpenAI content parts
            const parts = [];
            for (const block of msg.content) {
                if (block.type === "text") {
                    parts.push({type: "text", text: block.text});
                } else if (block.type === "image") {
                    // Anthropic image block → OpenAI image_url
                    const src = block.source;
                    if (src && src.type === "base64") {
                        parts.push({
                            type: "image_url",
                            image_url: {
                                url: `data:${src.media_type};base64,${src.data}`,
                            },
                        });
                    } else if (src && src.type === "url") {
                        parts.push({
                            type: "image_url",
                            image_url: {url: src.url},
                        });
                    }
                }
                // tool_use / tool_result blocks are handled below
                else if (block.type === "tool_use") {
                    // Will be handled as a separate assistant tool_calls message
                } else if (block.type === "tool_result") {
                    // Will be handled as a tool message
                }
            }
            // Check for tool_use blocks in assistant messages
            if (role === "assistant") {
                const toolUseBlocks = msg.content.filter(
                    (b) => b.type === "tool_use"
                );
                if (toolUseBlocks.length > 0) {
                    const textParts = parts.filter((p) => p.type === "text");
                    const textContent =
                        textParts.length === 1
                            ? textParts[0].text
                            : textParts.length > 1
                                ? textParts
                                : null;
                    messages.push({
                        role: "assistant",
                        content: textContent,
                        tool_calls: toolUseBlocks.map((tu) => ({
                            id: tu.id,
                            type: "function",
                            function: {
                                name: tu.name,
                                arguments: JSON.stringify(tu.input),
                            },
                        })),
                    });
                    continue; // skip the normal push below
                }
            }

            // Check for tool_result blocks in user messages
            if (role === "user") {
                const toolResults = msg.content.filter(
                    (b) => b.type === "tool_result"
                );
                if (toolResults.length > 0) {
                    // Push any text parts first as a user message
                    const textParts = parts.filter((p) => p.type === "text");
                    if (textParts.length > 0) {
                        messages.push({
                            role: "user",
                            content:
                                textParts.length === 1 ? textParts[0].text : textParts,
                        });
                    }
                    // Then push each tool result
                    for (const tr of toolResults) {
                        let resultContent;
                        if (typeof tr.content === "string") {
                            resultContent = tr.content;
                        } else if (Array.isArray(tr.content)) {
                            resultContent = tr.content
                                .map((b) => (typeof b === "string" ? b : b.text || ""))
                                .join("\n");
                        } else {
                            resultContent = "";
                        }
                        messages.push({
                            role: "tool",
                            tool_call_id: tr.tool_use_id,
                            content: resultContent,
                        });
                    }
                    continue;
                }
            }

            content =
                parts.length === 1 && parts[0].type === "text"
                    ? parts[0].text
                    : parts.length > 0
                        ? parts
                        : null;
        } else {
            content = null;
        }

        // Only push message if it has non-empty content
        if (content !== null && content !== "" && content !== undefined) {
            messages.push({role, content});
        }
    }

    // Determine which OpenAI model to use (allow mapping from Anthropic model name)
    let mappedModel = MODEL_MAP[body.model];
    const selectedModel = mappedModel || OPENAI_MODEL;
    if (mappedModel) {
        console.log(`Using OpenAI model ${selectedModel} (mapped from Anthropic model ${body.model})`);
    } else {
        console.log(`Using OpenAI model ${selectedModel} (default)`);
    }

    const openaiReq = {
        model: selectedModel,
        messages,
        stream: !!body.stream,
    };

    if (body.max_tokens != null) openaiReq.max_tokens = body.max_tokens;
    if (body.temperature != null) openaiReq.temperature = body.temperature;
    if (body.top_p != null) openaiReq.top_p = body.top_p;
    if (body.stop_sequences)
        openaiReq.stop = body.stop_sequences;

    // Tool definitions
    if (body.tools && body.tools.length > 0) {
        openaiReq.tools = body.tools.map((t) => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description || "",
                parameters: t.input_schema || {},
            },
        }));
    }

    if (body.stream) {
        openaiReq.stream_options = {include_usage: true};
    }

    return openaiReq;
}

// ---------- response conversion (non-streaming) ----------

function openAIToAnthropic(openaiRes, requestModel) {
    const choice = openaiRes.choices?.[0];
    const msg = choice?.message || {};

    const content = [];

    if (msg.content) {
        content.push({type: "text", text: msg.content});
    }

    // Tool calls
    if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
            let args;
            try {
                args = JSON.parse(tc.function.arguments);
            } catch {
                args = {};
            }
            content.push({
                type: "tool_use",
                id: tc.id,
                name: tc.function.name,
                input: args,
            });
        }
    }

    const stopReason = msg.tool_calls
        ? "tool_use"
        : mapFinishReason(choice?.finish_reason);

    return {
        id: genId("msg"),
        type: "message",
        role: "assistant",
        content,
        model: requestModel || openaiRes.model || OPENAI_MODEL,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: openaiRes.usage?.prompt_tokens || 0,
            output_tokens: openaiRes.usage?.completion_tokens || 0,
        },
    };
}

// ---------- streaming conversion ----------

/**
 * Read an OpenAI SSE stream and re-emit Anthropic SSE events on `res`.
 */
async function streamOpenAIToAnthropic(openaiResponse, res, requestModel) {
    const msgId = genId("msg");

    let contentBlockStarted = false;
    let blockIndex = 0;
    let toolCallAccum = {}; // id -> { id, name, argsJson }
    let stopReason = "end_turn";
    let inputTokens = 0;
    let outputTokens = 0;
    let messageStartSent = false;

    const reader = openaiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    function sendMessageStart() {
        if (messageStartSent) return;
        messageStartSent = true;
        const messageStart = {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: requestModel || OPENAI_MODEL,
            stop_reason: null,
            stop_sequence: null,
            usage: {input_tokens: inputTokens, output_tokens: outputTokens},
        };
        sendSSE(res, "message_start", {type: "message_start", message: messageStart});
    }

    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith("data: ")) continue;
                const data = trimmed.slice(6);
                if (data === "[DONE]") continue;

                let chunk;
                try {
                    chunk = JSON.parse(data);
                } catch {
                    continue;
                }

                const choice = chunk.choices?.[0];
                const delta = choice?.delta;

                // Capture usage from any chunk that has it
                if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens || 0;
                    outputTokens = chunk.usage.completion_tokens || 0;
                }

                // Send message_start on first relevant chunk if not already sent
                if (!messageStartSent && (delta || choice?.finish_reason)) {
                    sendMessageStart();
                }

                if (!delta && !choice?.finish_reason) continue;

                // --- Text content ---
                if (delta && delta.content) {
                    if (!contentBlockStarted) {
                        sendSSE(res, "content_block_start", {
                            type: "content_block_start",
                            index: blockIndex,
                            content_block: {type: "text", text: ""},
                        });
                        contentBlockStarted = true;
                    }
                    sendSSE(res, "content_block_delta", {
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {type: "text_delta", text: delta.content},
                    });
                }

                // --- Tool calls ---
                if (delta && delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!toolCallAccum[idx]) {
                            // Only start the block if we have the required id and name
                            if (tc.id && tc.function?.name) {
                                // Close text content block if open
                                if (contentBlockStarted) {
                                    sendSSE(res, "content_block_stop", {
                                        type: "content_block_stop",
                                        index: blockIndex,
                                    });
                                    blockIndex++;
                                    contentBlockStarted = false;
                                }

                                toolCallAccum[idx] = {
                                    id: tc.id,
                                    name: tc.function.name,
                                    argsJson: "",
                                    blockIndex: blockIndex,
                                };

                                sendSSE(res, "content_block_start", {
                                    type: "content_block_start",
                                    index: blockIndex,
                                    content_block: {
                                        type: "tool_use",
                                        id: tc.id,
                                        name: tc.function.name,
                                        input: {},
                                    },
                                });
                                blockIndex++;
                            }
                            // If we don't have complete info yet, accumulate partial data
                            else {
                                toolCallAccum[idx] = {
                                    id: tc.id || null,
                                    name: tc.function?.name || "",
                                    argsJson: tc.function?.arguments || "",
                                    blockIndex: null, // Will be set when block starts
                                };
                            }
                        } else {
                            // Update accumulated data
                            if (tc.id) toolCallAccum[idx].id = tc.id;
                            if (tc.function?.name) toolCallAccum[idx].name = tc.function.name;

                            // If the block hasn't been started yet, but now we have complete info, start it
                            if (toolCallAccum[idx].blockIndex === null && toolCallAccum[idx].id && toolCallAccum[idx].name) {
                                // Close text content block if open
                                if (contentBlockStarted) {
                                    sendSSE(res, "content_block_stop", {
                                        type: "content_block_stop",
                                        index: blockIndex,
                                    });
                                    blockIndex++;
                                    contentBlockStarted = false;
                                }

                                toolCallAccum[idx].blockIndex = blockIndex;

                                sendSSE(res, "content_block_start", {
                                    type: "content_block_start",
                                    index: blockIndex,
                                    content_block: {
                                        type: "tool_use",
                                        id: toolCallAccum[idx].id,
                                        name: toolCallAccum[idx].name,
                                        input: {},
                                    },
                                });
                                // Flush any buffered arguments
                                const bufferedArgs = toolCallAccum[idx].argsJson;
                                if (bufferedArgs) {
                                    sendSSE(res, "content_block_delta", {
                                        type: "content_block_delta",
                                        index: blockIndex,
                                        delta: {
                                            type: "input_json_delta",
                                            partial_json: bufferedArgs,
                                        },
                                    });
                                }
                                blockIndex++;
                            }
                        }

                        if (tc.function?.arguments && toolCallAccum[idx].blockIndex !== null) {
                            toolCallAccum[idx].argsJson += tc.function.arguments;
                            sendSSE(res, "content_block_delta", {
                                type: "content_block_delta",
                                index: toolCallAccum[idx].blockIndex,
                                delta: {
                                    type: "input_json_delta",
                                    partial_json: tc.function.arguments,
                                },
                            });
                        }
                    }
                }

                if (choice?.finish_reason) {
                    if (Object.keys(toolCallAccum).length > 0) {
                        stopReason = "tool_use";
                    } else {
                        stopReason = mapFinishReason(choice.finish_reason);
                    }
                }
            }
        }
    } catch (err) {
        console.error("Stream reading error:", err);
    }

    // Close any open content block
    if (contentBlockStarted) {
        sendSSE(res, "content_block_stop", {
            type: "content_block_stop",
            index: blockIndex,
        });
    }
    // Close tool call blocks
    for (const tc of Object.values(toolCallAccum)) {
        sendSSE(res, "content_block_stop", {
            type: "content_block_stop",
            index: tc.blockIndex,
        });
    }

    // Ensure message_start was sent (edge case: empty stream)
    sendMessageStart();

    // message_delta with stop_reason and usage
    sendSSE(res, "message_delta", {
        type: "message_delta",
        delta: {stop_reason: stopReason, stop_sequence: null},
        usage: {input_tokens: inputTokens, output_tokens: outputTokens},
    });

    sendSSE(res, "message_stop", {type: "message_stop"});
    res.end();
}

function sendSSE(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ---------- main route ----------

app.post("/v1/messages", async (req, res) => {
    try {
        const anthropicBody = req.body;
        console.log("--- Incoming Anthropic request ---");
        console.log(JSON.stringify(anthropicBody, null, 2));
        const openaiBody = anthropicToOpenAI(anthropicBody);
        console.log("--- Converted OpenAI request ---");
        console.log(JSON.stringify(openaiBody, null, 2));

        const headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
        };

        const openaiRes = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(openaiBody),
        });

        if (!openaiRes.ok) {
            const errText = await openaiRes.text();
            console.error(`OpenAI API error ${openaiRes.status}: ${errText}`);
            return res.status(openaiRes.status).json({
                type: "error",
                error: {
                    type: "api_error",
                    message: `Upstream error: ${errText}`,
                },
            });
        }

        if (anthropicBody.stream) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            await streamOpenAIToAnthropic(openaiRes, res, anthropicBody.model);
        } else {
            const openaiJson = await openaiRes.json();
            const anthropicRes = openAIToAnthropic(openaiJson, anthropicBody.model);
            res.json(anthropicRes);
        }
    } catch (err) {
        console.error("Proxy error:", err);
        res.status(500).json({
            type: "error",
            error: {
                type: "api_error",
                message: err.message,
            },
        });
    }
});

// Health check
app.get("/health", (_req, res) => res.json({status: "ok"}));

// ---------- exports ----------

module.exports = {
    app,
    anthropicToOpenAI,
    openAIToAnthropic,
    startServer,
};

/**
 * Starts the proxy server.
 *
 * This function contains the logic that was previously guarded by
 * `if (require.main === module)`. It reads SSL configuration, validates the
 * OpenAI API key, creates either an HTTPS or HTTP server, logs the start‑up
 * messages, and returns the underlying `http.Server`/`https.Server` instance
 * so callers can shut it down (useful for in‑process tests).
 *
 * The function is exported for use in tests; when the file is executed
 * directly (`node index.js`) we simply call it.
 */
function startServer() {
    // Initialize SSL if configuration is provided
    let sslOptions = null;
    const SSL_KEY_PATH = process.env.A2O_SSL_KEY_PATH || "";
    const SSL_CERT_PATH = process.env.A2O_SSL_CERT_PATH || "";

    if (SSL_KEY_PATH && SSL_CERT_PATH) {
        try {
            sslOptions = {
                key: fs.readFileSync(SSL_KEY_PATH),
                cert: fs.readFileSync(SSL_CERT_PATH),
            };
        } catch (e) {
            console.error('Failed to load SSL key/cert', e);
        }
    }

    OPENAI_API_KEY = process.env.A2O_OPENAI_API_KEY || "";
    if (!OPENAI_API_KEY) {
        console.error("A2O_OPENAI_API_KEY environment variable is required");
        process.exit(1);
    }

    let server;
    const port = parseInt(process.env.A2O_PROXY_PORT || "3456", 10);
    if (sslOptions) {
        server = https.createServer(sslOptions, app).listen(port, () => {
            console.log(`anthropic2openai proxy listening on https://localhost:${port}`);
        });
    } else {
        server = app.listen(port, () => {
            console.log(`anthropic2openai proxy listening on http://localhost:${port}`);
        });
    }
    console.log(`Forwarding to: ${OPENAI_BASE_URL}/chat/completions`);
    console.log(`Using model: ${OPENAI_MODEL}`);
    return server;
}

if (require.main === module) {
    startServer();
}
