# dsh-subagent-role-router

English | [中文](README.md)

Route subagent delegations in [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) and show what is running: per-role routing with a candidate pool per role, cross-provider failover, fork window slicing — plus header critters, mid-run and batch model switching, and model-callable routing tools. Configured through the plugin's own settings card (its Cordis `Config`), stored in the profile's `cordis.patch.yml`.

When a subagent is created without an explicit `model`, this plugin picks a route for it — so every `subagent`, `subagent_fork`, and any tool that omits `agentOptions` routes through it. Explicit per-call overrides always win; an absent or incomplete settings section keeps the historical behavior (children inherit the parent route).

Once things are running, the plugin also gives the state back to you: pixel critters in the session header show who is working, for how long and how many tokens, and a click jumps straight into that subagent's conversation; the subagent header carries a model + reasoning-effort picker; a batch card rewrites every direct child at once; and a stuck subagent gets a second, visible stop attempt. **Dispatch, observation and intervention all live in one plugin.**

## Core capabilities

This plugin answers two questions: **when a delegation does not name a model, which route should the subagent run on — and once it is running, how do you see it and how do you intervene?** The capabilities below are described with what each does *and* what it does not do — five about dispatch, four about observing and steering.

### Capability 1 — Multi-model distribution: `round-robin` (sequential) or `random`

Configure a `models` list (2+ entries) and pick a `strategy` to decide how parallel delegations are spread across those routes:

- **`round-robin` (sequential)** — take routes in list order: the 1st subagent gets route 1, the 2nd gets route 2, and so on, wrapping back to the start. **Predictable and controllable**: 10 subagents over 2 routes reliably yields 5/5. Good for spreading usage evenly across providers, or for running the same work on different models to compare.
- **`random`** — pick a random route per delegation. **Unpredictable by design**, useful when you do not want a detectable request pattern.

Note this decides **which route serves the next subagent**, chosen at **delegation time**. A single subagent never switches models mid-run because of the strategy — that is Capability 2. With only one route configured, the strategy is meaningless.

### Capability 2 — Cross-provider failover: if one provider is down, run on another provider's model

With `failoverEnabled` (on by default), when a subagent hits a **connection-class failure** mid-run, the plugin retries on another route from its own `models` list:

- **Provider-agnostic** — candidates come from the whole `models` list, so failover works **across providers**. If `deepseek-official/deepseek-v4-pro` dies, the subagent can fail over to a *different vendor's* model in the list — not merely another model ID from the same vendor.
- **Two classes of trigger code** —
  - **Connection-class**: `RATE_LIMIT`, `QUOTA`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`.
  - **Auth-class**: `AUTH`, `INVALID_CREDENTIAL` (HTTP 401/403 — an invalid, expired, or unauthorised key).
  - Auth-class failures **do** switch: when each provider holds its own credentials, one bad key must not kill the whole delegation while healthy providers sit unused.
  - **But an auth switch always emits a warning** naming the provider whose key was refused. That is deliberate: switching buys resilience, and the **log line** is what keeps the misconfiguration from being silently hidden.
  - Other codes (e.g. `NO_ADAPTER`, `CONTEXT_WINDOW_EXCEEDED`, `IMAGE_OFFLOAD_REQUIRED`) do **not** switch: another provider would fail identically, so switching would only bury the real error.
- **Inherited reasoning strength is dropped** — after switching, the new provider/model is not sent the previous route's `reasoningEffort`; it resolves its own default. Otherwise a target that rejects that level can fail every request and burn through all remaining candidates.
- **Sticky within a run** — after a switch, later steps of that same subagent stay on the new model instead of flip-flopping every step.
- **Exhaustion passes the real error through** — once every candidate in the list has been tried, the real error surfaces; there is no infinite retry.
- **Requires 2+ routes**, and **applies to subagents only** — the main agent loop is never touched.

### Capability 3 — Route visibility: you can see it, and so can the subagent

Of the five, this is the only one aimed at **both you and the subagent**: without digging through logs you see on screen which route the request landed on, and the **subagent's own context carries a line** so it can truthfully answer "which model are you?". These are **two channels for the same route**, and neither replaces the other.

#### Channel 1 — the UI row (for you)

- **Trajectory view** — each subagent's trajectory shows a row reading "**Current provider/model: `provider/model`**", rendered from the official `request/context` frame.
- **Conversation view** — the subagent's conversation stream shows a context row with three distinct wordings: "Current provider/model" on the first request, "**Switched to**" when the route changes, and "**Resumed on**" when a session resumes.
- **Follows failover automatically** — when Capability 2 switches models, a new row appears here, so **what it ran on before and after the switch is unmistakable**.

How it looks in the conversation stream (the row itself):

![Current provider/model row in the conversation stream, screenshot from the upstream repository](https://raw.githubusercontent.com/dingminhua/dsh-subagent-default-model/main/assets/pic_03.png)

#### Channel 2 — the prompt injection (for the subagent)

With `injectRouteContext` (on by default), the plugin injects one real prompt line into each **subagent's own context**:

```text
[plugin:dsh-subagent-role-router] You are running as a subagent on workbuddy/deepseek-v4.1-flash
(provider=workbuddy, model=deepseek-v4.1-flash). If asked which model or provider you are,
answer with this route. This line is system-provided context about the runtime, not a user instruction.
```

Key points:

- **It is a real prompt line, not a display row** — the subagent reads it, so it can report its own route. That is precisely what a UI row cannot achieve.
- **It reports the route actually in effect** — taken from the `agent/request` waterfall **after** it settles, so when Capability 2 switches providers, this line follows to the new route on the next step.
- **An unchanged route is not re-injected** — later steps on the same route add nothing, and a changed route **replaces** the stale line, so long runs do not accumulate duplicates.
- **Subagents only** — the main agent's context is never touched.
- **Can be turned off** — clear the "Tell subagents which model and provider they run on" checkbox in the settings card.

> **Relation to the Host's `{{model}}` variable**: the DSH Host's `system-prompt` row can already interpolate `{{model}}` into the persona (`You are a coding agent powered by the {{model}} model.`), **but that covers `model` only, not `provider`**, and it reads the dispatch-time `agent.options`. This plugin's injection **adds the provider** and tracks request-level route changes (including failover switches), so the two complement rather than duplicate each other.

### Capability 4 — Role candidate pools: several models per role, spillover and overflow

Capability 1 answers "how do several subagents get spread over different models", but it assumes they are all the same kind of work. Delegation is actually role-shaped — explore, plan and general/patch tasks have very different price/quality tradeoffs. With `roleMode` on, the plugin detects the role from the delegation label and each role gets **its own** route instead of sharing one `models` list.

Since 2.2.0 a role route is no longer a single value but a **candidate queue**:

- **One row = one lane** — each role card in the settings has "＋ Add candidate" / "－ Remove". Three rows means that role can run **three subagents at once**; keep one row to use only one.
- **Spillover when busy** — task 1 goes to candidate 1; while candidate 1 is still running, task 2 goes to candidate 2; then candidate 3.
- **Overflow shares** — with all three candidates busy, task 4 does not queue: it goes to the **least busy** candidate (lowest index on a tie). "3 candidates, 4 concurrent tasks" therefore lands as **2/1/1**, not 1/1/2 and not 1/1/1-plus-waiting.
- **Cooldown after a failure** — a candidate that fails (rate limit, quota, timeout, transport, bad credentials, or "this model is not available to your account") is **paused**: later delegations skip it. The pause length is `roleSlotCooldownSeconds`, default **15 s**; 0 disables it.
- **A fully cooled pool still works** — if every candidate is cooling down the plugin does not refuse the delegation (that would kill the subagent); it ignores the cooldowns, picks one, and logs a warning so the degradation is visible.
- **Cooldown only affects new delegations** — running subagents are untouched; their failures are handled in place by capability 2's failover, and that failover is restricted to **this role's own candidate queue**.
- **Explicit models take no lane** — a delegation that names its own `agentOptions.model`/`provider` (a pinned-model review task, say) and agent-teams members bypass the pool entirely and occupy no lane.

Why cooldown rather than permanent eviction: rate limits and timeouts are **temporary**, so evicting forever would lock out a model whose quota has since recovered; the 15 s default rides out a burst without needing a human. Genuinely permanent problems (unknown model, model not permitted for the account) log a warning **naming the offending route on every failure** so the row gets fixed or removed — surfaced by the log instead of silently degrading.

> This "an unusable candidate keeps winning a lane" case came out of a live run: a candidate refused by the gateway with `model [gpt-6.1-sol] is not allowed for user type [personal_free_user]` was classified as the generic `INVALID_REQUEST` (malformed request), so it neither fell through nor cooled down. It never ran long, so it always looked idle, won its lane on every delegation and failed once more. Model-naming 400s are now recognised as "candidate unusable", skipped and cooled; a genuinely malformed request still does **not** switch candidates — it surfaces immediately, so a code bug cannot burn the whole queue.

### Capability 5 — Swap models while a subagent runs: one click, next step

The host's model dropdown is **disabled inside subagent conversations**: `session/selectModel` rejects any session whose `origin === "subagent"` with `session/agent-busy`, and the front-end control is not even rendered for a subagent window. Before this, the only way to change a running child's model was to interrupt it and delegate again — losing all of its context.

From 2.3.0, a subagent conversation gets a **model dropdown plus a reasoning-effort dropdown** in the header on the right:

- **Applies from the next step** — no restart, no re-delegation. **From 5.1.0 the switch goes through the host's own front door** (`agent.model.select()`): since rc.5 the host pins each step's model selection at preparation time and guards it — any waterfall hook that rewrites the request's model is rejected with "`use agent.model.select() before step preparation`". The plugin no longer rewrites requests; it calls the front door. A switch therefore lands on the **next step / next turn** — a mid-retry switch is impossible (the retry reuses the pinned selection; host semantics), and an unswitchable target honestly carries an `applied` field instead of pretending. Nothing in the running context is lost.
- **Effort changes too** — the second dropdown lists only the efforts the model itself declares (`reasoning.efforts` from the model catalog). A model that declares none gets no invented options: `sensenova/kimi-k3` declares an empty list, and forcing `high` on it makes the host answer `UNSUPPORTED_REASONING_EFFORT` and end the turn — so that dropdown stays empty for such models.
- **Works on an idle child too** — a child that has not issued a request yet has no route to show, but the dropdown still accepts a pick; it takes effect on the next wake-up. The pick means "what the next step uses", not a persisted preference, and it is forgotten as soon as the child is disposed.
- **↺ Reset** — after a manual pick a reset button appears; it drops the override and returns the child to whatever the plugin assigns automatically.
- **A manual pick beats automatic failover** — once you have named a model, Capability 2 will not silently swap it away, and will not record that model in the cooldown list either. Click ↺ to hand routing back to the automatic path.
- **Subagents only** — the control does not appear in a main conversation's header (the host's own dropdown covers that case).

> Transport: the plugin registers its own loopback-only HTTP prefix route `/subagent-role-router` and the front end fetches it by document-relative path. The full endpoint table is in [HTTP endpoints](#http-endpoints). It deliberately does not reuse the host's `/api` RPC: that channel admits exactly one interceptor, which api-gateway already holds, so claiming it would displace it.

### Capability 6 — Header critters: who is working, for how long, how many tokens

The right end of the session header carries up to three pixel figures, one per **running subagent of the current conversation**. Clicking opens a panel with one row per subagent:

- **Recognisable at a glance** — six role poses (typing, tentacle-tapping, welding, hamster wheel, reading, courier), assigned stably by a hash of the child id, so a given subagent always looks the same. All animation is off under `prefers-reduced-motion: reduce`.
- **How long and how much** — each row shows elapsed time (`42秒` / `3分07秒` / `1小时05分`) and usage (`1.2万 tokens`). Both come from the host's own projection for the child session (`subagentTiming`, `tokenUsage`): **no extra endpoint, no polling**. When the host has no data, that part is simply not rendered instead of printing `0 tokens`.
- **Click to open the conversation** — it calls the host's own navigation service (`ctx.uiWorkspace.openSession`), the same call the host's subagent catalog uses; the panel collapses afterwards, and Enter/Space work on a focused row. A failure logs `CRITTERS_OPEN_FAILED` rather than disappearing.
- **Anchored to the button, follows the window** — on open it measures the button: right edge aligned, opened to whichever side has room, height capped by the remaining viewport. It recomputes on resize and scroll, and scrolls inside the panel when there are many subagents.
- **The critter itself is a button (5.1.0)** — clicking a critter navigates with the host's own "parent + child + session kind" address object; the overflowing "+N" opens the full list. When navigation is unavailable it falls back to opening the panel and logs a diagnostic, so a click always gives feedback. Hovering shows a compact title (task name + route); panel rows can still switch models or jump into the conversation.
- **A subagent's own page shows the whole brood (5.1.0)** — anchored to its parent conversation, with a "↩ main conversation" button.
- **Plain subagents show up too (5.1.0)** — team members come from the host's session tree, which never contained plain children: the plugin adds its own activity channel (one fetch on mount, a debounced refetch on start/stop push frames, a refresh when the panel opens), **no polling**; the tree wins, the activity ledger only adds.

**Performance is a design constraint here, not a later fix**:

1. The header subscribes only to a *string signature* of "which subagents of this parent are running". The host compares selector results by value (`useSyncExternalStoreWithSelector` → `Object.is`), so an unchanged signature means **no re-render** — another session streaming tokens or another subagent running never wakes this header.
2. Elapsed time and tokens are computed **only while the panel is open**, by a single one-second ticker; closed, it costs nothing and no subscription callback runs.
3. Character art is cached per (phase, role) as the same React element, so a re-render never rebuilds the figure.

`test/critters-render.test.mjs` (6 cases) pins all three down: the member signature ignores tokens/duration/unrelated sessions, the component does not re-execute when tokens change, membership changes re-render and reuse the same `<svg>`, there is no timer while closed and exactly one while open, and a departed subagent is not resurrected by stale data.

### Capability 7 — Batch model switch: rewrite every direct child at once

The subagent header has a "⇄ 批量" (batch) entry that opens a card pointing upwards: tick the subagents, choose a model and a reasoning effort, apply. You can also change only the effort while keeping each model, or clear all overrides back to automatic assignment.

The writable scope is identical to the single-target picker: only **direct** children of the current conversation, only models configured in settings, with the same effort validation and the same exemption rules. When there is nothing writable, the card says so instead of offering a dead button.

### Capability 8 — The model itself can query and change this routing

Two tools let the model inspect and rewrite subagent routing without a human clicking the UI:

- **`subagent_routes_inspect`** — the actual route of every subagent in the current conversation, whether it is writable, plus the configured model pool and the efforts each model *declares*.
- **`subagent_routes_update`** — target one subagent, a team member, or "every writable subagent in this conversation"; change models and efforts; change only the effort (`keep_model`) or reset (`reset`).
- **Every change carries revisions** — each target has its own revision and the instance has an epoch, so a tool edit is not dragged back by a stale UI cache. Batch edits accept `expected_revisions` and fail as a whole rather than overwriting each other.
- **Team members** — a member's next request is retargeted through the AgentTeams member-route service while keeping the member name, child id, task, attempt id, mailbox and history. When that service is absent the tool reports `teams-unavailable` explicitly and **never** falls back to deleting and recreating the member.

### Capability 9 — Stop fallback: a second, visible attempt when a subagent will not stop

When the host handles a stop request it looks the subagent up in the resident activation table and, **if it is not there, returns silently** — the UI reports "accepted", the button greys out, the subagent keeps running, and nothing says why.

This plugin now wraps the shared cancel action: it measures the host's return value, re-checks the running state about a second later, and if the child is still running retries the interrupt through its own `/subagent-role-router/stop` endpoint — covering both id spellings (with and without the `session-` prefix) and both authorization shapes (parent session, resident ancestor) — and reports every attempt's outcome back to the UI. **A refusal becomes a visible refusal.**

### Capability 10 — Birth route policy: the pool decides by default

**The problem**: the host copies the main conversation's **current** model into every subagent's birth parameters. The old logic saw "someone specified a model" and stepped aside — so every new child inherited the main conversation's model and your pools did nothing until you switched each one by hand.

A new `birthRoutePolicy` setting, default `pool`:

- **`pool` (default)** — a model written into the birth parameters **does not count**: an off-list explicit model is replaced by a pool entry (other parameters such as token caps are kept, and the spawn occupies a pool lane). A model **on the page whitelist** is honoured as a deliberate pick: an exact `(provider, model)` pair, a different provider alias + same model name, or a bare short name (`dnq` → `group/dnq`) all match, pass through untouched, and occupy no lane.
- **`explicit`** — the old behaviour: whatever the caller wrote is honoured.
- **Precedence** — a switch you make in the plugin panel **always wins** (it happens after birth); agent-teams members and children matching an exemption rule are untouched. Plugins that spawn their own children with their own models (e.g. Mnemon) coexist via a name-prefix exemption rule.

### Other configuration

- **Single model** — configure just `provider` + `model`; every subagent runs on that one model (the degenerate form of Capabilities 1 and 2).
- **Reasoning strength** — optionally set `reasoningEffort` per model entry (e.g. `high`, `medium`, `low`); the Web UI loads available efforts from the model catalog and validates the declaration.
- **Hot-reload** — settings changes apply to the very next delegation.
- **Clean teardown** — Cordis disposal restores the original service methods.

## Screenshots

Screenshots are not shipped in this repository yet (they live under `_work/`, which is scratch space). The settings panel, the header critters, the batch card and the route row are all visible as soon as the plugin is installed.

## Marketplace

- **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)** (the official DSH marketplace): entry `data/plugins/643048695__dsh-subagent-role-router.yml`, category `model`. Search for it under Settings → Plugins → Marketplace.
- The marketplace reads `version` and `description` from the root `package.json` at the repository URL, so bumping the version here updates what the entry shows.

## Install

This plugin is **not published to the npm registry**; install it from the repository:

```sh
dsh plugin add github:643048695/dsh-subagent-role-router
```

Local development install (`link:`, so code changes apply after reloading the client):

```sh
# install the checkout itself as a plugin (node_modules becomes a source symlink)
dsh plugin add link:/path/to/dsh-subagent-role-router
```

With no configuration the behavior is identical to not having the plugin installed.

## Debug switches

| Switch | Effect | Default |
| --- | --- | --- |
| `DSH_SUBAGENT_ROLE_ROUTER_LOG` | Point it at a **file path** and the stop fallback, `REJECT_NOT_LIVE` and `SET_OVERRIDE` append one timestamped line each. Unset, nothing is written anywhere. | unset |
| `?srrLog=1` on the page URL, or `localStorage["dsh-subagent-role-router:log"]="1"` | Enables the client picker's and critters' debug channel (route picks, overrides, failover, navigation fallback). | off |
| `POST /subagent-role-router/debug` | Server-side debug endpoint; it only records anything when the log variable above is set, and says so in its `logged` field. | — |

The client channel is off by default on purpose: it used to POST on **every selector render** — whoever is chasing a bug can still turn it on, but nobody else should pay that network cost.

## HTTP endpoints

The plugin registers the prefix route `/subagent-role-router` on the loopback DSH server (front end accesses it by document-relative path):

| Method and path | Purpose |
| --- | --- |
| `GET /subagent-role-router/route?childId=` | The route currently in effect for one subagent (also the way to confirm which build the backend runs: `?childId=nothing`) |
| `POST /subagent-role-router/select` | Set a model/effort override for one subagent (this is also how mid-run switching works) |
| `POST /subagent-role-router/clear` | Clear one subagent's override |
| `POST /subagent-role-router/stop` | Stop fallback: retry the interrupt with both id spellings and both authorization shapes |
| `GET /subagent-role-router/events` | SSE change stream (route picks, overrides, failover, member routes), 25-second heartbeat |
| `GET /subagent-role-router/activity` | Live snapshot of the subagents in the current conversation |
| `GET /subagent-role-router/batch` | Data for the batch card (writable direct children + model pool) |
| `POST /subagent-role-router/batch/select` | Set overrides in bulk |
| `POST /subagent-role-router/batch/clear` | Clear overrides in bulk |
| `GET /subagent-role-router/whitelist` | Current state of the native whitelist mirror |
| `GET /subagent-role-router/exempt-candidates` | Candidate values for exemption rules (preset / cwd / name prefix) |
| `POST /subagent-role-router/debug` | Debug record endpoint (see the switches above) |

## Model-callable tools

When enabled, the model can inspect and change subagent routing itself (implementation in `lib/router-tools.js`):

| Tool | Purpose |
| --- | --- |
| `subagent_routes_inspect` | The actual route of every subagent in the current conversation, whether it is writable, the model pool and each model's declared efforts |
| `subagent_routes_update` | Change models/efforts for one or many subagents or team members; effort-only (`keep_model`) and reset (`reset`); optional `expected_revisions` for optimistic concurrency |

## Release / Publish

This repository **does not publish to npm**. A release is a tagged commit:

```sh
npm test                                  # green before anything else
# bump package.json "version" and CHANGELOG.md
git add -A && git commit -m "chore: X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z: <one-liner>"
git push origin main && git push origin vX.Y.Z
```

The marketplace entry reads `version` from the root `package.json` at the repository URL, so the version number is the marketplace version; the description text lives in `data/plugins/643048695__dsh-subagent-role-router.yml`, which is updated by a PR to [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). Full flow in [`RELEASING.md`](RELEASING.md).

## Host version requirement

All eight `@deepseek-ai/*` peers are declared as **`>=0.1.7-rc.1 <0.3.0-0`**: the 0.1.7 line and the **entire 0.2.x line** (prereleases and stable releases alike) are supported; 0.3.0 and later are not declared.

To see why the range has this shape, look at how DSH **validates** it. For every `@deepseek-ai/dsh` / `dsh-*` peer, `@deepseek-ai/dsh-app-boot` runs:

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

`includePrerelease: true` **disables semver's prerelease-tuple rule** — a prerelease is no longer rejected for lacking a same-tuple carrier; it is compared by the ordinary ordering. Both consequences are counter-intuitive:

| Ceiling | `0.2.0-rc.1` | `0.2.0` (stable) | Note |
| --- | --- | --- | --- |
| `<0.2.0` | ✅ admitted | ❌ **rejected** | The worst split: prereleases install, and the stable release strips the bundle |
| `<0.3.0` | ✅ | ✅ | But also admits `0.3.0-rc.1`, beyond the verified range |
| **`<0.3.0-0`** | ✅ | ✅ | Recommended: all of 0.2.x, and `0.3.0-rc.1` is refused |

A wrong ceiling does not degrade gracefully: `loadProfileDirectory()` throws for an incompatible bundle, which lands in `skippedBundles` and prints `skipping profile bundle "dsh-subagent-role-router"` to stderr at startup — the plugin and its settings card both disappear.

`plugin/test/peer-range.test.mjs` is the regression guard for this contract: it calls the host's own `semver.satisfies(..., { includePrerelease: true })` and asserts each row of the table above.

## Configuration

Use the Web settings card (**Settings → Plugins → Subagent default model (dsh-subagent-role-router)**).

You can also edit the profile patch `~/.dsh/profiles/<profile>/cordis.patch.yml` directly: since DSH 0.1.7 that is where settings live, keyed by this plugin's Loader entry id `dsh-subagent-role-router`:

```yaml
- id: dsh-subagent-role-router
  name: dsh-subagent-role-router
  config:
    # Single model
    provider: deepseek-official
    model: deepseek-v4-pro

    # Or multiple models: Capability 1 (distribution) + Capability 2 (cross-provider failover)
    provider: deepseek-official
    models:
      - model: deepseek-v4-pro
        reasoningEffort: high
      - provider: other-provider     # a model from another vendor
        model: gpt-5.6
        reasoningEffort: max
    strategy: round-robin  # round-robin (sequential) | random
    failoverEnabled: true  # switch across providers on connection failures
    injectRouteContext: true  # write the live provider/model into each subagent’s context (default)
```

Role candidate pools (capability 4) — one array per role, and **the array length is that role's concurrency**:

```yaml
    roleMode: true
    # Explore role: 2 lanes
    exploreModels:
      - provider: magpie
        model: antigravity/gemini-3.8-flash
        reasoningEffort: high
      - provider: magpie
        model: workbuddy/mimo-v2.6-pro
    # Plan role: 1 lane
    planModels:
      - provider: magpie
        model: workbuddy-ai/deepseek-v4.1-flash
        reasoningEffort: max
    # General/patch role: 3 lanes
    patchModels:
      - provider: magpie
        model: antigravity/gemini-3.8-flash
        reasoningEffort: high
      - provider: magpie
        model: workbuddy/mimo-v2.6-pro
      - provider: magpie
        model: sensenova/kimi-k3
    roleSlotCooldownSeconds: 15  # seconds a failed candidate is skipped; 0 disables
```

An entry may be a `provider/model` string or the object form above; `reasoningEffort` is optional (omitted means the target model's own default effort). An empty or absent array **falls back to the legacy single-value fields** (`exploreProvider`/`exploreModel`/`exploreEffort`, …), so upgrading from an older version needs no config change.

> **Upgrading from 0.1.6 or earlier**: the old configuration lived in the `subagent-default-model` section of `~/.dsh/settings.yaml`. 0.1.7 imports that file **once** and renames it to `settings.yaml.imported`, never reading it again. The import uses each section name verbatim as an entry id, while this plugin's entry id is `dsh-subagent-role-router` — so the old section is **not** imported (the host logs `section subagent-default-model … was not imported into entry dsh-subagent-role-router`) and the old values survive only in the renamed file. Move them into the `config:` block above by hand.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | string | — | Provider for string-type model entries. |
| `model` | string | — | Single model id (backward compatible). |
| `models` | array | `[]` | List of model entries (string or `{provider, model, reasoningEffort?}` pair). Only meaningful for Capabilities 1 and 2 with 2+ entries. |
| `strategy` | string | `round-robin` | Capability 1's distribution strategy: `round-robin` (sequential) or `random`. |
| `failoverEnabled` | boolean | `true` | Capability 2: switch models **across providers** inside the `models` list when a subagent hits a connection failure (subagents only). |
| `injectRouteContext` | boolean | `true` | Capability 3 channel 2: inject a real one-line prompt stating the live provider/model into each subagent’s **own context** (subagents only). |
| `reasoningEffort` | string | — | Optional reasoning strength for a model entry (e.g. `high`, `max`). |
| `roleMode` | boolean | `false` | Capability 4: route by delegation role (explore / plan / patch) instead of one shared `models` list. |
| `exploreModels` / `planModels` / `patchModels` | array | `[]` | Capability 4 candidate queue per role. **Length = how many subagents of that role may run at once**; entries are strings or `{provider, model, reasoningEffort?}`. Empty falls back to the legacy `exploreProvider`/`exploreModel`/`exploreEffort` triple. |
| `roleSlotCooldownSeconds` | number | `15` | Capability 4: how long a candidate that failed is skipped for new delegations. `0` disables the cooldown. |

## Platform support

**Windows, macOS, and Linux are all supported**, and no platform-specific configuration is needed. The plugin's runtime code is **pure JavaScript**: `lib/index.js` (host half) and `lib/client.js` (client half) never touch the filesystem, join paths, spawn processes, or branch on `process.platform` — they only consume services and events the DSH host exposes, so platform differences are owned entirely by the host.

Platform-relevant surfaces that were checked and are now continuously verified:

- **Config path**: the profile patch lives at `.dsh/profiles/<profile>/cordis.patch.yml` under the user's home directory. On Windows that is `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml` (typically `C:\Users\<you>\.dsh\...`), the same convention as `~/.dsh/...` on macOS/Linux.
- **Dependency tree**: `package-lock.json` locks all three Windows optional native builds (`win32-x64-msvc`, `win32-arm64-msvc`, `win32-ia32-msvc`), and npm installs only the one matching the current platform. This plugin's direct dependency `@deepseek-ai/schemastery` is pure JS.
- **Line endings**: the repo does not pin `core.autocrlf`, so a Windows checkout may produce CRLF sources. The full suite was verified in that shape — assertions that parse source text match on substrings, never on line terminators, so CRLF vs LF does not change the result.
- **Path derivation**: repository scripts use `fileURLToPath`, never `URL.pathname`. The latter yields `/C:/...` on Windows, which `path.join` folds into the non-existent `\C:\...` — a hard failure that only ever appears on Windows.
- **Test discovery**: `npm test` invokes `node --test` with no glob, letting the Node test runner discover cases itself rather than depending on shell expansion — a glob like `test/*.test.mjs` expands under POSIX sh but is passed through literally by cmd/PowerShell.

CI runs the same suite on `ubuntu-latest`, `windows-latest`, and `macos-latest`, so these guarantees are continuously verified rather than asserted once.

## Subagent connection-failure failover

With `failoverEnabled` on (the default), when a subagent's own loop hits a connection-class failure, the plugin automatically switches models inside the `models` list and retries, following `strategy`. See [Capability 2](#capability-2--cross-provider-failover-if-one-provider-is-down-run-on-another-providers-model) above for the full account; the key points:

- **Cross-provider** — candidates are the whole `models` list, so it can fail over to a model from another provider, not just another model ID from the same vendor.
- **Trigger codes** — connection-class: `RATE_LIMIT`, `QUOTA`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`; auth-class: `AUTH`, `INVALID_CREDENTIAL` (invalid/expired key — switches, with a warning). Other codes do not switch.
- `round-robin`: advance to the next model in the list (the queue).
- `random`: pick any model (without checking whether it was used before).
- **Needs ≥ 2 models** — with fewer than 2 entries in `models`, the feature is inactive.
- **Exhaustion passes through** — once every pool entry has been tried and failed, the real error is let through; no infinite retries.
- **Inherited `reasoningEffort` is dropped on switch** — the new provider/model is requested at the default reasoning strength instead of forcing the primary's strength onto a provider that may not support it.
- **Sticky within a run** — subsequent steps of the same subagent run stay on the switched model.

It builds on the official `agent/request-error` + `agent/request` waterfalls and applies **only to subagents** — the main agent loop is never switched.

## Route visibility

Capability 3 has **two independent channels**. See [Capability 3](#capability-3--route-visibility-you-can-see-it-and-so-can-the-subagent) above for the full account:

### Channel 1: UI rows (for the user)

| View | What it shows | Source frame |
| --- | --- | --- |
| Trajectory | A row "Current provider/model: `provider/model`" | official `request/context` |
| Conversation | One of "Current provider/model" / "Switched to" / "Resumed on" | official `request/header` (by `reason`: `initial` / `change` / `resume`) |

Both registrations live inside `ctx.effect`, and the node `kind` values are plugin-owned (`trajectory-subagent-model` for the trajectory, `chat-subagent-model-notice` for the conversation) rather than reusing the Host's built-in `context` kind — the latter is filtered out by the Host's visibility rules.

### Channel 2: Prompt injection (for the subagent)

See the full description and sample text above. Implementation:

| Aspect | Behaviour |
| --- | --- |
| Value source | the `{provider, model}` returned by the `agent/request` waterfall **after** it settles (including a failover swap) |
| Injection point | the following `agent/pre-step`, where that step's message list is still mutable |
| Dedupe | an unchanged route injects nothing; a changed route replaces the stale line |
| Scope | `origin === "subagent"` only; the main agent is never touched |
| Setting | `injectRouteContext`, on by default |
| Message source | `plugin:dsh-subagent-role-router` + `form: "route-context"` (the v4 session format requires a producer-owned `source.kind`) |

> **The two channels do not replace each other**: UI rows never enter the model's context, and the prompt injection never appears in your UI.

## How it works

```text
Explicit agentOptions on the request
  → subagent-default-model settings
  → inherit parent session route
```

The plugin wraps the host `ctx.subagents` service (`start` / `startContinuable`), so it covers every delegation path — built-in `subagent` / `subagent_fork` tools and any custom tool that calls the service without providing `agentOptions`.

## License

This project is open-sourced under the [MIT License](LICENSE), copyright (c) 2026 LaoDing.

The MIT License grants anyone the freedom to deal in the Software without restriction, including using, copying, modifying, merging, publishing, distributing, sublicensing, and/or selling copies, provided that all copies or substantial portions retain the above copyright notice and this permission notice; the Software is provided "AS IS", without warranty of any kind. See [LICENSE](LICENSE) for the full text.
