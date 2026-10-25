# Local MCP music reads

MCP music access is off by default. Enable the API Server plugin, then **MCP music access → Enable MCP music access**. The main process owns a separate HTTP listener at `http://127.0.0.1:26539/mcp` (`mcpPort` changes the port). Expanded REST music access can remain off. Both transports use the same music service, renderer controller, caches, and physical request broker.

Use **MCP music access → Create client grant…** to choose the read permissions and explicitly copy the credential. Credentials last 24 hours and can be revoked from the same native menu. The credential stays in the main process and clipboard; it is never shown in a dialog renderer or stored in settings. REST credentials and MCP credentials have separate transport and exact-URL audiences.

A manual-header SDK client can connect as follows. Supply the token from your own secret input; do not put it in a URL or commit it to a configuration file.

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:26539/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
);
const client = new Client({ name: 'local-music-client', version: '1' });
await client.connect(transport);
const tools = await client.listTools();
const current = await client.callTool({ name: 'music_now_playing', arguments: {} });
await transport.terminateSession();
await client.close();
```

The nine tools are `music_now_playing`, `music_get_queue`, `music_search`, `music_browse`, `music_home`, `music_get_library_playlists`, `music_lyrics`, `music_related`, and `music_comments`. `tools/list` returns only tools covered by the authenticated grant. The five read permissions are `playback.read`, `catalog.read`, `personalized.read`, `library.read`, and `comments.read`. A grant with no permissions can initialize and list an empty set. Initialization, listing, and ping do not access the music source.

Arguments have strict object schemas. Cursor, selector, limit, nested target, and explicit public-WEB comment fallback rules match the expanded music service. Calls return a fixed text summary with useful data in `structuredContent`, or a fixed bounded error. The 16 mutation tools and operation-status tool remain a follow-on unit; this candidate does not provide all 26 tools.

Only literal loopback HTTP and `/mcp` are accepted. Every POST and DELETE requires the bearer, exact Host, and its owned session. Non-initialization requests require the negotiated `MCP-Protocol-Version` (`2025-11-25` or `2025-06-18`). POST accepts one JSON-RPC object, requires both JSON and event-stream Accept types, and returns JSON. Browser Origin, forwarded authority, batches, GET/SSE/resumption, OAuth, and remote access are outside this profile.

Sessions are limited to 16 globally and four per grant, with 15-minute idle and one-hour absolute lifetimes. Active request IDs are limited to four per session, eight per grant, and 32 globally. Numeric and string IDs are distinct, including numeric zero. The most recent 128 completed IDs remain unavailable for up to two minutes; older completed labels are evicted without limiting the number of requests a live session can complete. Clients should use fresh IDs rather than reuse completed labels. This bounds routing tombstones independently of the SDK's patched JSON cleanup. HTTP connections/transactions are capped at 64; headers at 16 KiB, input at 64 KiB, logical tool results at 256 KiB, and staged or queued output at 4 MiB globally. Responses are rejected rather than truncated.

Authenticated cancellation affects only its matching active request, including numeric zero. The cancellation notification receives empty HTTP 202. Its original request completes through normal SDK JSON send with fixed error `-32800`; this is a deliberate exception to the protocol's SHOULD-not-respond cancellation guidance, allowing the original JSON POST and HTTP resources to finish while other requests stay live. Client-local cancellation alone is not proof of HTTP completion. Source physical slots remain governed by the shared broker's settlement/tombstone rules.

The final writer checks original service, grant epoch, source, request, session, listener, frame admission, and time lifetimes after SDK awaits and sanitization. A retired success is not delivered. Reconfiguration, listener loss, native frame retirement, committed revoke, DELETE, and shutdown retire owned sessions.

This is an uncommitted R9 production candidate with isolated public SDK/loopback fixture evidence. Native application acceptance, dependency notices and packaging, platform/manual clients, root review, and the remaining 17 tools are still open. It is not a full-26 acceptance statement.
