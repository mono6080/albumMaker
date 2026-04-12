"""
Test flow part 2 - Student Edit page and PDF render
"""
import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

SCREENSHOTS_DIR = Path("D:/projects/album_maker/backend/test_screenshots")
SCREENSHOTS_DIR.mkdir(exist_ok=True)

console_errors = []
console_all = []

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=200)
        context = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await context.new_page()

        def on_console(msg):
            console_all.append(f"[{msg.type}] {msg.text}")
            if msg.type in ("error", "warning"):
                console_errors.append(f"[{msg.type}] {msg.text}")
        page.on("console", on_console)
        page.on("pageerror", lambda err: console_errors.append(f"[pageerror] {err}"))

        step = 10  # Continue from step 10

        async def screenshot(name):
            nonlocal step
            step += 1
            path = str(SCREENSHOTS_DIR / f"{step:02d}_{name}.png")
            await page.screenshot(path=path, full_page=False)
            print(f"[screenshot] {step:02d}_{name}.png")

        # Navigate to correct student edit URL
        print("\n=== Navigate to /projects/2/students/15/edit ===")
        await page.goto("http://localhost:5173/projects/2/students/15/edit")
        await page.wait_for_load_state("networkidle")
        await asyncio.sleep(2)
        await screenshot("student_15_edit_page")
        print(f"URL: {page.url}")
        print(f"Title: {await page.title()}")

        # Check images
        img_info = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('img')).map(img => ({
                src: img.src.substring(0, 120),
                width: img.naturalWidth,
                height: img.naturalHeight
            }));
        }""")
        print(f"Images on page ({len(img_info)}):")
        for i, img in enumerate(img_info[:15]):
            print(f"  [{i}] {img['src']} ({img['width']}x{img['height']})")

        # Check buttons
        buttons = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('button')).map((btn, i) => ({
                index: i,
                text: btn.textContent.trim(),
                disabled: btn.disabled
            }));
        }""")
        print("\nButtons on student edit page:")
        for btn in buttons:
            if btn['text']:
                print(f"  [{btn['index']}] '{btn['text']}' disabled={btn['disabled']}")

        await screenshot("student_15_photo_manager")

        # Click 產生 PDF
        print("\n=== Click 產生 PDF ===")
        pdf_btn = page.get_by_text("產生 PDF", exact=True)
        pdf_count = await pdf_btn.count()
        print(f"'產生 PDF' button count: {pdf_count}")

        if pdf_count > 0:
            is_disabled = await pdf_btn.first.is_disabled()
            print(f"Button disabled: {is_disabled}")
            if not is_disabled:
                await pdf_btn.first.click()
                print("Clicked 產生 PDF, waiting for render...")
                await asyncio.sleep(3)
                await screenshot("pdf_rendering")
                await asyncio.sleep(8)
                await page.wait_for_load_state("networkidle")
                await screenshot("pdf_render_done")
            else:
                print("PDF button is disabled")
                await screenshot("pdf_btn_disabled")
        else:
            print("No '產生 PDF' button found")
            await screenshot("no_pdf_button")

        # Check for download link or result
        links = await page.evaluate("""() => {
            return Array.from(document.querySelectorAll('a')).map(a => ({
                href: a.href,
                text: a.textContent.trim().substring(0, 50)
            })).filter(a => a.href && a.href !== '#');
        }""")
        print(f"\nLinks on page ({len(links)}):")
        for l in links[:10]:
            print(f"  {l['text']} -> {l['href']}")

        # Final summary
        print("\n" + "="*60)
        print("TEST PART 2 COMPLETE")
        print("="*60)
        print(f"\nConsole errors ({len(console_errors)}):")
        for err in console_errors[:20]:
            print(f"  {err}")

        await asyncio.sleep(2)
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
