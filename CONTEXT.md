# stdout-mcp

Lets developers and coding agents read the console output of Chrome extensions under development, without keeping those extensions' background scripts active.

## Language

**stdout extension**:
The helper Chrome extension that stores console output from the extensions being debugged.
_Avoid_: helper, remote extension

**Tap**:
The code that runs inside the extension being debugged, once it calls `stdout()`. It captures that extension's console calls and sends them to the stdout extension, and reloads the extension when asked.
_Avoid_: library, client, proxy, forwarder

**Tap Link**:
The conversation between a tap and the stdout extension: what each may say to the other.
_Avoid_: messages, payload

**MCP server**:
The installable product that coding agents are configured to use. It's made up of the relay and the daemon.
_Avoid_: log server

**Daemon**:
The single process on a machine that holds logs and answers tools for every agent session, from every browser.
_Avoid_: server, log server

**Relay**:
The per-session process that connects one agent to the daemon.

**Browser**:
One install of the stdout extension, in one profile of one browser, identified by its buffer ID. Chrome and Edge are two browsers, and so are two profiles of the same Chrome. Agents see it by the name the user gave it in the stdout extension's options, or by its brand and version, like "Edge 146".
_Avoid_: profile, client, instance

**Daemon Link**:
The conversation between the stdout extension and the daemon: what each may say to the other, and in what order.
_Avoid_: Extension Link, protocol (which means the MCP protocol), sync protocol, wire format

**Value tag**:
A labeled object that stands in for a console value JSON can't carry, like a Map or an Error.
_Avoid_: `__type` object, serialized value

**Agent mode**:
The setting, turned on from the stdout extension's toolbar icon, that lets the stdout extension send its logs to the daemon and take commands from it. Logs are stored whether or not it's on.

**Check-in**:
A periodic wake-up during agent mode, when the stdout extension offers the daemon anything it's missing, even if nothing new has been logged.

**Daemon connection**:
The stdout extension's ongoing effort, during agent mode, to keep the daemon caught up and answer its commands. It's either off, looking for the daemon, or connected.
_Avoid_: sync engine

**Sync position**:
The last entry from a browser's buffer that the daemon holds, numbered by that browser's stdout extension. The daemon keeps one for each browser.
_Avoid_: maxSeq, extensionSeq, serverSeq, afterSeq

**Cursor**:
A place in the daemon's own ordering of entries, which agents pass back to read only what's newer. It's only good for the run of the daemon that issued it, and it's unrelated to the sync position.
_Avoid_: maxSeq, offset
