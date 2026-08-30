# agy-agent-acp

Agent Client Protocol (ACP) adapter for Google Antigravity CLI (`agy`).

## Overview

`agy-agent-acp` implements the JSON-RPC 2.0 Agent Client Protocol (ACP) over `stdio`, allowing headless orchestration frameworks (such as Solace Buzz `buzz-acp`) to seamlessly drive the Google Antigravity CLI (`agy`) engine.

## Features

- **Standard ACP Wire Protocol**: Handles `initialize`, `session/new`, `session/prompt`, `session/cancel`, and `session/close`.
- **Streaming Response Integration**: Spawns `agy` in subprocess streaming mode (`--input-format stream-json --output-format stream-json`) and translates delta events into ACP `agent_message_chunk` and `tool_call` updates.
- **Configurable Context**: Injects system prompt files and tracks conversation workspace IDs.

## Installation

```bash
npm install -g agy-agent-acp
```

Or build from source:

```bash
npm install
npm run build
npm pack
npm install -g agy-agent-acp-*.tgz
```

## Usage

```bash
agy-agent-acp
```

The adapter communicates via JSON-RPC 2.0 on standard input and standard output.

## License

MIT
