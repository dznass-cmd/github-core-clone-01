# CoreForge

[![make.fun competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/dznass-cmd/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/dznass-cmd/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

CoreForge is a dependency-free, in-memory GitHub-compatible forge built for the
[make.fun GitHub Core Clone competition](https://make.fun/bounty/github-core-clone-01).
One Node.js 22 process serves Git Smart HTTP, REST v3, GraphQL v4 and MCP from a
shared repository store.

## Supported surfaces

- Git Smart HTTP: protocol v2 discovery, `ls-refs`, clone, fetch, shallow/deepen,
  receive-pack, fast-forward enforcement, tags, sideband and OFS/REF deltas.
- REST v3: repositories, contents, commits, branches, labels, issues, comments,
  pull requests, changed files and squash merges.
- GraphQL v4: repository, issue and pull-request queries, introspection, global
  nodes, pagination, batching and mutations.
- MCP Streamable HTTP: discovery plus six repository, issue and pull-request tools.

## Run

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with `MAKEFUN_ENV_URL`, serves
the forge until the harness reports completion, and then shuts down cleanly. It
uses only Node.js standard-library modules and requires no installation step,
database, Git binary or network service.

## Local conformance

With the official competition kit next to this repository:

```sh
node --experimental-strip-types ../github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:PORT --token TOKEN --perf
```

The current implementation passes all 120 official conformance checks.

## License

MIT
