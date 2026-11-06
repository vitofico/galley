# OpenAI GPT-6 models

Choose an OpenAI-compatible provider and model `gpt-6.1-terra`. For a hosted
installation, use proxy transport with upstream ID `openai`. The proxy injects
its `UPSTREAM_OPENAI_KEY` server-side; no provider credential belongs in the
browser configuration.

GPT-6 tool calls use OpenAI's Responses API. The model client selects that
protocol for GPT-6 models at `api.openai.com`, or through the named `openai`
proxy upstream. Other model endpoints retain Chat Completions. Generation,
streaming and connection probes use the same adapter. Responses are sent with
`store: false`; tool execution and document acceptance remain in Galley's
existing agent loop.
