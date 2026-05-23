import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import process from 'node:process'

const appBuildId =
  process.env.APP_BUILD_ID ||
  process.env.SOURCE_VERSION ||
  process.env.GITHUB_SHA ||
  Date.now().toString(36)

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(appBuildId),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // 離線 fallback 頁（由 workbox 在 navigate 失敗時回退）
      filename: 'sw.js',
      manifest: {
        name: '幼兒園相本製作',
        short_name: '相本製作',
        description: '幫助幼兒園老師製作個人化相本 PDF',
        theme_color: '#4f46e5',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        lang: 'zh-TW',
        icons: [
          { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // API 請求全走網路，不快取
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // API：永遠走網路，失敗就失敗（不 fallback）
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
          {
            // 圖片（uploads）：先試網路，失敗才用快取
            urlPattern: /^\/uploads\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'uploads-cache',
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
            },
          },
        ],
      },
      // 產生獨立的 offline.html fallback
      injectManifest: false,
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8765'
    }
  }
})
