# @kodein/opencode1-osc-7501

`@kodein/opencode1-osc-7501` reports OpenCode 1 session status to the controlling terminal through the [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status).

Terminals that support the protocol can show when OpenCode is idle, working, waiting for a permission response or user answer, finished, or failed. Unsupported terminals ignore the sequences.

## Install

Install the package where OpenCode loads plugins, then add it to `opencode.json`:

```sh
npm install @kodein/opencode1-osc-7501
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@kodein/opencode1-osc-7501"]
}
```

OpenCode installs configured npm plugins with Bun, so publishing this package to npm is enough for normal use.

## Status mapping

At plugin startup, OpenCode reports an application-level `idle` record with `id=opencode`. Each session is then represented by its own OSC record, using the session ID as its record ID.

| OpenCode event | OSC 7501 report |
| --- | --- |
| Session created | `idle` |
| Session busy | `working` |
| Session retrying | `working` with the retry message |
| Permission requested | `blocked`, `kind=permission` |
| User question asked (Ask User tool) | `blocked`, `kind=question` |
| Permission answered or user question answered/rejected | `working` (unless another request is still pending) |
| Session error | `error` with the error message |
| Session idle | `done`, or `error` after a session error |
| Session deleted | `clear` |

All non-clear reports include `app=opencode`. The plugin writes to `/dev/tty`, never standard output. In a headless process or on a platform without a controlling terminal it does nothing.

## Development

This package targets OpenCode 1.x and requires a current Node.js release with TypeScript stripping for the local test command.

```sh
npm install
npm test
npm run build
```
