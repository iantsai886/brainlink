# ChatGPT connection through Secure MCP Tunnel

Status: documented manual setup; BrainLink does not create, configure, or verify the tunnel.

ChatGPT cannot launch BrainLink's local `stdio` MCP process on its own. OpenAI's Secure MCP Tunnel provides a separate tunnel client that can reach an MCP server running on the same computer without opening an inbound firewall port or publishing BrainLink directly to the internet.

## Before setup

- Confirm that the ChatGPT account/workspace supports custom MCP connections and developer mode. Availability and permissions depend on the current plan and workspace settings; check OpenAI's current help page.
- Create a tunnel in OpenAI Platform and obtain its tunnel ID and runtime API key. Never paste the key into chat, BrainLink notes, or GitHub.
- Decide which BrainLink Twin and vault permissions this connection should receive. Start with the least access needed.
- Accept that MCP requests and results pass through OpenAI. The local tunnel avoids an inbound public server, but it does not keep MCP payloads exclusively on this computer.

## Setup outline

1. In BrainLink Setup, configure and test the local BrainLink server and its Twin permissions first.
2. Follow OpenAI's [ChatGPT custom MCP setup](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) and [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
3. Install and configure the official [OpenAI tunnel client](https://github.com/openai/tunnel-client) using its [onboarding steps](https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md). Use the official profile format and commands; keep the runtime key in the supported local secret mechanism.
4. Point the tunnel's MCP child process to BrainLink's supported MCP server command and its scoped connection token. Do not broaden the Twin's vault permissions to make setup easier.
5. Keep the tunnel client running. In ChatGPT, add the custom MCP connection using the tunnel ID and complete the required authorization.
6. Start a new ChatGPT conversation, confirm the BrainLink tools are visible, and test a harmless search against a non-private test vault. Confirm denied access to an unapproved vault before using real data.

## Current BrainLink limits

The ChatGPT card in Setup links to the official setup material and explains the data flow. It intentionally remains **Manual setup**: BrainLink currently does not generate or validate a tunnel profile, install the tunnel client, provision Platform resources, hold the runtime API key, or prove that ChatGPT can call the local server. Therefore this UI must not claim ChatGPT is connected. A successful local BrainLink check also does not prove the remote tunnel is healthy.

OpenAI's account requirements, interface, tunnel client and role permissions may change. Re-check the official docs at setup time. Tunnel pricing was not established by this specification.
