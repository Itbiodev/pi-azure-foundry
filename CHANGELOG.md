# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `gatewayUrl` config option to route chat requests through an API Management gateway.
- `headers` config option to send extra HTTP headers on every chat request.
- Reasoning deltas (`reasoning_content`, `reasoning`, `reasoning_text`) on the OpenAI-compatible route are surfaced as thinking blocks.
- Converter regression tests (`npm test`).

### Fixed
- Sessions no longer break permanently after an interrupted turn. Histories now pass through pi-ai's `transformMessages` before conversion, which adds synthetic results for unanswered tool calls and drops empty assistant turns.
- Assistant `content` is always a string on the OpenAI route. A tool-call-only turn previously sent no content, which Azure rejects.
- A turn's tool results are merged into a single user message on the Anthropic route.
- Thinking blocks with empty text or no signature are no longer replayed on the Anthropic route.
- Removed a stray duplicate of the source under `.pi/extensions`.

## [1.0.3]

### Added
- Model metadata resolved from pi-ai's built-in catalogs, with per-model overrides via the `models` config key (#1).

## [1.0.0] - 2025-05-22

### Added
- Initial release.
