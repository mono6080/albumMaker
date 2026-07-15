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
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:8765'

export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(appBuildId),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['offline.html', 'favicon.svg', 'icons/*.png'],
      // 離線 fallback 頁（由 workbox 在 navigate 失敗時回退）
      filename: 'sw.js',
      manifest: {
        name: '幼兒園相本系統',
        short_name: '相本系統',
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
          // 媒體現在也是受 Cookie 保護的 /api 端點；不可放進跨帳號共用的 SW cache。
        ],
      },
      // 產生獨立的 offline.html fallback
      injectManifest: false,
    }),
  ],
  server: {
    proxy: {
      '/api': apiProxyTarget
    }
  }
})
