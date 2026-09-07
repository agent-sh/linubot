# Provider connections

Open **Settings → Provider & credentials → Add connection**, choose a preset
and finish its sign-in or key setup. Select a model, save the connection and use
**Test connection** for a short real request. Testing uses your account and may
incur provider charges.

Saved connections remain available together. **Save connection** leaves the
app default unchanged; **Save and use as default** also changes the default for
bots following it. In a bot's **Model, skills & preferences**, select its own
provider and model. Changing the default does not disconnect other providers.

Model dropdowns query the selected service: a compatible models endpoint for
API providers, or Codex's model catalog for ChatGPT. Enter a custom model ID
when discovery is unavailable. Model availability, tools, images and limits
depend on your endpoint and account.

## Choose a connection method

| Provider | Connection method |
| --- | --- |
| OpenAI / ChatGPT | Browser sign-in or existing login through the installed Codex CLI |
| OpenAI API | API key for the standard Responses API |
| Anthropic | Claude Console API key |
| Google Gemini API | API key; optional OAuth with your own Google Desktop client and quota project |
| Qwen Token Plan / Coding Plan | Plan API key, or read-through of a matching Qwen Code configuration |
| Z.ai Coding Plan / API | API key for the matching plan endpoint |
| xAI | Browser device sign-in, selected Hermes xAI login, or API key |
| OpenRouter | Browser PKCE callback or API key |
| Meta / Muse Code | Existing Muse Code Model API credential or API key |
| Local and custom endpoints | API key, bearer token, x-api-key or no authentication as supported |

A consumer subscription and an API key are different access methods. Linubot
offers browser sign-in only for the implemented flows below.

## OpenAI / ChatGPT through Codex

Install the [official Codex CLI](https://developers.openai.com/codex/cli) and
make `codex` available on the desktop app's `PATH`. If it is elsewhere, set
`LINUBOT_CODEX_BIN` to its executable before launching Linubot.

Choose **OpenAI / ChatGPT sign-in**. Reuse your existing Codex login, or start
browser sign-in and complete the native Codex callback. Codex owns login and
refresh-token storage. Linubot uses its local
[app-server authentication and model APIs](https://developers.openai.com/codex/app-server)
without starting a Codex coding task.

These connections follow the installed CLI's selected ChatGPT account. Browser
sign-in can change that CLI account too. They do not create independent copies
of Codex refresh credentials. Access tokens are confined to the Codex endpoint;
an account change during a running task is rejected rather than silently moving
its context to another identity.

Choose the separate **OpenAI** API preset to use a standard API key at
`https://api.openai.com/v1`. A ChatGPT subscription does not make that endpoint
a subscription API.

## Anthropic

Choose **Anthropic**, obtain an API key from
[Claude Console](https://platform.claude.com/settings/keys), and save it using
the Messages format. The preset supplies the standard endpoint and API version.

Linubot does not offer consumer Claude login or import Claude Code subscription
tokens. Anthropic directs third-party products to API-key or supported cloud
authentication; see its
[authentication and credential policy](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

For another Anthropic-compatible service, use a custom endpoint with the
authentication that service requires.

## Google Gemini API

The shortest setup is **Google Gemini (OpenAI API)** with an
[API key from Google AI Studio](https://ai.google.dev/gemini-api/docs/api-key).
This uses Google's documented
[OpenAI-compatible endpoint](https://ai.google.dev/gemini-api/docs/openai).

For OAuth, choose **Google Gemini OAuth** and configure your own Google Cloud
project:

1. Enable the Generative Language API and configure the OAuth consent screen.
2. Create an OAuth client of type **Desktop app**, with the account allowed by
   that project's consent configuration.
3. Supply its downloaded client JSON and the project ID to use for API quota
   and billing.
4. Open browser sign-in, authorize access and return to Linubot.

Linubot uses a one-use loopback callback with PKCE and sends the configured quota
project with API requests. No shared publisher OAuth client is bundled. Advanced
launch configuration can supply `LINUBOT_GOOGLE_CLIENT_ID`,
`LINUBOT_GOOGLE_CLIENT_SECRET` and `LINUBOT_GOOGLE_PROJECT_ID`.

This is Gemini **API** OAuth with your project, not Gemini CLI or a consumer
Gemini subscription. Linubot does not read Gemini CLI tokens. Follow Google's
[OAuth setup guide](https://ai.google.dev/gemini-api/docs/oauth) for project
permissions and consent requirements. An API key remains the simpler setup.

## Qwen Token Plan and Coding Plan

Select the preset matching your plan and region, then enter its API key. If
Qwen Code already has that plan configured, its connection option reads the
matching entry from `~/.qwen/settings.json` without rewriting the source.

The reader requires a supported `modelProviders.openai` entry with the matching
base URL and environment-key name. It uses `BAILIAN_TOKEN_PLAN_API_KEY` for
Token Plan or `BAILIAN_CODING_PLAN_API_KEY` for Coding Plan, from the environment
or Qwen Code's settings. The selected model is reused when it belongs to that
plan. This remains a reference to the local configuration, so later key changes
there are followed.

Current Qwen Code documentation uses API keys for these plans and marks its old
free OAuth flow discontinued. Linubot does not revive cached Qwen OAuth tokens.
See [Qwen Code authentication](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md).

## Z.ai Coding Plan

Choose **Z.ai Coding Plan** and enter the plan's API key. Its OpenAI-compatible
base is `https://api.z.ai/api/coding/paas/v4`. The general **Z.ai API** preset
uses `https://api.z.ai/api/paas/v4`.

Use the Coding Plan for coding work allowed by your plan and supported tools;
use the general API for other scenarios. These are distinct endpoints.
Z.ai documents the
[coding-tool configuration](https://docs.z.ai/devpack/tool/others) and
[API authentication](https://docs.z.ai/guides/develop/http/introduction).

## Other browser and local sign-ins

- **xAI OAuth:** the app opens the device sign-in and polls for completion.
  Selecting an existing Hermes xAI sign-in keeps refresh ownership with Hermes.
- **OpenRouter:** its supported
  [PKCE flow](https://openrouter.ai/docs/guides/overview/auth/oauth) returns through
  a local callback. Linubot exchanges the one-use code and stores the resulting
  credential. Cancelled or invalid callbacks cannot save a connection.
- **Meta / Muse Code:** sign in with `muse login`, then select the existing
  Muse Code connection. Linubot reads its Meta Model API key, follows key changes
  and leaves the source configuration unchanged. It does not import Muse's
  account access token. See
  [Meta API fundamentals](https://github.com/meta-models/meta-model-cookbook/blob/main/01_api_fundamentals/README.md).

Completing a browser flow returns focus to Linubot. Account consent remains on
the provider's own page.

## Prepared API endpoints

| Preset | API base | Format |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | Responses |
| Anthropic | `https://api.anthropic.com/v1` | Messages |
| xAI API | `https://api.x.ai/v1` | Responses |
| OpenRouter | `https://openrouter.ai/api/v1` | Chat Completions |
| Meta / Muse Code | `https://api.meta.ai/v1` | Chat Completions |
| Google Gemini API | `https://generativelanguage.googleapis.com/v1beta/openai` | Chat Completions |
| Qwen Token Plan | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | Chat Completions |
| Qwen Coding Plan international | `https://coding-intl.dashscope.aliyuncs.com/v1` | Chat Completions |
| Qwen Coding Plan China | `https://coding.dashscope.aliyuncs.com/v1` | Chat Completions |
| Z.ai Coding Plan | `https://api.z.ai/api/coding/paas/v4` | Chat Completions |
| Z.ai API | `https://api.z.ai/api/paas/v4` | Chat Completions |
| Groq | `https://api.groq.com/openai/v1` | Chat Completions |
| Together AI | `https://api.together.ai/v1` | Chat Completions |
| DeepSeek | `https://api.deepseek.com/v1` | Chat Completions |
| Mistral | `https://api.mistral.ai/v1` | Chat Completions |
| Ollama | `http://localhost:11434/v1` | Chat Completions |
| LM Studio | `http://localhost:1234/v1` | Chat Completions |
| Local server / vLLM | `http://localhost:8000/v1` | Chat Completions |

Custom endpoints support Chat Completions, Responses, Anthropic Messages and
bearer Converse. Remote endpoints require HTTPS; loopback services can use HTTP.
No-auth local servers need no dummy key. Converse model IDs are entered manually.
Native sign-in endpoints are fixed and cannot forward those tokens to custom
servers.

## Storage and validation

Connection settings contain no API keys. Keys stay in memory or use encrypted
Linux keyring-backed storage when available. OAuth credential storage follows
the connection method; Codex and borrowed logins retain their source application's
ownership rules. An unavailable keyring can require signing in again after restart.

Changing an endpoint or authentication clears the old credential binding.
Removing a connection used by a bot is refused until the bot is reassigned.
Provider continuation data is bound to the connection, model and account; it is
not displayed as chat text.

Tests use controlled protocol and callback fixtures. Those checks establish
request shape, credential separation and cancellation behavior, not live consent
or model entitlement for every account. Use Test connection with the intended
account and see [validation](VALIDATION.md) for broader acceptance checks.

Provider references and endpoint configuration were checked September 7, 2026.
