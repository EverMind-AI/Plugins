# EverOS memory for ChatGPT and Codex

This is the EverOS plugin for the OpenAI plugin directory. It has one skill and one remote MCP server.

EverOS is the context and memory layer for your organization's AI agents. The plugin lets ChatGPT and Codex save to and read from one memory space in your EverOS account.

EverOS is not EverMe. EverMe is EverMind's work memory for people and the AI tools they use. It is built on EverOS and listed separately, with its own account.

## What it does

- Saves a fact, preference or decision when you share one worth keeping.
- Searches memories from earlier conversations.
- Reads the profile EverOS built from your memories.
- Lists stored memories, newest first.
- Deletes what the current conversation stored when you ask.

## Sign in

The plugin connects to `https://everos-mcp.evermind.ai/mcp` and signs you in to your EverOS account with OAuth (Dynamic Client Registration, PKCE S256). It stores no credential. On the consent page you choose the memory space the assistant may use. Revoke access under Connected Apps in the EverOS Console at https://everos.evermind.ai.

## Data this plugin sends

The plugin sends data to one destination: EverMind's own EverOS API.

- A save sends the text the assistant saves and a session id.
- A search sends the search query.

The server refuses saves that look like credentials. It never requests the full conversation.

## Delete your data

- **One conversation:** ask the assistant to forget what this conversation saved.
- **Everything:** delete the memory space in the EverOS Console.

Docs: https://docs.evermind.ai/cloud/mcp
Privacy policy: https://evermind.ai/privacy-policy
Support: https://evermind.ai/contact-us
