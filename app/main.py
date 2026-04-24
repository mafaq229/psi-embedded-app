from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app import powerbi
from app.auth import AuthError
from app.config import settings
from app.models import Dashboard, EmbedInfo, Report
from app.powerbi import PowerBIError

BASE_DIR = Path(__file__).resolve().parent.parent

app = FastAPI(title="Power BI Embed Playground")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def _split_by_type(reports: list[Report]) -> tuple[list[Report], list[Report]]:
    interactive = [r for r in reports if r.report_type == "PowerBIReport"]
    paginated = [r for r in reports if r.report_type == "PaginatedReport"]
    return interactive, paginated


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    error: str | None = None
    interactive: list[Report] = []
    paginated: list[Report] = []
    dashboards: list[Dashboard] = []
    try:
        reports = await powerbi.list_reports(settings.workspace_id)
        interactive, paginated = _split_by_type(reports)
        dashboards = await powerbi.list_dashboards(settings.workspace_id)
    except (AuthError, PowerBIError) as exc:
        error = str(exc)

    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "interactive_reports": interactive,
            "paginated_reports": paginated,
            "dashboards": dashboards,
            "error": error,
            "workspace_id": settings.workspace_id,
        },
    )


@app.get("/api/reports")
async def api_reports() -> list[Report]:
    try:
        return await powerbi.list_reports(settings.workspace_id)
    except (AuthError, PowerBIError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/dashboards")
async def api_dashboards() -> list[Dashboard]:
    try:
        return await powerbi.list_dashboards(settings.workspace_id)
    except (AuthError, PowerBIError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/embed-info/dashboard/{dashboard_id}")
async def api_embed_info_dashboard(dashboard_id: str) -> EmbedInfo:
    try:
        dashboard = await powerbi.get_dashboard(settings.workspace_id, dashboard_id)
        return await powerbi.generate_dashboard_embed_token(settings.workspace_id, dashboard)
    except (AuthError, PowerBIError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/embed-info/{report_id}")
async def api_embed_info(report_id: str) -> EmbedInfo:
    try:
        report = await powerbi.get_report(settings.workspace_id, report_id)
        return await powerbi.generate_embed_token(settings.workspace_id, report)
    except (AuthError, PowerBIError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
