# album_maker frontend

React 19 + Vite 8 + Tailwind CSS 4 SPA for the kindergarten album maker.

## Scripts

```bash
npm run dev      # Vite dev server on 5173; /api proxies to localhost:8765
npm run build    # production bundle consumed by backend/main.py from frontend/dist
npm run lint     # ESLint
npm run test:e2e # clean Playwright run; starts its own e2e backend and Vite
```

For HMR development, run the FastAPI backend on `8765`; this matches
`start.bat`, Docker, and the backend-served app path.

For repeated local Playwright checks, keep the e2e backend and Vite running:

```bash
npm run dev:e2e
npm run test:e2e:reuse -- -g multi-select
```

`dev:e2e` uses an isolated `.tmp/e2e` database and the fixed e2e admin
password. `test:e2e:reuse` skips Playwright's `webServer` startup entirely, so
do not use it unless `dev:e2e` is already running.

## Structure

- `src/api/`: API wrappers. `authApi.js` exports `apiClient` and `renderClient`.
- `src/context/`: global auth state.
- `src/pages/`: route-level views such as template editing, batch management, student edit, and review.
- `src/components/`: reusable UI and canvas components.
- `src/hooks/`: reusable state logic such as auto-save and permissions.
- `src/utils/` and `src/constants/`: shared helpers and static options.

Auth uses an HttpOnly Cookie set by the backend. Axios clients set
`withCredentials: true`; they do not inject a Bearer token.
