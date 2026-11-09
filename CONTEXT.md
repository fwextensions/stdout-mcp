# stdout-mcp

Lets developers and coding agents read the console output of Chrome extensions under development, without keeping those extensions' background scripts active.

## Language

**stdout extension**:
The helper Chrome extension that stores console output from the extensions being debugged.
_Avoid_: helper, remote extension

**MCP server**:
The installable product that coding agents are configured to use. It's made up of the relay and the daemon.
_Avoid_: log server

**Daemon**:
The single process on a machine that holds logs and answers tools for every agent session.
_Avoid_: server, log server

**Relay**:
The per-session process that connects one agent to the daemon.

**Extension Link**:
The conversation between the stdout extension and the daemon: what each may say to the other, and in what order.
_Avoid_: protocol (which means the MCP protocol), sync protocol, wire format

**Sync position**:
The last entry from the stdout extension's buffer that the daemon holds, numbered by the extension.
_Avoid_: maxSeq, extensionSeq, serverSeq, afterSeq

**Cursor**:
A place in the daemon's own numbering of entries, which agents pass back to read only what's newer. It's unrelated to the sync position.
_Avoid_: maxSeq, offset
