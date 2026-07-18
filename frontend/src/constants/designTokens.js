// 跨語言設計 tokens 鏡像
// 正本：backend/services/design_tokens.json——改任一邊都要同步另一邊，
// tests/test_contract_pins.py 會比對兩檔內容一致（不同步 CI 直接紅）。
// 注意：下方物件必須維持「嚴格 JSON」寫法（雙引號 key、無註解、無尾逗號），
// 釘測試是直接抽出這段做 json 解析。
export const DESIGN_TOKENS = {
  "canvas": { "width": 794, "height": 1123 },
  "photo_frame": {
    "default_border_width": 8,
    "bottom_inset_multiplier": 3,
    "content_min_width": 60
  },
  "text_layout": { "measurement_scale": 64 },
  "text_content": { "max_label_text_length": 200 },
  "photo_transform": { "max_scale": 3.0 }
};
