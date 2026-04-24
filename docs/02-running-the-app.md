# Running the App Locally

Prerequisites: Azure + Power BI setup complete ([docs/01-azure-setup.md](01-azure-setup.md)).

## 1. Install dependencies

```sh
uv sync
```

This creates `.venv/`, installs runtime + dev deps (including `ruff`), and generates `uv.lock`.

## 2. Fill in `.env`

```sh
cp .env.example .env
```

Open `.env` in your editor and paste the four values you collected during Azure setup:

| Key | Comes from |
|---|---|
| `TENANT_ID` | A3.2 — Directory (tenant) ID |
| `CLIENT_ID` | A3.2 — Application (client) ID |
| `CLIENT_SECRET` | A3.3 — the `Value` column (not Secret ID) |
| `WORKSPACE_ID` | A6 — the UUID from the workspace URL |

## 3. Make sure your F2 capacity is running

Go to Azure Portal → your Fabric resource → if it says **Paused**, click **Resume**. Wait ~30 seconds.

If you skip this, report rendering will fail even if auth succeeds.

## 4. Start the app

```sh
uv run uvicorn app.main:app --reload
```

Open <http://localhost:8000>.

## 5. First-time verification checklist

Run each of these and make sure they pass before assuming everything works:

- [ ] **Auth works.** Visit <http://localhost:8000/api/reports> directly. You should see a JSON list containing at least your two reports from A8. If it's `401`, wait 15 minutes for A5 to propagate. If it's `[]`, re-check A7 (service principal must be Member).
- [ ] **Homepage renders.** Visit <http://localhost:8000>. The sidebar shows two sections: "Interactive Reports" (1 item) and "Paginated Reports" (1 item).
- [ ] **Interactive report renders.** Click the PBI report in the sidebar. Within a few seconds, the report appears in the main pane with working visuals.
- [ ] **Paginated report renders.** Click the paginated report. It loads as a multi-page RDL with page navigation at the bottom.
- [ ] **No CORS errors.** Open DevTools (F12) → Console. Should be clean. Network tab should show successful calls to `api.powerbi.com` and `app.powerbi.com`.

If any step fails, see [docs/03-troubleshooting.md](03-troubleshooting.md).

## 6. Lint

```sh
uv run ruff check
uv run ruff format --check
```

## 7. End-of-day routine

1. Stop the server (`Ctrl+C`).
2. In Azure Portal → Fabric capacity → click **Pause**.
3. Verify status changed to **Paused**.

Paused = $0/hr. Forgetting this is how people burn through their $200 trial.
