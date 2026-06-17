# AskPage

[![CI](https://github.com/bulletinmybeard/agent-forge-ask-page/actions/workflows/ci.yml/badge.svg)](https://github.com/bulletinmybeard/agent-forge-ask-page/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178c6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646cff.svg?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Biome](https://img.shields.io/badge/lint%2Fformat-Biome-60a5fa.svg?logo=biome&logoColor=white)](https://biomejs.dev/)
[![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4.svg?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate)
[![Requires AgentForge](https://img.shields.io/badge/requires-AgentForge-blueviolet)](https://github.com/bulletinmybeard/agent-forge)

> [!NOTE]
> **Experimental and personal.**
> AskPage is something I tinker with to see how far a browser front-end for AgentForge can go. It is early, lightly tested, and rough in the corners I haven't needed yet.
> Things will move and break. Poke at it, but don't build on it.

AskPage is a Chrome extension powered by a self-hosted [AgentForge](https://github.com/bulletinmybeard/agent-forge) instance, which provides the LLM and the tool calls. It is a thin client with no model or server of its own, so once AgentForge is running you can point it at any element (or the whole page) and ask an LLM anything about it.

Point at a section, a table, a nav element, an article. Or scan the entire page. Then ask in plain language: extract, summarise, list, translate, audit. AskPage captures a content-rich snapshot of what you picked and hands your question to an AgentForge agent that answers in Markdown right in the side panel.

```text
"summarise this article in 5 bullets"
"extract every product name and price from this list"
"list the third-party scripts on this page"
"is this form accessible? flag the issues"
"download all images into ~/site/images"
"extract all ollama models, their descriptions, and links to docs, and store them in a CSV file in my Downloads folder"
```

Because the prompt/question runs through the AgentForge agent loop (not a one-shot prompt), AskPage can do more than answer. It has the full tool registry available (web fetch, file download, ...) and asks for confirmation before anything with side effects.

## Architecture

- **Capture** (`lib/capture.ts`): a content script reads the picked element or `<body>` and builds a `PageSnapshot`. It carries rendered text, a tag outline, anchors, images, scripts, page meta (title, description, canonical, language, Open Graph, Twitter, icons, JSON-LD), and the environment (UA, viewport, timezone).
- **Conversation** (`lib/agent_ws.ts`): the snapshot + your question go over the AgentForge `/ws/chat` WebSocket, tagged `source: "ask-page"`. The agent loop runs with the full tool registry routed to the AgentForge workers. The answer streams back and renders as Markdown.
- **REST around it** (`lib/api.ts`): provider/model list (`/api/providers`), health check (`/api/health`), and file upload (`/api/upload/{session_id}`) for attaching a viewport screenshot.

No LLM-generated code ever runs in the page. Tool calls with side effects pass through the agent's confirm/secret gate before they execute.

## Scopes

| Scope | How | What it captures |
|:------|:----|:-----------------|
| Element | Pick element, hover-highlight, click an element | That element's text + outline, plus its anchors and images |
| Page | Ask whole page | `<body>` text + outline, page-wide anchors, images, and scripts |
| Auto-collect | Give a selector. AskPage scrolls and gathers | A flat list of every matching item (text, key attributes, href) across infinite-scroll / paginated lists |

Auto-collect is tunable on the options page (max items, max scrolls, idle threshold, timeout, wait between scrolls) for sites that lazy-load.

## Build

```sh
npm install
npm run build      # full build (typecheck + main + content)
```

Produces an unpacked extension in `dist/`.

For iterative development:

```sh
npm run dev:main      # main build in watch mode (background + popup + sidepanel + options)

# in another terminal:
npm run dev:content   # content script build in watch mode
```

The build runs in two passes: `vite.config.ts` bundles the background service worker (ESM) + popup + side panel + options page, and `vite.content.config.ts` bundles the content script as an IIFE (MV3 runs content scripts as classic scripts). Reload the extension in `chrome://extensions` after changes.

## Formatting & linting

[Biome](https://biomejs.dev/) handles both, pinned to an exact version in `package.json` so CI matches local output.

```sh
npm run check        # verify formatting + lint + import sorting (no writes)
npm run check:fix    # apply safe fixes
npm run format       # format only
npm run lint         # lint only
```

## Install

1. Build as per the section above.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. **Load unpacked** > select `dist/`.
5. Open **Options** and set the AgentForge base URL + (optional) API key, then pick a provider.
6. Click **Test connection** which should report `OK`.

Optional: bind a keyboard shortcut for inspect mode at `chrome://extensions/shortcuts` (the `toggle-inspect` command ships without a default).

## Configuration

Settings live in `chrome.storage.local`, edited on the options page:

| Setting | Default | Notes |
|:--------|:--------|:------|
| `agentforge_base_url` | `http://localhost:8100` | AgentForge base URL |
| `agentforge_token` | _(empty)_ | Optional API key. Rides as a WS subprotocol + `Authorization` header. Blank = no auth |
| `provider` | `ollama` | Selected provider. The model list comes from `/api/providers` |
| `collect_max_items` | `1000` | Auto-collect: stop after N items |
| `collect_max_scrolls` | `50` | Auto-collect: stop after N scrolls |
| `collect_idle` | `3` | Auto-collect: idle scrolls before stopping |
| `collect_timeout_s` | `60` | Auto-collect: hard time cap |
| `collect_wait_ms` | `1200` | Auto-collect: wait between scrolls |
| `confirm_on_nav` | `true` | Ask before discarding an active conversation when the page navigates or reloads |

## Permissions

| Permission | Reason |
|:-----------|:-------|
| `activeTab` | Read DOM on the current tab when you pick / scan |
| `scripting` | Inject the inspect overlay + capture |
| `storage` | Persist settings |
| `tabs` | Send messages to the active tab |
| `sidePanel` | The conversation UI surface |
| `<all_urls>` (host) | Pick / scan on any page |

No `debugger` permission. Keeps the "this extension is using debugger" warning bar off.

## Requirements

A running AgentForge stack reachable from the browser, exposing `/ws/chat`, `/api/providers`, `/api/health`, and `/api/upload/{session_id}`. See [AgentForge](https://github.com/bulletinmybeard/agent-forge).

## License

MIT, see [LICENSE](LICENSE).
