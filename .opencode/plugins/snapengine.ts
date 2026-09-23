import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"

const PROVIDER_ID = "snapengine"
const DEFAULT_APP_ID = "com.huawei.testmate.codegenerator"
const DUMMY_API_KEY = "snapengine-auth-managed-by-plugin"

type PublicProvider = {
  options?: Record<string, unknown>
}

type StoredAuth =
  | { type: "api"; key: string }
  | { type: "oauth"; access: string; refresh?: string; expires?: number }
  | { type: string; [key: string]: unknown }

type ChoiceState = {
  role: string
  content: string[]
  reasoning: string[]
  toolCalls: Map<number, any>
  finishReason: string | null
  message?: Record<string, any>
}

function option(provider: PublicProvider, key: string) {
  const value = provider.options?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function getSnapURL(provider: PublicProvider) {
  const value = (process.env.SNAP_URL ?? "").trim() || option(provider, "snapURL")
  if (!value) {
    throw new Error(
      "SnapEngine URL is missing. Set provider.snapengine.options.snapURL in opencode.json or SNAP_URL.",
    )
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("SnapEngine URL must be an absolute http(s) URL.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SnapEngine URL must use http or https.")
  }

  return url.toString()
}

function getSDKBaseURL(snapURL: string) {
  const url = new URL(snapURL)
  const suffix = "/chat/completions"
  const path = url.pathname.replace(/\/+$/, "")
  if (path.endsWith(suffix)) {
    url.pathname = path.slice(0, -suffix.length) || "/"
    url.search = ""
    url.hash = ""
  }
  return url.toString().replace(/\/$/, "")
}

function getToken(auth: StoredAuth) {
  if (auth.type === "api" && typeof auth.key === "string" && auth.key.trim()) return auth.key.trim()
  if (auth.type === "oauth" && typeof auth.access === "string" && auth.access.trim()) return auth.access.trim()
  throw new Error("SnapEngine W3 credential is missing. Run: opencode auth login --provider snapengine")
}

function requestHeaders(input: RequestInfo | URL, init: RequestInit | undefined, token: string, provider: PublicProvider) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  }

  // @ai-sdk/openai-compatible requires an apiKey and injects Authorization.
  // SnapEngine does not use that bearer token; it uses x-auth-token instead.
  headers.delete("authorization")
  headers.set("content-type", "application/json")
  headers.set("x-auth-token", token)

  const appID = option(provider, "appId") || DEFAULT_APP_ID
  headers.set("app-id", appID)
  headers.set("X-HW-ID", option(provider, "hwId") || appID)
  headers.set("X-Snap-TraceID", randomUUID().replaceAll("-", ""))

  return headers
}

async function buildForwardInit(input: RequestInfo | URL, init?: RequestInit): Promise<RequestInit> {
  if (!(input instanceof Request)) return { ...init }

  const method = init?.method ?? input.method
  let body = init?.body

  if (body === undefined && method !== "GET" && method !== "HEAD") {
    body = await input.clone().arrayBuffer()
  }

  return {
    method,
    body,
    cache: init?.cache ?? input.cache,
    credentials: init?.credentials ?? input.credentials,
    integrity: init?.integrity ?? input.integrity,
    keepalive: init?.keepalive ?? input.keepalive,
    mode: init?.mode ?? input.mode,
    redirect: init?.redirect ?? input.redirect,
    referrer: init?.referrer ?? input.referrer,
    referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
    signal: init?.signal ?? input.signal,
    ...init,
  }
}

function bodyText(body: BodyInit | null | undefined) {
  if (body === undefined || body === null) return undefined
  if (typeof body === "string") return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  }
  return undefined
}

function requestMeta(init: RequestInit) {
  const raw = bodyText(init.body)
  if (!raw) return { stream: false, model: undefined as string | undefined }
  try {
    const parsed = JSON.parse(raw)
    return {
      stream: parsed?.stream === true,
      model: typeof parsed?.model === "string" ? parsed.model : undefined,
    }
  } catch {
    return { stream: false, model: undefined as string | undefined }
  }
}

function cleanResponseHeaders(source: Headers, contentType?: string) {
  const headers = new Headers(source)
  headers.delete("content-length")
  headers.delete("content-encoding")
  if (contentType) headers.set("content-type", contentType)
  return headers
}

function openAIErrorResponse(response: Response, body: string) {
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = undefined
  }

  if (parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object") {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: cleanResponseHeaders(response.headers, "application/json; charset=utf-8"),
    })
  }

  const errorCode =
    parsed && typeof parsed === "object" ? (parsed.error_code ?? parsed.code ?? undefined) : undefined
  const expired =
    response.status === 401 ||
    response.status === 403 ||
    body.includes("DEV.00000003") ||
    body.includes("认证信息过期")

  const upstreamMessage =
    parsed && typeof parsed === "object"
      ? (parsed.error_msg ?? parsed.message ?? body)
      : body || `SnapEngine HTTP ${response.status}`

  const message = expired
    ? `${upstreamMessage || "W3 authentication expired"}. Re-login with: opencode auth login --provider snapengine`
    : upstreamMessage

  return new Response(
    JSON.stringify({
      error: {
        message: String(message),
        type: expired ? "authentication_error" : "upstream_error",
        param: null,
        code: errorCode ?? null,
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: cleanResponseHeaders(response.headers, "application/json; charset=utf-8"),
    },
  )
}

function mergeToolCalls(target: Map<number, any>, fragments: unknown) {
  if (!Array.isArray(fragments)) return
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== "object") continue
    const item = fragment as any
    const index = Number.isInteger(item.index) ? item.index : 0
    const current =
      target.get(index) ??
      ({
        id: undefined,
        type: "function",
        function: { name: "", arguments: "" },
      } as any)

    if (item.id) current.id = item.id
    if (item.type) current.type = item.type
    if (item.function?.name) current.function.name += String(item.function.name)
    if (item.function?.arguments) current.function.arguments += String(item.function.arguments)
    target.set(index, current)
  }
}

function parseSSE(text: string) {
  const normalized = text.replace(/\r\n/g, "\n")
  const blocks = normalized.split(/\n\n+/)
  const payloads: string[] = []

  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
    if (data.length) payloads.push(data.join("\n").trim())
  }

  return payloads
}

function aggregateSSE(payloads: string[], requestedModel?: string) {
  let completionID: string | undefined
  let created = Math.floor(Date.now() / 1000)
  let model = requestedModel
  let usage: unknown
  let sawDone = false
  const states = new Map<number, ChoiceState>()

  for (const payload of payloads) {
    if (!payload) continue
    if (payload === "[DONE]") {
      sawDone = true
      continue
    }

    let event: any
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }

    if (event?.error) throw new Error(typeof event.error?.message === "string" ? event.error.message : "SnapEngine error")

    completionID = event?.id ?? completionID
    created = typeof event?.created === "number" ? event.created : created
    model = typeof event?.model === "string" ? event.model : model
    if (event?.usage !== undefined) usage = event.usage

    for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
      if (!choice || typeof choice !== "object") continue
      const index = Number.isInteger(choice.index) ? choice.index : 0
      const state =
        states.get(index) ??
        ({
          role: "assistant",
          content: [],
          reasoning: [],
          toolCalls: new Map<number, any>(),
          finishReason: null,
        } satisfies ChoiceState)

      if (choice.message && typeof choice.message === "object") {
        state.message = { ...choice.message }
      }

      const delta = choice.delta
      if (delta && typeof delta === "object") {
        if (typeof delta.role === "string") state.role = delta.role
        if (typeof delta.content === "string") state.content.push(delta.content)
        if (typeof delta.reasoning_content === "string") state.reasoning.push(delta.reasoning_content)
        mergeToolCalls(state.toolCalls, delta.tool_calls)
      }

      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        state.finishReason = String(choice.finish_reason)
      }
      states.set(index, state)
    }
  }

  if (!states.size) throw new Error("SnapEngine returned SSE without choices")
  if (!sawDone && [...states.values()].some((state) => state.finishReason === null)) {
    throw new Error("SnapEngine stream ended unexpectedly before finish_reason/[DONE]")
  }

  const choices = [...states.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, state]) => {
      const message: Record<string, any> = state.message ?? {
        role: state.role,
        content: state.content.join(""),
      }

      if (state.reasoning.length && message.reasoning_content === undefined) {
        message.reasoning_content = state.reasoning.join("")
      }
      if (state.toolCalls.size && message.tool_calls === undefined) {
        message.tool_calls = [...state.toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => call)
      }

      const finishReason =
        state.finishReason ?? (message.tool_calls && message.tool_calls.length ? "tool_calls" : "stop")

      return {
        index,
        message,
        finish_reason: finishReason,
      }
    })

  return {
    id: completionID ?? `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created,
    model: model ?? requestedModel ?? "snapengine",
    choices,
    ...(usage !== undefined ? { usage } : {}),
  }
}

function finishChunk(last: any, missing: number[], toolIndexes: Set<number>, requestedModel?: string) {
  return {
    id: last?.id ?? `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion.chunk",
    created: last?.created ?? Math.floor(Date.now() / 1000),
    model: last?.model ?? requestedModel ?? "snapengine",
    choices: missing.map((index) => ({
      index,
      delta: {},
      finish_reason: toolIndexes.has(index) ? "tool_calls" : "stop",
    })),
  }
}

function streamingResponse(response: Response, requestedModel?: string) {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const choiceIndexes = new Set<number>()
  const finishIndexes = new Set<number>()
  const toolIndexes = new Set<number>()
  let lastEvent: any
  let sawDone = false
  let buffer = ""

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (payload: string) => controller.enqueue(encoder.encode(`data: ${payload}\n\n`))

      const handleBlock = (block: string) => {
        if (sawDone) return
        const payload = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim()

        if (!payload) return
        if (payload === "[DONE]") {
          sawDone = true
          const missing = [...choiceIndexes].filter((index) => !finishIndexes.has(index))
          if (missing.length) emit(JSON.stringify(finishChunk(lastEvent, missing, toolIndexes, requestedModel)))
          emit("[DONE]")
          return
        }

        let event: any
        try {
          event = JSON.parse(payload)
        } catch {
          emit(payload)
          return
        }

        lastEvent = event
        for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
          if (!choice || typeof choice !== "object") continue
          const index = Number.isInteger(choice.index) ? choice.index : 0
          choiceIndexes.add(index)
          if (choice?.delta?.tool_calls || choice?.message?.tool_calls) toolIndexes.add(index)
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishIndexes.add(index)
        }
        emit(JSON.stringify(event))
      }

      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          buffer += decoder.decode(part.value, { stream: true })
          buffer = buffer.replace(/\r\n/g, "\n")

          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            handleBlock(block)
            boundary = buffer.indexOf("\n\n")
          }
        }

        buffer += decoder.decode()
        buffer = buffer.replace(/\r\n/g, "\n")
        if (buffer.trim()) handleBlock(buffer)

        if (!sawDone) {
          const missing = [...choiceIndexes].filter((index) => !finishIndexes.has(index))
          if (missing.length || choiceIndexes.size === 0) {
            throw new Error(
              `SnapEngine stream ended unexpectedly${missing.length ? `; missing finish_reason for choices ${missing.join(",")}` : ""}`,
            )
          }
          emit("[DONE]")
        }

        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })

  const headers = cleanResponseHeaders(response.headers, "text/event-stream; charset=utf-8")
  headers.set("cache-control", "no-cache")
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function nonStreamingResponse(response: Response, requestedModel?: string) {
  const text = (await response.text()).trim()
  if (!text) {
    return new Response(
      JSON.stringify({
        error: {
          message: "Empty response from SnapEngine",
          type: "upstream_error",
          param: null,
          code: null,
        },
      }),
      {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    )
  }

  try {
    JSON.parse(text)
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: cleanResponseHeaders(response.headers, "application/json; charset=utf-8"),
    })
  } catch {
    // SnapEngine may still return SSE even when stream=false.
  }

  try {
    const obj = aggregateSSE(parseSSE(text), requestedModel)
    return new Response(JSON.stringify(obj), {
      status: 200,
      headers: cleanResponseHeaders(response.headers, "application/json; charset=utf-8"),
    })
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "upstream_error",
          param: null,
          code: "snapengine_invalid_response",
        },
      }),
      {
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    )
  }
}

export async function SnapEnginePlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: PROVIDER_ID,
      loader: async (getAuth, provider) => {
        const publicProvider = provider as PublicProvider
        const snapURL = getSnapURL(publicProvider)

        return {
          // Satisfy @ai-sdk/openai-compatible's apiKey requirement. The plugin
          // removes its Authorization header and sends the real W3 token as
          // x-auth-token in the custom fetch below.
          apiKey: DUMMY_API_KEY,
          baseURL: getSDKBaseURL(snapURL),
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const prepared = await buildForwardInit(input, init)
            const meta = requestMeta(prepared)
            let auth = (await getAuth()) as StoredAuth
            let token = getToken(auth)

            const send = async (credential: string) => {
              const headers = requestHeaders(input, prepared, credential, publicProvider)
              return fetch(snapURL, { ...prepared, headers })
            }

            let response = await send(token)

            // Another login/refresh process may have replaced the credential while
            // this request was in flight. Retry only when the stored token changed.
            if (response.status === 401 || response.status === 403) {
              const latest = (await getAuth()) as StoredAuth
              const latestToken = getToken(latest)
              if (latestToken !== token) {
                await response.body?.cancel().catch(() => {})
                auth = latest
                token = latestToken
                response = await send(token)
              }
            }

            if (!response.ok) {
              const body = await response.text().catch(() => "")
              return openAIErrorResponse(response, body)
            }

            if (meta.stream) return streamingResponse(response, meta.model)
            return nonStreamingResponse(response, meta.model)
          },
        }
      },
      methods: [
        {
          type: "api",
          label: "W3 access token",
        },
      ],
    },
  }
}
