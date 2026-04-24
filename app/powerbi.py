import urllib.parse

import httpx

from app.auth import get_access_token
from app.config import settings
from app.models import Dashboard, Dataset, EmbedInfo, Report


class PowerBIError(RuntimeError):
    pass


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {get_access_token()}"}


async def list_reports(workspace_id: str) -> list[Report]:
    url = f"{settings.powerbi_api_base}/groups/{workspace_id}/reports"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_headers())
    if resp.status_code != 200:
        raise PowerBIError(f"list_reports failed: {resp.status_code} {resp.text}")
    items = resp.json().get("value", [])
    return [
        Report(
            id=item["id"],
            name=item["name"],
            report_type=item.get("reportType", "PowerBIReport"),
            embed_url=item["embedUrl"],
            dataset_id=item.get("datasetId"),
        )
        for item in items
    ]


async def list_datasets(workspace_id: str) -> list[Dataset]:
    url = f"{settings.powerbi_api_base}/groups/{workspace_id}/datasets"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_headers())
    if resp.status_code != 200:
        raise PowerBIError(f"list_datasets failed: {resp.status_code} {resp.text}")
    items = resp.json().get("value", [])
    return [Dataset(id=item["id"], name=item["name"]) for item in items]


async def list_dashboards(workspace_id: str) -> list[Dashboard]:
    url = f"{settings.powerbi_api_base}/groups/{workspace_id}/dashboards"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_headers())
    if resp.status_code != 200:
        raise PowerBIError(f"list_dashboards failed: {resp.status_code} {resp.text}")
    items = resp.json().get("value", [])
    return [
        Dashboard(
            id=item["id"],
            display_name=item.get("displayName", item["id"]),
            embed_url=item["embedUrl"],
        )
        for item in items
    ]


async def _resolve_cross_workspace_datasets(
    workspace_id: str, report_id: str
) -> list[tuple[str, str]]:
    """Return (workspace_id, dataset_id) pairs for any Power BI semantic models
    used by a paginated report that live outside the report's own workspace.

    Parses AnalysisServices datasources whose server URL follows the XMLA pattern:
      powerbi://api.powerbi.com/v1.0/myorg/<WorkspaceName>
    """
    url = f"{settings.powerbi_api_base}/groups/{workspace_id}/reports/{report_id}/datasources"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_headers())
    if resp.status_code != 200:
        return []  # non-fatal: caller falls back to workspace datasets only

    results: list[tuple[str, str]] = []
    for ds in resp.json().get("value", []):
        if ds.get("datasourceType") != "AnalysisServices":
            continue
        conn = ds.get("connectionDetails", {})
        server: str = conn.get("server", "")
        database: str = conn.get("database", "")
        if not server or not database:
            continue

        # Extract workspace name from the XMLA server URL's last path segment.
        workspace_name = urllib.parse.unquote(server.rstrip("/").split("/")[-1])

        # Resolve workspace name → workspace ID.
        ws_filter = urllib.parse.quote(f"name eq '{workspace_name}'")
        async with httpx.AsyncClient(timeout=30.0) as client:
            ws_resp = await client.get(
                f"{settings.powerbi_api_base}/groups?$filter={ws_filter}",
                headers=_headers(),
            )
        if ws_resp.status_code != 200:
            continue
        ws_items = ws_resp.json().get("value", [])
        if not ws_items:
            continue
        ds_workspace_id: str = ws_items[0]["id"]

        # Resolve dataset name → dataset ID within that workspace.
        ds_filter = urllib.parse.quote(f"name eq '{database}'")
        async with httpx.AsyncClient(timeout=30.0) as client:
            ds_resp = await client.get(
                f"{settings.powerbi_api_base}/groups/{ds_workspace_id}/datasets?$filter={ds_filter}",
                headers=_headers(),
            )
        if ds_resp.status_code != 200:
            continue
        ds_items = ds_resp.json().get("value", [])
        if not ds_items:
            continue

        results.append((ds_workspace_id, ds_items[0]["id"]))

    return results


async def generate_embed_token(workspace_id: str, report: Report) -> EmbedInfo:
    # Fetch all workspace reports and datasets up front.
    all_reports = await list_reports(workspace_id)
    datasets = await list_datasets(workspace_id)
    known_ds_ids = {d.id for d in datasets}
    extra_workspace_ids: list[str] = []

    # Always include every workspace report in the token. This is required so
    # that paginated report visuals embedded inside an interactive report are
    # authorised — the V2 token must list every report the session may access.
    reports_in_token = [{"id": r.id, "allowEdit": False} for r in all_reports]

    # Resolve cross-workspace datasets for every paginated report. Paginated
    # reports may bind to semantic models in other workspaces via XMLA.
    paginated = [r for r in all_reports if r.report_type == "PaginatedReport"]
    for pag in paginated:
        cross = await _resolve_cross_workspace_datasets(workspace_id, pag.id)
        for ws_id, ds_id in cross:
            if ds_id not in known_ds_ids:
                datasets.append(Dataset(id=ds_id, name=""))
                known_ds_ids.add(ds_id)
            if ws_id != workspace_id and ws_id not in extra_workspace_ids:
                extra_workspace_ids.append(ws_id)

    # V2 multi-resource endpoint — required for paginated reports backed by a
    # Power BI semantic model (V1 rejects them with InvalidRequest).
    url = f"{settings.powerbi_api_base}/GenerateToken"
    body = {
        "reports": reports_in_token,
        "datasets": [{"id": ds.id, "xmlaPermissions": "ReadOnly"} for ds in datasets],
        "targetWorkspaces": [{"id": workspace_id}] + [{"id": ws} for ws in extra_workspace_ids],
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, headers=_headers(), json=body)
    if resp.status_code != 200:
        raise PowerBIError(f"generate_embed_token failed: {resp.status_code} {resp.text}")
    data = resp.json()
    return EmbedInfo(
        embed_id=report.id,
        embed_url=report.embed_url,
        embed_token=data["token"],
        embed_type="report",
        report_type=report.report_type,
        expiration=data["expiration"],
    )


async def get_report(workspace_id: str, report_id: str) -> Report:
    url = f"{settings.powerbi_api_base}/groups/{workspace_id}/reports/{report_id}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_headers())
    if resp.status_code != 200:
        raise PowerBIError(f"get_report failed: {resp.status_code} {resp.text}")
    item = resp.json()
    return Report(
        id=item["id"],
        name=item["name"],
        report_type=item.get("reportType", "PowerBIReport"),
        embed_url=item["embedUrl"],
        dataset_id=item.get("datasetId"),
    )


async def get_dashboard(workspace_id: str, dashboard_id: str) -> Dashboard:
    url = f"{settings.powerbi_api_base}/groups/{workspace_id}/dashboards/{dashboard_id}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(url, headers=_headers())
    if resp.status_code != 200:
        raise PowerBIError(f"get_dashboard failed: {resp.status_code} {resp.text}")
    item = resp.json()
    return Dashboard(
        id=item["id"],
        display_name=item.get("displayName", item["id"]),
        embed_url=item["embedUrl"],
    )


async def generate_dashboard_embed_token(workspace_id: str, dashboard: Dashboard) -> EmbedInfo:
    # Dashboards have no V2 equivalent — Microsoft requires the V1 endpoint.
    url = (
        f"{settings.powerbi_api_base}/groups/{workspace_id}/dashboards/{dashboard.id}/GenerateToken"
    )
    body = {"accessLevel": "View"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, headers=_headers(), json=body)
    if resp.status_code != 200:
        raise PowerBIError(f"generate_dashboard_embed_token failed: {resp.status_code} {resp.text}")
    data = resp.json()
    return EmbedInfo(
        embed_id=dashboard.id,
        embed_url=dashboard.embed_url,
        embed_token=data["token"],
        embed_type="dashboard",
        expiration=data["expiration"],
    )
