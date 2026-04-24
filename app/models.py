from typing import Literal

from pydantic import BaseModel

ReportType = Literal["PowerBIReport", "PaginatedReport"]
EmbedType = Literal["report", "dashboard"]


class Report(BaseModel):
    id: str
    name: str
    report_type: ReportType
    embed_url: str
    dataset_id: str | None = None


class Dataset(BaseModel):
    id: str
    name: str


class Dashboard(BaseModel):
    id: str
    display_name: str
    embed_url: str


class EmbedInfo(BaseModel):
    embed_id: str
    embed_url: str
    embed_token: str
    token_type: Literal["Embed"] = "Embed"
    embed_type: EmbedType = "report"
    report_type: ReportType | None = None
    expiration: str
