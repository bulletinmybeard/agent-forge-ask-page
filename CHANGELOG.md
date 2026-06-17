# Changelog

All notable changes to AskPage are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-18

### Added

- **Scope bar** in the side panel with "Pick element" and "Whole page" re-scan buttons
- **URL-aware side panel** that detects page navigation and reloads, shows a "Page changed" banner
- **Conversation protection** toggle (default ON) that prompts before discarding an active conversation on page change
- Conversation preservation on manual re-scan (scope bar buttons keep chat history)

### Changed

- Move connection settings (Base URL, API key, Provider, Save, Test connection) from popup to options page
- Simplify popup to two action buttons ("Pick element", "Ask whole page") and a "Settings..." link
- Rename buttons: "Toggle inspect" to "Pick element", "Scan page" to "Ask whole page"
- Add `history_char_limit` query override for larger DOM snapshots
- Update agent framing and follow-up prefix

## [0.1.0] - 2026-06-06

Initial public release.

### Added

- Chrome MV3 extension with side panel conversation UI
- Element-scope and page-scope snapshot capture
- AgentForge WebSocket agent conversation (`/ws/chat`)
- Auto-collect: scroll-and-gather items by CSS selector for lazy-loaded lists
- Provider/model picker from `/api/providers`
- Viewport screenshot attachment (vision-capable models)
- Tool confirmation and sudo secret prompt gates
- Options page with auto-collect tuning knobs
- Keyboard shortcut for inspect mode (`toggle-inspect` command)
- Biome lint/format, TypeScript strict mode, CI workflow
