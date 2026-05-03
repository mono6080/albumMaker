# album_maker frontend

React 19 + Vite 8 + Tailwind CSS 4 SPA for the kindergarten album maker.

## Scripts

```bash
npm run dev      # Vite dev server on 5173; /api currently proxies to localhost:8769
npm run build    # production bundle consumed by backend/main.py from frontend/dist
npm run lint     # ESLint
```

For HMR development, run the FastAPI backend on `8769` or update `vite.config.js`
to match the backend port you are using. For the backend-served app path,
`start.bat`, Docker, and the README single-app mode use `8765`.

## Structure

- `src/api/`: API wrappers. `authApi.js` exports `apiClient` and `renderClient`.
- `src/context/`: global auth state.
- `src/pages/`: route-level views such as template editing, batch management, student edit, and review.
- `src/components/`: reusable UI and canvas components.
- `src/hooks/`: reusable state logic such as auto-save and permissions.
- `src/utils/` and `src/constants/`: shared helpers and static options.

Auth uses an HttpOnly Cookie set by the backend. Axios clients set
`withCredentials: true`; they do not inject a Bearer token.
