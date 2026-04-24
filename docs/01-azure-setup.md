# Azure + Power BI Setup — Step by Step

This walks you through every click you need to make **before** running the webapp. Budget ~60 min the first time. Follow the steps in order — later steps depend on earlier ones.

By the end you will have four values to paste into `.env`:

| `.env` key | Collected in step |
|---|---|
| `TENANT_ID` | A3 |
| `CLIENT_ID` | A3 |
| `CLIENT_SECRET` | A3 |
| `WORKSPACE_ID` | A6 |

> Keep a scratch pad (a plain text file) open while you work and paste each value as you collect it. Do **not** commit this scratch file — it contains secrets.

---

## A1. Create a Microsoft tenant + Azure account (10 min)

Goal: get into `portal.azure.com` with a $200 trial and a Microsoft Entra tenant.

1. Open **https://azure.microsoft.com/free**.
2. Click **Start free**.
3. Sign up with any email you control (a personal Gmail works).
4. Complete the signup:
   - You'll be asked for a credit card — this is for identity verification only. You won't be charged unless you exceed the $200 trial or explicitly upgrade.
5. When signup finishes, you're dropped into **https://portal.azure.com**. Bookmark it.

**What just happened under the hood:** Microsoft created a new **Entra tenant** (your private "directory"), added you as its Global Administrator, and gave you an Azure subscription with $200 of credit. The tenant is the container for all the identity + permissions work below.

> ⚠️ **About personal emails (Gmail/Outlook/Hotmail/Yahoo):** Azure accepts them, but **Power BI Pro will reject them** at A2 with a "your account isn't supported" error. Microsoft requires a "work or school account" for Power BI. The next step creates one inside the tenant you just made — it's free and takes 3 minutes.

---

## A1.5. Create a work-school admin user inside your tenant (5 min) — required if you signed up with Gmail/Outlook/etc.

Goal: produce a `admin@<something>.onmicrosoft.com` account you'll use for every Microsoft login from here on. The Gmail-based login stays attached to billing only.

> Skip this section only if you signed up in A1 with a pre-existing work/school email (e.g. `you@yourcompany.com`). Everyone else must do this.

1. In **portal.azure.com**, top search bar → **Microsoft Entra ID** → click it.
2. **Overview** tab → look at **Primary domain**. It will be something like `muhammadafaq1999gmail.onmicrosoft.com`. Remember this — it's your tenant domain.
3. Left sidebar → **Users** → **+ New user** → **Create new user**.
4. Fill in the **Basics** tab:
   - **User principal name:** `admin` (the `@<your-tenant>.onmicrosoft.com` suffix is filled in automatically).
   - **Display name:** `Admin`
   - **Password:** select **Let me create the password** → set one you'll remember.
   - Leave **Account enabled** checked.
5. Click the **Assignments** tab at the top → **+ Add role** → search **Global Administrator** → check it → **Select**.
6. Click **Review + create** → **Create**.

### Switch to the new account

7. Open an **incognito / private browser window** (so the Gmail session doesn't fight with the new one).
8. Go to **https://portal.azure.com** → sign in as `admin@<your-tenant>.onmicrosoft.com` with the password you set.
9. You'll be forced to change the password on first login — set a new one.
10. **From now on, every step below is done signed in as the `admin@*.onmicrosoft.com` user**, not your Gmail. The Gmail account still owns the Azure subscription (and gets billed), but the work-school user is what Power BI, admin portal, and workspaces will use.

### A1.5.1 — Grant the admin user access to the Azure subscription

Being Global Administrator of the Entra tenant is **not** the same as having rights on the Azure subscription. The subscription was created under your Gmail identity, so only Gmail has Owner on it. If you skip this step, A4 (creating a Fabric capacity) will fail with:

> `The client 'admin@…onmicrosoft.com' does not have authorization to perform action 'Microsoft.Resources/subscriptions/providers/read' over scope …`

Fix it once, now:

1. Sign in as your **Gmail** account in a separate browser window (this is the only account that currently has rights to grant access).
2. [portal.azure.com](https://portal.azure.com) → top search → **Subscriptions** → click **Azure subscription 1**.
3. Left sidebar → **Access control (IAM)** → top bar → **+ Add** → **Add role assignment**.
4. **Role** tab → click the **Privileged administrator roles** tab → select **Owner** → **Next**.
5. **Members** tab → **+ Select members** → type `admin` → pick `admin@<your-tenant>.onmicrosoft.com` → **Select** → **Next**.
6. **Conditions** tab → change the selection to **"Allow user to assign all roles except privileged administrator roles Owner, UAA, RBAC (Recommended)"** → **Next**.
   > ⚠️ You must set this condition — Owner requires it or the Review + assign step will show a red validation error and block you.
7. **Review + assign** → **Review + assign**.
7. Go back to your incognito admin window. Wait ~60 seconds for role propagation, then hard-refresh (Cmd/Ctrl+Shift+R) or sign out and back in.

---

## A2. Get a Power BI Pro license (5 min)

Goal: activate a free Power BI Pro trial on your work-school identity so you can publish reports.

1. In your incognito window (signed in as `admin@<your-tenant>.onmicrosoft.com`), open **https://www.microsoft.com/power-bi**.
2. Click **Start free** → **Try free** (for Power BI Pro, 60-day trial).
3. When prompted for an account, use `admin@<your-tenant>.onmicrosoft.com`.
4. Once activated, open **https://app.powerbi.com**. You should land on a Power BI home (not an "account not supported" page). Bookmark it.

> ⚠️ **Use the `.onmicrosoft.com` account from A1.5, not your Gmail.** Power BI rejects consumer email domains. Mixing a personal Gmail session with a work-school login in the same browser is the #1 reason tutorials silently break — use an incognito window for everything from here on.

---

## A3. Register an app in Microsoft Entra ID (10 min)

Goal: create a "service principal" (a robot identity your webapp uses) and collect three secrets — `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`.

### A3.1 — Create the app registration

1. In **https://portal.azure.com**, use the top search bar: type **Microsoft Entra ID** and click it.
2. In the left sidebar of Entra ID, click **App registrations**.
3. Click **+ New registration** (top of the blade).
4. Fill the form:
   - **Name:** `pbi-embed-app`
   - **Supported account types:** *Accounts in this organizational directory only (Default Directory only — Single tenant)*
   - **Redirect URI:** leave blank (we use client-credentials flow, no browser redirect needed).
5. Click **Register**.

### A3.2 — Collect `TENANT_ID` and `CLIENT_ID`

You're now on the app's **Overview** page.

1. Find **Application (client) ID** → copy → this is `CLIENT_ID` in `.env`.
2. Find **Directory (tenant) ID** → copy → this is `TENANT_ID` in `.env`.

### A3.3 — Create a client secret (`CLIENT_SECRET`)

1. In the left sidebar of the app, click **Certificates & secrets**.
2. Click the **Client secrets** tab.
3. Click **+ New client secret**.
4. Fill:
   - **Description:** `local-dev`
   - **Expires:** 180 days
5. Click **Add**.
6. The new secret appears in the table with two columns of interest: **Value** and **Secret ID**.
   - **Copy the `Value` column now.** This is `CLIENT_SECRET`.
   - It is shown **once**. If you refresh the page or navigate away, it becomes unreadable and you'll have to create a new one.
   - The `Secret ID` is NOT the secret — do not use it.

---

## A4. Create a Microsoft Fabric F2 capacity (10 min)

Goal: provision the compute that runs Power BI + paginated reports. F2 is the cheapest tier that supports paginated reports.

1. In **portal.azure.com**, top search bar: **Microsoft Fabric** → click the service (sometimes shown as "Microsoft Fabric" under Services).
2. Click **+ Create**.
3. Fill the form:
   - **Subscription:** *Azure subscription 1* (the one created with your trial).
   - **Resource group:** click **Create new** → name it `pbi-embed-rg` → **OK**.
   - **Capacity name:** `pbiembedf2` (lowercase, globally unique; pick something else if taken).
   - **Region:** whichever is geographically closest to you.
   - **Size:** **F2**.
   - **Fabric capacity administrator:** click **Add members** → add `admin@<your-tenant>.onmicrosoft.com` (the user from A1.5). **Do not add your Gmail** — it isn't a member of this tenant and Power BI won't recognise it.
4. Click **Review + create** → wait for validation → click **Create**.
5. Wait ~2 minutes. When deployment completes, click **Go to resource**.
6. You are now on the capacity's overview page. **Memorize the location of the `Pause` button at the top** — you will click this every single time you stop working for the day.

### 💰 Cost discipline (read this)

- F2 costs **~$0.36/hour**. Running 24/7 for 30 days ≈ **$260/month**.
- **Paused it costs $0.** There is no data loss from pausing — your workspace, reports, and settings all remain.
- Use the Pause button whenever you're not actively developing. Your $200 trial can last weeks this way.

---

## A5. Enable service principals in the Power BI tenant (5 min + up to 15 min propagation)

Goal: flip the global switch that lets your service principal call Power BI APIs. This is required and disabled by default.

1. Open **https://app.powerbi.com**.
2. Click the **gear icon** (top right) → **Admin portal**.
3. In the left sidebar, click **Tenant settings**.
4. Use browser Ctrl-F to find the **Developer settings** section.
5. Enable these two toggles (expand each one, set to **Enabled for the entire organization**, click **Apply**):
   - **Embed content in apps** — allows the embed token flow
   - **Service principals can call Fabric public APIs** — allows your service principal to call the Power BI REST API
6. Leave the rest disabled. You do **not** need "Service principals can create workspaces" or the profile/identity ones.

> ⏱️ **Propagation delay.** The setting can take up to **15 minutes** to take effect. If the webapp returns 401 right after setup, wait and retry before changing anything.

---

## A6. Create a workspace and attach it to the F2 capacity (5 min)

Goal: get a workspace with a **♦ diamond** icon and collect `WORKSPACE_ID`.

1. In **https://app.powerbi.com**, click **Workspaces** in the left nav.
2. Click **+ New workspace** (bottom of the flyout).
3. Fill in:
   - **Workspace name:** `MyEmbedWorkspace`
4. Click **Apply**.
5. You're now inside the new workspace. Click the **settings icon** (or **...** menu → **Workspace settings**) on the top right.
6. In the settings panel → **License info** section → change type to **Fabric capacity**.
7. From the dropdown select `pbiembedf2` (the capacity from A4).
8. Click **Save**.
9. Verify: the workspace name in the title bar now has a **♦ diamond icon** next to it. If it doesn't, the capacity isn't attached — re-check the dropdown.

### Collect `WORKSPACE_ID`

Look at your browser URL bar. It looks like:

```
https://app.powerbi.com/groups/<WORKSPACE_ID>/list
```

Copy the UUID between `/groups/` and `/list`. That's your `WORKSPACE_ID` for `.env`.

---

## A7. Add the service principal as a Member of the workspace (2 min)

Goal: grant your robot identity permission to read reports and generate embed tokens in this workspace.

1. Inside the workspace, click **Manage access** (top right).
2. Click **+ Add people or groups**.
3. In the search box, type `pbi-embed-app` (the name of your app registration from A3.1).
4. Select it from the dropdown.
5. Set the role to **Member**.
   - ⚠️ **Must be Member, not Viewer.** Viewer cannot generate embed tokens; Member can.
6. Click **Add**.

---

## A8. Publish a sample report and a sample paginated report (15 min)

You need at least one of each type for the webapp to show something interesting.

### A8.1 — Publish an interactive Power BI report

1. Download **Power BI Desktop**: https://www.microsoft.com/download/details.aspx?id=58494. Install it (Windows only).
2. Open it. Sign in (top-right **Sign in** link) with your `admin@<your-tenant>.onmicrosoft.com` account (the one from A1.5) — **not** your Gmail.
3. Click the **File** menu → **Get data** → **Samples** → **Financial sample** → **Load**.
4. In the Fields pane (right), drag a few columns onto the canvas — for example, check `Sales` and `Country`. Any visual will do.
5. **File → Publish → Publish to Power BI** → choose `MyEmbedWorkspace` → click **Select**.
6. Done. The `.pbix` now lives in your workspace.

### A8.2 — Publish a paginated report

1. Download **Power BI Report Builder**: https://www.microsoft.com/download/details.aspx?id=58158. Install.
2. Open Report Builder. Click **New Report** → use the **Table or Matrix Wizard**.
3. For a quick smoke test, choose **Create a dataset** → **New** → **Embedded connection**:
   - Connection type: **Microsoft SQL Server** (or any available) — actually the simplest is to skip wizard and add a dataset with hardcoded values.
   - Easiest option: cancel the wizard, right-click **Datasets** in the Report Data pane → **Add Dataset** → **Use a dataset embedded in my report** → **Query Designer** → paste a few rows of literal data via a `SELECT 'foo' AS col1, 1 AS col2 UNION ALL SELECT 'bar', 2`-style query against any available data source you have access to.
   - If you just want to see something render without any data source, you can drop a **Text Box** onto the report from the Insert ribbon and type "Hello paginated world!" in it — that's enough for a first test.
4. Click **File → Save** (save locally as a `.rdl`).
5. Click **File → Publish → Publish to Power BI** → select `MyEmbedWorkspace`.

Your workspace now has one **PowerBIReport** and one **PaginatedReport**. The webapp will list both automatically once running.

---

## You're done with Azure. Next steps

Back to [docs/02-running-the-app.md](02-running-the-app.md) to wire `.env` and run the webapp.

Remember: **pause the F2 capacity** in the Azure portal whenever you stop for the day.
