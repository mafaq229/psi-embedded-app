import msal

from app.config import settings


class AuthError(RuntimeError):
    pass


_msal_app: msal.ConfidentialClientApplication | None = None


def _get_app() -> msal.ConfidentialClientApplication:
    global _msal_app
    if _msal_app is None:
        try:
            _msal_app = msal.ConfidentialClientApplication(
                client_id=settings.client_id,
                authority=settings.authority,
                client_credential=settings.client_secret,
            )
        except ValueError as exc:
            raise AuthError(f"Invalid TENANT_ID or authority: {exc}") from exc
    return _msal_app


def get_access_token() -> str:
    result = _get_app().acquire_token_for_client(scopes=[settings.powerbi_scope])
    if "access_token" not in result:
        # Surface the full AAD error so the user can fix setup issues quickly.
        raise AuthError(
            f"Could not acquire AAD token. "
            f"error={result.get('error')} "
            f"description={result.get('error_description')}"
        )
    return result["access_token"]
