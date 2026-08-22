# The data explorer

The smallest complete thing: one declaration, a server checked against it, and
a view typed from it. If you read one example, read this one — the other two
are about what a component library can draw and what a host can be asked; this
is about the contract underneath both.

```
npm run build
NGMCP_DEV_HOST=1 node examples/data-explorer/dist/server.mjs
```

## The point

`contract.ts` is the only place the shape of a deployment is written down.

```ts
export const contracts = defineTools({
  list_deployments: {
    view: "ui://data-explorer/table",
    input: type<{ env?: Deployment["env"] }>({ /* JSON Schema */ }),
    output: type<{ deployments: Deployment[] }>(),
    summary: (out) => `${out.deployments.length} deployments`,
  },
});
```

The server imports it **for its values** and is type-checked against it:

```ts
app.implement(contracts, {
  list_deployments: async ({ env }) => ({ deployments: /* ... */ }),
});
```

The view imports it **as a type only**, so nothing of the server reaches the
bundle:

```ts
const api = client<typeof contracts>({ bridge: hostBridge() });
const loaded = await api.list_deployments({});   // knows it has `.deployments`
```

Adding a tool to `contract.ts` stops the server compiling until it is
implemented, and stops the view compiling until it agrees. The failure happens
at the keyboard rather than at a client.

## What is absent from `view.ts`

Worth reading for what is *not* there: no `?.`, no `?? []`, no shape written
twice. `result.structuredContent?.deployments ?? []` becomes
`(await api.list_deployments({})).deployments` — the same sentence with the
doubt removed, because the doubt was never warranted.

## Two things the tool answers

`summary` is what the model is told; `structuredContent` is what the view
draws. Four rows go to the table and one sentence goes to the model, rather
than four rows being flattened into prose for both. That split is the whole
argument for an app existing at all — see the top of `FLOOR.md`.

## Checked two ways

- `test/types/` compiles this example, so it cannot drift from the contract.
- `test/browser/view.test.js` runs the built server over a real pipe, mounts
  the view in a frame with an opaque origin, and asserts in both engines —
  including that filtering the table costs no tool call.
