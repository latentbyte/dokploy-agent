# TODO

## npm publishing

Currently install-from-source only (`package.json` is `private`). To publish `@latentbyte/dokploy-agent`:

- create the `latentbyte` npm org (free for public packages) and an automation token
- add `NPM_TOKEN` as a repo secret
- decide what ships: the agent-safe build under a `dokploy-agent` bin, the full `dokploy` bin, or both
- drop `"private": true` and add `"publishConfig": { "access": "public" }`
- add a publish workflow on `main` that runs check/build/test first and skips versions already on npm
- update the readme install section to `npm install -g @latentbyte/dokploy-agent`
