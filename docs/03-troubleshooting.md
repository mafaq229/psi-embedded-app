# Troubleshooting

Symptoms → likely cause → fix. Check these in order — the first few are by far the most common.

## `/api/reports` returns `401 Unauthorized`

**Cause 1:** A5 tenant setting (`Service principals can use Fabric APIs`) hasn't propagated yet.
**Fix:** Wait 15 minutes after enabling, then retry. Propagation is real and can take the full 15.

**Cause 2:** The setting was scoped to a security group and your service principal isn't in it.
**Fix:** Re-open Admin portal → Tenant settings → switch to "entire organization" for now, OR add the app registration to the security group.

## `/api/reports` returns `[]` (empty list)

**Cause:** The service principal isn't a **Member** of the workspace.
**Fix:** Workspace → Manage access → ensure `pbi-embed-app` is listed with role **Member** (not Viewer, not Contributor → Viewer doesn't work, Contributor works but Member is cleaner).

## `generate_embed_token` returns `403 Forbidden`

**Cause:** Workspace isn't on Fabric capacity (no ♦ diamond).
**Fix:** Workspace settings → License info → set to Fabric capacity → pick your F2 → Save. Confirm the diamond appears.

Sub-cause: F2 capacity is paused.
**Fix:** Azure Portal → your Fabric resource → **Resume**.

## `generate_embed_token` returns `400 "Paginated report with Power BI Dataset as a datasource is not supported with V1 embed token"`

**Cause:** The paginated (RDL) report is bound to a Power BI semantic model, and the V1 single-resource GenerateToken endpoint doesn't support that combination. Microsoft requires the V2 multi-resource endpoint (`POST /v1.0/myorg/GenerateToken`) with a `datasets[]` entry per semantic model where `xmlaPermissions` = `ReadOnly` and `allowEdit` = `false`.

**Fix:** This app already mints tokens via V2 in `app/powerbi.py` → `generate_embed_token()`. If you're seeing this error, check:

- Someone reverted that function back to the V1 URL (`/groups/{id}/reports/{id}/GenerateToken`). Compare against git history.
- The **XMLA endpoint** tenant setting is enabled (Admin portal → Tenant settings → *Allow XMLA endpoints and Analyze in Excel with on-premises datasets*).
- The workspace's XMLA endpoint is set to **Read Only** or **Read Write** (workspace settings → Premium → XMLA Endpoint).
- The semantic model and paginated report are both on Fabric/Premium capacity.

## MSAL returns `invalid_client`

**Cause:** You pasted the **Secret ID** instead of the **Value** when collecting `CLIENT_SECRET`.
**Fix:** Back to A3.3 — create a brand new client secret and **copy the Value column** this time. Update `.env`.

## MSAL returns `AADSTS700016: Application not found in the directory`

**Cause:** `TENANT_ID` and `CLIENT_ID` belong to different tenants (e.g. you registered the app in one Entra tenant but are authenticating against another).
**Fix:** In the Entra app's Overview, re-copy both IDs and update `.env`.

## Paginated report embed token succeeds but the report never renders (spinner or blank)

**Symptom:** The embed token is minted (no 502 error from `/api/embed-info`), the Power BI SDK starts initialising, but the report stays blank or the spinner never resolves. In browser DevTools the Network tab shows a failed request to `wabi-*.analysis.windows.net/powerbi/refresh/subscribe` with **No response headers**.

**Cause:** XMLA endpoints are not enabled. When a paginated report uses a Power BI semantic model as a datasource, the Power BI render engine accesses it via XMLA. Two settings must both be on:

1. **Tenant setting (Admin portal, one-time)**
   Admin portal → Tenant settings → Integration settings → *Allow XMLA endpoints and Analyze in Excel with on-premises datasets* → **Enabled** for the entire org (or at least the security group your service principal belongs to).

2. **Capacity setting (workspace level)**
   Power BI service → Workspace settings → Premium → **XMLA Endpoint** → set to **Read Only** (or Read Write).

Neither setting is on by default for new tenants. Enabling the tenant setting can take 5–10 minutes to propagate; the capacity setting takes effect immediately.

**Note:** The embed token request already includes `xmlaPermissions: "ReadOnly"` for every dataset in the token body — that field is a client-side hint, not the actual gate. The real gate is the two settings above.

## Paginated report only renders after clicking an interactive report first

**Symptom:** Clicking a paginated report directly shows a permanent loading spinner that never resolves and no error appears. If the user first clicks any interactive report and then clicks the paginated report, it renders correctly every time.

**Root cause — unsupported SDK settings passed to the RDL viewer:**
The Power BI JavaScript SDK uses two completely different rendering engines depending on report type:

| Engine | Report type | Supports |
|---|---|---|
| `reportEmbed` | Interactive (`.pbix`) | `settings.panes`, `settings.background`, filter pane, page navigation |
| `rdlEmbed` | Paginated (`.rdl`) | **None of the above** |

The original embed config passed `settings.panes.filters`, `settings.panes.pageNavigation`, and `settings.background = BackgroundType.Transparent` for all report types. The RDL viewer rejected these unsupported settings during its cold-start initialisation and silently hung.

When an interactive report was loaded first, the Power BI SDK's global service client was already initialised and the cluster connection was warm — so the RDL viewer could skip the failing init path and render successfully on the second attempt. That "click interactive first" behaviour was the key diagnostic clue: it exposed that the failure was in SDK initialisation state, not in the token, network, or capacity.

**Fix 1 in `static/js/embed.js`:** pass no `settings` for paginated reports.

```js
if (isDashboard) {
    config.pageView = "fitToWidth";
} else if (isPaginated) {
    // RDL viewer rejects panes / background — pass nothing.
} else {
    config.settings = { panes: { filters: { ... }, pageNavigation: { ... } }, background: ... };
}
```

**Fix 2 in `static/js/embed.js`:** call `showReady()` immediately for paginated reports instead of waiting for `loaded`/`rendered` events that the RDL viewer never fires.

```js
if (isPaginated) {
    // 'loaded' and 'rendered' are unsupported for paginated reports — the
    // app spinner would block the rendered content forever without this.
    showReady();
} else {
    embedded.on("loaded", () => showReady());
    embedded.on("rendered", () => showReady());
}
embedded.on("error", (event) => { ... });
```

Without Fix 2, the paginated report silently renders inside the container but the app's own "Minting embed token…" spinner sits on top of it permanently. The "click interactive first" workaround happened to leave the container in `is-ready` state, which is why the content became visible in that path.

---

## Paginated report visual inside an interactive report fails to render

**Symptom:** An interactive Power BI report that contains a **Paginated Report visual** (a paginated report embedded as a visual on a `.pbix` report page via Insert → Visualizations → Paginated report) fails to display the paginated content. The surrounding interactive visuals load fine; only the paginated visual shows an error.

**Root cause — embed token missing the paginated report resource:**
The V2 embed token is built from an explicit list of resources (`reports[]`, `datasets[]`, `targetWorkspaces[]`). When the backend minted a token for an interactive report, it only included that one report in `reports[]`. The paginated report visual inside it tried to render a second, separate paginated report — but that report's ID was not in the token, so the Power BI service rejected the render request.

This is different from embedding a paginated report directly. When a `.pbix` references a paginated report as a visual, the interactive report's embed session needs an authorised token for **both** the interactive report and every paginated report it contains.

**How it was debugged:** The paginated report worked fine when embedded on its own (standalone paginated embed). It only failed inside the interactive report. Comparing the two token requests showed the standalone token listed the paginated report in `reports[]` while the interactive token did not. Adding the paginated report ID to the interactive report's token body fixed it immediately.

**Fix in `app/powerbi.py`:** `generate_embed_token()` now calls `list_reports()` on every request and includes **all workspace reports** in the token's `reports[]` array. This ensures any paginated report visual — regardless of which interactive report contains it — is always authorised.

```python
all_reports = await list_reports(workspace_id)
reports_in_token = [{"id": r.id, "allowEdit": False} for r in all_reports]
# ... then pass reports_in_token as "reports" in the V2 GenerateToken body
```

**Why include all reports rather than just the specific paginated report?**
The interactive report's content is not inspectable via the REST API at embed-token-generation time — you cannot enumerate which paginated visuals a `.pbix` contains without parsing the report's internal `.zip` structure. Including all workspace reports is the safe, simple approach for a small workspace. For large workspaces with many reports you would instead inspect the report's datasources or maintain an explicit allowlist.

## Paginated report loads but is blank / gray

**Cause 1:** The RDL was published with no visible content (e.g. only a data source, no textbox or table).
**Fix:** Open the `.rdl` in Report Builder, add a Textbox with any visible text, and re-publish.

**Cause 2:** The data source the RDL references isn't accessible from the Power BI service.
**Fix:** For learning, keep it simple — use a Textbox-only report with no external data source.

## Interactive report loads but says "Effective identity is missing"

**Cause:** The dataset uses Row-Level Security (RLS) and needs an identity passed into the embed token.
**Fix:** You picked a sample that has RLS. Use a different sample (the built-in "Financial sample" does not need RLS) and re-publish.

## Browser console: "Cannot embed: Invalid token"

**Cause:** The embed token expired. Default lifetime is ~1 hour.
**Fix:** Refresh the page. The server generates a new token on each `/api/embed-info` call.

## Browser console: CORS error on `cdn.jsdelivr.net`

**Cause:** Offline, or corporate proxy blocking jsdelivr.
**Fix:** Swap the CDN in `static/js/embed.js` to `https://cdn.powerbi.com/libs/powerbi-client/2.23.1/powerbi.min.js` (Microsoft's own CDN).

## `uv run uvicorn` fails with `ModuleNotFoundError: No module named 'pydantic_settings'`

**Cause:** Dependencies not installed yet.
**Fix:** Run `uv sync` first.

## App starts but all requests hang

**Cause:** The F2 capacity is in transition ("Resuming..."). Azure reports this can take up to ~3 minutes after clicking Resume.
**Fix:** Wait until the Azure Portal shows the capacity as **Active**, then retry.

## Still stuck?

Run the auth call in isolation to rule out the webapp:

```sh
uv run python -c "from app.auth import get_access_token; print(get_access_token()[:40])"
```

- If this prints a token prefix, auth is fine — the issue is Power BI API permissions (workspace role or tenant setting).
- If this raises `AuthError`, the error message tells you exactly what MSAL said. Paste that into Google / the Microsoft docs.
