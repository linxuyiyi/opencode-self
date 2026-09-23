# SnapEngine project-level plugin

This integration lets OpenCode call SnapEngine directly. No localhost OpenAI proxy and no OpenCode rebuild are required.

## Install

Copy:

```text
.opencode/plugins/snapengine.ts
```

into the target project's `.opencode/plugins/` directory.

Merge the `provider.snapengine` block from `.opencode/snapengine.example.jsonc` into the project's `opencode.json` or `.opencode/opencode.jsonc`.

Set `options.snapURL` to the complete SnapEngine chat-completions endpoint, for example:

```text
http://host/api/v2/chat/completions
```

Alternatively, set environment variable `SNAP_URL`. It takes precedence over the config value.

## Login

Store the W3 access token through OpenCode's own auth store:

```bash
opencode auth login --provider snapengine
```

Choose `W3 access token` and paste the token when prompted.

OpenCode stores the credential in its normal auth store. The plugin never writes the token into `opencode.json`.

## Request behavior

For every SnapEngine request the plugin:

- removes the dummy OpenAI `Authorization` header;
- sends the W3 token as `x-auth-token`;
- sends `app-id` and `X-HW-ID`;
- creates a fresh `X-Snap-TraceID`;
- rewrites the AI SDK request to the exact configured `snapURL`;
- keeps OpenAI-compatible SSE/tool-call semantics;
- injects missing `finish_reason` only when SnapEngine explicitly sends `[DONE]`;
- treats an unexpected SSE EOF without `finish_reason` as a failure;
- aggregates an SSE-delta response when SnapEngine returns SSE for a non-streaming request;
- converts upstream HTTP errors to an OpenAI-shaped error payload.

The default app id is:

```text
com.huawei.testmate.codegenerator
```

It can be overridden with `provider.snapengine.options.appId`; `hwId` can also be overridden separately.

## Current authentication boundary

This version does not implement the private W3 login protocol itself because that protocol is not present in the OpenCode repository or the supplied proxy implementation. It integrates the W3 access token into OpenCode's native auth workflow.

A future W3 device/browser login can be added inside the same plugin without changing the provider configuration or reintroducing the localhost proxy.
