from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    tenant_id: str
    client_id: str
    client_secret: str
    workspace_id: str

    powerbi_scope: str = "https://analysis.windows.net/powerbi/api/.default"
    powerbi_api_base: str = "https://api.powerbi.com/v1.0/myorg"

    @property
    def authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.tenant_id}"


settings = Settings()  # type: ignore[call-arg]
