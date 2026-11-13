// The dashboard is one static page. It holds no secrets: the owner types the dashboard
// token into it, and it keeps the token in sessionStorage and sends it in a header.

import { readFileSync } from "node:fs";

export const DASHBOARD_HTML: string = readFileSync(new URL("./page.html", import.meta.url), "utf8");
