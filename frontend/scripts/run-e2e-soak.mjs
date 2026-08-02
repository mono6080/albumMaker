// 壓力／效能 e2e：靠大量固定等待製造真實時序，本質上就是慢，所以不放進每次 push 的
// 那一輪。改版動到預覽、頁面切換或渲染排程時手動跑一次。
process.env.E2E_SOAK = "1";
process.env.E2E_WORKERS = process.env.E2E_WORKERS ?? "1";
await import("./run-e2e.mjs");
