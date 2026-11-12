![icon](./extension/img/icon-128.png)

# stdout-mcp

> A simple Chrome extension for console-logging *other* Chrome extensions


## Why?

Seeing console log output can be crucial for debugging Chrome extensions, especially when they use a manifest V3 service worker to respond to user-generated events, like a tab opening, the focus changing, etc.  Sure, you can inspect the service worker console, but leaving that devtools window open keeps the service worker active.  So you'll never see your extension go through the transition from active to inactive and back again &mdash; which is often where bugs sneak in.

`stdout-mcp` provides an easy way to send console output from your service worker or other extension pages *without* keeping your background scripts active.


## Installation

```shell
npm install --save-dev stdout-mcp
```

After installing the package, you'll need to add the unpacked `stdout` extension to Chrome.  To do so, drag the `extension` folder from `node_modules/stdout-mcp/` into the Extensions window in Chrome (`chrome://extensions`).

Once `stdout` is running, click its <u>service worker</u> link to open the devtools window.  This is where any console output from your extension will be displayed.

You can also let a coding agent read the output directly.  See [Reading logs from a coding agent](#reading-logs-from-a-coding-agent).


## Usage

To send logs from your extension, import `stdout()` from the package and call it:

```js
// service-worker.js
import stdout from "stdout-mcp";

stdout();
console.log("my important message", { hello: "world" });
```

By default, the global `console` object will be wrapped with methods that forward all calls to the `stdout` extension, so anything passed to `console.log()`, `console.error()`, etc. in your extension will also be displayed in the `stdout` service worker's console.  Calls to `console.error()` appear there as warnings labeled "error", so they aren't listed as errors in `stdout` itself on `chrome://extensions`.

Call `stdout()` once from each "page" in your extension from which you want to send console output: the service worker, the popup, content scripts, etc.  To turn log forwarding off, such as in production, see [`enabled`](#enabled).


## Options

You can pass `stdout()` an object with these options.


### `enabled`

Set `enabled` to `false` to make `stdout()` silently do nothing.  It defaults to `true`.  Use an environment variable or something similar to send logs in development but not in production:

```js
stdout({ enabled: process.env.NODE_ENV !== "production" });
```


### `wrapConsole`

If you don't want to wrap the global `console` object, set `wrapConsole` to `false`.  In that case, `stdout()` will return an object with the standard console methods that you can call when you want to send console output to the `stdout` extension:

```js
const { log, error } = stdout({ wrapConsole: false });

console.log("this message will not be sent to stdout");
log("this message will be logged locally *and* sent to stdout", { hello: "world" });
error("so will this error", new Error("something went wrong"));
```


### `filename`

In the `stdout` devtools window, the filename of your extension page is prefixed to each line of output, since different parts of your extension can all send messages to that console.  By default, this filename is extracted from `location.pathname`, but you can specify a custom name by passing a `filename` field in the options object:

```js
// service-worker.js
stdout({ filename: "background" });

// popup.html
stdout({ filename: "toolbar" });
```


## Reading logs from a coding agent

The package includes an [MCP](https://modelcontextprotocol.io) server, `stdout-mcp`, that lets a coding agent like Claude Code read your extension's console output.  It needs no other changes to your extension.

The `stdout` extension stores the last 10,000 log messages it receives, whether or not an agent is connected.  So when you notice something going wrong and start an agent session, the agent can see what was logged beforehand.


### Setup

Add the server to your agent's MCP configuration.  For Claude Code, run this in your extension's project:

```shell
claude mcp add stdout -- npx stdout-mcp
```

Or add it to the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "stdout": {
      "command": "npx",
      "args": ["stdout-mcp"]
    }
  }
}
```

For Codex, run:

```shell
codex mcp add stdout -- npx -y stdout-mcp
```

Or add it to `~/.codex/config.toml`:

```toml
[mcp_servers.stdout]
command = "npx"
args = ["-y", "stdout-mcp"]
```

Codex's MCP servers are set for your user rather than for one project, so the server also starts in projects that don't have `stdout-mcp` installed.  The `-y` lets `npx` download it in those projects instead of waiting for you to confirm.

The agent starts the server when it needs it.  The server starts a small background process on port 47321 that holds the logs, runs the tools, and is shared by all agent sessions.  Each session's server only passes messages to it.  The background process exits after two hours without use.  See [docs/architecture.html](docs/architecture.html) for how these pieces fit together.

If the background process was started from an older version of `stdout-mcp`, the next agent session to start replaces it.  Sessions that are already open then use the new one.  The `stdout` extension then resends its stored logs within about 30 seconds.  A background process from a newer version is left running, so agents in projects that use different versions don't keep replacing each other's.


### Agent mode

To let `stdout` send its logs to the server, click the `stdout` icon in Chrome's toolbar.  (You may need to pin it from the Extensions menu first.)  The icon shows an **MCP** badge while agent mode is on.  The badge is green when the server has received the logs and gray while `stdout` is waiting for a server to start.

While agent mode is on, `stdout` sends new log messages to the server as they arrive.  It also checks for the server every 30 seconds, or every 5 seconds for the first three minutes after you turn on agent mode or start Chrome, so a newly started agent session gets the stored logs quickly.  While the server is running, the `stdout` service worker stays awake so it can receive commands such as reloading an extension.  This only affects `stdout`'s worker, not your extension's.

Click the icon again to turn agent mode off.  The logs are still stored and shown in the `stdout` console, but nothing is sent to the server.


### More than one browser

`stdout` can send logs from more than one browser at once, such as Chrome and Edge, or two Chrome profiles.  Turn on agent mode in each one.  When logs come from more than one browser, each message says which one it came from, and the agent can limit what it reads to one browser.  `reload_extension` reloads an extension in the browser it has logged from, and asks which one when it has logged from several.

Each browser is named by its brand and version, like `Edge 146`.  Chrome's channels all call themselves Chrome, so to tell Chrome and Canary apart, give one of them a name: right-click the `stdout` icon, choose **Options**, and enter a name like `Canary`.


### Tools

| Tool | Description |
|------|-------------|
| `get_logs` | Returns the most recent log messages, the messages after a cursor from a previous call, or the messages around a given one.  Can filter by level, extension, browser, filename, a regular expression, or how recent the messages are, like `10m`. |
| `wait_for_log` | Waits for a new log message that matches a regular expression, such as after the agent asks you to reproduce a problem. |
| `mark` | Adds a line to the log, such as before the agent asks you to reproduce a problem, so the messages that follow are easy to find. |
| `reload_extension` | Reloads an unpacked extension so it runs your latest code, even if its service worker failed to start.  It only works on extensions that have called `stdout()`.  If the extension is in more than one browser, pass `browser` to say which.  With `reloadManifest`, it also reads `manifest.json` again and says whether the extension came back.  That needs `stdout()` to be called when your service worker starts, and a service worker that can start. |
| `list_sources` | Lists the browsers `stdout` is sending logs from and when each last connected, and the extensions and pages that have sent logs. |

Times are shown in your local time zone, like in the `stdout` console, and each message shows the time since the previous one, like `+251ms`.  A `loaded` line marks the first message from each page load, so you can see when a service worker restarted or a popup was reopened.  These lines need the version of `stdout-mcp` that sends a page-load ID.


## License

[MIT](./LICENSE) © [John Dunning](https://github.com/fwextensions)
