# Embedding data flow — end-to-end

This doc traces exactly what data moves between the browser, this app, Microsoft Entra (AAD), and the Power BI REST API at each stage of an embed, with the schema of every request and response. It also covers the two non-obvious scenarios that drive most of the complexity: **paginated reports backed by a cross-workspace semantic model**, and **paginated report *visuals* embedded inside interactive `.pbix` reports**.

If you only read one thing, read **[Stage 4](#stage-4--mint-a-v2-embed-token-the-core-step)** — that's where the scenario-specific logic lives.

---

## Index

1. [Stage 1 — AAD access token (MSAL client-credentials)](#stage-1--aad-access-token-msal-client-credentials)
2. [Stage 2 — Workspace inventory: reports, datasets, dashboards](#stage-2--workspace-inventory-reports-datasets-dashboards)
3. [Stage 3 — Cross-workspace dataset resolution (paginated-only)](#stage-3--cross-workspace-dataset-resolution-paginated-only)
4. [Stage 4 — Mint a V2 embed token (the core step)](#stage-4--mint-a-v2-embed-token-the-core-step)
5. [Stage 5 — Dashboard token (V1, the different animal)](#stage-5--dashboard-token-v1-the-different-animal)
6. [Stage 6 — Frontend embed configuration](#stage-6--frontend-embed-configuration)
7. [Scenario walkthroughs](#scenario-walkthroughs)

---

## Stage 1 — AAD access token (MSAL client-credentials)

**Who:** the FastAPI server, via MSAL, talking to `login.microsoftonline.com`.
**When:** on every request that ends up calling the Power BI REST API (MSAL caches the token in-process until ~5 min before expiry, so most calls are cache hits).
**Code:** [app/auth.py:27](../app/auth.py#L27)

### Request

MSAL constructs the OAuth2 `client_credentials` request for you. The wire-level form:

```http
POST https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token
Content-Type: application/x-www-form-urlencoded

client_id={CLIENT_ID}
&client_secret={CLIENT_SECRET}
&grant_type=client_credentials
&scope=https://analysis.windows.net/powerbi/api/.default
```

| Field | Purpose | Why it's necessary |
|---|---|---|
| `client_id` | The Entra app registration ID (the service principal we created) | Identifies *who* is authenticating |
| `client_secret` | The password for that app registration | Proves we are the owner of that `client_id` |
| `grant_type=client_credentials` | OAuth2 flow type | App-only auth (no user in the loop); required because we're not doing delegated user sign-in |
| `scope=.../.default` | Resource the token is for | Tells AAD "mint a token that's valid for the Power BI API resource" — `.default` means "use all app permissions already granted" |

### Response

```json
{
  "token_type": "Bearer",
  "expires_in": 3599,
  "ext_expires_in": 3599,
  "access_token": "eyJ0eXAiOiJKV1Q..."
}
```

| Field | What it is |
|---|---|
| `access_token` | A signed JWT. The JWT body includes claims like `appid` (= our `client_id`), `oid` (service principal object ID), `tid` (tenant), `roles`, and `aud` (= `https://analysis.windows.net/powerbi/api`) |
| `expires_in` | Seconds until the token is no longer accepted by Power BI (always ~1 hour) |
| `token_type` | Always `Bearer` — the token goes in `Authorization: Bearer …` |

**This token does NOT go to the browser.** It's an identity-proving token for server-to-server calls to the Power BI REST API only. Exposing it to the browser would let anyone impersonate the service principal against every Power BI API endpoint for an hour. The browser gets a very different, tightly-scoped **embed token** later (Stages 4–5).

---

## Stage 2 — Workspace inventory: reports, datasets, dashboards

**Who:** the FastAPI server → Power BI REST API, using the AAD token from Stage 1.
**When:** on page load ([app/main.py:27](../app/main.py#L27)), and again inside `generate_embed_token()` at mint time.
**Code:** [app/powerbi.py:18](../app/powerbi.py#L18) (reports), [app/powerbi.py:37](../app/powerbi.py#L37) (datasets), [app/powerbi.py:47](../app/powerbi.py#L47) (dashboards).

All three calls share the same shape:

```http
GET https://api.powerbi.com/v1.0/myorg/groups/{WORKSPACE_ID}/{reports|datasets|dashboards}
Authorization: Bearer {AAD access token from Stage 1}
```

### Response schema — reports

```json
{
  "value": [
    {
      "id": "e1b23456-...",
      "name": "Sales Overview",
      "reportType": "PowerBIReport",        // or "PaginatedReport"
      "embedUrl": "https://app.powerbi.com/reportEmbed?reportId=...&groupId=...",
      "datasetId": "8c4567ab-...",          // null for paginated reports with no bound dataset
      "webUrl": "https://app.powerbi.com/groups/..."
    }
  ]
}
```

### Response schema — datasets

```json
{
  "value": [
    { "id": "8c4567ab-...", "name": "Sales Model", "configuredBy": "...", "isRefreshable": true }
  ]
}
```

### Response schema — dashboards

```json
{
  "value": [
    { "id": "d789abcd-...", "displayName": "Exec Dashboard",
      "embedUrl": "https://app.powerbi.com/dashboardEmbed?dashboardId=..." }
  ]
}
```

### What we keep and why

| Field | Kept? | Why |
|---|---|---|
| `id` | yes | Used in the URL for subsequent REST calls and passed to the JS SDK's `config.id` |
| `name` / `displayName` | yes | Sidebar label |
| `reportType` | yes | Drives branching — interactive vs paginated use different SDK configs and (in one case) different token endpoints |
| `embedUrl` | yes | Literally the iframe `src` the JS SDK uses. The service itself builds this URL; do NOT hand-construct it |
| `datasetId` | yes (kept on model, unused today) | For future per-report dataset lookups |
| Everything else | no | Not needed for the embed flow |

Schema: [app/models.py:9](../app/models.py#L9) (`Report`, `Dataset`, `Dashboard`).

---

## Stage 3 — Cross-workspace dataset resolution (paginated-only)

**Why this stage exists at all:** a paginated report (`.rdl`) can be published to Workspace A but get its data from a Power BI semantic model that lives in Workspace B. At mint time we must tell Power BI "the session is allowed to read *this* dataset in *that* workspace too" — otherwise the RDL viewer queries Workspace B over XMLA, gets denied, and renders blank.

**Who:** server → Power BI REST API.
**When:** inside `generate_embed_token()`, once per paginated report in the workspace.
**Code:** [app/powerbi.py:64](../app/powerbi.py#L64)

### Step 3a — `GET /reports/{id}/datasources`

Returns the data connections of a single report.

```json
{
  "value": [
    {
      "datasourceType": "AnalysisServices",
      "connectionDetails": {
        "server": "powerbi://api.powerbi.com/v1.0/myorg/Finance%20Workspace",
        "database": "Finance Model"
      }
    }
  ]
}
```

Only `datasourceType == "AnalysisServices"` entries matter (those are the XMLA-backed Power BI semantic models). Everything else — SQL, Excel, REST, etc. — we ignore here because the user's service principal is already authorised for them via the standard workspace grant.

The `server` field follows a fixed XMLA pattern: the last path segment is the **workspace name** (URL-encoded). The `database` field is the **dataset name**.

### Step 3b — resolve workspace name → workspace ID

```http
GET https://api.powerbi.com/v1.0/myorg/groups?$filter=name eq 'Finance Workspace'
```

Response is a normal groups collection; we take `value[0].id`.

### Step 3c — resolve dataset name → dataset ID

```http
GET https://api.powerbi.com/v1.0/myorg/groups/{ws_id}/datasets?$filter=name eq 'Finance Model'
```

Again, `value[0].id`.

### Output

Back to `generate_embed_token()` as a list of `(workspace_id, dataset_id)` tuples. Each tuple contributes one entry to `datasets[]` and (if it's a new workspace) one entry to `targetWorkspaces[]` in the V2 token body.

**Non-fatal on failure.** If any sub-call returns a non-200 or empty result, we skip that datasource rather than raising. Rationale: a stale or typo'd XMLA reference shouldn't break the entire workspace's embed flow; worst case the paginated report renders blank (which is the pre-existing failure mode anyway).

---

## Stage 4 — Mint a V2 embed token (the core step)

**Who:** server → `POST https://api.powerbi.com/v1.0/myorg/GenerateToken` (the **V2 multi-resource** endpoint — not the per-report one).
**When:** on `GET /api/embed-info/{report_id}` from the browser.
**Code:** [app/powerbi.py:124](../app/powerbi.py#L124)

### Request body — full schema

```json
{
  "reports": [
    { "id": "<reportA>", "allowEdit": false },
    { "id": "<reportB>", "allowEdit": false },
    { "id": "<every report in the workspace>", "allowEdit": false }
  ],
  "datasets": [
    { "id": "<ds1>", "xmlaPermissions": "ReadOnly" },
    { "id": "<ds2>", "xmlaPermissions": "ReadOnly" }
  ],
  "targetWorkspaces": [
    { "id": "<this workspace id>" },
    { "id": "<cross-workspace id 1>" }
  ]
}
```

### Why each field is shaped this way

**`reports[]` — every report in the workspace, not just the one requested.**

The V2 embed token grants the browser session read permission on exactly the resources listed. If an interactive `.pbix` we embed contains a **paginated report visual** (yes, you can drop a paginated report onto an interactive page), the SDK will at render time make a request for *that* paginated report's ID. If the token doesn't list it, Power BI returns `403 PowerBINotAuthorizedException` and the visual renders a broken-image box. There is no public REST API to enumerate a `.pbix`'s embedded paginated report visuals at runtime, so we can't be selective — we include every report in the workspace. See [app/powerbi.py:131-134](../app/powerbi.py#L131-L134).

`allowEdit: false` — this app is view-only.

**`datasets[]` — every known dataset, with `xmlaPermissions: "ReadOnly"`.**

Interactive reports bind to a single dataset via DirectQuery / import. Paginated reports may bind to an Analysis Services (XMLA) dataset. The RDL viewer issues DAX/XMLA queries *from the browser* against that dataset; those queries carry the embed token. Without the dataset listed (and `xmlaPermissions: "ReadOnly"` on it) the query gets denied.

Even interactive-only tokens include this so the same token works for mixed workspaces.

**`targetWorkspaces[]` — the requesting workspace plus any cross-workspace datasets' workspaces.**

This is the field that makes cross-workspace paginated reports work. `datasets[]` says "the token can read these dataset IDs"; `targetWorkspaces[]` says "…and these are the workspaces those datasets are allowed to live in." Both are required.

**Why not use V1 (`/groups/{ws}/reports/{id}/GenerateToken`)?**

V1 is per-report and has no `datasets[]` or `targetWorkspaces[]` fields. It returns `400 InvalidRequest` the moment a paginated report is bound to a Power BI semantic model (which, in Fabric, is the common case). V2 replaces V1 for every report type, so we use V2 unconditionally for reports. See README discussion: [README.md](../README.md).

### Response

```json
{
  "token": "H4sIAAAAAAAEAC...",     // opaque, ~2-4 KB
  "tokenId": "0e6f...-a1b2",        // not used by this app
  "expiration": "2026-04-24T21:30:00Z"
}
```

The response shape is documented here: https://learn.microsoft.com/rest/api/power-bi/embed-token/generate-token

| Field | What it is / what it's for |
|---|---|
| `token` | **This is the embed token.** It's a signed, short-lived credential scoped to exactly the reports/datasets/workspaces in the request. Safe to send to the browser — it cannot be exchanged for an AAD token, cannot call arbitrary REST endpoints, and expires in an hour |
| `expiration` | ISO-8601 UTC timestamp when the token stops working. Frontend doesn't auto-refresh today; if the user sits on the page past this, their next interaction will error and they reload |
| `tokenId` | Opaque handle for audit / revoke APIs. Unused here |

### What the FastAPI route returns to the browser

Packaged as `EmbedInfo` ([app/models.py:28](../app/models.py#L28)):

```json
{
  "embed_id":    "<the report id the user clicked>",
  "embed_url":   "https://app.powerbi.com/reportEmbed?reportId=...&groupId=...",
  "embed_token": "H4sIAAAAA...",
  "token_type":  "Embed",
  "embed_type":  "report",
  "report_type": "PowerBIReport",
  "expiration":  "2026-04-24T21:30:00Z"
}
```

Only `embed_id`, `embed_url`, `embed_token`, `embed_type`, `report_type` are consumed by the JS SDK. `token_type` is hard-coded to `"Embed"` (vs `"Aad"`) because we are *not* handing the browser an AAD token. `expiration` is included so future work can auto-refresh.

---

## Stage 5 — Dashboard token (V1, the different animal)

Dashboards have no V2 equivalent. They **must** use the V1 per-dashboard endpoint.

**Code:** [app/powerbi.py:201](../app/powerbi.py#L201)

### Request

```http
POST https://api.powerbi.com/v1.0/myorg/groups/{WORKSPACE_ID}/dashboards/{DASHBOARD_ID}/GenerateToken
Content-Type: application/json

{ "accessLevel": "View" }
```

### Response — same shape as Stage 4

```json
{ "token": "H4sIAAAA...", "tokenId": "...", "expiration": "2026-04-24T21:30:00Z" }
```

### Why no `reports[]`, `datasets[]`, `targetWorkspaces[]`?

A dashboard is a visual collage of *tile snapshots* from its underlying reports — the tiles are cached images/queries owned by the dashboard, not live report frames. The browser isn't making live dataset queries through the dashboard, so the token doesn't need dataset/workspace scopes. V1 is sufficient and is the *only* option.

`accessLevel: "View"` — the V1 field equivalent to V2's `allowEdit: false`.

---

## Stage 6 — Frontend embed configuration

**Who:** `static/js/embed.js` in the browser, using Microsoft's `powerbi-client` SDK (loaded from a CDN in the Jinja template).
**Code:** [static/js/embed.js:304](../static/js/embed.js#L304)

### What the SDK consumes

The SDK's `powerbi.embed(container, config)` reads a config object. What goes in depends on type:

#### Interactive report (`.pbix`)

```js
{
  type: "report",
  id: info.embed_id,
  embedUrl: info.embed_url,
  accessToken: info.embed_token,
  tokenType: models.TokenType.Embed,      // NOT Aad
  settings: {
    panes: {
      filters:        { visible: true, expanded: false },
      pageNavigation: { visible: true }
    },
    background: models.BackgroundType.Default
  }
}
```

#### Paginated report (`.rdl`)

```js
{
  type: "report",
  id: info.embed_id,
  embedUrl: info.embed_url,
  accessToken: info.embed_token,
  tokenType: models.TokenType.Embed
  // NO settings key. The RDL viewer engine explicitly does NOT support
  // settings.panes, settings.background, or the loaded/rendered events.
  // Passing any of them makes it hang during cold init.
}
```

See [static/js/embed.js:339-342](../static/js/embed.js#L339-L342) for the comment in code.

#### Dashboard

```js
{
  type: "dashboard",            // not "report"
  id: info.embed_id,
  embedUrl: info.embed_url,
  accessToken: info.embed_token,
  tokenType: models.TokenType.Embed,
  pageView: "fitToWidth"        // dashboard-specific; reports ignore it
}
```

### Why `tokenType: Embed` and not `Aad`

`TokenType.Aad` tells the SDK "the `accessToken` is the AAD bearer token; authenticate as that identity." That would require us to leak the Stage 1 AAD token to the browser — unacceptable.

`TokenType.Embed` tells the SDK "this is a short-lived, pre-scoped embed token minted by a trusted backend." Matches what we mint in Stage 4/5.

### Events the app listens on

```js
embedded.on("loaded",   () => showReady())   // interactive only
embedded.on("rendered", () => showReady())   // interactive only
embedded.on("error",    (e) => showError(e.detail?.message))  // all types
```

For paginated reports, the SDK does *not* fire `loaded` or `rendered` — the RDL viewer runs in an isolated iframe Microsoft does not instrument. The app instead calls `showReady()` synchronously after `powerbi.embed()` and relies on the RDL viewer's own in-frame spinner for feedback. See [static/js/embed.js:355-360](../static/js/embed.js#L355-L360).

---

## Scenario walkthroughs

Four scenarios, showing exactly what the V2 body looks like and why.

Assume the workspace contains:

| Type | Name | ID | Notes |
|---|---|---|---|
| Interactive | `Sales Overview` | `R_SALES` | Binds to dataset `DS_SALES` in *this* workspace. Contains a paginated report visual referencing `R_INV` |
| Interactive | `Plain Report` | `R_PLAIN` | Binds to `DS_SALES`. No embedded paginated visual |
| Paginated | `Inventory Detail` | `R_INV` | XMLA-bound to `DS_INV` in *the same* workspace |
| Paginated | `Finance Monthly` | `R_FIN` | XMLA-bound to `DS_FINMODEL` in **Workspace B** |
| Dashboard | `Exec` | `DB_EXEC` | Tiles from `R_SALES` and `R_PLAIN` |

### Scenario A — user clicks the interactive `Plain Report`

No paginated visuals inside, no cross-workspace datasets anywhere. Body to V2:

```json
{
  "reports": [
    { "id": "R_SALES", "allowEdit": false },
    { "id": "R_PLAIN", "allowEdit": false },
    { "id": "R_INV",   "allowEdit": false },
    { "id": "R_FIN",   "allowEdit": false }
  ],
  "datasets": [
    { "id": "DS_SALES", "xmlaPermissions": "ReadOnly" },
    { "id": "DS_INV",   "xmlaPermissions": "ReadOnly" },
    { "id": "DS_FINMODEL", "xmlaPermissions": "ReadOnly" }
  ],
  "targetWorkspaces": [
    { "id": "<this workspace>" },
    { "id": "<Workspace B>" }
  ]
}
```

The token is *over-scoped* relative to this user's immediate needs — we include every report and every cross-workspace dataset in the workspace. That's intentional: Stage 4 always builds the maximal body so clicking a *different* report afterward doesn't require a new mint. (Today the app mints fresh on every click anyway, but the body is the same shape.)

### Scenario B — user clicks the interactive `Sales Overview`, which contains a paginated-report visual

Identical V2 body to Scenario A. The work that makes the paginated-visual-inside-interactive case succeed isn't different fields — it's the *presence of `R_INV` in `reports[]` and `DS_INV` in `datasets[]`*, which Scenario A already does.

When the SDK renders `R_SALES`, it hits the paginated-visual rendering path, which fires an internal request for `R_INV`. Because `R_INV` is listed in `reports[]` and `DS_INV` in `datasets[]`, Power BI authorises it and the visual renders. If we had minted a V1 single-report token for `R_SALES`, the paginated visual would 403 and the visual pane would show "Couldn't load the visual."

### Scenario C — user clicks the paginated `Finance Monthly` (cross-workspace)

Same V2 body as A and B. What *did* the work earlier:

1. Stage 3 ran on every paginated report (including `R_FIN`), hit `/reports/R_FIN/datasources`, and found the XMLA server `powerbi://api.powerbi.com/v1.0/myorg/Workspace%20B` with database `Finance Model`.
2. Stage 3 resolved Workspace B → workspace ID, then `Finance Model` → `DS_FINMODEL`.
3. `DS_FINMODEL` was added to `datasets[]` and Workspace B to `targetWorkspaces[]`.

When the RDL viewer loads and issues XMLA queries against `DS_FINMODEL`, Power BI checks: is the dataset in the token? Yes. Is the workspace that hosts it listed in `targetWorkspaces`? Yes. Query authorised.

### Scenario D — user clicks the dashboard `Exec`

Completely different endpoint (Stage 5, V1). Body:

```json
{ "accessLevel": "View" }
```

No `reports[]`, no `datasets[]`, no `targetWorkspaces[]`. The dashboard renders tile snapshots, not live report frames, so no dataset-level authorisation is needed.

---

## A note on token lifetimes and rotation

- **AAD token (Stage 1):** ~1 hour, MSAL caches and reuses.
- **Embed token (Stage 4/5):** ~1 hour default, and the two are independent. An expired AAD token doesn't invalidate an already-minted embed token, and vice versa.
- **This app:** mints a fresh embed token on every sidebar click. Acceptable because mint latency is ~200-500 ms and we want the token scoped as narrowly as possible in time. A production app would cache per-session or refresh on the `tokenExpired` SDK event.

---

## Quick reference — where each stage lives

| Stage | File | Symbol |
|---|---|---|
| 1. AAD token | [app/auth.py](../app/auth.py) | `get_access_token()` |
| 2. Workspace inventory | [app/powerbi.py](../app/powerbi.py) | `list_reports`, `list_datasets`, `list_dashboards` |
| 3. Cross-workspace resolve | [app/powerbi.py](../app/powerbi.py) | `_resolve_cross_workspace_datasets` |
| 4. V2 embed token | [app/powerbi.py](../app/powerbi.py) | `generate_embed_token` |
| 5. V1 dashboard token | [app/powerbi.py](../app/powerbi.py) | `generate_dashboard_embed_token` |
| 6. SDK wiring | [static/js/embed.js](../static/js/embed.js) | `embedItem(...)` |

---

## Watching the flow in the VS Code debugger

This section maps every stage/scenario above to a concrete set of breakpoints you can set right now, plus which VS Code launch configuration to use. Configs are defined in [.vscode/launch.json](../.vscode/launch.json).

### Which launch config for what

| Goal | Config | Why |
|---|---|---|
| See the full request flow from a sidebar click end to end (Stages 2-5) | **FastAPI: uvicorn (reload)** | Starts the server under debugpy. Breakpoints in `app/*.py` fire on every browser interaction |
| Debug **only Stage 1** (AAD/MSAL) without any HTTP stack | **Smoke test: get_access_token** | Runs [.vscode/smoke_auth.py](../.vscode/smoke_auth.py) in isolation — one function, no FastAPI, no Power BI REST calls |
| Attach to a uvicorn you already started in a terminal | **Attach to running uvicorn (port 5678)** | Requires starting uvicorn with `debugpy --listen 5678 --wait-for-client` first |
| Ad-hoc script or paste-code-in-a-file experiments | **Python: current file** | Debugs whatever `.py` is focused |
| Stage 6 (browser-side SDK) | *not a VS Code config* — use **Chrome/Edge DevTools** with the `Sources` tab and `static/js/embed.js` open. VS Code can't step through the Power BI iframe's internal code |

### Universal breakpoint set (set these once)

Open the "FastAPI: uvicorn (reload)" config and drop breakpoints on these lines. Together they cover every stage.

| # | File:line | Stage | What to inspect in the Variables pane |
|---|---|---|---|
| 1 | [app/auth.py:28](../app/auth.py#L28) | Stage 1 — right after MSAL returns | `result` — the raw dict from MSAL. Look for `access_token`, `expires_in`, or an `error`/`error_description` pair |
| 2 | [app/powerbi.py:24](../app/powerbi.py#L24) | Stage 2 — `list_reports` response parsed | `resp.json()` has `.value` = the full reports array. Inspect every report's `reportType` and `embedUrl` |
| 3 | [app/powerbi.py:80](../app/powerbi.py#L80) | Stage 3 — `/datasources` response inspected | `resp.json().get("value", [])` — look for entries with `datasourceType == "AnalysisServices"`. `conn.get("server")` is the XMLA URL whose last segment is the workspace name |
| 4 | [app/powerbi.py:119](../app/powerbi.py#L119) | Stage 3 — after name-to-ID resolution | `results` — the final `[(workspace_id, dataset_id), …]` list that feeds Stage 4 |
| 5 | [app/powerbi.py:155](../app/powerbi.py#L155) | Stage 4 — **right before POST /GenerateToken** | `body` — this is the exact V2 request body from the scenario walkthroughs. Confirm `reports[]` has every workspace report, `datasets[]` includes any cross-workspace ones, `targetWorkspaces[]` has this workspace plus any extras |
| 6 | [app/powerbi.py:160](../app/powerbi.py#L160) | Stage 4 — after POST returns | `data` — the response with `token`, `tokenId`, `expiration`. `data["token"]` is what the browser will receive |
| 7 | [app/powerbi.py:208](../app/powerbi.py#L208) | Stage 5 — **right before dashboard POST** | `body` — should be just `{"accessLevel": "View"}`. Confirms V1 path for dashboards |

Tip: in the Run and Debug panel's breakpoints sidebar, group them so you can toggle each stage on/off.

### Per-scenario playbook

Start the **FastAPI: uvicorn (reload)** config, let it boot, then open http://localhost:8000 in a browser. Each scenario below says what to click and what to watch for.

#### Scenario A — plain interactive report (no paginated visual, no cross-ws)

1. Click **Plain Report** in the sidebar.
2. Breakpoint **1** fires first: confirm `result["access_token"]` is present. Step over.
3. Breakpoint **2** fires twice (once via the page load, once via the mint path) as `list_reports` runs. `resp.json()["value"]` should contain all four reports in the workspace.
4. Breakpoint **3** fires *once per paginated report in the workspace*, not once per clicked report. Even for Scenario A we still run Stage 3 on `R_INV` and `R_FIN`. For `R_INV` there will be an XMLA datasource pointing to the *same* workspace — that's fine, it just results in no new additions. For `R_FIN` you'll see a cross-workspace URL.
5. Breakpoint **5** is the key one. Inspect `body`:
   - `reports[]` has 4 entries (all four workspace reports — this is what "always include every workspace report" looks like).
   - `datasets[]` has `DS_SALES`, `DS_INV`, `DS_FINMODEL`.
   - `targetWorkspaces[]` has this workspace + Workspace B.
6. Step over; breakpoint **6** shows `data["token"]` — copy the first 40 chars to the clipboard if you want to decode it with https://jwt.ms.
7. The token is returned to the browser; breakpoints 7 does not fire (dashboard path).

#### Scenario B — interactive report containing a paginated-report visual

1. Click **Sales Overview** in the sidebar.
2. Breakpoints 1-6 fire identically to Scenario A. **This is the insight**: the V2 body at breakpoint 5 is *exactly the same shape* as Scenario A. There is no special field for "this report contains a paginated visual" — the ability to render the visual falls out naturally because `R_INV` is already in `reports[]` and `DS_INV` is in `datasets[]`.
3. To see the visual-specific round-trip, open **Chrome DevTools → Network** before clicking. Filter by `powerbi.com`. When `Sales Overview` renders, watch for a second request the SDK makes referencing `R_INV`'s ID — that's the paginated-visual fetch, authenticated by the embed token you minted at breakpoint 6.

#### Scenario C — paginated report bound to a cross-workspace semantic model

1. Click **Finance Monthly** in the sidebar.
2. Breakpoint **3** is where the interesting work happens *for this scenario's dataset*. When it fires for `R_FIN`, inspect:
   - `ds.get("datasourceType")` → `"AnalysisServices"`
   - `conn["server"]` → `"powerbi://api.powerbi.com/v1.0/myorg/Workspace%20B"` (URL-encoded space)
   - `workspace_name` after the `urllib.parse.unquote(...)` line → `"Workspace B"`
3. Step through the two resolution HTTP calls (name→ID for workspace, then name→ID for dataset).
4. Breakpoint **4** fires: `results` should be `[(<Workspace B's UUID>, "DS_FINMODEL")]`.
5. Breakpoint **5** — inspect `body`:
   - `datasets[]` includes `DS_FINMODEL`.
   - `targetWorkspaces[]` has two entries: this workspace and Workspace B.
6. After the POST returns (breakpoint 6), `data["token"]` is what the RDL viewer will use for its XMLA queries against Workspace B. If that token were missing either the dataset or the target workspace, the RDL viewer would render blank.

If the report renders blank despite the token looking correct at breakpoint 5, the cause is almost certainly XMLA endpoints being disabled at the tenant or workspace level (see [docs/03-troubleshooting.md](03-troubleshooting.md)) — not anything you'd catch in this debugger path.

#### Scenario D — dashboard

1. Click **Exec** in the sidebar.
2. Breakpoint **1** fires (auth still needed).
3. Breakpoints 2-6 do **not** fire. The dashboard path goes through `generate_dashboard_embed_token()`, bypassing all the V2 report-token plumbing.
4. Breakpoint **7** fires: confirm `body == {"accessLevel": "View"}`. Step over; the response shape is the same as Stage 4's — `token` + `expiration`.

### Isolating Stage 1 without the whole server

If auth itself is broken (e.g. you just rotated the client secret in Entra and want to verify), skip uvicorn and use **Smoke test: get_access_token**. It runs [.vscode/smoke_auth.py](../.vscode/smoke_auth.py):

```python
from app.auth import get_access_token
token = get_access_token()
print(f"token acquired, length={len(token)}, prefix={token[:40]}...")
```

Set a breakpoint on line 28 of [app/auth.py](../app/auth.py#L28) and press F5. If `result` contains `error == "invalid_client"`, your `CLIENT_SECRET` is wrong (you pasted the Secret ID instead of the Secret Value — the classic one). If it contains `error == "unauthorized_client"`, the tenant setting from [docs/01-azure-setup.md](01-azure-setup.md) step A5 hasn't propagated yet.

### Browser-side debugging for Stage 6

VS Code can't step into the Power BI iframe. For SDK-level issues, open DevTools:

- **Console tab** — the SDK logs structured errors here. For paginated reports the most common one is `PowerBINotAuthorizedException` (a report ID is missing from the token's `reports[]`) or `DatasetNotAccessibleFromTargetWorkspace` (cross-workspace dataset resolution failed at Stage 3).
- **Network tab** — filter on `powerbi.com`. You will see the `/reportEmbed` and `/rdlEmbed` requests plus any XMLA `POST`s the RDL viewer makes. The `Authorization` header on those carries the embed token you minted at Stage 4.
- **Sources tab** — `static/js/embed.js` is the app's wiring code; breakpoints in [static/js/embed.js:304](../static/js/embed.js#L304) (`embedItem`) let you inspect the `config` object being handed to `powerbi.embed()` and confirm `tokenType: Embed`, correct `type`, and a non-empty `accessToken`.
