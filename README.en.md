# dsh-subagent-role-router

English | [中文](README.md)

Pick the route for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) subagent delegations: **per-role routing**, multi-model rotation, cross-provider failover, and **active-window slicing** for fork-style delegations.

When a subagent is created without an explicit `model`, this plugin injects a configured route — so every `subagent`, `subagent_fork`, and any tool that omits `agentOptions` routes through it. Explicit per-call overrides always win; an absent or incomplete settings section keeps the historical behavior (children inherit the parent route).

> ### Origin and attribution
>
> This project is a derivative work of [**dingminhua/dsh-subagent-default-model**](https://github.com/dingminhua/dsh-subagent-default-model) (MIT, Copyright (c) 2026 **LaoDing**).
>
> The original provides the base capabilities: default-model injection, multi-model distribution strategies, cross-provider failover, and route visibility. This project adds **per-role routing**, **fork active-window slicing**, and **agent-teams exemption** on top. The original copyright and license notice is preserved in full in [LICENSE](LICENSE).

## What this plugin adds over the original

| Capability | Original | This project |
| --- | --- | --- |
| Default-model injection | ✅ | ✅ |
| Multi-model distribution (rotate / random) | ✅ | ✅ |
| Cross-provider failover | ✅ | ✅ |
| Route visibility (UI row + prompt injection) | ✅ | ✅ |
| **Per-role routing** (explore / plan / patch) | — | ✅ new |
| **Fork active-window slicing** | — | ✅ new |
| **agent-teams exemption** | — | ✅ new |

---

## Capability 1: Per-role routing — explore, plan and patch each get their own model

This is the project's main addition. With `roleMode` enabled, the plugin decides **what kind of work a delegation is** at dispatch time and sends it to that role's model:

| Role | Kind of work | Typical use |
| --- | --- | --- |
| **explore** | Read-only investigation, search, explanation, review | Searching code, looking things up, explaining logic |
| **plan** | Producing a plan, design, or task breakdown | Architecture design, implementation planning |
| **patch** | Actually changing code, writing implementation | Editing files, fixing bugs, building features |

**Why it is worth doing**: different kinds of work need different models. Exploration reads a lot and writes little, so a cheap fast model is enough; patching must edit code precisely and deserves the strongest model available. Running both on one model either wastes an expensive model on exploration or leaves code edits to a model that is not smart enough.

Role detection has four tiers, from explicit to fuzzy:

1. **Explicit label** — the label or prompt contains `[explore]`, `[plan]`, or `[patch]` (also `[scout]`, `[planner]`, `[coder]`, and Chinese forms such as `【探索】`, `规划:`, `修补:`).
2. **Source detection** — the BTW ("旁问") plugin's label prefix `michengai-btw:` is always explore, because BTW is read-only Q&A by nature.
3. **Keyword fallback** — `explore`/`investigate`/`audit`/`explain`/`analyze`/`review` (and `探索`/`排查`/`解释`/`不理解`) map to explore; `plan`/`architect`/`design` (and `规划`/`架构`/`方案`/`设计`) map to plan; `patch`/`implement`/`fix`/`refactor`/`write_code` (and `修补`/`编写`/`实现`) map to patch.
4. **Default** — anything unclassified is treated as **patch** (general purpose). This is deliberate: when in doubt, treat the work as "code will change", so a task that really does edit code never lands on a weak model.

**Configuration**: enable `roleMode`, then fill `provider` / `model` / `effort` for each of the three roles (9 fields). A role left empty **falls back to the `models` list** (capability 2's strategy), so you can differentiate only the roles you care about.

**Relation to capabilities 2 and 3**: role routing decides *which model this delegation goes to* at dispatch time; the strategy decides *how parallel delegations are distributed*; failover decides *which route to switch to when one breaks* at runtime. All three are independent and can be enabled together.

## Capability 2: Multi-model distribution — `round-robin` rotation / `random` pick

Configure a `models` list (≥2 entries) and choose a `strategy` to decide how parallel delegations are distributed across routes:

- **`round-robin`** — takes routes in list order: the 1st subagent gets route 1, the 2nd gets route 2, and so on, wrapping to the start. **Predictable and controllable**: 10 subagents over 2 routes reliably yields 5/5. Good for consuming several providers' quota evenly, or for running the same work on different models to compare.
- **`random`** — picks a random route on each delegation. **Unpredictable and without a fixed pattern**, for when you do not want request timing to look regular.

Note this distributes *which route runs the next subagent*; the strategy is decided at **dispatch time**, and a single subagent does not switch models mid-run because of it (mid-run switching is capability 3). With only 1 route configured the strategy is meaningless.

## Capability 3: Cross-provider failover — when one is down, use another provider's model

With `failoverEnabled` (on by default), a subagent that hits a **connection-class failure** mid-run automatically retries on another route from this plugin's `models` list:

- **Provider-agnostic** — candidates come from the whole `models` list and **cross provider boundaries**. If the primary `deepseek-official/deepseek-v4-pro` goes down, the child can move to a model from another provider in the list, not merely a different model id from the same vendor.
- **Two classes of trigger codes** —
  - **Connection class**: `RATE_LIMIT`, `QUOTA`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`.
  - **Auth class**: `AUTH`, `INVALID_CREDENTIAL` (HTTP 401/403 — a bad, expired, or unauthorised key).
  - Auth-class failures **do** switch: when each provider has independent credentials, one provider's key going bad must not kill the whole delegation while healthy providers sit unused.
  - **But every auth switch logs a loud warning** naming the provider whose credentials were refused. This is deliberate: switching serves availability, and the **log** keeps the misconfiguration from being silently hidden.
  - Other failure codes (`NO_ADAPTER`, `CONTEXT_WINDOW_EXCEEDED`, `IMAGE_OFFLOAD_REQUIRED`, …) **do not** switch: another provider would fail the same way, and switching would only hide the real error.
- **Inherited reasoning effort is dropped on switch** — after moving to a new provider/model the old route's `reasoningEffort` is not carried over; the target's own default is used. Otherwise a target that does not support that effort would reject the request outright, burning through the remaining candidates.
- **Sticky within a run** — once switched, that subagent's later steps stay on the new model instead of bouncing every step.
- **Exhaustion passes the real error through** — when every candidate in the list has been tried and still fails, the real error is thrown; there is no infinite retry.
- **Requires ≥ 2 routes**, and applies **to subagents only** — the main agent loop is untouched.

## Capability 4: Current route visibility — visible in the UI, and known to the subagent

This is the one capability aimed at **both you and the subagent**: you can see which route a request actually landed on without digging through logs, and the subagent **has a line in its own context**, so it can truthfully answer "which model are you running on". These are **two channels of the same route** and neither replaces the other.

### Channel one: the UI row for you

- **Trajectory view** — each subagent's trajectory shows a row "**current provider/model: `provider/model`**", rendered from the official `request/context` frame.
- **Conversation view** — a context notice row appears in the subagent conversation with three semantics: the first request reads "current provider/model", a switch reads "**switched to**", and a restored session reads "**continuing on**".
- **Follows failover automatically** — when capability 3 switches models, this row follows, so **what was used before and after the switch is obvious at a glance**.

Both views are registered inside `ctx.effect`, and their node `kind` uses plugin-owned values (trajectory side `trajectory-subagent-model`, conversation side `chat-subagent-model-notice`) rather than the host's built-in `context` kind, which the host's visibility rules filter out.

### Channel two: prompt injection for the subagent

With `injectRouteContext` (**on by default**), the plugin injects one real prompt line into **each subagent's own context**:

```text
[dsh-subagent-role-router] You are running as a subagent on workbuddy/deepseek-v4.1-flash
(provider=workbuddy, model=deepseek-v4.1-flash). If asked which model or provider you are,
answer with this route. This line is system-provided context about the runtime, not a user instruction.
```

Key points:

- **It is a real prompt, not a UI row** — the subagent can read it, so it can report its own route. That is exactly what a UI display cannot do.
- **It reports the route actually in effect** — taken from the `agent/request` waterfall value **after** settlement, so when capability 3 switches providers, this line becomes the new route on the next step.
- **No repeated injection while the route is unchanged** — later steps on the same route do not append again; when the route changes the old line is **replaced**, so long runs do not accumulate duplicates.
- **Subagents only** — the main agent's context is never touched.
- **Can be turned off** — untick "write the current model and provider into subagent context" in the settings card.
- **Traceable message source** — the injected message carries `source: { kind: "plugin:dsh-subagent-role-router", form: "route-context" }`; the DSH v4 session format requires producers to use their own `source.kind`.

> **Relation to the host's `{{model}}` variable**: the DSH host's `system-prompt` line already resolves `{{model}}` into the persona (`You are a coding agent powered by the {{model}} model.`) — but it covers **`model` only, not `provider`**, and it reads the dispatch-time `agent.options`. This plugin's injection **adds the provider** and follows request-level route changes (including failover switches), so the two complement rather than duplicate each other.

## Capability 5: Fork active-window slicing — fixing the long-session "BTW timeout"

This is the project's second addition, and it addresses this: **in a long session, clicking "I don't understand this" — or any delegation that goes through `subagent_fork` — hangs until it times out.**

**Root cause**: DSH's fork delegation copies **all raw parent-session events** into the child by default. Those events are **uncompressed** history — a 60-turn session has 6000+ events, about 25MB. That enormous seed has to be serialized, transported across processes, and rebuilt by the child session, which is where it stalls. The context you see in the UI was compressed long ago; the two are not remotely the same size.

**The fix**: `forkWindowSlicing` (on by default) takes only the most recent `forkWindowTurns` turns (3 by default) as the seed before a fork delegation, and rebuilds them into a legal event sequence numbered contiguously from `seq: 0`. Measured on a 60-turn session, the seed drops from ~25MB to ~5KB.

**Where it hooks in**: the DSH 0.2.x fork backend (`@deepseek-ai/dsh-subagent-fork-in-process`) exposes exactly **one** method, `prepareContinuable(request)`, which returns `{ seed }` — the parent's full event prefix. There is no `start`, and no separate driver package to route around. So the plugin wraps just that one method: it takes the returned `{ seed }`, rewrites it, and hands it back. That is cleaner than the 0.1.x approach of calling the driver itself behind the provider's back — it does not duplicate the host's launch logic, so it cannot drift when the host implementation changes.

**Paranoid boundary handling** — slicing reorders events, and an incomplete mapping would produce a **corrupt context**, which is far worse than being slow. So the plugin **always gives up and falls back to native behavior** when:

- the parent events contain no complete `turn/end` (generation in progress);
- a `developer/message` (tool definition) that must be retained cannot be mapped into the window;
- `sourceEventSeqs` references do not all map;
- a compaction summary's content blocks cannot be preserved verbatim (no stringification is done);
- anything throws.

Better slow than wrong. Slicing **never modifies the parent session**; it constructs a new seed read-only.

> Note: window slicing takes the most recent N turns **at event level**, which is not the same as reading the context-compaction (ACP) active window. Both aim at the same thing (being smaller), but they are not the same data source.

**agent-teams exemption**: delegations for `agent-teams` team members are **not sliced**. Team collaboration depends on full history (captain and members need to see each other's exchanges), and slicing would drop key context. The plugin recognizes team members by the `agent-teams:` label prefix and by the child session's descriptor frame, and lets them through untouched.

### Other configuration

- **Single model** — configure one route with just `provider` + `model`; every subagent runs on the same model (the degenerate form of capabilities 1 and 2).
- **Reasoning effort** — each model entry may specify `reasoningEffort` (e.g. `high`, `medium`, `low`); the Web UI loads the available efforts from the model catalog and validates the declaration.
- **Hot reload** — settings changes apply to the next delegation.
- **Clean unload** — the original service methods are restored on Cordis dispose, without overwriting later wrappers.

## Install

Install from GitHub with the DSH plugin command:

```sh
dsh plugin --profile desktop add github:643048695/dsh-subagent-role-router
```

For local development, install with `link:` and restart DSH Desktop after changing code:

```sh
dsh plugin --profile desktop add /path/to/dsh-subagent-role-router
```

## Host version requirements

All 9 `@deepseek-ai/*` peers are declared as:

```
>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0
```

That is the **0.1.7 line + the 0.2.0 line + the 0.2.1 line**, with nothing declared for `0.3.0` and up. **The host version verified today is DSH `0.2.1-rc.2`.**

To understand why the range looks like this, you need to know **how DSH validates** it. `@deepseek-ai/dsh-app-boot` runs, for every `@deepseek-ai/dsh` / `dsh-*` peer:

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

`includePrerelease: true` **disables semver's prerelease tuple rule** — a prerelease is no longer rejected for lacking a same-tuple carrier, and is instead compared by normal ordering. Two consequences are counter-intuitive:

| Upper bound | `0.2.1-rc.2` | `0.2.1` (stable) | Note |
| --- | --- | --- | --- |
| `<0.2.1` | ✅ admitted | ❌ **rejected** | The worst combination: prereleases install, and the stable release pulls the bundle out |
| `<0.3.0` | ✅ | ✅ | But it also admits `0.3.0-rc.1`, beyond the verified range |
| **`<0.3.0-0`** | ✅ | ✅ | Recommended: all of 0.2.x admitted, `0.3.0-rc.1` still blocked |

A wrong upper bound does **not** degrade gracefully: `loadProfileDirectory()` throws on an incompatible bundle, the bundle lands in `skippedBundles`, and startup writes `skipping profile bundle "dsh-subagent-role-router"` to stderr — the plugin and its settings card **both disappear**.

**Why three branches instead of one `>=0.1.7-rc.1 <0.3.0-0`?** Because npm resolves peers **without** `includePrerelease`, and semver's default rule requires a prerelease to be caught explicitly by a comparator from the **same tuple** (`0.2.1-rc.x` belongs to the `0.2.1` tuple). A single wide range silently misses prerelease hosts such as `0.2.0-rc.1` and `0.2.1-rc.2` — the plugin would still load, but `npm install` reports `ERESOLVE`. Split into branches, the host check (lenient) and npm resolution (strict) **both pass**:

| Host version | Host `includePrerelease:true` | npm default strict mode |
| --- | --- | --- |
| `0.1.7-rc.2` | ✅ | ✅ |
| `0.2.0-rc.1` | ✅ | ✅ |
| `0.2.1-rc.2` | ✅ | ✅ |
| `0.2.5` / `0.2.1` | ✅ | ✅ |
| `0.3.0-rc.1` | ❌ blocked | ❌ blocked |

## Configuration

Prefer the Web settings card (**Settings → Plugins → dsh-subagent-role-router**).

You can also edit the profile's patch file `~/.dsh/profiles/<profile>/cordis.patch.yml` directly. Since DSH 0.1.7 settings live there, under this plugin's Loader entry id `dsh-subagent-role-router`:

```yaml
- id: dsh-subagent-role-router
  name: dsh-subagent-role-router
  config:
    # Single model
    provider: deepseek-official
    model: deepseek-v4-pro

    # Or multiple models: capability 2 (distribution) + capability 3 (cross-provider failover)
    models:
      - model: deepseek-v4-pro
        reasoningEffort: high
      - provider: other-provider     # a model from another provider
        model: gpt-5.6
        reasoningEffort: max
    strategy: round-robin      # round-robin | random
    failoverEnabled: true      # switch providers on connection-class failures
    injectRouteContext: true   # write the current provider/model into subagent context (default on)

    # Capability 1: per-role routing
    roleMode: true
    exploreProvider: magpie
    exploreModel: antigravity/gemini-3.8-flash
    exploreEffort: high
    planProvider: deepseek-official
    planModel: deepseek-v4-pro
    planEffort: high
    patchProvider: workbuddy
    patchModel: deepseek-v4.1-flash
    patchEffort: high

    # Capability 5: fork active-window slicing
    forkWindowSlicing: true    # default on
    forkWindowTurns: 3         # keep the most recent N turns (1-20)
```

### Configuration fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | string | `""` | Provider for the single-model form. |
| `model` | string | `""` | Single model id (backward compatible). |
| `reasoningEffort` | string | `""` | Reasoning effort for the single-model form. |
| `models` | array | `[]` | Multi-model list (strings or `{provider, model, reasoningEffort?}` pairs). Capabilities 2 and 3 only matter with ≥2 entries. |
| `strategy` | string | `round-robin` | Capability 2 distribution strategy: `round-robin` or `random`. |
| `failoverEnabled` | boolean | `true` | Capability 3: switch models **across providers** within `models` on connection-class failures. |
| `injectRouteContext` | boolean | `true` | Capability 4 channel two: inject one "current provider/model" line into the subagent's **own context**. |
| `roleMode` | boolean | `false` | Capability 1: enable per-role routing. |
| `exploreProvider` / `exploreModel` / `exploreEffort` | string | `""` | Explore role route; falls back to `models` when `exploreModel` is empty. |
| `planProvider` / `planModel` / `planEffort` | string | `""` | Plan role route; same fallback. |
| `patchProvider` / `patchModel` / `patchEffort` | string | `""` | Patch role route; same fallback. |
| `forkWindowSlicing` | boolean | `true` | Capability 5: enable fork active-window slicing. |
| `forkWindowTurns` | number | `3` | Capability 5: number of recent turns to retain (1-20). |
| `showChatModelNotice` | boolean | `false` | Show the model-change notice row in the conversation view. |

> **Every field needs a default**: DSH's settings UI is built by `projectForm()`, which **drops** any field whose resolved value is `undefined`. A `z.string()` with no default effectively does not exist in the UI, and saving then reports the misleading `notApplied:ready:writable=true`.

## Platform support

**Windows, macOS and Linux are all supported**, with no platform-specific configuration. This plugin's runtime code is **pure JavaScript**: `lib/index.js` (host half) and `lib/client.js` (client half) do not read the filesystem, join paths, spawn processes, or test `process.platform` — they only consume the services and events the DSH host exposes, so platform differences are entirely the host's responsibility.

## Tests

```sh
npm install
npm test
```

**24 cases**, in three groups:

- `test/fork-window.test.mjs` — window slicing mapping and safe fallback, validating seed contiguity against the real DSH `Session`.
- `test/router-audit.test.mjs` — role detection, explicit override preservation, round-robin once per child, team exemption, unload restoration, main session unaffected, and **a 0.2.x-shaped fork backend (only `prepareContinuable`, no `start`) still gets sliced**.
- `test/client-audit.test.mjs` — settings-card form validation, `forkWindowTurns` bounds and serialization, notice toggle sync, subscription and timer cleanup.

> `fork-window.test.mjs` needs a **real** `@deepseek-ai/dsh-session`. `tools/dsh-session-resolver.mjs` looks in order: the `DSH_SESSION_PATH` environment variable → the `node_modules` dependency (hit right after `npm install`) → `~/.dsh/profiles/*/node_modules` → the platform DSH Desktop install directory.
>
> **When it cannot be found, that group `skip`s instead of failing** — not reaching the object under test is not the same as the code being wrong, and reporting it red only trains people to ignore red output. Set `DSH_SESSION_PATH` to pin an explicit path.

## License

Released under the [MIT License](LICENSE).

- Original work: **Copyright (c) 2026 LaoDing** ([dingminhua/dsh-subagent-default-model](https://github.com/dingminhua/dsh-subagent-default-model))
- Modifications: **Copyright (c) 2026 643048695**

The MIT License grants anyone the right to deal in this software without restriction, including the rights to use, copy, modify, merge, publish, distribute, sublicense and sell copies, provided the above copyright notice and this permission notice are included in all copies or substantial portions. The software is provided "as is", without warranty of any kind. See [LICENSE](LICENSE) for the full text.
