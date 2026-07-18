# Bundled render fonts

The editor and Pillow renderer use the same font outlines so line wrapping, weight,
and glyph metrics do not depend on the operating system. Browsers prefer the WOFF2
copies to reduce transfer size; Pillow continues to use the TTF files.

- `NotoSansTC-VF.ttf`: Google Fonts `ofl/notosanstc/NotoSansTC[wght].ttf`
- `NotoSerifTC-VF.ttf`: Google Fonts `ofl/notoseriftc/NotoSerifTC[wght].ttf`
- `NotoSansTC-VF.woff2` and `NotoSerifTC-VF.woff2`: web-only WOFF2 conversions of
  the same variable fonts
- `OFL-NotoSansTC.txt` and `OFL-NotoSerifTC.txt`: upstream copyright notices and
  SIL Open Font License 1.1 terms
- `manifest.json`: SHA-256 pins for the backend TTF render inputs only; web-only
  WOFF2 files intentionally do not change the render fingerprint

Source: <https://github.com/google/fonts/tree/main/ofl>
